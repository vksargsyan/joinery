import type { SqlDialect } from '@querybara/core';

/**
 * Column type canonicalisation and data-loss analysis. Each rule is listed where it is applied;
 * rules only make equal types that the server stores identically.
 */

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Lower-cases a type outside quoted parts (enum labels, quoted user type names). */
function lowerOutsideQuotes(text: string): string {
  return text.replace(
    /('(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`)|[^'"`]+/g,
    (part, quoted) => (quoted === undefined ? part.toLowerCase() : part),
  );
}

/** Removes whitespace inside parentheses outside quotes: "enum('a', 'b')" → "enum('a','b')". */
function tightenArgs(text: string): string {
  let out = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) out += text[++i]!;
      else if (ch === quote) {
        if (text[i + 1] === quote) out += text[++i]!;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth > 0 && /\s/.test(ch)) continue;
    if (ch === '(' && out.endsWith(' ')) out = out.trimEnd();
    out += ch;
  }
  return out;
}

const PG_ALIASES: Readonly<Record<string, string>> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  int2: 'smallint',
  smallint: 'smallint',
  int8: 'bigint',
  bigint: 'bigint',
  bool: 'boolean',
  boolean: 'boolean',
  float4: 'real',
  real: 'real',
  float8: 'double precision',
  float: 'double precision',
  'double precision': 'double precision',
  varchar: 'character varying',
  'character varying': 'character varying',
  char: 'character',
  character: 'character',
  bpchar: 'character',
  decimal: 'numeric',
  numeric: 'numeric',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  'timestamp with time zone': 'timestamp with time zone',
  'timestamp without time zone': 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  'time with time zone': 'time with time zone',
  'time without time zone': 'time without time zone',
  varbit: 'bit varying',
  'bit varying': 'bit varying',
};

/**
 * PostgreSQL types in format_type() form. Aliases fold to the canonical name (int4 → integer,
 * bool → boolean, varchar → character varying, timestamptz → timestamp with time zone, ...);
 * float(p) becomes real for p ≤ 24 and double precision otherwise; char without a length is
 * character(1); numeric(p) is numeric(p,0), as the server reports it; array dimensions collapse
 * to [] (PostgreSQL ignores them). Quoted user type names are kept as written.
 */
export function canonicalPgType(raw: string): string {
  let text = collapse(raw);
  let arraySuffix = '';
  for (;;) {
    const match = /\s*\[\d*\]$/.exec(text);
    if (!match) break;
    arraySuffix += '[]';
    text = text.slice(0, match.index);
  }
  if (text.includes('"')) return text + arraySuffix;
  const lower = text.toLowerCase();
  const match = /^(.*?)\s*(?:\(\s*([^)]*?)\s*\))?(?:\s+(with|without) time zone)?$/.exec(lower);
  if (!match) return lower + arraySuffix;
  const base = match[1]!;
  const args = match[2]?.replace(/\s+/g, '');
  const zone = match[3];

  if (base === 'float' && args !== undefined) {
    return (Number(args) <= 24 ? 'real' : 'double precision') + arraySuffix;
  }
  let canonical = PG_ALIASES[base] ?? base;
  if (zone !== undefined) {
    canonical = canonical.replace(/ with(out)? time zone$/, '') + ` ${zone} time zone`;
  }
  if (canonical === 'character' && args === undefined) return 'character(1)' + arraySuffix;
  if (canonical === 'numeric' && args !== undefined && /^\d+$/.test(args)) {
    return `numeric(${args},0)${arraySuffix}`;
  }
  if (args !== undefined && args !== '') {
    const zoneMatch = / (with|without) time zone$/.exec(canonical);
    if (zoneMatch) {
      canonical = `${canonical.slice(0, zoneMatch.index)}(${args})${zoneMatch[0]}`;
    } else {
      canonical = `${canonical}(${args})`;
    }
  }
  return canonical + arraySuffix;
}

const MYSQL_INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);

/** Display width the servers report for a ZEROFILL (so unsigned) integer declared without one. */
const MYSQL_ZEROFILL_WIDTHS: Readonly<Record<string, string>> = {
  tinyint: '3',
  smallint: '5',
  mediumint: '8',
  int: '10',
  bigint: '20',
};

