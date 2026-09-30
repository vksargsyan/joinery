import {
  isSqlEngine,
  requiresWriteConfirmation,
  type CellValue,
  type SqlDialect,
} from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { create } from 'zustand';

import type { ExportSource } from './export-wizard';
import type { ImportTarget } from './import-wizard';

/**
 * Which transfer dialog is open: the import wizard, the export wizard or Run SQL File. The
 * explorer and the result tabs open them; the window renders whichever is set.
 */

export interface RunSqlFileTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly dialect: SqlDialect;
  /** The database the statements run in; the connection's default when absent. */
  readonly database: string | undefined;
  readonly readOnly: boolean;
  readonly production: boolean;
  readonly confirmWrites: boolean;
}

export type TransferDialog =
  | { readonly kind: 'import'; readonly target: ImportTarget }
  | {
      readonly kind: 'export';
      readonly source: ExportSource;
      readonly tablesPath?: readonly string[];
    }
  | { readonly kind: 'run-sql-file'; readonly target: RunSqlFileTarget };

interface TransferDialogsState {
  readonly dialog: TransferDialog | undefined;
}

export const useTransferDialogs = create<TransferDialogsState>()(() => ({ dialog: undefined }));

export function closeTransferDialog(): void {
  useTransferDialogs.setState({ dialog: undefined });
}

function writeRules(profile: StoredProfile) {
  return {
    readOnly: profile.presentation.readOnly,
    production: profile.presentation.environment === 'production',
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

/**
 * Opens the import wizard for a table (`table`), or for a new table in a schema or database
 * (`table: null`).
 */
export function openImportWizard(
  profile: StoredProfile,
  location: { readonly database: string | undefined; readonly schema: string },
  table: string | null,
): void {
  if (!isSqlEngine(profile.engine)) return;
  useTransferDialogs.setState({
    dialog: {
      kind: 'import',
      target: {
        profileId: profile.id,
        profileName: profile.name,
        dialect: profile.engine,
        database: location.database,
        schema: location.schema,
        table,
        ...writeRules(profile),
      },
    },
  });
}

/**
 * Opens the export wizard on tables of one schema (the explorer), with `tables` selected and
 * the rest of `tablesPath`'s tables offered.
 */
export function openExportTables(
  profile: StoredProfile,
  location: { readonly database: string | undefined; readonly schema: string },
  tables: readonly string[],
  tablesPath?: readonly string[],
): void {
  if (!isSqlEngine(profile.engine)) return;
  useTransferDialogs.setState({
    dialog: {
      kind: 'export',
      source: {
        kind: 'tables',
        profileId: profile.id,
        profileName: profile.name,
        dialect: profile.engine,
        database: location.database,
        schema: location.schema,
        tables,
      },
      ...(tablesPath ? { tablesPath } : {}),
    },
  });
}

/** Opens the export wizard on a query result, which the job runner runs again. */
export function openExportQuery(
  profile: StoredProfile,
  query: { readonly text: string; readonly params?: readonly CellValue[] },
): void {
  if (!isSqlEngine(profile.engine)) return;
  useTransferDialogs.setState({
    dialog: {
      kind: 'export',
      source: {
        kind: 'query',
        profileId: profile.id,
        profileName: profile.name,
        dialect: profile.engine,
        database: undefined,
        text: query.text,
        ...(query.params !== undefined ? { params: query.params } : {}),
      },
    },
  });
}

/** Opens Run SQL File for a connection, or one of its databases. */
export function openRunSqlFile(profile: StoredProfile, database?: string): void {
  if (!isSqlEngine(profile.engine)) return;
  useTransferDialogs.setState({
    dialog: {
      kind: 'run-sql-file',
      target: {
        profileId: profile.id,
        profileName: profile.name,
        dialect: profile.engine,
        database,
        ...writeRules(profile),
      },
    },
  });
}
