/**
 * PostgreSQL array text form (`{1,2,NULL}`, `{{"a b",c},{d,e}}`): what the driver returns
 * for array columns and what PostgreSQL accepts as input.
 */

export type PgArray = (string | null | PgArray)[];

/** Parses an array literal, or returns an error message. */
export function parsePgArray(text: string): PgArray | string {
  let i = 0;
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const parseArray = (): PgArray | string => {
    if (text[i] !== '{') return 'Expected "{"';
    i++;
    const items: PgArray = [];
    skipSpace();
    if (text[i] === '}') {
      i++;
      return items;
    }
    for (;;) {
      skipSpace();
      const ch = text[i];
      if (ch === undefined) return 'Missing "}"';
      if (ch === '{') {
        const nested = parseArray();
        if (typeof nested === 'string') return nested;
        items.push(nested);
      } else if (ch === '"') {
        i++;
        let value = '';
        for (;;) {
          const c = text[i];
          if (c === undefined) return 'Unterminated quoted element';
          if (c === '\\') {
            const next = text[i + 1];
            if (next === undefined) return 'Unterminated quoted element';
            value += next;
            i += 2;
          } else if (c === '"') {
            i++;
            break;
          } else {
            value += c;
            i++;
          }
        }
        items.push(value);
      } else {
        let value = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '}') {
          const c = text[i]!;
          if (c === '{' || c === '"') return `Unexpected "${c}" in an unquoted element`;
          if (c === '\\' && i + 1 < text.length) {
            value += text[i + 1]!;
            i += 2;
            continue;
          }
          value += c;
          i++;
        }
        const trimmed = value.trim();
        if (trimmed === '') return 'Empty element: quote it as ""';
        items.push(trimmed.toUpperCase() === 'NULL' ? null : trimmed);
      }
      skipSpace();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return items;
      }
      return text[i] === undefined ? 'Missing "}"' : `Unexpected "${text[i]!}"`;
    }
  };
  skipSpace();
  const result = parseArray();
  if (typeof result === 'string') return result;
  skipSpace();
  if (i < text.length) return 'Unexpected text after the closing "}"';
  return result;
}

function quoteElement(value: string): string {
  if (value === '' || value.toUpperCase() === 'NULL' || /[{}",\\\s]/.test(value)) {
    return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
  }
  return value;
}

/** The canonical text form, quoting elements the way PostgreSQL prints them. */
export function formatPgArray(array: PgArray): string {
  return `{${array
    .map((item) =>
      item === null ? 'NULL' : Array.isArray(item) ? formatPgArray(item) : quoteElement(item),
    )
    .join(',')}}`;
}

/** A JSON array (`[1, "a", null]`) as a PgArray of element texts; other JSON is refused. */
export function pgArrayFromJson(value: unknown): PgArray | string {
  if (!Array.isArray(value)) return 'Expected an array';
  const out: PgArray = [];
  for (const item of value as unknown[]) {
    if (item === null) out.push(null);
    else if (Array.isArray(item)) {
      const nested = pgArrayFromJson(item);
      if (typeof nested === 'string') return nested;
      out.push(nested);
    } else if (typeof item === 'object') out.push(JSON.stringify(item));
    else out.push(String(item));
  }
  return out;
}
