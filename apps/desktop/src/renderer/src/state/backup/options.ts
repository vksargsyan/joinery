import { isSqlEngine, type EngineId, type SchemaSnapshot } from '@joinery/core';
import type {
  BackupFileFormat,
  BackupInspection,
  BackupJob,
  BackupMethod,
  BackupObjectInfo,
  BackupObjectKindName,
  BackupObjectRef,
  BackupSelectionInfo,
  NativeToolInfo,
  RestoreConflictInfo,
  RestoreJob,
} from '@joinery/ipc';

/**
 * The backup and restore wizards' rules as plain functions (spec §14): which formats and
 * methods a connection offers, the object catalog the user picks from, and the job specs the
 * choices become. The dialogs hold the choices; everything here is testable without a page.
 */

/** Where a backup or restore dialog was opened: a connection, one of its databases or schemas. */
export interface BackupTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly engine: EngineId;
  /**
   * SQL and MongoDB: the database. Redis: the logical database number (undefined in Cluster
   * mode). Undefined for the connection's default.
   */
  readonly database: string | undefined;
  /** PostgreSQL: the schema the dialog was opened on. */
  readonly schema: string | undefined;
  /** Redis: the key pattern of the namespace the dialog was opened on. */
  readonly pattern: string | undefined;
  /** Redis Cluster: the primary the dialog was opened on (where BGSAVE runs). */
  readonly node: string | undefined;
  readonly readOnly: boolean;
  readonly production: boolean;
  readonly confirmWrites: boolean;
}

export const FORMAT_LABELS: Readonly<Record<BackupFileFormat, string>> = {
  jbak: 'Joinery archive (.jbak)',
  sql: 'SQL script (.sql)',
  'sql-gz': 'Compressed SQL script (.sql.gz)',
  custom: 'pg_dump custom format (.dump)',
};

const EXTENSIONS: Readonly<Record<BackupFileFormat, string>> = {
  jbak: '.jbak',
  sql: '.sql',
  'sql-gz': '.sql.gz',
  custom: '.dump',
};

/** The save dialog's filter of a format. */
export function formatFilter(format: BackupFileFormat): { name: string; extensions: string[] } {
  switch (format) {
    case 'jbak':
      return { name: 'Joinery backups', extensions: ['jbak'] };
    case 'sql':
      return { name: 'SQL scripts', extensions: ['sql'] };
    case 'sql-gz':
      return { name: 'Compressed SQL scripts', extensions: ['gz'] };
    case 'custom':
      return { name: 'pg_dump archives', extensions: ['dump', 'backup'] };
  }
}

/** The shortest passphrase an encrypted archive accepts. */
export const MIN_PASSPHRASE_LENGTH = 8;

/** Whether `engine` backs up with pg_dump or mysqldump / mariadb-dump found on this machine. */
export function nativeDumpTool(
  engine: EngineId,
  tools: readonly NativeToolInfo[],
): NativeToolInfo | undefined {
  const names =
    engine === 'postgres'
      ? ['pg_dump']
      : engine === 'mariadb'
        ? ['mariadb-dump', 'mysqldump']
        : engine === 'mysql'
          ? ['mysqldump', 'mariadb-dump']
          : [];
  for (const name of names) {
    const tool = tools.find((t) => t.name === name);
    if (tool) return tool;
  }
  return undefined;
}

/** The client that restores a native backup of `format` into `engine`, when installed. */
export function nativeRestoreTool(
  engine: EngineId,
  format: BackupFileFormat,
  tools: readonly NativeToolInfo[],
): NativeToolInfo | undefined {
  if (format === 'jbak') return undefined;
  if (engine === 'postgres') {
    const psql = tools.find((t) => t.name === 'psql');
    if (format !== 'custom') return psql;
    return psql && tools.find((t) => t.name === 'pg_restore');
  }
  if (format === 'custom') return undefined;
  const names = engine === 'mariadb' ? ['mariadb', 'mysql'] : ['mysql', 'mariadb'];
  if (!isSqlEngine(engine)) return undefined;
  for (const name of names) {
    const tool = tools.find((t) => t.name === name);
    if (tool) return tool;
  }
  return undefined;
}

