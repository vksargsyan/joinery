import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ENGINES, JoineryError, isSqlEngine, type EngineId } from '@joinery/core';
import {
  EJSON,
  commandSafety,
  fromEjson,
  isBsonDocument,
  parseShell,
  toEjson,
  type BsonDocument,
  type CommandSafety,
} from '@joinery/mongo-tools';
import { connectThroughTransport, needsTransport, type TransportSession } from '@joinery/tunnel';

import { cancellable, closeQuietly, missingPasswordHint } from './connect';
import { CliError, EXIT, formatError, type ExitCode } from './errors';
import type { QueryOptions } from './commands/query';
import { formatDuration, plural, targetFor, writeLine, type Runtime } from './runtime';
import { excerpt } from './safety';
import { findProfile, isConnectionUri, resolvedProfile, withPassword, type Target } from './target';

/**
 * MongoDB in joinery-cli (spec §9): `joinery query <target> -e '<command document>'` runs
 * command documents such as `{ find: "orders", filter: { total: { $gt: 100 } } }` (Extended JSON
 * or shell syntax; an array of them runs in order) through the session's `execute`, and prints
 * the documents as relaxed Extended JSON; `--format json` prints canonical Extended JSON (an
 * array) and `jsonl` one canonical document per line. The write rules apply as for SQL: a
 * read-only target refuses commands that write, destructive commands (drops, multi-document
 * deletes and updates, killOp...) ask or need --yes, and production targets ask before every
 * write.
 */

/** The engine a target names, without resolving secrets: a URI's scheme or a saved profile's. */
export function engineOf(runtime: Runtime, spec: string): EngineId | undefined {
  if (isConnectionUri(spec)) {
    const scheme = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):/i.exec(spec.trim())?.[1]?.toLowerCase();
    return scheme === 'mongodb' || scheme === 'mongodb+srv' ? 'mongodb' : undefined;
  }
  try {
    const store = runtime.store.open({ create: false });
    return store ? findProfile(store, spec).engine : undefined;
  } catch {
    // The normal path reports a missing or ambiguous profile.
    return undefined;
  }
}

/** What a command document does, for the write rules (mongo-tools' shared classifier). */
export { commandSafety, type CommandSafety };

/** Parses the input into command documents: one document, or an array of them. */
export function parseCommands(text: string): BsonDocument[] {
  const value = parseShell(text);
  const commands = Array.isArray(value) ? value : [value];
  if (commands.length === 0 || !commands.every(isBsonDocument)) {
    throw new CliError('A MongoDB command must be a document such as { ping: 1 }', {
      hint: 'Pass one command document, or an array of them to run in order',
    });
  }
  return commands as BsonDocument[];
}

/** One document as the default output prints it: indented relaxed Extended JSON. */
export function relaxedText(ejson: string): string {
  return EJSON.stringify(fromEjson(ejson, 'document'), undefined, 2, { relaxed: true });
}

