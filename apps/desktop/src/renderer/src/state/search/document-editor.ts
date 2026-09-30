import type { ErrorData } from '@joinery/core';
import {
  JsonSyntaxError,
  formatJson,
  member,
  nodeText,
  numberAt,
  parseJsonTree,
  type SearchWriteResult,
} from '@joinery/search-tools';

import { errorInfo } from '../../lib/errors';

/**
 * The Elasticsearch / OpenSearch document editor (spec §11): a document's `_source` as JSON,
 * checked as it is typed, saved with optimistic concurrency. An edit writes only over the
 * version that was read (`if_seq_no` / `if_primary_term`); when someone changed the document
 * meanwhile the save fails with CONFLICT and the editor shows their version, offering to reload
 * it (dropping the edit) or to overwrite it with the edit after a confirmation. A new document
 * is created with `op_type=create`, so an id that exists is refused rather than replaced.
 * Numbers are never re-serialised: the text is sent as typed.
 */

export type DocumentEditorMode = 'edit' | 'create';

export interface DocumentVersion {
  readonly seqNo: number;
  readonly primaryTerm: number;
}

export interface DocumentEditorState {
  readonly mode: DocumentEditorMode;
  /** The index the document is written to (a concrete index for an edit). */
  readonly index: string;
  /** The document id: fixed for an edit, optional for a create. */
  readonly id: string;
  readonly routing: string | undefined;
  readonly text: string;
  /** The version the edit applies over; undefined when the hit had none (no concurrency check). */
  readonly version: DocumentVersion | undefined;
  readonly status: 'editing' | 'saving' | 'conflict';
  readonly issue: { readonly offset: number; readonly message: string } | undefined;
  readonly error: string | undefined;
  /** In a conflict: the stored document and its version. */
  readonly current:
    { readonly text: string; readonly version: DocumentVersion | undefined } | undefined;
}

/** How the editor writes; the confirmation (production, overwrite) is the caller's. */
export interface DocumentWrites {
  index(request: {
    readonly index: string;
    readonly id: string | undefined;
    readonly source: string;
    readonly routing: string | undefined;
    readonly version: DocumentVersion | undefined;
    readonly create: boolean;
  }): Promise<SearchWriteResult>;
}

export type DocumentSaveOutcome =
  { readonly ok: true; readonly result: SearchWriteResult } | { readonly ok: false };

/** Pretty text of a document's JSON, as written (numbers and escapes untouched). */
export function sourceText(source: string | undefined): string {
  if (source === undefined || source.trim() === '') return '{\n  \n}';
  try {
    return formatJson(source);
  } catch {
    return source;
  }
}

/** The syntax problem of the editor's text, if any (it must be a JSON object). */
export function checkSource(text: string): DocumentEditorState['issue'] {
  try {
    const node = parseJsonTree(text);
    return node.type === 'object'
      ? undefined
      : { offset: node.start, message: 'A document is a JSON object: { ... }' };
  } catch (error) {
    return error instanceof JsonSyntaxError
      ? { offset: error.offset, message: error.message }
      : { offset: 0, message: String(error) };
  }
}

export function editDocumentState(hit: {
  readonly index: string;
  readonly id: string;
  readonly routing?: string;
  readonly source?: string;
  readonly seqNo?: number;
  readonly primaryTerm?: number;
}): DocumentEditorState {
  return {
    mode: 'edit',
    index: hit.index,
    id: hit.id,
    routing: hit.routing,
    text: sourceText(hit.source),
    version:
      hit.seqNo !== undefined && hit.primaryTerm !== undefined
        ? { seqNo: hit.seqNo, primaryTerm: hit.primaryTerm }
        : undefined,
    status: 'editing',
    issue: undefined,
    error: undefined,
    current: undefined,
  };
}

export function createDocumentState(index: string, template?: string): DocumentEditorState {
  return {
    mode: 'create',
    index,
    id: '',
    routing: undefined,
    text: template ?? '{\n  \n}',
    version: undefined,
    status: 'editing',
    issue: undefined,
    error: undefined,
    current: undefined,
  };
}

