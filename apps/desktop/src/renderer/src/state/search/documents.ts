import { JoineryError } from '@joinery/core';
import type { RpcStream } from '@joinery/ipc';
import {
  bulkDeleteLines,
  bulkUpdateLines,
  classifyRequest,
  dslFields,
  formatConsoleRequest,
  formatJson,
  flatRecord,
  mappingFields,
  parseJsonTree,
  parseSearchError,
  partialDocument,
  topValuesBody,
  valueJsonOf,
  type BulkTarget,
  type FlatField,
  type SearchBulkItem,
  type SearchHit,
  type SearchPage,
} from '@joinery/search-tools';

import { errorInfo, errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import {
  DocumentEditorFlow,
  createDocumentState,
  editDocumentState,
  type DocumentEditorState,
} from './document-editor';
import { DslBuilder } from './query-builder';
import { BASE_STATE, SearchView, type SearchViewState } from './view';

/**
 * The document grid of an index, alias or data stream (spec §11): a search (a Query DSL clause
 * or a Lucene query string, a sort and aggregations, typed or built with the query builder)
 * whose hits load a page at a time as the grid scrolls, with each `_source` flattened into
 * dotted columns, and whose aggregations show beside them. Deep pages come from a point in time with
 * search_after (a scroll where there is none), never from/size, so paging past 10,000 hits
 * works. Documents are created, edited with optimistic concurrency (a conflict shows the stored
 * version) and deleted; selected rows are deleted or updated through `_bulk`, and pasted NDJSON
 * runs as a bulk request, each with its per-item outcome.
 */

export interface DocumentsTarget {
  readonly profileId: string;
  /** The index, alias or data stream searched. */
  readonly target: string;
  readonly kind: 'index' | 'alias' | 'data-stream';
}

/** Hits per page pulled from the server. */
export const DOCUMENT_PAGE_SIZE = 100;
/** Loads the next page when the last visible row is this close to the end. */
const PREFETCH_ROWS = 30;
/** Columns shown at most (mapped fields first). */
const MAX_COLUMNS = 300;

/** The outcome of a bulk action, per item. */
export interface BulkOutcome {
  readonly title: string;
  readonly items: readonly SearchBulkItem[];
  readonly failed: number;
}

export interface DocumentsState extends SearchViewState {
  /** A Query DSL clause (`{"term": ...}`) or a Lucene query string; empty matches everything. */
  readonly queryText: string;
  /** The sort as JSON (`[{"date": "desc"}]`); empty for index order. */
  readonly sortText: string;
  /** Aggregations as JSON (`{"by_status": {"terms": {"field": "status"}}}`); empty for none. */
  readonly aggsText: string;
  readonly issue: string | undefined;
  readonly pageSize: number;
  readonly running: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly hits: readonly SearchHit[];
  /** Bumped whenever `hits` changes (the grid redraws). */
  readonly version: number;
  readonly total: SearchPage['total'];
  readonly exactCount: number | undefined;
  readonly paging: SearchPage['paging'] | undefined;
  /** The last search's aggregation results (JSON text). */
  readonly aggregations: string | undefined;
  /** What the panel shows under the query bar. */
  readonly resultTab: 'documents' | 'aggregations';
  readonly tookMs: number | undefined;
  readonly error: string | undefined;
  /** Field columns (dotted paths), after the `_id` (and `_index`) columns. */
  readonly columns: readonly string[];
  readonly truncatedColumns: boolean;
  readonly editor: DocumentEditorState | undefined;
  readonly bulk: BulkOutcome | undefined;
}

/** The query clause of the query bar: JSON as written, text as a `query_string` query. */
export function queryClause(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('{')) {
    const node = parseJsonTree(trimmed);
    if (node.type !== 'object') throw new Error('The query is a JSON object');
    return trimmed;
  }
  return `{"query_string": {"query": ${JSON.stringify(trimmed)}}}`;
}

