import * as zlib from 'node:zlib';

import { QuerybaraError, type CellValue, type ColumnMeta, type SqlDialect } from '@querybara/core';
import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
  type ParquetParsers,
  type SchemaElement,
  type SchemaTree,
} from 'hyparquet';
import { ByteWriter, ParquetWriter } from 'hyparquet-writer';

import type { InferredColumn, InferredType } from './infer';
import {
  gunzip,
  isGzip,
  peekSource,
  randomAccess,
  type ByteSource,
  type RandomAccessReader,
  type Sink,
} from './io';
import { emptyParts, headerNames, toBatch } from './rows';
import { jsonText, type JsonText, type RowBatch, type SourceCell } from './types';

/**
 * Apache Parquet (spec §12), on hyparquet and hyparquet-writer (ADR 0020): the Thrift footer,
 * the page encodings and nested columns are theirs; how values map to and from database types,
 * streaming and the codecs are ours.
 *
 * Writing: the result's pages collect into a row group (100,000 rows, or about 8 MiB of
 * values, whichever comes first), which is encoded and handed to the sink before more rows are
 * fetched, so memory holds one row group. Column types come from the result's column kinds,
 * and values keep every digit and tick: integers as INT32 or INT64 (unsigned ones annotated),
 * `numeric(p,s)` as DECIMAL(p,s), dates as DATE, times as TIME(µs), timestamps as
 * TIMESTAMP(µs), UTC-adjusted when the server gave an offset, UUIDs as UUID, JSON as JSON, binary
 * as plain BYTE_ARRAY. A decimal without a precision (PostgreSQL's plain `numeric`), money,
 * intervals, arrays and everything else are UTF-8 text, as the server wrote them.
 *
 * Reading: positioned reads of the file (a copy spooled to disk for stdin or gzip), one row
 * group's column chunks at a time, decoded in slices of rows. Values come back as the text the
 * import converters take: exact decimal text, ISO dates and timestamps (`Z` when UTC-adjusted),
 * `\x` hex for binary, JSON text for nested columns (lists, maps, structs).
 */

// ---------------------------------------------------------------------------------------------
// Codecs

export const PARQUET_COMPRESSIONS = ['snappy', 'zstd', 'gzip', 'none'] as const;
export type ParquetCompression = (typeof PARQUET_COMPRESSIONS)[number];

const CODEC = {
  snappy: 'SNAPPY',
  zstd: 'ZSTD',
  gzip: 'GZIP',
  none: 'UNCOMPRESSED',
} as const satisfies Record<ParquetCompression, string>;

function corrupt(what: string): QuerybaraError {
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `The Parquet file is damaged: ${what}`,
  });
}

/** Decodes one LZ4 block (the raw format of LZ4_RAW pages) into exactly `outputLength` bytes. */
export function lz4Block(input: Uint8Array, outputLength: number): Uint8Array {
  const out = new Uint8Array(outputLength);
  let i = 0;
  let o = 0;
  const length = (base: number): number => {
    let n = base;
    if (base !== 15) return n;
    for (;;) {
      const byte = input[i++];
      if (byte === undefined) throw corrupt('an LZ4 length runs past the page');
      n += byte;
      if (byte !== 255) return n;
    }
  };
  while (i < input.length) {
    const token = input[i++]!;
    const literals = length(token >> 4);
    if (i + literals > input.length || o + literals > outputLength) {
      throw corrupt('LZ4 literals run past the page');
    }
    out.set(input.subarray(i, i + literals), o);
    i += literals;
    o += literals;
    // The last sequence is literals only.
    if (i >= input.length) break;
    if (i + 2 > input.length) throw corrupt('an LZ4 match offset is cut short');
    const offset = input[i]! | (input[i + 1]! << 8);
    i += 2;
    if (offset === 0 || offset > o) throw corrupt('an LZ4 match points before the page');
    const match = length(token & 15) + 4;
    if (o + match > outputLength) throw corrupt('an LZ4 match runs past the page');
    // Matches may overlap what they copy (runs), so byte by byte.
    for (let from = o - offset, end = o + match; o < end;) out[o++] = out[from++]!;
  }
  if (o !== outputLength) throw corrupt('an LZ4 page is shorter than its header says');
  return out;
}

/**
 * The deprecated LZ4 codec: Hadoop's framing (big-endian decompressed and compressed sizes
 * before each block), or a bare block as older parquet-cpp wrote it.
 */
function lz4Hadoop(input: Uint8Array, outputLength: number): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  try {
    const out = new Uint8Array(outputLength);
    let i = 0;
    let o = 0;
    while (i < input.length) {
      if (i + 8 > input.length) throw corrupt('a Hadoop LZ4 frame is cut short');
      const size = view.getUint32(i);
      const compressed = view.getUint32(i + 4);
      i += 8;
      if (i + compressed > input.length || o + size > outputLength) {
        throw corrupt('a Hadoop LZ4 frame runs past the page');
      }
      out.set(lz4Block(input.subarray(i, i + compressed), size), o);
      i += compressed;
      o += size;
    }
    if (o !== outputLength) throw corrupt('Hadoop LZ4 frames do not fill the page');
    return out;
  } catch {
    return lz4Block(input, outputLength);
  }
}

/** zstd arrived in node:zlib in Node.js 22.15; say so rather than fail obscurely. */
function zstd(name: 'zstdCompressSync' | 'zstdDecompressSync'): (input: Uint8Array) => Buffer {
  const fn = (zlib as Partial<typeof zlib>)[name];
  if (typeof fn !== 'function') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'ZSTD compression needs Node.js 22.15 or later',
    });
  }
  return (input) => fn(input);
}

