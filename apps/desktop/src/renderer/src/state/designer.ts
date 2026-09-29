import {
  JoineryError,
  isSqlEngine,
  type SchemaSnapshot,
  type SqlEngineId,
  type TableDef,
} from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { safetyPolicyFor } from '@joinery/sql-tools';
import {
  designDropTable,
  designTable,
  type DesignContext,
  type TableDesign,
  type ValidationIssue,
} from '@joinery/sync';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../lib/errors';
import { tableDiagnostics } from '../lib/language';
import { useConnections } from './connections';
import { profileById } from './data';
import { confirmRun } from './dialogs';
import {
  formFromTable,
  isDirty,
  newTableForm,
  renamesOf,
  tableFromForm,
  type DesignerForm,
} from './designer/form';
import { describeScriptFailure } from './designer/review';
import { loadChildren } from './explorer';
import { findTable, invalidateMetadata, loadSnapshot, metadataLane } from './metadata';
import { panelKey, patchPanel } from './panels';
import { SessionLane, collect, type QueryResult } from './session-lane';
import { writeGate } from './table/apply-flow';

/**
 * The table designer (spec §8): the live table from the metadata cache, the form being edited,
 * and the design `designTable` computes from them — script, warnings, data-loss analysis and
 * validation — recomputed shortly after each change, with the expressions parsed in a worker.
 * Save runs the reviewed script on the designer's own session (PostgreSQL in one transaction),
 * then refreshes the metadata, the explorer and the designer itself from the server.
 */

export interface DesignerTarget {
  readonly profileId: string;
  /** PostgreSQL: the database (sessions connect to it); MySQL/MariaDB: the table's database. */
  readonly database: string | undefined;
  /** PostgreSQL schema; the database on MySQL/MariaDB. */
  readonly schema: string;
  /** The live table, or null to design a new one. */
  readonly name: string | null;
  /** The explorer folder that lists the schema's tables, refreshed after a save. */
  readonly tablesPath?: readonly string[];
}

export type DesignerTab =
  | 'columns'
  | 'indexes'
  | 'foreign-keys'
  | 'uniques'
  | 'checks'
  | 'triggers'
  | 'partitions'
  | 'options'
  | 'comment'
  | 'sql';

export interface DesignerState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: string | undefined;
  readonly engine: SqlEngineId | undefined;
  readonly serverVersion: string | undefined;
  readonly partitionsSupported: boolean;
  readonly snapshot: SchemaSnapshot | undefined;
  /** The table on the server; null while designing a new one. */
  readonly live: TableDef | null;
  readonly initial: DesignerForm | undefined;
  readonly form: DesignerForm | undefined;
  readonly tab: DesignerTab;
  /** The column row the details pane shows. */
  readonly selectedColumn: string | undefined;
  /** The design of the current form (a moment after the last change). */
  readonly design: TableDesign | undefined;
  /** Syntax errors from the expression parser. */
  readonly syntaxIssues: readonly ValidationIssue[];
  readonly saving: boolean;
  readonly notice: { readonly kind: 'success' | 'error'; readonly text: string } | undefined;
}

export type ScriptOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly cancelled: false; readonly message: string };

const DESIGN_DELAY_MS = 120;
const DIAGNOSE_DELAY_MS = 500;

/** A table name not used in the schema yet: new_table, new_table_2... */
function freshTableName(snapshot: SchemaSnapshot, schema: string): string {
  const home = snapshot.schemas.find((s) => s.name === schema) ?? snapshot.schemas[0];
  const taken = new Set([
    ...(home?.tables.map((t) => t.name) ?? []),
    ...(home?.views.map((v) => v.name) ?? []),
  ]);
  if (!taken.has('new_table')) return 'new_table';
  for (let n = 2; ; n++) if (!taken.has(`new_table_${n}`)) return `new_table_${n}`;
}

