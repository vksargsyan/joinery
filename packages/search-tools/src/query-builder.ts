import {
  inlineJson,
  member,
  nodeText,
  parseJsonTree,
  quoteJson,
  readJsonString,
  type JsonNode,
} from './json';
import type { MappingField } from './mapping';

/**
 * The Elasticsearch query builder's model (spec §11, ADR 0024): a search as plain data (a bool
 * query whose must, filter, should and must_not clauses are conditions on mapped fields, groups
 * of their own, nested groups on a nested field, or clauses kept as written; a sort; and
 * aggregations with sub-aggregations), and the two conversions that keep it in step with the
 * documents view's query bar. `buildDsl` writes the query, sort and aggregations as one-line
 * JSON, or says what is missing; `readDsl` reads that text back into a model. What the builder
 * does not break down (a function_score, a range with a format, a filters aggregation) stays in
 * the model as its JSON, so any valid query opens in the builder, and building what was read
 * gives the same text again. Values are typed by the mapping and kept as written, so a long
 * such as 12345678901234567890 is never rounded.
 */

// ---------------------------------------------------------------------------------------------
// Fields

/** How the builder treats a mapped field. */
export type DslFieldKind =
  'text' | 'keyword' | 'number' | 'date' | 'boolean' | 'ip' | 'geo' | 'object' | 'nested' | 'other';

const KINDS: Readonly<Record<string, DslFieldKind>> = {
  text: 'text',
  match_only_text: 'text',
  search_as_you_type: 'text',
  annotated_text: 'text',
  keyword: 'keyword',
  constant_keyword: 'keyword',
  wildcard: 'keyword',
  flattened: 'keyword',
  version: 'keyword',
  long: 'number',
  integer: 'number',
  short: 'number',
  byte: 'number',
  double: 'number',
  float: 'number',
  half_float: 'number',
  scaled_float: 'number',
  unsigned_long: 'number',
  token_count: 'number',
  date: 'date',
  date_nanos: 'date',
  boolean: 'boolean',
  ip: 'ip',
  geo_point: 'geo',
  object: 'object',
  nested: 'nested',
};

/** A field the builder offers, from the index mapping. */
export interface DslField {
  /** The dotted path queries take: "customer.city", "title.keyword". */
  readonly path: string;
  /** The last segment of the path. */
  readonly name: string;
  /** The mapping type: "keyword", "long", "nested"... */
  readonly type: string;
  readonly kind: DslFieldKind;
  readonly depth: number;
  /** A multi-field (under a field's `fields`), such as "title.keyword". */
  readonly multiField: boolean;
  /** The nested fields the field is inside, outermost first. */
  readonly nested: readonly string[];
  /** For a text field: its keyword multi-field, which sorts and aggregates. */
  readonly keyword?: string;
}

/** The document id, which every index can be queried and sorted by. */
const ID_FIELD: DslField = {
  path: '_id',
  name: '_id',
  type: 'keyword',
  kind: 'keyword',
  depth: 0,
  multiField: false,
  nested: [],
};

/** The fields of a mapping as the builder lists them: `_id`, then the mapping depth first. */
export function dslFields(mapping: readonly MappingField[]): DslField[] {
  const nestedPaths = mapping.filter((f) => f.type === 'nested').map((f) => f.path);
  const out: DslField[] = [ID_FIELD];
  for (const field of mapping) {
    const kind = KINDS[field.type] ?? 'other';
    const keyword =
      kind === 'text'
        ? mapping.find(
            (f) =>
              f.multiField &&
              f.path.startsWith(`${field.path}.`) &&
              KINDS[f.type] === 'keyword' &&
              !f.path.slice(field.path.length + 1).includes('.'),
          )?.path
        : undefined;
    out.push({
      path: field.path,
      name: field.path.slice(field.path.lastIndexOf('.') + 1),
      type: field.type,
      kind,
      depth: field.path.split('.').length - 1,
      multiField: field.multiField,
      nested: nestedPaths.filter((p) => field.path.startsWith(`${p}.`)),
      ...(keyword !== undefined ? { keyword } : {}),
    });
  }
  return out;
}

/** The path to sort or aggregate a field by: a text field's keyword multi-field if it has one. */
export function sortPath(field: DslField | undefined, path: string): string {
  return field?.kind === 'text' && field.keyword !== undefined ? field.keyword : path;
}

// ---------------------------------------------------------------------------------------------
// Conditions

export const DSL_OPERATORS = [
  'match',
  'match_and',
  'match_phrase',
  'match_phrase_prefix',
  'query_string',
  'term',
  'terms',
  'range',
  'exists',
  'prefix',
  'wildcard',
  'regexp',
  'fuzzy',
  'geo_distance',
] as const;

export type DslOperator = (typeof DSL_OPERATORS)[number];

export const DSL_OPERATOR_LABELS: Readonly<Record<DslOperator, string>> = {
  match: 'matches',
  match_and: 'matches all words',
  match_phrase: 'matches the phrase',
  match_phrase_prefix: 'starts with the phrase',
  query_string: 'matches the Lucene query',
  term: 'is',
  terms: 'is one of',
  range: 'is in range',
  exists: 'exists',
  prefix: 'starts with',
  wildcard: 'matches the wildcard',
  regexp: 'matches the regex',
  fuzzy: 'is like',
  geo_distance: 'is within',
};

/** The Query DSL each operator writes, for tooltips. */
export const DSL_OPERATOR_QUERIES: Readonly<Record<DslOperator, string>> = {
  match: 'match: any of the words, analyzed',
  match_and: 'match with "operator": "and": every word, analyzed',
  match_phrase: 'match_phrase: the words in this order',
  match_phrase_prefix: 'match_phrase_prefix: the phrase, the last word as a prefix',
  query_string: 'query_string: Lucene syntax (AND, OR, field:value, wildcards)',
  term: 'term: exactly this value, not analyzed',
  terms: 'terms: exactly one of these values',
  range: 'range: gt, gte, lt, lte; dates take date math such as now-7d/d',
  exists: 'exists: the field has a value',
  prefix: 'prefix: the value starts with this, not analyzed',
  wildcard: 'wildcard: * and ? in the value, not analyzed',
  regexp: 'regexp: a Lucene regular expression over the whole value',
  fuzzy: 'fuzzy: within an edit distance of this value',
  geo_distance: 'geo_distance: within a distance of a point',
};