/** Page decompressors beyond hyparquet's built-in Snappy, each bounded by the page's size. */
const DECOMPRESSORS: Compressors = {
  GZIP: (input, outputLength) => zlib.unzipSync(input, { maxOutputLength: outputLength || 1 }),
  BROTLI: (input, outputLength) =>
    zlib.brotliDecompressSync(input, { maxOutputLength: outputLength || 1 }),
  ZSTD: (input) => zstd('zstdDecompressSync')(input),
  LZ4: lz4Hadoop,
  LZ4_RAW: lz4Block,
};

const COMPRESSORS = {
  GZIP: (input: Uint8Array) => zlib.gzipSync(input),
  ZSTD: (input: Uint8Array) => zstd('zstdCompressSync')(input),
};

// ---------------------------------------------------------------------------------------------
// Calendar arithmetic (proleptic Gregorian, any year; Date covers only ±273,790 years)

/** Days since 1970-01-01 of a civil date. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The civil date of a day number. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

const pad = (n: number | bigint, width = 2): string => String(n).padStart(width, '0');

/** A day number as `YYYY-MM-DD`; years before 1 as PostgreSQL writes them (`0044-03-15 BC`). */
export function dateText(days: number): string {
  const { year, month, day } = civilFromDays(days);
  const date = `${pad(year > 0 ? year : 1 - year, 4)}-${pad(month)}-${pad(day)}`;
  return year > 0 ? date : `${date} BC`;
}

/** Digits of a fraction of a second, trailing zeros dropped (`.5`, `.000123`, or nothing). */
function fractionText(fraction: bigint, digits: number): string {
  if (fraction === 0n) return '';
  return `.${pad(fraction, digits).replace(/0+$/, '')}`;
}

const DAY_SECONDS = 86_400n;

/** A time of day from units since midnight. */
function timeText(value: bigint, perSecond: bigint, digits: number): string {
  const seconds = value / perSecond;
  const fraction = value % perSecond;
  const h = seconds / 3600n;
  const m = (seconds / 60n) % 60n;
  const s = seconds % 60n;
  return `${pad(h)}:${pad(m)}:${pad(s)}${fractionText(fraction, digits)}`;
}

/** A timestamp from units since the epoch; `Z` when the instant is UTC-adjusted. */
function timestampText(value: bigint, perSecond: bigint, digits: number, utc: boolean): string {
  let seconds = value / perSecond;
  let fraction = value % perSecond;
  if (fraction < 0n) {
    fraction += perSecond;
    seconds -= 1n;
  }
  let days = seconds / DAY_SECONDS;
  let rest = seconds % DAY_SECONDS;
  if (rest < 0n) {
    rest += DAY_SECONDS;
    days -= 1n;
  }
  const date = dateText(Number(days));
  const time = timeText(rest * perSecond + fraction, perSecond, digits);
  const bc = date.endsWith(' BC');
  const stamp = `${bc ? date.slice(0, -3) : date} ${time}${utc ? 'Z' : ''}`;
  return bc ? `${stamp} BC` : stamp;
}

const DATE_TEXT = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/i;
const TIMESTAMP_TEXT =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?( BC)?$/i;
const TIME_TEXT = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?$/;

function calendarYear(digits: string, bc: string | undefined): number {
  const year = Number(digits);
  return bc === undefined ? year : 1 - year;
}

/** Microseconds in a fraction of a second (digits past the sixth are dropped). */
function fractionMicros(digits: string | undefined): bigint {
  return digits === undefined ? 0n : BigInt(digits.slice(0, 6).padEnd(6, '0'));
}

/** Seconds east of UTC in an offset: `Z`, `+05`, `+0530`, `+05:30`, `-03:30:15`. */
function offsetSeconds(zone: string): number {
  if (zone.toUpperCase() === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(/:/g, '');
  const [h, m, s] = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
  return sign * (Number(h) * 3600 + Number(m || '0') * 60 + Number(s || '0'));
}

// ---------------------------------------------------------------------------------------------
// Writing

export interface ParquetExportOptions {
  /** Page compression: `snappy` (default; fast and read everywhere), `zstd`, `gzip` or `none`. */
  readonly compression?: ParquetCompression;
  /** Most rows per row group (default 100,000); a group also ends at about 8 MiB of values. */
  readonly rowGroupRows?: number;
}

const GROUP_ROWS = 100_000;
/**
 * Estimated bytes of values per row group (see sizeOf). Encoding a group takes several times
 * the values' own size in hyparquet-writer, so this keeps an export's memory near 100 MB
 * whatever the table's width: 30,000-50,000 rows of a typical 8-column table.
 */
const GROUP_BYTES = 8 * 1024 * 1024;

function invalidValue(message: string, hint?: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message, ...(hint ? { hint } : {}) });
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hexText(bytes: Uint8Array, prefix = '\\x'): string {
  let out = prefix;
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

function isHandle(value: CellValue): boolean {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array);
}

/** A cell as text, as CSV writes it. */
function cellText(value: Exclude<CellValue, null>): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return hexText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw largeValue();
}

function largeValue(): QuerybaraError {
  return new QuerybaraError({
    code: 'NOT_SUPPORTED',
    message: 'A large value was only previewed; fetch it in full before exporting',
  });
}

const encoder = new TextEncoder();

