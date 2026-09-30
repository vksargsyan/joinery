import { JoineryError, requiresWriteConfirmation } from '@joinery/core';
import type { MongoExplainResult, RpcStream } from '@joinery/ipc';
import {
  formatShellInline,
  fromEjson,
  isBsonDocument,
  toEjson,
  toFindQuery,
  type BsonDocument,
  type DocumentPage,
  type ExplainVerbosity,
  type Namespace,
  type QueryModel,
} from '@joinery/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { profileById } from '../data';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { BulkFlow, bulkState, type BulkKind, type BulkState } from './bulk-flow';
import type { CodeExportRequest } from './code-export';
import { EditorFlow, cloneState, editState, insertState, type EditorState } from './editor-flow';
import { namespaceReference } from './explorer';
import {
  EMPTY_FIELDS,
  checkFields,
  findTextOf,
  modelOf,
  parseFindInput,
  type QueryExtras,
  type QueryField,
  type QueryFields,
  type TextIssue,
} from './query-bar';
import { QueryBuilder } from './query-builder';
import { DocumentResults, type ResultMode } from './results';

/**
 * One collection view (spec §9, "Browsing and editing"): the query bar, the documents paged
 * from a find() cursor as the user scrolls, counts (the collection's estimate, the exact number
 * of matches on demand), the tree, table and JSON views, the document editor, bulk update and
 * delete by the current filter, and explain. Everything runs on the view's own session. The
 * write rules follow the profile as the SQL table view's do: a read-only profile edits nothing,
 * a production one confirms every write, and bulk writes always confirm their matched count.
 */

export interface CollectionTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
  /** What the explorer showed; views are read-only. */
  readonly kind: 'collection' | 'view' | 'time-series';
}

/** Documents per page the view pulls from the cursor. */
export const PAGE_SIZE = 100;

export type ViewTab = ResultMode | 'explain';

export interface ExplainState {
  readonly verbosity: ExplainVerbosity;
  readonly loading: boolean;
  readonly result: MongoExplainResult | undefined;
  readonly error: string | undefined;
}

export interface Notice {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

/** The editor, and which loaded document it edits (none for an insert or a clone). */
export type OpenEditor = EditorState & { readonly index: number | undefined };

export interface CollectionViewState {
  readonly fields: QueryFields;
  readonly extras: QueryExtras;
  readonly issues: Partial<Record<QueryField, TextIssue>>;
  /** The find() text as shown (and edited) beside the fields. */
  readonly findText: string;
  readonly findIssue: TextIssue | undefined;
  /** The query the loaded documents came from; undefined before the first run. */
  readonly active: QueryModel | undefined;
  readonly running: boolean;
  readonly durationMs: number | undefined;
  /** The collection's size from its metadata: undefined while reading, null when unknown. */
  readonly estimate: number | null | undefined;
  /** Documents matching the active filter, counted on demand. */
  readonly exactCount: number | undefined;
  readonly counting: boolean;
  readonly tab: ViewTab;
  readonly explain: ExplainState | undefined;
  readonly notice: Notice | undefined;
  readonly readOnlyProfile: boolean;
  readonly production: boolean;
  /** Every write asks first (production, or the profile says so). */
  readonly confirmWrites: boolean;
  readonly editor: OpenEditor | undefined;
  readonly bulk: BulkState | undefined;
}

export class CollectionView {
  readonly id: string;
  readonly target: CollectionTarget;
  readonly store: StoreApi<CollectionViewState>;
  readonly results = new DocumentResults({ mode: 'tree' });
  /** The visual query builder, the query bar's second editor. */
  readonly builder: QueryBuilder;
  readonly #lane: SessionLane;
  #stream: RpcStream<DocumentPage> | undefined;
  #runId = 0;
  #count: AbortController | undefined;
  #editor: EditorFlow | undefined;
  #bulk: BulkFlow | undefined;

