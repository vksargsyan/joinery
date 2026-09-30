import { utf8Text } from './bytes';
import { replyItems, replyPairs, replyText, type RedisReply } from './reply';

/**
 * RediSearch (the Redis Query Engine, Redis 8 and Redis Stack; valkey-search): FT.INFO and
 * FT.SEARCH replies read into plain objects, FT.CREATE arguments built from a definition and
 * rebuilt from an index's info, and index fields suggested from sample documents. Pure, so the
 * page previews the FT.CREATE it will send.
 */

export const SEARCH_FIELD_TYPES = ['TEXT', 'TAG', 'NUMERIC', 'GEO', 'VECTOR', 'GEOSHAPE'] as const;
export type SearchFieldType = (typeof SEARCH_FIELD_TYPES)[number];

export const SEARCH_KEY_TYPES = ['HASH', 'JSON'] as const;
export type SearchKeyType = (typeof SEARCH_KEY_TYPES)[number];

/** A field of an index as FT.INFO describes it. */
export interface SearchField {
  /** The hash field, or the JSON path. */
  readonly identifier: string;
  /** The name queries use (`@name`). */
  readonly attribute: string;
  readonly type: string;
  /** Options with a value: WEIGHT, SEPARATOR, a vector's algorithm, dim, distance_metric... */
  readonly options: Readonly<Record<string, string>>;
  /** Options without one: SORTABLE, NOSTEM, UNF, CASESENSITIVE... */
  readonly flags: readonly string[];
}

export interface SearchIndexInfo {
  readonly name: string;
  /** HASH or JSON. */
  readonly keyType: string;
  readonly prefixes: readonly string[];
  readonly filter: string | null;
  readonly language: string | null;
  readonly fields: readonly SearchField[];
  readonly documents: number | null;
  readonly terms: number | null;
  readonly records: number | null;
  /** The index's memory, in bytes (from FT.INFO's `*_sz_mb` figures). */
  readonly memoryBytes: number | null;
  /** Documents are still being indexed (a new index over existing keys). */
  readonly indexing: boolean;
  /** 0 to 1. */
  readonly percentIndexed: number | null;
  readonly failures: number;
  readonly lastError: string | null;
  readonly lastErrorKey: string | null;
  /** Every figure FT.INFO gave, nested ones flattened (`gc_stats.bytes_collected`). */
  readonly stats: readonly (readonly [string, string])[];
}

/** A document FT.SEARCH returned. */
export interface SearchDocument {
  readonly key: Uint8Array;
  readonly score: number | null;
  /** Returned fields in the server's order; a JSON index returns `$` (the document). */
  readonly fields: readonly (readonly [string, Uint8Array])[];
}

export interface SearchResult {
  /** Documents that match, of which `documents` is one page. */
  readonly total: number;
  readonly documents: readonly SearchDocument[];
}

export const VECTOR_ALGORITHMS = ['FLAT', 'HNSW'] as const;
export const VECTOR_DISTANCES = ['COSINE', 'L2', 'IP'] as const;
export const VECTOR_DATA_TYPES = ['FLOAT32', 'FLOAT64', 'FLOAT16', 'BFLOAT16'] as const;

export interface SearchVectorOptions {
  readonly algorithm: (typeof VECTOR_ALGORITHMS)[number];
  readonly dim: number;
  readonly distance: (typeof VECTOR_DISTANCES)[number];
  readonly dataType: (typeof VECTOR_DATA_TYPES)[number];
  /** HNSW: edges per node and the build-time candidate list. */
  readonly m?: number;
  readonly efConstruction?: number;
}

/** A field to create. */
export interface SearchFieldDefinition {
  readonly identifier: string;
  /** AS: the name in queries; the identifier when absent (JSON paths need one). */
  readonly attribute?: string;
  readonly type: SearchFieldType;
  readonly sortable?: boolean;
  /** TEXT */
  readonly noStem?: boolean;
  readonly weight?: number;
  readonly phonetic?: string;
  /** TAG */
  readonly separator?: string;
  readonly caseSensitive?: boolean;
  /** VECTOR */
  readonly vector?: SearchVectorOptions;
  /** Also index documents where the field is missing or empty (Redis 7.4+). */
  readonly indexMissing?: boolean;
  readonly indexEmpty?: boolean;
}

