import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JoineryError } from '@joinery/core';
import { assertAllowed, type RedisSession } from '@joinery/driver-redis';
import {
  lookupCommand,
  quoteRepr,
  replyToJson,
  splitCommands,
  utf8Text,
  type CommandCatalog,
} from '@joinery/redis-tools';
import { connectThroughTransport, needsTransport, type TransportSession } from '@joinery/tunnel';

import type { QueryOptions } from './commands/query';
import { cancellable, closeQuietly, missingPasswordHint } from './connect';
import { CliError, EXIT, formatError, type ExitCode } from './errors';
import { engineOf } from './mongo';
import { formatDuration, targetFor, writeLine, type Runtime } from './runtime';
import {
  REDIS_SCHEMES,
  isConnectionUri,
  resolvedProfile,
  withPassword,
  type Target,
} from './target';

/**
 * Redis in joinery-cli (spec §10): `joinery query <target> -e 'SET k v'` runs redis-cli style
 * command lines (one command per line, redis-cli quoting) through the session's `execute` and
 * prints redis-cli's output; `--format json` prints each reply tree as JSON (an array), `jsonl`
 * one per line. Commands that would take over the connection (SUBSCRIBE, MONITOR...) are
 * refused. The write rules apply as for SQL: a read-only target refuses writes, destructive
 * commands (FLUSHALL, DEL, CLIENT KILL, ACL changes...) ask or need --yes, and production
 * targets ask before every write.
 */

/** True when the target is a Redis URI or a saved Redis profile. */
export function isRedisTarget(runtime: Runtime, spec: string): boolean {
  if (isConnectionUri(spec)) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(spec.trim())?.[1]?.toLowerCase() ?? '';
    return REDIS_SCHEMES.has(scheme);
  }
  return engineOf(runtime, spec) === 'redis';
}

/**
 * Commands that are destructive whatever the catalog says (the desktop app's rules, in
 * apps/desktop/src/shared/redis-safety.ts, list the same), with why.
 */
const DESTRUCTIVE: Readonly<Record<string, string>> = {
  FLUSHALL: 'deletes every key of every database',
  FLUSHDB: 'deletes every key of the database',
  DEL: 'deletes keys',
  UNLINK: 'deletes keys',
  GETDEL: 'deletes the key',
  RENAME: 'replaces the destination key if it exists',
  SWAPDB: 'swaps two databases',
  MIGRATE: 'moves keys to another server',
  SHUTDOWN: 'stops the server',
  DEBUG: 'can crash or stall the server',
  REPLICAOF: 'changes replication',
  SLAVEOF: 'changes replication',
  FAILOVER: 'changes replication',
  'CLIENT KILL': 'disconnects clients',
  'CLIENT PAUSE': 'pauses every client',
  'ACL SETUSER': 'changes access control',
  'ACL DELUSER': 'changes access control',
  'ACL LOAD': 'changes access control',
  'CONFIG SET': 'changes the server configuration',
  'CONFIG REWRITE': 'rewrites the configuration file',
  'CONFIG RESETSTAT': 'resets the server statistics',
  'SCRIPT FLUSH': 'removes every cached script',
  'FUNCTION FLUSH': 'removes every function library',
  'FUNCTION DELETE': 'removes a function library',
  'FUNCTION RESTORE': 'replaces function libraries',
  'SLOWLOG RESET': 'clears the slow log',
  'LATENCY RESET': 'clears the latency history',
  'XGROUP DESTROY': 'removes a consumer group',
  'MODULE UNLOAD': 'unloads a module',
  'CLUSTER RESET': 'changes the cluster topology',
  'CLUSTER FAILOVER': 'changes the cluster topology',
  'CLUSTER FORGET': 'changes the cluster topology',
  'CLUSTER SETSLOT': 'changes the cluster topology',
};

/** Writes the catalog's flags do not show. */
const WRITES = new Set(['PUBLISH', 'SPUBLISH', 'SCRIPT LOAD', 'FUNCTION LOAD', 'SAVE', 'BGSAVE']);

