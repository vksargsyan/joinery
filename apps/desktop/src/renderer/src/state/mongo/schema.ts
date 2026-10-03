import {
  formatShell,
  formatShellInline,
  parseShellDocument,
  quoteShellString,
  toEjson,
  toJsonSchema,
  type BsonDocument,
  type BsonTypeName,
  type Namespace,
  type SchemaAnalysis,
  type SchemaField,
  type ValidationAction,
  type ValidationLevel,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import type { Notice } from './collection-view';
import { databaseReference } from './explorer';
import { issueOf, type TextIssue } from './query-bar';
import {
  DEFAULT_WRITE_RULES,
  READ_ONLY_TEXT,
  confirmMongoWrite,
  loadWriteRules,
  type WriteRules,
} from './write-rules';

/**
 * Schema analysis (spec §9, "Schema and admin"): a user-sized $sample of a collection (after an
 * optional filter) analysed by the driver into field paths with their type mix, the share of
 * documents that have them and their most common values. The result shows as a field tree;
 * it exports as a JSON Schema (draft 2020-12) or a `$jsonSchema` validator (to a file or the
 * clipboard), and applies as the collection's validator through collMod after a confirmation
 * that shows the command.
 */

// ---------------------------------------------------------------------------------------------
// The result as rows

export interface TypeShare {
  readonly type: BsonTypeName;
  readonly count: number;
  /** Of the values seen at the path. */
  readonly share: number;
}

export interface SchemaRow {
  /** The display path, unique in the tree ("items[].sku"). */
  readonly key: string;
  readonly field: SchemaField;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly types: readonly TypeShare[];
}

/** A field's type mix as shares of its values, most frequent first. */
export function typeMix(field: SchemaField): TypeShare[] {
  const total = field.types.reduce((sum, t) => sum + t.count, 0);
  return field.types.map((t) => ({
    type: t.type,
    count: t.count,
    share: total === 0 ? 0 : t.count / total,
  }));
}

/** Sub-document fields, then the array element node. */
function childrenOf(field: SchemaField): SchemaField[] {
  return [...field.fields, ...(field.items ? [field.items] : [])];
}

/** The analysis as table rows: top-level fields, with the expanded ones' children below them. */
export function schemaRows(
  analysis: SchemaAnalysis,
  expanded: Readonly<Record<string, boolean>>,
): SchemaRow[] {
  const rows: SchemaRow[] = [];
  const visit = (field: SchemaField, depth: number): void => {
    const children = childrenOf(field);
    const open = expanded[field.path] === true;
    rows.push({
      key: field.path,
      field,
      depth,
      expandable: children.length > 0,
      expanded: open,
      types: typeMix(field),
    });
    if (open) for (const child of children) visit(child, depth + 1);
  };
  for (const field of analysis.fields) visit(field, 0);
  return rows;
}

/** Every path with children, for "expand all". */
export function expandablePaths(analysis: SchemaAnalysis): string[] {
  const paths: string[] = [];
  const visit = (field: SchemaField): void => {
    const children = childrenOf(field);
    if (children.length > 0) paths.push(field.path);
    children.forEach(visit);
  };
  analysis.fields.forEach(visit);
  return paths;
}

/** Finds a field by its display path. */
export function fieldAt(analysis: SchemaAnalysis, path: string): SchemaField | undefined {
  const search = (fields: readonly SchemaField[]): SchemaField | undefined => {
    for (const field of fields) {
      if (field.path === path) return field;
      const found = search(childrenOf(field));
      if (found) return found;
    }
    return undefined;
  };
  return search(analysis.fields);
}

// ---------------------------------------------------------------------------------------------
// Exports

export interface ExportOptions {
  /** A field is required when this share of its parents has it; default 1 (all of them). */
  readonly requiredThreshold?: number;
}

/** Standard JSON Schema (draft 2020-12) for the documents as relaxed Extended JSON. */
export function jsonSchemaText(analysis: SchemaAnalysis, options: ExportOptions = {}): string {
  return JSON.stringify(
    toJsonSchema(analysis, {
      dialect: 'json-schema',
      requiredThreshold: options.requiredThreshold ?? 1,
    }),
    null,
    2,
  );
}

/** The `{ $jsonSchema: … }` validator document (bsonType names). */
export function validatorDocument(
  analysis: SchemaAnalysis,
  options: ExportOptions = {},
): BsonDocument {
  const schema = toJsonSchema(analysis, {
    dialect: 'mongodb',
    requiredThreshold: options.requiredThreshold ?? 1,
  });
  return { $jsonSchema: schema as BsonDocument };
}

/** The validator as a JSON file holds it. */
export function validatorJsonText(analysis: SchemaAnalysis, options: ExportOptions = {}): string {
  return JSON.stringify(validatorDocument(analysis, options), null, 2);
}

/** The validator in mongosh syntax. */
export function validatorShellText(analysis: SchemaAnalysis, options: ExportOptions = {}): string {
  return formatShell(validatorDocument(analysis, options));
}

/** The collMod command that sets a collection's validation rules. */
export function collModCommand(
  ns: Namespace,
  changes: {
    readonly validator?: BsonDocument;
    readonly validationLevel?: ValidationLevel;
    readonly validationAction?: ValidationAction;
    readonly expireAfterSeconds?: number | 'off';
  },
): string {
  const parts = [`collMod: ${quoteShellString(ns.collection)}`];
  if (changes.validator !== undefined)
    parts.push(`validator: ${formatShellInline(changes.validator)}`);
  if (changes.validationLevel !== undefined) {
    parts.push(`validationLevel: ${quoteShellString(changes.validationLevel)}`);
  }
  if (changes.validationAction !== undefined) {
    parts.push(`validationAction: ${quoteShellString(changes.validationAction)}`);
  }
  if (changes.expireAfterSeconds !== undefined) {
    parts.push(
      `expireAfterSeconds: ${changes.expireAfterSeconds === 'off' ? "'off'" : changes.expireAfterSeconds}`,
    );
  }
  return `${databaseReference(ns.db)}.runCommand({ ${parts.join(', ')} })`;
}

// ---------------------------------------------------------------------------------------------
// The panel's state

export interface SchemaTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
  readonly kind: 'collection' | 'view' | 'time-series';
}

