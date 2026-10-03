import {
  Int32,
  formatShell,
  formatShellInline,
  fromEjson,
  parseShellDocument,
  quoteShellString,
  toEjson,
  type BsonDocument,
  type CollModSpec,
  type CollectionInfo,
  type CreateCollectionSpec,
  type Namespace,
  type ValidationAction,
  type ValidationLevel,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { loadChildren } from '../explorer';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import type { Notice } from './collection-view';
import { databaseReference, namespaceReference } from './explorer';
import { collModCommand } from './schema';
import { checkStages, pipelineDocuments, type PipelineStage } from './stage-list';
import {
  DEFAULT_WRITE_RULES,
  READ_ONLY_TEXT,
  confirmMongoWrite,
  loadWriteRules,
  type WriteRules,
} from './write-rules';

/**
 * Collection options (spec §9, "Schema and admin"): the create collection form (plain, capped,
 * time series, clustered; collation; validator with its level and action), the create view form
 * (source and pipeline), and the options of an existing collection (validation rules through
 * collMod, expiry of time series and clustered collections, rename, drop). Every change turns
 * into the exact mongosh command, which the user sees and confirms before it runs.
 */

// ---------------------------------------------------------------------------------------------
// Names and numbers

/** Why a collection name is refused, or undefined when the server takes it. */
export function collectionNameIssue(name: string): string | undefined {
  if (name.trim() === '') return 'Name the collection';
  if (name !== name.trim()) return 'The name has leading or trailing spaces';
  if (name.includes('$')) return 'A collection name cannot contain $';
  if (name.includes('\0')) return 'A collection name cannot contain a null character';
  if (name.startsWith('system.')) return 'Names starting with "system." are reserved';
  return undefined;
}

function wholeNumber(text: string, what: string, min: number): number | string {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return `${what} is a whole number`;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min) return `${what} must be at least ${min}`;
  return n;
}

