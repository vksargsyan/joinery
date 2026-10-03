import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { QuerybaraError } from '@querybara/core';
import { fileSink } from '@querybara/transfer';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ArchiveWriter,
  checkConfirmed,
  inspectBackup,
  isValidScryptCost,
  manifestSchema,
  safeName,
  type ManifestContent,
} from '../src';

/**
 * What the restore wizard learns from a file before anything runs (format, encryption, engine,
 * manifest), the manifest schema a reader enforces, and the confirmation rule.
 */

const dir = mkdtempSync(join(tmpdir(), 'querybara-inspect-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MANIFEST: ManifestContent = {
  createdAt: '2026-09-29T12:00:00.000Z',
  producer: 'Querybara test',
  engine: 'mariadb',
  serverVersion: '11.4.3-MariaDB',
  database: 'shop',
  objects: [
    {
      id: 'table:orders:create',
      kind: 'table',
      name: 'orders',
      qualifiedName: 'orders',
      dependsOn: [],
      ddl: 'ddl/0001-table-orders.json',
    },
  ],
};

describe('inspectBackup', () => {
  it('reads an archive manifest, and only says "encrypted" without the passphrase', async () => {
    const path = join(dir, 'x.qbak');
    const writer = await ArchiveWriter.create({
      sink: fileSink(path),
      encryption: { passphrase: 'pw', cost: { log2N: 10, r: 8, p: 1 } },
    });
    await writer.add('ddl/0001-table-orders.json', 'application/json', '{"pre":[]}');
    await writer.finish(MANIFEST);

    const locked = await inspectBackup(path);
    expect(locked).toMatchObject({ format: 'qbak', encrypted: true });
    expect(locked.manifest).toBeUndefined();
    const open = await inspectBackup(path, 'pw');
    expect(open).toMatchObject({
      format: 'qbak',
      encrypted: true,
      engine: 'mariadb',
      database: 'shop',
    });
    expect(open.manifest?.objects[0]?.id).toBe('table:orders:create');
    await expect(inspectBackup(path, 'wrong')).rejects.toThrow(/passphrase is wrong/);
  });

  it('recognises plain and gzipped scripts, pg_dump archives and our header line', async () => {
    const script = '-- Querybara backup of shop (postgres 16.4)\n-- Created ...\nSELECT 1;\n';
    writeFileSync(join(dir, 'a.sql'), script);
    writeFileSync(join(dir, 'a.sql.gz'), gzipSync(Buffer.from(script)));
    writeFileSync(join(dir, 'other.sql'), 'CREATE TABLE t (a int);\n');
    writeFileSync(join(dir, 'x.dump'), Buffer.from('PGDMP\u0001\u000e\u0000'));
    expect(await inspectBackup(join(dir, 'a.sql'))).toMatchObject({
      format: 'sql',
      engine: 'postgres',
      serverVersion: '16.4',
      database: 'shop',
    });
    expect(await inspectBackup(join(dir, 'a.sql.gz'))).toMatchObject({
      format: 'sql-gz',
      engine: 'postgres',
    });
    const other = await inspectBackup(join(dir, 'other.sql'));
    expect(other.format).toBe('sql');
    expect(other.engine).toBeUndefined();
    expect((await inspectBackup(join(dir, 'x.dump'))).format).toBe('custom');
    await expect(inspectBackup(join(dir, 'missing.sql'))).rejects.toThrow(/does not exist/);
  });
});

describe('manifest', () => {
  it('rejects manifests of other formats and malformed entries', () => {
    const base = { ...MANIFEST, format: 'querybara-backup', formatVersion: 1, entries: [] };
    expect(manifestSchema.safeParse(base).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, formatVersion: 2 }).success).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...base,
        entries: [
          {
            name: 'a',
            index: 0,
            offset: 0,
            storedLength: 1,
            size: 1,
            sha256: 'not-hex',
            contentType: 'application/sql',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('checkConfirmed', () => {
  const conflicts = [
    { id: 'table:a:create', kind: 'table' as const, qualifiedName: 'a', action: 'drop' as const },
    { id: 'view:v:create', kind: 'view' as const, qualifiedName: 'v', action: 'drop' as const },
  ];

  it('passes only when every conflict was confirmed', () => {
    expect(() => checkConfirmed([], undefined)).not.toThrow();
    expect(() =>
      checkConfirmed(
        conflicts,
        conflicts.map((c) => c.id),
      ),
    ).not.toThrow();
    let error: unknown;
    try {
      checkConfirmed(conflicts, ['table:a:create']);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(QuerybaraError);
    expect((error as QuerybaraError).code).toBe('CONFIRMATION_REQUIRED');
    expect((error as QuerybaraError).message).toBe(
      'Restoring drops 1 existing object first and needs confirmation: v',
    );
  });
});

describe('small rules', () => {
  it('bounds the scrypt cost a file may ask for', () => {
    expect(isValidScryptCost({ log2N: 17, r: 8, p: 1 })).toBe(true);
    expect(isValidScryptCost({ log2N: 30, r: 8, p: 1 })).toBe(false);
    expect(isValidScryptCost({ log2N: 20, r: 32, p: 1 })).toBe(false);
    expect(isValidScryptCost({ log2N: 9, r: 8, p: 1 })).toBe(false);
  });

  it('makes entry names safe', () => {
    expect(safeName('public.orders')).toBe('public.orders');
    expect(safeName('../etc/passwd')).toBe('__etc_passwd');
    expect(safeName('名前 with spaces')).toBe('_with_spaces');
    expect(safeName('')).toBe('_');
  });
});
