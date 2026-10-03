import {
  isSqlEngine,
  type SchemaSnapshot,
  type SqlDialect,
  type SqlEngineId,
} from '@querybara/core';
import type { ErModelDraftSummary } from '@querybara/ipc';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { cachedProfile } from '../data';
import { loadSnapshot, metadataCache } from '../metadata';
import { layoutBoxes, type LayoutBox, type LayoutEdge, type Point } from '../query-builder/layout';
import {
  boxSize,
  erDiagram,
  matchingTables,
  neighbourhood,
  relationColumns,
  tableId,
  visibleColumns,
  type ColumnMode,
  type DisplayOptions,
  type ErDiagram,
  type ErTable,
} from './model';
import {
  documentLayout,
  documentText,
  modelDocument,
  parseModelFile,
  rebaseModel,
  restoreDraft,
  sameFamily,
  type DiagramLayout,
} from './document';
import { startModel, type EditContext, type ModelState } from './edit';
import { ErModelEditor } from './editor';
import { diagramMermaid } from './mermaid';
import { diagramSvg } from './svg';

/**
 * An ER diagram panel (spec §8, "ER diagrams"): a database's (or PostgreSQL schema's) tables
 * and relationships reverse-engineered from the metadata cache, laid out with elkjs, and shown on
 * a canvas that pans, zooms and lets boxes be dragged. Columns show all, keys only or none, with
 * or without types; views can be added; a table can be selected (its relationships and
 * neighbours stand out), hidden, or shown with its neighbours alone; a search highlights
 * matching tables. The diagram exports as SVG, PNG or Mermaid text, to a file or the clipboard.
 * It reloads when the structure changes through Querybara or on Refresh.
 */

export interface ErTarget {
  readonly profileId: string;
  readonly dialect: SqlDialect;
  /** The database; the connection's own when undefined. */
  readonly database?: string;
  /** PostgreSQL: one schema; every schema when undefined. */
  readonly schema?: string;
}

export interface ErNotice {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

export interface ErState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: string | undefined;
  readonly diagram: ErDiagram | undefined;
  /** PostgreSQL: the schemas of the database, for the schema picker. */
  readonly schemas: readonly string[];
  readonly schema: string | undefined;
  readonly display: DisplayOptions;
  readonly includeViews: boolean;
  /** Top-left corners by table id. */
  readonly positions: Readonly<Record<string, Point>>;
  /** Tables taken off the canvas. */
  readonly hidden: ReadonlySet<string>;
  readonly search: string;
  readonly selected: string | undefined;
  /** A relationship picked on the canvas (while editing). */
  readonly selectedRelation: string | undefined;
  /** The model being edited, while editing. */
  readonly editor: ErModelEditor | undefined;
  /** Unapplied model changes kept for this database's schemas. */
  readonly drafts: readonly ErModelDraftSummary[];
  /** Bumped when the canvas should fit the diagram (after a layout) or a table. */
  readonly fit: { readonly seq: number; readonly table?: string };
  readonly laying: boolean;
  readonly exporting: boolean;
  readonly notice: ErNotice | undefined;
}

/** Rasterises an SVG document to PNG bytes (the canvas side does it; tests pass a fake). */
export type Rasterise = (
  svg: string,
  width: number,
  height: number,
  scale: number,
) => Promise<Uint8Array>;

const ENGINE_NAMES: Readonly<Record<SqlEngineId, string>> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
};

/** "just now", "5 minutes ago", "yesterday", "on 3 September". */
export function savedWhen(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
}

/** Space between the diagram and tables placed beside it. */
const NEW_GAP = 120;

export const DEFAULT_DISPLAY: DisplayOptions = { columns: 'all', types: true };

export type ExportFormat = 'svg' | 'png' | 'mermaid';

