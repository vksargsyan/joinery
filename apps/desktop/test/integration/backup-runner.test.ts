import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newId,
  rowAt,
  type CellValue,
  type ResolvedProfile,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import type { BackupInspection, JobSpec, RestorePlan } from '@joinery/ipc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { JobRunner } from '../../src/job-runner/runner';
import type { RunnerToMain } from '../../src/shared/job-protocol';

/**
 * Backup and restore jobs in the job runner against the real servers (spec §14): an encrypted
 * archive of a database, read back with its passphrase, one table restored into a database the
 * job creates, then restored again over itself, which the runner refuses until the plan's
 * conflicts are confirmed.
 */

const ENGINES = [
  ['postgres', process.env['JOINERY_TEST_POSTGRES_URL']],
  ['mysql', process.env['JOINERY_TEST_MYSQL_URL']],
  ['mariadb', process.env['JOINERY_TEST_MARIADB_URL']],
] as const;

const PASSPHRASE = 'runner integration passphrase';

let work = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'joinery-backup-it-'));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

async function rows(session: Session, sql: string): Promise<CellValue[][]> {
  const out: CellValue[][] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) out.push(rowAt(chunk, r));
    }
  }
  return out;
}

describe.each(ENGINES)('%s', (dialect: SqlDialect, url: string | undefined) => {
  const source = `joinery_bk_${randomBytes(4).toString('hex')}`;
  const copy = `joinery_bk_${randomBytes(4).toString('hex')}`;
  const posted: RunnerToMain[] = [];
  let admin: Session | undefined;
  const profile = (database?: string): ResolvedProfile =>
    resolvedProfileFromUrl(
      url!,
      database === undefined ? {} : { options: { defaultDatabase: database } },
    );
  const runner = new JobRunner({
    post: (message) => posted.push(message),
    connect: async (resolved) => {
      const session = await (await loadAdapter(resolved.profile.engine)).connect(resolved);
      return { session, resolved, close: () => session.close() };
    },
  });

  async function request<T>(request: Parameters<JobRunner['handle']>[0]): Promise<T> {
    const requestId = newId();
    runner.handle({ type: 'request', requestId, request });
    for (;;) {
      const response = posted.find((m) => m.type === 'response' && m.requestId === requestId);
      if (response?.type === 'response') {
        if (response.error) throw new Error(response.error.message);
        return response.result as T;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function job(spec: JobSpec): Promise<Extract<RunnerToMain, { type: 'done' }>> {
    const jobId = newId();
    runner.handle({ type: 'start', jobId, job: spec, resolved: profile() });
    for (;;) {
      const done = posted.find((m) => m.type === 'done' && m.jobId === jobId);
      if (done?.type === 'done') return done;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    if (!url) return;
    admin = await (await loadAdapter(dialect)).connect(profile());
    await rows(admin, `CREATE DATABASE ${source}`);
    const session = await (await loadAdapter(dialect)).connect(profile(source));
    try {
      for (const sql of [
        'CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)',
        'CREATE TABLE notes (id INT PRIMARY KEY, body TEXT)',
        "INSERT INTO customers VALUES (1, 'Ada'), (2, 'Grace'), (3, 'Zoë')",
        "INSERT INTO notes VALUES (1, 'left out')",
      ]) {
        await rows(session, sql);
      }
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (!admin) return;
    for (const name of [source, copy]) {
      await rows(
        admin,
        dialect === 'postgres'
          ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`
          : `DROP DATABASE IF EXISTS ${name}`,
      ).catch(() => undefined);
    }
    await admin.close();
  });

  it.skipIf(!url)(
    'backs up to an encrypted archive and restores one table into a new database',
    async () => {
      const path = join(work, `${source}.jbak`);
      const backup = await job({
        kind: 'backup',
        profileId: newId(),
        database: source,
        format: 'jbak',
        output: { path },
        encryption: { passphrase: PASSPHRASE },
      });
      expect(backup.error).toBeUndefined();
      expect(backup.summary).toMatchObject({ status: 'completed', rowsWritten: 4, files: [path] });

      const inspection = await request<BackupInspection>({
        kind: 'backup-inspect',
        input: { path, passphrase: PASSPHRASE },
      });
      const customers = inspection.objects?.find(
        (o) => o.kind === 'table' && o.name === 'customers',
      );
      expect(customers?.rows).toBe(3);

      const restore = {
        kind: 'restore' as const,
        profileId: newId(),
        database: copy,
        path,
        passphrase: PASSPHRASE,
        select: [customers!.id],
        onError: 'stop' as const,
      };
      const plan = await request<RestorePlan>({
        kind: 'restore-plan',
        input: { ...restore, createDatabase: true },
        resolved: profile(),
      });
      expect(plan.conflicts).toEqual([]);
      const created = await job({ ...restore, createDatabase: true });
      expect(created.error).toBeUndefined();
      expect(created.summary).toMatchObject({ status: 'completed', rowsWritten: 3 });

      const check = await (await loadAdapter(dialect)).connect(profile(copy));
      try {
        expect(await rows(check, 'SELECT id, name FROM customers ORDER BY id')).toEqual([
          [1, 'Ada'],
          [2, 'Grace'],
          [3, 'Zoë'],
        ]);
        const tables = await rows(
          check,
          dialect === 'postgres'
            ? "SELECT count(*) FROM information_schema.tables WHERE table_name = 'notes'"
            : "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes'",
        );
        expect(Number(tables[0]?.[0])).toBe(0);

        // Over itself: the table is dropped and created again only once that is confirmed.
        const again = await request<RestorePlan>({
          kind: 'restore-plan',
          input: restore,
          resolved: profile(),
        });
        expect(again.conflicts.map((c) => [c.id, c.action])).toEqual([[customers!.id, 'drop']]);
        const refused = await job(restore);
        expect(refused.error?.code).toBe('CONFIRMATION_REQUIRED');
        await rows(check, "UPDATE customers SET name = 'changed' WHERE id = 1");
        const replaced = await job({
          ...restore,
          confirmedConflicts: again.conflicts.map((c) => c.id),
        });
        expect(replaced.error).toBeUndefined();
        expect(await rows(check, 'SELECT name FROM customers WHERE id = 1')).toEqual([['Ada']]);
      } finally {
        await check.close();
      }
      expect(JSON.stringify(posted)).not.toContain(PASSPHRASE);
    },
  );
});
