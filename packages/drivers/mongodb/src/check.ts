import { lookup as dnsLookup, resolveSrv as dnsResolveSrv } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';

import {
  CONNECTION_CHECK_STEPS,
  JoineryError,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type HostPort,
  type ResolvedProfile,
} from '@joinery/core';
import {
  buildTlsSettings,
  errorMessage,
  mapNetworkError,
  type CheckConnectionDeps,
  type NetworkTarget,
} from '@joinery/driver-sql-base';
import { MongoClient } from 'mongodb';

import { buildMongoClientPlan, hostPortText, redactSecrets, type MongoClientPlan } from './config';
import { mapMongoError } from './errors';
import type { MongoDbSession } from './session';

/**
 * Test Connection for MongoDB (spec §4): DNS (the SRV record for mongodb+srv), TCP to the seed
 * hosts, the SSH tunnel or proxy, a TLS handshake, login, ping and the server version with its
 * topology. Each failing step names the problem and a fix hint; the steps after it are skipped.
 * A topology failure after login (replica set name mismatch, unreachable advertised members)
 * is diagnosed with a direct `hello` to the first reachable host.
 */

/** Network primitives, injectable for tests (the SQL check's deps plus SRV and TLS probes). */
export interface MongoCheckDeps extends CheckConnectionDeps {
  resolveSrv(name: string): Promise<HostPort[]>;
  /** Completes a TLS handshake with `target` and closes it. */
  tlsHandshake(target: HostPort, options: ConnectionOptions, timeoutMs: number): Promise<void>;
  /** The server's `hello` reply over a direct, unauthenticated connection (diagnostics). */
  hello(plan: MongoClientPlan, target: HostPort): Promise<Record<string, unknown>>;
  /** Opens the session the later steps use. */
  connect(resolved: ResolvedProfile): Promise<MongoDbSession>;
}

const defaultDeps: Omit<MongoCheckDeps, 'connect'> = {
  async lookup(host) {
    const { address } = await dnsLookup(host);
    return address;
  },
  probe(target, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (target.kind !== 'tcp') {
        reject(
          new JoineryError({ code: 'NOT_SUPPORTED', message: 'MongoDB needs a TCP endpoint' }),
        );
        return;
      }
      const socket = netConnect({ host: target.host, port: target.port });
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
  async resolveSrv(name) {
    const records = await dnsResolveSrv(`_mongodb._tcp.${name}`);
    return records.map((r) => ({ host: r.name, port: r.port }));
  },
  tlsHandshake(target, options, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ ...options, host: target.host, port: target.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          Object.assign(new Error('TLS handshake timed out'), {
            code: 'ERR_TLS_HANDSHAKE_TIMEOUT',
          }),
        );
      }, timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.end();
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
  async hello(plan, target) {
    const client = new MongoClient(`mongodb://${hostPortText(target)}/`, {
      ...tlsOnly(plan),
      directConnection: true,
      serverSelectionTimeoutMS: plan.options.connectTimeoutMS ?? 10_000,
      connectTimeoutMS: plan.options.connectTimeoutMS ?? 10_000,
    });
    try {
      await client.connect();
      return await client.db('admin').command({ hello: 1 });
    } finally {
      await client.close().catch(() => undefined);
    }
  },
};

function tlsOnly(plan: MongoClientPlan): Record<string, unknown> {
  const keys = [
    'tls',
    'ca',
    'cert',
    'key',
    'passphrase',
    'servername',
    'checkServerIdentity',
    'tlsAllowInvalidCertificates',
    'tlsAllowInvalidHostnames',
  ];
  const out: Record<string, unknown> = {};
  const options = plan.options as Record<string, unknown>;
  for (const key of keys) if (options[key] !== undefined) out[key] = options[key];
  return out;
}

class StepLog {
  private readonly reported = new Set<ConnectionCheckStep>();

  constructor(
    private readonly now: () => number,
    private readonly secrets: readonly string[],
  ) {}

