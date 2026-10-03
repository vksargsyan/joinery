import { newId } from '@querybara/core';
import {
  BSONRegExp,
  BSON_TYPES,
  BSON_TYPE_NAMES,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  ShellParseError,
  UUID,
  bsonTag,
  bsonTypeOf,
  formatShellInline,
  fromEjson,
  isBsonDocument,
  parseIsoDate,
  parseShell,
  serverTypeName,
  type BsonDocument,
  type BsonTypeName,
  type BsonValue,
  type QueryModel,
  type SchemaAnalysis,
  type SchemaField,
  type SchemaTypeCount,
} from '@querybara/mongo-tools';

/**
 * The visual query builder's model (spec §9, "Browsing and editing"): the fields to build with,
 * taken from a schema sample; filter conditions combined with AND, plus OR groups one level
 * deep; projection, sort, skip and limit. Two conversions keep the builder and the find() text
 * in step: builder state to a query model, with typed values so the Extended JSON keeps Int32,
 * Int64, Double, Decimal128, ObjectId, dates and UUIDs; and a query model back to builder state
 * when the query uses only what the builder can show (otherwise the reason why not). Pure.
 */

// ---------------------------------------------------------------------------------------------
// Fields

/** A field the builder offers, from the schema sample. */
export interface BuilderField {
  /** Dot notation, as filters, projections and sorts take it: "address.city", "items.sku". */
  readonly path: string;
  /** The schema's display path: "items[].sku". */
  readonly display: string;
  /** The last segment of the path. */
  readonly name: string;
  readonly depth: number;
  /** The most common type at the path; nulls count only when nothing else was seen. */
  readonly type: BsonTypeName;
  /** For arrays: the elements' most common type (undefined when every array was empty). */
  readonly elementType?: BsonTypeName;
  /** Every type seen, most frequent first. */
  readonly types: readonly BsonTypeName[];
  /** Share of the sampled documents that have the field. */
  readonly share: number;
  /** The sample's most common values, as the value editor shows them. */
  readonly suggestions: readonly string[];
}

function dominantType(types: readonly SchemaTypeCount[]): BsonTypeName {
  const found = types.find((t) => t.type !== 'null' && t.type !== 'undefined') ?? types[0];
  return found?.type ?? 'null';
}

/** The type conditions on a field compare against: an array's elements, else the field's. */
export function baseType(field: BuilderField | undefined): BsonTypeName | undefined {
  if (!field) return undefined;
  return field.type === 'array' ? field.elementType : field.type;
}

/**
 * The analysed fields as the builder lists them, depth first: sub-document fields under their
 * parent, and the fields of documents inside arrays by their dot path ("items.sku"), which
 * MongoDB matches against every element.
 */
export function builderFields(analysis: SchemaAnalysis): BuilderField[] {
  const out: BuilderField[] = [];
  const index = new Map<string, number>();
  const visit = (field: SchemaField, depth: number): void => {
    const type = dominantType(field.types);
    const elements = type === 'array' ? field.items : undefined;
    const elementType = elements ? dominantType(elements.types) : undefined;
    const valueType = valueTypeFor(type === 'array' ? elementType : type);
    const suggestions =
      valueType === 'shell'
        ? []
        : (elements ?? field).topValues.flatMap((top) => {
            const shown = valueText(fromEjson(top.value));
            return shown.type === valueType ? [shown.text] : [];
          });
    const entry: BuilderField = {
      path: field.queryPath,
      display: field.path,
      name: field.name,
      depth,
      type,
      ...(elementType !== undefined ? { elementType } : {}),
      types: field.types.map((t) => t.type),
      share: field.share,
      suggestions,
    };
    const seen = index.get(entry.path);
    if (seen === undefined) {
      index.set(entry.path, out.length);
      out.push(entry);
    } else {
      // The same dot path from a sub-document and from documents in an array: one entry.
      const first = out[seen]!;
      out[seen] = {
        ...first,
        types: [...first.types, ...entry.types.filter((t) => !first.types.includes(t))],
        share: Math.max(first.share, entry.share),
      };
    }
    for (const child of field.fields) visit(child, depth + 1);
    for (let items = field.items; items; items = items.items) {
      for (const child of items.fields) visit(child, depth + 1);
    }
  };
  for (const field of analysis.fields) visit(field, 0);
  return out;
}

