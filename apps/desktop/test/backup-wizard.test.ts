import {
  BACKUP_FORMATS,
  BACKUP_OBJECT_KINDS,
  NATIVE_TOOL_NAMES as TOOL_NAMES,
} from '@joinery/backup';
import { schemaSnapshotSchema } from '@joinery/core';
import {
  BACKUP_FILE_FORMATS,
  BACKUP_OBJECT_KIND_NAMES,
  NATIVE_TOOL_NAMES,
  backupJobSchema,
  restoreJobSchema,
  type BackupInspection,
  type NativeToolInfo,
} from '@joinery/ipc';
import { describe, expect, it } from 'vitest';

import {
  backupJobSpec,
  backupProblem,
  catalogItems,
  changeOptions,
  conflictLabel,
  defaultBackupOptions,
  defaultFileName,
  defaultRestoreChoices,
  engineFit,
  formatsFor,
  mongoCatalog,
  nativeDumpTool,
  nativeRestoreTool,
  restoreCatalog,
  restoreJobSpec,
  restoreProblem,
  sqlCatalog,
  sqlSelection,
  type BackupTarget,
} from '../src/renderer/src/state/backup/options';

/**
 * The backup and restore wizards' rules (spec §14): formats per engine and method, the object
 * catalog and the selection it becomes, what blocks a start, and the job specs, which must
 * pass the IPC schemas. The IPC lists that mirror @joinery/backup are checked here too.
 */

const PG: BackupTarget = {
  profileId: '4b0c0a52-5d1a-4c47-9d8e-0c2f4a0f7e11',
  profileName: 'Shop',
  engine: 'postgres',
  database: 'shop',
  schema: undefined,
  pattern: undefined,
  node: undefined,
  readOnly: false,
  production: false,
  confirmWrites: false,
};

const SNAPSHOT = schemaSnapshotSchema.parse({
  engine: 'postgres',
  database: 'shop',
  capturedAt: '2026-09-29T12:00:00.000Z',
  schemas: [
    {
      name: 'public',
      tables: [
        { name: 'orders', columns: [] },
        {
          name: 'events',
          kind: 'partitioned',
          columns: [],
          partitioning: { method: 'RANGE', key: '(at)', partitions: [{ name: 'events_2026' }] },
        },
        { name: 'events_2026', columns: [] },
        { name: 'remote', kind: 'foreign', columns: [] },
      ],
      views: [
        { name: 'recent', definition: 'SELECT 1' },
        { name: 'totals', materialized: true, definition: 'SELECT 1' },
      ],
      routines: [
        { name: 'touch', kind: 'function', signature: '', definition: 'CREATE FUNCTION touch()' },
        {
          name: 'touch',
          kind: 'function',
          signature: 'integer',
          definition: 'CREATE FUNCTION touch(integer)',
        },
      ],
      sequences: [
        { name: 'orders_id_seq', start: '1', increment: '1', ownedBy: 'orders.id' },
        { name: 'tickets', start: '1', increment: '1' },
      ],
      types: [{ name: 'mood', kind: 'enum', values: ['ok'], definition: 'CREATE TYPE mood' }],
    },
    { name: 'audit', tables: [{ name: 'log', columns: [] }] },
  ],
});

const TOOLS: NativeToolInfo[] = [
  {
    name: 'pg_dump',
    path: '/usr/bin/pg_dump',
    family: 'postgres',
    version: '16.4',
    major: 16,
    minor: 4,
  },
  { name: 'psql', path: '/usr/bin/psql', family: 'postgres', version: '16.4', major: 16, minor: 4 },
  {
    name: 'mariadb-dump',
    path: '/usr/bin/mariadb-dump',
    family: 'mariadb',
    version: '11.4.2',
    major: 11,
    minor: 4,
  },
];

