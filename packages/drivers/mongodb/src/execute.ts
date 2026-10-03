import {
  DEFAULT_PAGE_SIZE,
  QuerybaraError,
  toColumnChunk,
  type ColumnMeta,
  type ExecOptions,
  type ResultChunk,
} from '@querybara/core';
import {
  Int32,
  bsonTag,
  isBsonDocument,
  parseShell,
  type BsonDocument,
} from '@querybara/mongo-tools';
import type { Document } from 'mongodb';

import { RAW_BSON, ejson, type Execution, type MongoContext } from './context';

/** The one column of every `execute` result: each row is a document as canonical Extended JSON. */
export const DOCUMENT_COLUMN: ColumnMeta = {
  name: 'document',
  nativeType: 'document',
  kind: 'json',
};

/** Commands whose reply is a cursor, streamed page by page. */
const CURSOR_COMMANDS = new Set(['find', 'aggregate', 'listCollections', 'listIndexes']);

/** Commands that only run against the admin database; they are sent there whatever is current. */
const ADMIN_COMMANDS = new Set([
  'listDatabases',
  'currentOp',
  'killOp',
  'replSetGetStatus',
  'replSetGetConfig',
  'replSetStepDown',
  'replSetFreeze',
  'getParameter',
  'setParameter',
  'getCmdLineOpts',
  'top',
  'listShards',
  'fsync',
  'fsyncUnlock',
  'logRotate',
  'getLog',
  'setFeatureCompatibilityVersion',
  'killAllSessions',
  'getDefaultRWConcern',
  'setDefaultRWConcern',
  'shutdown',
]);

/** Write commands and the reply field that counts what they changed. */
const WRITE_COUNTS: Readonly<Record<string, string>> = {
  insert: 'n',
  update: 'nModified',
  delete: 'n',
  findAndModify: 'n',
};

/**
 * Parses the text of a command document ({ find: 'c', filter: {...} }, in Extended JSON or
 * shell syntax). Its first key names the command.
 */
export function parseCommand(text: string): { name: string; command: BsonDocument } {
  const value = parseShell(text);
  if (!isBsonDocument(value)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'A command must be a document such as { ping: 1 } or { find: "collection" }',
    });
  }
  const name = Object.keys(value)[0];
  if (name === undefined) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The command document is empty',
    });
  }
  return { name, command: value };
}

/** Adds the page size as the first batch size, unless the command sets its own. */
function withBatchSize(name: string, command: BsonDocument, pageSize: number): BsonDocument {
  const size = new Int32(pageSize);
  if (name === 'find') return 'batchSize' in command ? command : { ...command, batchSize: size };
  const cursor = command['cursor'];
  if (name === 'aggregate' && command['explain'] !== undefined) return command;
  if (isBsonDocument(cursor)) {
    return 'batchSize' in cursor ? command : { ...command, cursor: { ...cursor, batchSize: size } };
  }
  return { ...command, cursor: { batchSize: size } };
}

function countOf(reply: Document, field: string): number | null {
  const value: unknown = reply[field];
  if (typeof value === 'number') return value;
  const tag = bsonTag(value);
  if (tag === 'Int32' || tag === 'Double') return (value as Int32).value;
  if (tag === 'Long') return Number(String(value));
  return null;
}

/**
 * The generic Session.execute for MongoDB: runs one command document against the session's
 * current database (admin-only commands against admin). Cursor commands stream their
 * documents a page at a time as the consumer pulls, other replies are one row; every row is
 * one `document` cell of canonical Extended JSON.
 */
export async function* executeCommand(
  ctx: MongoContext,
  database: string,
  text: string,
  opts: ExecOptions,
): AsyncGenerator<ResultChunk> {
  const started = performance.now();
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE));
  if (
    opts.params !== undefined &&
    (Array.isArray(opts.params) ? opts.params.length > 0 : Object.keys(opts.params).length > 0)
  ) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'MongoDB commands take no parameters; write the values into the command document',
    });
  }
  const { name, command } = parseCommand(text);
  const target = ADMIN_COMMANDS.has(name) ? 'admin' : database;
  let rowCount = 0;
  yield* ctx.stream(
    { executionId: opts.executionId, ...(opts.signal ? { signal: opts.signal } : {}) },
    async function* (exec: Execution): AsyncGenerator<ResultChunk> {
      yield { type: 'columns', resultIndex: 0, columns: [DOCUMENT_COLUMN] };
      if (CURSOR_COMMANDS.has(name) && command['explain'] === undefined) {
        const cursor = exec.track(
          ctx.rawDb(target).runCursorCommand(withBatchSize(name, command, pageSize), {
            session: exec.session,
            ...(RAW_BSON as object),
          }),
        );
        cursor.setBatchSize(pageSize);
        let page: string[] = [];
        for await (const doc of cursor) {
          page.push(ejson(doc));
          if (page.length >= pageSize) {
            rowCount += page.length;
            yield toColumnChunk(
              0,
              1,
              page.map((cell) => [cell]),
            );
            page = [];
          }
        }
        if (page.length > 0) {
          rowCount += page.length;
          yield toColumnChunk(
            0,
            1,
            page.map((cell) => [cell]),
          );
        }
        yield { type: 'status', command: name, rowsAffected: null };
      } else {
        const reply = await ctx
          .rawDb(target)
          .command(command, { session: exec.session, ...RAW_BSON });
        rowCount = 1;
        yield toColumnChunk(0, 1, [[ejson(reply)]]);
        const field = WRITE_COUNTS[name];
        yield {
          type: 'status',
          command: name,
          rowsAffected: field !== undefined ? countOf(reply, field) : null,
        };
      }
      yield { type: 'end', durationMs: Math.round(performance.now() - started), rowCount };
    },
  );
}
