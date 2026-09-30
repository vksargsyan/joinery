import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../src';
import { tempDir } from './helpers';

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function open(location = ':memory:'): SqliteDatabase {
  const db = openDatabase(location);
  databases.push(db);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
  return db;
}

function values(db: SqliteDatabase): string[] {
  return db.all('SELECT value FROM t ORDER BY id').map((row) => String(row['value']));
}

describe('openDatabase', () => {
  it('opens a file database in WAL mode with foreign keys and a busy timeout', () => {
    const location = join(tempDir(), 'nested', 'store.db');
    const db = open(location);
    expect(db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(db.get('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
    expect(existsSync(location)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(location).mode & 0o777).toBe(0o600);
  });

  it('binds positional and named parameters and reports changes', () => {
    const db = open();
    expect(db.run('INSERT INTO t (value) VALUES (?)', ['a'])).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    db.run('INSERT INTO t (value) VALUES (:value)', { value: 'b' });
    db.prepare('INSERT INTO t (value) VALUES ($value)').run({ $value: 'c' });
    expect(values(db)).toEqual(['a', 'b', 'c']);
    expect(db.get('SELECT value FROM t WHERE id = ?', [99])).toBeUndefined();
    expect(db.run('UPDATE t SET value = ?', ['x']).changes).toBe(3);
  });

  it('round-trips BLOBs and streams rows with iterate', () => {
    const db = open();
    db.exec('CREATE TABLE b (data BLOB NOT NULL) STRICT');
    db.run('INSERT INTO b (data) VALUES (?)', [new Uint8Array([0, 1, 255])]);
    expect(db.get('SELECT data FROM b')?.['data']).toEqual(new Uint8Array([0, 1, 255]));
    for (const value of ['a', 'b', 'c']) db.run('INSERT INTO t (value) VALUES (?)', [value]);
    const seen: string[] = [];
    for (const row of db.iterate('SELECT value FROM t ORDER BY id')) {
      seen.push(String(row['value']));
      // A cached statement used mid-iteration must not disturb the iterator.
      db.get('SELECT count(*) AS n FROM t');
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('closes idempotently', () => {
    const db = openDatabase(':memory:');
    db.close();
    db.close();
    expect(db.isOpen).toBe(false);
    expect(() => db.exec('SELECT 1')).toThrow();
  });
});

describe('transactions', () => {
  it('commits on return and rolls back on throw', () => {
    const db = open();
    expect(db.transaction(() => db.run('INSERT INTO t (value) VALUES (?)', ['kept']).changes)).toBe(
      1,
    );
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (value) VALUES (?)', ['lost']);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(values(db)).toEqual(['kept']);
    expect(db.inTransaction).toBe(false);
  });

  it('nests with savepoints: a caught inner failure undoes only the inner work', () => {
    const db = open();
    db.transaction(() => {
      db.run('INSERT INTO t (value) VALUES (?)', ['outer']);
      expect(db.inTransaction).toBe(true);
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t (value) VALUES (?)', ['inner']);
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.transaction(() => db.run('INSERT INTO t (value) VALUES (?)', ['inner ok']));
    });
    expect(values(db)).toEqual(['outer', 'inner ok']);
  });

  it('rolls back everything when the outer transaction fails after inner ones committed', () => {
    const db = open();
    expect(() =>
      db.transaction(() => {
        db.transaction(() => db.run('INSERT INTO t (value) VALUES (?)', ['inner']));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(values(db)).toEqual([]);
  });

  it('refuses async callbacks and rolls back', async () => {
    const db = open();
    let pending: Promise<void> | undefined;
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (value) VALUES (?)', ['x']);
        pending = Promise.resolve();
        return pending;
      }),
    ).toThrow(/synchronous/);
    await pending;
    expect(values(db)).toEqual([]);
  });

  it('keeps the original error when SQL inside the transaction fails', () => {
    const db = open();
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (value) VALUES (?)', ['x']);
        db.run('INSERT INTO t (value) VALUES (?)', [null]);
      }),
    ).toThrow(/NOT NULL/);
    expect(values(db)).toEqual([]);
  });
});

describe('loading node:sqlite', () => {
  it('waits for the first database, so a program can hide the SQLite warning first', () => {
    // A static import loads node:sqlite while the program's imports are linked, and its
    // "experimental" warning then prints before the CLI's filter is installed (Node 22.17).
    const source = readFileSync(new URL('../src/sqlite.ts', import.meta.url), 'utf8');
    const imports = source.match(/^import .*'node:sqlite';$/gm) ?? [];
    expect(imports.every((line) => line.startsWith('import type '))).toBe(true);
  });
});
