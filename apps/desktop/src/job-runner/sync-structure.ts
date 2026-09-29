import { writeFile } from 'node:fs/promises';

import { ENGINES, JoineryError } from '@joinery/core';
import type { JobRowError, JobSummary, StructureScript } from '@joinery/ipc';
import {
  compareSchemas,
  generateScript,
  renderHtmlReport,
  summarizeDiff,
  type SchemaDiff,
  type SyncOperation,
} from '@joinery/sync';

import type { StructureApplyJob, StructureCompareJob } from '../shared/sync-jobs';
import {
  bothSides,
  cancelledError,
  checkTargetWrite,
  family,
  firstLine,
  isCancelled,
  plural,
  rollbackQuietly,
  runStatement,
  scopeFor,
  sha256,
  sideInfo,
  sqlDialect,
  type SyncJobContext,
  type SyncJobOutcome,
} from './sync-common';

/**
 * Structure sync in the job runner (spec §13, structure sync pipeline): introspect both sides
 * and diff them, generate the deployment script for a selection, apply it with progress and
 * stop-on-error, and re-compare afterwards. The page only ever sees the results.
 */

/** The diff with exactly these operations selected. */
export function withSelection(diff: SchemaDiff, selected: readonly string[]): SchemaDiff {
  const ids = new Set(selected);
  return {
    ...diff,
    operations: diff.operations.map((op) =>
      op.selected === ids.has(op.id) ? op : { ...op, selected: ids.has(op.id) },
    ),
  };
}

/** The ids of the operations a comparison selects by default (destructive ones are not). */
export function defaultSelection(diff: SchemaDiff): string[] {
  return diff.operations.filter((op) => op.selected).map((op) => op.id);
}

/** The deployment script for a selection, with the hash an apply is checked against. */
export function structureScript(diff: SchemaDiff, selected: readonly string[]): StructureScript {
  const script = generateScript(withSelection(diff, selected));
  return {
    text: script.text,
    statementCount: script.statements.length,
    operationCount: script.operationCount,
    transactional: script.transactional,
    backupRecommended: script.backupRecommended,
    warnings: [...script.warnings],
    missingDependencies: script.missingDependencies.map((m) => ({
      operationId: m.operationId,
      missing: [...m.missing],
    })),
    sha256: sha256(script.text),
  };
}

function countsText(operations: readonly SyncOperation[]): string {
  if (operations.length === 0) return 'No differences';
  const parts: string[] = [];
  for (const kind of ['create', 'alter', 'drop', 'rename'] as const) {
    const count = operations.filter((op) => op.kind === kind).length;
    if (count > 0) parts.push(`${count} ${kind}`);
  }
  return `${plural(operations.length, 'difference')}: ${parts.join(', ')}`;
}

function summary(
  status: JobSummary['status'],
  durationMs: number,
  outcome: string,
  extra: Partial<JobSummary> = {},
): JobSummary {
  return {
    status,
    rowsRead: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    durationMs: Math.round(durationMs),
    outcome: outcome.length > 500 ? `${outcome.slice(0, 499)}…` : outcome,
    ...extra,
  };
}

/** Structure compare (spec §13, steps 1-6): both snapshots, the diff and the default script. */
export async function runStructureCompare(
  job: StructureCompareJob,
  context: SyncJobContext,
): Promise<SyncJobOutcome> {
  const started = performance.now();
  const { source, target } = bothSides(context);
  const sourceDialect = sqlDialect(source);
  const targetDialect = sqlDialect(target);
  if (family(sourceDialect) !== family(targetDialect)) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `Cannot compare the structure of ${ENGINES[source.engine].displayName} with ${ENGINES[target.engine].displayName}`,
      hint: 'Structure sync pairs PostgreSQL with PostgreSQL and MySQL or MariaDB with MySQL or MariaDB.',
    });
  }
  if (source.engine !== target.engine) {
    context.log(
      'warning',
      `${ENGINES[source.engine].displayName} and ${ENGINES[target.engine].displayName} differ in places; the comparison warns where`,
    );
  }
  context.progress({ phase: 'Reading both structures' });
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    source.introspect(scopeFor(job.source, source)),
    target.introspect(scopeFor(job.target, target)),
  ]);
  if (context.signal.aborted) throw cancelledError();
  context.progress({ phase: 'Comparing' });
  const { diff } = compareSchemas(sourceSnapshot, targetSnapshot, job.options);
  const script = structureScript(diff, defaultSelection(diff));
  const outcome = countsText(diff.operations);
  context.log('info', outcome);
  return {
    summary: summary('completed', performance.now() - started, outcome, {
      statements: script.statementCount,
    }),
    errors: [],
    result: {
      kind: 'structure',
      source: sideInfo(context.sourceProfile!, source, sourceSnapshot.database, job.source),
      target: sideInfo(context.targetProfile, target, targetSnapshot.database, job.target),
      diff,
      summary: summarizeDiff(diff),
      sourceSnapshot,
      script,
    },
  };
}