/** A path the builder can query: no empty segments and no leading `$`. */
export function isQueryPath(path: string): boolean {
  return path !== '' && !path.startsWith('$') && path.split('.').every((part) => part !== '');
}

// ---------------------------------------------------------------------------------------------
// Values

/** How a condition's value is typed in; `shell` takes any mongosh literal. */
export const VALUE_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'objectId',
  'date',
  'bool',
  'uuid',
  'shell',
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export const VALUE_TYPE_LABELS: Readonly<Record<ValueType, string>> = {
  string: 'String',
  int: 'Int32',
  long: 'Int64',
  double: 'Double',
  decimal: 'Decimal128',
  objectId: 'ObjectId',
  date: 'Date',
  bool: 'Boolean',
  uuid: 'UUID',
  shell: 'mongosh',
};

/** The value type that edits values of a BSON type (unknown and null fields take strings). */
export function valueTypeFor(type: BsonTypeName | undefined): ValueType {
  switch (type) {
    case undefined:
    case 'null':
    case 'undefined':
    case 'string':
    case 'symbol':
      return 'string';
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
    case 'objectId':
    case 'date':
    case 'bool':
    case 'uuid':
      return type;
    default:
      return 'shell';
  }
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail<T>(message: string): Parsed<T> {
  return { ok: false, message };
}

const INTEGER = /^[+-]?\d+$/;
const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

/** Reads a value as typed into the value editor, as the BSON type the editor is set to. */
export function parseValue(text: string, type: ValueType): Parsed<BsonValue> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('Enter a value');
  switch (type) {
    case 'string':
      return ok(text);
    case 'int': {
      if (!INTEGER.test(trimmed)) return fail('Enter a whole number');
      const n = BigInt(trimmed);
      if (n < INT32_MIN || n > INT32_MAX) return fail('Out of the Int32 range: use Int64');
      return ok(new Int32(Number(n)));
    }
    case 'long': {
      if (!INTEGER.test(trimmed)) return fail('Enter a whole number');
      const n = BigInt(trimmed);
      if (n < INT64_MIN || n > INT64_MAX) return fail('Out of the Int64 range: use Decimal128');
      return ok(Long.fromBigInt(n));
    }
    case 'double': {
      const special = /^(?:NaN|[+-]?Infinity)$/.test(trimmed);
      if (!special && !DECIMAL_NUMBER.test(trimmed)) return fail('Enter a number');
      return ok(new Double(Number(trimmed)));
    }
    case 'decimal':
      try {
        return ok(Decimal128.fromString(trimmed));
      } catch {
        return fail('Enter a decimal number (at most 34 digits)');
      }
    case 'objectId':
      return /^[0-9a-fA-F]{24}$/.test(trimmed)
        ? ok(ObjectId.createFromHexString(trimmed.toLowerCase()))
        : fail('An ObjectId is 24 hexadecimal digits');
    case 'date': {
      const date = parseIsoDate(trimmed);
      return date ? ok(date) : fail('Enter an ISO date, e.g. 2026-01-31 or 2026-01-31T09:30:00Z');
    }
    case 'bool':
      return trimmed === 'true'
        ? ok(true)
        : trimmed === 'false'
          ? ok(false)
          : fail('Pick true or false');
    case 'uuid':
      return UUID.isValid(trimmed)
        ? ok(new UUID(trimmed))
        : fail('Enter a UUID, e.g. 0f8fad5b-d9cb-469f-a165-70867728950e');
    case 'shell':
      try {
        return ok(parseShell(text));
      } catch (error) {
        return fail(error instanceof ShellParseError ? error.reason : String(error));
      }
  }
}

function numberOf(value: BsonValue): number {
  return typeof value === 'number' ? value : (value as Int32 | Double).value;
}