const OPERATORS_BY_KIND: Readonly<Record<DslFieldKind, readonly DslOperator[]>> = {
  text: [
    'match',
    'match_and',
    'match_phrase',
    'match_phrase_prefix',
    'query_string',
    'exists',
    'prefix',
    'wildcard',
    'regexp',
    'fuzzy',
  ],
  keyword: ['term', 'terms', 'prefix', 'wildcard', 'regexp', 'fuzzy', 'range', 'exists', 'match'],
  number: ['term', 'terms', 'range', 'exists'],
  date: ['range', 'term', 'terms', 'exists'],
  boolean: ['term', 'exists'],
  ip: ['term', 'terms', 'range', 'exists'],
  geo: ['geo_distance', 'exists'],
  object: ['exists'],
  nested: ['exists'],
  other: DSL_OPERATORS.filter((op) => op !== 'query_string'),
};

/** The operators offered for a field ('' is a Lucene query over every field). */
export function operatorsFor(path: string, field: DslField | undefined): DslOperator[] {
  if (path === '') return ['query_string'];
  return [...OPERATORS_BY_KIND[field?.kind ?? 'other']];
}

/** How an operator's value is typed in. */
export type DslValueInput = 'text' | 'value' | 'list' | 'range' | 'geo' | 'none';

export function valueInput(operator: DslOperator): DslValueInput {
  switch (operator) {
    case 'term':
      return 'value';
    case 'terms':
      return 'list';
    case 'range':
      return 'range';
    case 'exists':
      return 'none';
    case 'geo_distance':
      return 'geo';
    default:
      return 'text';
  }
}

export interface DslCondition {
  readonly kind: 'condition';
  readonly id: string;
  /** A field path; '' for a Lucene query over every field. */
  readonly field: string;
  readonly operator: DslOperator;
  /**
   * The value as typed: a value (term), values separated by commas (terms), text (match,
   * prefix, wildcard, regexp, fuzzy, query_string), or "lat,lon" (geo_distance). A value in
   * double quotes is a JSON string: `"42"` is the text 42 on a number field, `"a, b"` one value.
   */
  readonly value: string;
  /** range: the bounds, '' for none. */
  readonly lower: string;
  readonly lowerInclusive: boolean;
  readonly upper: string;
  readonly upperInclusive: boolean;
  /** geo_distance: "10km". */
  readonly distance: string;
}

export const OCCURS = ['must', 'filter', 'should', 'must_not'] as const;

/** Where a clause sits in a bool query. */
export type Occur = (typeof OCCURS)[number];

export type DslClauses = { readonly [O in Occur]: readonly DslItem[] };

/** A bool query; with a path, the nested query around it. */
export interface DslGroup {
  readonly kind: 'group';
  readonly id: string;
  /** '' for a bool query; a nested field's path for a nested query. */
  readonly path: string;
  readonly clauses: DslClauses;
  /** minimum_should_match as typed ("1", "75%"); '' for the default. */
  readonly minimumShouldMatch: string;
}

/** A clause, sort key or aggregation kept as its JSON. */
export interface DslRaw {
  readonly kind: 'dsl';
  readonly id: string;
  readonly text: string;
}

export type DslItem = DslCondition | DslGroup | DslRaw;

// ---------------------------------------------------------------------------------------------
// Sort and aggregations

export interface DslSortField {
  readonly kind: 'field';
  readonly id: string;
  readonly field: string;
  readonly order: 'asc' | 'desc';
  /** Where documents without the field go; '' for the default (last). */
  readonly missing: '' | '_first' | '_last';
}

export type DslSortItem = DslSortField | DslRaw;

export const DSL_AGGREGATIONS = [
  'terms',
  'date_histogram',
  'histogram',
  'avg',
  'sum',
  'min',
  'max',
  'stats',
  'percentiles',
  'cardinality',
  'value_count',
] as const;

export type DslAggregationType = (typeof DSL_AGGREGATIONS)[number];

export const DSL_AGGREGATION_LABELS: Readonly<Record<DslAggregationType | 'dsl', string>> = {
  terms: 'Terms',
  date_histogram: 'Date histogram',
  histogram: 'Histogram',
  avg: 'Average',
  sum: 'Sum',
  min: 'Minimum',
  max: 'Maximum',
  stats: 'Stats',
  percentiles: 'Percentiles',
  cardinality: 'Distinct count',
  value_count: 'Value count',
  dsl: 'JSON',
};

/** Aggregations that make buckets, and so take sub-aggregations. */
export const BUCKET_AGGREGATIONS: ReadonlySet<string> = new Set([
  'terms',
  'date_histogram',
  'histogram',
]);

/** calendar_interval values a date histogram offers (any other is typed as fixed). */
export const CALENDAR_INTERVALS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '1m', label: 'Minute' },
  { value: '1h', label: 'Hour' },
  { value: '1d', label: 'Day' },
  { value: '1w', label: 'Week' },
  { value: '1M', label: 'Month' },
  { value: '1q', label: 'Quarter' },
  { value: '1y', label: 'Year' },
];