/** An index to create. */
export interface SearchIndexDefinition {
  readonly name: string;
  readonly keyType: SearchKeyType;
  readonly prefixes: readonly string[];
  readonly filter?: string;
  readonly language?: string;
  readonly fields: readonly SearchFieldDefinition[];
}

// ---------------------------------------------------------------------------------------------
// FT.INFO

const text = (reply: RedisReply | undefined): string | null =>
  reply === undefined ? null : (replyText(reply) ?? null);

function number(reply: RedisReply | undefined): number | null {
  const value = text(reply);
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whether a reply is an array (or map): a nested group of FT.INFO. */
function nested(reply: RedisReply): boolean {
  return reply.type === 'array' || reply.type === 'map' || reply.type === 'set';
}

/** Option names whose next token is their value, in the attribute arrays. */
const VALUED = new Set(['WEIGHT', 'SEPARATOR', 'PHONETIC']);

/** Options without a value (valkey-search writes them with 0 or 1 after them). */
const FLAGS = new Set([
  'SORTABLE',
  'UNF',
  'NOSTEM',
  'NOINDEX',
  'CASESENSITIVE',
  'WITHSUFFIXTRIE',
  'INDEXEMPTY',
  'INDEXMISSING',
]);

/** One attribute array: identifier, attribute and type pairs, then options and flags. */
function readField(reply: RedisReply): SearchField | null {
  const items = replyItems(reply) ?? [];
  const options: Record<string, string> = {};
  const flags: string[] = [];
  let identifier: string | null = null;
  let attribute: string | null = null;
  let type: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (nested(item)) continue;
    const token = text(item) ?? '';
    const next = items[i + 1];
    const nextText = next !== undefined && !nested(next) ? text(next) : null;
    if (token === 'identifier' || token === 'attribute' || token === 'type') {
      if (token === 'identifier') identifier = nextText;
      else if (token === 'attribute') attribute = nextText;
      else type = nextText;
      i++;
    } else if (VALUED.has(token)) {
      options[token] = nextText ?? '';
      i++;
    } else if (next !== undefined && nested(next)) {
      // valkey-search nests a vector's settings: index → [capacity, dimensions, algorithm → [...]].
      for (const [key, value] of flattenGroup(next, token)) options[key] = value;
      i++;
    } else if (FLAGS.has(token) || (/^[A-Z_]+$/.test(token) && nextText === null)) {
      // A flag: SORTABLE, NOSTEM, UNF... valkey-search writes some with 0 or 1 after them.
      if (nextText === '0' || nextText === '1') {
        if (nextText === '1') flags.push(token);
        i++;
      } else {
        flags.push(token);
      }
    } else if (nextText !== null) {
      // Lower-case settings with a value: algorithm, data_type, dim, distance_metric, M...
      options[token] = nextText;
      i++;
    }
  }
  if (identifier === null && attribute === null) return null;
  return {
    identifier: identifier ?? attribute ?? '',
    attribute: attribute ?? identifier ?? '',
    type: (type ?? '').toUpperCase(),
    options,
    flags,
  };
}

/** A nested group's scalar entries, keyed `prefix.key` (arrays of scalars joined). */
function flattenGroup(reply: RedisReply, prefix: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of replyPairs(reply) ?? []) {
    const key = `${prefix}.${text(k) ?? ''}`;
    if (nested(v)) out.push(...flattenGroup(v, key));
    else out.push([key, text(v) ?? '']);
  }
  return out;
}

const MB = 1024 * 1024;