/**
 * A value as the value editor shows it, with the type that reads it back to the same BSON value
 * (strings the one-line editor would change, like '' or text with line breaks, as mongosh).
 */
export function valueText(value: BsonValue): { readonly type: ValueType; readonly text: string } {
  const shell = { type: 'shell' as const, text: formatShellInline(value) };
  switch (bsonTypeOf(value)) {
    case 'string': {
      const text = value as string;
      return text.trim() === '' || /[\r\n]/.test(text) ? shell : { type: 'string', text };
    }
    case 'int':
      return { type: 'int', text: String(numberOf(value)) };
    case 'long':
      return { type: 'long', text: String(value) };
    case 'double': {
      const n = numberOf(value);
      return { type: 'double', text: Object.is(n, -0) ? '-0' : String(n) };
    }
    case 'decimal':
      return { type: 'decimal', text: String(value) };
    case 'objectId':
      return { type: 'objectId', text: (value as ObjectId).toHexString() };
    case 'date': {
      const date = value as Date;
      return Number.isNaN(date.getTime()) ? shell : { type: 'date', text: date.toISOString() };
    }
    case 'bool':
      return { type: 'bool', text: String(value) };
    case 'uuid':
      return { type: 'uuid', text: shell.text.slice("UUID('".length, -"')".length) };
    default:
      return shell;
  }
}

/** Reads a list editor's text: one value per line, blank lines skipped. */
export function parseList(text: string, type: ValueType): Parsed<BsonValue[]> {
  const values: BsonValue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const parsed = parseValue(line, type);
    if (!parsed.ok) return fail(`Line ${i + 1}: ${parsed.message}`);
    values.push(parsed.value);
  }
  return values.length > 0 ? ok(values) : fail('Enter at least one value, one per line');
}

/** A list as the list editor shows it: one type for all, or each value in mongosh syntax. */
export function listText(values: readonly BsonValue[]): {
  readonly type: ValueType;
  readonly text: string;
} {
  const shown = values.map(valueText);
  const type = shown[0]?.type ?? 'string';
  if (shown.every((s) => s.type === type)) {
    return { type, text: shown.map((s) => s.text).join('\n') };
  }
  return { type: 'shell', text: values.map((v) => formatShellInline(v)).join('\n') };
}

// ---------------------------------------------------------------------------------------------
// Conditions

export const OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$regex',
  '$all',
  '$size',
  '$exists',
  '$type',
  'null',
] as const;
/** A condition's operator; `null` is "is null" (`{ path: null }`: null or missing). */
export type ConditionOperator = (typeof OPERATORS)[number];

export const OPERATOR_LABELS: Readonly<Record<ConditionOperator, string>> = {
  $eq: 'equals ($eq)',
  $ne: 'not equal ($ne)',
  $gt: 'greater than ($gt)',
  $gte: 'at least ($gte)',
  $lt: 'less than ($lt)',
  $lte: 'at most ($lte)',
  $in: 'one of ($in)',
  $nin: 'none of ($nin)',
  $regex: 'matches ($regex)',
  $all: 'contains all ($all)',
  $size: 'array size ($size)',
  $exists: 'exists ($exists)',
  $type: 'has type ($type)',
  null: 'is null',
};

/** What the value editor of an operator edits. */
export type OperatorInput = 'value' | 'list' | 'regex' | 'exists' | 'type' | 'size' | 'none';

export function operatorInput(operator: ConditionOperator): OperatorInput {
  switch (operator) {
    case '$in':
    case '$nin':
    case '$all':
      return 'list';
    case '$regex':
      return 'regex';
    case '$exists':
      return 'exists';
    case '$type':
      return 'type';
    case '$size':
      return 'size';
    case 'null':
      return 'none';
    default:
      return 'value';
  }
}

const COMPARABLE: ReadonlySet<BsonTypeName> = new Set([
  'int',
  'long',
  'double',
  'decimal',
  'string',
  'date',
  'objectId',
  'timestamp',
]);

