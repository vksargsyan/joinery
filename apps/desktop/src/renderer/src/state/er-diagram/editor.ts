import { isSqlEngine, type SchemaSnapshot } from '@joinery/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { profileById } from '../data';
import { runScript } from '../designer';
import { invalidateMetadata } from '../metadata';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import {
  EditError,
  addColumn,
  addRelation,
  addTable,
  dropColumn,
  dropRelation,
  dropTable,
  editedSchema,
  modelChanges,
  moveColumn,
  renameTable,
  setTableComment,
  startModel,
  togglePrimaryKey,
  toggleUnique,
  updateColumn,
  updateRelation,
  type AddRelationInput,
  type ColumnPatch,
  type EditContext,
  type ModelChanges,
  type ModelState,
  type RelationPatch,
} from './edit';
import { modelScript, validateModel, type ModelIssue, type ModelScript } from './forward';
import type { Point } from '../query-builder/layout';
import type { ErDiagramView } from './view';

/**
 * Editing an ER diagram's schema as a model (spec §8, forward engineering): the model, its
 * undo and redo history, what it changes against the live schema it started from (marked on
 * the canvas), the table designer's validation of the changed tables, and Review & apply,
 * which shows the structure compare's script and runs it on the connection with the same
 * write-safety rules as the table designer. The live schema is not reread while editing: if
 * it changes on the server, the editor says so, and the script still says only what the model
 * changes.
 */

export interface EditorState {
  readonly model: ModelState;
  readonly changes: ModelChanges;
  readonly issues: readonly ModelIssue[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The live schema changed on the server since editing started. */
  readonly stale: boolean;
  /** The script under review, while the review is open. */
  readonly review: ModelScript | undefined;
  readonly applying: boolean;
  /** A column whose name field should take the focus (just added). */
  readonly focusColumn: { readonly table: string; readonly column: string } | undefined;
}

const HISTORY = 200;

export class ErModelEditor {
  readonly view: ErDiagramView;
  readonly context: EditContext;
  /** The live database when editing started: what the script changes. */
  readonly base: SchemaSnapshot;
  readonly store: StoreApi<EditorState>;
  #past: ModelState[] = [];
  #future: ModelState[] = [];

  constructor(view: ErDiagramView, base: SchemaSnapshot, context: EditContext) {
    this.view = view;
    this.base = base;
    this.context = context;
    const model = startModel(base, context);
    this.store = createStore<EditorState>()(() => ({
      model,
      changes: modelChanges(model, base, context),
      issues: [],
      canUndo: false,
      canRedo: false,
      stale: false,
      review: undefined,
      applying: false,
      focusColumn: undefined,
    }));
  }

  get state(): EditorState {
    return this.store.getState();
  }

  #set(patch: Partial<EditorState>): void {
    this.store.setState(patch);
  }

  // -------------------------------------------------------------------------------------------
  // Changing the model