/** Reads FT.INFO. */
export function parseSearchInfo(reply: RedisReply): SearchIndexInfo {
  const pairs = replyPairs(reply) ?? [];
  const top = new Map<string, RedisReply>();
  const stats: [string, string][] = [];
  for (const [k, v] of pairs) {
    const key = text(k) ?? '';
    top.set(key, v);
    if (key === 'attributes' || key === 'field statistics' || key === 'index_definition') continue;
    if (nested(v)) stats.push(...flattenGroup(v, key));
    else stats.push([key, text(v) ?? '']);
  }
  const definition = new Map<string, RedisReply>();
  for (const [k, v] of replyPairs(top.get('index_definition')) ?? []) {
    definition.set(text(k) ?? '', v);
  }
  const prefixes = definition.get('prefixes');
  const fields = (replyItems(top.get('attributes')) ?? [])
    .map(readField)
    .filter((field): field is SearchField => field !== null);
  const errors = new Map<string, RedisReply>();
  for (const [k, v] of replyPairs(top.get('Index Errors')) ?? []) errors.set(text(k) ?? '', v);
  const memory =
    number(top.get('total_index_memory_sz_mb')) ??
    (() => {
      const parts = [...top.entries()]
        .filter(([key]) => key.endsWith('_sz_mb'))
        .map(([, value]) => number(value) ?? 0);
      return parts.length > 0 ? parts.reduce((sum, n) => sum + n, 0) : null;
    })();
  const lastError = text(errors.get('last indexing error'));
  const lastErrorKey = text(errors.get('last indexing error key'));
  const backfill = number(top.get('backfill_in_progress'));
  const indexing = number(top.get('indexing'));
  return {
    name: text(top.get('index_name')) ?? '',
    keyType: text(definition.get('key_type')) ?? 'HASH',
    prefixes:
      prefixes === undefined
        ? []
        : nested(prefixes)
          ? (replyItems(prefixes) ?? []).map((item) => text(item) ?? '')
          : [text(prefixes) ?? ''],
    filter: text(definition.get('filter')),
    language: text(definition.get('default_language')),
    fields,
    documents: number(top.get('num_docs')),
    terms: number(top.get('num_terms')),
    records: number(top.get('num_records')),
    memoryBytes: memory === null ? null : Math.round(memory * MB),
    indexing: (indexing ?? backfill ?? 0) > 0,
    percentIndexed:
      number(top.get('percent_indexed')) ?? number(top.get('backfill_complete_percent')),
    failures:
      number(top.get('hash_indexing_failures')) ?? number(errors.get('indexing failures')) ?? 0,
    lastError: lastError === 'N/A' ? null : lastError,
    lastErrorKey: lastErrorKey === 'N/A' ? null : lastErrorKey,
    stats,
  };
}

// ---------------------------------------------------------------------------------------------
// FT.SEARCH

function bytesOf(reply: RedisReply | undefined): Uint8Array {
  if (reply?.type === 'bulk' || reply?.type === 'verbatim') return reply.value;
  return new TextEncoder().encode(text(reply) ?? '');
}

/** Reads FT.SEARCH, sent with WITHSCORES or not, with NOCONTENT or not. */
export function parseSearchReply(
  reply: RedisReply,
  options: { readonly withScores?: boolean; readonly noContent?: boolean } = {},
): SearchResult {
  const items = replyItems(reply) ?? [];
  const total = number(items[0]) ?? 0;
  const documents: SearchDocument[] = [];
  for (let i = 1; i < items.length;) {
    const key = bytesOf(items[i++]);
    let score: number | null = null;
    if (options.withScores === true) score = number(items[i++]);
    const fields: [string, Uint8Array][] = [];
    if (options.noContent !== true) {
      const content = items[i++];
      for (const [k, v] of replyPairs(content) ?? []) fields.push([text(k) ?? '', bytesOf(v)]);
    }
    documents.push({ key, score, fields });
  }
  return { total, documents };
}

// ---------------------------------------------------------------------------------------------
// FT.CREATE

