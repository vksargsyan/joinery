import type { ErrorData } from '@joinery/core';
import {
  formatShell,
  fromEjson,
  isBsonDocument,
  parseShellDocument,
  toEjson,
  type BsonDocument,
  type InsertOneResult,
  type WriteSummary,
} from '@joinery/mongo-tools';

import { errorInfo } from '../../lib/errors';
import { issueOf, type TextIssue } from './query-bar';

/**
 * The document editor (spec §9): a document as mongosh text (ObjectId, ISODate, NumberDecimal,
 * NumberLong, UUID, BinData...), checked as it is typed, saved as an optimistic replace for an
 * edit or an insert for a new document or a clone (the copy without its `_id`).
 *
 * A replace only happens while the stored document still equals the one that was opened. When
 * someone changed it meanwhile the editor shows the current version (CONFLICT) and offers to
 * reload it, dropping the edit, or to overwrite it with the edit after a confirmation. A
 * document the collection's validator refuses shows each failed rule with its field.
 */

export type EditorMode = 'edit' | 'insert' | 'clone';

export type EditorStatus = 'editing' | 'saving' | 'conflict' | 'saved';

export interface EditorState {
  readonly mode: EditorMode;
  readonly text: string;
  /** Extended JSON of the document as it was read (an edit); replaced documents must still equal it. */
  readonly original: string | undefined;
  readonly status: EditorStatus;
  /** A syntax problem in the text. */
  readonly issue: TextIssue | undefined;
  /** Why the last save failed (validator rules in `lines`). */
  readonly error: { readonly message: string; readonly lines: readonly string[] } | undefined;
  /** In a conflict: the current version on the server, as Extended JSON and as shell text. */
  readonly current: { readonly ejson: string; readonly text: string } | undefined;
}

/** How the editor writes; the confirmation (production, overwrite) is the caller's. */
export interface EditorWrites {
  replace(original: string, replacement: string): Promise<WriteSummary>;
  insert(document: string): Promise<InsertOneResult>;
}

export type SaveOutcome =
  | { readonly ok: true; readonly document: string; readonly insertedId?: string }
  | { readonly ok: false };

/** Narrow enough that a document shows one field per line, while small values stay inline. */
const EDITOR_LINE_WIDTH = 40;

/** Text for a document as the editor shows it. */
export function documentText(ejson: string): string {
  return formatShell(fromEjson(ejson, 'document'), { lineWidth: EDITOR_LINE_WIDTH });
}

/** A new editor on a loaded document. */
export function editState(ejson: string): EditorState {
  return base('edit', documentText(ejson), ejson);
}

/** A new editor for a new document (`template` as shell text, `{ }` by default). */
export function insertState(template = '{\n  \n}'): EditorState {
  return base('insert', template, undefined);
}

/** A new editor on a copy of a document, without its `_id` (the server gives it a new one). */
export function cloneState(ejson: string): EditorState {
  const value = fromEjson(ejson, 'document');
  const copy: BsonDocument = {};
  if (isBsonDocument(value)) {
    for (const key of Object.keys(value)) if (key !== '_id') copy[key] = value[key]!;
  }
  return base('clone', formatShell(copy, { lineWidth: EDITOR_LINE_WIDTH }), undefined);
}

function base(mode: EditorMode, text: string, original: string | undefined): EditorState {
  return {
    mode,
    text,
    original,
    status: 'editing',
    issue: undefined,
    error: undefined,
    current: undefined,
  };
}

/** The state after the user typed: the text and its syntax check. */
export function withText(state: EditorState, text: string): EditorState {
  return { ...state, text, issue: checkDocumentText(text), error: undefined };
}

/** The syntax problem of document text, if any. */
export function checkDocumentText(text: string): TextIssue | undefined {
  try {
    parseShellDocument(text, 'document');
    return undefined;
  } catch (error) {
    return issueOf(text, error);
  }
}

/** The Extended JSON the text stands for (throws on a syntax error). */
export function documentEjson(text: string): string {
  return toEjson(parseShellDocument(text, 'document'));
}

function failure(error: ErrorData): EditorState['error'] {
  return {
    message: error.message,
    lines: error.detail ? error.detail.split('\n').filter((line) => line.trim() !== '') : [],
  };
}

/**
 * Drives one editor: `save` writes (replace or insert), and after a conflict `reload` takes the
 * current version while `overwrite` replaces it with the edit. State changes go to `onChange`.
 */
export class EditorFlow {
  #state: EditorState;

  constructor(
    state: EditorState,
    private readonly writes: EditorWrites,
    private readonly onChange: (state: EditorState) => void = () => undefined,
  ) {
    this.#state = state;
  }

  get state(): EditorState {
    return this.#state;
  }

  #set(patch: Partial<EditorState>): void {
    this.#state = { ...this.#state, ...patch };
    this.onChange(this.#state);
  }

  setText(text: string): void {
    this.#state = withText(this.#state, text);
    this.onChange(this.#state);
  }

  /** Saves the text: replace (edit) or insert (new, clone). */
  async save(): Promise<SaveOutcome> {
    const issue = checkDocumentText(this.#state.text);
    if (issue) {
      this.#set({ issue });
      return { ok: false };
    }
    const document = documentEjson(this.#state.text);
    const original = this.#state.original;
    if (this.#state.mode === 'edit' && original !== undefined) {
      return this.#replace(original, document);
    }
    this.#set({ status: 'saving', error: undefined });
    try {
      const { insertedId } = await this.writes.insert(document);
      this.#set({ status: 'saved' });
      return { ok: true, document, insertedId };
    } catch (error) {
      const info = errorInfo(error);
      this.#set({
        status: 'editing',
        error: info.code === 'CANCELLED' ? undefined : failure(info),
      });
      return { ok: false };
    }
  }

  async #replace(original: string, document: string): Promise<SaveOutcome> {
    this.#set({ status: 'saving', error: undefined });
    try {
      await this.writes.replace(original, document);
      this.#set({ status: 'saved', original: document, current: undefined });
      return { ok: true, document };
    } catch (error) {
      const info = errorInfo(error);
      if (info.code === 'CONFLICT' && info.detail !== undefined) {
        this.#set({
          status: 'conflict',
          current: { ejson: info.detail, text: documentText(info.detail) },
          error: { message: info.message, lines: [] },
        });
      } else if (info.code === 'CANCELLED') {
        this.#set({ status: this.#state.current ? 'conflict' : 'editing' });
      } else {
        this.#set({ status: 'editing', error: failure(info) });
      }
      return { ok: false };
    }
  }

  /** After a conflict: edit the current version instead (the edit is dropped). */
  reload(): void {
    const current = this.#state.current;
    if (!current) return;
    this.#state = { ...base('edit', current.text, current.ejson) };
    this.onChange(this.#state);
  }

  /** After a conflict, once the user confirmed: replace the current version with the edit. */
  async overwrite(): Promise<SaveOutcome> {
    const current = this.#state.current;
    if (!current) return { ok: false };
    const issue = checkDocumentText(this.#state.text);
    if (issue) {
      this.#set({ issue });
      return { ok: false };
    }
    return this.#replace(current.ejson, documentEjson(this.#state.text));
  }
}