export interface DslAggregation {
  readonly id: string;
  readonly name: string;
  readonly type: DslAggregationType | 'dsl';
  readonly field: string;
  /** terms: how many buckets, '' for the default (10). */
  readonly size: string;
  /** date_histogram ("1d", "30m"), histogram ("100"). */
  readonly interval: string;
  /** date_histogram: fixed_interval instead of calendar_interval. */
  readonly fixed: boolean;
  /** dsl: the aggregation as JSON (its type and its own sub-aggregations). */
  readonly text: string;
  /** Sub-aggregations of a bucket aggregation. */
  readonly aggs: readonly DslAggregation[];
}

const AGGREGATIONS_BY_KIND: Readonly<Record<DslFieldKind, readonly DslAggregationType[]>> = {
  text: ['terms', 'cardinality', 'value_count'],
  keyword: ['terms', 'cardinality', 'value_count'],
  number: [
    'stats',
    'histogram',
    'terms',
    'avg',
    'sum',
    'min',
    'max',
    'percentiles',
    'cardinality',
    'value_count',
  ],
  date: ['date_histogram', 'min', 'max', 'terms', 'cardinality', 'value_count'],
  boolean: ['terms', 'value_count'],
  ip: ['terms', 'cardinality', 'value_count'],
  geo: ['value_count'],
  object: [],
  nested: [],
  other: DSL_AGGREGATIONS,
};

/** The aggregations offered for a field, the most useful first. */
export function aggregationsFor(field: DslField | undefined): DslAggregationType[] {
  return [...AGGREGATIONS_BY_KIND[field?.kind ?? 'other']];
}

// ---------------------------------------------------------------------------------------------
// The model

export interface DslModel {
  /** The query: the root bool (its path is always ''). */
  readonly query: DslGroup;
  readonly sort: readonly DslSortItem[];
  readonly aggs: readonly DslAggregation[];
}

/** The query bar's three texts; '' where there is nothing. */
export interface DslTexts {
  readonly query: string;
  readonly sort: string;
  readonly aggs: string;
}

let lastId = 0;

/** A new id for a model item. */
export function dslId(): string {
  lastId += 1;
  return `dsl-${lastId}`;
}

export const NO_CLAUSES: DslClauses = { must: [], filter: [], should: [], must_not: [] };

export function newGroup(path = ''): DslGroup {
  return { kind: 'group', id: dslId(), path, clauses: NO_CLAUSES, minimumShouldMatch: '' };
}

export function emptyDslModel(): DslModel {
  return { query: newGroup(), sort: [], aggs: [] };
}

export function newRaw(text = '{}'): DslRaw {
  return { kind: 'dsl', id: dslId(), text };
}

function defaultOperator(path: string, field: DslField | undefined): DslOperator {
  if (path === '') return 'query_string';
  switch (field?.kind) {
    case 'text':
      return 'match';
    case 'date':
      return 'range';
    case 'geo':
      return 'geo_distance';
    case 'object':
    case 'nested':
      return 'exists';
    default:
      return 'term';
  }
}

export function newCondition(
  path: string,
  field: DslField | undefined,
  patch: Partial<Omit<DslCondition, 'kind' | 'id' | 'field'>> = {},
): DslCondition {
  const operator = patch.operator ?? defaultOperator(path, field);
  return {
    kind: 'condition',
    id: dslId(),
    field: path,
    operator,
    value: field?.kind === 'boolean' && operator === 'term' ? 'true' : '',
    lower: '',
    lowerInclusive: true,
    upper: '',
    upperInclusive: field?.kind === 'date' ? false : true,
    distance: operator === 'geo_distance' ? '10km' : '',
    ...patch,
  };
}

/** A condition with another operator, keeping what it can of the value. */
export function withOperator(condition: DslCondition, operator: DslOperator): DslCondition {
  const from = valueInput(condition.operator);
  const to = valueInput(operator);
  let next: DslCondition = { ...condition, operator };
  if (from === 'range' && to !== 'range' && to !== 'none') {
    next = { ...next, value: condition.lower !== '' ? condition.lower : condition.upper };
  } else if (to === 'range' && from !== 'range' && condition.lower === '') {
    next = {
      ...next,
      lower: from === 'list' ? (splitList(condition.value)[0] ?? '') : condition.value,
    };
  } else if (from === 'list' && to !== 'list') {
    next = { ...next, value: splitList(condition.value)[0] ?? '' };
  }
  if (to === 'geo' && next.distance === '') next = { ...next, distance: '10km' };
  return next;
}

export function newSort(path: string, field: DslField | undefined): DslSortField {
  return {
    kind: 'field',
    id: dslId(),
    field: sortPath(field, path),
    order: path === '_score' || field?.kind === 'date' ? 'desc' : 'asc',
    missing: '',
  };
}

/** The name a new aggregation gets: by_status, created_over_time, avg_total. */
export function aggregationName(type: DslAggregationType | 'dsl', path: string): string {
  if (type === 'dsl') return 'aggregation';
  const base = path.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
  switch (type) {
    case 'terms':
      return `by_${base}`;
    case 'date_histogram':
      return `${base}_over_time`;
    case 'histogram':
      return `${base}_histogram`;
    case 'value_count':
      return `${base}_count`;
    case 'cardinality':
      return `distinct_${base}`;
    default:
      return `${type}_${base}`;
  }
}

/** A name for a new aggregation that its siblings do not use yet. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

export function newAggregation(
  type: DslAggregationType | 'dsl',
  path: string,
  field: DslField | undefined,
  siblings: readonly string[],
): DslAggregation {
  const target = sortPath(field, path);
  return {
    id: dslId(),
    name: uniqueName(aggregationName(type, target), siblings),
    type,
    field: target,
    size: '',
    interval: type === 'date_histogram' ? '1d' : type === 'histogram' ? '10' : '',
    fixed: false,
    text: type === 'dsl' ? `{"terms": {"field": ${quoteJson(target)}}}` : '',
    aggs: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Values

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const GEO_POINT = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const DISTANCE =
  /^\d+(?:\.\d+)?\s*(?:mi|miles|yd|yards|ft|feet|in|inch|km|kilometers|m|meters|cm|centimeters|mm|millimeters|NM|nmi|nauticalmiles)?$/;
const MINIMUM_SHOULD_MATCH = /^-?\d+%?$/;

type Parsed = { readonly json: string } | { readonly problem: string };

/**
 * The JSON of a typed value, by the field's kind: a number field takes a number, a boolean
 * field true or false, text-like fields a string; a field the mapping does not know takes a
 * number or boolean as written and anything else as a string. Double quotes make a string.
 */
