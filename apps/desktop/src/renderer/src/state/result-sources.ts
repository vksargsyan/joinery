import type { CellValue } from '@joinery/core';

/**
 * The statement behind each query result (its text and bound values), so "Export results…"
 * can run it again in the job runner (spec §12) instead of exporting only the rows loaded into
 * the grid. Keyed like the result views: `${runId}:${statementIndex}`.
 */

export interface ResultSource {
  readonly text: string;
  readonly params: readonly CellValue[];
}

const MAX_SOURCES = 500;
const sources = new Map<string, ResultSource>();

/** Remembers the statement a run executed; the oldest are forgotten past a few hundred. */
export function rememberResultSource(
  runId: string,
  statementIndex: number,
  text: string,
  params: readonly CellValue[],
): void {
  const key = `${runId}:${statementIndex}`;
  sources.delete(key);
  sources.set(key, { text, params });
  while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value!);
}

/** The statement behind a result view (`${runId}:${statementIndex}:${resultIndex}`). */
export function resultSource(resultId: string): ResultSource | undefined {
  return sources.get(resultId.split(':').slice(0, 2).join(':'));
}
