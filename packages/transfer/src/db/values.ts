import type { CellValue, SqlDialect } from '@querybara/core';

import { ConversionError, targetKind } from '../mapping';
import type { SourceCell } from '../types';

/**
 * Cell adapters between a SQL source and a SQL target. A source cell arrives as the driver
 * returns it (@querybara/core CellValue conventions) and leaves as a cell the import pipeline's
 * per-column converter (`converterFor`) turns into what the target column takes. The adapter
 * only bridges what that converter reads differently from a file: bytes travel as `\x` hex
 * text (which it decodes back), integers into booleans compare with zero, MySQL zero dates
 * become NULL, and a PostgreSQL time's UTC offset is dropped for MySQL.
 */

/** Adapts one source cell for the target column's converter. */
export type CellAdapter = (value: CellValue) => SourceCell;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** `\x0102...`, the form `converterFor` reads for binary columns. */
export function hexText(bytes: Uint8Array): string {
  let out = '\\x';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

const encoder = new TextEncoder();

function passThrough(value: CellValue): SourceCell {
  if (value === null) return null;
  if (value instanceof Uint8Array) return hexText(value);
  if (typeof value === 'object') {
    throw new ConversionError('A large value was only previewed and cannot be copied');
  }
  return value;
}

const ZERO_DATE = /^0000-00-00/;
const TIME_OFFSET = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * The adapter for one column: `sourceType` in `from` (as its snapshot prints it) going into a
 * `targetType` column in `to`.
 */
export function sqlCellAdapter(
  from: SqlDialect,
  sourceType: string,
  to: SqlDialect,
  targetType: string,
): CellAdapter {
  const source = targetKind(sourceType, from);
  const target = targetKind(targetType, to);
  // MySQL's zero dates have no PostgreSQL value; between MySQL servers they stay.
  const zeroDates =
    from !== 'postgres' &&
    to === 'postgres' &&
    (source === 'date' || source === 'datetime' || source === 'timestamp');
  if (target === 'boolean') {
    return (value) =>
      typeof value === 'number'
        ? value !== 0
        : typeof value === 'bigint'
          ? value !== 0n
          : passThrough(value);
  }
  if (target === 'binary') {
    return (value) =>
      typeof value === 'string' ? hexText(encoder.encode(value)) : passThrough(value);
  }
  if (target === 'time' && to !== 'postgres') {
    return (value) =>
      typeof value === 'string' ? value.trim().replace(TIME_OFFSET, '') : passThrough(value);
  }
  if (zeroDates) {
    return (value) =>
      typeof value === 'string' && ZERO_DATE.test(value) ? null : passThrough(value);
  }
  return passThrough;
}
