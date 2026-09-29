import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';

import {
  CONNECTION_CHECK_STEPS,
  ENGINES,
  JoineryError,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';

import { describeTarget, resolveEndpoint, type NetworkTarget } from './endpoint';
import { errorMessage, mapNetworkError } from './errors';

/** Network primitives, injectable so the step logic can be tested without a network. */
export interface CheckConnectionDeps {
  lookup(host: string): Promise<string>;
  /** Opens and closes a TCP connection or Unix socket within `timeoutMs`. */
  probe(target: NetworkTarget, timeoutMs: number): Promise<void>;
  now(): number;
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

function asJoineryError(error: unknown, where: string): JoineryError {
  if (error instanceof JoineryError) return error;
  return (
    mapNetworkError(error, where) ??
    new JoineryError({ code: 'CONNECTION_FAILED', message: errorMessage(error) }, { cause: error })
  );
}

/**
 * The stepwise Test Connection check (spec §4): DNS, TCP, SSH, TLS, auth, ping, version. Yields
 * one result per step as it completes, so the UI can show progress. The first failing step
 * carries the error message and a fix hint; the steps after it are reported as skipped.
 *
 * TLS and auth happen inside the driver handshake, so they are told apart by the connect error:
 * TLS_FAILED fails the TLS step, anything later fails auth.
 */
export async function* checkConnection(
  resolved: ResolvedProfile,
  adapter: DriverAdapter,
  deps: CheckConnectionDeps = defaultDeps,
): AsyncGenerator<ConnectionCheckResult> {
  const reported = new Set<ConnectionCheckStep>();
  const report = (result: ConnectionCheckResult): ConnectionCheckResult => {
    reported.add(result.step);
    return result;
  };
  const skipRest = function* (reason: string): Generator<ConnectionCheckResult> {
    for (const step of CONNECTION_CHECK_STEPS) {
      if (!reported.has(step)) yield { step, status: 'skipped', durationMs: 0, message: reason };
    }
  };
  const failure = (
    step: ConnectionCheckStep,
    started: number,
    error: JoineryError,
  ): ConnectionCheckResult =>
    report({
      step,
      status: 'failed',
      durationMs: Math.round(deps.now() - started),
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    });
  const afterFailure = 'Not run: an earlier step failed';
  const { profile } = resolved;
  const timeoutMs = profile.options.connectTimeoutMs;

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

  let started = deps.now();
  let target: NetworkTarget;
  try {
    target = resolveEndpoint(resolved).target;
  } catch (error) {
    yield failure('dns', started, asJoineryError(error, profile.name));
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
    started = deps.now();
    try {
      const address = await deps.lookup(target.host);
      yield report({
        step: 'dns',
        status: 'ok',
        durationMs: Math.round(deps.now() - started),
        message: `${target.host} resolves to ${address}`,
      });
    } catch (error) {
      yield failure('dns', started, asJoineryError(error, where));
      yield* skipRest(afterFailure);
      return;
    }
  }

  // TCP (or the Unix socket)
  started = deps.now();
  try {
    await deps.probe(target, timeoutMs);
    yield report({
      step: 'tcp',
      status: 'ok',
      durationMs: Math.round(deps.now() - started),
      message: `Connected to ${where}`,
    });
  } catch (error) {
    yield failure('tcp', started, asJoineryError(error, where));
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

  // TLS and auth, through the driver handshake
  const tlsOff = target.kind === 'socket' || profile.tls.mode === 'disable';
  started = deps.now();
  let session: Session;
  try {
    session = await adapter.connect(resolved);
  } catch (error) {
    const mapped = asJoineryError(error, where);
    if (tlsOff) {
      yield report({
        step: 'tls',
        status: 'skipped',
        durationMs: 0,
        message: target.kind === 'socket' ? 'Unix socket' : 'TLS is disabled',
      });
      yield failure('auth', started, mapped);
    } else if (mapped.code === 'TLS_FAILED') {
      yield failure('tls', started, mapped);
    } else if (mapped.code === 'CONNECTION_FAILED' || mapped.code === 'TIMEOUT') {
      // The socket opened, so a failure before login is most often the TLS negotiation.
      yield failure('tls', started, mapped);
    } else {
      yield report({ step: 'tls', status: 'ok', durationMs: 0, message: tlsMessage(resolved) });
      yield failure('auth', started, mapped);
    }
    yield* skipRest(afterFailure);
    return;
  }
  try {
    if (tlsOff) {
      yield report({
        step: 'tls',
        status: 'skipped',
        durationMs: 0,
        message: target.kind === 'socket' ? 'Unix socket' : 'TLS is disabled',
      });
    } else {
      yield report({ step: 'tls', status: 'ok', durationMs: 0, message: tlsMessage(resolved) });
    }
    yield report({
      step: 'auth',
      status: 'ok',
      durationMs: Math.round(deps.now() - started),
      message: 'Logged in',
    });

    started = deps.now();
    try {
      await session.ping();
      yield report({ step: 'ping', status: 'ok', durationMs: Math.round(deps.now() - started) });
    } catch (error) {
      yield failure('ping', started, asJoineryError(error, where));
      yield* skipRest(afterFailure);
      return;
    }

    yield report({
      step: 'version',
      status: 'ok',
      durationMs: 0,
      message: `${ENGINES[session.engine].displayName} ${session.serverVersion}`,
    });
  } finally {
    await session.close().catch(() => undefined);
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
