import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';

import {
  CONNECTION_CHECK_STEPS,
  JoineryError,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type DriverAdapter,
  type ResolvedProfile,
} from '@joinery/core';
import {
  describeTarget,
  errorMessage,
  mapNetworkError,
  type CheckConnectionDeps,
  type NetworkTarget,
} from '@joinery/driver-sql-base';
import { needsTransport, tunnelTarget } from '@joinery/tunnel';

import { buildRedisConnectionPlan, type RedisConnectionPlan } from './config';
import type { RedisSession } from './types';

const defaultDeps: CheckConnectionDeps = {
  async lookup(host) {
    return (await dnsLookup(host)).address;
  },
  probe(target, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket =
        target.kind === 'socket'
          ? netConnect({ path: target.path })
          : netConnect({ host: target.host, port: target.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
  },
  now: () => performance.now(),
};

function asJoineryError(error: unknown, where: string): JoineryError {
  if (error instanceof JoineryError) return error;
  return (
    mapNetworkError(error, where) ??
    new JoineryError({ code: 'CONNECTION_FAILED', message: errorMessage(error) }, { cause: error })
  );
}

class StepLog {
  private readonly reported = new Set<ConnectionCheckStep>();

  constructor(readonly now: () => number) {}

  report(result: ConnectionCheckResult): ConnectionCheckResult {
    this.reported.add(result.step);
    return result;
  }

  ok(step: ConnectionCheckStep, started: number, message?: string): ConnectionCheckResult {
    return this.report({
      step,
      status: 'ok',
      durationMs: Math.round(this.now() - started),
      ...(message !== undefined ? { message } : {}),
    });
  }

  skipped(step: ConnectionCheckStep, message: string): ConnectionCheckResult {
    return this.report({ step, status: 'skipped', durationMs: 0, message });
  }

  failure(step: ConnectionCheckStep, started: number, error: JoineryError): ConnectionCheckResult {
    return this.report({
      step,
      status: 'failed',
      durationMs: Math.round(this.now() - started),
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    });
  }

  *skipRest(): Generator<ConnectionCheckResult> {
    for (const step of CONNECTION_CHECK_STEPS) {
      if (!this.reported.has(step)) {
        yield {
          step,
          status: 'skipped',
          durationMs: 0,
          message: 'Not run: an earlier step failed',
        };
      }
    }
  }
}

/** DNS and TCP of the hosts Joinery contacts first; passes when at least one answers. */
async function* networkSteps(
  targets: readonly NetworkTarget[],
  what: string,
  d: CheckConnectionDeps,
  timeoutMs: number,
  log: StepLog,
): AsyncGenerator<ConnectionCheckResult, boolean> {
  const tcpTargets = targets.filter(
    (t): t is Extract<NetworkTarget, { kind: 'tcp' }> => t.kind === 'tcp',
  );
  let started = d.now();
  const names = [...new Set(tcpTargets.map((t) => t.host).filter((h) => isIP(h) === 0))];
  if (tcpTargets.length === 0) {
    yield log.skipped('dns', 'Unix socket');
  } else if (names.length === 0) {
    yield log.skipped(
      'dns',
      `${what} ${tcpTargets.map((t) => t.host).join(', ')} ${tcpTargets.length > 1 ? 'are IP addresses' : 'is an IP address'}`,
    );
  } else {
    const results = await Promise.allSettled(names.map((n) => d.lookup(n)));
    const resolved = names.filter((_, i) => results[i]!.status === 'fulfilled');
    if (resolved.length === 0) {
      const first = results[0] as PromiseRejectedResult;
      yield log.failure('dns', started, asJoineryError(first.reason, names[0]!));
      return false;
    }
    const failed = names.filter((n) => !resolved.includes(n));
    yield log.ok(
      'dns',
      started,
      names
        .map((n, i) => {
          const r = results[i]!;
          return r.status === 'fulfilled' ? `${n} resolves to ${r.value}` : `${n} does not resolve`;
        })
        .join('; ') + (failed.length > 0 ? ' (the others are enough)' : ''),
    );
  }

  started = d.now();
  const probes = await Promise.allSettled(targets.map((t) => d.probe(t, timeoutMs)));
  const reachable = targets.filter((_, i) => probes[i]!.status === 'fulfilled');
  if (reachable.length === 0) {
    const first = probes[0] as PromiseRejectedResult;
    yield log.failure('tcp', started, asJoineryError(first.reason, describeTarget(targets[0]!)));
    return false;
  }
  const unreachable = targets.length - reachable.length;
  yield log.ok(
    'tcp',
    started,
    `Connected to ${reachable.map(describeTarget).join(', ')}${unreachable > 0 ? ` (${unreachable} of ${targets.length} did not answer)` : ''}`,
  );
  return true;
}

function tlsMessage(mode: string): string {
  switch (mode) {
    case 'require':
      return 'Encrypted; the server certificate is not verified';
    case 'verify-ca':
      return 'Encrypted; certificate chain verified (host name not checked)';
    default:
      return 'Encrypted; certificate and host name verified';
  }
}

/** TLS, auth, ping and version, through the driver. */
async function* driverSteps(
  resolved: ResolvedProfile,
  adapter: DriverAdapter,
  d: CheckConnectionDeps,
  log: StepLog,
): AsyncGenerator<ConnectionCheckResult> {
  let started = d.now();
  let plan: RedisConnectionPlan;
  try {
    plan = buildRedisConnectionPlan(resolved);
  } catch (error) {
    const mapped = asJoineryError(error, resolved.profile.name);
    if (mapped.code !== 'TLS_FAILED') yield log.skipped('tls', 'Not checked');
    yield log.failure(mapped.code === 'TLS_FAILED' ? 'tls' : 'auth', started, mapped);
    yield* log.skipRest();
    return;
  }
  const tlsOff = plan.tls.mode === 'disable' || plan.target.kind === 'socket';
  let session: RedisSession;
  try {
    session = (await adapter.connect(resolved)) as RedisSession;
  } catch (error) {
    const mapped = asJoineryError(error, plan.where);
    if (tlsOff) {
      yield log.skipped('tls', plan.target.kind === 'socket' ? 'Unix socket' : 'TLS is disabled');
      yield log.failure('auth', started, mapped);
    } else if (mapped.code === 'TLS_FAILED' || mapped.code === 'TIMEOUT') {
      yield log.failure('tls', started, mapped);
    } else if (mapped.code === 'CONNECTION_FAILED' && /closed/.test(mapped.message)) {
      // The socket opened, so a close before login is most often the TLS negotiation.
      yield log.failure('tls', started, mapped);
    } else {
      yield log.ok('tls', started, tlsMessage(plan.tls.mode));
      yield log.failure('auth', started, mapped);
    }
    yield* log.skipRest();
    return;
  }
  try {
    if (tlsOff)
      yield log.skipped('tls', plan.target.kind === 'socket' ? 'Unix socket' : 'TLS is disabled');
    else yield log.ok('tls', started, tlsMessage(plan.tls.mode));
    yield log.ok(
      'auth',
      started,
      plan.user
        ? `Logged in as ${plan.user}`
        : plan.password
          ? 'Logged in'
          : 'No authentication needed',
    );
    started = d.now();
    try {
      await session.ping();
      yield log.ok('ping', started);
    } catch (error) {
      yield log.failure('ping', started, asJoineryError(error, plan.where));
      yield* log.skipRest();
      return;
    }
    const server = session.server;
    const product = server.flavor === 'valkey' ? 'Valkey' : 'Redis';
    const shape =
      server.topology === 'cluster'
        ? `cluster of ${session.nodes().length} primaries`
        : server.topology === 'sentinel'
          ? `through Sentinel, ${server.role}`
          : server.role;
    yield log.ok('version', d.now(), `${product} ${server.version} (${shape})`);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * Test Connection for a Redis profile (spec §4): DNS, TCP, SSH, TLS, auth, ping, version, with
 * a fix hint on the failing step. Sentinel and Cluster profiles check every sentinel / seed and
 * pass DNS and TCP when at least one answers. With an SSH tunnel or proxy and
 * `deps.runSshStep`, DNS and TCP check the first server on the way and the later steps run
 * through the tunnel; Sentinel and Cluster cannot be tunnelled and fail the SSH step.
 */
export async function* checkRedisConnection(
  resolved: ResolvedProfile,
  adapter: DriverAdapter,
  deps: Partial<CheckConnectionDeps> = {},
): AsyncGenerator<ConnectionCheckResult> {
  const d: CheckConnectionDeps = { ...defaultDeps, ...deps };
  const log = new StepLog(d.now);
  const { profile } = resolved;
  const timeoutMs = profile.options.connectTimeoutMs;

  if (needsTransport(profile) && !resolved.endpointOverride) {
    const first = profile.proxy ?? profile.ssh!.hops[0]!;
    const what = profile.proxy ? 'The proxy' : 'The SSH server';
    const firstTarget: NetworkTarget = {
      kind: 'tcp',
      host: first.host,
      port: first.port,
      tlsHost: first.host,
    };
    if (!(yield* networkSteps([firstTarget], what, d, timeoutMs, log))) {
      yield* log.skipRest();
      return;
    }
    const started = d.now();
    try {
      tunnelTarget(profile);
    } catch (error) {
      yield log.failure('ssh', started, asJoineryError(error, profile.name));
      yield* log.skipRest();
      return;
    }
    if (!d.runSshStep) {
      yield log.report({
        step: 'ssh',
        status: 'failed',
        durationMs: 0,
        message: 'This profile uses an SSH tunnel or proxy, but no tunnel is open for it',
        hint: 'Tunnels are opened by the connection host; run Test Connection from the app',
      });
      yield* log.skipRest();
      return;
    }
    let outcome: Awaited<ReturnType<NonNullable<CheckConnectionDeps['runSshStep']>>>;
    try {
      outcome = await d.runSshStep(resolved);
    } catch (error) {
      yield log.failure('ssh', started, asJoineryError(error, describeTarget(firstTarget)));
      yield* log.skipRest();
      return;
    }
    const transport = outcome.transport;
    try {
      yield log.report(outcome.result);
      if (outcome.result.status === 'failed' || !transport) {
        yield* log.skipRest();
        return;
      }
      const { proxy: _proxy, ...direct } = profile;
      yield* driverSteps(
        { ...resolved, profile: direct, endpointOverride: transport.endpointOverride },
        adapter,
        d,
        log,
      );
    } finally {
      await transport?.close().catch(() => undefined);
    }
    return;
  }

  let seeds: readonly NetworkTarget[];
  const started = d.now();
  try {
    const plan = buildRedisConnectionPlan(resolved);
    seeds = plan.seeds;
  } catch (error) {
    yield log.failure(
      needsTransport(profile) ? 'ssh' : 'dns',
      started,
      asJoineryError(error, profile.name),
    );
    yield* log.skipRest();
    return;
  }
  const what =
    profile.endpoint.kind === 'sentinel'
      ? 'Sentinel'
      : profile.endpoint.kind === 'cluster'
        ? 'Seed'
        : 'Host';
  if (!(yield* networkSteps(seeds, what, d, timeoutMs, log))) {
    yield* log.skipRest();
    return;
  }
  if (resolved.endpointOverride && needsTransport(profile)) {
    yield log.ok('ssh', d.now(), `Tunnel open at ${describeTarget(seeds[0]!)}`);
  } else {
    yield log.skipped('ssh', 'No SSH tunnel');
  }
  yield* driverSteps(resolved, adapter, d, log);
}
