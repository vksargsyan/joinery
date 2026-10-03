import { join } from 'node:path';

import type { Session } from '@querybara/core';
import { fileSink } from '@querybara/transfer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ArchiveReader,
  backupSql,
  planSqlRestore,
  restoreSqlArchive,
  restoreSqlScript,
  type BackupFormat,
  type BackupObjectKind,
} from '../../src';
import { PG_FIXTURE, expectSameDatabase } from './fixtures';
import { ScratchDatabases, query, rowsText, run, sqlServer, tempDir } from './helpers';

/**
 * PostgreSQL round trips (spec §14): a schema with tricky objects (extension types, enums,
 * composites, domains, serial and identity columns, a partitioned table, a self-referencing
 * foreign key, views, a materialised view, a trigger that would change rows if it fired during
 * the load) and tricky values is backed up in each format, restored into fresh databases, and
 * compared with the structure and data compare of @querybara/sync: zero differences.
 */

const server = sqlServer('postgres');
const FAST = { log2N: 10, r: 8, p: 1 };

describe.skipIf(!server)('PostgreSQL backup and restore', () => {
  const dbs = new ScratchDatabases(server!);
  const dir = tempDir('pg');
  let source: Session;

  beforeAll(async () => {
    source = await dbs.connect(await dbs.create('source'));
    await run(source, PG_FIXTURE.setup);
    await run(source, PG_FIXTURE.data);
  });

  afterAll(async () => {
    await dbs.dropAll();
    dir.remove();
  });

  async function backup(format: BackupFormat, file: string, extra: object = {}): Promise<string> {
    const path = join(dir.path, file);
    const summary = await backupSql({
      session: source,
      output: fileSink(path),
      format,
      selection: { schemas: ['bk'] },
      ...extra,
    });
    expect(summary.error).toBeUndefined();
    expect(summary.status).toBe('completed');
    expect(summary.rows).toBeGreaterThan(3700);
    return path;
  }

  it('round-trips an encrypted archive into a fresh database', async () => {
    const path = await backup('qbak', 'full.qbak', {
      encryption: { passphrase: 'correct horse battery staple', cost: FAST },
    });
    const archive = await ArchiveReader.open(path, { passphrase: 'correct horse battery staple' });
    expect(archive.encrypted).toBe(true);
    expect(archive.manifest.options['snapshot']).toBe('repeatable-read');
    const kinds = new Set(archive.manifest.objects.map((o) => o.kind));
    const expected: BackupObjectKind[] = [
      'schema',
      'extension',
      'type',
      'sequence',
      'table',
      'foreign-key',
      'view',
      'materialized-view',
      'routine',
      'trigger',
    ];
    for (const kind of expected) expect(kinds.has(kind)).toBe(true);
    await archive.verify();
    const target = await dbs.connect(await dbs.create('restored'));
    const summary = await restoreSqlArchive({ session: target, archive });
    await archive.close();
    expect(summary.errors).toEqual([]);
    expect(summary.status).toBe('completed');
    await expectSameDatabase(source, target, PG_FIXTURE);
  });

  for (const [format, file] of [
    ['sql', 'plain.sql'],
    ['sql-gz', 'plain.sql.gz'],
  ] as const) {
    it(`round-trips a ${format} script`, async () => {
      const path = await backup(format, file);
      const target = await dbs.connect(await dbs.create(format));
      const summary = await restoreSqlScript({ session: target, path });
      expect(summary.errors).toEqual([]);
      expect(summary.status).toBe('completed');
      await expectSameDatabase(source, target, PG_FIXTURE);
    });
  }

  it('restores selected tables with what they need, and nothing else', async () => {
    const path = await backup('qbak', 'selective.qbak');
    const archive = await ArchiveReader.open(path);
    const target = await dbs.connect(await dbs.create('selected'));
    const select = ['table:bk.orders:create'];
    const plan = await planSqlRestore({ session: target, archive, select });
    const ids = plan.objects.map((o) => o.id);
    expect(ids).toContain('type:bk.pair:create');
    expect(ids).toContain('type:bk.positive:create');
    expect(ids).toContain('trigger:bk.orders.orders_touch:create');
    expect(ids).toContain('routine:bk.touch():create');
    expect(ids).not.toContain('table:bk.customers:create');
    expect(plan.skipped.map((s) => s.id)).toContain(
      'foreign-key:bk.orders.orders_customer_id_fkey:create',
    );
    expect(plan.conflicts).toEqual([]);
    const summary = await restoreSqlArchive({ session: target, archive, select });
    expect(summary.status).toBe('completed');
    const sql = 'SELECT id, customer_id, total, qty, pair::text, gross FROM bk.orders ORDER BY id';
    expect(await rowsText(target, sql)).toEqual(await rowsText(source, sql));
    expect(await query(target, `SELECT to_regclass('bk.customers')::text`)).toEqual([[null]]);
    await archive.close();
  });

  it('asks before dropping existing objects, then replaces them', async () => {
    const path = await backup('qbak', 'replace.qbak');
    const target = await dbs.connect(await dbs.create('replace'));
    const archive = await ArchiveReader.open(path);
    expect((await restoreSqlArchive({ session: target, archive })).status).toBe('completed');
    await run(target, [
      'UPDATE bk.self_ref SET parent = NULL WHERE id = 1',
      'DELETE FROM bk.self_ref WHERE id = 3',
      "UPDATE bk.kinds SET c = 'zz'",
    ]);

    const plan = await planSqlRestore({ session: target, archive });
    const dropped = plan.conflicts.map((c) => c.qualifiedName);
    expect(dropped).toContain('bk.orders');
    expect(dropped).toContain('bk.mood');
    expect(plan.conflicts.every((c) => c.action === 'drop')).toBe(true);
    // Schemas and extensions that exist are kept, not dropped.
    expect(plan.existing).toContain('schema:bk:create');

    const refused = await restoreSqlArchive({ session: target, archive });
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(await rowsText(target, 'SELECT count(*) FROM bk.self_ref')).toEqual(['[2]']);

    const replaced = await restoreSqlArchive({
      session: target,
      archive,
      confirmedConflicts: plan.conflicts.map((c) => c.id),
    });
    expect(replaced.errors).toEqual([]);
    expect(replaced.status).toBe('completed');
    await archive.close();
    await expectSameDatabase(source, target, PG_FIXTURE);
  });

  it('stops and rolls back, or logs and continues, when statements fail', async () => {
    const path = await backup('sql', 'errors.sql');
    const target = await dbs.connect(await dbs.create('errors'));
    await run(target, ['CREATE SCHEMA bk', 'CREATE TABLE bk.self_ref (id text)']);

    await expect(restoreSqlScript({ session: target, path })).rejects.toThrow(/needs confirmation/);

    const confirmedConflicts = ['database'];
    const stopped = await restoreSqlScript({ session: target, path, confirmedConflicts });
    expect(stopped.status).toBe('failed');
    expect(stopped.errors[0]?.message).toMatch(/already exists/);
    // One transaction: nothing of the backup is left behind.
    expect(await query(target, `SELECT to_regclass('bk.customers')::text`)).toEqual([[null]]);

    const continued = await restoreSqlScript({
      session: target,
      path,
      confirmedConflicts,
      onError: 'continue',
    });
    expect(continued.status).toBe('completed');
    expect(continued.failed).toBeGreaterThan(0);
    expect(continued.errors.some((e) => /already exists/.test(e.message))).toBe(true);
    const sql = 'SELECT id, name, email, mood, tags, created, code FROM bk.customers ORDER BY id';
    expect(await rowsText(target, sql)).toEqual(await rowsText(source, sql));
  });
});
