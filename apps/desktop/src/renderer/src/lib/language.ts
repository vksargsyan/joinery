import type { SqlDialect, SqlEngineId, TableDef } from '@querybara/core';
import type { SqlDiagnostic } from '@querybara/sql-tools';
import type { ValidationIssue } from '@querybara/sync';

import LanguageWorker from '../workers/language.worker?worker';
import { LanguageClient, type WorkerLike } from './language-client';

/**
 * The language workers the app shares (spec §6). One language service, run as two instances by
 * role: parsing (the editor's syntax errors and the table designer's expression checks) uses
 * the dialect grammar (seconds on a large script, and 300+ KB of grammar to load), while
 * completion and signature help work on the lexer alone in milliseconds (ADR 0005). On one
 * thread a long parse would hold up every suggestion typed meanwhile; on two it never does, and
 * the completion worker never loads the grammar. Connection snapshots go to the completion
 * worker only.
 */

function startWorker(): WorkerLike {
  return new LanguageWorker() as WorkerLike;
}

/** Autocomplete and signature help. */
export const languageClient = new LanguageClient(startWorker);

const parsingClient = new LanguageClient(startWorker);

/** Syntax errors in `text`, at most one per statement. Never rejects. */
export function syntaxDiagnostics(
  text: string,
  dialect: SqlDialect,
  channel?: string,
): Promise<readonly SqlDiagnostic[]> {
  return parsingClient.diagnose(text, dialect, channel === undefined ? {} : { channel });
}

/** Syntax errors in a designed table's expressions (spec §8). Never rejects. */
export function tableDiagnostics(
  table: TableDef,
  engine: SqlEngineId,
  schema: string,
): Promise<readonly ValidationIssue[]> {
  return parsingClient.diagnoseTable(table, engine, schema);
}
