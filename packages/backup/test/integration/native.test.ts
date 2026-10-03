import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '@querybara/core';
import { fileSink } from '@querybara/transfer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  chooseTool,
  detectNativeTools,
  inspectBackup,
  nativeBackup,
  nativeRestore,
  type NativeFormat,
  type NativeTool,
} from '../../src';
import { PG_FIXTURE, expectSameDatabase, mysqlFixture, type SqlFixture } from './fixtures';
import { ScratchDatabases, run, sqlServer, tempDir, type SqlServerEngine } from './helpers';

/**
 * The native tools (spec §14): pg_dump / pg_restore / psql and mysqldump / mysql, when this
 * machine has a version that can read the server. Each case backs up the tricky fixture with the
 * tool, restores it with the matching client into a fresh database, and compares with
 * @querybara/sync. Cases whose tool is missing are skipped.
 */

const tools: NativeTool[] = await detectNativeTools();

interface Case {
  readonly engine: SqlServerEngine;
  readonly format: NativeFormat;
  readonly file: string;
}

const CASES: readonly Case[] = [
  { engine: 'postgres', format: 'custom', file: 'pg.dump' },
  { engine: 'postgres', format: 'sql-gz', file: 'pg.sql.gz' },
  { engine: 'mariadb', format: 'sql', file: 'maria.sql' },
  { engine: 'mysql', format: 'sql-gz', file: 'mysql.sql.gz' },
];

/**
 * mysqldump prints FLOAT columns with six significant digits, so a native MySQL backup loses
 * the rest (1.2345678 comes back as 1.23457); the Querybara format keeps them. The native cases
 * compare every other value.
 */
function nativeFixture(engine: SqlServerEngine): SqlFixture {
  if (engine === 'postgres') return PG_FIXTURE;
  const fixture = mysqlFixture(engine === 'mariadb');
  return { ...fixture, checks: fixture.checks.map((sql) => sql.replace('f + 0e0, ', '')) };
}

for (const engine of ['postgres', 'mysql', 'mariadb'] as const) {
  const server = sqlServer(engine);
  const fixture = nativeFixture(engine);
  describe.skipIf(!server)(`native tools with ${engine}`, () => {
    const dbs = new ScratchDatabases(server!);
    const dir = tempDir(`native-${engine}`);
    let source: Session;
    let sourceName = '';

    beforeAll(async () => {
      sourceName = await dbs.create('native_source');
      source = await dbs.connect(sourceName);
      await run(source, fixture.setup);
      await run(source, fixture.data);
    });

    afterAll(async () => {
      await dbs.dropAll();
      dir.remove();
    });

    for (const c of CASES.filter((x) => x.engine === engine)) {
      it(`backs up with the native dump tool and restores (${c.format})`, async (ctx) => {
        const dump = chooseTool(tools, 'dump', source.engine, source.serverVersion);
        const restoreTask = c.format === 'custom' ? 'restore-archive' : 'restore-script';
        const restore = chooseTool(tools, restoreTask, source.engine, source.serverVersion);
        // A client of the other family may not speak the server's authentication.
        if (!dump.tool || !restore.tool || dump.warnings.length > 0) {
          ctx.skip();
          return;
        }
        const path = join(dir.path, c.file);
        const backup = await nativeBackup({
          resolved: server!.profile(sourceName),
          engine: source.engine,
          serverVersion: source.serverVersion,
          database: sourceName,
          tools,
          output: fileSink(path),
          format: c.format,
          ...(fixture.schema ? { schemas: [fixture.schema] } : {}),
        });
        expect(backup.error).toBeUndefined();
        expect(backup.status).toBe('completed');
        expect(statSync(path).size).toBe(backup.bytesWritten);
        expect((await inspectBackup(path)).format).toBe(c.format);

        const targetName = await dbs.create(`native_${c.format}`);
        const target = await dbs.connect(targetName);
        const restored = await nativeRestore({
          session: target,
          resolved: server!.profile(targetName),
          engine: target.engine,
          serverVersion: target.serverVersion,
          database: targetName,
          tools,
          path,
        });
        expect(restored.errors).toEqual([]);
        expect(restored.error).toBeUndefined();
        expect(restored.status).toBe('completed');
        await expectSameDatabase(source, target, fixture);

        // A database that holds objects now: running the script over it needs confirmation.
        const again = await nativeRestore({
          session: target,
          resolved: server!.profile(targetName),
          engine: target.engine,
          serverVersion: target.serverVersion,
          database: targetName,
          tools,
          path,
        });
        expect(again.error?.code).toBe('CONFIRMATION_REQUIRED');
      });
    }
  });
}