/** Alias spellings the servers never report, folded to the type they create. */
const MYSQL_TYPE_ALIASES: Readonly<Record<string, string>> = {
  integer: 'int',
  dec: 'decimal',
  numeric: 'decimal',
  fixed: 'decimal',
  'double precision': 'double',
  real: 'double',
  'character varying': 'varchar',
  character: 'char',
  long: 'mediumtext',
  'long varchar': 'mediumtext',
  'long character varying': 'mediumtext',
  'long varbinary': 'mediumblob',
  // MySQL 8 reports GEOMETRYCOLLECTION as geomcollection, MariaDB (which lacks that spelling)
  // as geometrycollection: one name, valid on both, compares the two families alike.
  geomcollection: 'geometrycollection',
};

/**
 * MySQL/MariaDB COLUMN_TYPE text. Rules:
 * - keywords lower-case, enum/set labels untouched, no spaces inside the argument list;
 * - integer → int; bool/boolean → tinyint(1);
 * - integer display widths are dropped (MySQL 8.0.19+ no longer reports them, MariaDB still
 *   does): int(11) = int, bigint(20) unsigned = bigint unsigned. Kept for tinyint(1), which is
 *   the boolean convention and reported by both, and for zerofill columns, whose display
 *   depends on the width;
 * - ZEROFILL implies UNSIGNED, and a ZEROFILL integer without a width gets the one the servers
 *   report (int zerofill → int(10) unsigned zerofill);
 * - dec/numeric/fixed → decimal, decimal → decimal(10,0), decimal(p) → decimal(p,0);
 * - double precision/real → double; float(p) → float for p ≤ 24, double otherwise;
 * - character varying → varchar, character → char, char → char(1), binary → binary(1),
 *   bit → bit(1), year(4) → year; datetime(0)/timestamp(0)/time(0) drop the zero precision;
 * - long / long varchar → mediumtext, long varbinary → mediumblob, geomcollection →
 *   geometrycollection.
 */
export function canonicalMysqlType(raw: string): string {
  let text = tightenArgs(lowerOutsideQuotes(collapse(raw)));
  text = text.replace(/^national\s+/, '').replace(/^n(char|varchar)\b/, '$1');
  const match = /^([a-z ]+?)(\((.*)\))?((?: (?:unsigned|signed|zerofill))*)$/.exec(text);
  if (!match) return text;
  let base = match[1]!.trim();
  let args = match[3];
  const given = new Set(
    (match[4] ?? '')
      .trim()
      .split(' ')
      .filter((m) => m !== '' && m !== 'signed'),
  );
  const zerofill = given.has('zerofill');
  const modifiers = [
    ...(given.has('unsigned') || zerofill ? ['unsigned'] : []),
    ...(zerofill ? ['zerofill'] : []),
  ];

  if (base === 'bool' || base === 'boolean') return 'tinyint(1)';
  base = MYSQL_TYPE_ALIASES[base] ?? base;
  if (base === 'float' && args !== undefined && !args.includes(',')) {
    base = Number(args) <= 24 ? 'float' : 'double';
    args = undefined;
  }
  if (base === 'decimal') {
    if (args === undefined) args = '10,0';
    else if (!args.includes(',')) args = `${args},0`;
  }
  if ((base === 'char' || base === 'binary' || base === 'bit') && args === undefined) args = '1';
  if (base === 'year' && args === '4') args = undefined;
  if ((base === 'datetime' || base === 'timestamp' || base === 'time') && args === '0') {
    args = undefined;
  }
  if (MYSQL_INT_TYPES.has(base) && args !== undefined) {
    const keep = (base === 'tinyint' && args === '1') || zerofill;
    if (!keep) args = undefined;
  }
  if (MYSQL_INT_TYPES.has(base) && args === undefined && zerofill) {
    args = MYSQL_ZEROFILL_WIDTHS[base];
  }
  const typeText = args === undefined ? base : `${base}(${args})`;
  return [typeText, ...modifiers].join(' ');
}

export function canonicalType(raw: string, dialect: SqlDialect): string {
  return dialect === 'postgres' ? canonicalPgType(raw) : canonicalMysqlType(raw);
}

