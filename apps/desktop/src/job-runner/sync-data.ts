import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  ENGINES,
  QuerybaraError,
  type CellValue,
  type ColumnKind,
  type ColumnMeta,
  type SqlDialect,
} from '@querybara/core';
import type {
  DataActions,
  DataRowAction,
  DataRowDiff,
  DataTableResult,
  JobRowError,
  JobSummary,
} from '@querybara/ipc';
import {
  DataSyncScriptBuilder,
  columnIndex,
  compareTableData,
  dataSyncOrder,
  pairDataTables,
  type CanonicalOptions,
  type DataSyncOptions,
  type DataTablePair,
  type RowDiff,
  type TableRef,
  type TablePair,
} from '@querybara/sync';
import { formatCell } from '@querybara/table-data';

import type { DataApplyJob, DataCompareJob } from '../shared/sync-jobs';
import {
  MANIFEST_FILE,
  SPOOL_MAX_CELL,
  SPOOL_MAX_ROWS,
  SPOOL_PAGE_SIZE,
  rowPageFile,
  spoolManifestSchema,
  statementsFile,
  type SpoolManifest,
  type SpoolTable,
} from '../shared/sync-spool';
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
  sideInfo,
  sqlDialect,
  type SyncJobContext,
  type SyncJobOutcome,
} from './sync-common';

/**
 * Data sync in the job runner (spec §13, data sync algorithm): pair the tables, compare each
 * with server-side range checksums (`compareTableData`), and spool what differs into the folder
 * main made for the job: row pages for the grid, and every sync statement per action, so the
 * diff never sits in memory. Applying and writing the script read the statements back and run
 * them in batched transactions: deletes first, child tables before their parents, then updates
 * and inserts, parents first.
 */

const ACTIONS: readonly DataRowAction[] = ['insert', 'update', 'delete'];
const BATCH_ROWS = 500;

function display(value: CellValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = formatCell(value);
  return text.length > SPOOL_MAX_CELL ? `${text.slice(0, SPOOL_MAX_CELL)}…` : text;
}

function perAction<T>(make: (action: DataRowAction) => T): Record<DataRowAction, T> {
  return { insert: make('insert'), update: make('update'), delete: make('delete') };
}

/** The row layout `compareTableData` streams: the key columns, then the compared ones. */
interface RowLayout {
  readonly sourceColumns: string[];
  readonly targetColumns: string[];
  readonly targetKinds: Record<string, ColumnKind>;
  readonly compared: string[];
}

function rowLayout(
  keyColumns: readonly string[],
  sourceMeta: readonly ColumnMeta[],
  targetMeta: readonly ColumnMeta[],
  compared: readonly string[],
): RowLayout {
  const sourceNames = sourceMeta.map((c) => c.name);
  const targetNames = targetMeta.map((c) => c.name);
  const wanted = [...keyColumns, ...compared];
  const targetKinds: Record<string, ColumnKind> = {};
  for (const meta of targetMeta) targetKinds[meta.name] = meta.kind;
  return {
    sourceColumns: wanted.map((c) => sourceNames[columnIndex(sourceNames, c)] ?? c),
    targetColumns: wanted.map((c) => targetNames[columnIndex(targetNames, c)] ?? c),
    targetKinds,
    compared: [...compared],
  };
}

/** What a statement builder needs to know about a table. */
interface BuilderTable {
  readonly target: TableRef;
  readonly keyColumns: readonly string[];
  readonly sourceColumns: readonly string[];
  readonly targetColumns: readonly string[];
  readonly targetKinds: Readonly<Record<string, ColumnKind>>;
}

function builderOptions(
  dialect: SqlDialect,
  table: BuilderTable,
  extra: Partial<DataSyncOptions> = {},
): DataSyncOptions {
  return {
    dialect,
    table: table.target,
    keyColumns: table.targetColumns.slice(0, table.keyColumns.length),
    sourceColumns: table.sourceColumns,
    targetColumns: table.targetColumns,
    targetKinds: table.targetKinds,
    batchSize: BATCH_ROWS,
    ...extra,
  };
}