export function valueJson(text: string, kind: DslFieldKind | undefined): Parsed {
  const t = text.trim();
  if (t === '') return { problem: 'type a value' };
  if (t.startsWith('"')) {
    try {
      const { value, end } = readJsonString(t, 0);
      if (end === t.length) return { json: quoteJson(value) };
    } catch {
      // Reported below.
    }
    return { problem: 'close the quotes, or leave them out' };
  }
  switch (kind) {
    case 'number':
      return NUMBER.test(t) ? { json: t } : { problem: `${t} is not a number` };
    case 'boolean':
      return t === 'true' || t === 'false' ? { json: t } : { problem: 'true or false' };
    case undefined:
    case 'other':
      return NUMBER.test(t) || t === 'true' || t === 'false' ? { json: t } : { json: quoteJson(t) };
    default:
      return { json: quoteJson(t) };
  }
}

/** Splits a list of values at commas outside double quotes; empty values are dropped. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      current += char;
      if (char === '\\') {
        current += text[i + 1] ?? '';
        i++;
      } else if (char === '"') {
        quoted = false;
      }
    } else if (char === '"' && current.trim() === '') {
      quoted = true;
      current += char;
    } else if (char === ',') {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((value) => value.trim()).filter((value) => value !== '');
}

/** How a JSON value reads back as typed text; undefined for what is not a value. */
function valueText(
  node: JsonNode,
  kind: DslFieldKind | undefined,
  inList: boolean,
): string | undefined {
  if (node.type === 'number') return node.text;
  if (node.type === 'boolean') return String(node.value);
  if (node.type !== 'string') return undefined;
  const plain = valueJson(node.value, kind);
  const same =
    'json' in plain &&
    plain.json === quoteJson(node.value) &&
    !(inList && node.value.includes(','));
  return same ? node.value : quoteJson(node.value);
}

// ---------------------------------------------------------------------------------------------
// Building

export type DslBuild =
  | {
      readonly ok: true;
      readonly texts: DslTexts;
      /** Things that run but may not do what was meant, by item id. */
      readonly warnings: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      /** What is missing or wrong, by item id. */
      readonly issues: Readonly<Record<string, string>>;
      /** The first issue. */
      readonly message: string;
    };

const obj = (entries: readonly (readonly [string, string])[]): string =>
  `{${entries.map(([key, value]) => `${quoteJson(key)}: ${value}`).join(', ')}}`;

const list = (items: readonly string[]): string => `[${items.join(', ')}]`;

class Writer {
  readonly issues: Record<string, string> = {};
  readonly warnings: Record<string, string> = {};
  readonly #fields: ReadonlyMap<string, DslField>;

  constructor(fields: readonly DslField[]) {
    this.#fields = new Map(fields.map((f) => [f.path, f]));
  }

  field(path: string): DslField | undefined {
    return this.#fields.get(path);
  }

  issue(id: string, message: string): undefined {
    this.issues[id] ??= message;
    return undefined;
  }

  raw(item: { readonly id: string; readonly text: string }, what: string): string | undefined {
    if (item.text.trim() === '') return this.issue(item.id, `Write the ${what} as JSON`);
    try {
      const node = parseJsonTree(item.text);
      if (node.type !== 'object') return this.issue(item.id, `The ${what} is a JSON object`);
      return inlineJson(item.text);
    } catch (error) {
      return this.issue(item.id, `The ${what} is not valid JSON: ${(error as Error).message}`);
    }
  }

  item(item: DslItem, scope: readonly string[]): string | undefined {
    switch (item.kind) {
      case 'condition':
        return this.condition(item, scope);
      case 'group':
        return this.group(item, scope, false);
      case 'dsl':
        return this.raw(item, 'clause');
    }
  }

  /** A group's query; undefined for an empty root (no query at all). */
  group(group: DslGroup, scope: readonly string[], root: boolean): string | undefined {
    const inner = group.path === '' ? scope : [...scope, group.path];
    const built: [Occur, string[]][] = OCCURS.map((occur) => [
      occur,
      group.clauses[occur].flatMap((item) => this.item(item, inner) ?? []),
    ]);
    const total = OCCURS.reduce((n, occur) => n + group.clauses[occur].length, 0);
    const msm = group.minimumShouldMatch.trim();
    if (msm !== '' && !MINIMUM_SHOULD_MATCH.test(msm)) {
      this.issue(group.id, 'minimum_should_match is a number or a percentage, such as 1 or 75%');
    }
    let query: string | undefined;
    if (total === 0 && msm === '') {
      query = root && group.path === '' ? undefined : '{"match_all": {}}';
    } else if (total === 1 && group.clauses.must.length === 1 && msm === '') {
      query = built[0]![1][0];
    } else {
      const members: [string, string][] = built
        .filter(([, items]) => items.length > 0)
        .map(([occur, items]) => [occur, list(items)]);
      if (msm !== '')
        members.push(['minimum_should_match', /^-?\d+$/.test(msm) ? msm : quoteJson(msm)]);
      query = obj([['bool', obj(members)]]);
    }
    if (group.path === '') return query;
    if (!/\S/.test(group.path)) return this.issue(group.id, 'Choose the nested field');
    const field = this.field(group.path);
    if (field && field.kind !== 'nested') {
      this.issue(group.id, `${group.path} is not a nested field`);
    }
    return obj([
      [
        'nested',
        obj([
          ['path', quoteJson(group.path)],
          ['query', query ?? '{"match_all": {}}'],
        ]),
      ],
    ]);
  }

