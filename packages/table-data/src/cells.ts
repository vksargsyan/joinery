import type { CellValue } from '@querybara/core';

import type { ColumnInfo } from './columns';
import { formatPgArray, parsePgArray, pgArrayFromJson, type PgArray } from './pg-array';
import { isDefault, isLargeValue, toHex, type EditValue } from './values';

/**
 * Typed cell editors (spec §7): text in, a CellValue out in the representation the drivers
 * return (so an unchanged value compares equal to what was loaded), or a specific error.
 *
 * - Integers: number up to 2^53, bigint beyond, checked against the type's bounds (unsigned
 *   too). MySQL tinyint(1) and bit(1) also take true/false and are numbers 1/0.
 * - Decimals: the digits as text, padded to the column scale; more fraction digits than the
 *   scale is an error rather than silent rounding.
 * - Floats: numbers; NaN and ±Infinity on PostgreSQL only.
 * - Dates and times: validated and normalised to the server's text form (2026-09-29,
 *   14:30:00, 2026-09-29 14:30:00), including the MySQL range limits.
 * - JSON is validated and kept as typed; UUIDs are normalised to lower-case with hyphens;
 *   binary is hex (0x…, \x… or bare); enum and set labels come from the column type;
 *   PostgreSQL arrays take their text form or a JSON array and come out in canonical text.
 *
 * Empty input is '' for text columns and NULL for the others; `nullText` makes some text mean
 * NULL (for paste), `emptyIsNull` makes empty text columns NULL too.
 */

export type CellParseResult =
  { readonly ok: true; readonly value: CellValue } | { readonly ok: false; readonly error: string };

export interface ParseOptions {
  /** Text that means NULL, e.g. "NULL" when pasting from a tool that writes it. */
  readonly nullText?: string;
  /** Empty input is NULL for text columns too, instead of ''. */
  readonly emptyIsNull?: boolean;
}

const ok = (value: CellValue): CellParseResult => ({ ok: true, value });
const err = (error: string): CellParseResult => ({ ok: false, error });

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const FLOAT4_MAX = 3.4028234663852886e38;