/** Appends lines to a file, waiting for the stream to drain. */
class LineWriter {
  readonly #stream: WriteStream;

  constructor(path: string) {
    this.#stream = createWriteStream(path);
  }

  async write(line: string): Promise<void> {
    if (!this.#stream.write(`${line}\n`)) {
      await new Promise<void>((resolve) => this.#stream.once('drain', resolve));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#stream.once('error', reject);
      this.#stream.end(() => resolve());
    });
  }

  destroy(): void {
    this.#stream.destroy();
  }
}

/** One table's spool: row pages for the grid and sync statements per action. */
class TableSpool {
  readonly statements = perAction(() => 0);
  readonly stored = perAction(() => 0);
  readonly #builders: Record<DataRowAction, DataSyncScriptBuilder>;
  readonly #files: Record<DataRowAction, LineWriter>;
  readonly #pages = perAction((): DataRowDiff[] => []);
  readonly #pageNumbers = perAction(() => 0);

  constructor(
    private readonly dir: string,
    private readonly index: number,
    options: DataSyncOptions,
  ) {
    this.#builders = perAction(
      (action) =>
        new DataSyncScriptBuilder({
          ...options,
          actions: {
            insert: action === 'insert',
            update: action === 'update',
            delete: action === 'delete',
          },
        }),
    );
    this.#files = perAction((action) => new LineWriter(join(dir, statementsFile(index, action))));
  }

  async add(diff: RowDiff): Promise<void> {
    const action = diff.action;
    for (const sql of this.#builders[action].add(diff)) await this.#statement(action, sql);
    if (this.stored[action] >= SPOOL_MAX_ROWS) return;
    this.stored[action]++;
    this.#pages[action].push({
      action,
      key: diff.key.map(display),
      ...(diff.sourceRow ? { source: diff.sourceRow.map(display) } : {}),
      ...(diff.targetRow ? { target: diff.targetRow.map(display) } : {}),
      // Changed columns are named as the source names them, like the grid's columns.
      ...(diff.changedColumns ? { changed: [...diff.changedColumns] } : {}),
    });
    if (this.#pages[action].length >= SPOOL_PAGE_SIZE) await this.#flushPage(action);
  }

  async finish(): Promise<void> {
    for (const action of ACTIONS) {
      for (const sql of this.#builders[action].flush()) await this.#statement(action, sql);
      await this.#flushPage(action);
      await this.#files[action].close();
    }
  }

  destroy(): void {
    for (const action of ACTIONS) this.#files[action].destroy();
  }

  async #statement(action: DataRowAction, sql: string): Promise<void> {
    this.statements[action]++;
    await this.#files[action].write(JSON.stringify(sql));
  }

  async #flushPage(action: DataRowAction): Promise<void> {
    const rows = this.#pages[action].splice(0);
    if (rows.length === 0) return;
    const page = this.#pageNumbers[action]++;
    await writeFile(join(this.dir, rowPageFile(this.index, action, page)), JSON.stringify(rows));
  }
}

function canonicalOptions(job: DataCompareJob): CanonicalOptions {
  const { options } = job;
  return {
    ...(options.floatTolerance !== undefined ? { floatTolerance: options.floatTolerance } : {}),
    ...(options.trim !== undefined ? { trim: options.trim } : {}),
    ...(options.caseInsensitive === true ? { caseInsensitive: true } : {}),
  };
}

function tablePair(pair: DataTablePair, job: DataCompareJob): TablePair {
  const settings = job.tables?.find((t) => t.name === pair.name);
  const common = new Set(pair.commonColumns.map((c) => c.toLowerCase()));
  const columns = settings?.columns?.filter((c) => common.has(c.toLowerCase()));
  return {
    source: pair.source,
    target: pair.target,
    keyColumns: pair.keyColumns,
    ...(columns !== undefined ? { columns } : {}),
    ...(job.options.ignoreColumns !== undefined && job.options.ignoreColumns.length > 0
      ? { ignoreColumns: job.options.ignoreColumns }
      : {}),
  };
}