  condition(c: DslCondition, scope: readonly string[]): string | undefined {
    const field = this.field(c.field);
    const name = c.field === '' ? 'The Lucene query' : c.field;
    if (c.field === '' && c.operator !== 'query_string') return this.issue(c.id, 'Choose a field');
    const missing = field?.nested.filter((p) => !scope.includes(p)) ?? [];
    if (missing.length > 0) {
      this.warnings[c.id] =
        `${c.field} is inside the nested field ${missing.join(' and ')}: outside a nested group on it, this matches no document`;
    }
    const f = quoteJson(c.field);
    const text = (what: string): string | undefined =>
      c.value.trim() === '' ? this.issue(c.id, `${name}: type ${what}`) : quoteJson(c.value);
    const value = (typed: string): string | undefined => {
      const parsed = valueJson(typed, field?.kind);
      return 'json' in parsed ? parsed.json : this.issue(c.id, `${name}: ${parsed.problem}`);
    };
    switch (c.operator) {
      case 'match':
      case 'match_phrase':
      case 'match_phrase_prefix': {
        const query = text('the text to match');
        return query && obj([[c.operator, obj([[c.field, query]])]]);
      }
      case 'match_and': {
        const query = text('the text to match');
        return (
          query &&
          obj([
            [
              'match',
              obj([
                [
                  c.field,
                  obj([
                    ['query', query],
                    ['operator', '"and"'],
                  ]),
                ],
              ]),
            ],
          ])
        );
      }
      case 'query_string': {
        const query = text('a Lucene query');
        if (query === undefined) return undefined;
        const members: [string, string][] = [['query', query]];
        if (c.field !== '') members.push(['default_field', f]);
        return obj([['query_string', obj(members)]]);
      }
      case 'term': {
        const json = value(c.value);
        return json && obj([['term', obj([[c.field, json]])]]);
      }
      case 'terms': {
        const items = splitList(c.value);
        if (items.length === 0) return this.issue(c.id, `${name}: type one value or more`);
        const json: string[] = [];
        for (const item of items) {
          const one = value(item);
          if (one === undefined) return undefined;
          json.push(one);
        }
        return obj([['terms', obj([[c.field, list(json)]])]]);
      }
      case 'range': {
        if (c.lower.trim() === '' && c.upper.trim() === '') {
          return this.issue(c.id, `${name}: type a lower bound, an upper bound or both`);
        }
        const bounds: [string, string][] = [];
        if (c.lower.trim() !== '') {
          const json = value(c.lower);
          if (json === undefined) return undefined;
          bounds.push([c.lowerInclusive ? 'gte' : 'gt', json]);
        }
        if (c.upper.trim() !== '') {
          const json = value(c.upper);
          if (json === undefined) return undefined;
          bounds.push([c.upperInclusive ? 'lte' : 'lt', json]);
        }
        return obj([['range', obj([[c.field, obj(bounds)]])]]);
      }
      case 'exists':
        return obj([['exists', obj([['field', f]])]]);
      case 'prefix':
      case 'wildcard':
      case 'regexp':
      case 'fuzzy':
        return c.value === ''
          ? this.issue(c.id, `${name}: type a value`)
          : obj([[c.operator, obj([[c.field, quoteJson(c.value)]])]]);
      case 'geo_distance': {
        const point = GEO_POINT.exec(c.value);
        if (!point) return this.issue(c.id, `${name}: type the point as lat,lon`);
        const [lat, lon] = [Number(point[1]), Number(point[2])];
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return this.issue(c.id, `${name}: a latitude is within ±90, a longitude within ±180`);
        }
        const distance = c.distance.trim();
        if (!DISTANCE.test(distance)) {
          return this.issue(c.id, `${name}: type a distance such as 10km or 500m`);
        }
        return obj([
          [
            'geo_distance',
            obj([
              ['distance', quoteJson(distance)],
              [c.field, quoteJson(`${point[1]},${point[2]}`)],
            ]),
          ],
        ]);
      }
    }
  }

  sort(item: DslSortItem): string | undefined {
    if (item.kind === 'dsl') return this.raw(item, 'sort key');
    if (item.field.trim() === '') return this.issue(item.id, 'Choose a field to sort by');
    const order = quoteJson(item.order);
    return obj([
      [
        item.field,
        item.missing === ''
          ? order
          : obj([
              ['order', order],
              ['missing', quoteJson(item.missing)],
            ]),
      ],
    ]);
  }

  aggregations(aggs: readonly DslAggregation[]): string | undefined {
    const names = new Set<string>();
    const members: [string, string][] = [];
    for (const agg of aggs) {
      if (agg.name.trim() === '') {
        this.issue(agg.id, 'Name the aggregation');
        continue;
      }
      if (/[[\]>]/.test(agg.name)) {
        this.issue(agg.id, `${agg.name}: an aggregation name has no [, ] or >`);
        continue;
      }
      if (names.has(agg.name)) {
        this.issue(agg.id, `${agg.name} is used twice`);
        continue;
      }
      names.add(agg.name);
      const body = this.aggregation(agg);
      if (body !== undefined) members.push([agg.name, body]);
    }
    return members.length > 0 ? obj(members) : undefined;
  }

  aggregation(agg: DslAggregation): string | undefined {
    if (agg.type === 'dsl') return this.raw(agg, 'aggregation');
    const label = agg.name;
    if (agg.field.trim() === '') return this.issue(agg.id, `${label}: choose a field`);
    const members: [string, string][] = [['field', quoteJson(agg.field)]];
    switch (agg.type) {
      case 'terms': {
        const size = agg.size.trim();
        if (size !== '') {
          if (!/^[1-9]\d*$/.test(size)) {
            return this.issue(agg.id, `${label}: the size is a whole number above 0`);
          }
          members.push(['size', size]);
        }
        break;
      }
      case 'date_histogram': {
        const interval = agg.interval.trim();
        if (interval === '') return this.issue(agg.id, `${label}: choose an interval`);
        members.push([agg.fixed ? 'fixed_interval' : 'calendar_interval', quoteJson(interval)]);
        break;
      }
      case 'histogram': {
        const interval = agg.interval.trim();
        if (!NUMBER.test(interval) || !(Number(interval) > 0)) {
          return this.issue(agg.id, `${label}: the interval is a number above 0`);
        }
        members.push(['interval', interval]);
        break;
      }
      default:
        break;
    }
    const out: [string, string][] = [[agg.type, obj(members)]];
    if (agg.aggs.length > 0) {
      if (!BUCKET_AGGREGATIONS.has(agg.type)) {
        return this.issue(agg.id, `${label}: only bucket aggregations have sub-aggregations`);
      }
      const sub = this.aggregations(agg.aggs);
      if (sub === undefined) return undefined;
      out.push(['aggs', sub]);
    }
    return obj(out);
  }
}