/** The file formats a backup of `engine` can be written in with `method`. */
export function formatsFor(engine: EngineId, method: BackupMethod): readonly BackupFileFormat[] {
  if (!isSqlEngine(engine)) return ['jbak'];
  if (method === 'joinery') return ['jbak', 'sql', 'sql-gz'];
  return engine === 'postgres' ? ['custom', 'sql', 'sql-gz'] : ['sql', 'sql-gz'];
}

export interface BackupOptions {
  readonly method: BackupMethod;
  readonly format: BackupFileFormat;
  /** Archives: gzip each file inside. */
  readonly compress: boolean;
  readonly encrypt: boolean;
  readonly passphrase: string;
  readonly passphraseAgain: string;
  readonly structure: boolean;
  readonly data: boolean;
  readonly grants: boolean;
  readonly ownership: boolean;
  readonly consistent: boolean;
  readonly deferrable: boolean;
  readonly documentFormat: 'bson' | 'ejson';
  /** Redis: the key pattern. */
  readonly pattern: string;
  /** Where the backup is written (from the save dialog). */
  readonly path: string | undefined;
}

export function defaultBackupOptions(target: BackupTarget): BackupOptions {
  return {
    method: 'joinery',
    format: 'jbak',
    compress: true,
    encrypt: false,
    passphrase: '',
    passphraseAgain: '',
    structure: true,
    data: true,
    grants: false,
    ownership: false,
    consistent: true,
    deferrable: false,
    documentFormat: 'bson',
    pattern: target.pattern ?? '*',
    path: undefined,
  };
}

/** Options after a change, kept consistent: a format the method offers, no stale file name. */
export function changeOptions(
  engine: EngineId,
  options: BackupOptions,
  patch: Partial<BackupOptions>,
): BackupOptions {
  const next = { ...options, ...patch };
  const formats = formatsFor(engine, next.method);
  const format = formats.includes(next.format) ? next.format : formats[0]!;
  const archive = format === 'jbak' && next.method === 'joinery';
  const path =
    next.path !== undefined && !next.path.endsWith(EXTENSIONS[format]) ? undefined : next.path;
  return {
    ...next,
    format,
    encrypt: archive && next.encrypt,
    path,
  };
}

function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** "shop-20260929-1405.jbak": the save dialog's suggestion, safe as a file name. */
export function defaultFileName(
  target: BackupTarget,
  format: BackupFileFormat,
  now = new Date(),
): string {
  const base =
    target.engine === 'redis'
      ? `${target.profileName}-db${target.database ?? '0'}`
      : (target.database ?? target.profileName);
  const safe = base.replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '') || 'backup';
  return `${safe.slice(0, 120)}-${stamp(now)}${EXTENSIONS[format]}`;
}

// ---------------------------------------------------------------------------------------------
// The object catalog

/** One object the user can pick. */
export interface CatalogItem {
  /** Unique within the catalog. */
  readonly key: string;
  readonly ref: BackupObjectRef;
  readonly label: string;
  /** Tables: rows are backed up unless the user leaves them out. */
  readonly hasRows: boolean;
}

/** The objects of one kind in one schema (or database). */
export interface CatalogGroup {
  readonly key: string;
  readonly schema: string | undefined;
  readonly kind: BackupObjectKindName;
  readonly label: string;
  readonly items: readonly CatalogItem[];
}

const KIND_LABELS: Readonly<Record<BackupObjectKindName, string>> = {
  schema: 'Schemas',
  extension: 'Extensions',
  type: 'Types',
  sequence: 'Sequences',
  table: 'Tables',
  partition: 'Partitions',
  index: 'Indexes',
  unique: 'Unique keys',
  check: 'Checks',
  'primary-key': 'Primary keys',
  column: 'Columns',
  'foreign-key': 'Foreign keys',
  trigger: 'Triggers',
  view: 'Views',
  'materialized-view': 'Materialized views',
  routine: 'Routines',
  event: 'Events',
  grants: 'Privileges',
  collection: 'Collections',
  keys: 'Keys',
};

export function kindLabel(kind: BackupObjectKindName): string {
  return KIND_LABELS[kind];
}

function item(
  kind: BackupObjectKindName,
  schema: string | undefined,
  name: string,
  hasRows = false,
): CatalogItem {
  return {
    key: `${kind}:${schema ?? ''}.${name}`,
    ref: { kind, ...(schema !== undefined ? { schema } : {}), name },
    label: name,
    hasRows,
  };
}

