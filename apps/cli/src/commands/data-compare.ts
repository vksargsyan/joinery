import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  rmSync,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  newId,
  type CellValue,
  type ColumnKind,
  type ColumnMeta,
  type Session,
  type SqlDialect,
  type TlsMode,
} from '@joinery/core';
import {
  DataSyncScriptBuilder,
  columnIndex,
  compareTableData,
  type CanonicalOptions,
  type DataCompareSummary,
  type DataSyncOptions,
  type RowAction,
  type RowDiff,
  type TableRef,
  type TablePair,
} from '@joinery/sync';

import { cancellable, closeQuietly, drain, type Connection } from '../connect';
import { CliError, EXIT, formatError, type ExitCode } from '../errors';
import { bytesToBase64, cellText, isHandle } from '../output/cells';
import { singleLine, truncateToWidth } from '../output/width';
import { formatDuration, openTarget, plural, writeLine, type Runtime } from '../runtime';
import { confirmOperation } from '../safety';

export interface DataCompareCommandOptions {
  /** Source table, `schema.table` on PostgreSQL. */
  readonly table: string;
  /** Target table; defaults to the source table's name. */
  readonly targetTable?: string;
  readonly key?: readonly string[];
  readonly columns?: readonly string[];
  readonly ignoreColumns?: readonly string[];
  readonly actions: readonly RowAction[];
  readonly floatTolerance?: number;
  readonly trim?: CanonicalOptions['trim'];
  readonly caseInsensitive?: boolean;
  readonly out?: string;
  readonly apply: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  /** Row differences to print (0: none). */
  readonly showRows: number;
  readonly batchSize?: number;
  readonly disableForeignKeyChecks?: boolean;
  readonly tls?: TlsMode;
}

/** The row layout compareTableData streams: key columns first, then compared columns. */
interface RowLayout {
  readonly sourceColumns: readonly string[];
  readonly targetColumns: readonly string[];
  readonly targetKinds: Readonly<Record<string, ColumnKind>>;
  readonly compared: readonly string[];
}

interface CompareRun {
  readonly summary: DataCompareSummary;
  readonly layout: RowLayout;
  readonly samples: readonly RowDiff[];
  readonly durationMs: number;
}

/**
 * `joinery data-compare <source> <target> --table <name>`: data compare (spec §13, data sync).
 * Checksums key ranges on both servers, streams only mismatched ranges, prints counts per
 * action, and writes a sync script or applies it in one transaction. Scripts are spooled to
 * temporary files per action, so memory stays flat for large diffs. Exit 0: no differences
 * (for the selected actions); 1: differences found or remaining; 2: error.
 */