/**
 * Runs a reviewed DDL script statement by statement on `lane`, after the write-safety rules.
 * The script's own BEGIN/COMMIT make it one transaction on PostgreSQL; a failure there rolls
 * back. MySQL and MariaDB commit each DDL statement, which the failure message says.
 */
export async function runScript(
  lane: SessionLane,
  profile: StoredProfile,
  engine: SqlEngineId,
  statements: readonly string[],
  transactional: boolean,
): Promise<ScriptOutcome> {
  const gate = writeGate(statements, engine, safetyPolicyFor(profile));
  if (gate.action === 'refuse') return { ok: false, cancelled: false, message: gate.message };
  if (gate.action === 'confirm') {
    const ok = await confirmRun(gate.statements, profile.presentation.environment === 'production');
    if (!ok) return { ok: false, cancelled: true };
  }
  return lane.run(async (host, sessionId) => {
    for (let i = 0; i < statements.length; i++) {
      try {
        await collect(host, sessionId, { sql: statements[i]! });
      } catch (error) {
        if (transactional) await host.rollback({ sessionId }).catch(() => undefined);
        return {
          ok: false,
          cancelled: false,
          message: describeScriptFailure(i, statements.length, transactional, errorInfo(error)),
        } as const;
      }
    }
    return { ok: true } as const;
  });
}

export class TableDesigner {
  readonly id: string;
  target: DesignerTarget;
  readonly store: StoreApi<DesignerState>;
  readonly #lane: SessionLane;
  #designTimer: ReturnType<typeof setTimeout> | undefined;
  #diagnoseTimer: ReturnType<typeof setTimeout> | undefined;
  #diagnoseRun = 0;

  constructor(id: string, target: DesignerTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<DesignerState>()(() => ({
      status: 'loading',
      error: undefined,
      engine: undefined,
      serverVersion: undefined,
      partitionsSupported: false,
      snapshot: undefined,
      live: null,
      initial: undefined,
      form: undefined,
      tab: 'columns',
      selectedColumn: undefined,
      design: undefined,
      syntaxIssues: [],
      saving: false,
      notice: undefined,
    }));
    // Scripts name the table the way the snapshot does: MySQL unqualified, so the session
    // must be in the table's database on every engine.
    this.#lane = new SessionLane(target.profileId, target.database);
  }

  get state(): DesignerState {
    return this.store.getState();
  }