function group(
  schema: string | undefined,
  kind: BackupObjectKindName,
  items: readonly CatalogItem[],
): CatalogGroup[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.label.localeCompare(b.label));
  return [
    { key: `${schema ?? ''}:${kind}`, schema, kind, label: KIND_LABELS[kind], items: sorted },
  ];
}

/**
 * The objects of a SQL database the backup wizard offers: tables (partitions come with their
 * table), views, routines (every overload of a name together), sequences not owned by a
 * column, types and events, grouped by schema and kind. Indexes, keys, triggers and grants
 * come with the objects they belong to.
 */
export function sqlCatalog(snapshot: SchemaSnapshot): CatalogGroup[] {
  const postgres = snapshot.engine === 'postgres';
  const groups: CatalogGroup[] = [];
  for (const schemaDef of snapshot.schemas) {
    const schema = postgres ? schemaDef.name : undefined;
    const partitions = new Set(
      schemaDef.tables.flatMap((t) => (t.partitioning?.partitions ?? []).map((p) => p.name)),
    );
    const tables = schemaDef.tables
      .filter((t) => !partitions.has(t.name) && t.kind !== 'foreign')
      .map((t) => item('table', schema, t.name, true));
    const views = schemaDef.views.map((v) =>
      item(v.materialized ? 'materialized-view' : 'view', schema, v.name),
    );
    const routines = [...new Set(schemaDef.routines.map((r) => r.name))].map((name) =>
      item('routine', schema, name),
    );
    const sequences = schemaDef.sequences
      .filter((s) => s.ownedBy === undefined)
      .map((s) => item('sequence', schema, s.name));
    groups.push(
      ...group(schema, 'table', tables),
      ...group(
        schema,
        'view',
        views.filter((v) => v.ref.kind === 'view'),
      ),
      ...group(
        schema,
        'materialized-view',
        views.filter((v) => v.ref.kind === 'materialized-view'),
      ),
      ...group(schema, 'routine', routines),
      ...group(schema, 'sequence', sequences),
      ...group(
        schema,
        'type',
        schemaDef.types.map((t) => item('type', schema, t.name)),
      ),
      ...group(
        schema,
        'event',
        schemaDef.events.map((e) => item('event', schema, e.name)),
      ),
    );
  }
  return groups;
}

/** A MongoDB database's collections, views and time series collections. */
export function mongoCatalog(
  collections: readonly { readonly name: string; readonly kind: string }[],
): CatalogGroup[] {
  return group(
    undefined,
    'collection',
    collections.map((c) => ({
      ...item('collection', undefined, c.name, c.kind !== 'view'),
      label: c.kind === 'view' ? `${c.name} (view)` : c.name,
    })),
  );
}

export function catalogItems(catalog: readonly CatalogGroup[]): CatalogItem[] {
  return catalog.flatMap((g) => g.items);
}

/**
 * The backup selection of the checked objects. Everything checked backs up whole schemas
 * (`scopeSchemas`, or every schema) so objects the catalog does not list come along; a subset
 * names the objects, and the backup adds what they need. Undefined when nothing is checked.
 */
export function sqlSelection(
  catalog: readonly CatalogGroup[],
  checked: ReadonlySet<string>,
  withoutRows: ReadonlySet<string>,
  scopeSchemas: readonly string[] | undefined,
): BackupSelectionInfo | undefined {
  const items = catalogItems(catalog);
  const chosen = items.filter((i) => checked.has(i.key));
  if (chosen.length === 0) return undefined;
  const excludeData = chosen.filter((i) => i.hasRows && withoutRows.has(i.key)).map((i) => i.ref);
  const noData = excludeData.length > 0 ? { excludeData } : {};
  if (chosen.length === items.length) {
    return { ...(scopeSchemas !== undefined ? { schemas: [...scopeSchemas] } : {}), ...noData };
  }
  const schemas = [
    ...new Set(chosen.flatMap((i) => (i.ref.schema !== undefined ? [i.ref.schema] : []))),
  ];
  return {
    ...(schemas.length > 0 ? { schemas } : {}),
    include: chosen.map((i) => i.ref),
    ...noData,
  };
}