export async function dataCompareCommand(
  runtime: Runtime,
  sourceSpec: string,
  targetSpec: string,
  options: DataCompareCommandOptions,
): Promise<ExitCode> {
  const overrides = options.tls !== undefined ? { tls: options.tls } : {};
  let source: Connection | undefined;
  let target: Connection | undefined;
  let spool: SyncSpool | undefined;
  try {
    source = await openTarget(runtime, sourceSpec, overrides);
    target = await openTarget(runtime, targetSpec, overrides);
    const targetDialect = target.dialect;
    const pair = await tablePair(runtime, source, target, options);
    const wantScript = options.out !== undefined || options.apply;
    const selected = new Set(options.actions);
    const run = await compare(runtime, source.session, target.session, pair, options, (layout) => {
      if (!wantScript) return undefined;
      spool = new SyncSpool(syncOptions(targetDialect, pair, layout, options));
      return spool;
    });
    const counts = {
      insert: run.summary.inserts,
      update: run.summary.updates,
      delete: run.summary.deletes,
    };
    const pending = options.actions.reduce((sum, action) => sum + counts[action], 0);

    if (options.json) {
      const report = compareJson(source, target, pair, run, options);
      if (!options.apply) await writeLine(runtime, JSON.stringify(report, null, 2));
    } else {
      await writeLine(
        runtime,
        `Table ${describe(pair.source, source.dialect)} → ${describe(pair.target, target.dialect)} (key: ${pair.keyColumns.join(', ')}; ${plural(run.layout.compared.length, 'column')} compared)`,
      );
      for (const action of ['insert', 'update', 'delete'] as const) {
        const note = selected.has(action) ? '' : '  (not selected)';
        await writeLine(
          runtime,
          `  ${action.padEnd(7)} ${counts[action].toLocaleString('en-US').padStart(10)}${note}`,
        );
      }
      await writeLine(
        runtime,
        `  ${'equal'.padEnd(7)} ${run.summary.equal.toLocaleString('en-US').padStart(10)}`,
      );
      runtime.reporter.info(
        `Compared ${plural(run.summary.sourceRows, 'source row')} with ${plural(run.summary.targetRows, 'target row')} in ${formatDuration(run.durationMs)}` +
          (run.summary.checksums
            ? ` (${plural(run.summary.ranges, 'range')}, ${run.summary.matchedRanges} matched by checksum)`
            : ' (rows streamed; no checksums across engine families)'),
      );
      if (run.samples.length > 0) {
        await writeLine(runtime, '');
        await writeLine(runtime, `Row differences (first ${run.samples.length}):`);
        for (const line of sampleLines(run.samples, run.layout, runtime.out))
          await writeLine(runtime, line);
      }
    }

    if (spool) await spool.finish();
    if (options.out !== undefined && spool) {
      await spool.writeScript(resolve(runtime.ctx.cwd, options.out), pending);
      runtime.reporter.info(
        `Wrote the sync script (${plural(spool.statementCount, 'statement')}) to ${options.out}`,
      );
    }
    if (!options.apply) return pending > 0 ? EXIT.differences : EXIT.ok;

    // --apply
    if (pending === 0 || !spool) {
      if (options.json)
        await writeLine(
          runtime,
          JSON.stringify(compareJson(source, target, pair, run, options), null, 2),
        );
      else runtime.reporter.info('Nothing to apply.');
      return EXIT.ok;
    }
    const applied = await applySpool(runtime, target, spool, counts, options);
    if (!applied) return EXIT.error;
    const after = await compare(
      runtime,
      source.session,
      target.session,
      pair,
      options,
      () => undefined,
    );
    const left = {
      insert: after.summary.inserts,
      update: after.summary.updates,
      delete: after.summary.deletes,
    };
    const remaining = options.actions.reduce((sum, action) => sum + left[action], 0);
    if (options.json) {
      const report = {
        ...compareJson(source, target, pair, run, options),
        apply: { statements: spool.totalStatements, remaining: left },
      };
      await writeLine(runtime, JSON.stringify(report, null, 2));
    }
    if (remaining === 0) {
      runtime.reporter.print(
        runtime.reporter.style.green(
          `Applied ${plural(pending, 'row change')} in ${formatDuration(applied.durationMs)}; the target now matches the source for ${options.actions.join(', ')}.`,
        ),
      );
      return EXIT.ok;
    }
    runtime.reporter.error([
      `error: ${plural(remaining, 'row difference')} ${remaining === 1 ? 'remains' : 'remain'} after applying the sync script (insert ${left.insert}, update ${left.update}, delete ${left.delete})`,
      '  hint: rows may have changed on either side while syncing; compare again, or check triggers on the target',
    ]);
    return EXIT.differences;
  } finally {
    spool?.dispose();
    await closeQuietly(source?.session);
    await closeQuietly(target?.session);
  }
}

// ---------------------------------------------------------------------------------------------
// Table pairing and key discovery

async function tablePair(
  runtime: Runtime,
  source: Connection,
  target: Connection,
  options: DataCompareCommandOptions,
): Promise<TablePair> {
  const sourceRef = await tableRef(source, options.table);
  const targetRef = await tableRef(target, options.targetTable ?? options.table);
  const keyColumns = options.key ?? (await discoverKey(source.session, source.dialect, sourceRef));
  runtime.reporter.debug(`key columns: ${keyColumns.join(', ')}`);
  return {
    source: sourceRef,
    target: targetRef,
    keyColumns,
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    ...(options.ignoreColumns !== undefined ? { ignoreColumns: options.ignoreColumns } : {}),
  };
}

/** `schema.table` on PostgreSQL (default: the session's current schema); a plain name on MySQL. */
async function tableRef(connection: Connection, name: string): Promise<TableRef> {
  const dot = name.indexOf('.');
  if (connection.dialect !== 'postgres') {
    if (dot >= 0) {
      throw new CliError(
        `MySQL and MariaDB tables are named without a database prefix ("${name}")`,
        {
          hint: 'Put the database in the connection URI or pass --database',
        },
      );
    }
    return { name };
  }
  if (dot > 0) return { schema: name.slice(0, dot), name: name.slice(dot + 1) };
  const schema = await scalar(connection.session, 'SELECT current_schema()');
  return { schema: schema ?? 'public', name };
}

