import type { SqlDialect } from '@querybara/core';

/**
 * Identifier rules shared by the transfer planners: engine length limits, safe column names
 * for MongoDB field paths, unique names, and the column types a user may type in the wizard.
 */

/** Longest identifier in characters: PostgreSQL 63 (bytes, really), MySQL and MariaDB 64. */
export function maxIdentifier(dialect: SqlDialect): number {
  return dialect === 'postgres' ? 63 : 64;
}

/** Cuts a name to the dialect's limit, by code points so no character is split. */
export function fitIdentifier(name: string, dialect: SqlDialect): string {
  const limit = maxIdentifier(dialect);
  const chars = [...name];
  if (dialect !== 'postgres') return chars.slice(0, limit).join('');
  // PostgreSQL counts bytes.
  let out = '';
  let bytes = 0;
  for (const ch of chars) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * A column name for a MongoDB field path: dots and characters outside letters, digits and `_`
 * become `_` (`address.city` → `address_city`, `$weird key` → `_weird_key`).
 */
export function safeColumnName(path: string, dialect: SqlDialect): string {
  const name = path.replace(/\[\]/g, '').replace(/[^\p{L}\p{N}_]+/gu, '_');
  return fitIdentifier(/^_*$/.test(name) ? 'field' : name, dialect);
}

/** Hands out names unique within one table (or schema), case-insensitively. */
export class UniqueNames {
  readonly #taken = new Set<string>();

  constructor(
    private readonly dialect: SqlDialect,
    taken: Iterable<string> = [],
  ) {
    for (const name of taken) this.#taken.add(name.toLowerCase());
  }

  /** `name`, or `name_2`, `name_3`... cut to fit. */
  claim(name: string): string {
    const base = fitIdentifier(name, this.dialect);
    let candidate = base;
    for (let n = 2; this.#taken.has(candidate.toLowerCase()); n++) {
      const suffix = `_${n}`;
      let head = base;
      while (head !== '' && fitIdentifier(head + suffix, this.dialect) !== head + suffix) {
        head = [...head].slice(0, -1).join('');
      }
      candidate = head + suffix;
    }
    this.#taken.add(candidate.toLowerCase());
    return candidate;
  }

  has(name: string): boolean {
    return this.#taken.has(name.toLowerCase());
  }
}

/**
 * A column type as the wizard or the command line may give it: words, an optional `(n)` or
 * `(p,s)`, more words and array brackets (`varchar(255)`, `numeric(10,2)`, `timestamp(3) with
 * time zone`, `int unsigned`, `text[]`, `public.mood`), or a MySQL ENUM/SET with quoted
 * labels. Anything else never reaches the DDL.
 */
const DATA_TYPE =
  /^[A-Za-z_][\w$.]*(?:\s+[A-Za-z_][\w$.]*)*(?:\s*\(\s*\d+(?:\s*,\s*-?\d+)?\s*\))?(?:\s+[A-Za-z_][\w$.]*)*(?:\s*\[\s*\d*\s*\])*$/;
const LABELS = /^(?:enum|set)\s*\(\s*'(?:[^'\\]|\\.|'')*'(?:\s*,\s*'(?:[^'\\]|\\.|'')*')*\s*\)$/i;

export function isSafeDataType(text: string): boolean {
  const type = text.trim();
  return type.length > 0 && type.length <= 200 && (DATA_TYPE.test(type) || LABELS.test(type));
}