function baseType(column: ColumnInfo): string {
  return column.dataType
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRUE_WORDS = new Set(['t', 'true', 'y', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['f', 'false', 'n', 'no', 'off', '0']);

function booleanWord(text: string): boolean | undefined {
  const word = text.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

const INTEGER_BITS: Readonly<Record<string, number>> = {
  smallint: 16,
  int2: 16,
  smallserial: 16,
  integer: 32,
  int: 32,
  int4: 32,
  serial: 32,
  bigint: 64,
  int8: 64,
  bigserial: 64,
  tinyint: 8,
  mediumint: 24,
  boolean: 8,
  bool: 8,
};

/** Inclusive bounds of an integer column. */
export function integerBounds(column: ColumnInfo): readonly [bigint, bigint] {
  const base = baseType(column);
  if (base === 'oid') return [0n, 2n ** 32n - 1n];
  if (base === 'bit') return [0n, 2n ** BigInt(column.length ?? 1) - 1n];
  if (base === 'year') return [0n, 2155n];
  const bits = BigInt(INTEGER_BITS[base] ?? 64);
  if (column.unsigned) return [0n, 2n ** bits - 1n];
  return [-(2n ** (bits - 1n)), 2n ** (bits - 1n) - 1n];
}

function parseInteger(text: string, column: ColumnInfo): CellParseResult {
  if (column.booleanLike) {
    const word = booleanWord(text);
    if (word !== undefined) return ok(word ? 1 : 0);
  }
  if (!/^[+-]?\d+$/.test(text)) {
    return err(
      column.booleanLike ? 'Expected true, false or a whole number' : 'Expected a whole number',
    );
  }
  const n = BigInt(text);
  const [min, max] = integerBounds(column);
  if (n < min || n > max) return err(`Must be between ${min} and ${max}`);
  if (baseType(column) === 'year' && n !== 0n && n < 1901n)
    return err('Must be 0 or a year from 1901 to 2155');
  return ok(n >= MIN_SAFE && n <= MAX_SAFE ? Number(n) : n);
}

function parseDecimal(text: string, column: ColumnInfo): CellParseResult {
  const pg = column.dialect === 'postgres';
  if (baseType(column) === 'money') return ok(text);
  const special = /^([+-]?)(nan|infinity|inf)$/i.exec(text);
  if (special) {
    if (!pg) return err('MySQL and MariaDB decimals cannot be NaN or infinite');
    if (special[2]!.toLowerCase() === 'nan') return ok('NaN');
    return ok(special[1] === '-' ? '-Infinity' : 'Infinity');
  }
  const match = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    return err('Expected a number like 1234.56');
  }
  const negative = match[1] === '-';
  const exponent = Number(match[4] ?? '0');
  if (Math.abs(exponent) > 1000) return err('The number is out of range');
  let digits = `${match[2]}${match[3] ?? ''}`;
  let point = match[2]!.length + exponent;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  let integer = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  if (integer === '') integer = '0';
  let fraction = digits.slice(point);
  const scale = column.scale;
  if (scale !== undefined) {
    if (fraction.length > scale) {
      if (/[1-9]/.test(fraction.slice(scale))) {
        return err(
          scale === 0
            ? 'Expected a whole number'
            : `At most ${scale} digit${scale === 1 ? '' : 's'} after the decimal point`,
        );
      }
      fraction = fraction.slice(0, scale);
    }
    fraction = fraction.padEnd(scale, '0');
  }
  if (column.precision !== undefined) {
    const allowed = column.precision - (scale ?? 0);
    const used = integer === '0' ? 0 : integer.length;
    if (used > allowed) {
      return err(`At most ${allowed} digit${allowed === 1 ? '' : 's'} before the decimal point`);
    }
  }
  const zero = /^0*$/.test(integer + fraction);
  if (negative && !zero && column.unsigned) return err('Must not be negative');
  const body = fraction === '' ? integer : `${integer}.${fraction}`;
  return ok(negative && !zero ? `-${body}` : body);
}

function parseFloatValue(text: string, column: ColumnInfo): CellParseResult {
  const pg = column.dialect === 'postgres';
  const special = /^([+-]?)(nan|infinity|inf)$/i.exec(text);
  if (special) {
    if (!pg) return err('MySQL and MariaDB cannot store NaN or infinity');
    if (special[2]!.toLowerCase() === 'nan') return ok(Number.NaN);
    return ok(special[1] === '-' ? -Infinity : Infinity);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text))
    return err('Expected a number like 3.14');
  const value = Number(text);
  const single = ['real', 'float4', 'float'].includes(baseType(column));
  if (!Number.isFinite(value) || (single && Math.abs(value) > FLOAT4_MAX)) {
    return err('The number is out of range');
  }
  if (value < 0 && column.unsigned) return err('Must not be negative');
  return ok(value);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** "2026-9-29" → "2026-09-29", or an error for impossible dates and out-of-range years. */
function normaliseDate(text: string, column: ColumnInfo, bc: boolean): string | { error: string } {
  const match = /^(\d{4,7})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) return { error: '' };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = month === 2 && isLeapYear(bc ? 1 - year : year) ? 29 : DAYS[month - 1];
  const iso = `${match[1]!.padStart(4, '0')}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  if (days === undefined || day < 1 || day > days) return { error: `${iso} is not a valid date` };
  if (column.dialect === 'postgres') {
    if (year < 1 || year > 5874897) return { error: 'The year is out of range' };
  } else {
    if (bc) return { error: 'MySQL and MariaDB have no BC dates' };
    if (column.kind === 'timestamp') {
      if (iso < '1970-01-01' || iso > '2038-01-19')
        return { error: 'A TIMESTAMP must be between 1970-01-01 and 2038-01-19' };
    } else if (year < 1000 || year > 9999) {
      return { error: 'The year must be between 1000 and 9999' };
    }
  }
  return iso;
}

interface TimeParts {
  readonly text: string;
  readonly hours: number;
}

/** "9:5" → "09:05:00"; validates ranges (MySQL TIME may be negative and up to 838 hours). */
function normaliseTime(text: string, allowWide: boolean): TimeParts | undefined {
  const match = /^(-)?(\d{1,3}):(\d{1,2})(?::(\d{1,2})(\.\d{1,6})?)?$/.exec(text);
  if (!match) return undefined;
  const negative = match[1] === '-';
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4] ?? '0');
  const fraction = match[5] ?? '';
  if (negative && !allowWide) return undefined;
  if (minutes > 59 || seconds > 60 || (seconds === 60 && allowWide)) return undefined;
  if (allowWide) {
    if (hours > 838 || (hours === 838 && (minutes > 59 || seconds > 59 || fraction !== '')))
      return undefined;
  } else if (
    hours > 24 ||
    (hours === 24 && (minutes > 0 || seconds > 0 || /[1-9]/.test(fraction)))
  ) {
    return undefined;
  }
  const hh = String(hours).padStart(2, '0');
  const body = `${hh}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${fraction}`;
  return { text: negative ? `-${body}` : body, hours };
}

const ZONE = /^(?:z|utc|[+-]\d{1,2}(?::?\d{2})?)$/i;

function parseTime(text: string, column: ColumnInfo): CellParseResult {
  const pg = column.dialect === 'postgres';
  const example = column.withTimeZone
    ? 'Expected a time like 14:30:00+02'
    : 'Expected a time like 14:30:00';
  let body = text;
  let zone = '';
  if (column.withTimeZone) {
    const zoned = /^(.*?)\s*(z|utc|[+-]\d{1,2}(?::?\d{2})?)$/i.exec(text);
    if (zoned && /:/.test(zoned[1]!)) {
      body = zoned[1]!;
      zone =
        zoned[2]!.toUpperCase() === 'UTC'
          ? '+00'
          : zoned[2]!.toUpperCase() === 'Z'
            ? '+00'
            : zoned[2]!;
    }
  }
  const time = normaliseTime(body, !pg);
  if (!time) return err(example);
  return ok(time.text + zone);
}

function parseDateValue(text: string, column: ColumnInfo): CellParseResult {
  const example = 'Expected a date like 2026-09-29';
  if (column.dialect === 'postgres' && /^[+-]?infinity$/i.test(text)) return ok(text.toLowerCase());
  const bcMatch = /^(.*?)\s+bc$/i.exec(text);
  const bc = bcMatch !== null && column.dialect === 'postgres';
  const date = normaliseDate(bcMatch ? bcMatch[1]! : text, column, bcMatch !== null);
  if (typeof date !== 'string') return err(date.error || example);
  return ok(bc ? `${date} BC` : date);
}

function parseDateTime(text: string, column: ColumnInfo): CellParseResult {
  const pg = column.dialect === 'postgres';
  const zoned = pg && column.kind === 'timestamp';
  const example = zoned
    ? 'Expected a date and time like 2026-09-29 14:30:00+02'
    : 'Expected a date and time like 2026-09-29 14:30:00';
  if (pg && /^[+-]?infinity$/i.test(text)) return ok(text.toLowerCase());
  const match = /^(\d{4,7}-\d{1,2}-\d{1,2})(?:(?:t|\s+)(.*))?$/i.exec(text);
  if (!match) return err(example);
  let rest = (match[2] ?? '').trim();
  const bc = /\s*\bbc$/i.test(rest);
  rest = rest.replace(/\s*\bbc$/i, '');
  const date = normaliseDate(match[1]!, column, bc);
  if (typeof date !== 'string') return err(date.error || example);
  let zone = '';
  let clock = rest;
  const zoneMatch = /^(.*?\d)\s*(z|utc|[+-]\d{1,2}(?::?\d{2})?)$/i.exec(rest);
  if (zoneMatch) {
    if (!zoned) {
      return err(
        pg
          ? 'This column has no time zone; leave the offset out'
          : 'MySQL and MariaDB do not take a time zone offset here',
      );
    }
    clock = zoneMatch[1]!;
    const raw = zoneMatch[2]!.toUpperCase();
    zone = raw === 'Z' || raw === 'UTC' ? '+00' : raw;
  } else if (ZONE.test(rest)) {
    return err(example);
  }
  const time = clock === '' ? { text: '00:00:00', hours: 0 } : normaliseTime(clock, false);
  if (!time || time.hours > 23) return err(example);
  return ok(`${date} ${time.text}${zone}${bc && pg ? ' BC' : ''}`);
}

const INTERVAL_UNITS = new Set([
  'microsecond',
  'microseconds',
  'us',
  'usec',
  'usecs',
  'millisecond',
  'milliseconds',
  'ms',
  'msec',
  'msecs',
  'second',
  'seconds',
  's',
  'sec',
  'secs',
  'minute',
  'minutes',
  'm',
  'min',
  'mins',
  'hour',
  'hours',
  'h',
  'hr',
  'hrs',
  'day',
  'days',
  'd',
  'week',
  'weeks',
  'w',
  'month',
  'months',
  'mon',
  'mons',
  'year',
  'years',
  'y',
  'yr',
  'yrs',
  'decade',
  'decades',
  'century',
  'centuries',
  'millennium',
  'millennia',
]);

const ISO_DURATION =
  /^-?P(?=\d|T\d)(\d+(?:[.,]\d+)?Y)?(\d+(?:[.,]\d+)?M)?(\d+(?:[.,]\d+)?W)?(\d+(?:[.,]\d+)?D)?(T(?=\d)(\d+(?:[.,]\d+)?H)?(\d+(?:[.,]\d+)?M)?(\d+(?:[.,]\d+)?S)?)?$/i;

/** PostgreSQL interval input: ISO 8601 durations, "1 day 02:00:00", "3 hours ago", "1-2". */
function validInterval(text: string): boolean {
  if (ISO_DURATION.test(text)) return true;
  let s = text.toLowerCase().trim();
  if (s.startsWith('@')) s = s.slice(1).trim();
  if (s.endsWith(' ago')) s = s.slice(0, -4).trim();
  const tokens = s
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let components = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^[+-]?\d+(\.\d+)?$/.test(token)) {
      const unit = tokens[i + 1];
      if (unit !== undefined && INTERVAL_UNITS.has(unit)) i++;
      else if (unit !== undefined) return false;
      components++;
    } else if (
      /^[+-]?\d+:\d{1,2}(:\d{1,2}(\.\d+)?)?$/.test(token) ||
      /^[+-]?\d+-\d+$/.test(token)
    ) {
      components++;
    } else {
      return false;
    }
  }
  return components > 0;
}

function parseBinary(text: string, column: ColumnInfo): CellParseResult {
  const quoted = /^x'([0-9a-f]*)'$/i.exec(text);
  const hex = quoted ? quoted[1]! : text.replace(/^(0x|\\x)/i, '');
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    return err('Expected hex bytes like 0x48656c6c6f');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const base = baseType(column);
  if (
    column.length !== undefined &&
    (base === 'binary' || base === 'varbinary') &&
    bytes.length > column.length
  ) {
    return err(`At most ${column.length} bytes`);
  }
  return ok(bytes);
}

function parseEnum(text: string, column: ColumnInfo): CellParseResult {
  const labels = column.enumValues;
  if (labels === undefined) return ok(text);
  const find = (label: string): string | undefined => {
    if (labels.includes(label)) return label;
    if (column.dialect === 'postgres') return undefined;
    const matches = labels.filter((l) => l.toLowerCase() === label.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  };
  const list = labels.length > 12 ? `${labels.slice(0, 12).join(', ')}, …` : labels.join(', ');
  if (!column.multiple) {
    const label = find(text);
    return label === undefined ? err(`Expected one of: ${list}`) : ok(label);
  }
  if (text.trim() === '') return ok('');
  const chosen = new Set<string>();
  for (const part of text.split(',')) {
    const label = find(part.trim());
    if (label === undefined) return err(`"${part.trim()}" is not one of: ${list}`);
    chosen.add(label);
  }
  return ok(labels.filter((l) => chosen.has(l)).join(','));
}

/** An array element's text as PostgreSQL prints it inside an array. */
function elementText(value: CellValue): string {
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (value instanceof Uint8Array) return `\\x${toHex(value)}`;
  return formatCell(value);
}

function parseArray(text: string, column: ColumnInfo): CellParseResult {
  const example = 'Expected an array like {1,2,3} or [1, 2, 3]';
  let array: PgArray | string;
  if (text.startsWith('[')) {
    try {
      array = pgArrayFromJson(JSON.parse(text));
    } catch {
      return err(example);
    }
  } else array = parsePgArray(text);
  if (typeof array === 'string') return err(`${example}: ${array}`);
  const element = column.element;
  if (element === undefined) return ok(formatPgArray(array));
  let position = 0;
  const convert = (items: PgArray): PgArray | string => {
    const out: PgArray = [];
    for (const item of items) {
      if (item === null) {
        position++;
        out.push(null);
      } else if (Array.isArray(item)) {
        const nested = convert(item);
        if (typeof nested === 'string') return nested;
        out.push(nested);
      } else {
        position++;
        const parsed = parseCellInput(item, { ...element, nullable: true });
        if (!parsed.ok) return `Element ${position}: ${parsed.error}`;
        out.push(parsed.value === null ? null : elementText(parsed.value));
      }
    }
    return out;
  };
  const converted = convert(array);
  return typeof converted === 'string' ? err(converted) : ok(formatPgArray(converted));
}

function parseString(text: string, column: ColumnInfo): CellParseResult {
  const base = baseType(column);
  if (
    column.dialect === 'postgres' &&
    (base === 'bit' || base === 'bit varying' || base === 'varbit')
  ) {
    if (!/^[01]*$/.test(text)) return err('Expected bits like 0101');
    if (column.length !== undefined) {
      if (base === 'bit' && text.length !== column.length)
        return err(`Expected exactly ${column.length} bits`);
      if (base !== 'bit' && text.length > column.length)
        return err(`At most ${column.length} bits`);
    }
    return ok(text);
  }
  if (column.length !== undefined && [...text].length > column.length) {
    return err(`At most ${column.length} characters`);
  }
  return ok(text);
}

/**
 * Parses what the user typed (or pasted) into a cell of `column`. See the module comment for
 * each kind's rules and representation.
 */
export function parseCellInput(
  text: string,
  column: ColumnInfo,
  options: ParseOptions = {},
): CellParseResult {
  if (column.readOnly !== undefined) return err(column.readOnly);
  if (options.nullText !== undefined && text === options.nullText) {
    return column.nullable ? ok(null) : err('The column cannot be NULL');
  }
  const textual =
    column.kind === 'string' ||
    column.kind === 'unknown' ||
    (column.kind === 'enum' && column.multiple);
  if (text === '' && textual && !options.emptyIsNull) return parseValue(text, column);
  const trimmed = column.kind === 'string' || column.kind === 'unknown' ? text : text.trim();
  if (trimmed === '')
    return column.nullable ? ok(null) : err('A value is required: the column cannot be NULL');
  return parseValue(trimmed, column);
}

function parseValue(text: string, column: ColumnInfo): CellParseResult {
  switch (column.kind) {
    case 'integer':
    case 'bigint':
      return parseInteger(text, column);
    case 'boolean': {
      if (column.booleanLike) return parseInteger(text, column);
      const word = booleanWord(text);
      return word === undefined ? err('Expected true or false') : ok(word);
    }
    case 'decimal':
      return parseDecimal(text, column);
    case 'float':
      return parseFloatValue(text, column);
    case 'date':
      return parseDateValue(text, column);
    case 'time':
      return parseTime(text, column);
    case 'datetime':
    case 'timestamp':
      return parseDateTime(text, column);
    case 'interval':
      return validInterval(text)
        ? ok(text)
        : err('Expected an interval like 1 day 02:00:00, 3 hours or P1DT2H');
    case 'json':
      try {
        JSON.parse(text);
        return ok(text);
      } catch (error) {
        return err(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    case 'uuid': {
      const hex = text
        .replace(/^\{(.*)\}$/, '$1')
        .replace(/-/g, '')
        .toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hex)) {
        return err('Expected a UUID like 123e4567-e89b-12d3-a456-426614174000');
      }
      return ok(
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      );
    }
    case 'binary':
      return parseBinary(text, column);
    case 'enum':
      return parseEnum(text, column);
    case 'array':
      return parseArray(text, column);
    case 'string':
      return parseString(text, column);
    default:
      return ok(text);
  }
}

/**
 * A value as editable text: the inverse of `parseCellInput` for every non-NULL value. NULL and
 * DEFAULT give '' (the grid shows them as states, not text); binary is 0x-prefixed hex; a
 * large-value handle gives its preview.
 */
export function formatCell(value: EditValue | undefined, _column?: ColumnInfo): string {
  if (value === undefined || value === null || isDefault(value)) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return `0x${toHex(value)}`;
  if (isLargeValue(value)) return value.preview;
  return '';
}