  #set(patch: Partial<DesignerState>): void {
    this.store.setState(patch);
  }

  /** The design context for the engine: where the table lives and what surrounds it. */
  context(form: DesignerForm): DesignContext {
    const s = this.state;
    return {
      engine: s.engine!,
      ...(s.serverVersion !== undefined ? { serverVersion: s.serverVersion } : {}),
      schema: this.target.schema,
      ...(s.snapshot ? { snapshot: s.snapshot } : {}),
      renames: renamesOf(form),
    };
  }

  async init(): Promise<void> {
    this.#set({ status: 'loading', error: undefined });
    try {
      const profile = await profileById(this.target.profileId);
      if (!profile)
        throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
      if (!isSqlEngine(profile.engine)) {
        throw new JoineryError({
          code: 'NOT_SUPPORTED',
          message: 'The table designer needs a SQL connection',
        });
      }
      const connection = useConnections.getState().byProfile[this.target.profileId];
      this.#set({
        engine: profile.engine,
        serverVersion: connection?.info?.serverVersion,
        partitionsSupported: connection?.info?.capabilities.partitions ?? false,
      });
      await this.#loadLive(this.target.name);
    } catch (error) {
      this.#set({ status: 'error', error: errorMessage(error) });
    }
  }

  /** Loads the table from a fresh snapshot and resets the form to it. */
  async #loadLive(name: string | null): Promise<void> {
    const engine = this.state.engine!;
    const snapshot = await loadSnapshot(this.target.profileId, {
      dialect: engine,
      ...(this.target.database !== undefined ? { database: this.target.database } : {}),
    });
    let live: TableDef | null = null;
    let form: DesignerForm;
    if (name !== null) {
      live = findTable(snapshot, this.target.schema, name) ?? null;
      if (!live) {
        throw new JoineryError({
          code: 'NOT_FOUND',
          message: `Table ${this.target.schema}.${name} was not found; it may have been dropped or renamed`,
        });
      }
      form = formFromTable(live, engine, { live: true });
    } else {
      form = newTableForm(engine, freshTableName(snapshot, this.target.schema), {
        ...(snapshot.options['charset'] !== undefined
          ? { charset: snapshot.options['charset'] }
          : {}),
        ...(snapshot.options['collation'] !== undefined
          ? { collation: snapshot.options['collation'] }
          : {}),
      });
    }
    this.#set({
      status: 'ready',
      snapshot,
      live,
      initial: form,
      form,
      selectedColumn: form.columns[0]?.id,
      syntaxIssues: [],
      design: undefined,
    });
    patchPanel(this.id, {
      title: name === null ? `New table` : `${name} (design)`,
      dirty: false,
    });
    this.#recompute(true);
  }

  setTab(tab: DesignerTab): void {
    this.#set({ tab });
  }

  selectColumn(id: string | undefined): void {
    this.#set({ selectedColumn: id });
  }

  /** Replaces the form (every edit goes through here) and schedules the design. */
  setForm(form: DesignerForm): void {
    const initial = this.state.initial;
    this.#set({ form, notice: undefined });
    patchPanel(this.id, {
      dirty: initial ? isDirty(form, initial) : false,
    });
    this.#recompute(false);
  }

  /** Undoes every edit since the table was loaded. */
  revert(): void {
    const initial = this.state.initial;
    if (initial) this.setForm(initial);
  }

  /** The design for the current form right now (Save uses it, not the delayed one). */
  designNow(): TableDesign | undefined {
    const s = this.state;
    if (!s.form || !s.engine) return undefined;
    const design = designTable(s.live, tableFromForm(s.form), this.context(s.form));
    this.#set({ design });
    return design;
  }

  #recompute(immediate: boolean): void {
    clearTimeout(this.#designTimer);
    clearTimeout(this.#diagnoseTimer);
    const run = (): void => {
      try {
        this.designNow();
      } catch (error) {
        this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      }
    };
    if (immediate) run();
    else this.#designTimer = setTimeout(run, DESIGN_DELAY_MS);
    this.#diagnoseTimer = setTimeout(() => void this.#diagnose(), DIAGNOSE_DELAY_MS);
  }

  async #diagnose(): Promise<void> {
    const s = this.state;
    if (!s.form || !s.engine) return;
    const run = ++this.#diagnoseRun;
    const issues = await tableDiagnostics(tableFromForm(s.form), s.engine, this.target.schema);
    if (run === this.#diagnoseRun) this.#set({ syntaxIssues: issues });
  }

  /** Runs a data-loss check or find query (they use the live names, before saving). */
  query(sql: string): Promise<QueryResult> {
    return this.#lane.run((host, sessionId) => collect(host, sessionId, { sql }));
  }

  /**
   * Save: runs the reviewed design's statements. On success the metadata and the explorer
   * refresh and the designer reloads the table as the server now has it.
   */
  async save(design: TableDesign): Promise<ScriptOutcome> {
    // Read again: the profile may have become read-only or production since the view opened.
    const profile = await profileById(this.target.profileId);
    const engine = this.state.engine;
    if (!profile || !engine) {
      return { ok: false, cancelled: false, message: 'The connection was deleted' };
    }
    this.#set({ saving: true, notice: undefined });
    patchPanel(this.id, { busy: true });
    try {
      const outcome = await runScript(
        this.#lane,
        profile,
        engine,
        design.statements,
        design.transactional,
      );
      if (outcome.ok) {
        const name = design.table.name;
        this.target = { ...this.target, name };
        patchPanel(this.id, { key: panelKey('design', { ...this.target, name }) });
        invalidateMetadata(this.target.profileId);
        if (this.target.tablesPath)
          void loadChildren(this.target.profileId, this.target.tablesPath);
        await this.#loadLive(name);
        this.#set({ notice: { kind: 'success', text: `Saved ${name}` } });
      } else if (!outcome.cancelled) {
        // A failed non-transactional script may have changed the table part-way.
        if (!design.transactional) invalidateMetadata(this.target.profileId);
      }
      return outcome;
    } catch (error) {
      return { ok: false, cancelled: false, message: errorMessage(error) };
    } finally {
      this.#set({ saving: false });
      patchPanel(this.id, { busy: false });
    }
  }

  /** Reloads the live table (after a change made elsewhere); unsaved edits are dropped. */
  async reload(): Promise<void> {
    try {
      invalidateMetadata(this.target.profileId);
      await this.#loadLive(this.target.name);
    } catch (error) {
      this.#set({ status: 'error', error: errorMessage(error) });
    }
  }

  async dispose(): Promise<void> {
    clearTimeout(this.#designTimer);
    clearTimeout(this.#diagnoseTimer);
    await this.#lane.close();
  }
}

/** The drop-table script and its issues for a live table (explorer "Drop table…"). */
export async function designTableDrop(target: DesignerTarget & { readonly name: string }): Promise<{
  readonly design: TableDesign;
  readonly profile: StoredProfile;
  readonly engine: SqlEngineId;
}> {
  const profile = await profileById(target.profileId);
  if (!profile || !isSqlEngine(profile.engine)) {
    throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
  }
  const engine = profile.engine;
  const snapshot = await loadSnapshot(target.profileId, {
    dialect: engine,
    ...(target.database !== undefined ? { database: target.database } : {}),
  });
  const live = findTable(snapshot, target.schema, target.name);
  if (!live) {
    throw new JoineryError({
      code: 'NOT_FOUND',
      message: `Table ${target.schema}.${target.name} was not found`,
    });
  }
  const serverVersion = useConnections.getState().byProfile[target.profileId]?.info?.serverVersion;
  const design = designDropTable(live, {
    engine,
    schema: target.schema,
    snapshot,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
  });
  return { design, profile, engine };
}

/** Runs a data-loss check or find query for a table (in its database, before any change). */
export function queryForTable(target: DesignerTarget, sql: string): Promise<QueryResult> {
  return metadataLane(target.profileId, target.database).run((host, sessionId) =>
    collect(host, sessionId, { sql }),
  );
}

/** Runs a reviewed drop on a short-lived session, then refreshes the metadata and explorer. */
export async function dropTable(
  target: DesignerTarget & { readonly name: string },
  design: TableDesign,
  profile: StoredProfile,
  engine: SqlEngineId,
): Promise<ScriptOutcome> {
  const lane = new SessionLane(target.profileId, target.database);
  try {
    const outcome = await runScript(lane, profile, engine, design.statements, design.transactional);
    if (outcome.ok) {
      invalidateMetadata(target.profileId);
      if (target.tablesPath) void loadChildren(target.profileId, target.tablesPath);
    }
    return outcome;
  } catch (error) {
    return { ok: false, cancelled: false, message: errorMessage(error) };
  } finally {
    await lane.close();
  }
}

const designers = new Map<string, TableDesigner>();

export function createDesigner(id: string, target: DesignerTarget): TableDesigner {
  const designer = new TableDesigner(id, target);
  designers.set(id, designer);
  void designer.init();
  return designer;
}

export function getDesigner(id: string): TableDesigner | undefined {
  return designers.get(id);
}

export async function disposeDesigner(id: string): Promise<void> {
  const designer = designers.get(id);
  designers.delete(id);
  await designer?.dispose();
}

export function useDesignerState<T>(
  designer: TableDesigner,
  selector: (state: DesignerState) => T,
): T {
  return useStore(designer.store, selector);
}
