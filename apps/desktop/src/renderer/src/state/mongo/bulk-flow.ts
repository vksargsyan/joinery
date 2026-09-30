import { JoineryError } from '@joinery/core';
import { isBsonDocument, parseShell, toEjson, type WriteSummary } from '@joinery/mongo-tools';

import { errorMessage } from '../../lib/errors';
import { issueOf, type TextIssue } from './query-bar';

/**
 * Bulk update and bulk delete by the collection view's current filter (spec §9: "each with a
 * preview of the matched count"). The dry run counts the matching documents first; the write
 * runs only after the user confirmed that count, and always with `confirmed` (the connection
 * host treats both as destructive).
 */

export type BulkKind = 'update' | 'delete';

export type BulkStep = 'editing' | 'counting' | 'counted' | 'running' | 'done';

export interface BulkState {
  readonly kind: BulkKind;
  /** Extended JSON of the filter the documents are matched with. */
  readonly filter: string;
  /** The update document or pipeline as shell text (updates only). */
  readonly updateText: string;
  readonly step: BulkStep;
  /** Documents the dry run matched. */
  readonly matched: number | undefined;
  readonly result: WriteSummary | undefined;
  readonly issue: TextIssue | undefined;
  readonly error: string | undefined;
}

/** How the flow writes; `confirm` asks the user (with the command and the matched count). */
export interface BulkWrites {
  update(filter: string, update: string, dryRun: boolean): Promise<WriteSummary>;
  delete(filter: string, dryRun: boolean): Promise<WriteSummary>;
  confirm(matched: number): Promise<boolean>;
}

export function bulkState(kind: BulkKind, filter: string): BulkState {
  return {
    kind,
    filter,
    updateText: kind === 'update' ? '{ $set: {  } }' : '',
    step: 'editing',
    matched: undefined,
    result: undefined,
    issue: undefined,
    error: undefined,
  };
}

/** The update text as Extended JSON: a document of update operators, or a pipeline. */
export function updateEjson(text: string): string {
  const value = parseShell(text);
  if (!Array.isArray(value) && !isBsonDocument(value)) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The update must be a document such as { $set: { … } } or a pipeline [ … ]',
    });
  }
  return toEjson(value);
}

/** The syntax problem of update text, if any. */
export function checkUpdateText(text: string): TextIssue | undefined {
  try {
    updateEjson(text);
    return undefined;
  } catch (error) {
    return issueOf(text, error);
  }
}

export class BulkFlow {
  #state: BulkState;

  constructor(
    state: BulkState,
    private readonly writes: BulkWrites,
    private readonly onChange: (state: BulkState) => void = () => undefined,
  ) {
    this.#state = state;
  }

  get state(): BulkState {
    return this.#state;
  }

  #set(patch: Partial<BulkState>): void {
    this.#state = { ...this.#state, ...patch };
    this.onChange(this.#state);
  }

  /** A new update text; the earlier count no longer applies. */
  setUpdateText(text: string): void {
    this.#set({
      updateText: text,
      issue: checkUpdateText(text),
      step: 'editing',
      matched: undefined,
      error: undefined,
    });
  }

  /** The dry run: how many documents the filter matches (and, for updates, checks the update). */
  async count(): Promise<number | undefined> {
    const s = this.#state;
    let update: string | undefined;
    if (s.kind === 'update') {
      try {
        update = updateEjson(s.updateText);
      } catch (error) {
        this.#set({ error: errorMessage(error) });
        return undefined;
      }
    }
    this.#set({ step: 'counting', error: undefined });
    try {
      const summary =
        s.kind === 'update'
          ? await this.writes.update(s.filter, update!, true)
          : await this.writes.delete(s.filter, true);
      this.#set({ step: 'counted', matched: summary.matchedCount });
      return summary.matchedCount;
    } catch (error) {
      this.#set({ step: 'editing', error: errorMessage(error) });
      return undefined;
    }
  }

  /** Runs the write after the user confirmed the counted matches; false when not run. */
  async run(): Promise<boolean> {
    const s = this.#state;
    if (s.step !== 'counted' || s.matched === undefined) return false;
    if (!(await this.writes.confirm(s.matched))) return false;
    this.#set({ step: 'running', error: undefined });
    try {
      const result =
        s.kind === 'update'
          ? await this.writes.update(s.filter, updateEjson(s.updateText), false)
          : await this.writes.delete(s.filter, false);
      this.#set({ step: 'done', result });
      return true;
    } catch (error) {
      this.#set({ step: 'counted', error: errorMessage(error) });
      return false;
    }
  }
}
