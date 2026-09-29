import {
  bsonTypeOf,
  isBsonDocument,
  serverTypeName,
  toEjson,
  type BsonDocument,
  type BsonTypeName,
  type BsonValue,
} from './bson';
import { formatShellInline } from './shell/format';

/**
 * Schema analysis on a sample of documents (spec §9, "Schema and admin"): per field path the
 * type mix, how many documents have the field, the most common values and the nested
 * structure, plus export as a `$jsonSchema` validator. Memory stays bounded however large the
 * sample: paths, nesting depth, array elements looked at and tracked values are all capped.
 */

export interface SchemaAnalysisOptions {
  /** Most distinct field paths tracked; later new paths are ignored and `truncated` set. */
  readonly maxFields?: number;
  /** Deepest nesting analysed; deeper values count only as their type. */
  readonly maxDepth?: number;
  /** Array elements analysed per array. */
  readonly maxArrayItems?: number;
  /** Most common values reported per field. */
  readonly topValues?: number;
  /** Values whose Extended JSON is longer than this are not tracked as top values. */
  readonly maxValueLength?: number;
}

export interface SchemaTypeCount {
  readonly type: BsonTypeName;
  readonly count: number;
}

export interface SchemaValueCount {
  /** Canonical Extended JSON of the value. */
  readonly value: string;
  /** mongosh-style text for display. */
  readonly display: string;
  /** Occurrences counted for certain (exact while `topValuesExact`). */
  readonly count: number;
}

export interface SchemaField {
  /** Field name, or "[]" for array elements. */
  readonly name: string;
  /** Display path: "address.city", "tags[]", "items[].sku". */
  readonly path: string;
  /** Dot notation for queries and projections: "address.city", "tags", "items.sku". */
  readonly queryPath: string;
  /** Values seen at this path (every array element counts). */
  readonly count: number;
  /** Documents of the sample that have the path. */
  readonly documents: number;
  /** documents / documentCount: the share of documents with the field. */
  readonly share: number;
  /** count / times the parent was a document: how often the field is there when it could be. */
  readonly presence: number;
  /** Type mix, most frequent first. */
  readonly types: readonly SchemaTypeCount[];
  readonly topValues: readonly SchemaValueCount[];
  /** Top value counts are exact (fewer distinct values than tracked). */
  readonly topValuesExact: boolean;
  /** Distinct scalar values seen, when exact. */
  readonly distinctValues?: number;
  /** Fields of sub-documents at this path, in first-seen order. */
  readonly fields: readonly SchemaField[];
  /** Array elements at this path. */
  readonly items?: SchemaField;
  readonly arrayLengths?: { readonly min: number; readonly max: number; readonly average: number };
  /** Times the value was a document (the parent count for `fields`). */
  readonly documentValues: number;
}

export interface SchemaAnalysis {
  readonly documentCount: number;
  readonly fields: readonly SchemaField[];
  /** The field limit was reached: some paths are missing. */
  readonly truncated: boolean;
}

/** Space-saving top-k counter: bounded memory, exact while the distinct values fit. */
class TopValues {
  private readonly entries = new Map<string, { value: BsonValue; count: number; error: number }>();
  overflowed = false;

  constructor(private readonly capacity: number) {}

  add(key: string, value: BsonValue): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (this.entries.size < this.capacity) {
      this.entries.set(key, { value, count: 1, error: 0 });
      return;
    }
    this.overflowed = true;
    let minKey: string | undefined;
    let min = Infinity;
    for (const [k, e] of this.entries) {
      if (e.count < min) {
        min = e.count;
        minKey = k;
      }
    }
    this.entries.delete(minKey!);
    this.entries.set(key, { value, count: min + 1, error: min });
  }

  get size(): number {
    return this.entries.size;
  }

  top(n: number): SchemaValueCount[] {
    return [...this.entries.entries()]
      .map(([key, e]) => ({ key, value: e.value, count: e.count - e.error }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, n)
      .map((e) => ({
        value: e.key,
        display: formatShellInline(e.value, { maxStringLength: 120 }),
        count: e.count,
      }));
  }
}

class FieldNode {
  count = 0;
  documents = 0;
  lastDocument = -1;
  documentValues = 0;
  arrays = 0;
  minLength = Infinity;
  maxLength = 0;
  totalLength = 0;
  readonly types = new Map<BsonTypeName, number>();
  values: TopValues | undefined;
  children: Map<string, FieldNode> | undefined;
  items: FieldNode | undefined;

  constructor(
    readonly name: string,
    readonly path: string,
    readonly queryPath: string,
  ) {}
}

