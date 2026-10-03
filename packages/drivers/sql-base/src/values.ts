import { QuerybaraError, type CellValue, type LargeValueHandle } from '@querybara/core';

/**
 * An integer from its decimal text: a number when it fits in 2^53, a bigint otherwise
 * (CellValue convention).
 */
export function parseInteger(text: string): number | bigint {
  const n = Number(text);
  if (Number.isSafeInteger(n)) return n;
  return BigInt(text);
}

/** A standalone copy of binary data, so no driver buffer pool travels with the cell. */
export function toBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

/**
 * Checks positional query parameters. Named parameters (an object) are not supported by the
 * SQL drivers, and large-value handles are never sent back to the server.
 */
export function positionalParams(
  params: readonly CellValue[] | Readonly<Record<string, CellValue>> | undefined,
): readonly Exclude<CellValue, LargeValueHandle>[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'Named parameters are not supported here; pass the values as an array',
      hint: 'Use positional placeholders ($1 for PostgreSQL, ? for MySQL and MariaDB)',
    });
  }
  return params.map((value: CellValue, index): Exclude<CellValue, LargeValueHandle> => {
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `Parameter ${index + 1} is a large-value handle; fetch the full value first`,
      });
    }
    return value;
  });
}
