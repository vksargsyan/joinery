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
} from '../../src';
import { expectSameDatabase, mysqlFixture } from './fixtures';
import {
  ScratchDatabases,
  query,
  rowsText,
  run,
  sqlServer,
  tempDir,
  type SqlServerEngine,
} from './helpers';

/**
 * MySQL and MariaDB round trips (spec §14): tables with every tricky type (FLOAT that the text
 * protocol would round, BIT, unsigned BIGINT, spatial, JSON, binary with NUL bytes, zero
 * AUTO_INCREMENT keys), generated columns, foreign keys in a cycle, views, routines with their
 * own sql_mode, a trigger that would change rows if it fired during the load, an event, and on
 * MariaDB a sequence. Backed up in each format, restored into a database with another name,
 * compared with @querybara/sync: zero differences.
 */

const FAST = { log2N: 10, r: 8, p: 1 };

for (const engine of ['mysql', 'mariadb'] as const satisfies readonly SqlServerEngine[]) {
  const server = sqlServer(engine);
  describe.skipIf(!server)(`${engine} backup and restore`, () => {
    const fixture = mysqlFixture(engine === 'mariadb');
    const dbs = new ScratchDatabases(server!);
    const dir = tempDir(engine);
    let source: Session;

    beforeAll(async () => {
      source = await dbs.connect(await dbs.create('source'));
      await run(source, fixture.setup);
      await run(source, fixture.data);
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
        ...extra,
      });
      expect(summary.error).toBeUndefined();
      expect(summary.status).toBe('completed');
      expect(summary.warnings.some((w) => /logs \(MyISAM\)/.test(w))).toBe(true);
      return path;
    }

    it('round-trips an encrypted archive into a database with another name', async () => {
      const path = await backup('qbak', 'full.qbak', {
        encryption: { passphrase: 'pässwörd', cost: FAST },
      });
      const archive = await ArchiveReader.open(path, { passphrase: 'pässwörd' });
      expect(archive.manifest.options['snapshot']).toBe('consistent-snapshot');
      const target = await dbs.connect(await dbs.create('restored'));
      const summary = await restoreSqlArchive({ session: target, archive });
      await archive.close();
      expect(summary.errors).toEqual([]);
      expect(summary.status).toBe('completed');
      await expectSameDatabase(source, target, fixture);
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
        await expectSameDatabase(source, target, fixture);
      });
    }

    it('restores selected tables and replaces existing ones after confirmation', async () => {
      const path = await backup('qbak', 'selective.qbak');
      const archive = await ArchiveReader.open(path);
      const target = await dbs.connect(await dbs.create('selected'));
      const select = ['table:kinds:create', 'table:orders:create'];
      const plan = await planSqlRestore({ session: target, archive, select });
      expect(plan.objects.map((o) => o.id)).toContain('trigger:orders.orders_touch:create');
      expect(plan.skipped.map((s) => s.id)).toContain('foreign-key:orders.fk_customer:create');
      const first = await restoreSqlArchive({ session: target, archive, select });
      expect(first.status).toBe('completed');
      expect(await query(target, `SHOW TABLES`)).toEqual([['kinds'], ['orders']]);
      const sql = 'SELECT id, customer_id, total, gross, note FROM orders ORDER BY id';
      expect(await rowsText(target, sql)).toEqual(await rowsText(source, sql));

      await run(target, ['DELETE FROM orders WHERE id < 10']);
      const again = await planSqlRestore({ session: target, archive, select });
      // The trigger goes with its table, so it is not asked about separately.
      expect(again.conflicts.map((c) => c.qualifiedName).sort()).toEqual(['kinds', 'orders']);
      const refused = await restoreSqlArchive({ session: target, archive, select });
      expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
      const replaced = await restoreSqlArchive({
        session: target,
        archive,
        select,
        confirmedConflicts: again.conflicts.map((c) => c.id),
      });
      expect(replaced.errors).toEqual([]);
      expect(await rowsText(target, sql)).toEqual(await rowsText(source, sql));
      await archive.close();
    });
  });
}