type TypeFamily =
  | 'int'
  | 'decimal'
  | 'float'
  | 'string'
  | 'binary'
  | 'temporal-date'
  | 'temporal-time'
  | 'temporal-timestamp'
  | 'bool'
  | 'json'
  | 'enum'
  | 'other';

interface TypeInfo {
  readonly family: TypeFamily;
  /** Integers: byte size. Floats: 4 or 8. */
  readonly size?: number;
  readonly unsigned?: boolean;
  /** Strings and binaries: maximum length (Infinity when unbounded). */
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  /** Fractional seconds precision. */
  readonly fsp?: number;
  readonly values?: readonly string[];
  readonly withZone?: boolean;
  readonly array: boolean;
}

const INT_SIZES: Readonly<Record<string, number>> = {
  tinyint: 1,
  smallint: 2,
  mediumint: 3,
  int: 4,
  integer: 4,
  bigint: 8,
};

const TEXT_LENGTHS: Readonly<Record<string, number>> = {
  tinytext: 255,
  text: 65535,
  mediumtext: 16777215,
  longtext: 4294967295,
  tinyblob: 255,
  blob: 65535,
  mediumblob: 16777215,
  longblob: 4294967295,
};

function parseEnumValues(args: string): string[] {
  return [...args.matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'"));
}

function typeInfo(canonical: string, dialect: SqlDialect): TypeInfo {
  const array = canonical.endsWith('[]');
  const text = array ? canonical.replace(/(\[\])+$/, '') : canonical;
  const match = /^([a-z ]+?)(?:\((.*)\))?((?: [a-z ]+)*)$/.exec(text);
  const base = (match?.[1] ?? text).trim();
  const args = match?.[2];
  const tail = match?.[3] ?? '';
  const nums = args?.split(',').map((a) => Number(a)) ?? [];
  const unsigned = tail.includes('unsigned');

  if (base in INT_SIZES) {
    if (base === 'tinyint' && args === '1' && dialect !== 'postgres') {
      return { family: 'bool', array };
    }
    return { family: 'int', size: INT_SIZES[base]!, unsigned, array };
  }
  if (base === 'numeric' || base === 'decimal') {
    return args === undefined
      ? { family: 'decimal', array }
      : { family: 'decimal', precision: nums[0], scale: nums[1] ?? 0, unsigned, array };
  }
  if (base === 'real' || base === 'float') return { family: 'float', size: 4, array };
  if (base === 'double precision' || base === 'double') return { family: 'float', size: 8, array };
  if (base === 'boolean' || base === 'bool') return { family: 'bool', array };
  if (
    base === 'character varying' ||
    base === 'varchar' ||
    base === 'character' ||
    base === 'char'
  ) {
    return { family: 'string', length: args === undefined ? Infinity : nums[0], array };
  }
  if ((base === 'text' && dialect === 'postgres') || base === 'citext') {
    return { family: 'string', length: Infinity, array };
  }
  if (base in TEXT_LENGTHS) {
    return {
      family: base.endsWith('blob') ? 'binary' : 'string',
      length: TEXT_LENGTHS[base],
      array,
    };
  }
  if (base === 'varbinary' || base === 'binary')
    return { family: 'binary', length: nums[0], array };
  if (base === 'bytea') return { family: 'binary', length: Infinity, array };
  if (base === 'date') return { family: 'temporal-date', array };
  if (base === 'time' || base.startsWith('time ')) {
    return { family: 'temporal-time', fsp: nums[0] ?? (dialect === 'postgres' ? 6 : 0), array };
  }
  if (base === 'timestamp' || base === 'datetime' || text.startsWith('timestamp')) {
    return {
      family: 'temporal-timestamp',
      fsp: nums[0] ?? (dialect === 'postgres' ? 6 : 0),
      withZone: text.includes('with time zone'),
      array,
    };
  }
  if (base === 'json' || base === 'jsonb') return { family: 'json', array };
  if (base === 'enum' || base === 'set') {
    return { family: 'enum', values: parseEnumValues(args ?? ''), array };
  }
  return { family: 'other', array };
}

const INT_DIGITS: Readonly<Record<number, number>> = { 1: 3, 2: 5, 3: 8, 4: 10, 8: 19 };

export interface TypeChangeRisk {
  readonly message: string;
  /** Values can be lost or truncated (the change is destructive), not just reinterpreted. */
  readonly lossy: boolean;
}

/**
 * Why changing a column from `from` to `to` can lose data or reinterpret values, or null when
 * the change is a widening (int → bigint, varchar(50) → varchar(100), varchar → text...). Both
 * types must already be canonical.
 */
export function typeChangeRisk(
  from: string,
  to: string,
  dialect: SqlDialect,
): TypeChangeRisk | null {
  const message = typeChangeMessage(from, to, dialect);
  if (message === null) return null;
  return { message, lossy: !message.includes('reinterprets') };
}

function typeChangeMessage(from: string, to: string, dialect: SqlDialect): string | null {
  if (from === to) return null;
  const a = typeInfo(from, dialect);
  const b = typeInfo(to, dialect);
  const lossy = `changing ${from} to ${to} can lose data or fail on existing values`;
  if (a.array !== b.array) return lossy;

  if (b.family === 'string' && b.length === Infinity && a.family !== 'binary') return null;

  if (a.family !== b.family) {
    if (a.family === 'int' && b.family === 'decimal') {
      if (b.precision === undefined) return null;
      const intDigits = (b.precision ?? 0) - (b.scale ?? 0);
      return intDigits >= INT_DIGITS[a.size ?? 8]! ? null : `${to} cannot hold every ${from} value`;
    }
    if (a.family === 'int' && b.family === 'float') {
      return (a.size ?? 8) <= (b.size === 8 ? 4 : 2)
        ? null
        : `${to} cannot represent every ${from} exactly`;
    }
    if (a.family === 'bool' && b.family === 'int') return null;
    if (a.family === 'temporal-date' && b.family === 'temporal-timestamp') return null;
    return lossy;
  }

  switch (a.family) {
    case 'int':
      if (a.unsigned && !b.unsigned && (b.size ?? 8) <= (a.size ?? 8)) {
        return `${to} cannot hold the upper range of ${from}`;
      }
      if (!a.unsigned && b.unsigned) return `${to} cannot hold negative values`;
      return (b.size ?? 8) < (a.size ?? 8) ? `${to} is narrower than ${from}` : null;
    case 'decimal': {
      if (b.precision === undefined) return null;
      if (a.precision === undefined) return `${to} limits precision that ${from} does not`;
      const aInt = a.precision - (a.scale ?? 0);
      const bInt = b.precision - (b.scale ?? 0);
      if (bInt < aInt) return `${to} holds fewer integer digits than ${from}`;
      if ((b.scale ?? 0) < (a.scale ?? 0)) return `${to} rounds away decimal places of ${from}`;
      if (a.unsigned === true && b.unsigned !== true) return null;
      if (a.unsigned !== true && b.unsigned === true) return `${to} cannot hold negative values`;
      return null;
    }
    case 'float':
      return (b.size ?? 8) < (a.size ?? 8) ? `${to} has less precision than ${from}` : null;
    case 'string':
    case 'binary':
      return (b.length ?? Infinity) < (a.length ?? Infinity)
        ? `${to} is shorter than ${from}`
        : null;
    case 'temporal-time':
    case 'temporal-timestamp':
      if (a.family === 'temporal-timestamp' && a.withZone !== b.withZone) {
        return `converting between ${from} and ${to} reinterprets values in the session time zone`;
      }
      return (b.fsp ?? 0) < (a.fsp ?? 0) ? `${to} rounds fractional seconds of ${from}` : null;
    case 'enum': {
      const removed = (a.values ?? []).filter((v) => !(b.values ?? []).includes(v));
      return removed.length > 0
        ? `rows holding ${removed.map((v) => `'${v}'`).join(', ')} lose their value`
        : null;
    }
    case 'bool':
    case 'json':
    case 'temporal-date':
      return null;
    default:
      return lossy;
  }
}

/** True for MySQL types that carry a character set and collation. */
export function isMysqlTextType(canonical: string): boolean {
  return /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/.test(canonical);
}

/** True for numeric types, whose quoted literal defaults ('0') equal bare ones (0). */
export function isNumericType(canonical: string, dialect: SqlDialect): boolean {
  const info = typeInfo(canonical, dialect);
  return (
    !info.array &&
    (info.family === 'int' ||
      info.family === 'decimal' ||
      info.family === 'float' ||
      info.family === 'bool')
  );
}
