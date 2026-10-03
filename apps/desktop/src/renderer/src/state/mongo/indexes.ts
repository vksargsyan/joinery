import type {
  BsonDocument,
  IndexInfo,
  IndexKind,
  IndexSpec,
  Namespace,
} from '@querybara/mongo-tools';
import {
  Int32,
  formatShellInline,
  fromEjson,
  parseShellDocument,
  quoteShellString,
  toEjson,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import type { Notice } from './collection-view';
import { namespaceReference } from './explorer';
import {
  DEFAULT_WRITE_RULES,
  READ_ONLY_TEXT,
  confirmMongoWrite,
  loadWriteRules,
  type WriteRules,
} from './write-rules';

/**
 * The index manager (spec §9, "Schema and admin"): a collection's indexes with their keys, type
 * (single, compound, TTL, partial, unique, sparse, text, 2dsphere, hashed, wildcard), size,
 * usage from $indexStats and hidden state; a create form for every kind that shows the exact
 * `createIndex` command it runs; drop (after a confirmation with the command) and hide/unhide.
 */

// ---------------------------------------------------------------------------------------------
// Listing

/** The labels the type column shows for an index: its kind, then its options. */
export function indexBadges(index: IndexInfo): string[] {
  const badges: string[] = [index.kind];
  if (index.expireAfterSeconds !== undefined) badges.push('TTL');
  if (index.partialFilterExpression !== undefined) badges.push('partial');
  if (index.unique) badges.push('unique');
  if (index.sparse) badges.push('sparse');
  return badges;
}

/** An index's key pattern as mongosh prints it. */
export function keysText(index: Pick<IndexInfo, 'keys'>): string {
  try {
    return formatShellInline(fromEjson(index.keys, 'index keys'));
  } catch {
    return index.keys;
  }
}

/** Bytes as "12.3 kB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '–';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The mongosh command that drops an index. */
export function dropIndexCommand(ns: Namespace, name: string): string {
  return `${namespaceReference(ns.db, ns.collection)}.dropIndex(${quoteShellString(name)})`;
}

/** The mongosh command that hides or unhides an index. */
export function hideIndexCommand(ns: Namespace, name: string, hidden: boolean): string {
  return `${namespaceReference(ns.db, ns.collection)}.${hidden ? 'hideIndex' : 'unhideIndex'}(${quoteShellString(name)})`;
}

// ---------------------------------------------------------------------------------------------
// The create form

export type KeyType = '1' | '-1' | 'text' | '2dsphere' | '2d' | 'hashed';

export interface IndexKeyField {
  readonly field: string;
  readonly type: KeyType;
}

export interface IndexForm {
  readonly keys: readonly IndexKeyField[];
  /** Empty: the server's default name. */
  readonly name: string;
  readonly unique: boolean;
  readonly sparse: boolean;
  readonly hidden: boolean;
  /** TTL seconds; empty for none. */
  readonly ttl: string;
  /** mongosh documents; empty for none. */
  readonly partialFilter: string;
  readonly collation: string;
  readonly wildcardProjection: string;
  readonly weights: string;
  readonly defaultLanguage: string;
}

export type IndexFormField = Exclude<keyof IndexForm, 'hidden'>;

/** The kinds the form's presets set up. */
export type IndexPreset =
  'single' | 'compound' | 'ttl' | 'partial' | 'text' | '2dsphere' | 'hashed' | 'wildcard';

export const EMPTY_INDEX_FORM: IndexForm = {
  keys: [{ field: '', type: '1' }],
  name: '',
  unique: false,
  sparse: false,
  hidden: false,
  ttl: '',
  partialFilter: '',
  collation: '',
  wildcardProjection: '',
  weights: '',
  defaultLanguage: '',
};

/** A form set up for one kind of index, keeping the fields already typed. */
export function presetForm(preset: IndexPreset, form: IndexForm = EMPTY_INDEX_FORM): IndexForm {
  const first = form.keys[0]?.field ?? '';
  const plain = first === '$**' || first.endsWith('.$**') ? '' : first;
  switch (preset) {
    case 'single':
      return { ...form, keys: [{ field: plain, type: '1' }], ttl: '' };
    case 'compound':
      return {
        ...form,
        keys: [
          { field: plain, type: '1' },
          { field: form.keys[1]?.field ?? '', type: '1' },
        ],
        ttl: '',
      };
    case 'ttl':
      return { ...form, keys: [{ field: plain, type: '1' }], ttl: form.ttl || '3600' };
    case 'partial':
      return {
        ...form,
        sparse: false,
        partialFilter: form.partialFilter || '{ field: { $exists: true } }',
      };
    case 'text':
      return { ...form, keys: [{ field: plain, type: 'text' }], ttl: '', unique: false };
    case '2dsphere':
      return { ...form, keys: [{ field: plain, type: '2dsphere' }], ttl: '' };
    case 'hashed':
      return { ...form, keys: [{ field: plain, type: 'hashed' }], ttl: '', unique: false };
    case 'wildcard':
      return { ...form, keys: [{ field: '$**', type: '1' }], ttl: '', unique: false };
  }
}

export interface IndexPlan {
  readonly spec: IndexSpec;
  /** The mongosh command that creates it. */
  readonly command: string;
  /** The name the server gives it. */
  readonly name: string;
  readonly kind: IndexKind;
}

export type BuiltIndex =
  | { readonly ok: true; readonly plan: IndexPlan }
  | { readonly ok: false; readonly issues: Partial<Record<IndexFormField, string>> };

function keyValue(type: KeyType): Int32 | string {
  return type === '1' ? new Int32(1) : type === '-1' ? new Int32(-1) : type;
}

function isWildcard(field: string): boolean {
  return field === '$**' || field.endsWith('.$**');
}

/** The server's default index name: each key and its value joined with "_". */
export function defaultIndexName(keys: readonly IndexKeyField[]): string {
  return keys.map((key) => `${key.field}_${key.type}`).join('_');
}

function kindOf(keys: readonly IndexKeyField[]): IndexKind {
  if (keys.some((key) => isWildcard(key.field))) return 'wildcard';
  if (keys.some((key) => key.type === 'text')) return 'text';
  if (keys.some((key) => key.type === '2dsphere')) return '2dsphere';
  if (keys.some((key) => key.type === '2d')) return '2d';
  if (keys.some((key) => key.type === 'hashed')) return 'hashed';
  return keys.length > 1 ? 'compound' : 'single';
}

function documentOption(
  issues: Partial<Record<IndexFormField, string>>,
  field: IndexFormField,
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

const MAX_TTL = 2_147_483_647;

/**
 * Checks the form and builds the index: its spec for the connection host and the `createIndex`
 * command shown before it runs. Combinations the server refuses (TTL on a compound index,
 * partial with sparse, a unique hashed index...) are reported on the field that causes them.
 */
export function buildIndex(ns: Namespace, form: IndexForm): BuiltIndex {
  const issues: Partial<Record<IndexFormField, string>> = {};
  const keys = form.keys.map((key) => ({ field: key.field.trim(), type: key.type }));
  if (keys.length === 0 || keys.some((key) => key.field === '')) {
    issues.keys = 'Name every key field';
  } else if (new Set(keys.map((key) => key.field)).size !== keys.length) {
    issues.keys = 'A field can be in the key only once';
  } else if (keys.filter((key) => key.type === 'hashed').length > 1) {
    issues.keys = 'An index can hash only one field';
  } else if (keys.some((key) => isWildcard(key.field) && key.type !== '1' && key.type !== '-1')) {
    issues.keys = 'A wildcard key ($**) takes 1 or -1';
  }
  const kind = kindOf(keys);
  const text = keys.some((key) => key.type === 'text');
  const options: BsonDocument = {};
  const spec: { -readonly [K in keyof IndexSpec]?: IndexSpec[K] } = {};

  if (form.ttl.trim() !== '') {
    const ttl = form.ttl.trim();
    if (!/^\d+$/.test(ttl) || Number(ttl) > MAX_TTL) {
      issues.ttl = 'TTL is a whole number of seconds';
    } else if (keys.length !== 1 || kind !== 'single') {
      issues.ttl = 'A TTL index has exactly one ascending or descending key';
    } else if (keys[0]!.field === '_id') {
      issues.ttl = 'The _id field cannot have a TTL index';
    } else {
      spec.expireAfterSeconds = Number(ttl);
      options['expireAfterSeconds'] = new Int32(Number(ttl));
    }
  }
  if (form.unique) {
    if (kind === 'hashed' || kind === 'wildcard' || kind === 'text') {
      issues.unique = `A ${kind} index cannot be unique`;
    } else {
      spec.unique = true;
      options['unique'] = true;
    }
  }
  const partial = documentOption(issues, 'partialFilter', form.partialFilter);
  if (partial !== undefined) {
    if (form.sparse) issues.sparse = 'An index is either partial or sparse, not both';
    spec.partialFilterExpression = toEjson(partial);
    options['partialFilterExpression'] = partial;
  }
  if (form.sparse && !issues.sparse) {
    spec.sparse = true;
    options['sparse'] = true;
  }
  const collation = documentOption(issues, 'collation', form.collation);
  if (collation !== undefined) {
    if (collation['locale'] === undefined) issues.collation = 'A collation needs a locale';
    spec.collation = toEjson(collation);
    options['collation'] = collation;
  }
  const projection = documentOption(issues, 'wildcardProjection', form.wildcardProjection);
  if (projection !== undefined) {
    if (!(keys.length === 1 && keys[0]!.field === '$**')) {
      issues.wildcardProjection = 'A wildcard projection needs the single key $**';
    }
    spec.wildcardProjection = toEjson(projection);
    options['wildcardProjection'] = projection;
  }
  const weights = documentOption(issues, 'weights', form.weights);
  if (weights !== undefined) {
    if (!text) issues.weights = 'Weights apply to text indexes';
    spec.weights = toEjson(weights);
    options['weights'] = weights;
  }
  if (form.defaultLanguage.trim() !== '') {
    if (!text) issues.defaultLanguage = 'A default language applies to text indexes';
    spec.defaultLanguage = form.defaultLanguage.trim();
    options['default_language'] = form.defaultLanguage.trim();
  }
  if (form.hidden) {
    spec.hidden = true;
    options['hidden'] = true;
  }
  const name = form.name.trim();
  if (name !== '') {
    spec.name = name;
    options['name'] = name;
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };

  const keyDoc: BsonDocument = {};
  for (const key of keys) {
    Object.defineProperty(keyDoc, key.field, {
      value: keyValue(key.type),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const command = `${namespaceReference(ns.db, ns.collection)}.createIndex(${formatShellInline(keyDoc)}${
    Object.keys(options).length > 0 ? `, ${formatShellInline(options)}` : ''
  })`;
  return {
    ok: true,
    plan: {
      spec: { ...spec, keys: toEjson(keyDoc) } as IndexSpec,
      command,
      name: name !== '' ? name : defaultIndexName(keys),
      kind,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The panel's state

export interface IndexManagerTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
}

export interface CreateIndexState {
  readonly form: IndexForm;
  readonly built: BuiltIndex;
  readonly creating: boolean;
  readonly error: string | undefined;
}

export interface IndexManagerState {
  readonly indexes: readonly IndexInfo[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly notice: Notice | undefined;
  readonly create: CreateIndexState | undefined;
  readonly busy: string | undefined;
  readonly rules: WriteRules;
}

export class IndexManager {
  readonly id: string;
  readonly target: IndexManagerTarget;
  readonly store: StoreApi<IndexManagerState>;
  readonly #lane: SessionLane;

  constructor(id: string, target: IndexManagerTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<IndexManagerState>()(() => ({
      indexes: [],
      loading: false,
      error: undefined,
      notice: undefined,
      create: undefined,
      busy: undefined,
      rules: DEFAULT_WRITE_RULES,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): IndexManagerState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  get writable(): boolean {
    return !this.state.rules.readOnlyProfile;
  }

  #set(patch: Partial<IndexManagerState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ rules: await loadWriteRules(this.target.profileId) });
    await this.load();
  }

  /** Reads the indexes with their sizes and usage. */
  async load(): Promise<void> {
    this.#set({ loading: true, error: undefined });
    patchPanel(this.id, { busy: true });
    try {
      const indexes = await this.#lane.run((host, sessionId) =>
        host.mongo.indexes.list({ sessionId, ns: this.ns }),
      );
      this.#set({ indexes, loading: false });
    } catch (error) {
      this.#set({ loading: false, error: errorMessage(error) });
    } finally {
      patchPanel(this.id, { busy: false });
    }
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  #refuse(): boolean {
    if (this.writable) return false;
    this.#set({ notice: { kind: 'error', text: READ_ONLY_TEXT } });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Create

  openCreate(preset: IndexPreset = 'single'): void {
    if (this.#refuse()) return;
    this.#setForm(presetForm(preset));
  }

  #setForm(form: IndexForm): void {
    this.#set({
      create: { form, built: buildIndex(this.ns, form), creating: false, error: undefined },
    });
  }

  updateForm(patch: Partial<IndexForm>): void {
    const create = this.state.create;
    if (create) this.#setForm({ ...create.form, ...patch });
  }

  applyPreset(preset: IndexPreset): void {
    const create = this.state.create;
    if (create) this.#setForm(presetForm(preset, create.form));
  }

  setKey(index: number, patch: Partial<IndexKeyField>): void {
    const create = this.state.create;
    if (!create) return;
    const keys = create.form.keys.map((key, i) => (i === index ? { ...key, ...patch } : key));
    this.#setForm({ ...create.form, keys });
  }

  addKey(): void {
    const create = this.state.create;
    if (create)
      this.#setForm({ ...create.form, keys: [...create.form.keys, { field: '', type: '1' }] });
  }

  removeKey(index: number): void {
    const create = this.state.create;
    if (!create || create.form.keys.length <= 1) return;
    this.#setForm({ ...create.form, keys: create.form.keys.filter((_key, i) => i !== index) });
  }

  closeCreate(): void {
    this.#set({ create: undefined });
  }

  /** Creates the index the form describes (asking first on confirm-writes profiles). */
  async create(): Promise<boolean> {
    const create = this.state.create;
    if (!create || !create.built.ok || create.creating || this.#refuse()) return false;
    const plan = create.built.plan;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Create the index ${plan.name}?`,
      command: plan.command,
      confirmLabel: 'Create',
    });
    if (!ok) return false;
    this.#set({ create: { ...create, creating: true, error: undefined } });
    try {
      const { name } = await this.#lane.run((host, sessionId) =>
        host.mongo.indexes.create({
          sessionId,
          ns: this.ns,
          spec: plan.spec,
          confirmed: true,
        }),
      );
      this.#set({ create: undefined, notice: { kind: 'success', text: `Index ${name} created` } });
      await this.load();
      return true;
    } catch (error) {
      const current = this.state.create;
      if (current)
        this.#set({ create: { ...current, creating: false, error: errorMessage(error) } });
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Drop, hide

  async drop(name: string): Promise<boolean> {
    if (name === '_id_' || this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Drop the index ${name}?`,
      command: dropIndexCommand(this.ns, name),
      destructive: true,
      confirmLabel: 'Drop',
    });
    if (!ok) return false;
    this.#set({ busy: name });
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.indexes.drop({ sessionId, ns: this.ns, name, confirmed: true }),
      );
      this.#set({ notice: { kind: 'success', text: `Index ${name} dropped` } });
      await this.load();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    } finally {
      this.#set({ busy: undefined });
    }
  }

  async setHidden(name: string, hidden: boolean): Promise<boolean> {
    if (name === '_id_' || this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `${hidden ? 'Hide' : 'Unhide'} the index ${name}?`,
      command: hideIndexCommand(this.ns, name, hidden),
      confirmLabel: hidden ? 'Hide' : 'Unhide',
    });
    if (!ok) return false;
    this.#set({ busy: name });
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.indexes.setHidden({ sessionId, ns: this.ns, name, hidden, confirmed: true }),
      );
      this.#set({
        notice: {
          kind: 'success',
          text: hidden
            ? `Index ${name} hidden: the planner ignores it, and it is still maintained`
            : `Index ${name} is used again`,
        },
      });
      await this.load();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    } finally {
      this.#set({ busy: undefined });
    }
  }

  async dispose(): Promise<void> {
    await this.#lane.close();
  }
}

export function useIndexManager<T>(
  manager: IndexManager,
  selector: (state: IndexManagerState) => T,
): T {
  return useStore(manager.store, selector);
}