export interface RedisCommandSafety {
  readonly name: string;
  readonly writes: boolean;
  /** Why the command is destructive; undefined when it is not. */
  readonly destructive?: string;
  /** Not in the server's catalog: a read-only target refuses it (it may write). */
  readonly unknown: boolean;
}

/** Classifies one command (its words) with the server's command catalog. */
export function redisCommandSafety(
  words: readonly string[],
  catalog: CommandCatalog | undefined,
): RedisCommandSafety {
  const name = (words[0] ?? '').toUpperCase();
  const sub = (words[1] ?? '').toUpperCase();
  const full = sub === '' ? name : `${name} ${sub}`;
  const replaces =
    (name === 'COPY' || name === 'RESTORE') &&
    words.some((w, i) => i > 2 && w.toUpperCase() === 'REPLACE');
  if (DESTRUCTIVE[full] !== undefined) {
    return { name: full, writes: true, destructive: DESTRUCTIVE[full], unknown: false };
  }
  const reason =
    DESTRUCTIVE[name] ?? (replaces ? 'replaces the destination key if it exists' : undefined);
  if (reason !== undefined) return { name, writes: true, destructive: reason, unknown: false };
  if (WRITES.has(full)) return { name: full, writes: true, unknown: false };
  if (WRITES.has(name)) return { name, writes: true, unknown: false };
  const found = catalog ? lookupCommand(catalog, words) : undefined;
  if (!found) return { name, writes: catalog === undefined, unknown: catalog !== undefined };
  const writes = found.doc.write || found.doc.flags.includes('may_replicate');
  return { name: found.doc.name, writes, unknown: false };
}

/** A command line that splits back into exactly these arguments (every one redis-cli quoted). */
export function commandLine(args: readonly Uint8Array[]): string {
  return args.map((arg) => quoteRepr(arg)).join(' ');
}

function readInput(runtime: Runtime, options: QueryOptions): Promise<string> | string {
  if (options.execute !== undefined && options.file !== undefined) {
    throw new CliError('Pass either -e <commands> or -f <file>, not both');
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
    throw new CliError('No commands to run', {
      hint: 'Pass -e "GET key", -f <file>, or pipe commands into stdin (one per line)',
    });
  }
  return (async () => {
    let text = '';
    for await (const chunk of runtime.ctx.stdin) text += String(chunk);
    return text;
  })();
}