/** The operators offered for a field: by its type, with the array operators for arrays. */
export function operatorsFor(field: BuilderField | undefined): ConditionOperator[] {
  const base = baseType(field);
  const ops: ConditionOperator[] = ['$eq', '$ne'];
  if (base === undefined || COMPARABLE.has(base)) ops.push('$gt', '$gte', '$lt', '$lte');
  ops.push('$in', '$nin');
  if (base === undefined || base === 'string') ops.push('$regex');
  if (field?.type === 'array') ops.push('$all', '$size');
  ops.push('$exists', '$type', 'null');
  return ops;
}

/** The names `$type` takes: the server's type names and "number". */
export const TYPE_CHOICES: readonly string[] = [
  ...BSON_TYPE_NAMES.filter((name) => name !== 'uuid'),
  'number',
];

export interface Condition {
  readonly kind: 'condition';
  readonly id: string;
  readonly path: string;
  readonly operator: ConditionOperator;
  /** How `text` is read for value and list operators. */
  readonly valueType: ValueType;
  /** The value as typed: one per line for lists, the pattern for $regex, a type name for $type. */
  readonly text: string;
  /** Regular expression flags ($regex). */
  readonly flags: string;
}

/** Conditions of which any may match (`$or`). */
export interface OrGroup {
  readonly kind: 'or';
  readonly id: string;
  readonly conditions: readonly Condition[];
}

/** The filter's top level: conditions and OR groups, all of which must match. */
export type FilterItem = Condition | OrGroup;

export interface ProjectionEntry {
  readonly path: string;
  readonly include: boolean;
}

export interface SortEntry {
  readonly path: string;
  readonly direction: 1 | -1;
}

export interface BuilderQuery {
  readonly filter: readonly FilterItem[];
  readonly projection: readonly ProjectionEntry[];
  readonly sort: readonly SortEntry[];
  /** As typed; '' is none. */
  readonly skip: string;
  readonly limit: string;
}

export const EMPTY_BUILDER_QUERY: BuilderQuery = {
  filter: [],
  projection: [],
  sort: [],
  skip: '',
  limit: '',
};

function condition(
  path: string,
  operator: ConditionOperator,
  valueType: ValueType,
  text: string,
  flags = '',
): Condition {
  return { kind: 'condition', id: newId(), path, operator, valueType, text, flags };
}

function defaultText(
  operator: ConditionOperator,
  valueType: ValueType,
  base?: BsonTypeName,
): string {
  switch (operatorInput(operator)) {
    case 'exists':
      return 'true';
    case 'type':
      return base === undefined || base === 'null' ? 'string' : serverTypeName(base);
    case 'value':
      return valueType === 'bool' ? 'true' : '';
    default:
      return '';
  }
}

/** A new condition on a field: equality in the field's own type (existence for sub-documents). */
export function newCondition(path: string, field: BuilderField | undefined): Condition {
  const base = baseType(field);
  const operator: ConditionOperator =
    base === 'object' ? '$exists' : base === 'null' && field?.type !== 'array' ? 'null' : '$eq';
  const valueType = valueTypeFor(base);
  return condition(path, operator, valueType, defaultText(operator, valueType, base));
}

/** The condition with another operator, keeping what it can of the value. */
export function withOperator(
  current: Condition,
  operator: ConditionOperator,
  field: BuilderField | undefined,
): Condition {
  if (operator === current.operator) return current;
  const before = operatorInput(current.operator);
  const after = operatorInput(operator);
  const base = baseType(field);
  if (after === 'value' || after === 'list' || after === 'regex') {
    if (before === 'value' || before === 'regex' || before === 'list') {
      const text =
        before === 'list' && after !== 'list'
          ? (current.text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '')
          : current.text;
      return { ...current, operator, text };
    }
    // From an operator without a value: start empty, in the field's type when it is known.
    const valueType = field ? valueTypeFor(base) : current.valueType;
    const text = after === 'value' && valueType === 'bool' ? 'true' : '';
    return { ...current, operator, valueType, text };
  }
  return { ...current, operator, text: defaultText(operator, current.valueType, base) };
}

const REGEX_FLAGS = /^[imsux]*$/;

