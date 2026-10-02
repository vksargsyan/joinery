import { isJsonText, type SourceCell, type SourceRow } from './types';

/**
 * Column type inference for previews and "create a new table from the file" (spec §12). Each
 * value narrows the set of types the column can still have; the most specific survivor wins,
 * in the order of INFERRED_TYPES. Text is classified the same way whether it came from CSV or
 * from a JSON string, so exported files re-infer the types they were written from. `time` and
 * `binary` come only from typed sources (Parquet's schema), never from text.
 */

export const INFERRED_TYPES = [
  'boolean',
  'integer',
  'bigint',
  'decimal',
  'float',
  'date',
  'timestamp',
  'uuid',
  'json',
  'time',
  'binary',
  'text',
] as const;
export type InferredType = (typeof INFERRED_TYPES)[number];

/** How a date is written: ISO year-month-day, or day/month/year or month/day/year. */
export const DATE_ORDERS = ['ymd', 'dmy', 'mdy'] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

export interface InferredColumn {
  readonly name: string;
  readonly type: InferredType;
  /** A null or empty value was seen. */
  readonly nullable: boolean;
  /** Longest value as text, in UTF-16 code units. */
  readonly maxLength: number;
  /** Values seen that were not null or empty. */
  readonly samples: number;
  /** decimal: total and fractional digits needed. */
  readonly precision?: number;
  readonly scale?: number;
  /** timestamp: most fractional-second digits seen. */
  readonly fractionalDigits?: number;
  /** timestamp: some value carries a UTC offset or Z. */
  readonly withTimeZone?: boolean;
  /** date and timestamp: how the date part is written. */
  readonly dateOrder?: DateOrder;
}

const BOOL = 1 << 0;
const INT = 1 << 1;
const BIGINT = 1 << 2;
const DEC = 1 << 3;
const FLOAT = 1 << 4;
const DATE = 1 << 5;
const TS = 1 << 6;
const UUID = 1 << 7;
const JSON_ = 1 << 8;
const ALL = (1 << 9) - 1;

const ORDER_YMD = 1;
const ORDER_DMY = 2;
const ORDER_MDY = 4;

const INTEGER_RE = /^[+-]?(?:0|[1-9]\d*)$/;
const DECIMAL_RE = /^[+-]?(?:\d+\.\d+|\.\d+|\d+\.)$/;
const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;
const SPECIAL_FLOAT_RE = /^[+-]?(?:nan|inf|infinity)$/i;
const BOOL_RE = /^(?:true|false|t|f|yes|no)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const TIME_PART = String.raw`(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?`;
const ISO_TS_RE = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})[T ]${TIME_PART}$`, 'i');
const SLASH_TS_RE = new RegExp(
  String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[T ]${TIME_PART}$`,
  'i',
);

const INT32_MAX = 2147483647n;
const INT64_MAX = 9223372036854775807n;

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Date orders a d/m/y-or-m/d/y date allows. */
function slashOrders(a: number, b: number, year: number): number {
  let orders = 0;
  if (validDay(year, b, a)) orders |= ORDER_DMY;
  if (validDay(year, a, b)) orders |= ORDER_MDY;
  return orders;
}

/** What one text value allows. */
interface Classified {
  mask: number;
  orders?: number;
  intDigits?: number;
  scale?: number;
  fraction?: number;
  zone?: boolean;
}

function digitsOf(text: string): { intDigits: number; scale: number } {
  const unsigned = text.replace(/^[+-]/, '');
  const dot = unsigned.indexOf('.');
  const intPart = (dot < 0 ? unsigned : unsigned.slice(0, dot)).replace(/^0+/, '');
  return { intDigits: intPart.length, scale: dot < 0 ? 0 : unsigned.length - dot - 1 };
}

function classifyInteger(text: string): Classified {
  const big = BigInt(text);
  const abs = big < 0n ? -big : big;
  const { intDigits } = digitsOf(text);
  if (abs <= INT32_MAX) return { mask: INT | BIGINT | DEC | FLOAT, intDigits, scale: 0 };
  if (abs <= INT64_MAX) {
    const safe = abs <= BigInt(Number.MAX_SAFE_INTEGER);
    return { mask: BIGINT | DEC | (safe ? FLOAT : 0), intDigits, scale: 0 };
  }
  return { mask: intDigits <= 65 ? DEC : 0, intDigits, scale: 0 };
}

/** Classifies trimmed, non-empty text. */
export function classifyText(text: string): Classified {
  if (INTEGER_RE.test(text)) return classifyInteger(text);
  if (DECIMAL_RE.test(text)) {
    const { intDigits, scale } = digitsOf(text);
    return { mask: (intDigits + scale <= 65 && scale <= 30 ? DEC : 0) | FLOAT, intDigits, scale };
  }
  if (FLOAT_RE.test(text) || SPECIAL_FLOAT_RE.test(text)) return { mask: FLOAT };
  if (BOOL_RE.test(text)) return { mask: BOOL };
  const first = text.charCodeAt(0);
  if (first >= 48 && first <= 57) {
    let m = ISO_DATE_RE.exec(text);
    if (m) {
      const ok = validDay(Number(m[1]), Number(m[2]), Number(m[3]));
      return ok ? { mask: DATE | TS, orders: ORDER_YMD } : { mask: 0 };
    }
    m = SLASH_DATE_RE.exec(text);
    if (m) {
      const orders = slashOrders(Number(m[1]), Number(m[2]), Number(m[3]));
      return orders === 0 ? { mask: 0 } : { mask: DATE | TS, orders };
    }
    m = ISO_TS_RE.exec(text);
    if (m) {
      const ok = validDay(Number(m[1]), Number(m[2]), Number(m[3])) && validTime(m, 4);
      if (!ok) return { mask: 0 };
      return { mask: TS, orders: ORDER_YMD, fraction: m[7]?.length ?? 0, zone: m[8] !== undefined };
    }
    m = SLASH_TS_RE.exec(text);
    if (m) {
      const orders = slashOrders(Number(m[1]), Number(m[2]), Number(m[3]));
      if (orders === 0 || !validTime(m, 4)) return { mask: 0 };
      return { mask: TS, orders, fraction: m[7]?.length ?? 0, zone: m[8] !== undefined };
    }
  }
  if (text.length === 36 && UUID_RE.test(text)) return { mask: UUID };
  if ((first === 123 || first === 91) && isJson(text)) return { mask: JSON_ };
  return { mask: 0 };
}