const EXPORT_FORMATS: Readonly<Record<ExportFormat, { label: string; extension: string }>> = {
  svg: { label: 'SVG', extension: 'svg' },
  png: { label: 'PNG', extension: 'png' },
  mermaid: { label: 'Mermaid', extension: 'mmd' },
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A file name from the database and schema: "shop-public-erd". */
function fileStem(diagram: ErDiagram, schema: string | undefined): string {
  const stem = [diagram.database, schema].filter(Boolean).join('-');
  return `${stem.replace(/[^\w.-]+/g, '_') || 'diagram'}-erd`;
}

export class ErDiagramView {
  readonly id: string;
  readonly target: ErTarget;
  readonly store: StoreApi<ErState>;
  #loadSeq = 0;
  #live: SchemaSnapshot | undefined;
  /** The shown schema's draft is resumed once, when the diagram first finds it. */
  #resumed = false;

  constructor(id: string, target: ErTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<ErState>()(() => ({
      status: 'loading',
      error: undefined,
      diagram: undefined,
      schemas: [],
      schema: target.schema,
      display: DEFAULT_DISPLAY,
      includeViews: false,
      positions: {},
      hidden: new Set(),
      search: '',
      selected: undefined,
      selectedRelation: undefined,
      editor: undefined,
      drafts: [],
      fit: { seq: 0 },
      laying: false,
      exporting: false,
      notice: undefined,
    }));
  }

  get state(): ErState {
    return this.store.getState();
  }

  #set(patch: Partial<ErState>): void {
    this.store.setState(patch);
  }

  /** The tables a search matches. */
  matches(): ReadonlySet<string> {
    const diagram = this.state.diagram;
    return diagram ? matchingTables(diagram, this.state.search) : new Set();
  }

  // -------------------------------------------------------------------------------------------
  // Loading

  /** Reads the database's structure from the metadata cache and draws it. */
  async load(): Promise<void> {
    const seq = ++this.#loadSeq;
    if (!this.state.diagram) this.#set({ status: 'loading', error: undefined });
    try {
      const snapshot = await loadSnapshot(this.target.profileId, {
        dialect: this.target.dialect,
        ...(this.target.database === undefined ? {} : { database: this.target.database }),
      });
      if (seq !== this.#loadSeq) return;
      this.#live = snapshot;
      // While a model is edited the canvas shows the model; the editor notes the change.
      const editor = this.state.editor;
      if (editor) {
        editor.liveChanged(snapshot);
        this.#set({ status: 'ready', error: undefined });
        return;
      }
      const schemas = this.target.dialect === 'postgres' ? snapshot.schemas.map((s) => s.name) : [];
      const schema =
        this.state.schema !== undefined && schemas.includes(this.state.schema)
          ? this.state.schema
          : undefined;
      this.#set({ schemas, schema });
      await this.#show(snapshot);
      await this.#listDrafts();
    } catch (error) {
      if (seq !== this.#loadSeq) return;
      this.#set({ status: 'error', error: errorMessage(error) });
    }
  }

  /** The structure last read from the server. */
  get live(): SchemaSnapshot | undefined {
    return this.#live;
  }

  /**
   * Draws a snapshot, the live structure or a model being edited: boxes keep their places,
   * hidden tables and the selection stay where their tables still exist, and new tables are
   * laid out (all of them on a first load or a schema switch, else beside the diagram).
   */
  async #show(snapshot: SchemaSnapshot): Promise<void> {
    const schema = this.state.schema;
    const diagram = erDiagram(snapshot, this.target.dialect, {
      ...(schema === undefined ? {} : { schema }),
      includeViews: this.state.includeViews,
    });
    const ids = new Set(diagram.tables.map((t) => t.id));
    const positions = Object.fromEntries(
      Object.entries(this.state.positions).filter(([id]) => ids.has(id)),
    );
    const relations = new Set(diagram.relations.map((r) => r.id));
    this.#set({
      status: 'ready',
      error: undefined,
      diagram,
      positions,
      hidden: new Set([...this.state.hidden].filter((id) => ids.has(id))),
      selected:
        this.state.selected !== undefined && ids.has(this.state.selected)
          ? this.state.selected
          : undefined,
      selectedRelation:
        this.state.selectedRelation !== undefined && relations.has(this.state.selectedRelation)
          ? this.state.selectedRelation
          : undefined,
    });
    if (Object.keys(positions).length === 0) await this.layout();
    else await this.#placeNew();
  }

  /** Draws the model being edited (the editor calls it after each change). */
  showModel(snapshot: SchemaSnapshot): Promise<void> {
    return this.#show(snapshot);
  }

  /** The id a table of the edited schema has on the canvas. */
  tableIdOf(name: string): string {
    const schema =
      this.target.dialect === 'postgres' ? (this.state.schema ?? '') : (this.#live?.database ?? '');
    return tableId(schema, name);
  }

  /** Where a new table goes: right of the diagram, level with its top. */
  spotBeside(): Point {
    const diagram = this.state.diagram;
    const { positions, hidden } = this.state;
    if (!diagram) return { x: 40, y: 40 };
    const shown = this.#boxes(diagram, (t) => positions[t.id] !== undefined && !hidden.has(t.id));
    if (shown.length === 0) return { x: 40, y: 40 };
    return {
      x: Math.max(...shown.map((box) => positions[box.id]!.x + box.width)) + NEW_GAP,
      y: Math.min(...shown.map((box) => positions[box.id]!.y)),
    };
  }

  /** Keeps a box where it was when its table is renamed. */
  movePosition(from: string, to: string): void {
    const { [from]: place, ...rest } = this.state.positions;
    if (!place) return;
    this.#set({
      positions: { ...rest, [to]: place },
      ...(this.state.selected === from ? { selected: to } : {}),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Editing

  /** Why the model cannot be edited now, or undefined when it can. */
  editBlocker(): string | undefined {
    if (!this.#live || !this.state.diagram) return 'The structure is still loading';
    if (cachedProfile(this.target.profileId)?.presentation.readOnly) {
      return 'The connection is read-only';
    }
    if (this.target.dialect === 'postgres' && this.state.schema === undefined) {
      return 'Choose a schema to edit it';
    }
    return undefined;
  }

  /** Starts editing the shown schema as a model. */
  startEditing(): void {
    const blocker = this.editBlocker();
    const engine = this.#engine();
    if (blocker || !this.#live || !engine || this.state.editor) {
      if (blocker) this.note({ kind: 'error', text: blocker });
      return;
    }
    const schema = this.target.dialect === 'postgres' ? this.state.schema! : this.#live.database;
    this.#startEditor(this.#live, { engine, schema });
    this.#set({ notice: undefined });
  }

  #engine(): SqlEngineId | undefined {
    const engine = cachedProfile(this.target.profileId)?.engine;
    return engine !== undefined && isSqlEngine(engine) ? engine : undefined;
  }

  #startEditor(
    base: SchemaSnapshot,
    context: EditContext,
    options: { readonly model?: ModelState; readonly drafted?: boolean } = {},
  ): ErModelEditor {
    this.state.editor?.dispose();
    const editor = new ErModelEditor(this, base, context, options);
    this.#set({ editor });
    editor.begin();
    if (this.#live && base !== this.#live) editor.liveChanged(this.#live);
    return editor;
  }

  /** Leaves editing (after Discard or Apply) and draws the live structure again. */
  stopEditing(): void {
    const editor = this.state.editor;
    if (!editor) return;
    editor.dispose();
    this.#set({ editor: undefined, selectedRelation: undefined });
    if (this.#live) void this.#show(this.#live);
    void this.#listDrafts();
  }

  // -------------------------------------------------------------------------------------------
  // Drafts and model files

  /** The schema this diagram's table ids use: the PostgreSQL schema, else the database. */
  diagramSchema(schema = this.state.schema): string {
    return this.target.dialect === 'postgres' ? (schema ?? '') : (this.#live?.database ?? '');
  }

  /** Where the boxes are and what the diagram shows, for a model document. */
  currentLayout(): DiagramLayout {
    const { positions, hidden, display, includeViews } = this.state;
    return { positions, hidden, display, includeViews };
  }

  #applyLayout(layout: DiagramLayout): void {
    this.#set({
      positions: { ...layout.positions },
      hidden: new Set(layout.hidden),
      display: layout.display,
      includeViews: layout.includeViews,
      selected: undefined,
      selectedRelation: undefined,
      fit: { seq: this.state.fit.seq + 1 },
    });
  }

  /** The database's drafts, for the banner; resumes the shown schema's once. */
  async #listDrafts(): Promise<void> {
    const live = this.#live;
    if (!live) return;
    let drafts: readonly ErModelDraftSummary[];
    try {
      drafts = await mainApi().erModels.listDrafts({
        profileId: this.target.profileId,
        database: live.database,
      });
    } catch {
      return;
    }
    this.#set({ drafts });
    const shown = this.target.dialect === 'postgres' ? this.state.schema : live.database;
    const mine = drafts.find((draft) => draft.schema === shown);
    if (mine && !this.state.editor && !this.#resumed) {
      this.#resumed = true;
      await this.resumeDraft(mine.schema);
    }
  }

  /** Reopens a schema's unapplied changes where they were left. */
  async resumeDraft(schema: string): Promise<void> {
    const live = this.#live;
    const engine = this.#engine();
    if (!live || !engine) return;
    try {
      const draft = await mainApi().erModels.getDraft({
        profileId: this.target.profileId,
        database: live.database,
        schema,
      });
      if (!draft) {
        this.note({ kind: 'error', text: 'The unapplied changes could not be read' });
        return;
      }
      const { base, model } = restoreDraft(draft.document);
      if (this.target.dialect === 'postgres') this.#set({ schema });
      this.#applyLayout(documentLayout(draft.document, this.diagramSchema(schema)));
      this.#startEditor(base, { engine, schema }, { model, drafted: true });
      this.note({
        kind: 'info',
        text: `Restored your unapplied changes to ${schema} (${draft.changes} ${draft.changes === 1 ? 'table' : 'tables'}, ${savedWhen(draft.savedAt)})`,
      });
    } catch (error) {
      this.note({
        kind: 'error',
        text: `The unapplied changes could not be read: ${errorMessage(error)}`,
      });
    }
  }

  /** Drops a schema's unapplied changes without opening them. */
  async discardDraft(schema: string): Promise<void> {
    const live = this.#live;
    if (!live) return;
    try {
      await mainApi().erModels.deleteDraft({
        profileId: this.target.profileId,
        database: live.database,
        schema,
      });
    } finally {
      await this.#listDrafts();
    }
  }

  /** Saves the shown schema, as edited or as it is live, as a model file. */
  async saveModelFile(): Promise<void> {
    const live = this.#live;
    const engine = this.#engine();
    const editor = this.state.editor;
    if (!live || !engine) return;
    const schema =
      editor?.context.schema ??
      (this.target.dialect === 'postgres' ? this.state.schema : live.database);
    if (schema === undefined) {
      this.note({ kind: 'error', text: 'Choose a schema to save it as a model' });
      return;
    }
    const context: EditContext = { engine, schema };
    const document = modelDocument({
      model: editor?.state.model ?? startModel(live, context),
      context,
      layout: this.currentLayout(),
      diagramSchema: this.diagramSchema(),
      savedAt: new Date().toISOString(),
    });
    const stem = [live.database, this.target.dialect === 'postgres' ? schema : undefined]
      .filter(Boolean)
      .join('-')
      .replace(/[^\w.-]+/g, '_');
    try {
      const { path } = await mainApi().dialogs.saveFile({
        title: 'Save the ER model',
        defaultName: `${stem || 'model'}.model.json`,
        filters: [{ name: 'Querybara ER model', extensions: ['json'] }],
      });
      if (path === null) return;
      await mainApi().dialogs.writeFile({ path, text: documentText(document) });
      this.note({ kind: 'success', text: `Saved the model to ${path}` });
    } catch (error) {
      this.note({ kind: 'error', text: `The model could not be saved: ${errorMessage(error)}` });
    }
  }

  /**
   * Opens a model file on this diagram's database: the model becomes what the schema should
   * look like here, in edit mode, to review and apply. The file's schema is used when the
   * diagram shows every schema and the database has it.
   */
  async openModelFile(): Promise<void> {
    const live = this.#live;
    const engine = this.#engine();
    if (!live || !engine) return;
    try {
      const { path } = await mainApi().dialogs.openFile({
        title: 'Open an ER model',
        filters: [{ name: 'Querybara ER model', extensions: ['json'] }],
      });
      if (path === null) return;
      const { text } = await mainApi().dialogs.readFile({ path });
      const parsed = parseModelFile(text);
      if (!parsed.ok) {
        this.note({ kind: 'error', text: parsed.message });
        return;
      }
      const { document } = parsed;
      if (!sameFamily(document.engine, engine)) {
        this.note({
          kind: 'error',
          text: `The model is for ${ENGINE_NAMES[document.engine]}; this connection is ${ENGINE_NAMES[engine]}`,
        });
        return;
      }
      let schema = this.target.dialect === 'postgres' ? this.state.schema : live.database;
      if (schema === undefined && live.schemas.some((s) => s.name === document.schema)) {
        schema = document.schema;
      }
      if (schema === undefined) {
        this.note({
          kind: 'error',
          text: `Choose the schema to open the model in (it was ${document.schema})`,
        });
        return;
      }
      const context: EditContext = { engine, schema };
      const model = rebaseModel(document, live, context);
      if (this.target.dialect === 'postgres') this.#set({ schema });
      this.#applyLayout(documentLayout(document, this.diagramSchema(schema)));
      const editor = this.#startEditor(live, context, { model });
      const name = path.split(/[\\/]/).pop() ?? path;
      const count = editor.state.changes.count;
      this.note({
        kind: 'info',
        text:
          count === 0
            ? `Opened ${name}: ${schema} already matches it`
            : `Opened ${name}: it changes ${count} ${count === 1 ? 'table' : 'tables'} of ${schema}. Review before applying.`,
      });
    } catch (error) {
      this.note({ kind: 'error', text: `The model could not be opened: ${errorMessage(error)}` });
    }
  }

  /** Reads the structure again from the server. */
  async refresh(): Promise<void> {
    const database = this.state.diagram?.database ?? this.target.database;
    try {
      await metadataCache.refresh(
        this.target.profileId,
        database === undefined ? undefined : [database],
      );
    } catch {
      // The load below reports what is wrong.
    }
    await this.load();
  }

  // -------------------------------------------------------------------------------------------
  // Layout

  /** The boxes of some tables, sized for what they show. */
  #boxes(diagram: ErDiagram, include: (table: ErTable) => boolean): LayoutBox[] {
    const related = relationColumns(diagram);
    const { display } = this.state;
    return diagram.tables.filter(include).map((table) => ({
      id: table.id,
      ...boxSize(
        diagram,
        table,
        visibleColumns(table, display.columns, related.get(table.id)),
        display.types,
      ),
    }));
  }

  #edges(diagram: ErDiagram): LayoutEdge[] {
    return diagram.relations.map((r) => ({ id: r.id, source: r.child, target: r.parent }));
  }

  /** Lays the shown tables out with elkjs, related tables side by side, and fits the view. */
  async layout(): Promise<void> {
    const diagram = this.state.diagram;
    if (!diagram) return;
    this.#set({ laying: true });
    try {
      const { hidden } = this.state;
      const boxes = this.#boxes(diagram, (table) => !hidden.has(table.id));
      const placed = await layoutBoxes(boxes, this.#edges(diagram));
      if (this.state.diagram !== diagram) return;
      this.#set({
        positions: { ...this.state.positions, ...placed },
        fit: { seq: this.state.fit.seq + 1 },
      });
    } finally {
      this.#set({ laying: false });
    }
  }

  /**
   * Places shown tables that have no place yet: laid out among themselves, to the right of the
   * diagram, so the boxes the user arranged stay where they are.
   */
  async #placeNew(): Promise<void> {
    const diagram = this.state.diagram;
    if (!diagram) return;
    const { positions, hidden } = this.state;
    const fresh = this.#boxes(diagram, (t) => !positions[t.id] && !hidden.has(t.id));
    if (fresh.length === 0) return;
    const placed = this.#boxes(diagram, (t) => positions[t.id] !== undefined && !hidden.has(t.id));
    if (placed.length === 0) return this.layout();
    const right = Math.max(...placed.map((box) => positions[box.id]!.x + box.width));
    const top = Math.min(...placed.map((box) => positions[box.id]!.y));
    this.#set({ laying: true });
    try {
      const laid = await layoutBoxes(fresh, this.#edges(diagram));
      if (this.state.diagram !== diagram) return;
      const moved = Object.fromEntries(
        Object.entries(laid).map(([id, p]) => [id, { x: right + NEW_GAP + p.x, y: top + p.y }]),
      );
      this.#set({
        positions: { ...this.state.positions, ...moved },
        fit: { seq: this.state.fit.seq + 1 },
      });
    } finally {
      this.#set({ laying: false });
    }
  }

  /** Boxes dragged by the user keep where they were dropped. */
  move(positions: Readonly<Record<string, Point>>): void {
    this.#set({ positions: { ...this.state.positions, ...positions } });
  }

  // -------------------------------------------------------------------------------------------
  // What is shown

  async setSchema(schema: string | undefined): Promise<void> {
    if (schema === this.state.schema || this.state.editor) return;
    this.#set({ schema, positions: {}, hidden: new Set(), selected: undefined });
    await this.load();
  }

  async setIncludeViews(includeViews: boolean): Promise<void> {
    this.#set({ includeViews });
    const editor = this.state.editor;
    if (editor) await this.#show(editor.state.model.snapshot);
    else await this.load();
  }

  /** Box heights follow the columns shown, so the layout runs again. */
  async setColumns(columns: ColumnMode): Promise<void> {
    this.#set({ display: { ...this.state.display, columns } });
    await this.layout();
  }

  async setTypes(types: boolean): Promise<void> {
    this.#set({ display: { ...this.state.display, types } });
    await this.layout();
  }

  setSearch(search: string): void {
    this.#set({ search });
  }

  /** Selects a table (its relationships and neighbours stand out), or clears the selection. */
  select(table: string | undefined): void {
    this.#set({ selected: table, selectedRelation: undefined });
  }

  /** Selects a relationship (while editing), or clears the selection. */
  selectRelation(relation: string | undefined): void {
    this.#set({ selectedRelation: relation, selected: undefined });
  }

  /** Brings a table into view and selects it. */
  focus(table: string): void {
    const hidden = new Set(this.state.hidden);
    hidden.delete(table);
    this.#set({ hidden, selected: table, fit: { seq: this.state.fit.seq + 1, table } });
    void this.#placeNew();
  }

  /** Fits the whole diagram into view. */
  fitAll(): void {
    this.#set({ fit: { seq: this.state.fit.seq + 1 } });
  }

  /** Shows only a table and the tables it is related to, and selects it. */
  isolate(table: string): void {
    const diagram = this.state.diagram;
    if (!diagram) return;
    const { tables } = neighbourhood(diagram, table);
    this.#set({
      hidden: new Set(diagram.tables.map((t) => t.id).filter((id) => !tables.has(id))),
      selected: table,
      fit: { seq: this.state.fit.seq + 1 },
    });
  }

  setHidden(table: string, hidden: boolean): void {
    const next = new Set(this.state.hidden);
    if (hidden) next.add(table);
    else next.delete(table);
    this.#set({
      hidden: next,
      ...(hidden && this.state.selected === table ? { selected: undefined } : {}),
    });
    if (!hidden) void this.#placeNew();
  }

  showAll(): void {
    this.#set({ hidden: new Set(), fit: { seq: this.state.fit.seq + 1 } });
    void this.#placeNew();
  }

  note(notice: ErNotice | undefined): void {
    this.#set({ notice });
  }

  // -------------------------------------------------------------------------------------------
  // Export

  /** "shop · public — 12 tables, 9 relationships". */
  caption(): string {
    const diagram = this.state.diagram;
    if (!diagram) return '';
    const shown = diagram.tables.filter((t) => !this.state.hidden.has(t.id) && !t.external).length;
    const place = [diagram.database, this.state.schema].filter(Boolean).join(' · ');
    return `${place} — ${shown} ${shown === 1 ? 'table' : 'tables'}, ${diagram.relations.length} ${diagram.relations.length === 1 ? 'relationship' : 'relationships'}`;
  }

  /** The diagram as it is on the canvas, as an SVG document. */
  svg(): { svg: string; width: number; height: number } | undefined {
    const { diagram, positions, display, hidden } = this.state;
    if (!diagram) return undefined;
    return diagramSvg({ diagram, positions, display, hidden, caption: this.caption() });
  }

  /** The shown tables as Mermaid `erDiagram` text. */
  mermaid(): string | undefined {
    const { diagram, hidden, display } = this.state;
    return diagram ? diagramMermaid(diagram, { hidden, types: display.types }) : undefined;
  }

  /** Saves the diagram as an SVG or PNG image, or as Mermaid text, where the user picks. */
  async export(format: ExportFormat, rasterise?: Rasterise): Promise<void> {
    const diagram = this.state.diagram;
    const image = this.svg();
    if (!diagram || !image || this.state.exporting) return;
    const { label, extension } = EXPORT_FORMATS[format];
    this.#set({ exporting: true });
    try {
      const { path } = await mainApi().dialogs.saveFile({
        title: `Export the diagram as ${label}`,
        defaultName: `${fileStem(diagram, this.state.schema)}.${extension}`,
        filters: [{ name: label, extensions: [extension] }],
      });
      if (path === null) return;
      if (format === 'svg') {
        await mainApi().dialogs.writeFile({ path, text: image.svg });
      } else if (format === 'mermaid') {
        await mainApi().dialogs.writeFile({ path, text: this.mermaid() ?? '' });
      } else {
        if (!rasterise) throw new Error('PNG export needs the canvas');
        const bytes = await rasterise(image.svg, image.width, image.height, 2);
        await mainApi().dialogs.writeFile({ path, base64: base64(bytes) });
      }
      this.note({ kind: 'success', text: `Saved to ${path}` });
    } catch (error) {
      this.note({
        kind: 'error',
        text: `The diagram could not be exported: ${errorMessage(error)}`,
      });
    } finally {
      this.#set({ exporting: false });
    }
  }

  /** Copies the diagram as Mermaid text or SVG markup; call it from a user action. */
  copy(format: 'svg' | 'mermaid'): void {
    const text = format === 'svg' ? this.svg()?.svg : this.mermaid();
    if (text === undefined) return;
    this.note(
      copyToClipboard(text)
        ? { kind: 'success', text: `Copied the diagram as ${EXPORT_FORMATS[format].label}` }
        : { kind: 'error', text: 'The diagram could not be copied to the clipboard' },
    );
  }
}

/** Subscribes a component to part of an ER diagram's state. */
export function useErDiagram<T>(view: ErDiagramView, selector: (state: ErState) => T): T {
  return useStore(view.store, selector);
}