/** The search body of the query bar (JSON text), or throws what is wrong with it. */
export function searchBody(queryText: string, sortText: string, aggsText = ''): string {
  const members: string[] = [];
  let query: string | undefined;
  try {
    query = queryClause(queryText);
  } catch (error) {
    throw new Error(`The query is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (query !== undefined) members.push(`"query": ${query}`);
  const sort = sortText.trim();
  if (sort !== '') {
    try {
      parseJsonTree(sort);
    } catch (error) {
      throw new Error(`The sort is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
    members.push(`"sort": ${sort}`);
  }
  const aggs = aggsText.trim();
  if (aggs !== '') {
    let node;
    try {
      node = parseJsonTree(aggs);
    } catch (error) {
      throw new Error(`The aggregations are not valid JSON: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (node.type !== 'object') throw new Error('The aggregations are a JSON object');
    members.push(`"aggs": ${aggs}`);
  }
  return `{${members.join(', ')}}`;
}

export class DocumentsView extends SearchView<DocumentsState> {
  readonly target: DocumentsTarget;
  readonly builder: DslBuilder;
  #records: ReadonlyMap<string, FlatField>[] = [];
  #mapped: string[] = [];
  #stream: RpcStream<SearchPage> | undefined;
  #runId = 0;
  #editor: DocumentEditorFlow | undefined;

  constructor(id: string, target: DocumentsTarget) {
    super(id, target.profileId, {
      ...BASE_STATE,
      queryText: '',
      sortText: '',
      aggsText: '',
      issue: undefined,
      pageSize: DOCUMENT_PAGE_SIZE,
      running: false,
      loadingMore: false,
      hasMore: false,
      hits: [],
      version: 0,
      total: undefined,
      exactCount: undefined,
      paging: undefined,
      aggregations: undefined,
      resultTab: 'documents',
      tookMs: undefined,
      error: undefined,
      columns: [],
      truncatedColumns: false,
      editor: undefined,
      bulk: undefined,
    });
    this.target = target;
    this.builder = new DslBuilder({
      texts: () => ({
        query: this.state.queryText,
        sort: this.state.sortText,
        aggs: this.state.aggsText,
      }),
      subscribe: (listener) => this.store.subscribe(listener),
      setTexts: (texts) =>
        this.set({
          queryText: texts.query,
          sortText: texts.sort,
          aggsText: texts.aggs,
          issue: undefined,
        }),
      topValues: async (path) => {
        const response = await this.call((host, sessionId) =>
          host.search.request({
            sessionId,
            request: {
              method: 'POST',
              path: `/${encodeURIComponent(this.target.target)}/_search`,
              body: topValuesBody(path),
            },
          }),
        );
        if (response.status >= 300) {
          throw new Error(parseSearchError(response.body)?.reason ?? `HTTP ${response.status}`);
        }
        return response.body;
      },
    });
  }

  /** Several indices can answer (an alias, a data stream, a pattern): show `_index`. */
  get showsIndex(): boolean {
    return this.target.kind !== 'index' || /[*,]/.test(this.target.target);
  }

  get writable(): boolean {
    return !this.readOnly;
  }

  async init(): Promise<void> {
    await this.loadBasics();
    await this.#loadMapping();
    await this.search();
  }

  /** Mapped fields become the first columns, so empty ones show too, and the builder's fields. */
  async #loadMapping(): Promise<void> {
    this.builder.setFields({ status: 'loading', fields: [], error: undefined });
    try {
      const mapping = mappingFields(
        await this.call((host, sessionId) =>
          host.search.indices.getMapping({ sessionId, index: this.target.target }),
        ),
      );
      this.#mapped = mapping
        .filter((f) => !f.multiField && f.type !== 'object' && f.type !== 'nested')
        .map((f) => f.path);
      this.builder.setFields({ status: 'done', fields: dslFields(mapping), error: undefined });
    } catch (error) {
      this.#mapped = [];
      this.builder.setFields({
        status: 'error',
        fields: dslFields([]),
        error: errorMessage(error),
      });
    }
  }

  /** Reads the mapping again (the builder's field list). */
  async reloadFields(): Promise<void> {
    await this.#loadMapping();
  }

  setQueryText(text: string): void {
    this.set({ queryText: text, issue: undefined });
  }

  setSortText(text: string): void {
    this.set({ sortText: text, issue: undefined });
  }

  setAggsText(text: string): void {
    this.set({ aggsText: text, issue: undefined });
  }

  setResultTab(resultTab: DocumentsState['resultTab']): void {
    this.set({ resultTab });
  }

  setPageSize(size: number): void {
    this.set({ pageSize: Math.max(1, Math.min(10_000, Math.floor(size))) });
  }

  /** The flattened fields of a loaded hit. */
  record(row: number): ReadonlyMap<string, FlatField> | undefined {
    return this.#records[row];
  }

  /** What a cell shows; undefined for a field the document does not have. */
  cell(row: number, column: string): FlatField | undefined {
    return this.#records[row]?.get(column);
  }

  // -------------------------------------------------------------------------------------------
  // Searching and paging

  /** Runs the query bar's search from the first page. */
  async search(): Promise<void> {
    const pending = this.builder.pendingIssue();
    if (pending !== undefined) {
      this.set({ issue: `Finish the query first: ${pending}` });
      return;
    }
    let body: string;
    try {
      body = searchBody(this.state.queryText, this.state.sortText, this.state.aggsText);
    } catch (error) {
      this.set({ issue: errorMessage(error) });
      return;
    }
    const runId = ++this.#runId;
    await this.#closeStream();
    this.#records = [];
    this.set({
      running: true,
      issue: undefined,
      error: undefined,
      notice: undefined,
      hits: [],
      version: this.state.version + 1,
      hasMore: false,
      total: undefined,
      exactCount: undefined,
      paging: undefined,
      aggregations: undefined,
      columns: this.#columnsFor([]).columns,
    });
    patchPanel(this.id, { busy: true });
    const started = performance.now();
    try {
      this.#stream = await this.call(async (host, sessionId) =>
        host.search.documents.search({
          sessionId,
          target: this.target.target,
          body,
          pageSize: this.state.pageSize,
        }),
      );
      await this.#pull(runId);
      if (runId === this.#runId) this.set({ tookMs: Math.round(performance.now() - started) });
    } finally {
      if (runId === this.#runId) {
        this.set({ running: false });
        patchPanel(this.id, { busy: false });
      }
    }
  }

  /** Pulls the next page of the current search. */
  async #pull(runId: number): Promise<void> {
    const stream = this.#stream;
    if (!stream || runId !== this.#runId) return;
    this.set({ loadingMore: true });
    try {
      const next = await stream.next();
      if (runId !== this.#runId) return;
      if (next.done) {
        this.#stream = undefined;
        this.set({ hasMore: false });
        return;
      }
      this.#append(next.value);
    } catch (error) {
      if (runId !== this.#runId) return;
      this.#stream = undefined;
      this.set({ hasMore: false, error: errorMessage(error) });
    } finally {
      if (runId === this.#runId) this.set({ loadingMore: false });
    }
  }

  #append(page: SearchPage): void {
    const records = page.hits.map((hit) => {
      try {
        return hit.source !== undefined ? flatRecord(hit.source) : new Map<string, FlatField>();
      } catch {
        return new Map<string, FlatField>();
      }
    });
    this.#records = [...this.#records, ...records];
    const hits = [...this.state.hits, ...page.hits];
    const { columns, truncated } = this.#columnsFor(this.#records);
    this.set({
      hits,
      version: this.state.version + 1,
      columns,
      truncatedColumns: truncated,
      hasMore: page.hits.length >= this.state.pageSize,
      ...(page.total !== undefined ? { total: page.total } : {}),
      ...(page.aggregations !== undefined ? { aggregations: page.aggregations } : {}),
      paging: page.paging,
    });
  }

  #columnsFor(records: readonly ReadonlyMap<string, FlatField>[]): {
    columns: string[];
    truncated: boolean;
  } {
    const seen = new Set<string>(this.#mapped);
    for (const record of records) for (const path of record.keys()) seen.add(path);
    const all = [...seen];
    return { columns: all.slice(0, MAX_COLUMNS), truncated: all.length > MAX_COLUMNS };
  }

  /** Loads more when the grid shows rows near the end of what is loaded. */
  onVisibleRows(lastVisible: number): void {
    const s = this.state;
    if (s.hasMore && !s.loadingMore && !s.running && lastVisible >= s.hits.length - PREFETCH_ROWS) {
      void this.#pull(this.#runId);
    }
  }

  /** Loads the next page (the "Load more" button). */
  async loadMore(): Promise<void> {
    if (!this.state.hasMore || this.state.loadingMore) return;
    await this.#pull(this.#runId);
  }

  /** Counts the documents the query matches exactly (the total stops at 10,000). */
  async countExactly(): Promise<void> {
    let query: string | undefined;
    try {
      query = queryClause(this.state.queryText);
    } catch (error) {
      this.set({ issue: errorMessage(error) });
      return;
    }
    await this.busy(async () => {
      const { count } = await this.call((host, sessionId) =>
        host.search.documents.count({
          sessionId,
          target: this.target.target,
          ...(query !== undefined ? { query } : {}),
        }),
      );
      this.set({ exactCount: count });
    });
  }

  async #closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.return().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // The document editor

  #refuseReadOnly(): boolean {
    if (!this.readOnly) return false;
    this.notify('error', 'This connection is read-only.');
    return true;
  }

  /** Opens the editor on a loaded document, or on a new one. */
  openEditor(mode: 'edit' | 'create', row?: number): void {
    if (this.#refuseReadOnly()) return;
    const hit = row === undefined ? undefined : this.state.hits[row];
    if (mode === 'edit' && hit === undefined) return;
    if (mode === 'edit' && hit?.source === undefined) {
      this.notify('error', 'This document was read without its _source, so it cannot be edited.');
      return;
    }
    const state =
      mode === 'edit' ? editDocumentState(hit!) : createDocumentState(this.target.target);
    this.#editor = new DocumentEditorFlow(
      state,
      {
        index: async (request) => {
          const path =
            request.id === undefined
              ? `/${request.index}/_doc`
              : `/${request.index}/${request.create ? '_create' : '_doc'}/${request.id}`;
          const version = request.version
            ? `?if_seq_no=${request.version.seqNo}&if_primary_term=${request.version.primaryTerm}`
            : '';
          const confirmed = await this.guard({
            safety: { writes: true },
            title: request.create ? 'Create the document?' : 'Save the document?',
            detail: `${request.id === undefined ? 'POST' : 'PUT'} ${path}${version}\n${request.source}`,
            confirmLabel: 'Save',
          });
          if (confirmed === undefined) {
            throw new JoineryError({ code: 'CANCELLED', message: 'Not saved' });
          }
          return this.call((host, sessionId) =>
            host.search.documents.index({
              sessionId,
              index: request.index,
              source: request.source,
              ...(request.id !== undefined ? { id: request.id } : {}),
              ...(request.create ? { opType: 'create' as const } : {}),
              ...(request.routing !== undefined ? { routing: request.routing } : {}),
              ...(request.version
                ? { ifSeqNo: request.version.seqNo, ifPrimaryTerm: request.version.primaryTerm }
                : {}),
              refresh: 'wait_for',
              confirmed,
            }),
          );
        },
      },
      (next) => this.set({ editor: next }),
    );
    this.set({ editor: state });
  }

  setEditorText(text: string): void {
    this.#editor?.setText(text);
  }

  setEditorId(id: string): void {
    this.#editor?.setId(id);
  }

  /** Saves the editor; an edited row shows the stored document afterwards. */
  async saveEditor(): Promise<boolean> {
    const flow = this.#editor;
    if (!flow) return false;
    const outcome = await flow.save();
    if (!outcome.ok) return false;
    await this.#afterSave(flow, outcome.result.id);
    return true;
  }

  /** After a conflict: take the stored version instead of the edit. */
  reloadEditor(): void {
    this.#editor?.reload();
  }

  /** After a conflict: overwrite the stored version with the edit, once the user agrees. */
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
    const outcome = await flow.overwrite();
    if (!outcome.ok) return false;
    await this.#afterSave(flow, outcome.result.id);
    return true;
  }

  async #afterSave(flow: DocumentEditorFlow, id: string): Promise<void> {
    const { mode, index } = flow.state;
    this.closeEditor();
    if (mode === 'edit') {
      const row = this.state.hits.findIndex((h) => h.index === index && h.id === id);
      if (row >= 0) await this.#reread(row);
      this.notify('success', `Saved ${id}`);
    } else {
      await this.search();
      this.notify('success', `Created ${id} in ${index}`);
    }
  }

  closeEditor(): void {
    this.#editor = undefined;
    this.set({ editor: undefined });
  }

  /** Reads loaded documents again (after an edit), keeping the grid where it is. */
  async #reread(...rows: number[]): Promise<void> {
    const hits = [...this.state.hits];
    const records = [...this.#records];
    for (const row of rows) {
      const hit = hits[row];
      if (!hit) continue;
      try {
        const doc = await this.call((host, sessionId) =>
          host.search.documents.get({
            sessionId,
            index: hit.index,
            id: hit.id,
            ...(hit.routing !== undefined ? { routing: hit.routing } : {}),
          }),
        );
        if (!doc.found) continue;
        const { seqNo: _s, primaryTerm: _p, version: _v, source: _source, ...rest } = hit;
        hits[row] = {
          ...rest,
          ...(doc.source !== undefined ? { source: doc.source } : {}),
          ...(doc.seqNo !== undefined ? { seqNo: doc.seqNo } : {}),
          ...(doc.primaryTerm !== undefined ? { primaryTerm: doc.primaryTerm } : {}),
          ...(doc.version !== undefined ? { version: doc.version } : {}),
        };
        records[row] = doc.source !== undefined ? flatRecord(doc.source) : new Map();
      } catch (error) {
        this.notify('error', errorMessage(error));
      }
    }
    this.#records = records;
    const { columns, truncated } = this.#columnsFor(records);
    this.set({ hits, version: this.state.version + 1, columns, truncatedColumns: truncated });
  }

  #removeRows(rows: ReadonlySet<number>): void {
    this.#records = this.#records.filter((_r, i) => !rows.has(i));
    this.set({
      hits: this.state.hits.filter((_h, i) => !rows.has(i)),
      version: this.state.version + 1,
      exactCount: undefined,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Deletes and bulk actions

  #targets(rows: readonly number[]): { row: number; target: BulkTarget }[] {
    return rows.flatMap((row) => {
      const hit = this.state.hits[row];
      if (!hit) return [];
      return [
        {
          row,
          target: {
            index: hit.index,
            id: hit.id,
            ...(hit.routing !== undefined ? { routing: hit.routing } : {}),
            ...(hit.seqNo !== undefined ? { seqNo: hit.seqNo } : {}),
            ...(hit.primaryTerm !== undefined ? { primaryTerm: hit.primaryTerm } : {}),
          },
        },
      ];
    });
  }

  /** Deletes the documents of these rows (one DELETE, or a bulk request for several). */
  async deleteRows(rows: readonly number[]): Promise<void> {
    if (this.#refuseReadOnly()) return;
    const targets = this.#targets(rows);
    if (targets.length === 0) return;
    if (targets.length === 1) {
      const { row, target } = targets[0]!;
      const path = `/${target.index}/_doc/${target.id}`;
      const confirmed = await this.guard({
        safety: { writes: true, destructive: 'deletes the document' },
        title: 'Delete this document?',
        detail: `DELETE ${path}`,
        confirmLabel: 'Delete',
      });
      if (confirmed === undefined) return;
      await this.busy(async () => {
        try {
          await this.call((host, sessionId) =>
            host.search.documents.delete({
              sessionId,
              index: target.index,
              id: target.id,
              ...(target.routing !== undefined ? { routing: target.routing } : {}),
              ...(target.seqNo !== undefined && target.primaryTerm !== undefined
                ? { ifSeqNo: target.seqNo, ifPrimaryTerm: target.primaryTerm }
                : {}),
              refresh: 'wait_for',
              confirmed,
            }),
          );
        } catch (error) {
          if (errorInfo(error).code === 'CONFLICT') {
            throw new JoineryError({
              code: 'CONFLICT',
              message: `${target.id} changed since it was read, so it was not deleted`,
              hint: 'Search again to see the current version',
            });
          }
          throw error;
        }
        this.#removeRows(new Set([row]));
        this.notify('success', `Deleted ${target.id}`);
      });
      return;
    }
    const ndjson = bulkDeleteLines(targets.map((t) => t.target));
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'POST', path: '/_bulk', body: ndjson }),
      title: `Delete ${formatCount(targets.length)} documents?`,
      detail: `POST /_bulk\n${ndjson}`,
      confirmLabel: 'Delete',
    });
    if (confirmed === undefined) return;
    await this.#runBulk(`Delete ${formatCount(targets.length)} documents`, ndjson, confirmed, {
      onDone: (items) => {
        const deleted = new Set(
          targets.filter((_t, i) => items[i] !== undefined && !items[i]!.error).map((t) => t.row),
        );
        this.#removeRows(deleted);
      },
    });
  }

  /** Sets one field on the documents of these rows (a bulk of partial updates). */
  async setFieldOnRows(rows: readonly number[], path: string, valueText: string): Promise<void> {
    if (this.#refuseReadOnly()) return;
    const targets = this.#targets(rows);
    if (targets.length === 0) return;
    let doc: string;
    try {
      doc = partialDocument(path.trim(), valueJsonOf(valueText));
    } catch (error) {
      this.notify('error', errorMessage(error));
      return;
    }
    const ndjson = bulkUpdateLines(
      targets.map((t) => t.target),
      doc,
    );
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'POST', path: '/_bulk', body: ndjson }),
      title: `Update ${formatCount(targets.length)} documents?`,
      detail: `POST /_bulk\n${ndjson}`,
      confirmLabel: 'Update',
    });
    if (confirmed === undefined) return;
    await this.#runBulk(
      `Set ${path} on ${formatCount(targets.length)} documents`,
      ndjson,
      confirmed,
      {
        onDone: async (items) => {
          await this.#reread(
            ...targets
              .filter((_t, i) => items[i] !== undefined && !items[i]!.error)
              .map((t) => t.row),
          );
        },
      },
    );
  }

  /** Sends pasted NDJSON to `_bulk` (the target is the default index), then searches again. */
  async sendBulk(ndjson: string): Promise<boolean> {
    if (this.#refuseReadOnly()) return false;
    if (ndjson.trim() === '') return false;
    const body = ndjson.endsWith('\n') ? ndjson : `${ndjson}\n`;
    const confirmed = await this.guard({
      safety: classifyRequest({ method: 'POST', path: '/_bulk', body }),
      title: 'Send the bulk request?',
      detail: `POST /${this.target.target}/_bulk\n${body}`,
      confirmLabel: 'Send',
    });
    if (confirmed === undefined) return false;
    let ok = false;
    await this.#runBulk('Bulk request', body, confirmed, {
      index: this.target.target,
      onDone: async () => {
        ok = true;
        await this.search();
      },
    });
    return ok;
  }

  async #runBulk(
    title: string,
    ndjson: string,
    confirmed: boolean,
    options: {
      readonly index?: string;
      readonly onDone: (items: readonly SearchBulkItem[]) => void | Promise<void>;
    },
  ): Promise<void> {
    await this.busy(async () => {
      const result = await this.call((host, sessionId) =>
        host.search.documents.bulk({
          sessionId,
          ndjson,
          refresh: 'wait_for',
          confirmed,
          ...(options.index !== undefined ? { index: options.index } : {}),
        }),
      );
      const failed = result.items.filter((i) => i.error !== undefined).length;
      await options.onDone(result.items);
      this.set({ bulk: { title, items: result.items, failed } });
      this.notify(
        failed === 0 ? 'success' : 'error',
        failed === 0
          ? `${title}: ${formatCount(result.items.length)} done`
          : `${title}: ${formatCount(failed)} of ${formatCount(result.items.length)} failed`,
      );
    });
  }

  closeBulk(): void {
    this.set({ bulk: undefined });
  }

  /** The search as a console request, to go on with it there. */
  consoleText(): string {
    const body = searchBody(this.state.queryText, this.state.sortText, this.state.aggsText);
    return formatConsoleRequest({
      method: 'GET',
      path: `/${this.target.target}/_search`,
      ...(body !== '{}' ? { body: formatJson(body) } : {}),
    });
  }

  override async dispose(): Promise<void> {
    this.builder.dispose();
    this.#runId++;
    await this.#closeStream();
    await super.dispose();
  }
}