/**
 * The query bar's texts for a model, or what to fix first. An empty query, sort or aggregation
 * list is ''.
 */
export function buildDsl(model: DslModel, fields: readonly DslField[]): DslBuild {
  const writer = new Writer(fields);
  const query = writer.group(model.query, [], true) ?? '';
  const sortItems = model.sort.flatMap((item) => writer.sort(item) ?? []);
  const aggs = writer.aggregations(model.aggs) ?? '';
  const ids = Object.keys(writer.issues);
  if (ids.length > 0) {
    return { ok: false, issues: writer.issues, message: writer.issues[ids[0]!]! };
  }
  return {
    ok: true,
    texts: { query, sort: sortItems.length > 0 ? list(sortItems) : '', aggs },
    warnings: writer.warnings,
  };
}

/** The search body of the texts, on one line (formatJson spreads it over lines). */
export function dslBody(texts: DslTexts): string {
  const members: [string, string][] = [];
  if (texts.query !== '') members.push(['query', texts.query]);
  if (texts.sort !== '') members.push(['sort', texts.sort]);
  if (texts.aggs !== '') members.push(['aggs', texts.aggs]);
  return obj(members);
}

// ---------------------------------------------------------------------------------------------
// Reading

export type DslRead =
  | { readonly ok: true; readonly model: DslModel }
  | {
      readonly ok: false;
      readonly part: keyof DslTexts;
      readonly problem: string;
    };

interface Reader {
  readonly text: string;
  readonly fields: ReadonlyMap<string, DslField>;
  readonly all: readonly DslField[];
}

/** The only member of an object with one member. */
function only(node: JsonNode | undefined): { key: string; value: JsonNode } | undefined {
  if (node?.type !== 'object' || node.members.length !== 1) return undefined;
  const [m] = node.members;
  return { key: m!.key, value: m!.value };
}

/** The member keys of an object, if they are distinct and all allowed. */
function keysWithin(node: JsonNode, allowed: readonly string[]): Set<string> | undefined {
  if (node.type !== 'object') return undefined;
  const keys = new Set(node.members.map((m) => m.key));
  if (keys.size !== node.members.length) return undefined;
  for (const key of keys) if (!allowed.includes(key)) return undefined;
  return keys;
}

const inline = (r: Reader, node: JsonNode): string => inlineJson(nodeText(r.text, node));

function raw(r: Reader, node: JsonNode): DslRaw {
  return newRaw(inline(r, node));
}

/** A condition from `{"<type>": body}`, or undefined when the builder cannot show it. */
function readCondition(r: Reader, type: string, body: JsonNode): DslCondition | undefined {
  const exists = type === 'exists' && keysWithin(body, ['field'])?.size === 1;
  if (exists) {
    const field = member(body, 'field');
    return field?.type === 'string' ? cond(r, field.value, 'exists', {}) : undefined;
  }
  if (type === 'query_string') {
    const keys = keysWithin(body, ['query', 'default_field']);
    const query = member(body, 'query');
    const field = member(body, 'default_field');
    if (!keys || query?.type !== 'string') return undefined;
    if (field !== undefined && field.type !== 'string') return undefined;
    return cond(r, field?.type === 'string' ? field.value : '', 'query_string', {
      value: query.value,
    });
  }
  if (type === 'geo_distance') {
    if (body.type !== 'object' || body.members.length !== 2) return undefined;
    const distance = member(body, 'distance');
    const point = body.members.find((m) => m.key !== 'distance');
    if (!point || distance === undefined) return undefined;
    const lat = latLon(point.value);
    const d =
      distance.type === 'string' ? distance.value : distance.type === 'number' ? distance.text : '';
    return lat ? cond(r, point.key, 'geo_distance', { value: lat, distance: d }) : undefined;
  }
  const f = only(body);
  if (!f) return undefined;
  const kind = r.fields.get(f.key)?.kind;
  const v = f.value;
  switch (type) {
    case 'match':
    case 'match_phrase':
    case 'match_phrase_prefix': {
      if (v.type === 'string') return cond(r, f.key, type, { value: v.value });
      const query = member(v, 'query');
      if (query?.type !== 'string') return undefined;
      if (keysWithin(v, ['query'])) return cond(r, f.key, type, { value: query.value });
      const operator = member(v, 'operator');
      if (type === 'match' && keysWithin(v, ['query', 'operator']) && operator?.type === 'string') {
        const op = operator.value.toLowerCase();
        if (op === 'and') return cond(r, f.key, 'match_and', { value: query.value });
        if (op === 'or') return cond(r, f.key, 'match', { value: query.value });
      }
      return undefined;
    }
    case 'term': {
      const node = keysWithin(v, ['value'])?.size === 1 ? member(v, 'value')! : v;
      const text = valueText(node, kind, false);
      return text === undefined ? undefined : cond(r, f.key, 'term', { value: text });
    }
    case 'terms': {
      if (v.type !== 'array' || v.items.length === 0) return undefined;
      const texts = v.items.map((item) => valueText(item, kind, true));
      if (texts.some((t) => t === undefined)) return undefined;
      return cond(r, f.key, 'terms', { value: texts.join(', ') });
    }
    case 'range': {
      const keys = keysWithin(v, ['gt', 'gte', 'lt', 'lte']);
      if (!keys || keys.size === 0) return undefined;
      if ((keys.has('gt') && keys.has('gte')) || (keys.has('lt') && keys.has('lte')))
        return undefined;
      const lowerKey = keys.has('gt') ? 'gt' : keys.has('gte') ? 'gte' : undefined;
      const upperKey = keys.has('lt') ? 'lt' : keys.has('lte') ? 'lte' : undefined;
      const lower = lowerKey ? valueText(member(v, lowerKey)!, kind, false) : '';
      const upper = upperKey ? valueText(member(v, upperKey)!, kind, false) : '';
      if (lower === undefined || upper === undefined) return undefined;
      return cond(r, f.key, 'range', {
        lower,
        lowerInclusive: lowerKey !== 'gt',
        upper,
        upperInclusive: upperKey !== 'lt',
      });
    }
    case 'prefix':
    case 'wildcard':
    case 'regexp':
    case 'fuzzy': {
      const node = keysWithin(v, ['value'])?.size === 1 ? member(v, 'value')! : v;
      return node.type === 'string' ? cond(r, f.key, type, { value: node.value }) : undefined;
    }
    default:
      return undefined;
  }
}