/** How one result column is written: its schema element and how a cell becomes its value. */
interface ColumnPlan {
  readonly element: SchemaElement;
  /** A non-null cell as the value hyparquet-writer takes for the element. */
  readonly value: (cell: Exclude<CellValue, null>) => unknown;
  /** A converted type for the footer only, set once the pages are written (see `close`). */
  readonly footerConvertedType?: 'JSON';
}

function integerOf(cell: Exclude<CellValue, null>): bigint {
  if (typeof cell === 'bigint') return cell;
  if (typeof cell === 'number' && Number.isInteger(cell)) return BigInt(cell);
  if (typeof cell === 'boolean') return cell ? 1n : 0n;
  if (typeof cell === 'string' && /^[+-]?\d+$/.test(cell.trim())) return BigInt(cell.trim());
  throw invalidValue(`${typeof cell === 'string' ? `"${cell}"` : String(cell)} is not an integer`);
}

const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;

/** Bytes of a FIXED_LEN_BYTE_ARRAY that holds every unscaled value of a precision. */
function decimalBytes(precision: number): number {
  const max = 10n ** BigInt(precision) - 1n;
  let bytes = 1;
  while (max >= 2n ** BigInt(8 * bytes - 1)) bytes++;
  return bytes;
}

const DECIMAL_TEXT = /^([+-])?(\d*)(?:\.(\d*))?$/;

/** Decimal text as its unscaled integer at `scale`, checked against `precision`. */
export function unscaledDecimal(text: string, precision: number, scale: number): bigint {
  const m = DECIMAL_TEXT.exec(text.trim());
  const whole = m?.[2] ?? '';
  const fraction = m?.[3] ?? '';
  if (!m || whole + fraction === '') {
    throw invalidValue(
      `"${text}" cannot be written as a Parquet DECIMAL`,
      'Export the column as text: cast it in a query',
    );
  }
  if (/[1-9]/.test(fraction.slice(scale))) {
    throw invalidValue(`${text} has more than ${scale} decimal places`);
  }
  const digits = `${whole}${fraction.slice(0, scale).padEnd(scale, '0')}`;
  const unscaled = BigInt(digits === '' ? '0' : digits);
  if (unscaled >= 10n ** BigInt(precision)) {
    throw invalidValue(`${text} has more than ${precision} digits`);
  }
  return m[1] === '-' ? -unscaled : unscaled;
}

function dateDays(cell: Exclude<CellValue, null>): number {
  const text = String(cell).trim();
  const m = DATE_TEXT.exec(text);
  if (!m) {
    throw invalidValue(
      `"${text}" cannot be written as a Parquet DATE`,
      'Export the column as text: cast it in a query',
    );
  }
  return daysFromCivil(calendarYear(m[1]!, m[4]), Number(m[2]), Number(m[3]));
}

/** Microseconds since the epoch; UTC when the text has an offset, its wall clock otherwise. */
function timestampMicros(cell: Exclude<CellValue, null>): bigint {
  const text = String(cell).trim();
  const m = TIMESTAMP_TEXT.exec(text) ?? (DATE_TEXT.test(text) ? null : undefined);
  if (m === null) return BigInt(dateDays(cell)) * DAY_SECONDS * 1_000_000n;
  if (m === undefined) {
    throw invalidValue(
      `"${text}" cannot be written as a Parquet TIMESTAMP`,
      'Export the column as text: cast it in a query',
    );
  }
  const days = daysFromCivil(calendarYear(m[1]!, m[9]), Number(m[2]), Number(m[3]));
  const offset = m[8] === undefined ? 0 : offsetSeconds(m[8]);
  const seconds =
    BigInt(days) * DAY_SECONDS +
    BigInt(Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]) - offset);
  return seconds * 1_000_000n + fractionMicros(m[7]);
}

function timeMicros(cell: Exclude<CellValue, null>): bigint {
  const text = String(cell).trim();
  const m = TIME_TEXT.exec(text);
  const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : -1;
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59 || seconds > 86_400) {
    throw invalidValue(
      `"${text}" is not a time of day, which Parquet TIME holds`,
      'Export the column as text: cast it in a query',
    );
  }
  return BigInt(seconds) * 1_000_000n + fractionMicros(m[4]);
}

function booleanOf(cell: Exclude<CellValue, null>): boolean {
  if (typeof cell === 'boolean') return cell;
  if (cell === 0 || cell === 1) return cell === 1;
  const text = String(cell).trim().toLowerCase();
  if (['t', 'true', '1', 'y', 'yes', 'on'].includes(text)) return true;
  if (['f', 'false', '0', 'n', 'no', 'off'].includes(text)) return false;
  throw invalidValue(`"${String(cell)}" is not a boolean`);
}