const TRACKED_TYPES = new Set<BsonTypeName>([
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'uuid',
  'null',
  'timestamp',
  'symbol',
]);

/** Accumulates documents one at a time; `result()` can be called at any point. */
export class SchemaAnalyzer {
  private readonly root = new FieldNode('', '', '');
  private documentCount = 0;
  private fieldCount = 0;
  private truncated = false;
  private readonly maxFields: number;
  private readonly maxDepth: number;
  private readonly maxArrayItems: number;
  private readonly topValues: number;
  private readonly maxValueLength: number;

  constructor(options: SchemaAnalysisOptions = {}) {
    this.maxFields = options.maxFields ?? 1000;
    this.maxDepth = options.maxDepth ?? 20;
    this.maxArrayItems = options.maxArrayItems ?? 100;
    this.topValues = options.topValues ?? 10;
    this.maxValueLength = options.maxValueLength ?? 200;
  }

  add(document: BsonDocument): void {
    const index = this.documentCount;
    this.documentCount += 1;
    this.root.documentValues += 1;
    this.addFields(this.root, document, index, 0);
  }

  private addFields(parent: FieldNode, doc: BsonDocument, index: number, depth: number): void {
    for (const key of Object.keys(doc)) {
      parent.children ??= new Map();
      let child = parent.children.get(key);
      if (!child) {
        if (this.fieldCount >= this.maxFields) {
          this.truncated = true;
          continue;
        }
        this.fieldCount += 1;
        const path = parent.path === '' ? key : `${parent.path}.${key}`;
        const queryPath = parent.queryPath === '' ? key : `${parent.queryPath}.${key}`;
        child = new FieldNode(key, path, queryPath);
        parent.children.set(key, child);
      }
      this.addValue(child, doc[key]!, index, depth + 1);
    }
  }

  private addValue(node: FieldNode, value: BsonValue, index: number, depth: number): void {
    node.count += 1;
    if (node.lastDocument !== index) {
      node.lastDocument = index;
      node.documents += 1;
    }
    const type = bsonTypeOf(value);
    node.types.set(type, (node.types.get(type) ?? 0) + 1);
    if (Array.isArray(value)) {
      node.arrays += 1;
      node.minLength = Math.min(node.minLength, value.length);
      node.maxLength = Math.max(node.maxLength, value.length);
      node.totalLength += value.length;
      if (depth >= this.maxDepth || value.length === 0) return;
      node.items ??= new FieldNode('[]', `${node.path}[]`, node.queryPath);
      const n = Math.min(value.length, this.maxArrayItems);
      for (let i = 0; i < n; i++) this.addValue(node.items, value[i]!, index, depth + 1);
      return;
    }
    if (isBsonDocument(value)) {
      node.documentValues += 1;
      if (depth < this.maxDepth) this.addFields(node, value, index, depth);
      return;
    }
    if (!TRACKED_TYPES.has(type)) return;
    const key = toEjson(value);
    if (key.length > this.maxValueLength) return;
    node.values ??= new TopValues(Math.max(this.topValues * 5, 20));
    node.values.add(key, value);
  }

  result(): SchemaAnalysis {
    const total = this.documentCount;
    const build = (node: FieldNode, parentDocuments: number): SchemaField => {
      const fields = [...(node.children?.values() ?? [])].map((child) =>
        build(child, node.documentValues),
      );
      const values = node.values;
      return {
        name: node.name,
        path: node.path,
        queryPath: node.queryPath,
        count: node.count,
        documents: node.documents,
        share: total === 0 ? 0 : node.documents / total,
        presence: parentDocuments === 0 ? 0 : Math.min(1, node.count / parentDocuments),
        types: [...node.types.entries()]
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),
        topValues: values ? values.top(this.topValues) : [],
        topValuesExact: values ? !values.overflowed : true,
        ...(values && !values.overflowed ? { distinctValues: values.size } : {}),
        fields,
        ...(node.items ? { items: build(node.items, node.count) } : {}),
        ...(node.arrays > 0
          ? {
              arrayLengths: {
                min: node.minLength,
                max: node.maxLength,
                average: node.totalLength / node.arrays,
              },
            }
          : {}),
        documentValues: node.documentValues,
      };
    };
    const fields = [...(this.root.children?.values() ?? [])].map((child) => build(child, total));
    return { documentCount: total, fields, truncated: this.truncated };
  }
}

/** Analyses a sample of documents (see SchemaAnalyzer). */
export function analyzeSchema(
  documents: Iterable<BsonDocument>,
  options?: SchemaAnalysisOptions,
): SchemaAnalysis {
  const analyzer = new SchemaAnalyzer(options);
  for (const doc of documents) analyzer.add(doc);
  return analyzer.result();
}

