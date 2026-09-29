import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ENGINES, JoineryError, isSqlEngine, type EngineId, type Session } from '@joinery/core';
import {
  FIELD_SHAPES,
  planDbTransfer,
  runDbTransfer,
  transferSupport,
  type ColumnOverride,
  type DbTransferOptions,
  type DbTransferProgress,
  type DbTransferSpec,
  type DbTransferSummary,
  type EmbedSpec,
  type FieldShape,
  type OpenedSession,
  type SessionOpener,
  type TransferObjectSpec,
  type TransferPlan,
} from '@joinery/transfer';
import { connectThroughTransport, needsTransport } from '@joinery/tunnel';
import { InvalidArgumentError } from 'commander';

import { connect, missingPasswordHint } from '../connect';
import { CliError, EXIT, InterruptedError, type ExitCode } from '../errors';
import { formatDuration, plural, targetFor, writeLine, type Runtime } from '../runtime';
import { confirmOperation } from '../safety';
import { resolvedProfile, withPassword, type Target, type TargetOverrides } from '../target';
import type { TunnelFlags } from '../tunnels';
import { describeRowError } from './transfer';

/**
 * `joinery transfer <source> <target>` (spec §12): data transfer between databases through the
 * same streaming pipeline as the desktop app's transfer jobs — PostgreSQL, MySQL and MariaDB to
 * any of them, SQL engines to MongoDB and back, Redis to Redis. `--dry-run` prints the plan (every column's source and
 * target type, the statements before and after the data) and changes nothing. The write rules
 * are `import`'s: a read-only target refuses; dropping, emptying or overwriting anything, and
 * any write to a production or "confirm writes" profile, need --yes or a confirmation.
 * Exit codes: 0 done, 1 done but rows were skipped, 2 failed or refused, 130 interrupted.
 */

/** Failed rows printed on stderr; the rest only go to --error-log. */
const SHOWN_ERRORS = 10;

/** What `joinery transfer` does, from its flags (see `transferDbOptions` in program.ts). */
export interface TransferDbOptions {
  /** Tables (or collections) to transfer; `schema.table` names the PostgreSQL schema. */
  readonly objects: readonly string[];
  /** Redis: key patterns. */
  readonly patterns: readonly string[];
  /** Every table or collection of the source schema or database. */
  readonly all: boolean;
  /** The source database (MongoDB: of the collections; SQL: to connect to). */
  readonly database?: string;
  /** The PostgreSQL source schema. */
  readonly schema?: string;
  readonly targetDatabase?: string;
  readonly targetSchema?: string;
  /** `[source, target]` table names. */
  readonly renames: readonly (readonly [string, string])[];
  /** `[table, column, type]`. */
  readonly types: readonly (readonly [string, string, string])[];
  /** `[table, column]`. */
  readonly skips: readonly (readonly [string, string])[];
  /** `[collection, field, shape]`. */
  readonly shapes: readonly (readonly [string, string, FieldShape])[];
  readonly embeds: readonly (EmbedSpec & { readonly parent: string })[];
  readonly options: Partial<DbTransferOptions>;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly yes: boolean;
  readonly errorLog?: string;
  readonly tls?: TargetOverrides['tls'];
  readonly tunnel?: TunnelFlags;
}

// ---------------------------------------------------------------------------------------------
// Flag parsers

/** `--rename from=to`. */
export function renameFlag(value: string): readonly [string, string] {
  const at = value.indexOf('=');
  if (at <= 0 || at === value.length - 1) {
    throw new InvalidArgumentError('Use source=target (e.g. orders=orders_2024).');
  }
  return [value.slice(0, at).trim(), value.slice(at + 1).trim()];
}

/** `table.column`: the first dot separates the table (a MongoDB field path keeps its dots). */
function tableColumn(text: string, example: string): readonly [string, string] {
  const dot = text.indexOf('.');
  if (dot <= 0 || dot === text.length - 1) {
    throw new InvalidArgumentError(`Use table.column (e.g. ${example}).`);
  }
  return [text.slice(0, dot).trim(), text.slice(dot + 1).trim()];
}