export const DEFAULT_SCHEMA_SAMPLE = 1000;

export interface SchemaState {
  readonly sampleSize: number;
  readonly filter: string;
  readonly filterIssue: TextIssue | undefined;
  readonly running: boolean;
  /** When the running analysis started (for the elapsed time). */
  readonly startedAt: number | undefined;
  readonly durationMs: number | undefined;
  readonly result: SchemaAnalysis | undefined;
  readonly error: string | undefined;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly selected: string | undefined;
  /** Share of documents a field needs to count as required in the exports. */
  readonly requiredThreshold: number;
  readonly validationLevel: ValidationLevel;
  readonly validationAction: ValidationAction;
  readonly notice: Notice | undefined;
  readonly rules: WriteRules;
}

export class SchemaPanelState {
  readonly id: string;
  readonly target: SchemaTarget;
  readonly store: StoreApi<SchemaState>;
  readonly #lane: SessionLane;
  #controller: AbortController | undefined;

  constructor(id: string, target: SchemaTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<SchemaState>()(() => ({
      sampleSize: DEFAULT_SCHEMA_SAMPLE,
      filter: '',
      filterIssue: undefined,
      running: false,
      startedAt: undefined,
      durationMs: undefined,
      result: undefined,
      error: undefined,
      expanded: {},
      selected: undefined,
      requiredThreshold: 1,
      validationLevel: 'strict',
      validationAction: 'error',
      notice: undefined,
      rules: DEFAULT_WRITE_RULES,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): SchemaState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  #set(patch: Partial<SchemaState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ rules: await loadWriteRules(this.target.profileId) });
    await this.run();
  }

  setSampleSize(size: number): void {
    if (Number.isInteger(size) && size >= 1 && size <= 100_000) this.#set({ sampleSize: size });
  }

  setFilter(filter: string): void {
    let filterIssue: TextIssue | undefined;
    if (filter.trim() !== '') {
      try {
        parseShellDocument(filter, 'filter');
      } catch (error) {
        filterIssue = issueOf(filter, error);
      }
    }
    this.#set({ filter, filterIssue });
  }

  setRequiredThreshold(share: number): void {
    if (share > 0 && share <= 1) this.#set({ requiredThreshold: share });
  }

  setValidation(patch: { level?: ValidationLevel; action?: ValidationAction }): void {
    this.#set({
      ...(patch.level ? { validationLevel: patch.level } : {}),
      ...(patch.action ? { validationAction: patch.action } : {}),
    });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  /** Samples and analyses the collection; cancel() stops it on the server. */
  async run(): Promise<void> {
    if (this.state.running) return;
    if (this.state.filterIssue) {
      this.#set({ notice: { kind: 'error', text: 'Fix the filter first.' } });
      return;
    }
    const filter = this.state.filter.trim();
    const controller = new AbortController();
    this.#controller = controller;
    const startedAt = performance.now();
    this.#set({ running: true, startedAt, error: undefined, notice: undefined });
    patchPanel(this.id, { busy: true });
    try {
      const result = await this.#lane.run((host, sessionId) =>
        host.mongo.analyzeSchema(
          {
            sessionId,
            ns: this.ns,
            options: {
              sampleSize: this.state.sampleSize,
              ...(filter !== '' ? { filter: toEjson(parseShellDocument(filter, 'filter')) } : {}),
            },
          },
          { signal: controller.signal },
        ),
      );
      if (this.#controller !== controller) return;
      this.#set({
        result,
        durationMs: Math.round(performance.now() - startedAt),
        expanded: {},
        selected: result.fields[0]?.path,
      });
    } catch (error) {
      if (this.#controller !== controller) return;
      const cancelled = controller.signal.aborted || errorInfo(error).code === 'CANCELLED';
      this.#set(
        cancelled
          ? { notice: { kind: 'info', text: 'Analysis cancelled' } }
          : { error: errorMessage(error) },
      );
    } finally {
      if (this.#controller === controller) {
        this.#controller = undefined;
        this.#set({ running: false, startedAt: undefined });
        patchPanel(this.id, { busy: false });
      }
    }
  }

  cancel(): void {
    this.#controller?.abort();
  }

  toggle(path: string): void {
    const expanded = { ...this.state.expanded };
    if (expanded[path]) delete expanded[path];
    else expanded[path] = true;
    this.#set({ expanded });
  }

  expandAll(open: boolean): void {
    const result = this.state.result;
    if (!result) return;
    this.#set({
      expanded: open ? Object.fromEntries(expandablePaths(result).map((p) => [p, true])) : {},
    });
  }

  select(path: string): void {
    this.#set({ selected: path });
  }

  // -------------------------------------------------------------------------------------------
  // Exports

  exportText(kind: 'json-schema' | 'validator'): string | undefined {
    const result = this.state.result;
    if (!result) return undefined;
    const options = { requiredThreshold: this.state.requiredThreshold };
    return kind === 'json-schema'
      ? jsonSchemaText(result, options)
      : validatorJsonText(result, options);
  }

  /** Saves an export where the user picks, through main's save dialog and file grants. */
  async saveExport(kind: 'json-schema' | 'validator'): Promise<void> {
    const text = this.exportText(kind);
    if (text === undefined) return;
    try {
      const { path } = await mainApi().dialogs.saveFile({
        title: kind === 'json-schema' ? 'Save JSON Schema' : 'Save validator',
        defaultName: `${this.target.collection}.${kind === 'json-schema' ? 'schema' : 'validator'}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (path === null) return;
      await mainApi().mongo.writeText({ path, text });
      this.#set({ notice: { kind: 'success', text: `Saved to ${path}` } });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  noteCopied(what: string): void {
    this.#set({ notice: { kind: 'success', text: `${what} copied to the clipboard` } });
  }

  /** The collMod command that applies the analysed schema as the validator. */
  applyCommand(): string | undefined {
    const result = this.state.result;
    if (!result) return undefined;
    return collModCommand(this.ns, {
      validator: validatorDocument(result, { requiredThreshold: this.state.requiredThreshold }),
      validationLevel: this.state.validationLevel,
      validationAction: this.state.validationAction,
    });
  }

  /** Sets the analysed schema as the collection's validator, after showing the command. */
  async applyValidator(): Promise<boolean> {
    const result = this.state.result;
    const command = this.applyCommand();
    if (!result || command === undefined) return false;
    if (this.state.rules.readOnlyProfile || this.target.kind === 'view') {
      this.#set({
        notice: {
          kind: 'error',
          text: this.target.kind === 'view' ? 'A view has no validator.' : READ_ONLY_TEXT,
        },
      });
      return false;
    }
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Apply the schema as the validator of ${this.target.collection}?`,
      message:
        this.state.validationAction === 'error'
          ? 'Inserts and updates that do not match are refused from now on. This runs:'
          : 'Documents that do not match are logged from now on. This runs:',
      command,
      always: true,
      confirmLabel: 'Apply',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.collections.collMod({
          sessionId,
          ns: this.ns,
          changes: {
            validator: toEjson(
              validatorDocument(result, { requiredThreshold: this.state.requiredThreshold }),
            ),
            validationLevel: this.state.validationLevel,
            validationAction: this.state.validationAction,
          },
          confirmed: true,
        }),
      );
      this.#set({ notice: { kind: 'success', text: 'Validator applied' } });
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.#controller?.abort();
    await this.#lane.close();
  }
}

export function useSchemaPanel<T>(panel: SchemaPanelState, selector: (state: SchemaState) => T): T {
  return useStore(panel.store, selector);
}