describe('the IPC lists mirror @joinery/backup', () => {
  it('has the same object kinds, formats and tools', () => {
    expect([...BACKUP_OBJECT_KIND_NAMES]).toEqual([...BACKUP_OBJECT_KINDS]);
    expect([...BACKUP_FILE_FORMATS]).toEqual([...BACKUP_FORMATS, 'custom']);
    expect([...NATIVE_TOOL_NAMES]).toEqual([...TOOL_NAMES]);
  });
});

describe('backup options', () => {
  it('offers the formats of each engine and method', () => {
    expect(formatsFor('postgres', 'joinery')).toEqual(['jbak', 'sql', 'sql-gz']);
    expect(formatsFor('postgres', 'native')).toEqual(['custom', 'sql', 'sql-gz']);
    expect(formatsFor('mysql', 'native')).toEqual(['sql', 'sql-gz']);
    expect(formatsFor('mongodb', 'joinery')).toEqual(['jbak']);
    expect(formatsFor('redis', 'native')).toEqual(['jbak']);
  });

  it('keeps options consistent when they change', () => {
    const start = { ...defaultBackupOptions(PG), encrypt: true, path: '/b/shop.jbak' };
    const native = changeOptions('postgres', start, { method: 'native' });
    expect(native).toMatchObject({ format: 'custom', encrypt: false, path: undefined });
    const script = changeOptions('postgres', { ...start, path: '/b/shop.sql' }, { format: 'sql' });
    expect(script).toMatchObject({ format: 'sql', encrypt: false, path: '/b/shop.sql' });
  });

  it('finds the native tools for an engine', () => {
    expect(nativeDumpTool('postgres', TOOLS)?.name).toBe('pg_dump');
    expect(nativeDumpTool('mysql', TOOLS)?.name).toBe('mariadb-dump');
    expect(nativeDumpTool('mongodb', TOOLS)).toBeUndefined();
    expect(nativeRestoreTool('postgres', 'sql', TOOLS)?.name).toBe('psql');
    expect(nativeRestoreTool('postgres', 'custom', TOOLS)).toBeUndefined();
    expect(nativeRestoreTool('mariadb', 'sql-gz', TOOLS)).toBeUndefined();
    expect(nativeRestoreTool('postgres', 'jbak', TOOLS)).toBeUndefined();
  });

  it('suggests a safe file name', () => {
    const now = new Date(2026, 8, 29, 14, 5);
    expect(defaultFileName(PG, 'jbak', now)).toBe('shop-20260929-1405.jbak');
    expect(defaultFileName({ ...PG, database: '../etc passwd' }, 'sql-gz', now)).toBe(
      'etc_passwd-20260929-1405.sql.gz',
    );
    expect(defaultFileName({ ...PG, engine: 'redis', database: '3' }, 'jbak', now)).toBe(
      'Shop-db3-20260929-1405.jbak',
    );
  });

  it('says what blocks the start', () => {
    const options = { ...defaultBackupOptions(PG), path: '/b/shop.jbak' };
    expect(backupProblem(PG, options, { empty: false })).toBeUndefined();
    expect(backupProblem(PG, options, { empty: true })).toMatch(/at least one object/);
    expect(
      backupProblem(PG, { ...options, structure: false, data: false }, { empty: false }),
    ).toMatch(/structure, the data or both/);
    const encrypted = { ...options, encrypt: true, passphrase: 'short', passphraseAgain: 'short' };
    expect(backupProblem(PG, encrypted, { empty: false })).toMatch(/at least 8/);
    expect(
      backupProblem(
        PG,
        { ...encrypted, passphrase: 'long enough', passphraseAgain: 'long enougj' },
        { empty: false },
      ),
    ).toMatch(/do not match/);
    expect(backupProblem(PG, { ...options, path: undefined }, { empty: false })).toMatch(/save/);
    expect(
      backupProblem({ ...PG, engine: 'mongodb', database: undefined }, options, { empty: false }),
    ).toMatch(/database/);
  });
});