/**
 * The stored document a CONFLICT error carries (`detail`: `{"_seq_no", "_primary_term",
 * "_version", "_source"}` as the driver writes it).
 */
export function conflictCurrent(detail: string | undefined): DocumentEditorState['current'] {
  if (detail === undefined) return undefined;
  try {
    const root = parseJsonTree(detail);
    const source = member(root, '_source');
    const seqNo = numberAt(root, '_seq_no');
    const primaryTerm = numberAt(root, '_primary_term');
    return {
      text: sourceText(source ? nodeText(detail, source) : undefined),
      version:
        seqNo !== undefined && primaryTerm !== undefined ? { seqNo, primaryTerm } : undefined,
    };
  } catch {
    return undefined;
  }
}

function messageOf(info: ErrorData): string {
  return info.hint ? `${info.message}. ${info.hint}` : info.message;
}

/** Drives one editor (see the module comment); state changes go to `onChange`. */
export class DocumentEditorFlow {
  #state: DocumentEditorState;

  constructor(
    state: DocumentEditorState,
    private readonly writes: DocumentWrites,
    private readonly onChange: (state: DocumentEditorState) => void = () => undefined,
  ) {
    this.#state = state;
  }

  get state(): DocumentEditorState {
    return this.#state;
  }

  #set(patch: Partial<DocumentEditorState>): void {
    this.#state = { ...this.#state, ...patch };
    this.onChange(this.#state);
  }

  setText(text: string): void {
    this.#set({ text, issue: checkSource(text), error: undefined });
  }

  setId(id: string): void {
    if (this.#state.mode === 'create') this.#set({ id, error: undefined });
  }

  /** Saves over the version that was read (edit) or creates the document. */
  async save(): Promise<DocumentSaveOutcome> {
    return this.#write(this.#state.version);
  }

  /** After a conflict, once the user agreed: writes the edit over the current version. */
  async overwrite(): Promise<DocumentSaveOutcome> {
    const current = this.#state.current;
    if (!current) return { ok: false };
    return this.#write(current.version);
  }

  /** After a conflict: edit the current version instead (the edit is dropped). */
  reload(): void {
    const current = this.#state.current;
    if (!current) return;
    this.#set({
      text: current.text,
      version: current.version,
      status: 'editing',
      current: undefined,
      error: undefined,
      issue: undefined,
    });
  }

  async #write(version: DocumentVersion | undefined): Promise<DocumentSaveOutcome> {
    const issue = checkSource(this.#state.text);
    if (issue) {
      this.#set({ issue });
      return { ok: false };
    }
    const { mode, index, id, routing, text } = this.#state;
    const inConflict = this.#state.current !== undefined;
    this.#set({ status: 'saving', error: undefined });
    try {
      const result = await this.writes.index({
        index,
        id: mode === 'create' && id.trim() === '' ? undefined : id,
        source: text,
        routing,
        version: mode === 'edit' ? version : undefined,
        create: mode === 'create',
      });
      this.#set({
        status: 'editing',
        current: undefined,
        version:
          result.seqNo !== undefined && result.primaryTerm !== undefined
            ? { seqNo: result.seqNo, primaryTerm: result.primaryTerm }
            : undefined,
      });
      return { ok: true, result };
    } catch (error) {
      const info = errorInfo(error);
      if (info.code === 'CONFLICT' && mode === 'edit') {
        const current = conflictCurrent(info.detail);
        this.#set({ status: 'conflict', current, error: info.message });
      } else if (info.code === 'CONFLICT') {
        this.#set({
          status: 'editing',
          error: `A document with the id ${id} already exists in ${index}; choose another id, or leave it empty for a generated one`,
        });
      } else if (info.code === 'CANCELLED') {
        this.#set({ status: inConflict ? 'conflict' : 'editing' });
      } else {
        this.#set({ status: inConflict ? 'conflict' : 'editing', error: messageOf(info) });
      }
      return { ok: false };
    }
  }
}