/** FT.CREATE's arguments (after the command name) for a definition. */
export function searchCreateArgs(definition: SearchIndexDefinition): string[] {
  const args = [definition.name, 'ON', definition.keyType];
  if (definition.prefixes.length > 0) {
    args.push('PREFIX', String(definition.prefixes.length), ...definition.prefixes);
  }
  if (definition.filter !== undefined && definition.filter.trim() !== '') {
    args.push('FILTER', definition.filter);
  }
  if (definition.language !== undefined && definition.language !== '') {
    args.push('LANGUAGE', definition.language);
  }
  args.push('SCHEMA');
  for (const field of definition.fields) {
    args.push(field.identifier);
    const attribute = field.attribute?.trim();
    if (attribute !== undefined && attribute !== '' && attribute !== field.identifier) {
      args.push('AS', attribute);
    }
    args.push(field.type);
    if (field.type === 'VECTOR' && field.vector) {
      const v = field.vector;
      const params = ['TYPE', v.dataType, 'DIM', String(v.dim), 'DISTANCE_METRIC', v.distance];
      if (v.algorithm === 'HNSW') {
        if (v.m !== undefined) params.push('M', String(v.m));
        if (v.efConstruction !== undefined)
          params.push('EF_CONSTRUCTION', String(v.efConstruction));
      }
      args.push(v.algorithm, String(params.length), ...params);
      continue;
    }
    if (field.type === 'TEXT') {
      if (field.weight !== undefined && field.weight !== 1)
        args.push('WEIGHT', String(field.weight));
      if (field.noStem === true) args.push('NOSTEM');
      if (field.phonetic !== undefined && field.phonetic !== '') {
        args.push('PHONETIC', field.phonetic);
      }
    }
    if (field.type === 'TAG') {
      if (field.separator !== undefined && field.separator !== ',') {
        args.push('SEPARATOR', field.separator);
      }
      if (field.caseSensitive === true) args.push('CASESENSITIVE');
    }
    if (field.indexEmpty === true && (field.type === 'TEXT' || field.type === 'TAG')) {
      args.push('INDEXEMPTY');
    }
    if (field.indexMissing === true) args.push('INDEXMISSING');
    if (field.sortable === true && field.type !== 'GEOSHAPE') args.push('SORTABLE');
  }
  return args;
}

