import {
  ENGINES,
  JoineryError,
  isSqlEngine,
  type ConnectionCheckResult,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { checkConnection as checkSqlConnection } from '@joinery/driver-sql-base';

import { needsTransport } from './endpoint';
import type { TransportManager } from './manager';
import {
  asJoineryError,
  tunnelledProfile,
  type Transport,
  type TransportOptions,
} from './transport';

/** The `ssh` step's result and, when it passed, the open transport (close it when done). */
export interface SshStepOutcome {
  readonly result: ConnectionCheckResult;
  readonly transport?: Transport;
}

/**
 * The `ssh` step of Test Connection (spec §4): opens the profile's SSH chain or proxy and proves
 * the final forward reaches the database endpoint. A failure names the reason and a fix hint
 * (wrong password, key rejected, passphrase missing, host key untrusted or changed, forwarding
 * refused, proxy authentication failed...). A profile without a tunnel or proxy is `skipped`.
 */
export async function runSshStep(
  resolved: ResolvedProfile,
  manager: TransportManager,
  options: Partial<TransportOptions> = {},
): Promise<SshStepOutcome> {
  if (!needsTransport(resolved.profile)) {
    return {
      result: { step: 'ssh', status: 'skipped', durationMs: 0, message: 'No SSH tunnel or proxy' },
    };
  }
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  let transport: Transport | undefined;
  try {
    transport = await manager.open(resolved, options);
    if (!transport) throw new JoineryError({ code: 'INTERNAL', message: 'No transport opened' });
    await transport.probe();
    return {
      result: { step: 'ssh', status: 'ok', durationMs: elapsed(), message: transport.description },
      transport,
    };
  } catch (error) {
    await transport?.close().catch(() => undefined);
    const failure = asJoineryError(error);
    return {
      result: {
        step: 'ssh',
        status: 'failed',
        durationMs: elapsed(),
        message: failure.message,
        ...(failure.hint !== undefined ? { hint: failure.hint } : {}),
      },
    };
  }
}

/**
 * A driver's own Test Connection that opens its `ssh` step through the hook it is given: the
 * MongoDB and Redis drivers' `checkConnection(resolved, { runSshStep })`. DNS and TCP check the
 * first server on the way, the hook opens the tunnel or proxy, and the later steps run through
 * it. This package never imports those drivers (they depend on it); the app attaches the check
 * to its adapter with `withSshStepCheck`.
 */
export type SshStepCheck = (
  resolved: ResolvedProfile,
  deps: { readonly runSshStep: (resolved: ResolvedProfile) => Promise<SshStepOutcome> },
) => AsyncIterable<ConnectionCheckResult>;

/** An adapter that can run its own Test Connection through a tunnel (see SshStepCheck). */
export interface SshStepCheckAdapter extends DriverAdapter {
  readonly checkWithSshStep: SshStepCheck;
}

/**
 * Attaches `check` to `adapter` (a fresh instance: the adapter is changed in place), so
 * `checkConnectionThroughTransport` can test its profiles through an SSH tunnel or proxy.
 */
export function withSshStepCheck<A extends DriverAdapter>(
  adapter: A,
  check: SshStepCheck,
): A & SshStepCheckAdapter {
  return Object.assign(adapter, { checkWithSshStep: check });
}

function sshStepCheckOf(adapter: DriverAdapter): SshStepCheck | undefined {
  const check: unknown = (adapter as Partial<SshStepCheckAdapter>).checkWithSshStep;
  return typeof check === 'function' ? (check as SshStepCheck) : undefined;
}

/**
 * Test Connection for any profile, tunnel or not: what the connection host and joinery-cli call
 * instead of `adapter.checkConnection`. Without a tunnel or proxy it is the adapter's own check;
 * with one, an adapter given an SshStepCheck (MongoDB, Redis) runs it with the SSH step opened
 * through `manager`, and a SQL engine runs the shared stepwise check the same way; the later
 * steps go through the tunnel.
 */
export async function* checkConnectionThroughTransport(
  adapter: DriverAdapter,
  resolved: ResolvedProfile,
  manager: TransportManager,
  options: Partial<TransportOptions> = {},
): AsyncGenerator<ConnectionCheckResult> {
  const engine = resolved.profile.engine;
  if (!needsTransport(resolved.profile) || resolved.endpointOverride) {
    if (!adapter.checkConnection) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `Test Connection is not available for ${ENGINES[engine].displayName} yet`,
      });
    }
    yield* adapter.checkConnection(resolved);
    return;
  }
  const engineCheck = sshStepCheckOf(adapter);
  if (engineCheck) {
    yield* engineCheck(resolved, {
      runSshStep: (profile) => runSshStep(profile, manager, options),
    });
    return;
  }
  if (!isSqlEngine(engine)) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `Test Connection through an SSH tunnel or proxy is not available for ${ENGINES[engine].displayName} yet`,
    });
  }
  yield* checkSqlConnection(resolved, adapter, {
    runSshStep: (profile) => runSshStep(profile, manager, options),
  });
}

/** A driver session opened through a transport, and how to close both. */
export interface TransportSession {
  readonly session: Session;
  /** Undefined when the profile needs no tunnel or proxy. */
  readonly transport?: Transport;
  /** Closes the session, then releases the transport (and its shared SSH sessions). */
  close(): Promise<void>;
}

/**
 * Opens a driver session through the profile's tunnel or proxy (directly when it has neither).
 * When the driver fails because the tunnel did (a refused forward, a dropped SSH session), the
 * tunnel's more precise error is thrown instead of the driver's generic one.
 */
export async function connectThroughTransport(
  adapter: DriverAdapter,
  resolved: ResolvedProfile,
  manager: TransportManager,
  options: Partial<TransportOptions> = {},
): Promise<TransportSession> {
  const transport = await manager.open(resolved, options);
  if (!transport) {
    const session = await adapter.connect(resolved);
    return { session, close: () => session.close() };
  }
  let tunnelFailure: JoineryError | undefined;
  const unsubscribe = transport.onError((error) => {
    tunnelFailure ??= error;
  });
  let session: Session;
  try {
    session = await adapter.connect(tunnelledProfile(resolved, transport));
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw tunnelFailure ? new JoineryError(tunnelFailure.toJSON(), { cause: error }) : error;
  } finally {
    unsubscribe();
  }
  let closing: Promise<void> | undefined;
  return {
    session,
    transport,
    close: () =>
      (closing ??= (async () => {
        try {
          await session.close();
        } finally {
          await transport.close();
        }
      })()),
  };
}