  /** Shows a model state: marks, validation, the canvas and the panel's unsaved flag. */
  #show(model: ModelState, extra: Partial<EditorState> = {}): void {
    const changes = modelChanges(model, this.base, this.context);
    this.#set({
      model,
      changes,
      issues: validateModel(model, this.base, this.context, this.base.serverVersion),
      canUndo: this.#past.length > 0,
      canRedo: this.#future.length > 0,
      ...extra,
    });
    patchPanel(this.view.id, { dirty: changes.count > 0 });
    void this.view.showModel(model.snapshot);
  }

  /**
   * Runs an edit; what the model refuses becomes the panel's notice. `placed` runs after a
   * successful edit and before the canvas redraws (to move a renamed table's box).
   */
  #edit<T>(
    change: (model: ModelState) => { state: ModelState; result: T },
    placed?: (result: T) => void,
  ): T | undefined {
    const current = this.state.model;
    try {
      const { state, result } = change(current);
      if (state === current) return result;
      this.#past = [...this.#past, current].slice(-HISTORY);
      this.#future = [];
      placed?.(result);
      this.#show(state);
      return result;
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      this.view.note({ kind: 'error', text: error.message });
      return undefined;
    }
  }

  #simple(change: (model: ModelState) => ModelState): boolean {
    return this.#edit((model) => ({ state: change(model), result: true })) === true;
  }

  undo(): void {
    const previous = this.#past.at(-1);
    if (!previous) return;
    this.#past = this.#past.slice(0, -1);
    this.#future = [this.state.model, ...this.#future];
    this.#show(previous);
  }

  redo(): void {
    const next = this.#future[0];
    if (!next) return;
    this.#future = this.#future.slice(1);
    this.#past = [...this.#past, this.state.model];
    this.#show(next);
  }

  /** Adds a table, where given or beside the diagram, and selects it. */
  addTable(at?: Point): string | undefined {
    const spot = at ?? this.view.spotBeside();
    const name = this.#edit(
      (model) => {
        const added = addTable(model, this.context);
        return { state: added.state, result: added.name };
      },
      (added) => this.view.move({ [this.view.tableIdOf(added)]: spot }),
    );
    if (name !== undefined) this.view.focus(this.view.tableIdOf(name));
    return name;
  }

  renameTable(from: string, to: string): boolean {
    const name = to.trim();
    return (
      this.#edit(
        (model) => ({ state: renameTable(model, this.context, from, name), result: true }),
        () => this.view.movePosition(this.view.tableIdOf(from), this.view.tableIdOf(name)),
      ) === true
    );
  }

  dropTable(name: string): boolean {
    return this.#simple((model) => dropTable(model, this.context, name));
  }

  setTableComment(table: string, comment: string): boolean {
    return this.#simple((model) => setTableComment(model, this.context, table, comment));
  }

  addColumn(table: string): string | undefined {
    const name = this.#edit((model) => {
      const added = addColumn(model, this.context, table);
      return { state: added.state, result: added.name };
    });
    if (name !== undefined) this.#set({ focusColumn: { table, column: name } });
    return name;
  }

  updateColumn(table: string, column: string, patch: ColumnPatch): boolean {
    return this.#simple((model) => updateColumn(model, this.context, table, column, patch));
  }

  dropColumn(table: string, column: string): boolean {
    return this.#simple((model) => dropColumn(model, this.context, table, column));
  }

  moveColumn(table: string, column: string, index: number): boolean {
    return this.#simple((model) => moveColumn(model, this.context, table, column, index));
  }

  togglePrimaryKey(table: string, column: string): boolean {
    return this.#simple((model) => togglePrimaryKey(model, this.context, table, column));
  }

  toggleUnique(table: string, column: string): boolean {
    return this.#simple((model) => toggleUnique(model, this.context, table, column));
  }

  /** Adds a relationship and selects it; returns its name. */
  addRelation(input: AddRelationInput): string | undefined {
    const name = this.#edit((model) => {
      const added = addRelation(model, this.context, input);
      return { state: added.state, result: added.name };
    });
    if (name !== undefined) {
      const added = this.view.state.diagram?.relations.find(
        (r) => r.name === name && r.child === this.view.tableIdOf(input.child),
      );
      if (added) this.view.selectRelation(added.id);
    }
    return name;
  }

  updateRelation(child: string, name: string, patch: RelationPatch): boolean {
    return this.#simple((model) => updateRelation(model, this.context, child, name, patch));
  }

  dropRelation(child: string, name: string): boolean {
    return this.#simple((model) => dropRelation(model, this.context, child, name));
  }

  /** The edited schema's table names, for pickers. */
  tableNames(): string[] {
    return editedSchema(this.state.model.snapshot, this.context).tables.map((t) => t.name);
  }

  focusHandled(): void {
    if (this.state.focusColumn) this.#set({ focusColumn: undefined });
  }

  // -------------------------------------------------------------------------------------------
  // The live schema

  /** The structure was read again while editing: note whether the edited schema changed. */
  liveChanged(snapshot: SchemaSnapshot): void {
    const before = JSON.stringify(editedSchema(this.base, this.context).tables);
    let after: string;
    try {
      after = JSON.stringify(editedSchema(snapshot, this.context).tables);
    } catch {
      after = '';
    }
    if (before !== after && !this.state.stale) this.#set({ stale: true });
  }

  // -------------------------------------------------------------------------------------------
  // Review and apply

  /** Opens the review of the script the model makes. */
  review(): void {
    const script = modelScript(this.state.model, this.base, this.context);
    if (script.statements.length === 0) {
      this.view.note({
        kind: 'info',
        text: 'The model is the same as the database: nothing to apply',
      });
      return;
    }
    this.#set({ review: script });
  }

  closeReview(): void {
    this.#set({ review: undefined });
  }

  /** Discards the model and shows the live structure again. */
  discard(): void {
    this.#set({ review: undefined });
    this.view.stopEditing();
  }

  /**
   * Runs the reviewed script on the diagram's database, after the write-safety rules. On
   * success the editor closes and the diagram reloads from the server; on failure the model
   * stays, and the message says what ran (MySQL and MariaDB commit each DDL statement).
   */
  async apply(): Promise<boolean> {
    const script = this.state.review;
    if (!script || this.state.applying) return false;
    const profile = await profileById(this.view.target.profileId);
    if (!profile || !isSqlEngine(profile.engine)) {
      this.view.note({ kind: 'error', text: 'The connection was deleted' });
      return false;
    }
    this.#set({ applying: true });
    patchPanel(this.view.id, { busy: true });
    const lane = new SessionLane(
      profile.id,
      this.view.state.diagram?.database ?? this.view.target.database,
    );
    try {
      const outcome = await runScript(
        lane,
        profile,
        profile.engine,
        script.statements,
        script.transactional,
      );
      if (outcome.ok) {
        const count = script.operations.length;
        this.#set({ review: undefined });
        this.view.stopEditing();
        this.view.note({
          kind: 'success',
          text: `Applied ${count} ${count === 1 ? 'change' : 'changes'} to ${this.context.schema}`,
        });
        invalidateMetadata(profile.id);
        return true;
      }
      if (!outcome.cancelled) {
        this.view.note({ kind: 'error', text: outcome.message });
        this.#set({ review: undefined });
        // Part of a MySQL script may have run: the live structure is read again.
        if (!script.transactional) invalidateMetadata(profile.id);
      }
      return false;
    } catch (error) {
      this.view.note({ kind: 'error', text: errorMessage(error) });
      return false;
    } finally {
      this.#set({ applying: false });
      patchPanel(this.view.id, { busy: false });
      void lane.close();
    }
  }

  /** Saves the reviewed script as a .sql file. */
  async saveScript(): Promise<void> {
    const script = this.state.review;
    if (!script) return;
    try {
      const { path } = await mainApi().dialogs.saveFile({
        title: 'Save the script',
        defaultName: `${this.context.schema.replace(/[^\w.-]+/g, '_')}-changes.sql`,
        filters: [{ name: 'SQL', extensions: ['sql'] }],
      });
      if (path === null) return;
      await mainApi().dialogs.writeFile({ path, text: `${script.text}\n` });
      this.view.note({ kind: 'success', text: `Saved to ${path}` });
    } catch (error) {
      this.view.note({
        kind: 'error',
        text: `The script could not be saved: ${errorMessage(error)}`,
      });
    }
  }
}

/** Subscribes a component to part of an editor's state. */
export function useEditor<T>(editor: ErModelEditor, selector: (state: EditorState) => T): T {
  return useStore(editor.store, selector);
}