async function scalar(session: Session, sql: string): Promise<string | undefined> {
  let value: CellValue | undefined;
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && value === undefined && chunk.rowCount > 0)
      value = chunk.data[0]?.[0];
  }
  return value === null || value === undefined ? undefined : cellText(value);
}

/** The primary key, else a unique NOT NULL key (constraint or plain-column unique index). */
export async function discoverKey(
  session: Session,
  dialect: SqlDialect,
  table: TableRef,
): Promise<string[]> {
  const snapshot = await session.introspect(
    dialect === 'postgres' && table.schema !== undefined
      ? { schemas: [table.schema], include: ['table'] }
      : { include: ['table'] },
  );
  const tables = snapshot.schemas.flatMap((schema) => schema.tables);
  const def =
    tables.find((t) => t.name === table.name) ??
    tables.find((t) => t.name.toLowerCase() === table.name.toLowerCase());
  if (!def) {
    throw new CliError(`Table ${describe(table, dialect)} was not found on the source`, {
      code: 'NOT_FOUND',
    });
  }
  if (def.primaryKey) return [...def.primaryKey.columns];
  const notNull = (columns: readonly string[]): boolean =>
    columns.every((name) => def.columns.find((c) => c.name === name)?.nullable === false);
  const unique = def.uniques.find((u) => notNull(u.columns));
  if (unique) return [...unique.columns];
  for (const index of def.indexes) {
    if (!index.unique || index.where !== undefined) continue;
    const names = index.columns.map((c) =>
      c.name !== null && c.expression === undefined && c.length === undefined ? c.name : null,
    );
    if (names.every((n): n is string => n !== null) && notNull(names)) return names;
  }
  throw new CliError(
    `Table ${describe(table, dialect)} has no primary key or unique NOT NULL key`,
    {
      hint: 'Name the key columns with --key',
    },
  );
}

function describe(table: TableRef, dialect: SqlDialect): string {
  return dialect === 'postgres' && table.schema ? `${table.schema}.${table.name}` : table.name;
}

// ---------------------------------------------------------------------------------------------
// Compare

