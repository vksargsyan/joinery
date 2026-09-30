import type { SqlDialect } from '@joinery/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { loadSnapshot, metadataCache } from '../metadata';
import { layoutBoxes, type LayoutBox, type LayoutEdge, type Point } from '../query-builder/layout';
import {
  boxSize,
  erDiagram,
  matchingTables,
  neighbourhood,
  relationColumns,
  visibleColumns,
  type ColumnMode,
  type DisplayOptions,
  type ErDiagram,
  type ErTable,
} from './model';
import { diagramMermaid } from './mermaid';
import { diagramSvg } from './svg';

/**
 * An ER diagram panel (spec §8, "ER diagrams"): a database's (or PostgreSQL schema's) tables
 * and relationships reverse-engineered from the metadata cache, laid out with elkjs, and shown on
 * a canvas that pans, zooms and lets boxes be dragged. Columns show all, keys only or none, with
 * or without types; views can be added; a table can be selected (its relationships and
 * neighbours stand out), hidden, or shown with its neighbours alone; a search highlights
 * matching tables. The diagram exports as SVG, PNG or Mermaid text, to a file or the clipboard.
 * It reloads when the structure changes through Joinery or on Refresh.
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
      const schemas = this.target.dialect === 'postgres' ? snapshot.schemas.map((s) => s.name) : [];
      const schema =
        this.state.schema !== undefined && schemas.includes(this.state.schema)
          ? this.state.schema
          : undefined;
      const diagram = erDiagram(snapshot, this.target.dialect, {
        ...(schema === undefined ? {} : { schema }),
        includeViews: this.state.includeViews,
      });
      const ids = new Set(diagram.tables.map((t) => t.id));
      const positions = Object.fromEntries(
        Object.entries(this.state.positions).filter(([id]) => ids.has(id)),
      );
      this.#set({
        status: 'ready',
        error: undefined,
        diagram,
        schemas,
        schema,
        positions,
        hidden: new Set([...this.state.hidden].filter((id) => ids.has(id))),
        selected:
          this.state.selected !== undefined && ids.has(this.state.selected)
            ? this.state.selected
            : undefined,
      });
      // A first load or a schema switch is laid out whole; views turned on, or tables created
      // since, go beside the diagram, which keeps the arrangement the user made.
      if (Object.keys(positions).length === 0) await this.layout();
      else await this.#placeNew();
    } catch (error) {
      if (seq !== this.#loadSeq) return;
      this.#set({ status: 'error', error: errorMessage(error) });
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
    if (schema === this.state.schema) return;
    this.#set({ schema, positions: {}, hidden: new Set(), selected: undefined });
    await this.load();
  }

  async setIncludeViews(includeViews: boolean): Promise<void> {
    this.#set({ includeViews });
    await this.load();
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
    this.#set({ selected: table });
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