function floatOf(cell: Exclude<CellValue, null>): number {
  if (typeof cell === 'number') return cell;
  if (typeof cell === 'bigint') return Number(cell);
  const text = String(cell).trim();
  const value = Number(text);
  if (!Number.isNaN(value) || /^[+-]?nan$/i.test(text)) return value;
  if (/^[+-]?inf(inity)?$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  throw invalidValue(`"${text}" is not a number`);
}

function textPlan(name: string, repetition: SchemaElement['repetition_type']): ColumnPlan {
  return {
    element: {
      name,
      type: 'BYTE_ARRAY',
      converted_type: 'UTF8',
      logical_type: { type: 'STRING' },
      repetition_type: repetition,
    },
    value: cellText,
  };
}

/**
 * The Parquet column for a result column, from its kind and the engine's type name. The
 * dialect tells PostgreSQL's `time` (a time of day) from MySQL's (a duration of ±838 hours).
 */
export function parquetColumnPlan(
  column: ColumnMeta,
  name = column.name,
  dialect: SqlDialect = 'postgres',
): ColumnPlan {
  const repetition = column.nullable === false ? 'REQUIRED' : 'OPTIONAL';
  const native = column.nativeType.toLowerCase().trim();
  const unsigned = /\bunsigned\b/.test(native);
  const base = { name, repetition_type: repetition } as const;
  switch (column.kind) {
    case 'boolean':
      return { element: { ...base, type: 'BOOLEAN' }, value: booleanOf };
    case 'integer': {
      // oid and INT UNSIGNED reach 2^32 - 1; the rest fit INT32.
      if (native === 'oid' || (unsigned && /^(int|integer)\b/.test(native))) {
        return { element: { ...base, type: 'INT64' }, value: integerOf };
      }
      return {
        element: { ...base, type: 'INT32' },
        value: (cell) => {
          const value = integerOf(cell);
          if (value < INT32_MIN || value > INT32_MAX) {
            throw invalidValue(`${value} does not fit a 32-bit integer`);
          }
          return Number(value);
        },
      };
    }
    case 'bigint':
      if (unsigned) {
        // The legacy annotation alone: hyparquet-writer encodes the INTEGER logical type's bit
        // width as a Thrift i32 where the format has an i8, and Arrow refuses the footer.
        // Readers take UINT_64 as the same unsigned 64-bit integer.
        return {
          element: { ...base, type: 'INT64', converted_type: 'UINT_64' },
          value: (cell) => BigInt.asIntN(64, integerOf(cell)),
        };
      }
      return { element: { ...base, type: 'INT64' }, value: integerOf };
    case 'decimal': {
      const m = /^(?:numeric|decimal|dec|fixed)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(native);
      const precision = Number(m?.[1] ?? 0);
      const scale = Number(m?.[2] ?? 0);
      // Unbounded numeric, money and the widest decimals stay text, digit for digit.
      if (!m || precision < 1 || precision > 76 || scale > precision)
        return textPlan(name, repetition);
      const physical =
        precision <= 9
          ? ({ type: 'INT32' } as const)
          : precision <= 18
            ? ({ type: 'INT64' } as const)
            : ({ type: 'FIXED_LEN_BYTE_ARRAY', type_length: decimalBytes(precision) } as const);
      return {
        element: {
          ...base,
          ...physical,
          converted_type: 'DECIMAL',
          logical_type: { type: 'DECIMAL', precision, scale },
          precision,
          scale,
        },
        value: (cell) =>
          unscaledDecimal(typeof cell === 'string' ? cell : cellText(cell), precision, scale),
      };
    }
    case 'float':
      return {
        element: {
          ...base,
          type:
            /^(float4|real)\b/.test(native) || /^float\b(?!\s*\()/.test(native)
              ? 'FLOAT'
              : 'DOUBLE',
        },
        value: floatOf,
      };
    case 'date':
      return {
        element: { ...base, type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' } },
        value: dateDays,
      };
    case 'datetime':
    case 'timestamp': {
      // PostgreSQL's timestamptz text carries its offset: those are instants. MySQL's
      // TIMESTAMP arrives as session wall-clock text, like DATETIME.
      const utc = /^timestamptz\b|with time zone/.test(native);
      return {
        element: {
          ...base,
          type: 'INT64',
          ...(utc ? { converted_type: 'TIMESTAMP_MICROS' as const } : {}),
          logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: utc, unit: 'MICROS' },
        },
        value: timestampMicros,
      };
    }
    case 'time':
      if (dialect !== 'postgres' || /^timetz\b|with time zone/.test(native)) {
        return textPlan(name, repetition);
      }
      return {
        element: {
          ...base,
          type: 'INT64',
          logical_type: { type: 'TIME', isAdjustedToUTC: false, unit: 'MICROS' },
        },
        value: timeMicros,
      };
    case 'json':
      // The server's JSON text as it is. The JSON converted type, which DuckDB and older
      // readers go by, would make hyparquet-writer serialise the text again, so it is added to
      // the footer only, after the pages are written.
      return {
        element: { ...base, type: 'BYTE_ARRAY', logical_type: { type: 'JSON' } },
        value: (cell) => (cell instanceof Uint8Array ? cell : encoder.encode(cellText(cell))),
        footerConvertedType: 'JSON',
      };
    case 'uuid':
      return {
        element: {
          ...base,
          type: 'FIXED_LEN_BYTE_ARRAY',
          type_length: 16,
          logical_type: { type: 'UUID' },
        },
        value: (cell) => (cell instanceof Uint8Array ? cell : cellText(cell).trim()),
      };
    case 'binary':
      return {
        element: { ...base, type: 'BYTE_ARRAY' },
        value: (cell) => (cell instanceof Uint8Array ? cell : encoder.encode(cellText(cell))),
      };
    default:
      return textPlan(name, repetition);
  }
}

/** Rough bytes a value takes in memory (its slot, and its contents), to size row groups. */
function sizeOf(value: unknown): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value instanceof Uint8Array) return 16 + value.length;
  return 16;
}

/** hyparquet-writer's output buffer, handed to the sink after each row group and at the end. */
class SinkWriter extends ByteWriter {
  constructor(private readonly sink: Sink) {
    super(64 * 1024);
  }

  flush(): Promise<void> {
    if (this.index === 0) return Promise.resolve();
    // The buffer is reused, and a sink may hold a chunk after its write resolves.
    const chunk = new Uint8Array(this.buffer, 0, this.index).slice();
    this.index = 0;
    return this.sink.write(chunk);
  }