describe('the object catalog', () => {
  it('lists what the user picks, grouped by schema and kind', () => {
    const groups = sqlCatalog(SNAPSHOT);
    const labels = groups.map(
      (g) => `${g.schema}:${g.kind}:${g.items.map((i) => i.label).join(',')}`,
    );
    expect(labels).toEqual([
      'public:table:events,orders',
      'public:view:recent',
      'public:materialized-view:totals',
      'public:routine:touch',
      'public:sequence:tickets',
      'public:type:mood',
      'audit:table:log',
    ]);
  });

  it('backs up whole schemas when everything is checked, named objects otherwise', () => {
    const groups = sqlCatalog(SNAPSHOT);
    const all = new Set(catalogItems(groups).map((i) => i.key));
    expect(sqlSelection(groups, all, new Set(), undefined)).toEqual({});
    expect(sqlSelection(groups, all, new Set(), ['public'])).toEqual({ schemas: ['public'] });
    const orders = 'table:public.orders';
    const selection = sqlSelection(
      groups,
      new Set([orders, 'view:public.recent']),
      new Set([orders]),
      undefined,
    );
    expect(selection).toEqual({
      schemas: ['public'],
      include: [
        { kind: 'table', schema: 'public', name: 'orders' },
        { kind: 'view', schema: 'public', name: 'recent' },
      ],
      excludeData: [{ kind: 'table', schema: 'public', name: 'orders' }],
    });
    expect(sqlSelection(groups, new Set(), new Set(), undefined)).toBeUndefined();
  });

  it('lists MongoDB collections with views marked', () => {
    const [group] = mongoCatalog([
      { name: 'people', kind: 'collection' },
      { name: 'adults', kind: 'view' },
    ]);
    expect(group?.items.map((i) => [i.label, i.hasRows])).toEqual([
      ['adults (view)', false],
      ['people', true],
    ]);
  });
});

describe('backup jobs', () => {
  it('encrypts only archives, and the spec passes the IPC schema', () => {
    const options = {
      ...defaultBackupOptions(PG),
      encrypt: true,
      passphrase: 'correct horse',
      passphraseAgain: 'correct horse',
      path: '/b/shop.jbak',
    };
    const job = backupJobSpec(PG, options, { selection: { schemas: ['public'] } });
    expect(backupJobSchema.parse(job)).toEqual(job);
    expect(job).toMatchObject({
      kind: 'backup',
      database: 'shop',
      format: 'jbak',
      compress: true,
      encryption: { passphrase: 'correct horse' },
      selection: { schemas: ['public'] },
      consistent: true,
      deferrable: false,
    });
    const native = backupJobSpec(
      PG,
      changeOptions('postgres', options, { method: 'native', path: '/b/shop.dump' }),
      {},
    );
    expect(native).toMatchObject({ method: 'native', format: 'custom' });
    expect(native).not.toHaveProperty('encryption');
    expect(native).not.toHaveProperty('consistent');
  });

  it('writes the MongoDB and Redis options', () => {
    const mongo = { ...PG, engine: 'mongodb' as const };
    const job = backupJobSpec(
      mongo,
      { ...defaultBackupOptions(mongo), documentFormat: 'ejson', path: '/b/app.jbak' },
      { collections: ['people'] },
    );
    expect(job).toMatchObject({ collections: ['people'], documentFormat: 'ejson' });
    expect(job).not.toHaveProperty('structure');
    const redis = { ...PG, engine: 'redis' as const, database: '2', pattern: 'user:*' };
    expect(
      backupJobSpec(redis, { ...defaultBackupOptions(redis), path: '/b/r.jbak' }, {}),
    ).toMatchObject({ database: '2', pattern: 'user:*' });
  });
});

const ARCHIVE: BackupInspection = {
  format: 'jbak',
  size: 2048,
  encrypted: true,
  engine: 'postgres',
  serverVersion: '16.4',
  database: 'shop',
  objects: [
    { id: 'schema:public', kind: 'schema', name: 'public', qualifiedName: 'public', dependsOn: [] },
    {
      id: 'table:public.orders',
      kind: 'table',
      schema: 'public',
      name: 'orders',
      qualifiedName: 'public.orders',
      dependsOn: ['schema:public'],
      rows: 3,
    },
    {
      id: 'index:public.orders_at',
      kind: 'index',
      schema: 'public',
      name: 'orders_at',
      qualifiedName: 'public.orders_at',
      parent: 'table:public.orders',
      dependsOn: [],
    },
  ],
};