/** A command as a line for redis-cli: arguments quoted where they need it. */
export function commandLine(command: string, args: readonly string[]): string {
  const quote = (arg: string): string =>
    arg !== '' && /^[\w.:$@*\-[\]/{}|]+$/u.test(arg)
      ? arg
      : `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  return [command, ...args.map(quote)].join(' ');
}

const num = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const pick = <T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T =>
  allowed.find((choice) => choice === value?.toUpperCase()) ?? fallback;

/**
 * The definition an index's info describes, for "copy FT.CREATE" and "duplicate": fields,
 * their options and flags, prefixes and filter. Settings FT.INFO does not report (stop words,
 * a custom score field) are not carried over.
 */
export function definitionOf(info: SearchIndexInfo): SearchIndexDefinition {
  const option = (field: SearchField, ...names: string[]): string | undefined => {
    for (const name of names) {
      const hit = Object.entries(field.options).find(
        ([key]) =>
          key.toLowerCase() === name.toLowerCase() ||
          key.toLowerCase().endsWith(`.${name.toLowerCase()}`),
      );
      if (hit) return hit[1];
    }
    return undefined;
  };
  return {
    name: info.name,
    keyType: info.keyType.toUpperCase() === 'JSON' ? 'JSON' : 'HASH',
    prefixes: info.prefixes.filter((prefix) => prefix !== ''),
    ...(info.filter !== null ? { filter: info.filter } : {}),
    fields: info.fields.map((field): SearchFieldDefinition => {
      const type = pick(SEARCH_FIELD_TYPES, field.type, 'TEXT');
      const has = (flag: string): boolean => field.flags.includes(flag);
      const weight = num(field.options['WEIGHT']);
      const separator = field.options['SEPARATOR'];
      const base: SearchFieldDefinition = {
        identifier: field.identifier,
        ...(field.attribute !== field.identifier ? { attribute: field.attribute } : {}),
        type,
        ...(has('SORTABLE') ? { sortable: true } : {}),
        ...(has('NOSTEM') ? { noStem: true } : {}),
        ...(weight !== undefined ? { weight } : {}),
        ...(separator !== undefined && separator !== '' ? { separator } : {}),
        ...(has('CASESENSITIVE') ? { caseSensitive: true } : {}),
        ...(has('INDEXMISSING') ? { indexMissing: true } : {}),
        ...(has('INDEXEMPTY') ? { indexEmpty: true } : {}),
      };
      if (type !== 'VECTOR') return base;
      const m = num(option(field, 'M'));
      const ef = num(option(field, 'ef_construction'));
      return {
        ...base,
        vector: {
          algorithm: pick(VECTOR_ALGORITHMS, option(field, 'algorithm', 'algorithm.name'), 'FLAT'),
          dim: num(option(field, 'dim', 'dimensions')) ?? 0,
          distance: pick(VECTOR_DISTANCES, option(field, 'distance_metric'), 'COSINE'),
          dataType: pick(VECTOR_DATA_TYPES, option(field, 'data_type'), 'FLOAT32'),
          ...(m !== undefined ? { m } : {}),
          ...(ef !== undefined ? { efConstruction: ef } : {}),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Suggested fields

/** A field suggested from sample documents, with what was seen. */
export interface SearchFieldSuggestion extends SearchFieldDefinition {
  /** Sample documents that had the field. */
  readonly seen: number;
  readonly example: string;
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const GEO = /^[+-]?\d{1,3}(?:\.\d+)?,\s*[+-]?\d{1,2}(?:\.\d+)?$/;

/** The field type sample values suggest: numbers, geo points, tags (short, repeated) or text. */
export function suggestFieldType(values: readonly string[]): SearchFieldType {
  const present = values.filter((value) => value !== '');
  if (present.length === 0) return 'TEXT';
  if (present.every((value) => NUMERIC.test(value.trim()))) return 'NUMERIC';
  if (
    present.every((value) => {
      if (!GEO.test(value.trim())) return false;
      const [lon, lat] = value.split(',').map(Number);
      return Math.abs(lon!) <= 180 && Math.abs(lat!) <= 90;
    })
  ) {
    return 'GEO';
  }
  // Tags: comma lists, or short values that repeat (statuses, categories, codes).
  if (present.some((value) => /^[^\s,]+(,[^\s,]+)+$/.test(value))) return 'TAG';
  const distinct = new Set(present);
  const short = present.every((value) => value.length <= 40);
  const repeated =
    distinct.size < present.length && distinct.size <= Math.max(3, present.length / 3);
  return short && repeated ? 'TAG' : 'TEXT';
}

/**
 * Fields suggested from sample documents: each hash field (or JSON scalar and array-of-scalars
 * path) with the type its values suggest, the most common first.
 */
export function suggestSearchFields(
  documents: readonly (readonly (readonly [string, string])[])[],
  keyType: SearchKeyType,
): SearchFieldSuggestion[] {
  const values = new Map<string, string[]>();
  for (const document of documents) {
    for (const [name, value] of document) {
      let list = values.get(name);
      if (!list) {
        list = [];
        values.set(name, list);
      }
      list.push(value);
    }
  }
  return [...values.entries()]
    .map(([identifier, list]): SearchFieldSuggestion => {
      const array = keyType === 'JSON' && identifier.endsWith('[*]');
      const type = array ? 'TAG' : suggestFieldType(list);
      const attribute =
        keyType === 'JSON'
          ? identifier
              .replace(/^\$\.?/, '')
              .replace(/\[\*\]$/, '')
              .replace(/[^\w]+/g, '_')
              .replace(/^_+|_+$/g, '') || 'field'
          : identifier;
      return {
        identifier,
        ...(attribute !== identifier ? { attribute } : {}),
        type,
        ...(type === 'NUMERIC' ? { sortable: true } : {}),
        seen: list.length,
        example: list.find((value) => value !== '')?.slice(0, 80) ?? '',
      };
    })
    .sort((a, b) => b.seen - a.seen || a.identifier.localeCompare(b.identifier));
}

/** A JSON document's scalar paths and arrays of scalars (as `path[*]`), for suggestions. */
export function jsonFields(json: string): [string, string][] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  // JSON.GET with `$` wraps the document in an array.
  if (Array.isArray(root) && root.length === 1 && typeof root[0] === 'object') root = root[0];
  const out: [string, string][] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 6 || out.length > 200) return;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      const scalars = value.filter((item) => typeof item !== 'object' || item === null);
      if (scalars.length > 0 && scalars.length === value.length) {
        out.push([`${path}[*]`, scalars.map(String).join(',')]);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const segment = /^[A-Za-z_]\w*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        walk(child, `${path}${segment}`, depth + 1);
      }
      return;
    }
    out.push([path, String(value)]);
  };
  walk(root, '$', 0);
  return out;
}

/** Hash fields as [name, value] text pairs (binary values are skipped). */
export function hashFields(
  pairs: readonly (readonly [Uint8Array, Uint8Array])[],
): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of pairs) {
    const field = utf8Text(name);
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      continue;
    }
    out.push([field, decoded]);
  }
  return out;
}
