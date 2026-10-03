import { SQL_ENGINE_IDS, type CellValue, type SqlDialect } from '@querybara/core';
import { z } from 'zod';

import { cellValueSchema } from './results';

/**
 * Zod schemas for the table data grid's Apply (spec §7): the change plan the renderer builds
 * with `planChanges` from @querybara/table-data, and what `applyChanges` reports back. The types
 * are declared here rather than imported, so this package stays independent of the engine; they
 * mirror `ChangePlan` and `ApplyResult` exactly, and the desktop app passes one for the other,
 * which fails to compile if the two drift.
 */

/** How the plan finds rows again: primary key, unique key or every column. */
export interface ApplyRowIdentity {
  readonly kind: 'primary-key' | 'unique' | 'all-columns' | 'none';
  readonly columns: readonly string[];
  readonly name?: string;
  readonly warning?: string;
  readonly unreliable?: readonly { readonly column: string; readonly reason: string }[];
}

/** One parameterised statement with its positional parameters. */
export interface ApplySqlQuery {
  readonly sql: string;
  readonly params: readonly CellValue[];
}

/** One statement of the plan: one row's delete, update or insert. */
export interface ApplyStatement extends ApplySqlQuery {
  readonly kind: 'delete' | 'update' | 'insert';
  readonly key: string;
  readonly label: string;
  readonly preview: string;
  readonly returnsRow: boolean;
  readonly readBack?: ApplySqlQuery;
  readonly knownValues: Readonly<Record<string, CellValue>>;
}

/** The statements Apply runs in one transaction. */
export interface ApplyPlan {
  readonly dialect: SqlDialect;
  readonly table: { readonly schema?: string; readonly name: string };
  readonly identity: ApplyRowIdentity;
  readonly columns: readonly string[];
  readonly statements: readonly ApplyStatement[];
  readonly previewSql: string;
}

/** One row as written, in the plan's column order. */
export interface AppliedRowData {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly key: string;
  readonly newKey?: string;
  readonly row: readonly CellValue[] | null;
}

export interface ApplyResultData {
  readonly rows: readonly AppliedRowData[];
}

const sqlQuerySchema: z.ZodType<ApplySqlQuery, ApplySqlQuery> = z.object({
  sql: z.string().min(1),
  params: z.array(cellValueSchema),
});

export const applyRowIdentitySchema: z.ZodType<ApplyRowIdentity, ApplyRowIdentity> = z.object({
  kind: z.enum(['primary-key', 'unique', 'all-columns', 'none']),
  columns: z.array(z.string()),
  name: z.string().optional(),
  warning: z.string().optional(),
  unreliable: z.array(z.object({ column: z.string(), reason: z.string() })).optional(),
});

const applyStatementSchema: z.ZodType<ApplyStatement, ApplyStatement> = z.object({
  kind: z.enum(['delete', 'update', 'insert']),
  key: z.string().min(1),
  label: z.string(),
  sql: z.string().min(1),
  params: z.array(cellValueSchema),
  preview: z.string(),
  returnsRow: z.boolean(),
  readBack: sqlQuerySchema.optional(),
  knownValues: z.record(z.string(), cellValueSchema),
});

export const applyPlanSchema: z.ZodType<ApplyPlan, ApplyPlan> = z.object({
  dialect: z.enum(SQL_ENGINE_IDS),
  table: z.object({ schema: z.string().optional(), name: z.string().min(1) }),
  identity: applyRowIdentitySchema,
  columns: z.array(z.string()),
  statements: z.array(applyStatementSchema),
  previewSql: z.string(),
});

export const applyResultSchema: z.ZodType<ApplyResultData, ApplyResultData> = z.object({
  rows: z.array(
    z.object({
      kind: z.enum(['insert', 'update', 'delete']),
      key: z.string(),
      newKey: z.string().optional(),
      row: z.array(cellValueSchema).nullable(),
    }),
  ),
});