/** Asks (or checks --yes) before a command the write rules stop; throws when it may not run. */
async function checkCommand(
  runtime: Runtime,
  target: Target,
  safety: RedisCommandSafety,
  index: number,
  line: string,
  options: QueryOptions,
  fromStdin: boolean,
): Promise<void> {
  if (target.policy.readOnly && (safety.writes || safety.unknown)) {
    throw new CliError(
      safety.writes
        ? `Command ${index} (${safety.name}) writes, but "${target.label}" is read-only`
        : `Command ${index} (${safety.name}) is unknown to the server's catalog, and "${target.label}" is read-only`,
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
  const asks =
    safety.destructive !== undefined ||
    (safety.writes && (production || target.policy.confirmWrites === true));
  if (!asks || options.yes) return;
  const why =
    safety.destructive !== undefined
      ? `${safety.name} ${safety.destructive}`
      : production
        ? `it writes to the production connection "${target.label}"`
        : `"${target.label}" asks before every write`;
  const { prompter } = runtime.ctx;
  if (!prompter.interactive || fromStdin) {
    throw new CliError(`Command ${index} needs confirmation: ${why}`, {
      code: 'CONFIRMATION_REQUIRED',
      hint: 'Pass --yes to run it without asking, or run in a terminal to confirm it',
    });
  }
  runtime.reporter.print(`Command ${index} needs confirmation: ${why}`);
  runtime.reporter.print(`    ${line.length > 200 ? `${line.slice(0, 199)}…` : line}`);
  if ((await prompter.confirm('Run it?')) !== 'yes') {
    throw new CliError(`Command ${index} was not confirmed`, { code: 'CONFIRMATION_REQUIRED' });
  }
}

/** Connects to a Redis target (through its tunnel), asking for a password once if refused. */
async function openRedis(
  runtime: Runtime,
  target: Target,
  options: QueryOptions,
): Promise<TransportSession & { readonly target: Target }> {
  const adapter = runtime.ctx.adapters('redis');
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

function isRedisSession(session: TransportSession['session']): session is RedisSession {
  return session.engine === 'redis';
}

/** `joinery query` on a Redis target (see the module comment). */
export async function redisQueryCommand(
  runtime: Runtime,
  spec: string,
  options: QueryOptions,
): Promise<ExitCode> {
  if (options.format === 'csv' || options.format === 'tsv') {
    throw new CliError(
      `Redis replies print as redis-cli output or JSON, not ${options.format.toUpperCase()}`,
      {
        code: 'NOT_SUPPORTED',
        hint: 'Leave --format out for redis-cli output, or use --format json or jsonl',
      },
    );
  }
  if (options.params.length > 0) {
    throw new CliError('Redis commands take no parameters', {
      code: 'NOT_SUPPORTED',
      hint: 'Write the values into the command line',
    });
  }
  const fromStdin =
    options.execute === undefined && (options.file === undefined || options.file === '-');
  let commands: Uint8Array[][];
  try {
    commands = splitCommands(await readInput(runtime, options)).filter((c) => c.length > 0);
  } catch (error) {
    if (error instanceof JoineryError)
      throw new CliError(error.message, { hint: error.hint ?? '' });
    throw error;
  }
  if (commands.length === 0) {
    runtime.reporter.info('No commands to run');
    return EXIT.ok;
  }
  // Commands that would take over the connection are refused before connecting.
  for (const args of commands) {
    try {
      assertAllowed(args.map(utf8Text));
    } catch (error) {
      if (!(error instanceof JoineryError)) throw error;
      const streaming = /^(p|s)?(un)?subscribe$|^monitor$/i.test(utf8Text(args[0]!));
      throw new CliError(error.message, {
        code: 'NOT_SUPPORTED',
        hint: streaming
          ? 'joinery query waits for one reply per command; use the Pub/Sub or Monitor tool of the Joinery app, or redis-cli'
          : (error.hint ?? ''),
      });
    }
  }
  const target = await targetFor(runtime, spec, options);
  runtime.interrupts.throwIfInterrupted();
  const connection = await openRedis(runtime, target, options);
  const { session } = connection;
  const { reporter } = runtime;
  let failures = 0;
  let firstJson = true;
  try {
    if (!isRedisSession(session)) throw new CliError(`"${target.label}" is not a Redis server`);
    const catalog = await session.commandDocs().catch(() => undefined);
    if (options.format === 'json') await runtime.stdout.write('[');
    for (const [i, args] of commands.entries()) {
      const words = args.map(utf8Text);
      const line = commandLine(args);
      const prefix = commands.length === 1 ? '' : `[${i + 1}] `;
      const started = runtime.ctx.now();
      try {
        await checkCommand(
          runtime,
          connection.target,
          redisCommandSafety(words, catalog),
          i + 1,
          line,
          options,
          fromStdin,
        );
        if (options.format === 'json' || options.format === 'jsonl') {
          // The reply tree: the command itself, cancelled with Ctrl+C by dropping the connection.
          const reply = await runtime.interrupts.guard(
            () => void session.close(),
            () => session.command(args),
          );
          const json = JSON.stringify(replyToJson(reply));
          if (options.format === 'json') {
            await runtime.stdout.write(`${firstJson ? '\n' : ',\n'}${json}`);
            firstJson = false;
          } else {
            await writeLine(runtime, json);
          }
          if (reply.type === 'error') throw new CliError(reply.value, { code: 'SQL_ERROR' });
        } else {
          await cancellable(runtime.interrupts, session, async (execution) => {
            for await (const chunk of session.execute(line, execution)) {
              if (chunk.type === 'rows') {
                for (const cell of chunk.data[0] ?? []) await writeLine(runtime, String(cell));
              }
            }
          });
        }
        reporter.info(
          `${prefix}${words[0]?.toUpperCase() ?? ''} · ${formatDuration(runtime.ctx.now() - started)}`,
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