function readInput(runtime: Runtime, options: QueryOptions): Promise<string> | string {
  if (options.execute !== undefined && options.file !== undefined) {
    throw new CliError('Pass either -e <command> or -f <file>, not both');
  }
  if (options.execute !== undefined) return options.execute;
  if (options.file !== undefined && options.file !== '-') {
    try {
      return readFileSync(resolve(runtime.ctx.cwd, options.file), 'utf8');
    } catch (error) {
      throw new CliError(
        `Cannot read ${options.file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        { code: 'NOT_FOUND' },
      );
    }
  }
  if (runtime.ctx.stdin.isTTY) {
    throw new CliError('No command to run', {
      hint: 'Pass -e "{ ping: 1 }", -f <file>, or pipe a command document into stdin',
    });
  }
  return (async () => {
    let text = '';
    runtime.ctx.stdin.setEncoding?.('utf8');
    for await (const chunk of runtime.ctx.stdin) text += String(chunk);
    return text;
  })();
}

/** Asks (or checks --yes) before a command the write rules stop. */
async function checkCommand(
  runtime: Runtime,
  target: Target,
  command: BsonDocument,
  index: number,
  options: QueryOptions,
  fromStdin: boolean,
): Promise<void> {
  const safety = commandSafety(command);
  if (!safety.writes) return;
  if (target.policy.readOnly) {
    throw new CliError(
      `Command ${index} (${safety.name}) writes, but "${target.label}" is read-only`,
      {
        code: 'READ_ONLY',
        hint:
          target.readOnlySource === 'flag'
            ? 'Writes are refused because --read-only was given'
            : 'The profile is locked read-only; unlock it in the app or use another profile to write',
      },
    );
  }
  const production = target.policy.production;
  if (!safety.destructive && !production && target.policy.confirmWrites !== true) return;
  if (options.yes) return;
  const why = safety.destructive
    ? `${safety.name} can remove or change a lot of data`
    : production
      ? `it writes to the production connection "${target.label}"`
      : `"${target.label}" asks before every write`;
  const { prompter } = runtime.ctx;
  const { reporter } = runtime;
  if (!prompter.interactive || fromStdin) {
    throw new CliError(`Command ${index} needs confirmation: ${why}`, {
      code: 'CONFIRMATION_REQUIRED',
      hint: 'Pass --yes to run it without asking, or run in a terminal to confirm it',
    });
  }
  reporter.print(`Command ${index} needs confirmation: ${why}`);
  reporter.print(excerpt(EJSON.stringify(command, undefined, 2, { relaxed: true })));
  if ((await prompter.confirm('Run it?')) !== 'yes') {
    throw new CliError(`Command ${index} was not confirmed`, { code: 'CONFIRMATION_REQUIRED' });
  }
}

/** Connects to a MongoDB target (through its tunnel), asking for a password once if refused. */
async function openMongo(
  runtime: Runtime,
  target: Target,
  options: QueryOptions,
): Promise<TransportSession & { readonly target: Target }> {
  const adapter = runtime.ctx.adapters('mongodb');
  const open = (current: Target): Promise<TransportSession> =>
    needsTransport(current.profile)
      ? connectThroughTransport(
          adapter,
          resolvedProfile(current),
          runtime.tunnels.manager(options.tunnel),
        )
      : adapter
          .connect(resolvedProfile(current))
          .then((session) => ({ session, close: () => session.close() }));
  runtime.reporter.progress(`Connecting to ${target.label}…`, true);
  try {
    try {
      return { ...(await open(target)), target };
    } catch (error) {
      const refused = error instanceof JoineryError && error.code === 'AUTH_FAILED';
      if (!refused || target.passwordKnown) throw error;
      if (!runtime.ctx.prompter.interactive) {
        throw new CliError(error.message, {
          code: 'AUTH_FAILED',
          hint: missingPasswordHint(target),
          cause: error,
        });
      }
      const retry = withPassword(
        target,
        await runtime.ctx.prompter.secret(`Password for ${target.label}: `),
      );
      return { ...(await open(retry)), target: retry };
    }
  } finally {
    runtime.reporter.clearProgress();
  }
}

/** `joinery query` on a MongoDB target (see the module comment). */
export async function mongoQueryCommand(
  runtime: Runtime,
  spec: string,
  options: QueryOptions,
): Promise<ExitCode> {
  if (options.format === 'csv' || options.format === 'tsv') {
    throw new CliError(
      `MongoDB results print as Extended JSON, not ${options.format.toUpperCase()}`,
      {
        code: 'NOT_SUPPORTED',
        hint: 'Leave --format out for relaxed Extended JSON, or use --format json or jsonl',
      },
    );
  }
  if (options.params.length > 0) {
    throw new CliError('MongoDB commands take no parameters', {
      code: 'NOT_SUPPORTED',
      hint: 'Write the values into the command document',
    });
  }
  const fromStdin =
    options.execute === undefined && (options.file === undefined || options.file === '-');
  const commands = parseCommands(await readInput(runtime, options));
  const target = await targetFor(runtime, spec, options);
  for (const [i, command] of commands.entries()) {
    await checkCommand(runtime, target, command, i + 1, options, fromStdin);
  }
  runtime.interrupts.throwIfInterrupted();
  const connection = await openMongo(runtime, target, options);
  const { session } = connection;
  const { reporter } = runtime;
  let failures = 0;
  let firstJson = true;
  try {
    if (options.format === 'json') await runtime.stdout.write('[');
    for (const [i, command] of commands.entries()) {
      const prefix = commands.length === 1 ? '' : `[${i + 1}] `;
      const started = runtime.ctx.now();
      try {
        let documents = 0;
        let limited = false;
        let status: { command: string | null; rowsAffected: number | null } | undefined;
        await cancellable(runtime.interrupts, session, async (execution) => {
          consume: for await (const chunk of session.execute(toEjson(command), execution)) {
            if (chunk.type === 'status') status = chunk;
            if (chunk.type !== 'rows') continue;
            for (const cell of chunk.data[0] ?? []) {
              if (typeof cell !== 'string') continue;
              if (options.rowLimit > 0 && documents >= options.rowLimit) {
                limited = true;
                break consume;
              }
              documents += 1;
              if (options.format === 'json') {
                await runtime.stdout.write(`${firstJson ? '\n' : ',\n'}${cell}`);
                firstJson = false;
              } else if (options.format === 'jsonl') {
                await writeLine(runtime, cell);
              } else {
                await writeLine(runtime, relaxedText(cell));
              }
            }
          }
        });
        const time = formatDuration(runtime.ctx.now() - started);
        const affected =
          status?.rowsAffected !== null && status?.rowsAffected !== undefined
            ? ` · ${plural(status.rowsAffected, 'document')} affected`
            : '';
        const limit = limited
          ? ` (row limit ${options.rowLimit.toLocaleString('en-US')} reached; more not shown)`
          : '';
        reporter.info(
          `${prefix}${status?.command ?? Object.keys(command)[0]}: ${plural(documents, 'document')}${limit}${affected} · ${time}`,
        );
      } catch (error) {
        if (!(error instanceof JoineryError)) throw error;
        failures += 1;
        reporter.error(formatError(error, { verbose: reporter.verbose }));
        if (!options.continueOnError) break;
      }
    }
    if (options.format === 'json') await runtime.stdout.write(firstJson ? ']\n' : '\n]\n');
  } finally {
    await closeQuietly(connection);
  }
  return failures > 0 ? EXIT.error : EXIT.ok;
}

/** The refusal of a SQL-only command (compare, ddl, import...) for a MongoDB or other target. */
export function sqlOnlyError(target: Target): CliError | undefined {
  const engine = target.profile.engine;
  if (isSqlEngine(engine)) return undefined;
  return new CliError(
    `"${target.label}" is a ${ENGINES[engine].displayName} connection; this command works with PostgreSQL, MySQL and MariaDB`,
    {
      code: 'NOT_SUPPORTED',
      hint: 'Use "joinery test" and "joinery query" with this connection',
    },
  );
}
