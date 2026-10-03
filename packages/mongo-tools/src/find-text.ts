import { QuerybaraError } from '@querybara/core';

import {
  bsonTag,
  fromEjson,
  isBsonDocument,
  toEjson,
  type BsonDocument,
  type BsonValue,
} from './bson';
import { formatShell, formatShellInline, quoteShellString } from './shell/format';
import type { Token } from './shell/lexer';
import { ShellParser, type ShellParseOptions } from './shell/parser';
import type { FindQuery } from './wire';

/**
 * The query bar model (spec §9): the visual builder edits it, and the `db.coll.find(...)` text
 * shown beside the builder is generated from it and parsed back into it when edited by hand.
 */
export interface QueryModel {
  readonly filter: BsonDocument;
  readonly projection?: BsonDocument;
  readonly sort?: BsonDocument;
  readonly skip?: number;
  readonly limit?: number;
  readonly collation?: BsonDocument;
  /** An index key pattern or an index name. */
  readonly hint?: BsonDocument | string;
  readonly maxTimeMS?: number;
}

export interface ParsedFindText {
  /** The collection the text names, or undefined for a bare `find(...)` or `{ filter }`. */
  readonly collection?: string;
  readonly query: QueryModel;
}

/** Database methods and properties that shadow a collection of the same name in `db.<name>`. */
const DB_MEMBERS = new Set([
  'adminCommand',
  'aggregate',
  'auth',
  'commandHelp',
  'createCollection',
  'createRole',
  'createUser',
  'createView',
  'currentOp',
  'dropAllRoles',
  'dropAllUsers',
  'dropDatabase',
  'dropRole',
  'dropUser',
  'fsyncLock',
  'fsyncUnlock',
  'getCollection',
  'getCollectionInfos',
  'getCollectionNames',
  'getMongo',
  'getName',
  'getProfilingStatus',
  'getReplicationInfo',
  'getRole',
  'getRoles',
  'getSiblingDB',
  'getUser',
  'getUsers',
  'grantRolesToRole',
  'grantRolesToUser',
  'hello',
  'help',
  'hostInfo',
  'isMaster',
  'killOp',
  'listCommands',
  'logout',
  'printCollectionStats',
  'revokeRolesFromRole',
  'revokeRolesFromUser',
  'rotateCertificates',
  'runCommand',
  'serverBuildInfo',
  'serverStatus',
  'setLogLevel',
  'setProfilingLevel',
  'shutdownServer',
  'sql',
  'stats',
  'updateRole',
  'updateUser',
  'version',
  'watch',
]);

/** `db.name` when the name can be written that way, else `db.getCollection('name')`. */
export function collectionReference(collection: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) && !DB_MEMBERS.has(collection)
    ? `db.${collection}`
    : `db.getCollection(${quoteShellString(collection)})`;
}

function isEmpty(doc: BsonDocument | undefined): boolean {
  return doc === undefined || Object.keys(doc).length === 0;
}

/**
 * The `db.coll.find(filter, projection).sort(...).skip(n).limit(n).collation(...)` text for a
 * query. Empty parts are left out. With `multiline`, long documents wrap as mongosh prints them.
 */
