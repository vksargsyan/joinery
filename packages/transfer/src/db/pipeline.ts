import { JoineryError, type Session } from '@joinery/core';

import type { RowError, TransferStatus } from '../types';
import type {
  DbTransferError,
  DbTransferOptions,
  DbTransferProgress,
  DbTransferSummary,
  DbTransferTableSummary,
  OpenedSession,
  SessionOpener,
  TransferPlan,
} from './spec';

/**
 * The one streaming pipeline every transfer runs through (spec §12, ADR 0006): an engine pair
 * turns the request into an `Execution` (a plan plus units of work), and `runExecution` drives
 * it: prepare the target, load the units side by side on their own sessions (bounded by
 * `parallel`), finish each table as its data lands, then add what joins tables. A new target
 * engine is a new `Execution` builder; nothing here knows about engines.
 */

export type LogLevel = 'info' | 'warning' | 'error';

export interface UnitCounts {
  readonly read: number;
  readonly written: number;
  readonly skipped: number;
}

export interface UnitResult extends UnitCounts {
  readonly status: TransferStatus;
  readonly errors: readonly RowError[];
}

/** What a unit of work gets: its own source and target sessions. */
export interface UnitContext {
  readonly source: Session;
  readonly target: Session;
  /** Another source session, for lookups while `source` streams (opened on first use). */
  lookup(): Promise<Session>;
  readonly options: DbTransferOptions;
  readonly signal: AbortSignal;
  /** Reports this unit's counts so far (cumulative). */
  progress(counts: UnitCounts): void;
  log(level: LogLevel, message: string): void;
}

/** One table, collection or key pattern to move. */
export interface TransferUnit {
  readonly source: string;
  readonly target: string;
  load(context: UnitContext): Promise<UnitResult>;
  /**
   * After a completed load, on the same target session: keys, indexes, counters. A failure is
   * reported as an error of the table; the data stays.
   */
  finish?(context: UnitContext): Promise<void>;
}

export interface ExecutionContext {
  readonly options: DbTransferOptions;
  readonly signal: AbortSignal;
  log(level: LogLevel, message: string): void;
}

/** A planned transfer, ready to run. */
export interface Execution {
  readonly plan: TransferPlan;
  /** Every source session the transfer opens (time zone...). */
  setupSource?(session: Session): Promise<void>;
  /** Every target session; returns what undoes it before the session is released. */
  setupTarget?(session: Session, context: ExecutionContext): Promise<(() => Promise<void>) | void>;
  /** Before any data, on the control target session: drops, creates, truncates. */
  prepare?(target: Session, context: ExecutionContext): Promise<void>;
  readonly units: readonly TransferUnit[];
  /**
   * After the units, on the control target session, with the targets that completed: foreign
   * keys between them. Returns what failed.
   */
  complete?(
    target: Session,
    completed: ReadonlySet<string>,
    context: ExecutionContext,
  ): Promise<DbTransferError[]>;
}

export interface RunExecutionOptions {
  readonly execution: Execution;
  /** The sessions the plan was made on; reused for prepare, complete and the first worker. */
  readonly control: { readonly source: OpenedSession; readonly target: OpenedSession };
  readonly openSource: SessionOpener;
  readonly openTarget: SessionOpener;
  readonly options: DbTransferOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DbTransferProgress) => void;
  readonly onLog?: (level: LogLevel, message: string) => void;
  readonly progressIntervalMs?: number;
  /** Errors kept in the summary (default 1000); the counts include every one. */
  readonly errorLogLimit?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Aggregates the units' counts and emits progress at most every `interval` ms. */
class ProgressMeter {
  readonly #counts = new Map<TransferUnit, UnitCounts>();
  readonly #current = new Set<string>();
  #phase = 'Starting';
  #done = 0;
  #last = 0;
  readonly #started = performance.now();

  constructor(
    private readonly total: number,
    private readonly interval: number,
    private readonly emit: ((progress: DbTransferProgress) => void) | undefined,
  ) {}

  phase(phase: string): void {
    this.#phase = phase;
    this.report(true);
  }

  start(unit: TransferUnit): void {
    this.#current.add(unit.target);
    this.report(true);
  }

  update(unit: TransferUnit, counts: UnitCounts): void {
    this.#counts.set(unit, counts);
    this.report(false);
  }