function dataSummary(
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

/**
 * Compares the data of every paired table (spec §13, data sync steps 1-6) and spools the
 * differences. A table whose compare fails (a key the two servers order differently, say) is
 * reported with its error; the others still compare.
 */
export async function runDataCompare(
  job: DataCompareJob,
  context: SyncJobContext,
): Promise<SyncJobOutcome> {
  const started = performance.now();
  const { source, target } = bothSides(context);
  const { signal } = context;
  const sourceDialect = sqlDialect(source);
  const targetDialect = sqlDialect(target);
  const crossFamily = family(sourceDialect) !== family(targetDialect);
  context.progress({ phase: 'Reading both table lists' });
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    source.introspect(scopeFor(job.source, source, ['table'])),
    target.introspect(scopeFor(job.target, target, ['table'])),
  ]);
  if (signal.aborted) throw cancelledError();
  if (crossFamily) {
    const pgSnapshot = sourceDialect === 'postgres' ? sourceSnapshot : targetSnapshot;
    if (pgSnapshot.schemas.length !== 1) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `Comparing ${ENGINES[source.engine].displayName} data with ${ENGINES[target.engine].displayName} data needs one PostgreSQL schema`,
        hint: 'Choose the PostgreSQL schema to compare with the MySQL or MariaDB database.',
      });
    }
    context.log(
      'info',
      'The engines differ: rows are streamed and compared as canonical values (no checksums)',
    );
  }
  const { pairs, skipped } = pairDataTables(sourceSnapshot, targetSnapshot, {
    ...(job.tables !== undefined ? { tables: job.tables.map((t) => t.name) } : {}),
  });
  for (const skip of skipped) context.log('warning', `Skipped ${skip.name}: ${skip.reason}`);
  const canonical = canonicalOptions(job);
  const tables: SpoolTable[] = [];
  let rowsCompared = 0;
  for (const [index, pair] of pairs.entries()) {
    if (signal.aborted) throw cancelledError();
    const tableStarted = performance.now();
    const phase = `Comparing ${pair.name} (${index + 1} of ${pairs.length})`;
    context.progress({ phase, table: pair.name, rowsRead: rowsCompared });
    let spool: TableSpool | undefined;
    let layout: RowLayout | undefined;
    const entry: SpoolTable = {
      index,
      name: pair.name,
      source: pair.source,
      target: pair.target,
      keyColumns: [...pair.keyColumns],
      commonColumns: [...pair.commonColumns],
      compared: [],
      columns: [...pair.keyColumns],
      counts: { inserts: 0, updates: 0, deletes: 0, equal: 0, sourceRows: 0, targetRows: 0 },
      checksums: false,
      ranges: 0,
      matchedRanges: 0,
      stored: { insert: 0, update: 0, delete: 0 },
      statements: { insert: 0, update: 0, delete: 0 },
      durationMs: 0,
      sourceColumns: [...pair.keyColumns],
      targetColumns: [...pair.keyColumns],
      targetKinds: {},
    };
    try {
      for await (const event of compareTableData(source, target, tablePair(pair, job), {
        canonical,
        signal,
      })) {
        if (event.type === 'start') {
          layout = rowLayout(pair.keyColumns, event.sourceColumns, event.targetColumns, [
            ...event.compared,
          ]);
          spool = new TableSpool(
            job.spoolDir,
            index,
            builderOptions(targetDialect, {
              ...layout,
              target: pair.target,
              keyColumns: pair.keyColumns,
            }),
          );
        } else if (event.type === 'diff') {
          await spool?.add(event.diff);
        } else if (event.type === 'progress') {
          context.progress({
            phase,
            table: pair.name,
            rowsRead: rowsCompared + event.rowsCompared,
          });
        } else {
          const s = event.summary;
          rowsCompared += s.sourceRows + s.targetRows;
          Object.assign(entry, {
            counts: {
              inserts: s.inserts,
              updates: s.updates,
              deletes: s.deletes,
              equal: s.equal,
              sourceRows: s.sourceRows,
              targetRows: s.targetRows,
            },
            checksums: s.checksums,
            ranges: s.ranges,
            matchedRanges: s.matchedRanges,
          });
        }
      }
      await spool?.finish();
    } catch (error) {
      spool?.destroy();
      if (isCancelled(error, signal)) throw cancelledError();
      const message = error instanceof Error ? error.message : String(error);
      entry.error = message;
      context.log('error', `${pair.name}: ${message}`);
    }
    if (layout) {
      Object.assign(entry, {
        compared: layout.compared,
        columns: layout.sourceColumns,
        sourceColumns: layout.sourceColumns,
        targetColumns: layout.targetColumns,
        targetKinds: layout.targetKinds,
      });
    }
    if (spool) {
      entry.stored = { ...spool.stored };
      entry.statements = { ...spool.statements };
    }
    entry.durationMs = Math.round(performance.now() - tableStarted);
    tables.push(entry);
    const c = entry.counts;
    if (!entry.error) {
      context.log(
        'info',
        `${pair.name}: ${c.inserts} to insert, ${c.updates} to update, ${c.deletes} to delete, ${c.equal} identical`,
      );
    }
  }
  const manifest: SpoolManifest = {
    version: 1,
    dialect: targetDialect,
    pageSize: SPOOL_PAGE_SIZE,
    tables,
    order: dataSyncOrder(pairs, targetSnapshot),
    apply: {
      disableForeignKeyChecks: job.options.disableForeignKeyChecks === true,
      disableTriggers: job.options.disableTriggers === true,
    },
  };
  await writeFile(join(job.spoolDir, MANIFEST_FILE), JSON.stringify(manifest));
  const differing = tables.filter(
    (t) => t.counts.inserts + t.counts.updates + t.counts.deletes > 0,
  );
  const failed = tables.filter((t) => t.error !== undefined);
  const totals = tables.reduce(
    (sum, t) => ({
      inserts: sum.inserts + t.counts.inserts,
      updates: sum.updates + t.counts.updates,
      deletes: sum.deletes + t.counts.deletes,
    }),
    { inserts: 0, updates: 0, deletes: 0 },
  );
  const outcome =
    differing.length === 0
      ? `${plural(tables.length, 'table')} compared, no differences${failed.length > 0 ? `; ${failed.length} failed` : ''}`
      : `${plural(differing.length, 'table')} of ${tables.length} differ: ${totals.inserts} to insert, ${totals.updates} to update, ${totals.deletes} to delete${failed.length > 0 ? `; ${failed.length} failed` : ''}`;
  context.log('info', outcome);
  const result: DataTableResult[] = tables.map(
    ({ sourceColumns: _s, targetColumns: _t, targetKinds: _k, ...table }) => table,
  );
  return {
    summary: dataSummary('completed', performance.now() - started, outcome, {
      rowsRead: rowsCompared,
      rowsSkipped: 0,
    }),
    errors: failed.map((t) => ({ message: `${t.name}: ${t.error ?? ''}` })),
    result: {
      kind: 'data',
      source: sideInfo(context.sourceProfile!, source, sourceSnapshot.database, job.source),
      target: sideInfo(context.targetProfile, target, targetSnapshot.database, job.target),
      tables: result,
      skipped,
      pageSize: SPOOL_PAGE_SIZE,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the spool back: the sync plan

export async function readManifest(spoolDir: string): Promise<SpoolManifest> {
  let text: string;
  try {
    text = await readFile(join(spoolDir, MANIFEST_FILE), 'utf8');
  } catch {
    throw new QuerybaraError({
      code: 'NOT_FOUND',
      message: 'The comparison’s rows are gone',
      hint: 'Compare again.',
    });
  }
  return spoolManifestSchema.parse(JSON.parse(text));
}

/** One transaction of a data sync: one table's deletes, or its updates and inserts. */
export interface SyncUnit {
  readonly table: SpoolTable;
  readonly actions: readonly DataRowAction[];
  readonly prologue: readonly string[];
  readonly epilogue: readonly string[];
  /** Statements in the body, before prologue and epilogue. */
  readonly count: number;
}

/**
 * The transactions a data sync runs, in order: each table's deletes, child tables first, then
 * each table's updates and inserts, parent tables first.
 */
export function syncPlan(
  manifest: SpoolManifest,
  tables: readonly number[],
  actions: DataActions,
): SyncUnit[] {
  const options = manifest.apply;
  const wanted = new Set(tables);
  const ordered = manifest.order
    .map((index) => manifest.tables[index])
    .filter((t): t is SpoolTable => t !== undefined && wanted.has(t.index) && !t.error);
  const unit = (table: SpoolTable, unitActions: DataRowAction[]): SyncUnit | undefined => {
    const count = unitActions.reduce((sum, a) => sum + table.statements[a], 0);
    if (count === 0) return undefined;
    const builder = new DataSyncScriptBuilder(
      builderOptions(manifest.dialect, table, {
        transaction: true,
        ...(options.disableForeignKeyChecks ? { disableForeignKeyChecks: true } : {}),
        ...(options.disableTriggers ? { disableTriggers: true } : {}),
      }),
    );
    return {
      table,
      actions: unitActions,
      prologue: builder.prologue(),
      epilogue: builder.epilogue(),
      count,
    };
  };
  const units: SyncUnit[] = [];
  if (actions.delete) {
    for (const table of [...ordered].reverse()) {
      const u = unit(table, ['delete']);
      if (u) units.push(u);
    }
  }
  const writes: DataRowAction[] = [
    ...(actions.update ? (['update'] as const) : []),
    ...(actions.insert ? (['insert'] as const) : []),
  ];
  if (writes.length > 0) {
    for (const table of ordered) {
      const u = unit(table, writes);
      if (u) units.push(u);
    }
  }
  return units;
}

/** Every statement of a unit, prologue and epilogue included. */
export async function* unitStatements(spoolDir: string, unit: SyncUnit): AsyncGenerator<string> {
  yield* unit.prologue;
  for (const action of unit.actions) {
    if (unit.table.statements[action] === 0) continue;
    const lines = createInterface({
      input: createReadStream(join(spoolDir, statementsFile(unit.table.index, action))),
      crlfDelay: Infinity,
    });
    for await (const line of lines) if (line !== '') yield JSON.parse(line) as string;
  }
  yield* unit.epilogue;
}

function unitComment(unit: SyncUnit): string {
  const parts = unit.actions
    .filter((a) => unit.table.statements[a] > 0)
    .map((a) => {
      const rows =
        a === 'insert'
          ? unit.table.counts.inserts
          : a === 'update'
            ? unit.table.counts.updates
            : unit.table.counts.deletes;
      return `${rows} ${a === 'delete' ? 'deletes' : a === 'update' ? 'updates' : 'inserts'}`;
    });
  return `-- ${unit.table.name}: ${parts.join(', ')}`;
}

/**
 * The data sync script for a selection (spec §13, data sync step 7): written to `path`, or,
 * without one, its first `limit` statements for the review before applying.
 */
export async function dataSyncScript(input: {
  readonly spoolDir: string;
  readonly tables: readonly number[];
  readonly actions: DataActions;
  readonly path?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<{ statements: string[]; total: number; truncated: boolean; bytes: number }> {
  const manifest = await readManifest(input.spoolDir);
  const units = syncPlan(manifest, input.tables, input.actions);
  const total = units.reduce((sum, u) => sum + u.count + u.prologue.length + u.epilogue.length, 0);
  if (input.path === undefined) {
    const limit = input.limit ?? 200;
    const statements: string[] = [];
    outer: for (const unit of units) {
      for await (const sql of unitStatements(input.spoolDir, unit)) {
        if (statements.length >= limit) break outer;
        statements.push(sql);
      }
    }
    return { statements, total, truncated: total > statements.length, bytes: 0 };
  }
  const out = new LineWriter(input.path);
  let bytes = 0;
  const write = async (line: string): Promise<void> => {
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    await out.write(line);
  };
  try {
    await write('-- Querybara data sync');
    await write(
      `-- ${plural(total, 'statement')}; each table's changes run in their own transaction`,
    );
    if (units.length === 0) await write('-- No differences to sync');
    for (const unit of units) {
      await write('');
      await write(unitComment(unit));
      for await (const sql of unitStatements(input.spoolDir, unit)) await write(`${sql};`);
    }
    await out.close();
  } catch (error) {
    out.destroy();
    throw error;
  }
  return { statements: [], total, truncated: false, bytes };
}

/**
 * Applies the spooled changes of a selection (spec §13, data sync step 7) in batched
 * transactions, one per table and pass, stopping at the first error: that transaction rolls
 * back, and the ones before it stay committed.
 */
export async function runDataApply(
  job: DataApplyJob,
  context: SyncJobContext,
): Promise<SyncJobOutcome> {
  const started = performance.now();
  const { target, signal } = context;
  checkTargetWrite(context.targetProfile, job.confirmed);
  const manifest = await readManifest(job.spoolDir);
  if (manifest.dialect !== sqlDialect(target)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The target connection is not the one that was compared',
    });
  }
  const units = syncPlan(manifest, job.tables, job.actions);
  const total = units.reduce((sum, u) => sum + u.count + u.prologue.length + u.epilogue.length, 0);
  if (total === 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The selected tables have nothing to apply for the chosen actions',
    });
  }
  context.log(
    'info',
    `Applying ${plural(total, 'statement')} in ${plural(units.length, 'transaction')}`,
  );
  let done = 0;
  let rowsAffected = 0;
  const committed = new Set<string>();
  for (const unit of units) {
    let inUnit = 0;
    try {
      for await (const sql of unitStatements(job.spoolDir, unit)) {
        context.progress({
          phase: `Applying ${unit.table.name}: ${firstLine(sql, 60)}`,
          table: unit.table.name,
          statements: done,
          rowsWritten: rowsAffected,
        });
        rowsAffected += await runStatement(target, sql, signal);
        done++;
        inUnit++;
      }
      committed.add(unit.table.name);
    } catch (error) {
      await rollbackQuietly(target);
      if (isCancelled(error, signal)) throw cancelledError();
      const message = error instanceof Error ? error.message : String(error);
      const kept =
        committed.size > 0
          ? `The changes to ${[...committed].join(', ')} stay committed.`
          : 'Nothing was committed.';
      context.log('error', `${unit.table.name}: ${message}`);
      context.log('error', `The ${unit.table.name} transaction was rolled back. ${kept}`);
      const errors: JobRowError[] = [
        { statement: done + 1, message, text: `${unit.table.name} (statement ${inUnit + 1})` },
      ];
      return {
        summary: dataSummary(
          'failed',
          performance.now() - started,
          `Stopped at ${unit.table.name}: its transaction was rolled back. ${kept}`,
          { statements: done, failed: 1, rowsWritten: rowsAffected, rowsAffected },
        ),
        errors,
      };
    }
  }
  const outcome = `Applied ${plural(rowsAffected, 'row change')} to ${plural(committed.size, 'table')}`;
  context.log('info', outcome);
  return {
    summary: dataSummary('completed', performance.now() - started, outcome, {
      statements: done,
      failed: 0,
      rowsWritten: rowsAffected,
      rowsAffected,
    }),
    errors: [],
  };
}
