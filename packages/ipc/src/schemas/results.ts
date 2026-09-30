import {
  COLUMN_KINDS,
  DEFAULT_PAGE_SIZE,
  NOTICE_SEVERITIES,
  type CellValue,
  type ColumnKind,
  type ColumnMeta,
  type LargeValueHandle,
  type QueryParams,
  type ResultChunk,
} from '@joinery/core';
import { z } from 'zod';

/**
 * Zod schemas for the result types in @joinery/core (results.ts). Each schema is annotated with
 * the core type as both its input and output, which checks at compile time that the schema
 * produces the core type, and lets handlers return core values (readonly arrays included).
 */

export const columnKindSchema: z.ZodType<ColumnKind, ColumnKind> = z.enum(COLUMN_KINDS);

export const columnMetaSchema: z.ZodType<ColumnMeta, ColumnMeta> = z.object({
  name: z.string(),
  nativeType: z.string(),
  kind: columnKindSchema,
  nullable: z.boolean().optional(),
  table: z.string().optional(),
  schema: z.string().optional(),
});

function isLargeValueHandle(value: object): value is LargeValueHandle {
  return (
    '$handle' in value &&
    typeof value.$handle === 'string' &&
    'preview' in value &&
    typeof value.preview === 'string' &&
    'byteLength' in value &&
    typeof value.byteLength === 'number' &&
    'kind' in value &&
    (value.kind === 'text' || value.kind === 'binary')
  );
}

/**
 * True for every CellValue kind: null, boolean, number (NaN and ±Infinity included: float
 * columns hold them), bigint, string, Uint8Array and LargeValueHandle.
 */
export function isCellValue(value: unknown): value is CellValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return true;
    case 'object':
      return value === null || value instanceof Uint8Array || isLargeValueHandle(value);
    default:
      return false;
  }
}

export const largeValueHandleSchema: z.ZodType<LargeValueHandle, LargeValueHandle> = z.object({
  $handle: z.string().min(1),
  preview: z.string(),
  byteLength: z.number().int().nonnegative(),
  kind: z.enum(['text', 'binary']),
});

/**
 * One cell. A type guard rather than a union of zod schemas: it runs once per cell of every
 * result chunk, and z.number() would reject the NaN and Infinity that float columns can hold.
 */
export const cellValueSchema: z.ZodType<CellValue, CellValue> = z.custom<CellValue>(
  isCellValue,
  'Expected a cell value (null, boolean, number, bigint, string, Uint8Array or value handle)',
);

export const queryParamsSchema: z.ZodType<QueryParams, QueryParams> = z.union([
  z.array(cellValueSchema),
  z.record(z.string(), cellValueSchema),
]);

const resultIndexSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();

/**
 * The `rows` chunk. `data` is checked by one loop over the columns and cells instead of nested
 * zod arrays: zod would rebuild every column array and run a union per cell, while the loop
 * allocates nothing and returns the chunk's own arrays.
 *
 * Measured on Node 22.22 (x64 Linux container), a 1,000-row × 50-column chunk of mixed cells
 * (numbers, strings, booleans, null, bigint, Uint8Array), validating the whole ResultChunk, median
 * of 30 runs:
 * - this schema: 0.26 ms per chunk (about 5 ns per cell), no allocation;
 * - z.array(z.array(z.union([...cell kinds]))): 8.2 ms per chunk, plus a full copy;
 * - for scale, structuredClone of the same chunk: 10.5 ms.
 * So validating on both ends adds about 5% to what the port transfer itself costs.
 * test/chunk-validation.test.ts re-measures this and prints the figures.
 */
const rowsChunkSchema = z
  .object({
    type: z.literal('rows'),
    resultIndex: resultIndexSchema,
    rowCount: countSchema,
    data: z.custom<CellValue[][]>(Array.isArray, 'Expected an array of columns'),
  })
  .superRefine((chunk, ctx) => {
    const { data, rowCount } = chunk;
    for (let c = 0; c < data.length; c++) {
      const column: unknown = data[c];
      if (!Array.isArray(column)) {
        ctx.addIssue({ code: 'custom', path: ['data', c], message: 'Expected a column array' });
        return;
      }
      if (column.length !== rowCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', c],
          message: `Expected ${rowCount} cells, got ${column.length}`,
        });
        return;
      }
      for (let r = 0; r < rowCount; r++) {
        if (!isCellValue(column[r])) {
          ctx.addIssue({ code: 'custom', path: ['data', c, r], message: 'Expected a cell value' });
          return;
        }
      }
    }
  });

export const resultChunkSchema: z.ZodType<ResultChunk, ResultChunk> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('columns'),
    resultIndex: resultIndexSchema,
    columns: z.array(columnMetaSchema),
  }),
  rowsChunkSchema,
  z.object({
    type: z.literal('status'),
    command: z.string().nullable(),
    rowsAffected: countSchema.nullable(),
    lastInsertId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('notice'),
    severity: z.enum(NOTICE_SEVERITIES),
    message: z.string(),
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal('end'),
    durationMs: z.number().nonnegative(),
    rowCount: countSchema,
  }),
]);

/** Rows per chunk a caller may ask for; the spec caps chunks at 1,000 rows. */
export const pageSizeSchema = z.number().int().min(1).max(DEFAULT_PAGE_SIZE);
