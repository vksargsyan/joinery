import {
  JoineryError,
  newId,
  type DriverAdapter,
  type EngineId,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import { createPostgresAdapter } from '@joinery/driver-postgres';

import type { AdapterFactory, Prompter } from './context';
import { CliError } from './errors';
import type { Interrupts } from './interrupt';
import type { Reporter } from './reporter';
import { passwordEnvName, resolvedProfile, withPassword, type Target } from './target';

/** The adapters joinery-cli ships: the same packages the desktop connection host runs. */
export const defaultAdapters: AdapterFactory = (engine: EngineId): DriverAdapter => {
  switch (engine) {
    case 'postgres':
      return createPostgresAdapter();
    case 'mysql':
    case 'mariadb':
      return createMysqlAdapter({ engine });
    default:
      throw new CliError(`joinery-cli cannot connect to ${engine} yet`, { code: 'NOT_SUPPORTED' });
  }
};

export interface ConnectDeps {
  readonly adapters: AdapterFactory;
  readonly prompter: Prompter;
  readonly reporter: Reporter;
}

/** An open session and the target it was opened with (plus any password typed on the way). */
export interface Connection {
  readonly session: Session;
  readonly target: Target;
  readonly dialect: SqlDialect;
}

/**
 * Connects to a target. When the server rejects a login made without a password and there is a
 * terminal, asks for the password and tries once more (psql's behaviour). A `mysql://` target
 * that turns out to be MariaDB is reopened with the MariaDB dialect, so scripts and snapshots
 * use MariaDB rules.
 */
export async function connect(target: Target, deps: ConnectDeps): Promise<Connection> {
  if (target.profile.ssh) {
    throw new CliError('joinery-cli cannot open SSH tunnels yet', {
      code: 'NOT_SUPPORTED',
      hint: 'Open the tunnel yourself (ssh -N -L 15432:db-host:5432 bastion) and connect to the local port with a URI',
    });
  }
  const adapter = deps.adapters(target.profile.engine);
  let current = target;
  let session: Session;
  try {
    session = await adapter.connect(resolvedProfile(current));
  } catch (error) {
    if (!isAuthFailure(error) || current.passwordKnown) throw error;
    if (!deps.prompter.interactive) {
      throw new CliError(error.message, {
        code: 'AUTH_FAILED',
        hint: missingPasswordHint(current),
        cause: error,
      });
    }
    deps.reporter.info(`${current.label}: ${error.message}`);
    current = withPassword(current, await deps.prompter.secret(`Password for ${current.label}: `));
    session = await adapter.connect(resolvedProfile(current));
  }
  if (current.profile.engine === 'mysql' && /mariadb/i.test(session.serverVersion)) {
    deps.reporter.debug(
      `${current.label} is MariaDB ${session.serverVersion}; using the MariaDB dialect`,
    );
    await session.close();
    session = await deps.adapters('mariadb').connect(resolvedProfile(current));
  }
  deps.reporter.debug(`connected to ${current.label}: ${session.engine} ${session.serverVersion}`);
  return { session, target: current, dialect: dialectOf(session.engine) };
}

/** What to do when a login without a password was refused and nobody can be asked. */
export function missingPasswordHint(target: Target): string {
  return target.kind === 'uri'
    ? 'No password was given: put it in the URI, set JOINERY_PASSWORD, or run in a terminal to be asked'
    : `No password was given: set ${passwordEnvName(target.label)} or JOINERY_PASSWORD, or run in a terminal to be asked`;
}

function isAuthFailure(error: unknown): error is JoineryError {
  return error instanceof JoineryError && error.code === 'AUTH_FAILED';
}

/** The SQL dialect of a SQL engine. */
export function dialectOf(engine: EngineId): SqlDialect {
  if (engine === 'postgres' || engine === 'mysql' || engine === 'mariadb') return engine;
  throw new CliError(`${engine} is not a SQL engine`, { code: 'NOT_SUPPORTED' });
}

/** An execution id and the signal that aborts it. */
export interface Execution {
  readonly executionId: string;
  readonly signal: AbortSignal;
}

/**
 * Runs one execution with Ctrl+C wired to it: the interrupt aborts the signal and asks the
 * session to cancel (KILL QUERY / pg_cancel_backend over a control connection), so the server
 * stops the statement too.
 */
export function cancellable<T>(
  interrupts: Interrupts,
  session: Session,
  work: (execution: Execution) => Promise<T>,
): Promise<T> {
  const executionId = newId();
  const controller = new AbortController();
  return interrupts.guard(
    () => {
      controller.abort();
      void session.cancel(executionId).catch(() => undefined);
    },
    () => work({ executionId, signal: controller.signal }),
  );
}

/** Runs one statement to completion, discarding any rows (DDL, DML, ROLLBACK). */
export async function drain(session: Session, sql: string, execution?: Execution): Promise<void> {
  for await (const _chunk of session.execute(sql, execution ?? { executionId: newId() })) {
    // Pulling the iterator is what runs the statement.
  }
}

/** Closes a session, never throwing (used in finally blocks). */
export async function closeQuietly(session: Session | undefined): Promise<void> {
  if (!session) return;
  await session.close().catch(() => undefined);
}