/** The operator and the typed value a condition puts in the filter. */
export function conditionValue(c: Condition): Parsed<{ op: string; value: BsonValue }> {
  if (!isQueryPath(c.path)) return fail('This field name cannot be queried from the builder');
  const as = (op: string, parsed: Parsed<BsonValue>): Parsed<{ op: string; value: BsonValue }> =>
    parsed.ok ? ok({ op, value: parsed.value }) : parsed;
  switch (operatorInput(c.operator)) {
    case 'none':
      return ok({ op: '$eq', value: null });
    case 'exists':
      return ok({ op: '$exists', value: c.text !== 'false' });
    case 'type':
      return TYPE_CHOICES.includes(c.text)
        ? ok({ op: '$type', value: c.text })
        : fail('Pick a BSON type');
    case 'size': {
      const n = c.text.trim();
      if (!/^\d+$/.test(n) || BigInt(n) > INT32_MAX) return fail('Enter a number of elements');
      return ok({ op: '$size', value: new Int32(Number(n)) });
    }
    case 'regex': {
      if (c.text === '') return fail('Enter a pattern');
      if (!REGEX_FLAGS.test(c.flags)) return fail('Flags can be i, m, s, u and x');
      const flags = [...new Set(c.flags)].sort().join('');
      return ok({ op: '$regex', value: new BSONRegExp(c.text, flags) });
    }
    case 'list':
      return as(c.operator, parseList(c.text, c.valueType));
    case 'value':
      return as(c.operator, parseValue(c.text, c.valueType));
  }
}

// ---------------------------------------------------------------------------------------------
// Projection, sort, skip and limit

/** MongoDB's rule: a projection includes fields or excludes them; only `_id` may differ. */
export function projectionIssue(entries: readonly ProjectionEntry[]): string | undefined {
  const others = entries.filter((e) => e.path !== '_id');
  if (others.some((e) => e.include) && others.some((e) => !e.include)) {
    return 'A projection either includes or excludes fields (only _id may differ): make them all Include or all Exclude';
  }
  return undefined;
}

/**
 * Adds a field to the projection the way the rule allows: excluded when the others are
 * excluded, else included; `_id` next to included fields is excluded (it comes by default).
 */
export function addProjection(
  entries: readonly ProjectionEntry[],
  path: string,
): ProjectionEntry[] {
  if (entries.some((e) => e.path === path)) return [...entries];
  const others = entries.filter((e) => e.path !== '_id');
  const include =
    path === '_id'
      ? !others.some((e) => e.include)
      : !(others.length > 0 && others.every((e) => !e.include));
  return [...entries, { path, include }];
}

export function addSort(entries: readonly SortEntry[], path: string): SortEntry[] {
  return entries.some((e) => e.path === path) ? [...entries] : [...entries, { path, direction: 1 }];
}

/** The list with one item moved from `from` to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** Skip or limit as typed: '' is none, else a whole number. */
export function countIssue(text: string, label: 'Skip' | 'Limit'): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return `${label} must be a whole number`;
  return Number.isSafeInteger(Number(trimmed)) ? undefined : `${label} is too large`;
}

// ---------------------------------------------------------------------------------------------
// Builder → query model

export interface BuilderIssues {
  /** By condition id. */
  readonly conditions: Readonly<Record<string, string>>;
  readonly projection?: string;
  readonly skip?: string;
  readonly limit?: string;
}

export const NO_ISSUES: BuilderIssues = { conditions: {} };

export type BuildResult =
  | { readonly ok: true; readonly model: QueryModel }
  | { readonly ok: false; readonly issues: BuilderIssues; readonly message: string };

