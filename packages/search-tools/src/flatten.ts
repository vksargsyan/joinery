import { compactJson, parseJsonTree, type JsonNode } from './json';

/**
 * Flattened fields for the document grid (spec §11): a document's `_source` becomes one cell per
 * leaf, named by its dotted path ("customer.address.city"). Values stay exact: a number's cell
 * is its text as the server wrote it, so a 64-bit id or `1.10` shows unchanged. Arrays are one
 * cell (their compact JSON), as Elasticsearch treats them as multi-valued fields.
 */

export type FlatKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/** One leaf of a flattened document. */
export interface FlatField {
  /** The dotted path, e.g. "customer.address.city". */
  readonly path: string;
  readonly kind: FlatKind;
  /** What the grid shows: a string's value, a number as written, containers as compact JSON. */
  readonly text: string;
}

export interface FlattenOptions {
  /** Object levels flattened into dotted paths; deeper objects are one JSON cell. Default 8. */
  readonly maxDepth?: number;
}

function leafText(text: string, node: JsonNode): string {
  switch (node.type) {
    case 'string':
      return node.value;
    case 'number':
      return node.text;
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
      return 'null';
    default:
      return compactJson(text.slice(node.start, node.end));
  }
}

/**
 * Flattens a document's JSON text into its leaves, in document order. An empty object is a
 * leaf (`{}`); text that is not a JSON object flattens to one field with an empty path.
 */
export function flattenSource(source: string, options: FlattenOptions = {}): FlatField[] {
  const maxDepth = options.maxDepth ?? 8;
  const root = parseJsonTree(source);
  const out: FlatField[] = [];
  const walk = (node: JsonNode, path: string, depth: number): void => {
    if (node.type === 'object' && node.members.length > 0 && depth < maxDepth) {
      for (const m of node.members)
        walk(m.value, path === '' ? m.key : `${path}.${m.key}`, depth + 1);
      return;
    }
    out.push({ path, kind: node.type, text: leafText(source, node) });
  };
  walk(root, '', 0);
  return out;
}

/** The flattened fields of a document by path (the last duplicate wins). */
export function flatRecord(source: string, options?: FlattenOptions): Map<string, FlatField> {
  const record = new Map<string, FlatField>();
  for (const field of flattenSource(source, options)) record.set(field.path, field);
  return record;
}

/** The grid's columns: the given field paths first, then every other path in order of appearance. */
export function documentColumns(
  records: Iterable<ReadonlyMap<string, FlatField>>,
  options: { readonly first?: readonly string[]; readonly limit?: number } = {},
): { readonly columns: string[]; readonly truncated: boolean } {
  const limit = options.limit ?? 500;
  const seen = new Set<string>(options.first ?? []);
  for (const record of records) {
    for (const path of record.keys()) seen.add(path);
  }
  const all = [...seen];
  return { columns: all.slice(0, limit), truncated: all.length > limit };
}

/**
 * The JSON of a value the user typed: JSON as written (`42`, `true`, `"x"`, `[1, 2]`), anything
 * else as a string.
 */
export function valueJsonOf(text: string): string {
  try {
    return compactJson(text);
  } catch {
    return JSON.stringify(text);
  }
}

/**
 * A partial document that sets one dotted path (for `_update`): "a.b" and `1` give
 * `{"a":{"b":1}}`, so the field lands where the mapping's object fields are.
 */
export function partialDocument(path: string, valueJson: string): string {
  const parts = path.split('.').filter((p) => p !== '');
  if (parts.length === 0) throw new Error('Name the field to set');
  return parts.reduceRight((inner, key) => `{${JSON.stringify(key)}:${inner}}`, valueJson);
}