function latLon(node: JsonNode): string | undefined {
  if (node.type === 'string') {
    const point = GEO_POINT.exec(node.value);
    return point ? `${point[1]},${point[2]}` : undefined;
  }
  if (node.type === 'array' && node.items.length === 2) {
    const [lon, lat] = node.items;
    return lon?.type === 'number' && lat?.type === 'number' ? `${lat.text},${lon.text}` : undefined;
  }
  const lat = member(node, 'lat');
  const lon = member(node, 'lon');
  if (
    keysWithin(node, ['lat', 'lon'])?.size === 2 &&
    lat?.type === 'number' &&
    lon?.type === 'number'
  ) {
    return `${lat.text},${lon.text}`;
  }
  return undefined;
}

function cond(
  r: Reader,
  field: string,
  operator: DslOperator,
  patch: Partial<DslCondition>,
): DslCondition {
  const info = r.fields.get(field);
  return {
    ...newCondition(field, info, { operator }),
    value: '',
    lower: '',
    lowerInclusive: true,
    upper: '',
    upperInclusive: true,
    distance: '',
    ...patch,
  };
}

/** Whether an item read from text builds again (what the builder shows, it must write). */
function builds(r: Reader, build: (writer: Writer) => unknown): boolean {
  const writer = new Writer(r.all);
  build(writer);
  return Object.keys(writer.issues).length === 0;
}

function readItem(r: Reader, node: JsonNode): DslItem {
  const one = only(node);
  if (one?.key === 'bool') return readBool(r, one.value, '') ?? raw(r, node);
  if (one?.key === 'nested') {
    const keys = keysWithin(one.value, ['path', 'query']);
    const path = member(one.value, 'path');
    const query = member(one.value, 'query');
    if (
      keys?.size === 2 &&
      path?.type === 'string' &&
      /\S/.test(path.value) &&
      query?.type === 'object'
    ) {
      const group = groupOf(r, query, path.value);
      if (builds(r, (w) => w.group(group, [], false))) return group;
    }
    return raw(r, node);
  }
  if (one) {
    const condition = readCondition(r, one.key, one.value);
    if (condition && builds(r, (w) => w.condition(condition, []))) return condition;
  }
  return raw(r, node);
}

function readBool(r: Reader, body: JsonNode, path: string): DslGroup | undefined {
  if (!keysWithin(body, [...OCCURS, 'minimum_should_match'])) return undefined;
  const clauses: Record<Occur, DslItem[]> = { must: [], filter: [], should: [], must_not: [] };
  for (const occur of OCCURS) {
    const node = member(body, occur);
    if (node === undefined) continue;
    const items = node.type === 'array' ? node.items : [node];
    if (items.some((item) => item.type !== 'object')) return undefined;
    clauses[occur] = items.map((item) => readItem(r, item));
  }
  const msm = member(body, 'minimum_should_match');
  let minimumShouldMatch = '';
  if (msm !== undefined) {
    if (msm.type === 'number') minimumShouldMatch = msm.text;
    else if (msm.type === 'string') minimumShouldMatch = msm.value;
    else return undefined;
    if (!MINIMUM_SHOULD_MATCH.test(minimumShouldMatch.trim())) return undefined;
  }
  return { ...newGroup(path), clauses, minimumShouldMatch };
}

/** A query as a group: a bool's clauses, nothing for match_all, else one must clause. */
function groupOf(r: Reader, node: JsonNode, path: string): DslGroup {
  const one = only(node);
  if (one?.key === 'bool') {
    const group = readBool(r, one.value, path);
    if (group) return group;
  }
  if (one?.key === 'match_all' && one.value.type === 'object' && one.value.members.length === 0) {
    return newGroup(path);
  }
  return { ...newGroup(path), clauses: { ...NO_CLAUSES, must: [readItem(r, node)] } };
}