/** Sets a key as an own property, so a field named "__proto__" stays a field. */
function put(doc: BsonDocument, key: string, value: BsonValue): void {
  Object.defineProperty(doc, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `{ path: value }` reads as equality only when the value is not a regex or operators. */
function plainEquality(value: BsonValue): boolean {
  if (value instanceof RegExp || bsonTag(value) === 'BSONRegExp') return false;
  return !isBsonDocument(value) || !Object.keys(value).some((key) => key.startsWith('$'));
}

function pathValue(ops: readonly (readonly [string, BsonValue])[]): BsonValue {
  const [first] = ops;
  if (ops.length === 1 && first![0] === '$eq' && plainEquality(first![1])) return first![1];
  const doc: BsonDocument = {};
  for (const [op, value] of ops) put(doc, op, value);
  return doc;
}

function single(path: string, op: string, value: BsonValue): BsonDocument {
  const doc: BsonDocument = {};
  put(doc, path, pathValue([[op, value]]));
  return doc;
}

/**
 * The filter document: conditions on one path merge into one operator document (a single
 * equality stays `{ path: value }`), a repeated operator on a path goes to `$and`, the first OR
 * group is `$or` and later ones are `$and: [{ $or }]`. Invalid conditions are left out and
 * reported in `issues`.
 */
function buildFilter(items: readonly FilterItem[], issues: Record<string, string>): BsonDocument {
  type Slot =
    | { readonly kind: 'path'; readonly path: string; readonly ops: [string, BsonValue][] }
    | { readonly kind: 'or'; readonly branches: BsonDocument[] };
  const slots: Slot[] = [];
  const byPath = new Map<string, Extract<Slot, { kind: 'path' }>>();
  const and: BsonDocument[] = [];
  let orPlaced = false;
  for (const item of items) {
    if (item.kind === 'or') {
      const branches: BsonDocument[] = [];
      for (const c of item.conditions) {
        const v = conditionValue(c);
        if (v.ok) branches.push(single(c.path, v.value.op, v.value.value));
        else issues[c.id] = v.message;
      }
      if (branches.length === 0) continue;
      if (orPlaced) and.push({ $or: branches });
      else slots.push({ kind: 'or', branches });
      orPlaced = true;
      continue;
    }
    const v = conditionValue(item);
    if (!v.ok) {
      issues[item.id] = v.message;
      continue;
    }
    const { op, value } = v.value;
    const slot = byPath.get(item.path);
    if (!slot) {
      const created: Extract<Slot, { kind: 'path' }> = {
        kind: 'path',
        path: item.path,
        ops: [[op, value]],
      };
      slots.push(created);
      byPath.set(item.path, created);
    } else if (slot.ops.some(([existing]) => existing === op)) {
      and.push(single(item.path, op, value));
    } else {
      slot.ops.push([op, value]);
    }
  }
  const filter: BsonDocument = {};
  for (const slot of slots) {
    if (slot.kind === 'path') put(filter, slot.path, pathValue(slot.ops));
    else put(filter, '$or', slot.branches);
  }
  if (and.length > 0) put(filter, '$and', and);
  return filter;
}

/**
 * The query model of the builder (without collation, hint and maxTimeMS, which the builder
 * does not edit), or every problem that keeps it from being one.
 */
export function buildQuery(query: BuilderQuery): BuildResult {
  const conditions: Record<string, string> = {};
  const filter = buildFilter(query.filter, conditions);
  const projectionProblem = projectionIssue(query.projection);
  const skipProblem = countIssue(query.skip, 'Skip');
  const limitProblem = countIssue(query.limit, 'Limit');
  const issues: BuilderIssues = {
    conditions,
    ...(projectionProblem !== undefined ? { projection: projectionProblem } : {}),
    ...(skipProblem !== undefined ? { skip: skipProblem } : {}),
    ...(limitProblem !== undefined ? { limit: limitProblem } : {}),
  };
  const message = firstIssue(query, issues);
  if (message !== undefined) return { ok: false, issues, message };
  const projection: BsonDocument = {};
  for (const e of query.projection) put(projection, e.path, new Int32(e.include ? 1 : 0));
  const sort: BsonDocument = {};
  for (const e of query.sort) put(sort, e.path, new Int32(e.direction));
  const skip = query.skip.trim() === '' ? 0 : Number(query.skip.trim());
  const limit = query.limit.trim() === '' ? 0 : Number(query.limit.trim());
  return {
    ok: true,
    model: {
      filter,
      ...(query.projection.length > 0 ? { projection } : {}),
      ...(query.sort.length > 0 ? { sort } : {}),
      ...(skip > 0 ? { skip } : {}),
      ...(limit > 0 ? { limit } : {}),
    },
  };
}

function allConditions(items: readonly FilterItem[]): Condition[] {
  return items.flatMap((item) => (item.kind === 'or' ? item.conditions : [item]));
}

/** The first problem, as one line naming where it is. */
function firstIssue(query: BuilderQuery, issues: BuilderIssues): string | undefined {
  for (const c of allConditions(query.filter)) {
    const issue = issues.conditions[c.id];
    if (issue !== undefined) return `Filter on ${c.path}: ${issue}`;
  }
  if (issues.projection !== undefined) return `Projection: ${issues.projection}`;
  return issues.skip ?? issues.limit;
}

// ---------------------------------------------------------------------------------------------
// Query model → builder

class Unrepresentable extends Error {}

function unrepresentable(message: string): never {
  throw new Unrepresentable(message);
}

function numeric(value: BsonValue): number | undefined {
  if (typeof value === 'number') return value;
  switch (bsonTag(value)) {
    case 'Int32':
    case 'Double':
      return (value as Int32 | Double).value;
    case 'Long':
      return (value as Long).toNumber();
    default:
      return undefined;
  }
}

function regexCondition(path: string, value: BsonValue): Condition {
  if (value instanceof RegExp)
    return condition(path, '$regex', 'string', value.source, value.flags);
  const re = value as BSONRegExp;
  return condition(path, '$regex', 'string', re.pattern, re.options);
}

function isRegex(value: BsonValue): boolean {
  return value instanceof RegExp || bsonTag(value) === 'BSONRegExp';
}

function readOperator(
  path: string,
  op: string,
  value: BsonValue,
  options: BsonValue | undefined,
): Condition {
  switch (op) {
    case '$eq':
    case '$ne':
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      if (op === '$eq' && value === null) return condition(path, 'null', 'string', '');
      const shown = valueText(value);
      return condition(path, op, shown.type, shown.text);
    }
    case '$in':
    case '$nin':
    case '$all': {
      if (!Array.isArray(value) || value.length === 0) {
        unrepresentable(`${op} on ${path} needs a non-empty list`);
      }
      const shown = listText(value);
      return condition(path, op, shown.type, shown.text);
    }
    case '$exists': {
      const n = numeric(value);
      const exists = typeof value === 'boolean' ? value : n !== undefined ? n !== 0 : undefined;
      if (exists === undefined) unrepresentable(`$exists on ${path} must be true or false`);
      return condition(path, '$exists', 'bool', String(exists));
    }
    case '$type': {
      const n = numeric(value);
      const name =
        typeof value === 'string'
          ? value
          : n !== undefined
            ? Object.values(BSON_TYPES).find((t) => t.number === n && t.name !== 'uuid')?.name
            : undefined;
      if (name === undefined || !TYPE_CHOICES.includes(name)) {
        unrepresentable(`$type on ${path} lists several types`);
      }
      return condition(path, '$type', 'string', name);
    }
    case '$size': {
      const n = numeric(value);
      if (n === undefined || !Number.isInteger(n) || n < 0) {
        unrepresentable(`$size on ${path} must be a whole number`);
      }
      return condition(path, '$size', 'int', String(n));
    }
    case '$regex': {
      if (typeof value === 'string') {
        if (options !== undefined && typeof options !== 'string') {
          unrepresentable(`$options on ${path} must be a string`);
        }
        return condition(path, '$regex', 'string', value, options ?? '');
      }
      if (!isRegex(value)) unrepresentable(`$regex on ${path} must be a pattern`);
      if (options !== undefined) unrepresentable(`$regex on ${path} has flags in two places`);
      return regexCondition(path, value);
    }
    default:
      return unrepresentable(`${op} is not in the builder`);
  }
}

/** The conditions `{ path: value }` stands for. */
function readPath(path: string, value: BsonValue): Condition[] {
  if (path.startsWith('$')) unrepresentable(`${path} is not in the builder`);
  if (isBsonDocument(value) && Object.keys(value).some((key) => key.startsWith('$'))) {
    const keys = Object.keys(value);
    if (!keys.every((key) => key.startsWith('$'))) {
      unrepresentable(`The condition on ${path} mixes operators and fields`);
    }
    const options = value['$options'];
    if (options !== undefined && value['$regex'] === undefined) {
      unrepresentable(`$options on ${path} comes without $regex`);
    }
    return keys
      .filter((key) => key !== '$options')
      .map((key) => readOperator(path, key, value[key]!, options));
  }
  if (isRegex(value)) return [regexCondition(path, value)];
  if (value === null) return [condition(path, 'null', 'string', '')];
  const shown = valueText(value);
  return [condition(path, '$eq', shown.type, shown.text)];
}

const ONE_LEVEL = 'The builder shows one level of OR, with one condition per $or branch';

function readOr(value: BsonValue): OrGroup {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isBsonDocument)) {
    unrepresentable('$or must be a non-empty list of documents');
  }
  const conditions = (value as BsonDocument[]).map((branch) => {
    const keys = Object.keys(branch);
    if (keys.length !== 1 || keys[0]!.startsWith('$')) unrepresentable(ONE_LEVEL);
    const read = readPath(keys[0]!, branch[keys[0]!]!);
    if (read.length !== 1) unrepresentable(ONE_LEVEL);
    return read[0]!;
  });
  return { kind: 'or', id: newId(), conditions };
}

