import { randomBytes } from 'node:crypto';

import {
  newId,
  rowAt,
  type CellValue,
  type SchemaSnapshot,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import { createMysqlAdapter } from '@joinery/driver-mysql';
import { createPostgresAdapter } from '@joinery/driver-postgres';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';
import { analyzeStatement } from '@joinery/sql-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MetadataCache, type StructureChange } from '../../src/renderer/src/state/metadata-cache';
import { readConnectionFacts } from '../../src/renderer/src/state/session-facts';
import {
  LanguageService,
  type CatalogContext,
  type LanguageResponse,
} from '../../src/renderer/src/workers/language-service';

/**
 * Autocomplete's metadata pipeline against the real servers (spec §5, §6): session facts from
 * the small queries, introspection of the current database only, the language service
 * completing tables, columns and foreign key joins from it, a refresh after DDL, and (MySQL,
 * MariaDB) another database loaded when it is used.
 */

const ENGINES = [
  ['postgres', process.env['JOINERY_TEST_POSTGRES_URL']],
  ['mysql', process.env['JOINERY_TEST_MYSQL_URL']],
  ['mariadb', process.env['JOINERY_TEST_MARIADB_URL']],
] as const;

async function rows(session: Session, sql: string): Promise<CellValue[][]> {
  const out: CellValue[][] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) out.push(rowAt(chunk, r));
    }
  }
  return out;
}

function connect(dialect: SqlDialect, url: string, database?: string): Promise<Session> {
  const adapter =
    dialect === 'postgres' ? createPostgresAdapter() : createMysqlAdapter({ engine: dialect });
  return adapter.connect(
    resolvedProfileFromUrl(
      url,
      database === undefined ? {} : { options: { defaultDatabase: database } },
    ),
  );
}

describe.each(ENGINES)('%s', (dialect, url) => {
  const main = `joinery_ac_${randomBytes(4).toString('hex')}`;
  const other = `joinery_ac_${randomBytes(4).toString('hex')}`;
  let admin: Session | undefined;
  let session: Session | undefined;

  beforeAll(async () => {
    if (!url) return;
    admin = await connect(dialect, url);
    await rows(admin, `CREATE DATABASE ${main}`);
    if (dialect !== 'postgres') await rows(admin, `CREATE DATABASE ${other}`);
    session = await connect(dialect, url, main);
    await rows(session, 'CREATE TABLE authors (id int PRIMARY KEY, name varchar(100))');
    await rows(
      session,
      'CREATE TABLE books (id int PRIMARY KEY, author_id int, title varchar(100), ' +
        'FOREIGN KEY (author_id) REFERENCES authors (id))',
    );
    if (dialect !== 'postgres') await rows(session, `CREATE TABLE ${other}.leads (id int)`);
  });

  afterAll(async () => {
    await session?.close();
    if (admin) {
      const force = dialect === 'postgres' ? ' WITH (FORCE)' : '';
      await rows(admin, `DROP DATABASE IF EXISTS ${main}${force}`).catch(() => {});
      if (dialect !== 'postgres')
        await rows(admin, `DROP DATABASE IF EXISTS ${other}`).catch(() => {});
      await admin.close();
    }
  });

  it.skipIf(!url)('completes from the introspected current database', async () => {
    const responses: LanguageResponse[] = [];
    const service = new LanguageService((response) => responses.push(response), {
      schedule: (task) => task(),
    });
    const changes: StructureChange[] = [];
    const introspected: string[] = [];
    const stored: SchemaSnapshot[] = [];
    const cache = new MetadataCache(
      {
        loadCached: async () => [],
        store: async (_profileId, snapshot) => {
          stored.push(snapshot);
        },
        drop: async () => {},
        facts: (_profileId, d) => readConnectionFacts(d, (sql) => rows(session!, sql)),
        introspect: (_profileId, d, database) => {
          introspected.push(database);
          return session!.introspect(d === 'postgres' ? {} : { database });
        },
      },
      {
        publish: (profileId, change) => service.handle({ type: 'snapshots', profileId, ...change }),
        forget: () => {},
        status: () => {},
        changed: (_profileId, change) => changes.push(change),
      },
    );
    await cache.open('p', dialect);
    const facts = cache.facts('p')!;
    expect(facts.database).toBe(main);
    // Only the current database, never the whole server.
    expect(introspected).toEqual([main]);
    expect(stored.map((s) => s.database)).toEqual([main]);

    const context: CatalogContext = {
      dialect,
      currentDatabase: main,
      ...(facts.searchPath ? { searchPath: facts.searchPath } : {}),
      ...(facts.user ? { user: facts.user } : {}),
      ...(facts.lowerCaseTableNames === undefined
        ? {}
        : { lowerCaseTableNames: facts.lowerCaseTableNames }),
    };
    const labels = (text: string): string[] => {
      const id = responses.length + 1;
      service.handle({ type: 'complete', id, profileId: 'p', context, text, offset: text.length });
      const response = responses.find((r) => r.id === id);
      if (response?.type !== 'complete') throw new Error(`no completion for ${text}`);
      return response.result.items.map((item) => `${item.kind}:${item.label}`);
    };

    expect(labels('SELECT * FROM ')).toEqual(
      expect.arrayContaining(['table:authors', 'table:books']),
    );
    expect(labels('SELECT * FROM books WHERE ')).toEqual(
      expect.arrayContaining(['column:author_id', 'column:title']),
    );
    expect(labels('SELECT * FROM books b JOIN authors a ')).toContain('join:ON a.id = b.author_id');

    // DDL run from a tab: the database is read again and the new table completes.
    const ddl = 'CREATE TABLE reviews (id int PRIMARY KEY)';
    await rows(session!, ddl);
    cache.afterRun('p', {
      tabId: 't1',
      statements: [{ text: ddl, analysis: analyzeStatement(ddl, dialect) }],
      database: main,
      inTransaction: false,
    });
    await expect.poll(() => changes).toEqual([{ databases: [main], list: false }]);
    expect(labels('SELECT * FROM rev')).toContain('table:reviews');

    if (dialect !== 'postgres') {
      // Another database completes by name, and its tables once it is used.
      expect(labels(`SELECT * FROM ${other.slice(0, 12)}`)).toContain(`database:${other}`);
      expect(labels(`SELECT * FROM ${other}.`)).not.toContain('table:leads');
      await cache.use('p', other);
      expect(labels(`SELECT * FROM ${other}.`)).toContain('table:leads');
    }
  });
});