function readSortItem(r: Reader, node: JsonNode): DslSortItem {
  const sortField = (field: string, order?: string, missing?: string): DslSortField => ({
    kind: 'field',
    id: dslId(),
    field,
    order: order === 'asc' || order === 'desc' ? order : field === '_score' ? 'desc' : 'asc',
    missing: missing === '_first' || missing === '_last' ? missing : '',
  });
  if (node.type === 'string' && node.value !== '') return sortField(node.value);
  const one = only(node);
  if (one && one.key !== '') {
    const v = one.value;
    if (v.type === 'string' && (v.value === 'asc' || v.value === 'desc')) {
      return sortField(one.key, v.value);
    }
    if (keysWithin(v, ['order', 'missing'])) {
      const order = member(v, 'order');
      const missing = member(v, 'missing');
      const orderOk =
        order === undefined || (order.type === 'string' && /^(asc|desc)$/.test(order.value));
      const missingOk =
        missing === undefined ||
        (missing.type === 'string' && /^_(first|last)$/.test(missing.value));
      if (orderOk && missingOk) {
        return sortField(
          one.key,
          order?.type === 'string' ? order.value : undefined,
          missing?.type === 'string' ? missing.value : undefined,
        );
      }
    }
  }
  return raw(r, node);
}

function readAggregations(r: Reader, node: JsonNode): DslAggregation[] {
  if (node.type !== 'object') return [];
  return node.members.map((m) => readAggregation(r, m.key, m.value));
}

function readAggregation(r: Reader, name: string, body: JsonNode): DslAggregation {
  const fallback = (): DslAggregation => ({
    ...newAggregation('dsl', '', undefined, []),
    name,
    text: inline(r, body),
  });
  if (body.type !== 'object') return fallback();
  const typeMembers = body.members.filter((m) => m.key !== 'aggs' && m.key !== 'aggregations');
  const subs = body.members.filter((m) => m.key === 'aggs' || m.key === 'aggregations');
  const type = typeMembers[0]?.key;
  if (
    typeMembers.length !== 1 ||
    subs.length > 1 ||
    !(DSL_AGGREGATIONS as readonly string[]).includes(type!) ||
    (subs.length === 1 && (!BUCKET_AGGREGATIONS.has(type!) || subs[0]!.value.type !== 'object'))
  ) {
    return fallback();
  }
  const spec = typeMembers[0]!.value;
  const allowed: Readonly<Record<string, readonly string[]>> = {
    terms: ['field', 'size'],
    date_histogram: ['field', 'calendar_interval', 'fixed_interval'],
    histogram: ['field', 'interval'],
  };
  const keys = keysWithin(spec, allowed[type!] ?? ['field']);
  const field = member(spec, 'field');
  if (!keys || field?.type !== 'string') return fallback();
  const scalar = (key: string): string | undefined => {
    const node = member(spec, key);
    return node?.type === 'number' ? node.text : node?.type === 'string' ? node.value : undefined;
  };
  let interval = '';
  let fixed = false;
  if (type === 'date_histogram') {
    if (keys.has('calendar_interval') === keys.has('fixed_interval')) return fallback();
    fixed = keys.has('fixed_interval');
    const value = member(spec, fixed ? 'fixed_interval' : 'calendar_interval');
    if (value?.type !== 'string') return fallback();
    interval = value.value;
  } else if (type === 'histogram') {
    interval = scalar('interval') ?? '';
  }
  const agg: DslAggregation = {
    id: dslId(),
    name,
    type: type as DslAggregationType,
    field: field.value,
    size: scalar('size') ?? '',
    interval,
    fixed,
    text: '',
    aggs: subs.length === 1 ? readAggregations(r, subs[0]!.value) : [],
  };
  return builds(r, (w) => w.aggregation({ ...agg, aggs: [] })) ? agg : fallback();
}

/**
 * Reads the query bar's texts into a model. The query is Query DSL (a JSON object) or a Lucene
 * query string (read as a query_string condition); the sort a JSON array or one sort key; the
 * aggregations a JSON object. Only text that is not valid JSON fails: what the builder does not
 * break down is kept as JSON.
 */
export function readDsl(texts: DslTexts, fields: readonly DslField[]): DslRead {
  const parse = (part: keyof DslTexts, what: string): JsonNode | DslRead | undefined => {
    const text = texts[part].trim();
    if (text === '') return undefined;
    try {
      return parseJsonTree(text);
    } catch (error) {
      return {
        ok: false,
        part,
        problem: `The ${what} is not valid JSON: ${(error as Error).message}`,
      };
    }
  };
  const isFailure = (value: JsonNode | DslRead | undefined): value is DslRead =>
    value !== undefined && 'ok' in value;

  let query = newGroup();
  const queryText = texts.query.trim();
  if (queryText !== '' && !queryText.startsWith('{')) {
    query = {
      ...query,
      clauses: {
        ...NO_CLAUSES,
        must: [{ ...newCondition('', undefined), value: queryText }],
      },
    };
  } else {
    const node = parse('query', 'query');
    if (isFailure(node)) return node;
    if (node) {
      if (node.type !== 'object')
        return { ok: false, part: 'query', problem: 'The query is a JSON object' };
      query = groupOf(
        { text: texts.query.trim(), fields: fieldMap(fields), all: fields },
        node,
        '',
      );
    }
  }

  const sortNode = parse('sort', 'sort');
  if (isFailure(sortNode)) return sortNode;
  const sortReader = { text: texts.sort.trim(), fields: fieldMap(fields), all: fields };
  const sort = sortNode
    ? (sortNode.type === 'array' ? sortNode.items : [sortNode]).map((item) =>
        readSortItem(sortReader, item),
      )
    : [];

  const aggsNode = parse('aggs', 'aggregations');
  if (isFailure(aggsNode)) return aggsNode;
  if (aggsNode && aggsNode.type !== 'object') {
    return { ok: false, part: 'aggs', problem: 'The aggregations are a JSON object' };
  }
  const aggs = aggsNode
    ? readAggregations({ text: texts.aggs.trim(), fields: fieldMap(fields), all: fields }, aggsNode)
    : [];
  return { ok: true, model: { query, sort, aggs } };
}

function fieldMap(fields: readonly DslField[]): ReadonlyMap<string, DslField> {
  return new Map(fields.map((f) => [f.path, f]));
}