function readFilter(filter: BsonDocument): FilterItem[] {
  const items: FilterItem[] = [];
  const readAnd = (doc: BsonDocument): void => {
    for (const [key, value] of Object.entries(doc)) {
      if (key === '$and') {
        if (!Array.isArray(value) || value.length === 0 || !value.every(isBsonDocument)) {
          unrepresentable('$and must be a non-empty list of documents');
        }
        (value as BsonDocument[]).forEach(readAnd);
      } else if (key === '$or') {
        items.push(readOr(value));
      } else if (key.startsWith('$')) {
        unrepresentable(`${key} is not in the builder`);
      } else {
        items.push(...readPath(key, value));
      }
    }
  };
  readAnd(filter);
  return items;
}

function readProjection(projection: BsonDocument | undefined): ProjectionEntry[] {
  return Object.entries(projection ?? {}).map(([path, value]) => {
    const n = numeric(value);
    const include = typeof value === 'boolean' ? value : n !== undefined ? n !== 0 : undefined;
    if (include === undefined || path.startsWith('$')) {
      unrepresentable(`The projection of ${path} is an expression`);
    }
    return { path, include };
  });
}

function readSort(sort: BsonDocument | undefined): SortEntry[] {
  return Object.entries(sort ?? {}).map(([path, value]) => {
    const n = numeric(value);
    if (n !== 1 && n !== -1) unrepresentable(`Sorting by ${formatShellInline(value)} on ${path}`);
    return { path, direction: n };
  });
}

export type ReadResult =
  | { readonly ok: true; readonly query: BuilderQuery }
  | { readonly ok: false; readonly reason: string };

/**
 * The builder state showing a query model, or why the builder cannot show it: operators it has
 * no editor for ($elemMatch, $not, $expr, $nor...), OR nested deeper than one level or with
 * several conditions per branch, projection expressions and sorts other than 1 and -1.
 * Collation, hint and maxTimeMS are not the builder's: the caller keeps them.
 */
export function readQuery(model: QueryModel): ReadResult {
  try {
    return {
      ok: true,
      query: {
        filter: readFilter(model.filter),
        projection: readProjection(model.projection),
        sort: readSort(model.sort),
        skip: model.skip !== undefined && model.skip > 0 ? String(model.skip) : '',
        limit: model.limit !== undefined && model.limit > 0 ? String(model.limit) : '',
      },
    };
  } catch (error) {
    if (error instanceof Unrepresentable) return { ok: false, reason: error.message };
    throw error;
  }
}