/** `--type table.column=type`. */
export function typeFlag(value: string): readonly [string, string, string] {
  const at = value.lastIndexOf('=');
  if (at <= 0)
    throw new InvalidArgumentError('Use table.column=type (e.g. orders.total=numeric(12,2)).');
  const [table, column] = tableColumn(value.slice(0, at), 'orders.total=numeric(12,2)');
  const type = value.slice(at + 1).trim();
  if (type === '') throw new InvalidArgumentError('The type is empty.');
  return [table, column, type];
}

/** `--skip table.column`. */
export function skipFlag(value: string): readonly [string, string] {
  return tableColumn(value, 'orders.note');
}

/** `--shape collection.field=columns|json|child`. */
export function shapeFlag(value: string): readonly [string, string, FieldShape] {
  const at = value.lastIndexOf('=');
  const shape = value.slice(at + 1).trim();
  if (at <= 0 || !(FIELD_SHAPES as readonly string[]).includes(shape)) {
    throw new InvalidArgumentError(
      `Use collection.field=${FIELD_SHAPES.join('|')} (e.g. orders.items=child).`,
    );
  }
  const [table, field] = tableColumn(value.slice(0, at), 'orders.items=child');
  return [table, field, shape as FieldShape];
}

/** `--embed parent:child:foreign_key[:field]`. */
export function embedFlag(value: string): EmbedSpec & { readonly parent: string } {
  const parts = value.split(':').map((p) => p.trim());
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => p === '')) {
    throw new InvalidArgumentError(
      'Use parent:child:foreign_key[:field] (e.g. orders:items:items_order_id_fkey:lines).',
    );
  }
  const [parent, table, foreignKey, field] = parts as [string, string, string, string | undefined];
  return { parent, table, foreignKey, ...(field !== undefined ? { field } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Sessions

/** Opens a session for a target on a known engine, through its tunnel or proxy. */
async function openWith(
  runtime: Runtime,
  engine: EngineId,
  target: Target,
  tunnel: TunnelFlags | undefined,
): Promise<OpenedSession> {
  const adapter = runtime.ctx.adapters(engine);
  const resolved = resolvedProfile(target);
  if (needsTransport(target.profile)) {
    return connectThroughTransport(adapter, resolved, runtime.tunnels.manager(tunnel));
  }
  const session = await adapter.connect(resolved);
  return { session, close: () => session.close() };
}

interface Side {
  /** The first session, used to plan, then as the transfer's control session. */
  readonly first: OpenedSession;
  readonly target: Target;
  /** Opens the first session once, then new ones. */
  readonly open: SessionOpener;
}

/**
 * Connects one side, asking for a password once when the server refused a login without one
 * (as `query` does); a `mysql://` target that is MariaDB gets the MariaDB dialect.
 */
async function openSide(
  runtime: Runtime,
  target: Target,
  tunnel: TunnelFlags | undefined,
): Promise<Side> {
  let opened: OpenedSession;
  let current = target;
  let engine: EngineId = target.profile.engine;
  runtime.reporter.progress(`Connecting to ${target.label}…`, true);
  try {
    if (isSqlEngine(engine)) {
      const connection = await connect(target, {
        adapters: runtime.ctx.adapters,
        prompter: runtime.ctx.prompter,
        reporter: runtime.reporter,
        transports: () => runtime.tunnels.manager(tunnel),
      });
      opened = { session: connection.session, close: connection.close };
      current = connection.target;
      engine = connection.session.engine;
    } else {
      try {
        opened = await openWith(runtime, engine, current, tunnel);
      } catch (error) {
        const refused = error instanceof JoineryError && error.code === 'AUTH_FAILED';
        if (!refused || current.passwordKnown) throw error;
        if (!runtime.ctx.prompter.interactive) {
          throw new CliError(error.message, {
            code: 'AUTH_FAILED',
            hint: missingPasswordHint(current),
            cause: error,
          });
        }
        runtime.reporter.info(`${current.label}: ${error.message}`);
        const password = await runtime.ctx.prompter.secret(`Password for ${current.label}: `);
        current = withPassword(current, password);
        opened = await openWith(runtime, engine, current, tunnel);
      }
    }
  } finally {
    runtime.reporter.clearProgress();
  }
  // Closed by the transfer when it ran, by the command otherwise: whichever comes first.
  let closing: Promise<void> | undefined;
  const first: OpenedSession = {
    session: opened.session,
    close: () => (closing ??= opened.close()),
  };
  let used = false;
  const final = current;
  const open: SessionOpener = async () => {
    if (!used) {
      used = true;
      return first;
    }
    return openWith(runtime, engine, final, tunnel);
  };
  return { first, target: current, open };
}

/** Every table (collection) of the source schema (database), for --all. */
async function allObjects(
  session: Session,
  db: string | undefined,
  schema: string | undefined,
): Promise<string[]> {
  if (isSqlEngine(session.engine)) {
    const pg = session.engine === 'postgres';
    const name = schema || 'public';
    const snapshot = await session.introspect({
      ...(pg ? { schemas: [name] } : {}),
      include: ['table'],
    });
    const found = pg ? snapshot.schemas.find((s) => s.name === name) : snapshot.schemas[0];
    return (found?.tables ?? []).map((t) => t.name);
  }
  const database = db || (session as Session & { currentDatabase?: string }).currentDatabase;
  if (session.engine !== 'mongodb' || !database) return [];
  const nodes = await session.browse([database, 'collections']);
  return nodes.filter((n) => n.kind === 'collection').map((n) => n.name);
}

// ---------------------------------------------------------------------------------------------
// The spec

/** Splits `schema.table` names into the one source schema and the tables. */
function objectNames(
  options: TransferDbOptions,
  sourceEngine: EngineId,
): { schema?: string; names: string[] } {
  if (sourceEngine !== 'postgres')
    return { names: [...options.objects], ...(options.schema ? { schema: options.schema } : {}) };
  let schema = options.schema;
  const names: string[] = [];
  for (const object of options.objects) {
    const dot = object.indexOf('.');
    if (dot <= 0) {
      names.push(object);
      continue;
    }
    const own = object.slice(0, dot);
    if (schema !== undefined && schema !== own) {
      throw new CliError(`${object} is in schema ${own}, but the tables come from ${schema}`, {
        hint: 'A transfer reads one PostgreSQL schema; run one per schema',
      });
    }
    schema = own;
    names.push(object.slice(dot + 1));
  }
  return { ...(schema !== undefined ? { schema } : {}), names };
}

/**
 * The engine's spec from the flags: one object per table with its rename, column types,
 * skipped columns, field shapes and embeds (each must name a transferred table).
 */
export function buildSpec(
  options: TransferDbOptions,
  sourceEngine: EngineId,
  objects: readonly string[],
  schema: string | undefined,
): DbTransferSpec {
  const known = new Set(objects);
  const unknown = [
    ...options.renames.map(([name]) => name),
    ...options.types.map(([name]) => name),
    ...options.skips.map(([name]) => name),
    ...options.shapes.map(([name]) => name),
    ...options.embeds.map((e) => e.parent),
  ].find((name) => !known.has(name));
  if (unknown !== undefined) {
    throw new CliError(`${unknown} is not one of the tables transferred`, {
      hint: `Name it with --table, or leave its --rename/--type/--skip/--shape/--embed out`,
    });
  }
  const specObjects: TransferObjectSpec[] = objects.map((name) => {
    const columns = new Map<string, ColumnOverride>();
    const patch = (source: string, change: Omit<ColumnOverride, 'source'>): void => {
      columns.set(source, { ...columns.get(source), ...change, source });
    };
    for (const [table, column, dataType] of options.types)
      if (table === name) patch(column, { dataType });
    for (const [table, column] of options.skips) if (table === name) patch(column, { skip: true });
    for (const [table, field, shape] of options.shapes) if (table === name) patch(field, { shape });
    const rename = options.renames.find(([from]) => from === name)?.[1];
    const embed = options.embeds
      .filter((e) => e.parent === name)
      .map(({ parent: _parent, ...e }) => e);
    return {
      name,
      ...(rename !== undefined ? { target: rename } : {}),
      ...(columns.size > 0 ? { columns: [...columns.values()] } : {}),
      ...(embed.length > 0 ? { embed } : {}),
    };
  });
  return {
    source: {
      ...(options.database !== undefined ? { database: options.database } : {}),
      ...(schema !== undefined ? { schema } : {}),
    },
    target: {
      ...(options.targetDatabase !== undefined ? { database: options.targetDatabase } : {}),
      ...(options.targetSchema !== undefined ? { schema: options.targetSchema } : {}),
    },
    objects: sourceEngine === 'redis' ? [] : specObjects,
    ...(sourceEngine === 'redis' ? { keyPatterns: [...options.patterns] } : {}),
    options: options.options,
  };
}

// ---------------------------------------------------------------------------------------------
// Output

/** The plan as text: each table with its columns and types, then the statements. */
export function planText(plan: TransferPlan): string {
  const lines: string[] = [];
  for (const table of plan.tables) {
    const how = table.exists ? `${table.action}, exists` : 'create';
    const rows = table.rows !== undefined ? `, about ${plural(table.rows, 'row')}` : '';
    lines.push(
      `${table.source} → ${table.target} (${table.kind === 'keys' ? 'keys' : how}${rows})`,
    );
    const width = Math.max(0, ...table.columns.map((c) => c.source.length));
    const typeWidth = Math.max(0, ...table.columns.map((c) => c.sourceType.length));
    for (const column of table.columns) {
      if (column.target === '') {
        lines.push(
          `  ${column.source.padEnd(width)}  ${column.sourceType.padEnd(typeWidth)}  (${column.shape === 'child' ? 'child table' : 'flattened'})`,
        );
        continue;
      }
      const renamed = column.target !== column.source ? ` ${column.target}` : '';
      const skipped = column.skipped ? '  (skipped)' : '';
      const note = column.note !== undefined && !column.skipped ? `  — ${column.note}` : '';
      lines.push(
        `  ${column.source.padEnd(width)}  ${column.sourceType.padEnd(typeWidth)}  →${renamed} ${column.targetType}${skipped}${note}`,
      );
    }
    for (const problem of table.problems) lines.push(`  ✗ ${problem}`);
    for (const warning of table.warnings) lines.push(`  ! ${warning}`);
  }
  if (plan.destructive.length > 0) {
    lines.push('', 'Dropped, emptied or overwritten:', ...plan.destructive.map((d) => `  ${d}`));
  }
  if (plan.before.length > 0)
    lines.push('', '-- Before the data', ...plan.before.map((s) => `${s};`));
  if (plan.after.length > 0) lines.push('', '-- After the data', ...plan.after.map((s) => `${s};`));
  return lines.join('\n');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function errorLine(error: DbTransferSummary['errors'][number]): string {
  return `${error.table !== undefined ? `${error.table}: ` : ''}${describeRowError(error)}`;
}

// ---------------------------------------------------------------------------------------------
// The command

/** The progress line: phase, tables done, rows, rate, the tables in flight, elapsed time. */
function progressLine(progress: DbTransferProgress, unit: string): string {
  const tables = progress.tables > 0 ? ` ${progress.tablesDone}/${progress.tables}` : '';
  const skipped =
    progress.rowsSkipped > 0 ? `, ${progress.rowsSkipped.toLocaleString('en-US')} skipped` : '';
  const rate =
    progress.rowsPerSecond > 0
      ? ` · ${progress.rowsPerSecond.toLocaleString('en-US')} ${unit}/s`
      : '';
  const current = progress.current.length > 0 ? ` · ${progress.current.join(', ')}` : '';
  return `${progress.phase}${tables} · ${progress.rowsWritten.toLocaleString('en-US')} ${unit}${skipped}${rate}${current} · ${formatDuration(progress.elapsedMs)}`;
}

/**
 * The write rules on the target (spec §12): whatever is dropped, emptied or overwritten always
 * needs a confirmation; a production or "confirm writes" profile confirms any transfer, listing
 * what is created. --yes answers.
 */
async function confirmPlan(
  runtime: Runtime,
  target: Target,
  plan: TransferPlan,
  yes: boolean,
): Promise<void> {
  const { reporter } = runtime;
  const { policy } = target;
  const deps = { yes, prompter: runtime.ctx.prompter, reporter };
  if (plan.destructive.length > 0) {
    if (!yes) for (const line of plan.destructive) reporter.print(`  ${line}`);
    await confirmOperation(
      `The transfer drops, empties or overwrites data on "${target.label}"${policy.production ? ' (production)' : ''}. Continue?`,
      deps,
    );
  } else if (policy.production || policy.confirmWrites) {
    if (!yes) for (const line of plan.creates) reporter.print(`  ${line}`);
    await confirmOperation(
      `Transfer into ${policy.production ? 'the production connection ' : ''}"${target.label}"?`,
      deps,
    );
  }
}

/** Runs `joinery transfer`; see the top of this file. */
export async function transferDbCommand(
  runtime: Runtime,
  sourceSpec: string,
  targetSpec: string,
  options: TransferDbOptions,
): Promise<ExitCode> {
  const { reporter } = runtime;
  const common = {
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.tunnel !== undefined ? { tunnel: options.tunnel } : {}),
  };
  const sourceTarget = await targetFor(runtime, sourceSpec, {
    ...common,
    ...(options.database !== undefined ? { database: options.database } : {}),
  });
  const targetTarget = await targetFor(runtime, targetSpec, {
    ...common,
    ...(options.targetDatabase !== undefined ? { database: options.targetDatabase } : {}),
  });
  const support = transferSupport(sourceTarget.profile.engine, targetTarget.profile.engine);
  if (!support.supported) {
    throw new CliError(support.reason ?? 'This transfer is not supported', {
      code: 'NOT_SUPPORTED',
    });
  }
  const redis = sourceTarget.profile.engine === 'redis';
  const unit = redis ? 'keys' : 'rows';
  if (redis && options.patterns.length === 0) {
    throw new CliError('Name the keys to copy with --pattern', {
      hint: "--pattern '*' copies every key",
    });
  }
  if (!redis && options.objects.length === 0 && !options.all) {
    const what = sourceTarget.profile.engine === 'mongodb' ? 'collections' : 'tables';
    throw new CliError(`Name the ${what} to transfer`, {
      hint: 'Use --table (repeatable) or --all',
    });
  }
  if (targetTarget.policy.readOnly && !options.dryRun) {
    throw new CliError(`"${targetTarget.label}" is read-only; nothing can be transferred into it`, {
      code: 'READ_ONLY',
      hint:
        targetTarget.readOnlySource === 'flag'
          ? 'Writes are refused because --read-only was given'
          : 'The profile is locked read-only; unlock it in the app or use another profile',
    });
  }
  runtime.interrupts.throwIfInterrupted();

  const source = await openSide(runtime, sourceTarget, options.tunnel);
  let target: Side | undefined;
  try {
    target = await openSide(runtime, targetTarget, options.tunnel);
    const sourceEngine = source.first.session.engine;
    const sameConnection =
      sourceSpec === targetSpec && (options.database ?? '') === (options.targetDatabase ?? '');
    const named = objectNames(options, sourceEngine);
    const objects = options.all
      ? await allObjects(source.first.session, options.database, named.schema)
      : named.names;
    if (!redis && objects.length === 0) {
      throw new CliError('There is nothing to transfer: the source has no tables or collections');
    }
    const spec = buildSpec(options, sourceEngine, objects, named.schema);
    reporter.progress('Planning the transfer…', true);
    const plan = await planDbTransfer({
      spec,
      source: source.first.session,
      target: target.first.session,
      sameConnection,
    }).finally(() => reporter.clearProgress());

    if (options.dryRun) {
      await writeLine(
        runtime,
        options.json ? JSON.stringify(plan, jsonReplacer, 2) : planText(plan),
      );
      for (const problem of plan.problems) reporter.error([`error: ${problem}`]);
      return plan.problems.length > 0 ? EXIT.error : EXIT.ok;
    }
    if (plan.problems.length > 0) {
      throw new CliError(
        plan.problems.length === 1
          ? plan.problems[0]!
          : `The transfer cannot run: ${plan.problems.join('; ')}`,
        { hint: 'See the whole plan with --dry-run' },
      );
    }
    for (const warning of plan.warnings) reporter.warn(warning);
    await confirmPlan(runtime, target.target, plan, options.yes);
    const confirmed = new Set(plan.destructive);

    const controller = new AbortController();
    const summary = await runtime.interrupts
      .guard(
        () => controller.abort(),
        () =>
          runDbTransfer({
            spec,
            source: source.open,
            target: target!.open,
            sameConnection,
            signal: controller.signal,
            // The transfer plans again on its own: whatever became destructive since the plan
            // was confirmed needs its own yes.
            onPlan: (fresh) => {
              const unconfirmed = fresh.destructive.filter((line) => !confirmed.has(line));
              if (unconfirmed.length > 0 && !options.yes) {
                throw new CliError(`Not confirmed: ${unconfirmed.join('; ')}`, {
                  code: 'CONFIRMATION_REQUIRED',
                  hint: 'The target changed since the plan; run again to see the new plan',
                });
              }
            },
            onProgress: (progress) => reporter.progress(progressLine(progress, unit)),
            onLog: (level, message) => {
              if (level === 'warning') reporter.warn(message);
              else reporter.debug(message);
            },
          }),
      )
      .finally(() => reporter.clearProgress());

    if (options.errorLog !== undefined) {
      writeFileSync(
        resolve(runtime.ctx.cwd, options.errorLog),
        summary.errors.map((error) => `${errorLine(error)}\n`).join(''),
      );
    }
    const label = summary.status === 'completed' ? 'skipped' : 'error';
    for (const error of summary.errors.slice(0, SHOWN_ERRORS)) {
      reporter.print(`${label}: ${errorLine(error)}`);
    }
    if (summary.errors.length > SHOWN_ERRORS) {
      const more = plural(summary.errors.length - SHOWN_ERRORS, 'more error');
      reporter.print(
        `… ${more}${options.errorLog !== undefined ? ` in ${options.errorLog}` : ' (see them all with --error-log)'}`,
      );
    }
    if (options.json) await writeLine(runtime, JSON.stringify(summary, jsonReplacer, 2));
    if (summary.status === 'cancelled') throw new InterruptedError();
    const moved = plural(summary.rowsWritten, redis ? 'key' : 'row');
    if (summary.status === 'failed') {
      const done = summary.tables.filter((t) => t.status === 'completed').length;
      reporter.print(
        `Transfer failed after ${moved}; ${done} of ${plural(summary.tables.length, redis ? 'pattern' : 'table')} finished`,
      );
      return EXIT.error;
    }
    const engine = ENGINES[target.first.session.engine].displayName;
    const perSecond =
      summary.durationMs > 0
        ? `, ${Math.round((summary.rowsWritten * 1000) / summary.durationMs).toLocaleString('en-US')} ${unit}/s`
        : '';
    const skipped =
      summary.rowsSkipped > 0
        ? `; ${plural(summary.rowsSkipped, redis ? 'key' : 'row')} skipped`
        : '';
    reporter.info(
      `Transferred ${moved} into ${engine} "${target.target.label}" in ${formatDuration(summary.durationMs)}${perSecond}${skipped}`,
    );
    return summary.rowsSkipped > 0 || summary.errors.length > 0 ? EXIT.partial : EXIT.ok;
  } finally {
    await target?.first.close().catch(() => undefined);
    await source.first.close().catch(() => undefined);
  }
}