export interface JsonSchemaOptions {
  /**
   * `mongodb` (default): a `$jsonSchema` validator using `bsonType`, ready for collMod.
   * `json-schema`: standard JSON Schema (draft 2020-12) for documents as relaxed Extended JSON.
   */
  readonly dialect?: 'mongodb' | 'json-schema';
  /** A field is required when it is present in at least this share of its parents; default 1. */
  readonly requiredThreshold?: number;
  /** Set `additionalProperties` on every object schema; left out (allowed) by default. */
  readonly additionalProperties?: boolean;
}

type SchemaNode = Record<string, unknown>;

function jsonSchemaForType(type: BsonTypeName): SchemaNode | undefined {
  switch (type) {
    case 'double':
    case 'decimal':
      return { type: 'number' };
    case 'int':
    case 'long':
      return { type: 'integer' };
    case 'string':
    case 'symbol':
      return { type: 'string' };
    case 'bool':
      return { type: 'boolean' };
    case 'null':
    case 'undefined':
      return { type: 'null' };
    case 'object':
      return { type: 'object' };
    case 'array':
      return { type: 'array' };
    case 'date':
      return { type: 'string', format: 'date-time' };
    case 'objectId':
      return { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    default:
      // Binary, regex, timestamps and the rest have no JSON Schema type: accept anything.
      return undefined;
  }
}

/**
 * A JSON Schema for the analysed documents: `required` lists the fields present in every
 * parent (or `requiredThreshold` of them), `properties` and `items` follow the nested structure
 * and each field allows the types seen. The result is a plain object: pass it through
 * `toEjson` for collMod, or JSON.stringify for the `json-schema` dialect.
 */
export function toJsonSchema(
  analysis: SchemaAnalysis,
  options: JsonSchemaOptions = {},
): SchemaNode {
  const dialect = options.dialect ?? 'mongodb';
  const threshold = options.requiredThreshold ?? 1;

  const objectSchema = (fields: readonly SchemaField[], parentCount: number): SchemaNode => {
    const properties: SchemaNode = {};
    const required: string[] = [];
    for (const field of fields) {
      Object.defineProperty(properties, field.name, {
        value: fieldSchema(field),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (parentCount > 0 && field.count >= threshold * parentCount) required.push(field.name);
    }
    const schema: SchemaNode = dialect === 'mongodb' ? { bsonType: 'object' } : { type: 'object' };
    if (required.length > 0) schema['required'] = required;
    if (fields.length > 0) schema['properties'] = properties;
    if (options.additionalProperties !== undefined) {
      schema['additionalProperties'] = options.additionalProperties;
    }
    return schema;
  };

  const fieldSchema = (field: SchemaField): SchemaNode => {
    const types = field.types.map((t) => t.type);
    const hasObject = types.includes('object') && field.fields.length > 0;
    const hasItems = types.includes('array') && field.items !== undefined;
    if (dialect === 'mongodb') {
      const bsonTypes = [...new Set(types.map(serverTypeName))];
      const schema: SchemaNode = {
        bsonType: bsonTypes.length === 1 ? bsonTypes[0] : bsonTypes,
      };
      if (hasObject) {
        const nested = objectSchema(field.fields, field.documentValues);
        if (nested['required']) schema['required'] = nested['required'];
        if (nested['properties']) schema['properties'] = nested['properties'];
        if (nested['additionalProperties'] !== undefined) {
          schema['additionalProperties'] = nested['additionalProperties'];
        }
      }
      if (hasItems) schema['items'] = fieldSchema(field.items!);
      return schema;
    }
    const variants: SchemaNode[] = [];
    for (const type of types) {
      const variant = jsonSchemaForType(type);
      if (variant === undefined) return {};
      if (type === 'object' && hasObject) {
        variants.push(objectSchema(field.fields, field.documentValues));
      } else if (type === 'array' && hasItems) {
        variants.push({ type: 'array', items: fieldSchema(field.items!) });
      } else {
        variants.push(variant);
      }
    }
    const unique = variants.filter(
      (v, i) => variants.findIndex((w) => JSON.stringify(w) === JSON.stringify(v)) === i,
    );
    if (unique.length === 1) return unique[0]!;
    if (unique.every((v) => Object.keys(v).length === 1)) {
      return { type: [...new Set(unique.map((v) => v['type'] as string))] };
    }
    return { anyOf: unique };
  };

  const root = objectSchema(analysis.fields, analysis.documentCount);
  if (dialect === 'json-schema') {
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...root };
  }
  return root;
}