  override finish(): Promise<void> {
    return this.flush();
  }
}

/**
 * One Parquet file of one result, written as its pages arrive. `close` writes the footer and
 * closes the sink; `abort` abandons the file.
 */
export class ParquetFileWriter {
  private readonly out: SinkWriter;
  private writer: ParquetWriter | undefined;
  private plans: ColumnPlan[] = [];
  private names: string[] = [];
  private values: unknown[][] = [];
  private rows = 0;
  private bytes = 0;
  private readonly groupRows: number;

  constructor(
    private readonly sink: Sink,
    private readonly options: ParquetExportOptions = {},
    private readonly dialect: SqlDialect = 'postgres',
  ) {
    this.out = new SinkWriter(sink);
    this.groupRows = Math.max(1, Math.floor(options.rowGroupRows ?? GROUP_ROWS));
  }

  begin(
    columns: readonly ColumnMeta[],
    names: readonly string[] = columns.map((c) => c.name),
  ): void {
    if (this.writer !== undefined) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'A Parquet file holds one table',
      });
    }
    if (columns.length === 0) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'The result has no columns to write to Parquet',
      });
    }
    this.names = [...names];
    this.plans = columns.map((column, c) => parquetColumnPlan(column, names[c], this.dialect));
    this.values = columns.map(() => []);
    const compression = this.options.compression ?? 'snappy';
    this.writer = new ParquetWriter({
      writer: this.out,
      schema: [{ name: 'root', num_children: columns.length }, ...this.plans.map((p) => p.element)],
      codec: CODEC[compression],
      compressors: COMPRESSORS,
      kvMetadata: [{ key: 'writer', value: 'Querybara' }],
    });
  }

  /** Adds a page of rows (column-major, as results arrive); writes a row group when full. */
  async page(data: readonly (readonly CellValue[])[], rowCount: number): Promise<void> {
    const width = this.plans.length;
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < width; c++) {
        const cell = data[c]?.[r] ?? null;
        let value: unknown = null;
        if (cell !== null) {
          if (isHandle(cell)) throw largeValue();
          try {
            value = this.plans[c]!.value(cell);
          } catch (error) {
            if (!(error instanceof QuerybaraError)) throw error;
            throw new QuerybaraError({
              code: error.code,
              message: `Column "${this.names[c]!}", row ${this.rows + 1}: ${error.message}`,
              ...(error.hint !== undefined ? { hint: error.hint } : {}),
            });
          }
        }
        this.bytes += sizeOf(value);
        this.values[c]!.push(value);
      }
      this.rows++;
      if (this.rows >= this.groupRows || this.bytes >= GROUP_BYTES) await this.flushGroup();
    }
  }

  private async flushGroup(): Promise<void> {
    if (this.writer === undefined || this.rows === 0) return;
    const columnData = this.plans.map((plan, c) => ({
      name: plan.element.name,
      data: this.values[c]!,
    }));
    const rows = this.rows;
    this.values = this.plans.map(() => []);
    this.rows = 0;
    this.bytes = 0;
    try {
      await this.writer.write({ columnData, rowGroupSize: rows });
    } catch (error) {
      throw error instanceof QuerybaraError
        ? error
        : invalidValue(`Could not write a Parquet row group: ${(error as Error).message}`);
    }
  }

  /** Writes the rows still held; the footer follows at `close`. */
  async end(): Promise<void> {
    await this.flushGroup();
  }

  async close(): Promise<void> {
    if (this.writer === undefined) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'Nothing was exported, so there is no Parquet file to write',
      });
    }
    await this.flushGroup();
    // The writer holds these element objects and serialises them into the footer at finish.
    for (const plan of this.plans) {
      if (plan.footerConvertedType !== undefined) {
        plan.element.converted_type = plan.footerConvertedType;
      }
    }
    await this.writer.finish();
    await this.sink.close();
  }

  abort(reason?: unknown): Promise<void> {
    return this.sink.abort(reason);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading

/** Rows decoded per step within a row group. */
const SLICE_ROWS = 16_384;

const MAGIC = [0x50, 0x41, 0x52, 0x31]; // PAR1
const ENCRYPTED_MAGIC = [0x50, 0x41, 0x52, 0x45]; // PARE

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  return magic.every((byte, i) => bytes[at + i] === byte);
}

/** True when bytes start like a Parquet file. */
export function isParquet(head: Uint8Array): boolean {
  return startsWith(head, MAGIC) || startsWith(head, ENCRYPTED_MAGIC);
}

function refuse(message: string, hint?: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message, ...(hint ? { hint } : {}) });
}

/** How a top-level leaf's raw values become cells, and what the column is. */
interface LeafReader {
  readonly type: InferredType;
  readonly precision?: number;
  readonly scale?: number;
  readonly fractionalDigits?: number;
  readonly withTimeZone?: boolean;
  /** A raw value (annotations stripped: numbers, bigints, booleans, bytes). */
  readonly convert: (raw: unknown) => SourceCell;
}

const utf8 = new TextDecoder('utf-8');

function bytesOf(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === 'string') return encoder.encode(raw);
  throw corrupt('a byte array column holds something else');
}

function twosComplement(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const bits = BigInt(bytes.length * 8);
  return bytes.length > 0 && (bytes[0]! & 0x80) !== 0 ? value - (1n << bits) : value;
}