/** Why the backup cannot start yet; undefined when it can. */
export function backupProblem(
  target: BackupTarget,
  options: BackupOptions,
  selection: { readonly empty: boolean },
): string | undefined {
  if (selection.empty) return 'Choose at least one object to back up.';
  if (target.engine === 'mongodb' && (target.database ?? '') === '') {
    return 'Open the backup from a database.';
  }
  if (isSqlEngine(target.engine) && !options.structure && !options.data) {
    return 'Back up the structure, the data or both.';
  }
  if (target.engine === 'redis' && options.pattern.trim() === '') {
    return 'Enter a key pattern (* for every key).';
  }
  if (options.encrypt) {
    if (options.passphrase.length < MIN_PASSPHRASE_LENGTH) {
      return `The passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters.`;
    }
    if (options.passphrase !== options.passphraseAgain) return 'The passphrases do not match.';
  }
  if (options.path === undefined) return 'Choose where to save the backup.';
  return undefined;
}

/** The backup job the choices describe. */
export function backupJobSpec(
  target: BackupTarget,
  options: BackupOptions,
  choice: {
    readonly selection?: BackupSelectionInfo | undefined;
    readonly collections?: readonly string[] | undefined;
  },
): BackupJob {
  if (options.path === undefined) throw new Error('No output file');
  const sql = isSqlEngine(target.engine);
  const native = sql && options.method === 'native';
  const archive = options.format === 'jbak' && !native;
  return {
    kind: 'backup',
    profileId: target.profileId,
    ...(target.database !== undefined ? { database: target.database } : {}),
    ...(native ? { method: 'native' as const } : {}),
    format: options.format,
    output: { path: options.path },
    ...(archive ? { compress: options.compress } : {}),
    ...(archive && options.encrypt ? { encryption: { passphrase: options.passphrase } } : {}),
    ...(sql
      ? {
          ...(choice.selection !== undefined ? { selection: choice.selection } : {}),
          structure: options.structure,
          data: options.data,
          grants: options.grants,
          ownership: options.ownership,
          ...(native ? {} : { consistent: options.consistent }),
          ...(target.engine === 'postgres' ? { deferrable: options.deferrable } : {}),
        }
      : {}),
    ...(target.engine === 'mongodb'
      ? {
          ...(choice.collections !== undefined ? { collections: [...choice.collections] } : {}),
          documentFormat: options.documentFormat,
        }
      : {}),
    ...(target.engine === 'redis' ? { pattern: options.pattern.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Restore

/** Kinds shown as their own line in the restore wizard; the rest come with their parent. */
const RESTORE_LISTED: ReadonlySet<BackupObjectKindName> = new Set([
  'schema',
  'extension',
  'type',
  'sequence',
  'table',
  'view',
  'materialized-view',
  'routine',
  'event',
  'collection',
  'keys',
]);

/** An archive's objects the restore wizard lists, grouped by kind, in archive order. */
export function restoreCatalog(objects: readonly BackupObjectInfo[]): {
  readonly kind: BackupObjectKindName;
  readonly label: string;
  readonly objects: readonly BackupObjectInfo[];
}[] {
  const groups = new Map<BackupObjectKindName, BackupObjectInfo[]>();
  for (const object of objects) {
    if (object.parent !== undefined || !RESTORE_LISTED.has(object.kind)) continue;
    const list = groups.get(object.kind) ?? [];
    list.push(object);
    groups.set(object.kind, list);
  }
  const order = [...RESTORE_LISTED];
  return [...groups]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([kind, list]) => ({ kind, label: KIND_LABELS[kind], objects: list }));
}

/** Whether a backup of `from` restores into a `to` connection; a note when it is a stretch. */
export function engineFit(
  to: EngineId,
  from: EngineId | undefined,
): { readonly ok: boolean; readonly note?: string } {
  if (from === undefined) {
    return isSqlEngine(to)
      ? { ok: true, note: 'The file does not say which server it came from.' }
      : { ok: false, note: 'This file is not a backup of this kind of server.' };
  }
  if (from === to) return { ok: true };
  const mysqlFamily = (e: EngineId): boolean => e === 'mysql' || e === 'mariadb';
  if (mysqlFamily(from) && mysqlFamily(to)) {
    return { ok: true, note: `This is a ${from} backup; some statements may differ on ${to}.` };
  }
  return { ok: false, note: `This is a ${from} backup; it does not restore into ${to}.` };
}

export interface RestoreChoices {
  readonly passphrase: string | undefined;
  /** Archive object ids; undefined restores everything. */
  readonly select: readonly string[] | undefined;
  readonly structure: boolean;
  readonly data: boolean;
  /** Restore into a database the restore creates (SQL engines). */
  readonly createDatabase: boolean;
  readonly database: string;
  readonly method: BackupMethod;
  readonly onError: 'stop' | 'continue';
  readonly replace: boolean;
  readonly absoluteTtl: boolean;
}

export function defaultRestoreChoices(
  target: BackupTarget,
  inspection?: BackupInspection,
): RestoreChoices {
  return {
    passphrase: undefined,
    select: undefined,
    structure: true,
    data: true,
    createDatabase: false,
    database: target.database ?? (target.engine === 'redis' ? '0' : (inspection?.database ?? '')),
    method: inspection?.format === 'custom' ? 'native' : 'joinery',
    onError: 'stop',
    replace: false,
    absoluteTtl: false,
  };
}

/** Why the restore cannot be planned yet; undefined when it can. */
export function restoreProblem(
  target: BackupTarget,
  inspection: BackupInspection | undefined,
  choices: RestoreChoices,
): string | undefined {
  if (target.readOnly) return `"${target.profileName}" is read-only, so nothing can be restored.`;
  if (!inspection) return 'Choose a backup file.';
  if (inspection.format === 'jbak' && !inspection.objects) return 'Enter the passphrase.';
  const fit = engineFit(target.engine, inspection.engine);
  if (!fit.ok) return fit.note;
  if (choices.select !== undefined && choices.select.length === 0) {
    return 'Choose at least one object to restore.';
  }
  const database = choices.database.trim();
  if (target.engine === 'redis' && !/^\d{1,5}$/.test(database) && database !== '') {
    return 'Enter a database number.';
  }
  if ((target.engine === 'mongodb' || choices.createDatabase) && database === '') {
    return 'Enter the database to restore into.';
  }
  if (inspection.format === 'custom' && choices.method !== 'native') {
    return 'A pg_dump custom archive restores with pg_restore only.';
  }
  return undefined;
}

/** The restore job the choices describe. */
export function restoreJobSpec(
  target: BackupTarget,
  path: string,
  inspection: BackupInspection,
  choices: RestoreChoices,
  confirmation: {
    readonly conflicts?: readonly RestoreConflictInfo[];
    readonly confirmed?: boolean;
  } = {},
): RestoreJob {
  const archive = inspection.format === 'jbak';
  const database = choices.database.trim();
  const sql = isSqlEngine(target.engine);
  return {
    kind: 'restore',
    profileId: target.profileId,
    ...(database !== '' ? { database } : {}),
    ...(!archive && choices.method === 'native' ? { method: 'native' as const } : {}),
    path,
    ...(archive && choices.passphrase !== undefined ? { passphrase: choices.passphrase } : {}),
    ...(archive && choices.select !== undefined ? { select: [...choices.select] } : {}),
    ...(archive && sql ? { structure: choices.structure, data: choices.data } : {}),
    onError: choices.onError,
    ...(target.engine === 'redis'
      ? { replace: choices.replace, absoluteTtl: choices.absoluteTtl }
      : {}),
    ...(sql && choices.createDatabase ? { createDatabase: true } : {}),
    ...(confirmation.conflicts !== undefined && confirmation.conflicts.length > 0
      ? { confirmedConflicts: confirmation.conflicts.map((c) => c.id) }
      : {}),
    ...(confirmation.confirmed === true ? { confirmed: true } : {}),
  };
}

const CONFLICT_ACTIONS: Readonly<Record<RestoreConflictInfo['action'], string>> = {
  drop: 'dropped and created again',
  append: 'kept; the backup adds its rows',
  overwrite: 'overwritten',
};

/** "orders (table): dropped and created again". */
export function conflictLabel(conflict: RestoreConflictInfo): string {
  if (conflict.id === 'database') {
    return `Not empty (${conflict.qualifiedName}): the script runs over them and may replace them`;
  }
  return `${conflict.qualifiedName} (${conflict.kind}): ${CONFLICT_ACTIONS[conflict.action]}`;
}