async function compare(
  runtime: Runtime,
  sourceSession: Session,
  targetSession: Session,
  pair: TablePair,
  options: DataCompareCommandOptions,
  onStart: (layout: RowLayout) => SyncSpool | undefined,
): Promise<CompareRun> {
  const { reporter, interrupts, ctx } = runtime;
  const canonical: CanonicalOptions = {
    ...(options.floatTolerance !== undefined ? { floatTolerance: options.floatTolerance } : {}),
    ...(options.trim !== undefined ? { trim: options.trim } : {}),
    ...(options.caseInsensitive ? { caseInsensitive: true } : {}),
  };
  const selected = new Set(options.actions);
  const controller = new AbortController();
  const started = ctx.now();
  let layout: RowLayout | undefined;
  let spool: SyncSpool | undefined;
  let summary: DataCompareSummary | undefined;
  const samples: RowDiff[] = [];
  await interrupts.guard(
    () => controller.abort(),
    async () => {
      for await (const event of compareTableData(sourceSession, targetSession, pair, {
        canonical,
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'start':
            layout = rowLayout(pair, event.sourceColumns, event.targetColumns, event.compared);
            spool = onStart(layout);
            break;
          case 'progress':
            reporter.progress(
              `Comparing… ${plural(event.rowsCompared, 'row')} · ${plural(event.ranges, 'range')} (${event.matchedRanges} matched)`,
            );
            break;
          case 'diff':
            if (!selected.has(event.diff.action)) break;
            if (samples.length < options.showRows) samples.push(event.diff);
            await spool?.add(event.diff);
            break;
          case 'done':
            summary = event.summary;
            break;
        }
      }
    },
  );
  reporter.clearProgress();
  if (!summary || !layout)
    throw new CliError('The data compare ended without a summary', { code: 'INTERNAL' });
  return { summary, layout, samples, durationMs: ctx.now() - started };
}

/** Rebuilds the column order compareTableData streams rows in: keys, then compared columns. */
function rowLayout(
  pair: TablePair,
  sourceMeta: readonly ColumnMeta[],
  targetMeta: readonly ColumnMeta[],
  compared: readonly string[],
): RowLayout {
  const sourceNames = sourceMeta.map((c) => c.name);
  const targetNames = targetMeta.map((c) => c.name);
  const wanted = [...pair.keyColumns, ...compared];
  const targetColumns = wanted.map((c) => targetNames[columnIndex(targetNames, c)] ?? c);
  const targetKinds: Record<string, ColumnKind> = {};
  for (const meta of targetMeta) targetKinds[meta.name] = meta.kind;
  return {
    sourceColumns: wanted.map((c) => sourceNames[columnIndex(sourceNames, c)] ?? c),
    targetColumns,
    targetKinds,
    compared,
  };
}

function syncOptions(
  dialect: SqlDialect,
  pair: TablePair,
  layout: RowLayout,
  options: DataCompareCommandOptions,
): DataSyncOptions {
  return {
    dialect,
    table: pair.target,
    keyColumns: layout.targetColumns.slice(0, pair.keyColumns.length),
    sourceColumns: layout.sourceColumns,
    targetColumns: layout.targetColumns,
    targetKinds: layout.targetKinds,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.disableForeignKeyChecks ? { disableForeignKeyChecks: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Script spooling and apply

const ACTION_ORDER: readonly RowAction[] = ['delete', 'update', 'insert'];

/**
 * Sync statements spooled to temporary files, one per action, as JSON lines. Deletes run
 * first, then updates, then inserts, across the whole table (a key whose case changed under a
 * case-insensitive collation is deleted before it is re-inserted), without holding the diff in
 * memory.
 */
export class SyncSpool {
  readonly #dir: string;
  readonly #builders: Record<RowAction, DataSyncScriptBuilder>;
  readonly #files: Record<RowAction, { path: string; stream: WriteStream }>;
  readonly #prologue: readonly string[];
  readonly #epilogue: readonly string[];
  #count = 0;

  constructor(options: DataSyncOptions) {
    this.#dir = mkdtempSync(join(tmpdir(), 'joinery-sync-'));
    const only = (action: RowAction): DataSyncScriptBuilder =>
      new DataSyncScriptBuilder({
        ...options,
        actions: {
          insert: action === 'insert',
          update: action === 'update',
          delete: action === 'delete',
        },
      });
    this.#builders = { insert: only('insert'), update: only('update'), delete: only('delete') };
    const file = (action: RowAction): { path: string; stream: WriteStream } => {
      const path = join(this.#dir, `${action}.jsonl`);
      return { path, stream: createWriteStream(path) };
    };
    this.#files = { insert: file('insert'), update: file('update'), delete: file('delete') };
    this.#prologue = this.#builders.insert.prologue();
    this.#epilogue = this.#builders.insert.epilogue();
  }

  /** Statements in the body (without the transaction prologue and epilogue). */
  get statementCount(): number {
    return this.#count;
  }

  /** Everything `statements()` yields. */
  get totalStatements(): number {
    return this.#count === 0 ? 0 : this.#count + this.#prologue.length + this.#epilogue.length;
  }

  async add(diff: RowDiff): Promise<void> {
    await this.#write(diff.action, this.#builders[diff.action].add(diff));
  }

  /** Flushes partial batches and closes the files. */
  async finish(): Promise<void> {
    for (const action of ACTION_ORDER) await this.#write(action, this.#builders[action].flush());
    await Promise.all(
      ACTION_ORDER.map(
        (action) => new Promise<void>((done) => this.#files[action].stream.end(() => done())),
      ),
    );
  }

  /** Every statement in run order: prologue, deletes, updates, inserts, epilogue. */
  async *statements(): AsyncGenerator<string> {
    if (this.#count === 0) return;
    yield* this.#prologue;
    for (const action of ACTION_ORDER) {
      const lines = createInterface({ input: createReadStream(this.#files[action].path) });
      for await (const line of lines) if (line !== '') yield JSON.parse(line) as string;
    }
    yield* this.#epilogue;
  }

  async writeScript(path: string, pending: number): Promise<void> {
    const out = createWriteStream(path);
    const write = (text: string): Promise<void> =>
      new Promise((done, fail) => {
        if (out.write(text)) done();
        else out.once('drain', done).once('error', fail);
      });
    await write(pending === 0 ? '-- No differences to sync\n' : '');
    for await (const statement of this.statements()) await write(`${statement};\n`);
    await new Promise<void>((done) => out.end(() => done()));
  }

  dispose(): void {
    for (const action of ACTION_ORDER) this.#files[action].stream.destroy();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  async #write(action: RowAction, statements: readonly string[]): Promise<void> {
    const stream = this.#files[action].stream;
    for (const statement of statements) {
      this.#count++;
      if (!stream.write(`${JSON.stringify(statement)}\n`)) {
        await new Promise<void>((done) => stream.once('drain', done));
      }
    }
  }
}

async function applySpool(
  runtime: Runtime,
  target: Connection,
  spool: SyncSpool,
  counts: Readonly<Record<RowAction, number>>,
  options: DataCompareCommandOptions,
): Promise<{ durationMs: number } | undefined> {
  const { reporter, interrupts, ctx } = runtime;
  const { session } = target;
  if (target.target.policy.readOnly) {
    throw new CliError(`"${target.target.label}" is read-only; the sync script was not applied`, {
      code: 'READ_ONLY',
    });
  }
  const parts = options.actions.map((action) => `${counts[action]} ${action}`).join(', ');
  const policy = target.target.policy;
  if (
    (options.actions.includes('delete') && counts.delete > 0) ||
    policy.production ||
    policy.confirmWrites === true
  ) {
    await confirmOperation(`Apply ${parts} to "${target.target.label}"?`, {
      yes: options.yes,
      prompter: ctx.prompter,
      reporter,
    });
  }
  const started = ctx.now();
  let index = 0;
  for await (const sql of spool.statements()) {
    index++;
    reporter.progress(`Applying statement ${index}/${spool.totalStatements}…`);
    try {
      await cancellable(interrupts, session, (execution) => drain(session, sql, execution));
    } catch (error) {
      reporter.clearProgress();
      if (session.inTransaction) await drain(session, 'ROLLBACK').catch(() => undefined);
      if (interrupts.interrupted) throw error;
      reporter.error(
        formatError(error, { verbose: reporter.verbose, statement: { index, text: sql } }),
      );
      reporter.print('The sync transaction was rolled back; the target is unchanged.');
      return undefined;
    }
  }
  reporter.clearProgress();
  return { durationMs: ctx.now() - started };
}

// ---------------------------------------------------------------------------------------------
// Output

function valueText(value: CellValue | undefined): string {
  if (value === undefined || value === null) return 'NULL';
  const text = singleLine(truncateToWidth(cellText(value), 40));
  return typeof value === 'string' ? `'${text}'` : text;
}

function sampleLines(
  samples: readonly RowDiff[],
  layout: RowLayout,
  style: Runtime['out'],
): string[] {
  const keyCount = layout.sourceColumns.length - layout.compared.length;
  const keyText = (diff: RowDiff): string =>
    diff.key
      .map((v, i) => `${layout.sourceColumns[i] ?? `key${i + 1}`}=${valueText(v)}`)
      .join(', ');
  return samples.map((diff) => {
    if (diff.action === 'insert') {
      const values = layout.sourceColumns
        .slice(keyCount)
        .map((c, i) => `${c}=${valueText(diff.sourceRow?.[keyCount + i])}`)
        .join(', ');
      return `  ${style.green('+')} ${keyText(diff)}${values ? `  ${values}` : ''}`;
    }
    if (diff.action === 'delete') return `  ${style.red('-')} ${keyText(diff)}`;
    const changes = (diff.changedColumns ?? []).map((column) => {
      const s = columnIndex(layout.sourceColumns, column);
      const t = columnIndex(layout.targetColumns, column);
      return `${column}: ${valueText(diff.targetRow?.[t])} → ${valueText(diff.sourceRow?.[s])}`;
    });
    return `  ${style.yellow('~')} ${keyText(diff)}  ${changes.join(', ')}`;
  });
}

/** A JSON-safe copy of a cell: bigint as a string (exact), binary as base64. */
function jsonSafe(value: CellValue | undefined): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (isHandle(value)) return value.preview;
  return value;
}

function compareJson(
  source: Connection,
  target: Connection,
  pair: TablePair,
  run: CompareRun,
  options: DataCompareCommandOptions,
): Record<string, unknown> {
  const row = (names: readonly string[], values: readonly CellValue[] | undefined): unknown =>
    values ? Object.fromEntries(names.map((n, i) => [n, jsonSafe(values[i])])) : undefined;
  return {
    source: { label: source.target.label, table: describe(pair.source, source.dialect) },
    target: { label: target.target.label, table: describe(pair.target, target.dialect) },
    key: pair.keyColumns,
    compared: run.layout.compared,
    actions: options.actions,
    summary: run.summary,
    differences: run.samples.map((diff) => ({
      action: diff.action,
      key: diff.key.map(jsonSafe),
      ...(diff.changedColumns ? { changedColumns: diff.changedColumns } : {}),
      ...(diff.sourceRow ? { source: row(run.layout.sourceColumns, diff.sourceRow) } : {}),
      ...(diff.targetRow ? { target: row(run.layout.targetColumns, diff.targetRow) } : {}),
    })),
  };
}