describe('restores', () => {
  it('lists top-level objects by kind', () => {
    expect(
      restoreCatalog(ARCHIVE.objects!).map((g) => [g.kind, g.objects.map((o) => o.id)]),
    ).toEqual([
      ['schema', ['schema:public']],
      ['table', ['table:public.orders']],
    ]);
  });

  it('checks the backup fits the connection', () => {
    expect(engineFit('postgres', 'postgres')).toEqual({ ok: true });
    expect(engineFit('mariadb', 'mysql').ok).toBe(true);
    expect(engineFit('postgres', 'mysql').ok).toBe(false);
    expect(engineFit('redis', undefined).ok).toBe(false);
  });

  it('says what blocks the review', () => {
    const choices = defaultRestoreChoices(PG, ARCHIVE);
    expect(restoreProblem(PG, ARCHIVE, choices)).toBeUndefined();
    expect(restoreProblem({ ...PG, readOnly: true }, ARCHIVE, choices)).toMatch(/read-only/);
    const { objects: _hidden, ...locked } = ARCHIVE;
    expect(restoreProblem(PG, locked, choices)).toMatch(/passphrase/);
    expect(restoreProblem(PG, ARCHIVE, { ...choices, select: [] })).toMatch(/at least one/);
    expect(
      restoreProblem(PG, ARCHIVE, { ...choices, createDatabase: true, database: ' ' }),
    ).toMatch(/database/);
    expect(restoreProblem({ ...PG, engine: 'mysql' }, ARCHIVE, choices)).toMatch(/postgres backup/);
    const custom: BackupInspection = { format: 'custom', size: 10, encrypted: false };
    expect(restoreProblem(PG, custom, { ...choices, method: 'joinery' })).toMatch(/pg_restore/);
  });

  it('carries the confirmed conflicts and the production confirmation', () => {
    const choices = {
      ...defaultRestoreChoices(PG, ARCHIVE),
      passphrase: 'correct horse',
      select: ['table:public.orders'],
      createDatabase: true,
      database: 'shop_copy',
    };
    const job = restoreJobSpec(PG, '/b/shop.jbak', ARCHIVE, choices, {
      conflicts: [
        {
          id: 'table:public.orders',
          kind: 'table',
          qualifiedName: 'public.orders',
          action: 'drop',
        },
      ],
      confirmed: true,
    });
    expect(restoreJobSchema.parse(job)).toEqual(job);
    expect(job).toEqual({
      kind: 'restore',
      profileId: PG.profileId,
      database: 'shop_copy',
      path: '/b/shop.jbak',
      passphrase: 'correct horse',
      select: ['table:public.orders'],
      structure: true,
      data: true,
      onError: 'stop',
      createDatabase: true,
      confirmedConflicts: ['table:public.orders'],
      confirmed: true,
    });
    const script: BackupInspection = { format: 'sql', size: 10, encrypted: false };
    expect(
      restoreJobSpec(PG, '/b/shop.sql', script, {
        ...defaultRestoreChoices(PG, script),
        method: 'native',
        database: '',
      }),
    ).toEqual({
      kind: 'restore',
      profileId: PG.profileId,
      method: 'native',
      path: '/b/shop.sql',
      onError: 'stop',
    });
  });

  it('words conflicts', () => {
    expect(
      conflictLabel({ id: 't', kind: 'table', qualifiedName: 'public.orders', action: 'drop' }),
    ).toBe('public.orders (table): dropped and created again');
    expect(
      conflictLabel({
        id: 'database',
        kind: 'database',
        qualifiedName: 'the 3 objects already in the database',
        action: 'overwrite',
      }),
    ).toMatch(/^Not empty/);
  });
});