  constructor(id: string, target: CollectionTarget, fields: Partial<QueryFields> = {}) {
    this.id = id;
    this.target = target;
    const initial = { ...EMPTY_FIELDS, ...fields };
    this.store = createStore<CollectionViewState>()(() => ({
      fields: initial,
      extras: {},
      issues: checkFields(initial),
      findText: findTextOf(target.collection, initial) ?? '',
      findIssue: undefined,
      active: undefined,
      running: false,
      durationMs: undefined,
      estimate: undefined,
      exactCount: undefined,
      counting: false,
      tab: 'tree',
      explain: undefined,
      notice: undefined,
      readOnlyProfile: false,
      production: false,
      confirmWrites: false,
      editor: undefined,
      bulk: undefined,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
    this.builder = new QueryBuilder({
      collection: target.collection,
      query: () => this.state,
      subscribe: (listener) => this.store.subscribe(listener),
      setFindText: (text) => this.setFindText(text),
      sample: (sampleSize, signal) =>
        this.#lane.run((host, sessionId) =>
          host.mongo.analyzeSchema({ sessionId, ns: this.ns, options: { sampleSize } }, { signal }),
        ),
    });
  }

  get state(): CollectionViewState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  /** Views are read-only, and so is everything on a read-only profile. */
  get writable(): boolean {
    return this.target.kind !== 'view' && !this.state.readOnlyProfile;
  }

  /** Documents read with a projection are partial, so they cannot be edited or cloned. */
  get editable(): boolean {
    return this.writable && this.state.active?.projection === undefined;
  }

  #set(patch: Partial<CollectionViewState>): void {
    this.store.setState(patch);
  }

  /** Reads the profile's write rules and runs the query. */
  async init(): Promise<void> {
    const profile = await profileById(this.target.profileId);
    if (profile) {
      this.#set({
        readOnlyProfile: profile.presentation.readOnly,
        production: profile.presentation.environment === 'production',
        confirmWrites: requiresWriteConfirmation(profile),
      });
    }
    await this.run();
  }

  // -------------------------------------------------------------------------------------------
  // Query bar

