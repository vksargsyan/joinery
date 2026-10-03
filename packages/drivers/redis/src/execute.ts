import {
  QuerybaraError,
  type ColumnMeta,
  type ExecOptions,
  type ResultChunk,
} from '@querybara/core';
import { formatReply, splitCommands, utf8Text, type RedisReply } from '@querybara/redis-tools';

import { mapRedisError, type RedisErrorContext } from './errors';

/**
 * The CLI's command execution (spec §10): redis-cli tokenizing, refusal of commands that would
 * take over the shared connection, and results as the generic chunk stream (one `reply`
 * column holding the redis-cli formatted text).
 */

const TIMEOUT_LAST = new Set(['blpop', 'brpop', 'brpoplpush', 'blmove', 'bzpopmin', 'bzpopmax']);
const TIMEOUT_FIRST = new Set(['blmpop', 'bzmpop']);

function refuse(message: string, hint: string): QuerybaraError {
  return new QuerybaraError({ code: 'NOT_SUPPORTED', message, hint });
}

function isZero(text: string | undefined): boolean {
  return text !== undefined && Number(text) === 0;
}

/**
 * Throws NOT_SUPPORTED for commands that would hijack the session's connection: Pub/Sub
 * subscriptions, MONITOR, replication (SYNC/PSYNC), blocking commands without a timeout, and
 * commands that change the connection protocol or reply mode.
 */
export function assertAllowed(words: readonly string[]): void {
  const name = (words[0] ?? '').toLowerCase();
  const sub = (words[1] ?? '').toLowerCase();
  switch (name) {
    case 'subscribe':
    case 'psubscribe':
    case 'ssubscribe':
    case 'unsubscribe':
    case 'punsubscribe':
    case 'sunsubscribe':
      throw refuse(
        `${name.toUpperCase()} would turn this connection into a subscriber`,
        'Use the Pub/Sub tool, which subscribes on its own connection',
      );
    case 'monitor':
      throw refuse(
        'MONITOR would take over this connection',
        'Use the Monitor tool, which runs MONITOR on its own connection',
      );
    case 'sync':
    case 'psync':
    case 'replconf':
      throw refuse(
        `${name.toUpperCase()} is part of the replication protocol`,
        'It cannot run from a client session',
      );
    case 'quit':
    case 'reset':
      throw refuse(
        `${name.toUpperCase()} would reset or close the session's connection`,
        'Close the tab or disconnect instead',
      );
    case 'hello':
      if (words[1] !== undefined && words[1] !== '2') {
        throw refuse(
          'Querybara sessions speak RESP2',
          'Run HELLO without a protocol version, or HELLO 2',
        );
      }
      return;
    case 'client':
      if (sub === 'reply') {
        throw refuse(
          'CLIENT REPLY would desynchronise the session',
          'Replies cannot be turned off in Querybara',
        );
      }
      return;
    case 'wait':
      if (isZero(words[2])) {
        throw refuse(
          'WAIT with timeout 0 would block the connection forever',
          'Give WAIT a timeout in milliseconds',
        );
      }
      return;
    case 'waitaof':
      if (isZero(words[3])) {
        throw refuse(
          'WAITAOF with timeout 0 would block the connection forever',
          'Give WAITAOF a timeout in milliseconds',
        );
      }
      return;
    case 'xread':
    case 'xreadgroup': {
      const block = words.findIndex((w, i) => i > 0 && w.toLowerCase() === 'block');
      if (block > 0 && isZero(words[block + 1])) {
        throw refuse(
          `${name.toUpperCase()} BLOCK 0 would block the connection forever`,
          'Give BLOCK a timeout in milliseconds, or browse the stream in the stream editor',
        );
      }
      return;
    }
    default:
      if (TIMEOUT_LAST.has(name) && isZero(words[words.length - 1])) {
        throw refuse(
          `${name.toUpperCase()} with timeout 0 would block the connection forever`,
          'Give it a timeout in seconds (it can still be cancelled)',
        );
      }
      if (TIMEOUT_FIRST.has(name) && isZero(words[1])) {
        throw refuse(
          `${name.toUpperCase()} with timeout 0 would block the connection forever`,
          'Give it a timeout in seconds (it can still be cancelled)',
        );
      }
  }
}

/** Runs one command for `execute`: the session's user-command path (gate, cancel, tracking). */
export type CommandRunner = (
  args: readonly Uint8Array[],
  index: number,
) => Promise<{ readonly reply: RedisReply; readonly node?: string }>;

const REPLY_COLUMN: ColumnMeta = { name: 'reply', nativeType: 'redis-reply', kind: 'string' };
const NODE_COLUMN: ColumnMeta = { name: 'node', nativeType: 'redis-node', kind: 'string' };

/**
 * Executes command text: one command per line (line breaks inside quotes belong to the
 * argument), each as its own result set with a `reply` column (plus `node` in Cluster mode).
 * An error reply stops the run and is thrown as a QuerybaraError.
 */
export async function* executeText(
  text: string,
  opts: ExecOptions,
  run: CommandRunner,
  context: RedisErrorContext,
  cluster: boolean,
): AsyncGenerator<ResultChunk> {
  const started = performance.now();
  const commands = splitCommands(text);
  for (const args of commands) assertAllowed(args.map(utf8Text));
  let rowCount = 0;
  for (const [index, args] of commands.entries()) {
    if (opts.signal?.aborted) throw new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' });
    const name = utf8Text(args[0]!).toUpperCase();
    const { reply, node } = await run(args, index);
    if (reply.type === 'error') {
      const error = new Error(reply.value);
      error.name = 'ReplyError';
      throw mapRedisError(error, { ...context, command: name });
    }
    yield {
      type: 'columns',
      resultIndex: index,
      columns: cluster ? [REPLY_COLUMN, NODE_COLUMN] : [REPLY_COLUMN],
    };
    const formatted = formatReply(reply, 'cli');
    yield {
      type: 'rows',
      resultIndex: index,
      rowCount: 1,
      data: cluster ? [[formatted], [node ?? null]] : [[formatted]],
    };
    yield { type: 'status', command: name, rowsAffected: null };
    rowCount += 1;
  }
  yield { type: 'end', durationMs: Math.round(performance.now() - started), rowCount };
}
