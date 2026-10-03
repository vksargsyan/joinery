import type { CellValue, ColumnKind, LargeValueHandle } from '@querybara/core';

/**
 * How CellValues print. Text formats (table, CSV, TSV) use the server's text form for strings,
 * decimals and dates, exact digits for bigint, `true`/`false` for booleans and `\x`-prefixed
 * hex for binary (PostgreSQL's bytea output). JSON keeps numbers as numbers (bigint as exact
 * digits), binary as base64 and embeds JSON columns as JSON.
 */

export function isHandle(value: CellValue): value is LargeValueHandle {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** `\x`-prefixed lower-case hex, as PostgreSQL prints bytea. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '\\x';
  for (const byte of bytes) out += HEX[byte];
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** The text form of a non-null cell. */
export function cellText(value: Exclude<CellValue, null>): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
    case 'bigint':
      return String(value);
    default:
      return value instanceof Uint8Array ? bytesToHex(value) : value.preview;
  }
}

/** Column kinds printed right-aligned in tables. */
export function isNumericKind(kind: ColumnKind): boolean {
  return kind === 'integer' || kind === 'bigint' || kind === 'decimal' || kind === 'float';
}

/**
 * One cell as JSON text. Non-finite floats become strings ("NaN", "Infinity"): JSON has no
 * literal for them. A JSON column is embedded as JSON when its text parses.
 */
export function cellJson(value: CellValue, kind?: ColumnKind): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      if (kind === 'json' && isJsonText(value)) return value.trim();
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
    case 'bigint':
      return value.toString();
    default:
      if (value instanceof Uint8Array) return JSON.stringify(bytesToBase64(value));
      return JSON.stringify({
        $handle: value.$handle,
        preview: value.preview,
        byteLength: value.byteLength,
        kind: value.kind,
      });
  }
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Object keys for JSON rows: column names, with repeats made unique (`id`, `id_2`), so no value
 * is silently lost when a query returns two columns with one name.
 */
export function uniqueKeys(names: readonly string[]): string[] {
  const used = new Set<string>();
  const taken = new Set(names);
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    let n = 2;
    while (used.has(`${name}_${n}`) || taken.has(`${name}_${n}`)) n++;
    const key = `${name}_${n}`;
    used.add(key);
    return key;
  });
}