  /** A field typed by the user: checked, and the find() text follows when every field is valid. */
  setField(field: QueryField, text: string): void {
    const fields = { ...this.state.fields, [field]: text };
    const findText = findTextOf(this.target.collection, fields, this.state.extras);
    this.#set({
      fields,
      issues: checkFields(fields),
      ...(findText !== undefined ? { findText, findIssue: undefined } : {}),
    });
  }

  /** The find() text edited by hand: when it parses the fields follow it. */
  setFindText(text: string): void {
    const parsed = parseFindInput(text, this.target.collection);
    if (!parsed.ok) {
      this.#set({ findText: text, findIssue: parsed.issue });
      return;
    }
    this.#set({
      findText: text,
      findIssue: undefined,
      fields: parsed.fields,
      extras: parsed.extras,
      issues: {},
    });
  }

  /**
   * The query in the bar as code export takes it; undefined, with a notice, while a field does
   * not parse.
   */
  exportRequest(): CodeExportRequest | undefined {
    const s = this.state;
    if (s.findIssue || Object.keys(s.issues).length > 0) {
      this.#set({ notice: { kind: 'error', text: 'Fix the query first.' } });
      return undefined;
    }
    try {
      return {
        target: {
          kind: 'find',
          collection: this.target.collection,
          query: modelOf(s.fields, s.extras),
        },
        database: this.target.db,
      };
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return undefined;
    }
  }

  /** Replaces the query with `fields` (a query opened from elsewhere) and runs it. */
  async applyFields(fields: QueryFields): Promise<void> {
    this.#set({
      fields,
      extras: {},
      issues: checkFields(fields),
      findText: findTextOf(this.target.collection, fields) ?? this.state.findText,
      findIssue: undefined,
    });
    await this.run();
  }

  /** Clears the query and runs it again. */
  async reset(): Promise<void> {
    this.#set({
      fields: EMPTY_FIELDS,
      extras: {},
      issues: {},
      findText: findTextOf(this.target.collection, EMPTY_FIELDS) ?? '',
      findIssue: undefined,
    });
    await this.run();
  }

  // -------------------------------------------------------------------------------------------
  // Running and paging

  /** Runs the query in the bar from the first page; problems are shown instead of running. */
  async run(): Promise<void> {
    const s = this.state;
    const pending = this.builder.pendingIssue();
    if (s.findIssue || Object.keys(s.issues).length > 0 || pending !== undefined) {
      this.#set({
        notice: {
          kind: 'error',
          text: pending === undefined ? 'Fix the query first.' : `Fix the query first. ${pending}`,
        },
      });
      return;
    }
    let model: QueryModel;
    try {
      model = modelOf(s.fields, s.extras);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return;
    }
    const runId = ++this.#runId;
    await this.#closeStream();
    this.#count?.abort();
    this.results.begin(() => this.#fetch(runId));
    this.#set({
      active: model,
      running: true,
      exactCount: undefined,
      notice: undefined,
      explain: undefined,
      tab: s.tab === 'explain' ? this.results.state.mode : s.tab,
    });
    patchPanel(this.id, { busy: true });
    const started = performance.now();
    try {
      this.#stream = await this.#lane.run(async (host, sessionId) =>
        host.mongo.find({ sessionId, ns: this.ns, query: toFindQuery(model), pageSize: PAGE_SIZE }),
      );
      await this.#fetch(runId);
      if (runId === this.#runId) this.#set({ durationMs: Math.round(performance.now() - started) });
    } finally {
      if (runId === this.#runId) {
        this.#set({ running: false });
        patchPanel(this.id, { busy: false });
      }
    }
    void this.#refreshEstimate();
  }

  /** Pulls the next page of the current run. */
  async #fetch(runId: number): Promise<void> {
    const stream = this.#stream;
    if (!stream || runId !== this.#runId) return;
    this.results.setLoading(true);
    try {
      const next = await stream.next();
      if (runId !== this.#runId) return;
      if (next.done) {
        this.results.append([], false);
        this.#stream = undefined;
        return;
      }
      this.results.append(next.value.documents, next.value.documents.length >= PAGE_SIZE);
    } catch (error) {
      if (runId !== this.#runId) return;
      this.#stream = undefined;
      this.results.fail(errorMessage(error));
    }
  }

  async #closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.return().catch(() => undefined);
  }

  async #refreshEstimate(): Promise<void> {
    this.#set({ estimate: undefined });
    try {
      const { count } = await this.#lane.run((host, sessionId) =>
        host.mongo.estimatedCount({ sessionId, ns: this.ns }),
      );
      this.#set({ estimate: count });
    } catch {
      this.#set({ estimate: null });
    }
  }

  /** Counts the documents matching the active filter exactly (spec §9: exact on demand). */
  async countExactly(): Promise<void> {
    const active = this.state.active;
    if (this.state.counting || !active) return;
    const controller = new AbortController();
    this.#count = controller;
    this.#set({ counting: true });
    try {
      const { count } = await this.#lane.run((host, sessionId) =>
        host.mongo.count(
          { sessionId, ns: this.ns, filter: toEjson(active.filter) },
          { signal: controller.signal },
        ),
      );
      if (this.#count === controller) this.#set({ exactCount: count });
    } catch (error) {
      if (errorInfo(error).code !== 'CANCELLED' && !controller.signal.aborted) {
        this.#set({ notice: { kind: 'error', text: `Count failed: ${errorMessage(error)}` } });
      }
    } finally {
      if (this.#count === controller) {
        this.#count = undefined;
        this.#set({ counting: false });
      }
    }
  }

  cancelCount(): void {
    this.#count?.abort();
    this.#count = undefined;
    this.#set({ counting: false });
  }

  setTab(tab: ViewTab): void {
    if (tab !== 'explain') this.results.setMode(tab);
    this.#set({ tab });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  // -------------------------------------------------------------------------------------------
  // Explain

  /** Explains the query in the bar (queryPlanner, or executionStats which runs it). */
  async explain(verbosity: ExplainVerbosity = 'executionStats'): Promise<void> {
    const pending = this.builder.pendingIssue();
    if (pending !== undefined) {
      this.#set({ notice: { kind: 'error', text: `Fix the query first. ${pending}` } });
      return;
    }
    let model: QueryModel;
    try {
      model = modelOf(this.state.fields, this.state.extras);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return;
    }
    this.#set({
      tab: 'explain',
      explain: { verbosity, loading: true, result: undefined, error: undefined },
    });
    try {
      const result = await this.#lane.run((host, sessionId) =>
        host.mongo.explain({
          sessionId,
          ns: this.ns,
          target: { kind: 'find', query: toFindQuery(model) },
          verbosity,
        }),
      );
      this.#set({ explain: { verbosity, loading: false, result, error: undefined } });
    } catch (error) {
      this.#set({
        explain: { verbosity, loading: false, result: undefined, error: errorMessage(error) },
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Writes

  #nsRef(): string {
    return namespaceReference(this.target.db, this.target.collection);
  }

  /** Asks before a write on a production (or confirm-writes) profile; true when it may run. */
  async #confirmWrite(title: string, command: string): Promise<boolean> {
    if (!this.state.confirmWrites) return true;
    return confirm({
      title,
      message: this.state.production
        ? 'This connection is marked production, so every write asks first.'
        : 'This connection asks before every write.',
      detail: command,
      confirmLabel: 'Run it',
      danger: true,
    });
  }

  #refuse(): boolean {
    if (this.writable) return false;
    this.#set({
      notice: {
        kind: 'error',
        text:
          this.target.kind === 'view' ? 'A view is read-only.' : 'This connection is read-only.',
      },
    });
    return true;
  }

  /** The `_id` of a loaded document, as Extended JSON. */
  #idOf(index: number): string | undefined {
    const value = this.results.values()[index];
    if (!isBsonDocument(value) || value['_id'] === undefined) return undefined;
    return toEjson(value['_id']);
  }

  #idText(id: string): string {
    return formatShellInline(fromEjson(id, '_id'));
  }

  /** Opens the document editor: edit or clone a loaded document, or insert a new one. */
  openEditor(mode: 'edit' | 'clone' | 'insert', index?: number): void {
    if (this.#refuse()) return;
    const document = index === undefined ? undefined : this.results.state.documents[index];
    if (mode !== 'insert' && document === undefined) return;
    if (mode !== 'insert' && !this.editable) {
      this.#set({
        notice: {
          kind: 'error',
          text: 'These documents were read with a projection; clear it to edit whole documents.',
        },
      });
      return;
    }
    const state =
      mode === 'edit'
        ? editState(document!)
        : mode === 'clone'
          ? cloneState(document!)
          : insertState();
    const editIndex = mode === 'edit' ? index : undefined;
    this.#editor = new EditorFlow(
      state,
      {
        replace: async (original, replacement) => {
          const id = toEjson((fromEjson(original) as BsonDocument)['_id']!);
          const confirmed = await this.#confirmWrite(
            'Replace the document?',
            `${this.#nsRef()}.replaceOne({ _id: ${this.#idText(id)} }, ${formatShellInline(fromEjson(replacement))})`,
          );
          if (!confirmed) throw new JoineryError({ code: 'CANCELLED', message: 'Not saved' });
          return this.#lane.run((host, sessionId) =>
            host.mongo.replaceOne({
              sessionId,
              ns: this.ns,
              original,
              replacement,
              confirmed: this.state.confirmWrites,
            }),
          );
        },
        insert: async (document) => {
          const confirmed = await this.#confirmWrite(
            'Insert the document?',
            `${this.#nsRef()}.insertOne(${formatShellInline(fromEjson(document))})`,
          );
          if (!confirmed) throw new JoineryError({ code: 'CANCELLED', message: 'Not saved' });
          return this.#lane.run((host, sessionId) =>
            host.mongo.insertOne({
              sessionId,
              ns: this.ns,
              document,
              confirmed: this.state.confirmWrites,
            }),
          );
        },
      },
      (next) => this.#set({ editor: { ...next, index: editIndex } }),
    );
    this.#set({ editor: { ...state, index: editIndex } });
  }

  setEditorText(text: string): void {
    this.#editor?.setText(text);
  }

  /** Saves the editor; on success the view shows the document as stored. */
  async saveEditor(): Promise<boolean> {
    const flow = this.#editor;
    const index = this.state.editor?.index;
    if (!flow) return false;
    const outcome = await flow.save();
    if (!outcome.ok) return false;
    this.closeEditor();
    if (flow.state.mode === 'edit' && index !== undefined) {
      await this.#reread(index);
      this.#set({ notice: { kind: 'success', text: 'Document saved' } });
    } else {
      // Read again first: a run clears the notice.
      await this.run();
      this.#set({ notice: { kind: 'success', text: 'Document inserted' } });
    }
    return true;
  }

  /** After a conflict: edit the current version instead. */
  reloadEditor(): void {
    this.#editor?.reload();
  }

  /** After a conflict: overwrite the current version with the edit, once the user agrees. */
  async overwriteEditor(): Promise<boolean> {
    const flow = this.#editor;
    const current = flow?.state.current;
    if (!flow || !current) return false;
    const ok = await confirm({
      title: 'Overwrite the newer version?',
      message:
        'Someone changed this document after you opened it. Overwriting replaces their version with yours.',
      detail: current.text,
      confirmLabel: 'Overwrite',
      danger: true,
    });
    if (!ok) return false;
    const index = this.state.editor?.index;
    const outcome = await flow.overwrite();
    if (!outcome.ok) return false;
    this.closeEditor();
    if (index !== undefined) await this.#reread(index);
    this.#set({ notice: { kind: 'success', text: 'Document saved' } });
    return true;
  }

  closeEditor(): void {
    this.#editor = undefined;
    this.#set({ editor: undefined });
  }

  /** Reads one loaded document again by its `_id` (after an edit). */
  async #reread(index: number): Promise<void> {
    const id = this.#idOf(index);
    if (id === undefined) return;
    try {
      const stream = await this.#lane.run(async (host, sessionId) =>
        host.mongo.find({ sessionId, ns: this.ns, query: { filter: `{"_id":${id}}`, limit: 1 } }),
      );
      let fresh: string | undefined;
      for await (const page of stream) fresh ??= page.documents[0];
      if (fresh !== undefined) this.results.replaceAt(index, fresh);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  /** Deletes one loaded document by its `_id`, after a confirmation that shows the command. */
  async deleteDocument(index: number): Promise<void> {
    if (this.#refuse()) return;
    const id = this.#idOf(index);
    if (id === undefined) {
      this.#set({ notice: { kind: 'error', text: 'This document has no _id to delete it by.' } });
      return;
    }
    const ok = await confirm({
      title: 'Delete this document?',
      message: this.state.production
        ? 'This connection is marked production. The document is deleted for good.'
        : 'The document is deleted for good.',
      detail: `${this.#nsRef()}.deleteOne({ _id: ${this.#idText(id)} })`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const summary = await this.#lane.run((host, sessionId) =>
        host.mongo.deleteOne({ sessionId, ns: this.ns, id, confirmed: true }),
      );
      if (summary.deletedCount > 0) this.results.removeAt(index);
      this.#set({
        notice: {
          kind: summary.deletedCount > 0 ? 'success' : 'info',
          text: summary.deletedCount > 0 ? 'Document deleted' : 'The document was already gone',
        },
        exactCount: undefined,
      });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Bulk update and delete

  /** The filter bulk writes use: the one the loaded documents were read with. */
  #bulkFilter(): string {
    const active = this.state.active ?? modelOf(this.state.fields, this.state.extras);
    return toEjson(active.filter);
  }

  /** Opens bulk update or delete by the current filter; a delete counts its matches at once. */
  openBulk(kind: BulkKind): void {
    if (this.#refuse()) return;
    const filter = this.#bulkFilter();
    const state = bulkState(kind, filter);
    const filterText = formatShellInline(fromEjson(filter));
    this.#bulk = new BulkFlow(
      state,
      {
        update: (f, update, dryRun) =>
          this.#lane.run((host, sessionId) =>
            host.mongo.updateMany({
              sessionId,
              ns: this.ns,
              filter: f,
              update,
              dryRun,
              ...(dryRun ? {} : { confirmed: true }),
            }),
          ),
        delete: (f, dryRun) =>
          this.#lane.run((host, sessionId) =>
            host.mongo.deleteMany({
              sessionId,
              ns: this.ns,
              filter: f,
              dryRun,
              ...(dryRun ? {} : { confirmed: true }),
            }),
          ),
        confirm: (matched) => {
          const update = this.#bulk?.state.updateText ?? '';
          return confirm({
            title:
              kind === 'update'
                ? `Update ${formatCount(matched)} ${matched === 1 ? 'document' : 'documents'}?`
                : `Delete ${formatCount(matched)} ${matched === 1 ? 'document' : 'documents'}?`,
            message: `${formatCount(matched)} ${matched === 1 ? 'document matches' : 'documents match'} the filter${this.state.production ? ' on this production connection' : ''}.`,
            detail:
              kind === 'update'
                ? `${this.#nsRef()}.updateMany(${filterText}, ${update.trim()})`
                : `${this.#nsRef()}.deleteMany(${filterText})`,
            confirmLabel: kind === 'update' ? 'Update' : 'Delete',
            danger: true,
          });
        },
      },
      (next) => this.#set({ bulk: next }),
    );
    this.#set({ bulk: state });
    if (kind === 'delete') void this.#bulk.count();
  }

  setBulkUpdateText(text: string): void {
    this.#bulk?.setUpdateText(text);
  }

  async countBulk(): Promise<void> {
    await this.#bulk?.count();
  }

  /** Runs the bulk write after the confirmation, then reads the documents again. */
  async runBulk(): Promise<boolean> {
    const flow = this.#bulk;
    if (!flow) return false;
    const done = await flow.run();
    if (!done) return false;
    const result = flow.state.result;
    const text =
      flow.state.kind === 'update'
        ? `Updated ${formatCount(result?.modifiedCount ?? 0)} of ${formatCount(result?.matchedCount ?? 0)} matching documents`
        : `Deleted ${formatCount(result?.deletedCount ?? 0)} documents`;
    await this.run();
    this.#set({ notice: { kind: 'success', text } });
    return true;
  }

  closeBulk(): void {
    this.#bulk = undefined;
    this.#set({ bulk: undefined });
  }

  async dispose(): Promise<void> {
    this.builder.dispose();
    this.#runId++;
    this.#count?.abort();
    await this.#closeStream();
    await this.#lane.close();
  }
}

/** Subscribes a component to part of a collection view's state. */
export function useCollectionState<T>(
  view: CollectionView,
  selector: (state: CollectionViewState) => T,
): T {
  return useStore(view.store, selector);
}