function documentText(
  issues: Record<string, string>,
  field: string,
  text: string,
): BsonDocument | undefined {
  if (text.trim() === '') return undefined;
  try {
    return parseShellDocument(text, field);
  } catch (error) {
    issues[field] = errorMessage(error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Create collection

export type NewCollectionKind = 'plain' | 'capped' | 'timeseries' | 'clustered';

export interface CreateCollectionForm {
  readonly name: string;
  readonly kind: NewCollectionKind;
  /** Capped: bytes, and optionally most documents. */
  readonly cappedSize: string;
  readonly cappedMax: string;
  readonly timeField: string;
  readonly metaField: string;
  readonly granularity: '' | 'seconds' | 'minutes' | 'hours';
  /** Time series and clustered: delete documents this many seconds old; empty for never. */
  readonly expireAfterSeconds: string;
  readonly collation: string;
  readonly validator: string;
  readonly validationLevel: '' | ValidationLevel;
  readonly validationAction: '' | ValidationAction;
}

export const EMPTY_COLLECTION_FORM: CreateCollectionForm = {
  name: '',
  kind: 'plain',
  cappedSize: '1048576',
  cappedMax: '',
  timeField: 'timestamp',
  metaField: '',
  granularity: '',
  expireAfterSeconds: '',
  collation: '',
  validator: '',
  validationLevel: '',
  validationAction: '',
};

export interface CollectionPlan<S> {
  readonly name: string;
  readonly spec: S;
  readonly command: string;
}

export type Built<S> =
  | { readonly ok: true; readonly plan: CollectionPlan<S> }
  | { readonly ok: false; readonly issues: Readonly<Record<string, string>> };

/** Clustered collections need MongoDB 5.3 or later. */
export function supportsClustered(version: string | undefined): boolean {
  if (version === undefined) return false;
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major > 5 || (major === 5 && minor >= 3);
}

/** Checks the form and builds the collection's spec and its `createCollection` command. */
export function buildCreateCollection(
  db: string,
  form: CreateCollectionForm,
): Built<CreateCollectionSpec> {
  const issues: Record<string, string> = {};
  const nameIssue = collectionNameIssue(form.name);
  if (nameIssue) issues['name'] = nameIssue;
  const spec: { -readonly [K in keyof CreateCollectionSpec]: CreateCollectionSpec[K] } = {};
  const options: BsonDocument = {};

  if (form.kind === 'capped') {
    const size = wholeNumber(form.cappedSize, 'Size', 1);
    const max = form.cappedMax.trim() === '' ? undefined : wholeNumber(form.cappedMax, 'Max', 1);
    if (typeof size === 'string') issues['cappedSize'] = size;
    if (typeof max === 'string') issues['cappedMax'] = max;
    if (typeof size === 'number' && typeof max !== 'string') {
      spec.capped = { size, ...(max !== undefined ? { max } : {}) };
      options['capped'] = true;
      options['size'] = size;
      if (max !== undefined) options['max'] = max;
    }
  }
  if (form.kind === 'timeseries') {
    const timeField = form.timeField.trim();
    const metaField = form.metaField.trim();
    if (timeField === '') issues['timeField'] = 'Name the field that holds the time';
    else if (metaField === timeField)
      issues['metaField'] = 'The meta field must differ from the time field';
    if (timeField !== '' && metaField !== timeField) {
      spec.timeseries = {
        timeField,
        ...(metaField !== '' ? { metaField } : {}),
        ...(form.granularity !== '' ? { granularity: form.granularity } : {}),
      };
      options['timeseries'] = { ...spec.timeseries };
    }
  }
  if (form.expireAfterSeconds.trim() !== '') {
    if (form.kind !== 'timeseries' && form.kind !== 'clustered') {
      issues['expireAfterSeconds'] = 'Only time series and clustered collections expire documents';
    } else {
      const ttl = wholeNumber(form.expireAfterSeconds, 'Expiry', 0);
      if (typeof ttl === 'string') issues['expireAfterSeconds'] = ttl;
      else {
        spec.expireAfterSeconds = ttl;
        options['expireAfterSeconds'] = ttl;
      }
    }
  }
  if (form.kind === 'clustered') {
    spec.clustered = {};
    options['clusteredIndex'] = { key: { _id: new Int32(1) }, unique: true };
  }
  const collation = documentText(issues, 'collation', form.collation);
  if (collation !== undefined) {
    if (collation['locale'] === undefined) issues['collation'] = 'A collation needs a locale';
    spec.collation = toEjson(collation);
    options['collation'] = collation;
  }
  const validator = documentText(issues, 'validator', form.validator);
  if (validator !== undefined) {
    if (form.kind === 'timeseries')
      issues['validator'] = 'Time series collections take no validator';
    spec.validator = toEjson(validator);
    options['validator'] = validator;
  }
  if (form.validationLevel !== '') {
    spec.validationLevel = form.validationLevel;
    options['validationLevel'] = form.validationLevel;
  }
  if (form.validationAction !== '') {
    spec.validationAction = form.validationAction;
    options['validationAction'] = form.validationAction;
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const name = form.name;
  const command = `${databaseReference(db)}.createCollection(${quoteShellString(name)}${
    Object.keys(options).length > 0 ? `, ${formatShellInline(options)}` : ''
  })`;
  return { ok: true, plan: { name, spec, command } };
}

// ---------------------------------------------------------------------------------------------
// Create view

export interface CreateViewForm {
  readonly name: string;
  /** The collection (or view) the view reads. */
  readonly source: string;
  readonly stages: readonly PipelineStage[];
  readonly collation: string;
}

export interface ViewSpec {
  readonly viewOn: string;
  /** Extended JSON array. */
  readonly pipeline: string;
  readonly collation?: string;
}

/** Checks the form and builds the view's spec and its `createView` command. */
export function buildCreateView(db: string, form: CreateViewForm): Built<ViewSpec> {
  const issues: Record<string, string> = {};
  const nameIssue = collectionNameIssue(form.name);
  if (nameIssue) issues['name'] = nameIssue.replace('the collection', 'the view');
  const sourceIssue = collectionNameIssue(form.source);
  if (sourceIssue)
    issues['source'] = form.source.trim() === '' ? 'Pick the source collection' : sourceIssue;
  else if (form.source === form.name) issues['source'] = 'A view cannot read itself';
  const checks = checkStages(form.stages);
  const broken = form.stages.findIndex((stage) => checks[stage.id]?.issue !== undefined);
  let pipeline: BsonDocument[] = [];
  if (broken >= 0) issues['stages'] = `Fix stage ${broken + 1}`;
  else {
    try {
      pipeline = pipelineDocuments(form.stages);
    } catch (error) {
      issues['stages'] = errorMessage(error);
    }
    if (pipeline.some((stage) => '$out' in stage || '$merge' in stage)) {
      issues['stages'] = 'A view cannot write ($out, $merge)';
    }
  }
  const collation = documentText(issues, 'collation', form.collation);
  if (collation !== undefined && collation['locale'] === undefined) {
    issues['collation'] = 'A collation needs a locale';
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const command = `${databaseReference(db)}.createView(${quoteShellString(form.name)}, ${quoteShellString(form.source)}, ${formatShell(pipeline)}${
    collation !== undefined ? `, { collation: ${formatShellInline(collation)} }` : ''
  })`;
  return {
    ok: true,
    plan: {
      name: form.name,
      command,
      spec: {
        viewOn: form.source,
        pipeline: toEjson(pipeline),
        ...(collation !== undefined ? { collation: toEjson(collation) } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Options of an existing collection

export interface ValidationForm {
  /** The validator document in mongosh syntax; empty removes it. */
  readonly validator: string;
  readonly validationLevel: ValidationLevel;
  readonly validationAction: ValidationAction;
}

/** The form showing a collection's current validation rules. */
export function validationFormOf(info: CollectionInfo): ValidationForm {
  let validator = '';
  if (info.validator !== undefined) {
    try {
      const value = fromEjson(info.validator, 'validator');
      validator =
        typeof value === 'object' && value !== null && Object.keys(value).length === 0
          ? ''
          : formatShell(value);
    } catch {
      validator = info.validator;
    }
  }
  return {
    validator,
    validationLevel: info.validationLevel ?? 'strict',
    validationAction: info.validationAction ?? 'error',
  };
}

/** The collMod changes (and command) from the current rules to the form; nothing if equal. */
export function buildValidationChange(
  ns: Namespace,
  current: ValidationForm,
  form: ValidationForm,
): Built<CollModSpec> | undefined {
  const issues: Record<string, string> = {};
  const changes: { -readonly [K in keyof CollModSpec]: CollModSpec[K] } = {};
  const shown: {
    validator?: BsonDocument;
    validationLevel?: ValidationLevel;
    validationAction?: ValidationAction;
  } = {};
  if (form.validator.trim() !== current.validator.trim()) {
    const doc =
      form.validator.trim() === '' ? {} : documentText(issues, 'validator', form.validator);
    if (doc !== undefined) {
      changes.validator = toEjson(doc);
      shown.validator = doc;
    }
  }
  if (form.validationLevel !== current.validationLevel) {
    changes.validationLevel = form.validationLevel;
    shown.validationLevel = form.validationLevel;
  }
  if (form.validationAction !== current.validationAction) {
    changes.validationAction = form.validationAction;
    shown.validationAction = form.validationAction;
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  if (Object.keys(changes).length === 0) return undefined;
  return {
    ok: true,
    plan: { name: ns.collection, spec: changes, command: collModCommand(ns, shown) },
  };
}

/** The collMod that changes (or turns off) the expiry of a time series or clustered collection. */
export function buildExpiryChange(ns: Namespace, text: string): Built<CollModSpec> {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === 'off') {
    return {
      ok: true,
      plan: {
        name: ns.collection,
        spec: { expireAfterSeconds: 'off' },
        command: collModCommand(ns, { expireAfterSeconds: 'off' }),
      },
    };
  }
  const ttl = wholeNumber(trimmed, 'Expiry', 0);
  if (typeof ttl === 'string') return { ok: false, issues: { expireAfterSeconds: ttl } };
  return {
    ok: true,
    plan: {
      name: ns.collection,
      spec: { expireAfterSeconds: ttl },
      command: collModCommand(ns, { expireAfterSeconds: ttl }),
    },
  };
}

/** The mongosh command that renames a collection within its database. */
export function renameCommand(ns: Namespace, to: string, dropTarget: boolean): string {
  return `${namespaceReference(ns.db, ns.collection)}.renameCollection(${quoteShellString(to)}${dropTarget ? ', true' : ''})`;
}

/** The mongosh command that drops a collection or view. */
export function dropCollectionCommand(ns: Namespace): string {
  return `${namespaceReference(ns.db, ns.collection)}.drop()`;
}

/** The explorer folder that lists a collection of this type. */
export function folderOf(type: CollectionInfo['type'] | 'plain' | NewCollectionKind): string {
  return type === 'view' ? 'views' : type === 'timeseries' ? 'time-series' : 'collections';
}

// ---------------------------------------------------------------------------------------------
// The options panel

export interface CollectionOptionsTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
}

export interface CollectionOptionsState {
  readonly info: CollectionInfo | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly validation: ValidationForm;
  readonly expiry: string;
  readonly renameTo: string;
  readonly dropTarget: boolean;
  readonly saving: boolean;
  readonly notice: Notice | undefined;
  /** The collection was dropped or renamed away: the panel shows nothing more. */
  readonly gone: boolean;
  readonly rules: WriteRules;
}

export class CollectionOptions {
  readonly id: string;
  target: CollectionOptionsTarget;
  readonly store: StoreApi<CollectionOptionsState>;
  readonly #lane: SessionLane;

  constructor(id: string, target: CollectionOptionsTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<CollectionOptionsState>()(() => ({
      info: undefined,
      loading: false,
      error: undefined,
      validation: { validator: '', validationLevel: 'strict', validationAction: 'error' },
      expiry: '',
      renameTo: '',
      dropTarget: false,
      saving: false,
      notice: undefined,
      gone: false,
      rules: DEFAULT_WRITE_RULES,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): CollectionOptionsState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  #set(patch: Partial<CollectionOptionsState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ rules: await loadWriteRules(this.target.profileId) });
    await this.load();
  }

  async load(): Promise<void> {
    this.#set({ loading: true, error: undefined });
    try {
      const info = await this.#lane.run((host, sessionId) =>
        host.mongo.collections.info({ sessionId, ns: this.ns }),
      );
      this.#set({
        info,
        loading: false,
        validation: validationFormOf(info),
        expiry: info.expireAfterSeconds !== undefined ? String(info.expireAfterSeconds) : '',
        renameTo: info.name,
      });
    } catch (error) {
      this.#set({ loading: false, error: errorMessage(error) });
    }
  }

  setValidation(patch: Partial<ValidationForm>): void {
    this.#set({ validation: { ...this.state.validation, ...patch } });
  }

  setExpiry(expiry: string): void {
    this.#set({ expiry });
  }

  setRename(renameTo: string, dropTarget = this.state.dropTarget): void {
    this.#set({ renameTo, dropTarget });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  /** The validation change the form holds (undefined when nothing changed). */
  validationChange(): Built<CollModSpec> | undefined {
    const info = this.state.info;
    if (!info) return undefined;
    return buildValidationChange(this.ns, validationFormOf(info), this.state.validation);
  }

  #refuse(): boolean {
    if (!this.state.rules.readOnlyProfile) return false;
    this.#set({ notice: { kind: 'error', text: READ_ONLY_TEXT } });
    return true;
  }

  async #collMod(
    title: string,
    built: Built<CollModSpec> | undefined,
    done: string,
  ): Promise<boolean> {
    if (!built || this.#refuse()) return false;
    if (!built.ok) {
      this.#set({ notice: { kind: 'error', text: Object.values(built.issues)[0] ?? 'Invalid' } });
      return false;
    }
    const ok = await confirmMongoWrite(this.state.rules, {
      title,
      command: built.plan.command,
      always: true,
      confirmLabel: 'Apply',
    });
    if (!ok) return false;
    this.#set({ saving: true });
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.collections.collMod({
          sessionId,
          ns: this.ns,
          changes: built.plan.spec,
          confirmed: true,
        }),
      );
      await this.load();
      this.#set({ notice: { kind: 'success', text: done } });
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    } finally {
      this.#set({ saving: false });
    }
  }

  saveValidation(): Promise<boolean> {
    return this.#collMod(
      `Change the validation rules of ${this.target.collection}?`,
      this.validationChange(),
      'Validation rules saved',
    );
  }

  saveExpiry(): Promise<boolean> {
    return this.#collMod(
      `Change the expiry of ${this.target.collection}?`,
      buildExpiryChange(this.ns, this.state.expiry),
      'Expiry saved',
    );
  }

  /** Renames the collection; the panel then shows it under its new name. */
  async rename(): Promise<boolean> {
    const to = this.state.renameTo.trim();
    const issue = collectionNameIssue(to);
    if (issue || to === this.target.collection) {
      this.#set({ notice: { kind: 'error', text: issue ?? 'Type a new name' } });
      return false;
    }
    if (this.#refuse()) return false;
    const dropTarget = this.state.dropTarget;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Rename ${this.target.collection} to ${to}?`,
      command: renameCommand(this.ns, to, dropTarget),
      always: true,
      destructive: dropTarget,
      confirmLabel: 'Rename',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.collections.rename({ sessionId, ns: this.ns, to, dropTarget, confirmed: true }),
      );
      const folder = folderOf(this.state.info?.type ?? 'collection');
      this.target = { ...this.target, collection: to };
      patchPanel(this.id, { title: `${to} options` });
      await loadChildren(this.target.profileId, [this.target.db, folder]).catch(() => undefined);
      await this.load();
      this.#set({ notice: { kind: 'success', text: `Renamed to ${to}` } });
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  /** Drops the collection (or view) after a confirmation that shows the command. */
  async drop(): Promise<boolean> {
    if (this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Drop ${this.target.db}.${this.target.collection}?`,
      command: dropCollectionCommand(this.ns),
      destructive: true,
      confirmLabel: 'Drop',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.collections.drop({ sessionId, ns: this.ns, confirmed: true }),
      );
      const folder = folderOf(this.state.info?.type ?? 'collection');
      this.#set({ gone: true, notice: { kind: 'success', text: 'Dropped' } });
      await loadChildren(this.target.profileId, [this.target.db, folder]).catch(() => undefined);
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  async dispose(): Promise<void> {
    await this.#lane.close();
  }
}

export function useCollectionOptions<T>(
  panel: CollectionOptions,
  selector: (state: CollectionOptionsState) => T,
): T {
  return useStore(panel.store, selector);
}
