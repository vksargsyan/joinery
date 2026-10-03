import { join } from 'node:path';

import { QuerybaraError } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrate,
  openDatabase,
  openStore,
  readSchemaVersion,
  type Migration,
} from '../src';
import { tempDir, testSealer, thrown } from './helpers';

function emptyDatabase() {
  return openDatabase(':memory:');
}

describe('migrate', () => {
  it('builds the schema from an empty database', () => {
    const db = emptyDatabase();
    expect(readSchemaVersion(db)).toBe(0);
    const result = migrate(db);
    expect(result).toEqual({
      from: 0,
      to: SCHEMA_VERSION,
      applied: MIGRATIONS.map((migration) => migration.version),
    });
    const names = db
      .all("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name")
      .map((row) => row['name']);
    expect(names).toEqual(
      expect.arrayContaining([
        'folders',
        'metadata_cache',
        'profile_secrets',
        'profiles',
        'query_history',
        'query_history_fts',
        'query_history_fts_insert',
        'saved_queries',
        'secrets',
        'settings',
        'snippets',
      ]),
    );
    db.close();
  });

  it('is idempotent', () => {
    const db = emptyDatabase();
    migrate(db);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
    db.close();
  });

  it('keeps data across reopening a file store', () => {
    const location = join(tempDir(), 'store.db');
    const first = openStore(location, { sealer: testSealer() });
    first.settings.set('theme', 'dark');
    first.close();
    const second = openStore(location, { sealer: testSealer() });
    expect(second.settings.get('theme')).toBe('dark');
    expect(readSchemaVersion(second.db)).toBe(SCHEMA_VERSION);
    second.close();
  });

  it('refuses a store written by a newer Querybara', () => {
    const location = join(tempDir(), 'store.db');
    const db = openDatabase(location);
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();

    const error = thrown(() => openStore(location, { sealer: testSealer() }));
    expect(error).toBeInstanceOf(QuerybaraError);
    expect(error).toMatchObject({
      code: 'NOT_SUPPORTED',
      message: expect.stringContaining(`schema version ${SCHEMA_VERSION + 5}`),
      hint: expect.stringMatching(/Update Querybara/),
    });
  });

  it('applies only pending migrations, each in its own transaction', () => {
    const db = emptyDatabase();
    const log: number[] = [];
    const steps: Migration[] = [
      { version: 1, name: 'one', up: (d) => (d.exec('CREATE TABLE a (x TEXT)'), log.push(1)) },
      { version: 2, name: 'two', up: (d) => (d.exec('CREATE TABLE b (x TEXT)'), log.push(2)) },
    ];
    migrate(db, steps.slice(0, 1));
    expect(migrate(db, steps).applied).toEqual([2]);
    expect(log).toEqual([1, 2]);
    db.close();
  });

  it('rolls back a failing migration and stays at the last good version', () => {
    const db = emptyDatabase();
    const steps: Migration[] = [
      { version: 1, name: 'one', up: (d) => d.exec('CREATE TABLE a (x TEXT)') },
      {
        version: 2,
        name: 'broken',
        up: (d) => {
          d.exec('CREATE TABLE b (x TEXT)');
          throw new Error('broken migration');
        },
      },
    ];
    expect(() => migrate(db, steps)).toThrow('broken migration');
    expect(readSchemaVersion(db)).toBe(1);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'b'")).toBeUndefined();
    db.close();
  });

  it('rejects migrations that are not numbered 1..n', () => {
    const db = emptyDatabase();
    expect(() => migrate(db, [{ version: 2, name: 'gap', up: () => undefined }])).toThrow(
      /must have version 1/,
    );
    db.close();
  });
});