export function formatFindText(
  collection: string,
  query: QueryModel,
  options: { readonly multiline?: boolean } = {},
): string {
  const doc = (value: BsonValue): string =>
    options.multiline ? formatShell(value) : formatShellInline(value);
  const args = [doc(query.filter)];
  if (!isEmpty(query.projection)) args.push(doc(query.projection!));
  let text = `${collectionReference(collection)}.find(${args.join(', ')})`;
  const chain = (method: string, arg: string): void => {
    text += options.multiline ? `\n  .${method}(${arg})` : `.${method}(${arg})`;
  };
  if (!isEmpty(query.sort)) chain('sort', doc(query.sort!));
  if (query.skip !== undefined && query.skip > 0) chain('skip', String(query.skip));
  if (query.limit !== undefined && query.limit > 0) chain('limit', String(query.limit));
  if (!isEmpty(query.collation)) chain('collation', doc(query.collation!));
  if (query.hint !== undefined) {
    chain('hint', typeof query.hint === 'string' ? quoteShellString(query.hint) : doc(query.hint));
  }
  if (query.maxTimeMS !== undefined) chain('maxTimeMS', String(query.maxTimeMS));
  return text;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class FindTextParser extends ShellParser {
  private readonly query: Mutable<QueryModel> = { filter: {} };

  parse(): ParsedFindText {
    const first = this.lexer.peek();
    if (this.isPunct(first, '{')) {
      this.query.filter = this.document(first, 'filter');
      this.expectEnd();
      return { query: this.query };
    }
    let collection: string | undefined;
    if (first.kind === 'ident' && first.value === 'db') {
      this.lexer.next();
      collection = this.receiver();
      this.expect('.');
    }
    const method = this.lexer.next();
    if (method.kind !== 'ident' || method.value !== 'find') this.unexpected(method, 'find(...)');
    this.findArgs();
    for (;;) {
      const token = this.lexer.peek();
      if (!this.isPunct(token, '.')) break;
      this.lexer.next();
      this.cursorMethod();
    }
    this.expectEnd();
    return { ...(collection !== undefined ? { collection } : {}), query: this.query };
  }

  /** `.name`, `.getCollection('name')` or `['name']` after `db`. */
  private receiver(): string {
    const token = this.lexer.next();
    if (this.isPunct(token, '[')) {
      const name = this.lexer.next();
      if (name.kind !== 'string') this.unexpected(name, 'a collection name string');
      this.expect(']');
      return name.value;
    }
    if (!this.isPunct(token, '.')) this.unexpected(token, "'.'");
    const name = this.lexer.next();
    if (name.kind !== 'ident') {
      this.unexpected(name, 'a collection name');
    }
    if (name.value !== 'getCollection') {
      if (this.isPunct(this.lexer.peek(), '-')) {
        this.fail(name.start, 'This collection name must be quoted', "Write db.getCollection('…')");
      }
      return name.value;
    }
    this.expect('(');
    const arg = this.lexer.next();
    if (arg.kind !== 'string') this.unexpected(arg, 'a collection name string');
    this.expect(')');
    return arg.value;
  }

  private document(at: Token, what: string): BsonDocument {
    const value = this.parseValue();
    if (!isBsonDocument(value)) this.fail(at.start, `The ${what} must be a document { ... }`);
    return value;
  }

  private integer(at: Token, what: string): number {
    const value = this.parseValue();
    const n =
      typeof value === 'number'
        ? value
        : bsonTag(value) === 'Int32' || bsonTag(value) === 'Double'
          ? (value as { value: number }).value
          : bsonTag(value) === 'Long'
            ? Number((value as { toString(): string }).toString())
            : NaN;
    if (!Number.isSafeInteger(n) || n < 0) {
      this.fail(at.start, `${what} expects a non-negative integer`);
    }
    return n;
  }

  /** Arguments of one call; each is parsed by `each` with its first token. */
  private args(each: (at: Token, index: number) => void, max: number, name: string): number {
    this.expect('(');
    let count = 0;
    for (;;) {
      const token = this.lexer.peek();
      if (this.isPunct(token, ')')) {
        this.lexer.next();
        return count;
      }
      if (count >= max) this.fail(token.start, `${name}() takes at most ${max} arguments`);
      each(token, count);
      count += 1;
      const after = this.lexer.next();
      if (this.isPunct(after, ')')) return count;
      if (!this.isPunct(after, ',')) this.unexpected(after, "',' or ')'");
    }
  }

  private findArgs(): void {
    this.args(
      (at, index) => {
        if (index === 0) this.query.filter = this.document(at, 'filter');
        else if (index === 1) this.query.projection = this.document(at, 'projection');
        else this.findOptions(this.document(at, 'options'), at);
      },
      3,
      'find',
    );
  }

  /** The third find() argument: { sort, skip, limit, projection, collation, hint, maxTimeMS }. */
  private findOptions(options: BsonDocument, at: Token): void {
    for (const [key, value] of Object.entries(options)) {
      const number = (): number => {
        const n = typeof value === 'number' ? value : Number((value as object).valueOf());
        if (!Number.isSafeInteger(n) || n < 0) this.fail(at.start, `${key} must be an integer`);
        return n;
      };
      const doc = (): BsonDocument => {
        if (!isBsonDocument(value)) this.fail(at.start, `${key} must be a document`);
        return value;
      };
      switch (key) {
        case 'sort':
          this.query.sort = doc();
          break;
        case 'projection':
          this.query.projection = doc();
          break;
        case 'collation':
          this.query.collation = doc();
          break;
        case 'skip':
          this.query.skip = number();
          break;
        case 'limit':
          this.query.limit = number();
          break;
        case 'maxTimeMS':
          this.query.maxTimeMS = number();
          break;
        case 'hint':
          this.query.hint = typeof value === 'string' ? value : doc();
          break;
        default:
          this.fail(at.start, `Unsupported find() option "${key}"`);
      }
    }
  }

  private cursorMethod(): void {
    const token = this.lexer.next();
    if (token.kind !== 'ident') this.unexpected(token, 'a cursor method');
    const one = (read: (at: Token) => void): void => {
      const count = this.args((at) => read(at), 1, token.value);
      if (count !== 1) this.fail(token.start, `${token.value}() takes one argument`);
    };
    switch (token.value) {
      case 'sort':
        return one((at) => (this.query.sort = this.document(at, 'sort')));
      case 'projection':
      case 'project':
        return one((at) => (this.query.projection = this.document(at, 'projection')));
      case 'collation':
        return one((at) => (this.query.collation = this.document(at, 'collation')));
      case 'skip':
        return one((at) => (this.query.skip = this.integer(at, 'skip()')));
      case 'limit':
        return one((at) => (this.query.limit = this.integer(at, 'limit()')));
      case 'maxTimeMS':
        return one((at) => (this.query.maxTimeMS = this.integer(at, 'maxTimeMS()')));
      case 'hint':
        return one((at) => {
          const value = this.parseValue();
          if (typeof value !== 'string' && !isBsonDocument(value)) {
            this.fail(at.start, 'hint() expects an index name or a key pattern');
          }
          this.query.hint = value;
        });
      case 'pretty':
        this.args(() => undefined, 0, 'pretty');
        return;
      default:
        this.fail(
          token.start,
          `Unsupported cursor method "${token.value}"`,
          'Use sort, skip, limit, projection, collation, hint or maxTimeMS',
        );
    }
  }
}

/**
 * Parses find() text back into the query model. Accepts `db.coll.find(...)`,
 * `db.getCollection('coll').find(...)`, `db['coll'].find(...)`, a bare `find(...)`, or just a
 * filter document; chained sort, skip, limit, projection, collation, hint and maxTimeMS; and
 * find's third options argument. Errors are ShellParseErrors with line and column.
 */
export function parseFindText(text: string, options?: ShellParseOptions): ParsedFindText {
  return new FindTextParser(text, options).parse();
}

/** The model as it crosses processes: documents as canonical Extended JSON. */
export function toFindQuery(query: QueryModel): FindQuery {
  const out: Mutable<FindQuery> = { filter: toEjson(query.filter) };
  if (query.projection !== undefined) out.projection = toEjson(query.projection);
  if (query.sort !== undefined) out.sort = toEjson(query.sort);
  if (query.skip !== undefined) out.skip = query.skip;
  if (query.limit !== undefined) out.limit = query.limit;
  if (query.collation !== undefined) out.collation = toEjson(query.collation);
  if (query.hint !== undefined) out.hint = toEjson(query.hint);
  if (query.maxTimeMS !== undefined) out.maxTimeMS = query.maxTimeMS;
  return out;
}

function ejsonDocument(text: string, what: string): BsonDocument {
  const value = fromEjson(text, what);
  if (!isBsonDocument(value)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The ${what} must be a document`,
    });
  }
  return value;
}

/** The inverse of `toFindQuery`. */
export function fromFindQuery(query: FindQuery): QueryModel {
  const out: Mutable<QueryModel> = {
    filter: query.filter !== undefined ? ejsonDocument(query.filter, 'filter') : {},
  };
  if (query.projection !== undefined)
    out.projection = ejsonDocument(query.projection, 'projection');
  if (query.sort !== undefined) out.sort = ejsonDocument(query.sort, 'sort');
  if (query.skip !== undefined) out.skip = query.skip;
  if (query.limit !== undefined) out.limit = query.limit;
  if (query.collation !== undefined) out.collation = ejsonDocument(query.collation, 'collation');
  if (query.hint !== undefined) {
    const hint = fromEjson(query.hint, 'hint');
    if (typeof hint !== 'string' && !isBsonDocument(hint)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'The hint must be an index name or a key pattern',
      });
    }
    out.hint = hint;
  }
  if (query.maxTimeMS !== undefined) out.maxTimeMS = query.maxTimeMS;
  return out;
}