function validTime(m: RegExpExecArray, at: number): boolean {
  const hour = Number(m[at]);
  const minute = Number(m[at + 1]);
  const second = m[at + 2] === undefined ? 0 : Number(m[at + 2]);
  return hour <= 24 && minute <= 59 && second <= 60;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Accumulates one column's values; `result` gives the inferred type. */
export class ColumnInference {
  private mask = ALL;
  private orders = ORDER_YMD | ORDER_DMY | ORDER_MDY;
  private nullable = false;
  private maxLength = 0;
  private samples = 0;
  private intDigits = 0;
  private scale = 0;
  private fraction = 0;
  private zone = false;

  add(value: SourceCell | undefined): void {
    if (value === null || value === undefined) {
      this.nullable = true;
      return;
    }
    let classified: Classified;
    let length: number;
    if (typeof value === 'string') {
      length = value.length;
      const text = value.trim();
      if (text === '') {
        this.nullable = true;
        this.maxLength = Math.max(this.maxLength, length);
        return;
      }
      classified = classifyText(text);
    } else if (typeof value === 'boolean') {
      length = value ? 4 : 5;
      classified = { mask: BOOL };
    } else if (typeof value === 'number') {
      const text = String(value);
      length = text.length;
      classified = Number.isFinite(value) ? classifyText(text) : { mask: FLOAT };
    } else if (typeof value === 'bigint') {
      const text = value.toString();
      length = text.length;
      classified = classifyInteger(text);
    } else if (isJsonText(value)) {
      const text = value.$json;
      length = text.length;
      const first = text.charCodeAt(0);
      classified = first === 123 || first === 91 ? { mask: JSON_ } : classifyText(text);
    } else {
      return;
    }
    this.samples++;
    this.maxLength = Math.max(this.maxLength, length);
    this.mask &= classified.mask;
    if (classified.orders !== undefined) {
      this.orders &= classified.orders;
      if (this.orders === 0) this.mask &= ~(DATE | TS);
    }
    if (classified.intDigits !== undefined)
      this.intDigits = Math.max(this.intDigits, classified.intDigits);
    if (classified.scale !== undefined) this.scale = Math.max(this.scale, classified.scale);
    if (classified.fraction !== undefined)
      this.fraction = Math.max(this.fraction, classified.fraction);
    if (classified.zone === true) this.zone = true;
  }

  result(name: string): InferredColumn {
    const base = {
      name,
      nullable: this.nullable,
      maxLength: this.maxLength,
      samples: this.samples,
    };
    if (this.samples === 0) return { ...base, type: 'text' };
    const mask = this.mask;
    const order: DateOrder =
      this.orders & ORDER_YMD ? 'ymd' : this.orders & ORDER_DMY ? 'dmy' : 'mdy';
    if (mask & BOOL) return { ...base, type: 'boolean' };
    if (mask & INT) return { ...base, type: 'integer' };
    if (mask & BIGINT) return { ...base, type: 'bigint' };
    if (mask & DEC) {
      return {
        ...base,
        type: 'decimal',
        precision: Math.max(1, this.intDigits + this.scale),
        scale: this.scale,
      };
    }
    if (mask & FLOAT) return { ...base, type: 'float' };
    if (mask & DATE) return { ...base, type: 'date', dateOrder: order };
    if (mask & TS) {
      return {
        ...base,
        type: 'timestamp',
        dateOrder: order,
        fractionalDigits: Math.min(this.fraction, 6),
        withTimeZone: this.zone,
      };
    }
    if (mask & UUID) return { ...base, type: 'uuid' };
    if (mask & JSON_) return { ...base, type: 'json' };
    return { ...base, type: 'text' };
  }
}

/** Infers every column of a sample. */
export function inferColumns(
  columns: readonly string[],
  rows: readonly SourceRow[],
): InferredColumn[] {
  const inference = columns.map(() => new ColumnInference());
  for (const row of rows) {
    for (let c = 0; c < inference.length; c++) inference[c]!.add(row[c] ?? null);
  }
  return inference.map((column, c) => column.result(columns[c]!));
}

/** Whether a value fits a type, for header detection (does the first row look like data?). */
export function fitsType(value: SourceCell | undefined, type: InferredType): boolean {
  if (type === 'text') return true;
  const inference = new ColumnInference();
  inference.add(value ?? null);
  const result = inference.result('');
  if (result.samples === 0) return true;
  if (result.type === type) return true;
  const widening: Readonly<Record<string, readonly InferredType[]>> = {
    integer: ['bigint', 'decimal', 'float'],
    bigint: ['decimal', 'float'],
    decimal: ['float'],
    date: ['timestamp'],
  };
  return widening[result.type]?.includes(type) === true;
}