/** An unscaled integer as decimal text at `scale`. */
export function decimalText(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  let digits = (negative ? -unscaled : unscaled).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  } else if (scale < 0) {
    digits += '0'.repeat(-scale);
  }
  return negative ? `-${digits}` : digits;
}

function float16(bytes: Uint8Array): number {
  const bits = (bytes[1]! << 8) | bytes[0]!;
  const sign = bits >> 15 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function uuidText(bytes: Uint8Array): string {
  const hex = hexText(bytes, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Parquet's INTERVAL (months, days, milliseconds) as ISO 8601, which PostgreSQL reads. */
function intervalText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const months = view.getUint32(0, true);
  const days = view.getUint32(4, true);
  const ms = view.getUint32(8, true);
  return `P${months}M${days}DT${Math.floor(ms / 1000)}${fractionText(BigInt(ms % 1000), 3)}S`;
}

function numberOrBigint(value: bigint): number | bigint {
  return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

const UNITS = {
  MILLIS: { perSecond: 1000n, digits: 3 },
  MICROS: { perSecond: 1_000_000n, digits: 6 },
  NANOS: { perSecond: 1_000_000_000n, digits: 9 },
} as const;

function bigintOf(raw: unknown): bigint {
  return typeof raw === 'bigint' ? raw : BigInt(raw as number);
}

/** The reader of a top-level primitive column, from its annotations. */
function leafReader(element: SchemaElement): LeafReader {
  const { type, logical_type: logical, converted_type: converted } = element;
  const text: LeafReader = { type: 'text', convert: (raw) => utf8.decode(bytesOf(raw)) };
  const binary: LeafReader = { type: 'binary', convert: (raw) => hexText(bytesOf(raw)) };

  if (
    logical?.type === 'STRING' ||
    logical?.type === 'ENUM' ||
    converted === 'UTF8' ||
    converted === 'ENUM'
  ) {
    return text;
  }
  if (logical?.type === 'JSON' || converted === 'JSON') {
    return { ...text, type: 'json' };
  }
  if (logical?.type === 'UUID' && type === 'FIXED_LEN_BYTE_ARRAY') {
    return { type: 'uuid', convert: (raw) => uuidText(bytesOf(raw)) };
  }
  if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
    const precision = logical?.type === 'DECIMAL' ? logical.precision : (element.precision ?? 38);
    const scale = logical?.type === 'DECIMAL' ? logical.scale : (element.scale ?? 0);
    const convert =
      type === 'INT32' || type === 'INT64'
        ? (raw: unknown) => decimalText(bigintOf(raw), scale)
        : (raw: unknown) => decimalText(twosComplement(bytesOf(raw)), scale);
    return { type: 'decimal', precision, scale: Math.max(0, scale), convert };
  }
  if (logical?.type === 'DATE' || converted === 'DATE') {
    return { type: 'date', convert: (raw) => dateText(Number(raw)) };
  }
  if (logical?.type === 'TIME' || converted === 'TIME_MILLIS' || converted === 'TIME_MICROS') {
    const unit =
      logical?.type === 'TIME' ? logical.unit : converted === 'TIME_MILLIS' ? 'MILLIS' : 'MICROS';
    const { perSecond, digits } = UNITS[unit];
    return {
      type: 'time',
      fractionalDigits: Math.min(digits, 6),
      convert: (raw) => timeText(bigintOf(raw), perSecond, digits),
    };
  }
  if (
    logical?.type === 'TIMESTAMP' ||
    converted === 'TIMESTAMP_MILLIS' ||
    converted === 'TIMESTAMP_MICROS'
  ) {
    const unit =
      logical?.type === 'TIMESTAMP'
        ? logical.unit
        : converted === 'TIMESTAMP_MILLIS'
          ? 'MILLIS'
          : 'MICROS';
    const utc = logical?.type === 'TIMESTAMP' ? logical.isAdjustedToUTC : true;
    const { perSecond, digits } = UNITS[unit];
    return {
      type: 'timestamp',
      fractionalDigits: Math.min(digits, 6),
      withTimeZone: utc,
      convert: (raw) => timestampText(bigintOf(raw), perSecond, digits, utc),
    };
  }
  if (logical?.type === 'INTERVAL' || converted === 'INTERVAL') {
    return { type: 'text', convert: (raw) => intervalText(bytesOf(raw)) };
  }
  if (logical?.type === 'FLOAT16') {
    return { type: 'float', convert: (raw) => float16(bytesOf(raw)) };
  }
  if (logical?.type === 'GEOMETRY' || logical?.type === 'GEOGRAPHY') {
    // Well-known binary as hex, which PostGIS reads as a geometry.
    return { type: 'text', convert: (raw) => hexText(bytesOf(raw), '') };
  }
  const unsignedInt =
    (logical?.type === 'INTEGER' && !logical.isSigned) ||
    converted === 'UINT_8' ||
    converted === 'UINT_16' ||
    converted === 'UINT_32' ||
    converted === 'UINT_64';
  switch (type) {
    case 'BOOLEAN':
      return { type: 'boolean', convert: (raw) => Boolean(raw) };
    case 'INT32':
      if (unsignedInt) {
        const narrow =
          converted === 'UINT_8' ||
          converted === 'UINT_16' ||
          (logical?.type === 'INTEGER' && logical.bitWidth < 32);
        return { type: narrow ? 'integer' : 'bigint', convert: (raw) => (raw as number) >>> 0 };
      }
      return { type: 'integer', convert: (raw) => raw as number };
    case 'INT64':
      if (unsignedInt) {
        return {
          type: 'decimal',
          precision: 20,
          scale: 0,
          convert: (raw) => numberOrBigint(BigInt.asUintN(64, bigintOf(raw))),
        };
      }
      return { type: 'bigint', convert: (raw) => numberOrBigint(bigintOf(raw)) };
    case 'INT96':
      // Converted by the timestamp parser below: Spark and Impala's nanosecond instants.
      return {
        type: 'timestamp',
        fractionalDigits: 6,
        withTimeZone: true,
        convert: (raw) => raw as string,
      };
    case 'FLOAT':
    case 'DOUBLE':
      return { type: 'float', convert: (raw) => raw as number };
    default:
      return binary;
  }
}

/** A JSON value, exactly: bigints as digits, bytes as base64, dates as ISO text. */
function jsonOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'bigint':
      return value.toString();
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }
  if (typeof (value as JsonText).$json === 'string') return (value as JsonText).$json;
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return `[${Array.from(value as ArrayLike<unknown>, jsonOf).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${jsonOf(v)}`).join(',')}}`;
}

/**
 * hyparquet's converters for what reaches them (nested columns' leaves and INT96), as the
 * text the import takes.
 */
const PARSERS: Partial<ParquetParsers> = {
  timestampFromMilliseconds: (ms) => timestampText(ms, 1000n, 3, true),
  timestampFromMicroseconds: (us) => timestampText(us, 1_000_000n, 6, true),
  timestampFromNanoseconds: (ns) => timestampText(ns, 1_000_000_000n, 9, true),
  dateFromDays: (days) => dateText(days),
  jsonFromBytes: (bytes) => (bytes ? jsonText(utf8.decode(bytes)) : bytes),
};

/** One top-level column of the file. */
interface FileColumn {
  /** The name in the file (read by it). */
  readonly source: string;
  /** Unique, non-blank name for the import. */
  readonly name: string;
  readonly nullable: boolean;
  readonly nested: boolean;
  readonly reader: LeafReader;
}

/** An open Parquet file: its metadata, columns and positioned reads. */
export interface ParquetFile {
  readonly size: number;
  readonly metadata: FileMetaData;
  readonly rows: number;
  readonly columns: readonly FileColumn[];
  readonly createdBy?: string;
  readonly compressions: readonly string[];
  close(): Promise<void>;
  /** Reads rows [start, end) as cells aligned with `columns`. */
  read(start: number, end: number): Promise<SourceCell[][]>;
  /** Byte offset where each row group's data ends, for progress. */
  readonly groupEnds: readonly number[];
  /** Forgets the byte ranges fetched so far, before the next row group. */
  focus(): void;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Opens a Parquet file for reading: checks its magic numbers, reads the footer and describes
 * its columns. Gzip-wrapped files (and sources without positioned reads) are spooled to disk.
 */
export async function openParquet(
  source: ByteSource,
  decompress: 'auto' | 'gzip' | 'none' = 'auto',
): Promise<ParquetFile> {
  let reader: RandomAccessReader | undefined;
  if (source.randomAccess !== undefined && decompress !== 'gzip') {
    const direct = await source.randomAccess();
    const head = await direct.read(0, 2);
    if (decompress === 'none' || !isGzip(head)) reader = direct;
    else await direct.close();
  }
  if (reader === undefined) {
    let bytes = source;
    if (decompress !== 'none') {
      const peeked = await peekSource(source, 2);
      bytes = decompress === 'gzip' || isGzip(peeked.head) ? gunzip(peeked.source) : peeked.source;
    }
    reader = await randomAccess(bytes);
  }
  try {
    return await describe(reader);
  } catch (error) {
    await reader.close();
    throw error;
  }
}

async function describe(reader: RandomAccessReader): Promise<ParquetFile> {
  const size = reader.size;
  const head = size >= 4 ? await reader.read(0, 4) : new Uint8Array();
  const tail = size >= 8 ? await reader.read(size - 4, 4) : new Uint8Array();
  if (startsWith(head, ENCRYPTED_MAGIC) || startsWith(tail, ENCRYPTED_MAGIC)) {
    throw refuse('This Parquet file is encrypted', 'Decrypt it with the tool that wrote it');
  }
  if (!startsWith(head, MAGIC) || !startsWith(tail, MAGIC)) {
    throw refuse(
      'This is not a Parquet file',
      size < 12 ? 'The file is too short' : 'It lacks the PAR1 marks at its start and end',
    );
  }

  // Byte ranges hyparquet asks for, kept while one row group is read in slices.
  let cache = new Map<string, Promise<ArrayBuffer>>();
  const file: AsyncBuffer = {
    byteLength: size,
    slice(start, end = size) {
      const key = `${start}:${end}`;
      let range = cache.get(key);
      if (range === undefined) {
        range = reader.read(start, end - start).then(toArrayBuffer);
        cache.set(key, range);
      }
      return range;
    },
  };

  let metadata: FileMetaData;
  try {
    metadata = await parquetMetadataAsync(file, { parsers: PARSERS });
  } catch (error) {
    throw corrupt((error as Error).message.replace(/^parquet /, ''));
  }
  cache = new Map();

  const tree = parquetSchema(metadata);
  const leaves = new Set<SchemaElement>();
  const names = headerNames(tree.children.map((child) => child.element.name));
  const columns = tree.children.map((child: SchemaTree, c): FileColumn => {
    const nested = child.children.length > 0;
    if (!nested) leaves.add(child.element);
    return {
      source: child.element.name,
      name: names[c]!,
      nullable: child.element.repetition_type !== 'REQUIRED',
      nested,
      reader: nested
        ? { type: 'json', convert: (raw) => (raw === undefined ? null : jsonText(jsonOf(raw))) }
        : leafReader(child.element),
    };
  });
  // Top-level leaves are read raw and converted here (exact decimals, every timestamp tick);
  // nested columns keep hyparquet's conversions and become JSON.
  const raw: FileMetaData = {
    ...metadata,
    schema: metadata.schema.map((element) =>
      leaves.has(element)
        ? {
            name: element.name,
            ...(element.type !== undefined ? { type: element.type } : {}),
            ...(element.type_length !== undefined ? { type_length: element.type_length } : {}),
            ...(element.repetition_type !== undefined
              ? { repetition_type: element.repetition_type }
              : {}),
          }
        : element,
    ),
  };
  const sources = columns.map((c) => c.source);

  const groupEnds: number[] = [];
  const codecs = new Set<string>();
  for (const group of metadata.row_groups) {
    let end = 0;
    for (const chunk of group.columns) {
      const meta = chunk.meta_data;
      if (meta === undefined) continue;
      codecs.add(meta.codec);
      const start = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
      end = Math.max(end, start + Number(meta.total_compressed_size));
    }
    groupEnds.push(Math.min(end, size));
  }

  return {
    size,
    metadata,
    rows: Number(metadata.num_rows),
    columns,
    ...(metadata.created_by !== undefined ? { createdBy: metadata.created_by } : {}),
    compressions: [...codecs],
    groupEnds,
    close: () => reader.close(),
    focus() {
      cache = new Map();
    },
    async read(start, end) {
      let rows: unknown[][] = [];
      try {
        await parquetRead({
          file,
          metadata: raw,
          columns: sources,
          rowStart: start,
          rowEnd: end,
          utf8: false,
          parsers: PARSERS,
          compressors: DECOMPRESSORS,
          onComplete: (result) => (rows = result),
        });
      } catch (error) {
        if (error instanceof QuerybaraError) throw error;
        const message = (error as Error).message;
        if (/unsupported compression codec/.test(message)) {
          throw refuse(
            `This Parquet file uses a compression Querybara does not read (${message.split(': ').pop()})`,
            'Rewrite it with Snappy, ZSTD, GZIP, Brotli or LZ4',
          );
        }
        throw corrupt(message.replace(/^parquet /, ''));
      }
      const width = columns.length;
      return rows.map((values) => {
        const row = new Array<SourceCell>(width);
        for (let c = 0; c < width; c++) {
          const value = values[c];
          row[c] = value === null || value === undefined ? null : columns[c]!.reader.convert(value);
        }
        return row;
      });
    },
  };
}

/**
 * Rows per read in one row group. Flat columns skip the pages before a slice without decoding
 * them; nested ones cannot, so a file with one is read a whole row group at a time.
 */
function sliceRows(file: ParquetFile): number {
  return file.columns.some((c) => c.nested) ? Infinity : SLICE_ROWS;
}

/**
 * The rows of a Parquet file, a slice at a time. Row numbers are 1-based; `lines` repeats them.
 * `bytesRead` advances through the row groups' data.
 */
export async function* readParquet(
  source: ByteSource,
  decompress: 'auto' | 'gzip' | 'none' = 'auto',
): AsyncGenerator<RowBatch> {
  const file = await openParquet(source, decompress);
  try {
    const names = file.columns.map((c) => c.name);
    const slice = sliceRows(file);
    let groupStart = 0;
    let previousEnd = 0;
    for (let g = 0; g < file.metadata.row_groups.length; g++) {
      const groupRows = Number(file.metadata.row_groups[g]!.num_rows);
      const groupEnd = file.groupEnds[g] ?? previousEnd;
      file.focus();
      for (let at = 0; at < groupRows; at += slice) {
        const count = Math.min(slice, groupRows - at);
        const rows = await file.read(groupStart + at, groupStart + at + count);
        const parts = emptyParts();
        for (let r = 0; r < rows.length; r++) {
          const number = groupStart + at + r + 1;
          parts.rows.push(rows[r]!);
          parts.rowNumbers.push(number);
          parts.lines.push(number);
        }
        const done = (at + count) / groupRows;
        yield toBatch(names, parts, Math.round(previousEnd + (groupEnd - previousEnd) * done));
      }
      groupStart += groupRows;
      previousEnd = Math.max(previousEnd, groupEnd);
    }
    yield toBatch(names, emptyParts(), file.size);
  } finally {
    await file.close();
  }
}

/** The file's columns as the preview and "create a table" see them: types from the schema. */
export function parquetColumns(
  file: ParquetFile,
  sample: readonly InferredColumn[],
): InferredColumn[] {
  return file.columns.map((column, c) => {
    const seen = sample[c];
    const reader = column.reader;
    return {
      name: column.name,
      type: reader.type,
      nullable: column.nullable,
      maxLength: seen?.maxLength ?? 0,
      samples: seen?.samples ?? 0,
      ...(reader.precision !== undefined ? { precision: reader.precision } : {}),
      ...(reader.scale !== undefined ? { scale: reader.scale } : {}),
      ...(reader.fractionalDigits !== undefined
        ? { fractionalDigits: reader.fractionalDigits }
        : {}),
      ...(reader.withTimeZone !== undefined ? { withTimeZone: reader.withTimeZone } : {}),
      ...(reader.type === 'date' || reader.type === 'timestamp'
        ? { dateOrder: 'ymd' as const }
        : {}),
    };
  });
}