  report(result: ConnectionCheckResult): ConnectionCheckResult {
    this.reported.add(result.step);
    return {
      ...result,
      ...(result.message !== undefined
        ? { message: redactSecrets(result.message, this.secrets) }
        : {}),
    };
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

function asJoinery(error: unknown, where: string, secrets: readonly string[]): JoineryError {
  if (error instanceof JoineryError) return error;
  return mapNetworkError(error, where) ?? mapMongoError(error, { where, secrets });
}

/** The stepwise Test Connection for a MongoDB profile (see the module comment). */
export async function* checkMongoConnection(
  resolved: ResolvedProfile,
  deps: Partial<MongoCheckDeps> & Pick<MongoCheckDeps, 'connect'>,
): AsyncGenerator<ConnectionCheckResult> {
  const d: MongoCheckDeps = { ...defaultDeps, ...deps };
  const { profile } = resolved;
  const secrets = Object.values(resolved.secrets);
  const log = new StepLog(d.now, secrets);
  const timeoutMs = profile.options.connectTimeoutMs;

  if ((profile.ssh || profile.proxy) && !resolved.endpointOverride) {
    if (!d.runSshStep) {
      yield log.skipped('dns', 'The SSH server or proxy resolves the database host');
      yield log.skipped('tcp', 'Reached through the tunnel');
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
    yield* throughTransport(resolved, d, log, d.runSshStep);
    return;
  }

  let started = d.now();
  let plan: MongoClientPlan;
  try {
    plan = buildMongoClientPlan(resolved);
  } catch (error) {
    yield log.failure('dns', started, asJoinery(error, profile.name, secrets));
    yield* log.skipRest();
    return;
  }

  // DNS: the SRV record, or each seed host name.
  let targets: HostPort[] = resolved.endpointOverride
    ? [resolved.endpointOverride]
    : [...plan.seeds];
  if (plan.srv && !resolved.endpointOverride) {
    const name = plan.seeds[0]!.host;
    try {
      targets = await d.resolveSrv(name);
      yield log.ok('dns', started, `SRV ${name} lists ${targets.map(hostPortText).join(', ')}`);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      yield log.failure(
        'dns',
        started,
        new JoineryError({
          code: 'CONNECTION_FAILED',
          message: `No SRV record _mongodb._tcp.${name} could be read${code ? ` (${code})` : ''}`,
          hint: 'Check the cluster host name; a mongodb+srv name needs an SRV record in DNS (VPN, network)',
        }),
      );
      yield* log.skipRest();
      return;
    }
  } else {
    const names = targets.filter((t) => isIP(t.host) === 0).slice(0, 8);
    if (names.length === 0) {
      yield log.skipped(
        'dns',
        `${targets.map((t) => t.host).join(', ')}: IP address${targets.length > 1 ? 'es' : ''}`,
      );
    } else {
      const results = await Promise.allSettled(names.map((t) => d.lookup(t.host)));
      const failed = names.filter((_, i) => results[i]!.status === 'rejected');
      if (failed.length === names.length) {
        const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        yield log.failure(
          'dns',
          started,
          asJoinery(first.reason, hostPortText(failed[0]!), secrets),
        );
        yield* log.skipRest();
        return;
      }
      const resolvedHosts = names
        .map((t, i) =>
          results[i]!.status === 'fulfilled'
            ? `${t.host} → ${(results[i] as PromiseFulfilledResult<string>).value}`
            : undefined,
        )
        .filter((x) => x !== undefined);
      yield log.ok(
        'dns',
        started,
        `${resolvedHosts.join(', ')}${failed.length > 0 ? `; not resolved: ${failed.map((t) => t.host).join(', ')}` : ''}`,
      );
      targets = targets.filter((t) => !failed.includes(t));
    }
  }

  // TCP: every seed, in parallel; one reachable host is enough to go on.
  started = d.now();
  const probed = targets.slice(0, 8);
  const reached = await Promise.allSettled(
    probed.map((t) =>
      d.probe(
        { kind: 'tcp', host: t.host, port: t.port, tlsHost: t.host } as NetworkTarget,
        timeoutMs,
      ),
    ),
  );
  const reachable = probed.filter((_, i) => reached[i]!.status === 'fulfilled');
  if (reachable.length === 0) {
    const first = reached[0] as PromiseRejectedResult;
    yield log.failure('tcp', started, asJoinery(first.reason, hostPortText(probed[0]!), secrets));
    yield* log.skipRest();
    return;
  }
  const unreachable = probed.filter((t) => !reachable.includes(t));
  yield log.ok(
    'tcp',
    started,
    `Connected to ${reachable.map(hostPortText).join(', ')}${unreachable.length > 0 ? `; not reachable: ${unreachable.map(hostPortText).join(', ')}` : ''}`,
  );

  if (resolved.endpointOverride && profile.ssh) {
    yield log.ok('ssh', d.now(), `Tunnel open at ${hostPortText(resolved.endpointOverride)}`);
  } else {
    yield log.skipped('ssh', 'No SSH tunnel');
  }
  yield* driverSteps(resolved, plan, reachable[0]!, d, log);
}

/** TLS handshake, login, ping and version against `first` (a reachable host). */
async function* driverSteps(
  resolved: ResolvedProfile,
  plan: MongoClientPlan,
  first: HostPort,
  d: MongoCheckDeps,
  log: StepLog,
): AsyncGenerator<ConnectionCheckResult> {
  const { profile } = resolved;
  const where = hostPortText(first);
  const timeoutMs = profile.options.connectTimeoutMs;
  let started = d.now();
  if (plan.tls.mode === 'disable') {
    yield log.skipped('tls', 'TLS is disabled');
  } else {
    try {
      const tlsHost = plan.tunnelled ? (plan.tls.expectedHostname ?? first.host) : first.host;
      const settings = buildTlsSettings(resolved, {
        kind: 'tcp',
        host: first.host,
        port: first.port,
        tlsHost,
      });
      await d.tlsHandshake(first, settings.options ?? {}, timeoutMs);
      yield log.ok('tls', started, tlsMessage(plan.tls.mode));
    } catch (error) {
      const mapped = asJoinery(error, where, plan.secrets);
      const failure =
        mapped.code === 'TLS_FAILED'
          ? mapped
          : new JoineryError({
              code: 'TLS_FAILED',
              message: `TLS negotiation with ${where} failed: ${redactSecrets(errorMessage(error), plan.secrets)}`,
              hint: 'Check that the server has TLS enabled and that the TLS mode and certificates in the profile match it',
            });
      yield log.failure('tls', started, failure);
      yield* log.skipRest();
      return;
    }
  }

  started = d.now();
  let session: MongoDbSession;
  try {
    session = await d.connect(resolved);
  } catch (error) {
    let failure = asJoinery(error, plan.where, plan.secrets);
    if (failure.code !== 'AUTH_FAILED' && failure.code !== 'TLS_FAILED') {
      failure = await diagnoseTopology(plan, first, d, failure);
    }
    yield log.failure(failure.code === 'TLS_FAILED' ? 'tls' : 'auth', started, failure);
    yield* log.skipRest();
    return;
  }
  try {
    const user =
      profile.auth.method === 'password' || profile.auth.method === 'clientCertificate'
        ? profile.auth.user
        : undefined;
    yield log.ok('auth', started, user ? `Logged in as ${user}` : 'Connected');
    started = d.now();
    try {
      await session.ping();
      yield log.ok('ping', started);
    } catch (error) {
      yield log.failure('ping', started, asJoinery(error, plan.where, plan.secrets));
      yield* log.skipRest();
      return;
    }
    started = d.now();
    const info = await session.serverInfo().catch(() => undefined);
    const topology =
      info?.topology === 'replicaSet'
        ? `replica set ${info.setName ?? ''} (${info.members.length || 1} member${info.members.length === 1 ? '' : 's'})`
        : info?.topology === 'sharded'
          ? `sharded cluster (${info.members.length} shard${info.members.length === 1 ? '' : 's'})`
          : (info?.topology ?? session.topology);
    yield log.ok('version', started, `MongoDB ${session.serverVersion}, ${topology}`);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * Explains a failed login-time topology check with a direct `hello`: a replica set name that
 * differs from the profile's, or members advertised under names this computer cannot use.
 */
async function diagnoseTopology(
  plan: MongoClientPlan,
  first: HostPort,
  d: MongoCheckDeps,
  failure: JoineryError,
): Promise<JoineryError> {
  let hello: Record<string, unknown>;
  try {
    hello = await d.hello(plan, first);
  } catch {
    return failure;
  }
  const setName = typeof hello['setName'] === 'string' ? hello['setName'] : undefined;
  if (plan.replicaSet !== undefined && setName !== plan.replicaSet) {
    return new JoineryError(
      {
        code: 'CONNECTION_FAILED',
        message: setName
          ? `${hostPortText(first)} belongs to replica set "${setName}", not "${plan.replicaSet}"`
          : `${hostPortText(first)} is not a member of a replica set, but the profile names "${plan.replicaSet}"`,
        hint: setName
          ? `Set the replica set name to "${setName}"`
          : 'Remove the replica set name from the profile',
      },
      { cause: failure },
    );
  }
  const hosts = Array.isArray(hello['hosts']) ? hello['hosts'].map(String) : [];
  const seeds = new Set(plan.seeds.map(hostPortText));
  if (setName && hosts.length > 0 && !hosts.some((h) => seeds.has(h))) {
    return new JoineryError(
      {
        code: 'CONNECTION_FAILED',
        message: `${failure.message}. The replica set "${setName}" advertises its members as ${hosts.join(', ')}`,
        hint: 'This computer may not reach those names: turn on Direct connection to use this host only, or make the advertised names resolvable',
      },
      { cause: failure },
    );
  }
  return failure;
}

/** DNS and TCP to the proxy or first SSH hop, the `ssh` step, then the driver steps through it. */
async function* throughTransport(
  resolved: ResolvedProfile,
  d: MongoCheckDeps,
  log: StepLog,
  runSshStep: NonNullable<CheckConnectionDeps['runSshStep']>,
): AsyncGenerator<ConnectionCheckResult> {
  const { profile } = resolved;
  const secrets = Object.values(resolved.secrets);
  const first = profile.proxy ?? profile.ssh!.hops[0]!;
  const what = profile.proxy ? 'proxy' : 'SSH server';
  const firstWhere = hostPortText(first);
  let started = d.now();
  if (isIP(first.host) !== 0) {
    yield log.skipped('dns', `The ${what} ${first.host} is an IP address`);
  } else {
    try {
      const address = await d.lookup(first.host);
      yield log.ok('dns', started, `The ${what} ${first.host} resolves to ${address}`);
    } catch (error) {
      yield log.failure('dns', started, asJoinery(error, firstWhere, secrets));
      yield* log.skipRest();
      return;
    }
  }
  started = d.now();
  try {
    await d.probe(
      { kind: 'tcp', host: first.host, port: first.port, tlsHost: first.host },
      profile.options.connectTimeoutMs,
    );
    yield log.ok('tcp', started, `Connected to the ${what} ${firstWhere}`);
  } catch (error) {
    yield log.failure('tcp', started, asJoinery(error, firstWhere, secrets));
    yield* log.skipRest();
    return;
  }
  started = d.now();
  let outcome: Awaited<ReturnType<typeof runSshStep>>;
  try {
    outcome = await runSshStep(resolved);
  } catch (error) {
    yield log.failure('ssh', started, asJoinery(error, firstWhere, secrets));
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
    const through: ResolvedProfile = {
      ...resolved,
      profile: direct,
      endpointOverride: transport.endpointOverride,
    };
    let plan: MongoClientPlan;
    try {
      plan = buildMongoClientPlan(through);
    } catch (error) {
      yield log.failure('tls', d.now(), asJoinery(error, profile.name, secrets));
      yield* log.skipRest();
      return;
    }
    yield* driverSteps(through, plan, transport.endpointOverride, d, log);
  } finally {
    await transport?.close().catch(() => undefined);
  }
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
