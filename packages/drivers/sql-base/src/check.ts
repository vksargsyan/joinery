import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';

import {
  CONNECTION_CHECK_STEPS,
  ENGINES,
  QuerybaraError,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@querybara/core';

import { describeTarget, resolveEndpoint, type NetworkTarget } from './endpoint';
import { errorMessage, mapNetworkError } from './errors';

/** What the `ssh` step leaves open for the later steps: a local endpoint into the tunnel. */
export interface CheckTransport {
  readonly endpointOverride: { readonly host: string; readonly port: number };
  close(): Promise<void>;
}

/** The outcome of the `ssh` step: its result and, when it passed, the open transport. */
export interface SshStepOutcome {
  readonly result: ConnectionCheckResult;
  readonly transport?: CheckTransport;
}

/** Network primitives, injectable so the step logic can be tested without a network. */
export interface CheckConnectionDeps {
  lookup(host: string): Promise<string>;
  /** Opens and closes a TCP connection or Unix socket within `timeoutMs`. */
  probe(target: NetworkTarget, timeoutMs: number): Promise<void>;
  now(): number;
  /**
   * Runs the `ssh` step for a profile with an SSH tunnel or a proxy: opens it and proves it
   * reaches the endpoint (@querybara/tunnel's `runSshStep`). When it passes, TLS, auth, ping and
   * version run through the transport, which is closed when the check ends. Without it, such a
   * profile fails the `ssh` step, since nothing here can open a tunnel.
   */
  runSshStep?(resolved: ResolvedProfile): Promise<SshStepOutcome>;
}

const defaultDeps: CheckConnectionDeps = {
  async lookup(host) {
    const { address } = await dnsLookup(host);
    return address;
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

function asQuerybaraError(error: unknown, where: string): QuerybaraError {
  if (error instanceof QuerybaraError) return error;
  return (
    mapNetworkError(error, where) ??
    new QuerybaraError(
      { code: 'CONNECTION_FAILED', message: errorMessage(error) },
      { cause: error },
    )
  );
}

/** Tracks which steps were reported, so the rest can be reported as skipped. */
class StepLog {
  private readonly reported = new Set<ConnectionCheckStep>();

  constructor(private readonly now: () => number) {}

  report(result: ConnectionCheckResult): ConnectionCheckResult {
    this.reported.add(result.step);
    return result;
  }

  failure(
    step: ConnectionCheckStep,
    started: number,
    error: QuerybaraError,
  ): ConnectionCheckResult {
    return this.report({
      step,
      status: 'failed',
      durationMs: Math.round(this.now() - started),
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    });
  }

  *skipRest(reason: string): Generator<ConnectionCheckResult> {
    for (const step of CONNECTION_CHECK_STEPS) {
      if (!this.reported.has(step))
        yield { step, status: 'skipped', durationMs: 0, message: reason };
    }
  }
}

const afterFailure = 'Not run: an earlier step failed';

/**
 * The stepwise Test Connection check (spec §4): DNS, TCP, SSH, TLS, auth, ping, version. Yields
 * one result per step as it completes, so the UI can show progress. The first failing step
 * carries the error message and a fix hint; the steps after it are reported as skipped.
 *
 * TLS and auth happen inside the driver handshake, so they are told apart by the connect error:
 * TLS_FAILED fails the TLS step, anything later fails auth.
 *
 * With an SSH tunnel or a proxy and `deps.runSshStep`, DNS and TCP check the first server on the
 * way (the proxy or the first SSH hop), the SSH step opens the tunnel, and the later steps run
 * through it. `deps` may be partial; missing members use the real network.
 */
export async function* checkConnection(
  resolved: ResolvedProfile,
  adapter: DriverAdapter,
  deps: Partial<CheckConnectionDeps> = {},
): AsyncGenerator<ConnectionCheckResult> {
  const d: CheckConnectionDeps = { ...defaultDeps, ...deps };
  const log = new StepLog(d.now);
  const report = (result: ConnectionCheckResult) => log.report(result);
  const failure = (step: ConnectionCheckStep, started: number, error: QuerybaraError) =>
    log.failure(step, started, error);
  const skipRest = (reason: string) => log.skipRest(reason);
  const { profile } = resolved;
  const timeoutMs = profile.options.connectTimeoutMs;

  if ((profile.ssh || profile.proxy) && !resolved.endpointOverride && d.runSshStep) {
    yield* checkThroughTransport(resolved, adapter, d, d.runSshStep, log);
    return;
  }

  if (profile.ssh && !resolved.endpointOverride) {
    yield report({
      step: 'dns',
      status: 'skipped',
      durationMs: 0,
      message: 'The SSH server resolves the database host',
    });
    yield report({ step: 'tcp', status: 'skipped', durationMs: 0, message: 'Reached through SSH' });
    yield report({
      step: 'ssh',
      status: 'failed',
      durationMs: 0,
      message: 'This profile uses an SSH tunnel, but no tunnel is open for it',
      hint: 'SSH tunnels are opened by the connection host; run Test Connection from the app',
    });
    yield* skipRest(afterFailure);
    return;
  }

  let started = d.now();
  let target: NetworkTarget;
  try {
    target = resolveEndpoint(resolved).target;
  } catch (error) {
    yield failure('dns', started, asQuerybaraError(error, profile.name));
    yield* skipRest(afterFailure);
    return;
  }
  const where = describeTarget(target);

  // DNS
  if (target.kind === 'socket') {
    yield report({ step: 'dns', status: 'skipped', durationMs: 0, message: 'Unix socket' });
  } else if (isIP(target.host) !== 0) {
    yield report({
      step: 'dns',
      status: 'skipped',
      durationMs: 0,
      message: `${target.host} is an IP address`,
    });
  } else {
    started = d.now();
    try {
      const address = await d.lookup(target.host);
      yield report({
        step: 'dns',
        status: 'ok',
        durationMs: Math.round(d.now() - started),
        message: `${target.host} resolves to ${address}`,
      });
    } catch (error) {
      yield failure('dns', started, asQuerybaraError(error, where));
      yield* skipRest(afterFailure);
      return;
    }
  }

  // TCP (or the Unix socket)
  started = d.now();
  try {
    await d.probe(target, timeoutMs);
    yield report({
      step: 'tcp',
      status: 'ok',
      durationMs: Math.round(d.now() - started),
      message: `Connected to ${where}`,
    });
  } catch (error) {
    yield failure('tcp', started, asQuerybaraError(error, where));
    yield* skipRest(afterFailure);
    return;
  }

  // SSH
  if (profile.ssh && resolved.endpointOverride) {
    yield report({
      step: 'ssh',
      status: 'ok',
      durationMs: 0,
      message: `Tunnel open at ${where}`,
    });
  } else {
    yield report({ step: 'ssh', status: 'skipped', durationMs: 0, message: 'No SSH tunnel' });
  }

  yield* driverSteps(resolved, adapter, target, where, d, log);
}

/**
 * TLS, auth, ping and version: the steps that run inside the driver, against `target` (the
 * endpoint, or the tunnel's local end). Closes the session it opens.
 */
async function* driverSteps(
  resolved: ResolvedProfile,
  adapter: DriverAdapter,
  target: NetworkTarget,
  where: string,
  d: CheckConnectionDeps,
  log: StepLog,
): AsyncGenerator<ConnectionCheckResult> {
  const { profile } = resolved;
  const tlsOff = target.kind === 'socket' || profile.tls.mode === 'disable';
  let started = d.now();
  let session: Session;
  try {
    session = await adapter.connect(resolved);
  } catch (error) {
    const mapped = asQuerybaraError(error, where);
    if (tlsOff) {
      yield log.report({
        step: 'tls',
        status: 'skipped',
        durationMs: 0,
        message: target.kind === 'socket' ? 'Unix socket' : 'TLS is disabled',
      });
      yield log.failure('auth', started, mapped);
    } else if (mapped.code === 'TLS_FAILED') {
      yield log.failure('tls', started, mapped);
    } else if (mapped.code === 'CONNECTION_FAILED' || mapped.code === 'TIMEOUT') {
      // The socket opened, so a failure before login is most often the TLS negotiation.
      yield log.failure('tls', started, mapped);
    } else {
      yield log.report({ step: 'tls', status: 'ok', durationMs: 0, message: tlsMessage(resolved) });
      yield log.failure('auth', started, mapped);
    }
    yield* log.skipRest(afterFailure);
    return;
  }
  try {
    if (tlsOff) {
      yield log.report({
        step: 'tls',
        status: 'skipped',
        durationMs: 0,
        message: target.kind === 'socket' ? 'Unix socket' : 'TLS is disabled',
      });
    } else {
      yield log.report({ step: 'tls', status: 'ok', durationMs: 0, message: tlsMessage(resolved) });
    }
    yield log.report({
      step: 'auth',
      status: 'ok',
      durationMs: Math.round(d.now() - started),
      message: 'Logged in',
    });

    started = d.now();
    try {
      await session.ping();
      yield log.report({ step: 'ping', status: 'ok', durationMs: Math.round(d.now() - started) });
    } catch (error) {
      yield log.failure('ping', started, asQuerybaraError(error, where));
      yield* log.skipRest(afterFailure);
      return;
    }

    yield log.report({
      step: 'version',
      status: 'ok',
      durationMs: 0,
      message: `${ENGINES[session.engine].displayName} ${session.serverVersion}`,
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * The check for a profile with an SSH tunnel or a proxy: DNS and TCP for the first server on the
 * way, the SSH step through `runSshStep`, then the driver steps through the open transport.
 */
async function* checkThroughTransport(
  resolved: ResolvedProfile,
  adapter: DriverAdapter,
  d: CheckConnectionDeps,
  runSshStep: NonNullable<CheckConnectionDeps['runSshStep']>,
  log: StepLog,
): AsyncGenerator<ConnectionCheckResult> {
  const { profile } = resolved;
  const first = profile.proxy ?? profile.ssh!.hops[0]!;
  const what = profile.proxy ? 'proxy' : 'SSH server';
  const firstTarget: NetworkTarget = {
    kind: 'tcp',
    host: first.host,
    port: first.port,
    tlsHost: first.host,
  };
  const firstWhere = describeTarget(firstTarget);

  // DNS and TCP of the first server on the way; the database host is resolved beyond it.
  let started = d.now();
  if (isIP(first.host) !== 0) {
    yield log.report({
      step: 'dns',
      status: 'skipped',
      durationMs: 0,
      message: `The ${what} ${first.host} is an IP address`,
    });
  } else {
    try {
      const address = await d.lookup(first.host);
      yield log.report({
        step: 'dns',
        status: 'ok',
        durationMs: Math.round(d.now() - started),
        message: `The ${what} ${first.host} resolves to ${address}`,
      });
    } catch (error) {
      yield log.failure('dns', started, asQuerybaraError(error, firstWhere));
      yield* log.skipRest(afterFailure);
      return;
    }
  }
  started = d.now();
  try {
    await d.probe(firstTarget, profile.options.connectTimeoutMs);
    yield log.report({
      step: 'tcp',
      status: 'ok',
      durationMs: Math.round(d.now() - started),
      message: `Connected to the ${what} ${firstWhere}`,
    });
  } catch (error) {
    yield log.failure('tcp', started, asQuerybaraError(error, firstWhere));
    yield* log.skipRest(afterFailure);
    return;
  }

  // SSH (or the proxy): open the transport and prove it reaches the endpoint.
  started = d.now();
  let outcome: SshStepOutcome;
  try {
    outcome = await runSshStep(resolved);
  } catch (error) {
    yield log.failure('ssh', started, asQuerybaraError(error, firstWhere));
    yield* log.skipRest(afterFailure);
    return;
  }
  const transport = outcome.transport;
  try {
    yield log.report(outcome.result);
    if (outcome.result.status === 'failed' || !transport) {
      yield* log.skipRest(afterFailure);
      return;
    }
    // The transport already goes through the proxy; the driver connects to its local end.
    const { proxy: _proxy, ...direct } = profile;
    const through: ResolvedProfile = {
      ...resolved,
      profile: direct,
      endpointOverride: transport.endpointOverride,
    };
    let target: NetworkTarget;
    try {
      target = resolveEndpoint(through).target;
    } catch (error) {
      yield log.failure('tls', started, asQuerybaraError(error, profile.name));
      yield* log.skipRest(afterFailure);
      return;
    }
    const where = target.kind === 'tcp' ? `${target.tlsHost} (through the tunnel)` : profile.name;
    yield* driverSteps(through, adapter, target, where, d, log);
  } finally {
    await transport?.close().catch(() => undefined);
  }
}

function tlsMessage(resolved: ResolvedProfile): string {
  switch (resolved.profile.tls.mode) {
    case 'require':
      return 'Encrypted; the server certificate is not verified';
    case 'verify-ca':
      return 'Encrypted; certificate chain verified (host name not checked)';
    default:
      return 'Encrypted; certificate and host name verified';
  }
}