  finish(unit: TransferUnit): void {
    this.#current.delete(unit.target);
    this.#done++;
    this.report(true);
  }

  totals(): UnitCounts {
    let read = 0;
    let written = 0;
    let skipped = 0;
    for (const c of this.#counts.values()) {
      read += c.read;
      written += c.written;
      skipped += c.skipped;
    }
    return { read, written, skipped };
  }

  report(force: boolean): void {
    if (this.emit === undefined) return;
    const now = performance.now();
    if (!force && now - this.#last < this.interval) return;
    this.#last = now;
    const { read, written, skipped } = this.totals();
    const elapsedMs = Math.round(now - this.#started);
    this.emit({
      phase: this.#phase,
      tables: this.total,
      tablesDone: this.#done,
      current: [...this.#current],
      rowsRead: read,
      rowsWritten: written,
      rowsSkipped: skipped,
      elapsedMs,
      rowsPerSecond: elapsedMs > 0 ? Math.round((written * 1000) / elapsedMs) : 0,
    });
  }
}

/** A worker's sessions: opened on first use, set up once, released at the end. */
class WorkerSessions {
  #source: OpenedSession | undefined;
  #target: OpenedSession | undefined;
  #lookup: OpenedSession | undefined;
  #restore: (() => Promise<void>) | undefined;
  #sourceReady = false;

  constructor(
    private readonly run: RunExecutionOptions,
    private readonly context: ExecutionContext,
    reuse?: { source: OpenedSession; target: OpenedSession },
  ) {
    this.#source = reuse?.source;
    this.#target = reuse?.target;
    this.owned = reuse === undefined;
  }

  readonly owned: boolean;

  async source(): Promise<Session> {
    this.#source ??= await this.run.openSource();
    if (!this.#sourceReady) {
      this.#sourceReady = true;
      await this.run.execution.setupSource?.(this.#source.session);
    }
    return this.#source.session;
  }

  async target(): Promise<Session> {
    if (this.#target === undefined || this.#restore === undefined) {
      this.#target ??= await this.run.openTarget();
      const restore = await this.run.execution.setupTarget?.(this.#target.session, this.context);
      this.#restore = restore ?? (async () => undefined);
    }
    return this.#target.session;
  }

  async lookup(): Promise<Session> {
    if (this.#lookup === undefined) {
      this.#lookup = await this.run.openSource();
      await this.run.execution.setupSource?.(this.#lookup.session);
    }
    return this.#lookup.session;
  }

  /** Undoes the target setup; closes what this worker opened. */
  async release(): Promise<void> {
    await this.#restore?.().catch(() => undefined);
    this.#restore = undefined;
    await this.#lookup?.close().catch(() => undefined);
    if (this.owned) {
      await this.#source?.close().catch(() => undefined);
      await this.#target?.close().catch(() => undefined);
    }
  }
}

/**
 * Runs a planned transfer. Resolves with a summary for every runtime outcome; the caller
 * closes the control sessions.
 */
export async function runExecution(run: RunExecutionOptions): Promise<DbTransferSummary> {
  const { execution, options } = run;
  const started = performance.now();
  const errorLimit = run.errorLogLimit ?? 1000;
  const errors: DbTransferError[] = [];
  const stop = new AbortController();
  const signal = run.signal ? AbortSignal.any([run.signal, stop.signal]) : stop.signal;
  const log = (level: LogLevel, message: string): void => run.onLog?.(level, message);
  const context: ExecutionContext = { options, signal, log };
  const meter = new ProgressMeter(
    execution.units.length,
    run.progressIntervalMs ?? 250,
    run.onProgress,
  );
  const tables: DbTransferTableSummary[] = [];
  const completed = new Set<string>();
  let failed = false;
  const addError = (error: DbTransferError): void => {
    if (errors.length < errorLimit) errors.push(error);
  };

  const control = new WorkerSessions(run, context, run.control);
  try {
    meter.phase('Preparing the target');
    const target = await control.target();
    await control.source();
    await execution.prepare?.(target, context);
  } catch (error) {
    await control.release();
    const cancelled = run.signal?.aborted === true;
    if (!cancelled) addError({ message: messageOf(error) });
    return {
      status: cancelled ? 'cancelled' : 'failed',
      rowsRead: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      durationMs: Math.round(performance.now() - started),
      tables: [],
      errors,
    };
  }

  meter.phase('Transferring');
  const queue = [...execution.units];
  const workerCount = Math.max(1, Math.min(options.parallel, queue.length));
  const work = async (sessions: WorkerSessions): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const unit = queue.shift();
      if (unit === undefined) return;
      const unitStarted = performance.now();
      meter.start(unit);
      log(
        'info',
        `Transferring ${unit.source}${unit.source === unit.target ? '' : ` into ${unit.target}`}`,
      );
      let result: UnitResult;
      let unitContext: UnitContext | undefined;
      try {
        unitContext = {
          source: await sessions.source(),
          target: await sessions.target(),
          lookup: () => sessions.lookup(),
          options,
          signal,
          progress: (counts) => meter.update(unit, counts),
          log,
        };
        result = await unit.load(unitContext);
      } catch (error) {
        const cancelled = signal.aborted;
        result = {
          status: cancelled ? 'cancelled' : 'failed',
          read: 0,
          written: 0,
          skipped: 0,
          errors: cancelled ? [] : [{ message: messageOf(error) }],
        };
      }
      meter.update(unit, result);
      for (const error of result.errors) addError({ ...error, table: unit.target });
      if (result.status === 'completed' && unitContext !== undefined && unit.finish !== undefined) {
        try {
          await unit.finish(unitContext);
        } catch (error) {
          addError({ table: unit.target, message: messageOf(error) });
          log('error', `${unit.target}: ${messageOf(error)}`);
        }
      }
      if (result.status === 'completed') completed.add(unit.target);
      const skipped =
        result.skipped > 0 ? `, ${result.skipped.toLocaleString('en-US')} skipped` : '';
      log(
        result.status === 'completed' ? 'info' : 'error',
        `${unit.target}: ${result.status === 'completed' ? 'copied' : result.status} ${result.written.toLocaleString('en-US')} of ${result.read.toLocaleString('en-US')} rows${skipped}`,
      );
      tables.push({
        source: unit.source,
        target: unit.target,
        status: result.status,
        rowsRead: result.read,
        rowsWritten: result.written,
        rowsSkipped: result.skipped,
        durationMs: Math.round(performance.now() - unitStarted),
      });
      meter.finish(unit);
      if (result.status !== 'completed') {
        failed = failed || result.status === 'failed';
        // A table that stopped (on error, or cancelled) stops the others.
        stop.abort();
        return;
      }
    }
  };

  const workers: WorkerSessions[] = [control];
  for (let i = 1; i < workerCount; i++) workers.push(new WorkerSessions(run, context));
  await Promise.all(
    workers.map((sessions) =>
      work(sessions).catch((error: unknown) => {
        failed = true;
        addError({ message: messageOf(error) });
        stop.abort();
      }),
    ),
  );
  for (const worker of workers.slice(1)) await worker.release();

  if (!signal.aborted && execution.complete !== undefined) {
    meter.phase('Adding foreign keys');
    try {
      const target = await control.target();
      for (const error of await execution.complete(target, completed, context)) {
        addError(error);
        log('error', error.message);
      }
    } catch (error) {
      addError({ message: messageOf(error) });
    }
  }
  await control.release();

  const everyTable =
    tables.length === execution.units.length && tables.every((t) => t.status === 'completed');
  const status: TransferStatus = failed ? 'failed' : everyTable ? 'completed' : 'cancelled';
  meter.phase(status === 'completed' ? 'Done' : status === 'cancelled' ? 'Cancelled' : 'Failed');
  const totals = tables.reduce(
    (sum, t) => ({
      read: sum.read + t.rowsRead,
      written: sum.written + t.rowsWritten,
      skipped: sum.skipped + t.rowsSkipped,
    }),
    { read: 0, written: 0, skipped: 0 },
  );
  return {
    status,
    rowsRead: totals.read,
    rowsWritten: totals.written,
    rowsSkipped: totals.skipped,
    durationMs: Math.round(performance.now() - started),
    tables,
    errors,
  };
}

/** Throws the plan's problems before anything runs. */
export function assertRunnable(plan: TransferPlan): void {
  if (plan.problems.length === 0) return;
  throw new JoineryError({
    code: 'VALIDATION_FAILED',
    message:
      plan.problems.length === 1
        ? plan.problems[0]!
        : `The transfer cannot run: ${plan.problems.join('; ')}`,
  });
}