/**
 * Applies a selection (spec §13, steps 7-8): the script is generated again here and must be
 * the one the user reviewed; it runs statement by statement with progress and stops at the
 * first error (PostgreSQL rolls its transaction back; MySQL and MariaDB keep what ran). Then
 * the target is read again and compared with the source structure of the comparison: no
 * applied operation may remain.
 */
export async function runStructureApply(
  job: StructureApplyJob,
  context: SyncJobContext,
): Promise<SyncJobOutcome> {
  const started = performance.now();
  const { target, signal } = context;
  checkTargetWrite(context.targetProfile, job.confirmed);
  const chosen = withSelection(job.diff, job.selected);
  const script = generateScript(chosen);
  if (sha256(script.text) !== job.scriptSha256) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The script is not the one that was reviewed',
      hint: 'Review the script again, then apply it.',
    });
  }
  const statements = script.statements;
  if (statements.length === 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'No selected operation has statements to run',
    });
  }
  const applied = [...new Set(script.steps.flatMap((s) => (s.operationId ? [s.operationId] : [])))];
  const beginAt = script.transactional ? statements.indexOf('BEGIN') : -1;
  context.log(
    'info',
    `Applying ${plural(applied.length, 'operation')} (${plural(statements.length, 'statement')}) to ${job.diff.targetDatabase}${script.transactional ? ' in one transaction' : ''}`,
  );
  if (!script.transactional) {
    context.log(
      'warning',
      `${ENGINES[target.engine].displayName} runs DDL outside transactions: a failed statement leaves the ones before it applied`,
    );
  }
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i]!;
    context.progress({
      phase: `Applying ${i + 1} of ${statements.length}: ${firstLine(sql, 80)}`,
      statements: i,
    });
    try {
      await runStatement(target, sql, signal);
    } catch (error) {
      await rollbackQuietly(target);
      if (isCancelled(error, signal)) throw cancelledError();
      const message = error instanceof Error ? error.message : String(error);
      const rolledBack = script.transactional && beginAt >= 0 && i > beginAt;
      const after = rolledBack
        ? `The transaction was rolled back; the target is unchanged${beginAt > 0 ? `, except ${plural(beginAt, 'statement')} that run before the transaction` : ''}.`
        : `The ${plural(i, 'statement')} before it stay applied.`;
      context.log('error', `Statement ${i + 1} failed: ${message}`);
      context.log('error', after);
      const errors: JobRowError[] = [{ statement: i + 1, message, text: sql.slice(0, 2000) }];
      return {
        summary: summary(
          'failed',
          performance.now() - started,
          `Stopped at statement ${i + 1} of ${statements.length}. ${after}`,
          { statements: i, failed: 1 },
        ),
        errors,
      };
    }
  }
  const durationMs = performance.now() - started;
  context.progress({ phase: 'Comparing again', statements: statements.length });
  const snapshot = await target.introspect(scopeFor(job.target, target));
  const { diff } = compareSchemas(job.sourceSnapshot, snapshot, job.diff.options);
  const appliedIds = new Set(applied);
  const unconverged = diff.operations.filter((op) => appliedIds.has(op.id)).map((op) => op.id);
  const outcome =
    unconverged.length > 0
      ? `Applied ${plural(statements.length, 'statement')}, but ${plural(unconverged.length, 'applied operation')} still differ`
      : diff.operations.length === 0
        ? `Applied ${plural(statements.length, 'statement')}; the target now matches the source`
        : `Applied ${plural(statements.length, 'statement')}; ${plural(diff.operations.length, 'difference')} not selected ${diff.operations.length === 1 ? 'remains' : 'remain'}`;
  context.log(unconverged.length > 0 ? 'error' : 'info', outcome);
  return {
    summary: summary('completed', performance.now() - started, outcome, {
      statements: statements.length,
      failed: 0,
    }),
    errors: [],
    result: {
      kind: 'structure',
      target: sideInfo(context.targetProfile, target, snapshot.database, job.target),
      diff,
      summary: summarizeDiff(diff),
      script: structureScript(diff, defaultSelection(diff)),
      applied: {
        statements: statements.length,
        operations: applied,
        durationMs: Math.round(durationMs),
        unconverged,
      },
    },
  };
}

/** Writes the script or the HTML report of a selection (spec §13: export an HTML report). */
export async function exportStructure(input: {
  readonly diff: SchemaDiff;
  readonly selected: readonly string[];
  readonly format: 'sql' | 'html';
  readonly path: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly generatedAt: string;
}): Promise<{ bytes: number }> {
  const chosen = withSelection(input.diff, input.selected);
  const script = generateScript(chosen);
  const text =
    input.format === 'sql'
      ? script.text
      : renderHtmlReport(chosen, {
          sourceLabel: input.sourceLabel,
          targetLabel: input.targetLabel,
          script,
          generatedAt: input.generatedAt,
        });
  const bytes = Buffer.from(text, 'utf8');
  await writeFile(input.path, bytes);
  return { bytes: bytes.length };
}
