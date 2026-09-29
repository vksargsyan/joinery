import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { schemaSnapshotSchema } from '@joinery/core';
import type { SchemaSnapshot } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  compareSchemas,
  formatStatements,
  generateScript,
  missingDependencies,
  renderCreateTable,
  renderHtmlReport,
  renderSnapshotDdl,
  setAllSelected,
  setOperationSelected,
  tokenizeSql,
} from '../src';
import type { SchemaDiff } from '../src';

function snapshot(
  engine: 'postgres' | 'mysql' | 'mariadb',
  database: string,
  schemas: unknown[],
): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine,
    database,
    capturedAt: '2026-01-01T00:00:00Z',
    schemas,
  });
}

function golden(name: string, side: 'source' | 'target'): SchemaSnapshot {
  const file = fileURLToPath(new URL(`./golden/${name}/${side}.json`, import.meta.url));
  return schemaSnapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const col = (
  name: string,
  ordinal: number,
  dataType: string,
  extra: Record<string, unknown> = {},
) => ({
  name,
  ordinal,
  dataType,
  nullable: true,
  ...extra,
});

describe('compareSchemas', () => {
  it('refuses pairs across engine families', () => {
    const pg = snapshot('postgres', 'a', []);
    const my = snapshot('mysql', 'b', []);
    expect(() => compareSchemas(pg, my)).toThrow(/Cannot sync structure from postgres to mysql/);
    expect(() => compareSchemas({ ...pg, engine: 'mongodb' }, pg)).toThrow(
      /does not support mongodb/,
    );
  });

  it('matches the single MySQL schema whatever the database names and emits unqualified names', () => {
    const source = snapshot('mysql', 'shop_dev', [
      { name: 'shop_dev', tables: [{ name: 't', columns: [col('a', 1, 'int')] }] },
    ]);
    const target = snapshot('mysql', 'shop_prod', [
      { name: 'shop_prod', tables: [{ name: 't', columns: [col('a', 1, 'bigint')] }] },
    ]);
    const { diff, summary } = compareSchemas(source, target);
    expect(summary).toMatchObject({ total: 1, alter: 1 });
    expect(diff.operations[0]!.statements).toEqual(['ALTER TABLE `t` MODIFY COLUMN `a` int']);
  });

  it('keeps operation ids stable across compares', () => {
    const a = compareSchemas(golden('pg-views', 'source'), golden('pg-views', 'target')).diff;
    const b = compareSchemas(golden('pg-views', 'source'), golden('pg-views', 'target')).diff;
    expect(a.operations.map((op) => op.id)).toEqual(b.operations.map((op) => op.id));
    expect(new Set(a.operations.map((op) => op.id)).size).toBe(a.operations.length);
  });

  it('matches names case-insensitively on request', () => {
    const source = snapshot('postgres', 'a', [
      { name: 'public', tables: [{ name: 'Users', columns: [col('Id', 1, 'integer')] }] },
    ]);
    const target = snapshot('postgres', 'b', [
      { name: 'public', tables: [{ name: 'users', columns: [col('id', 1, 'integer')] }] },
    ]);
    expect(compareSchemas(source, target).summary.total).toBe(2);
    expect(compareSchemas(source, target, { ignoreNameCase: true }).diff.identical).toBe(true);
  });

  it('writes owners and comments only when they are compared', () => {
    const table = (owner: string, comment: string) => ({
      name: 't',
      columns: [col('a', 1, 'integer')],
      owner,
      comment,
    });
    const source = snapshot('postgres', 'a', [{ name: 'public', tables: [table('app', 'new')] }]);
    const target = snapshot('postgres', 'b', [{ name: 'public', tables: [table('admin', 'old')] }]);
    expect(compareSchemas(source, target).diff.operations[0]!.statements).toEqual([
      `COMMENT ON TABLE "public"."t" IS 'new'`,
    ]);
    expect(
      compareSchemas(source, target, { ignoreOwnership: false }).diff.operations[0]!.statements,
    ).toContain('ALTER TABLE "public"."t" OWNER TO "app"');
    expect(compareSchemas(source, target, { ignoreComments: true }).diff.identical).toBe(true);
  });

  it('re-creates MySQL foreign keys renamed by a rule (MySQL cannot rename them)', () => {
    const table = (fk: string) => ({
      name: 'c',
      columns: [col('p', 1, 'int')],
      indexes: [{ name: 'p', columns: [{ name: 'p' }] }],
      foreignKeys: [{ name: fk, columns: ['p'], refTable: 'parent', refColumns: ['id'] }],
    });
    const parent = {
      name: 'parent',
      columns: [col('id', 1, 'int')],
      primaryKey: { name: 'PRIMARY', columns: ['id'] },
    };
    const source = snapshot('mysql', 'a', [{ name: 'a', tables: [table('fk_c_parent'), parent] }]);
    const target = snapshot('mysql', 'b', [{ name: 'b', tables: [table('c_ibfk_1'), parent] }]);
    const { diff } = compareSchemas(source, target, {
      renames: [{ objectKind: 'constraint', table: 'c', from: 'c_ibfk_1', to: 'fk_c_parent' }],
    });
    expect(diff.operations.map((op) => [op.id, op.changes, op.statements])).toEqual([
      [
        'foreign-key:c.fk_c_parent:alter',
        ['name: c_ibfk_1 → fk_c_parent'],
        [
          'ALTER TABLE `c` DROP FOREIGN KEY `c_ibfk_1`',
          'ALTER TABLE `c` ADD CONSTRAINT `fk_c_parent` FOREIGN KEY (`p`) REFERENCES `parent` (`id`)',
        ],
      ],
    ]);
  });

  it('accepts either table name in a column rename rule', () => {
    const source = snapshot('postgres', 'a', [
      { name: 'public', tables: [{ name: 't', columns: [col('full_name', 1, 'text')] }] },
    ]);
    const target = snapshot('postgres', 'b', [
      { name: 'public', tables: [{ name: 't', columns: [col('name', 1, 'text')] }] },
    ]);
    const { diff } = compareSchemas(source, target, {
      renames: [{ objectKind: 'column', table: 't', from: 'name', to: 'full_name' }],
    });
    expect(diff.operations.map((op) => [op.kind, op.statements])).toEqual([
      ['rename', ['ALTER TABLE "public"."t" RENAME COLUMN "name" TO "full_name"']],
    ]);
  });
});

describe('selection', () => {
  const diff = (): SchemaDiff =>
    compareSchemas(golden('pg-fk-cycles', 'source'), golden('pg-fk-cycles', 'target')).diff;

  it('unticking an operation unticks what depends on it', () => {
    const initial = diff();
    const create = initial.operations.find((op) => op.id === 'table:public.books:create')!;
    expect(create.selected).toBe(true);
    const dependents = initial.operations
      .filter((op) => op.dependsOn.includes(create.id))
      .map((op) => op.id);
    expect(dependents).toEqual(
      expect.arrayContaining([
        'foreign-key:public.authors.authors_favourite_fk:create',
        'foreign-key:public.books.books_author_id_fkey:create',
      ]),
    );
    const after = setOperationSelected(initial, create.id, false);
    for (const id of [create.id, ...dependents])
      expect(after.operations.find((op) => op.id === id)!.selected).toBe(false);
    expect(missingDependencies(after)).toEqual([]);
  });

  it('ticking an operation ticks what it needs', () => {
    const none = setAllSelected(diff(), false);
    expect(none.operations.every((op) => !op.selected)).toBe(true);
    const fk = 'foreign-key:public.books.books_author_id_fkey:create';
    const after = setOperationSelected(none, fk, true);
    const selected = after.operations
      .filter((op) => op.selected)
      .map((op) => op.id)
      .sort();
    expect(selected).toEqual(
      [fk, 'table:public.authors:create', 'table:public.books:create'].sort(),
    );
  });

  it('reports dependencies left out by direct edits in the script warnings', () => {
    const initial = diff();
    const edited: SchemaDiff = {
      ...initial,
      operations: initial.operations.map((op) =>
        op.id === 'table:public.authors:create' ? { ...op, selected: false } : op,
      ),
    };
    const script = generateScript(edited);
    expect(script.missingDependencies.length).toBeGreaterThan(0);
    expect(script.warnings.some((w) => w.code === 'missing-dependency')).toBe(true);
  });

  it('starts destructive operations unticked and leaves them out of the default script', () => {
    const { diff: d } = compareSchemas(
      golden('pg-tables', 'source'),
      golden('pg-tables', 'target'),
    );
    const drop = d.operations.find((op) => op.id === 'table:public.audit_log:drop')!;
    expect(drop).toMatchObject({ destructive: true, selected: false });
    expect(generateScript(d).statements).not.toContain('DROP TABLE "public"."audit_log"');
    expect(generateScript(d, { include: 'all' }).statements).toContain(
      'DROP TABLE "public"."audit_log"',
    );
  });
});

describe('generateScript', () => {
  it('wraps PostgreSQL in one transaction and adds enum labels first', () => {
    const { diff } = compareSchemas(golden('pg-enums', 'source'), golden('pg-enums', 'target'));
    const script = generateScript(diff);
    const begin = script.statements.indexOf('BEGIN');
    const addValue = script.statements.findIndex((s) => s.includes('ADD VALUE'));
    expect(addValue).toBeGreaterThanOrEqual(0);
    expect(addValue).toBeLessThan(begin);
    expect(script.statements.at(-1)).toBe('COMMIT');
    expect(script.transactional).toBe(true);
    expect(script.backupRecommended).toBe(false);
    const plain = generateScript(diff, { transaction: false, header: false, comments: false });
    expect(plain.statements).not.toContain('BEGIN');
    expect(plain.text.startsWith('ALTER TYPE')).toBe(true);
  });

  it('keeps DELIMITER out of the statements and picks a delimiter absent from the body', () => {
    const { diff } = compareSchemas(
      golden('my-code-objects', 'source'),
      golden('my-code-objects', 'target'),
    );
    const script = generateScript(diff);
    expect(script.backupRecommended).toBe(true);
    expect(script.transactional).toBe(false);
    expect(script.statements.some((s) => s.includes('DELIMITER'))).toBe(false);
    expect(script.text).toContain('DELIMITER $$');
    const body = "CREATE PROCEDURE p() BEGIN SELECT '$$'; END";
    expect(formatStatements([body], 'mysql')).toBe(`DELIMITER ;;\n${body};;\nDELIMITER ;`);
    expect(generateScript(diff, { disableForeignKeyChecks: false }).statements).not.toContain(
      'SET FOREIGN_KEY_CHECKS = 0',
    );
  });

  it('produces an empty script for identical databases', () => {
    const snap = golden('pg-views', 'source');
    const { diff } = compareSchemas(snap, snap);
    expect(diff.identical).toBe(true);
    expect(generateScript(diff).statements).toEqual([]);
  });
});

describe('identifier safety', () => {
  const nasty = ['we"ird', 'back`tick', 'semi;colon', "quote'd", 'spaced name', '--dash'];

  function checkStatements(statements: readonly string[], dialect: 'postgres' | 'mysql'): void {
    for (const sql of statements) {
      const tokens = tokenizeSql(sql, dialect);
      expect(
        tokens.some((t) => t.kind === 'punct' && t.text === ';'),
        sql,
      ).toBe(false);
      expect(
        tokens.some((t) => t.kind === 'comment'),
        sql,
      ).toBe(false);
      for (const t of tokens.filter((t) => t.kind === 'quoted-ident')) {
        expect([...nasty, 'public', 'app', 'lib', ...nasty.map((n) => `${n}_2`)], sql).toContain(
          t.value,
        );
      }
    }
  }

  it.each(['postgres', 'mysql'] as const)(
    'quotes hostile names in every statement (%s)',
    (dialect) => {
      const schemaName = dialect === 'postgres' ? 'app' : 'lib';
      const table = (name: string) => ({
        name,
        columns: nasty.map((c, i) =>
          col(c, i + 1, dialect === 'postgres' ? 'integer' : 'int', { comment: `it's ${c}` }),
        ),
        primaryKey: { name: `${name}_2`, columns: [nasty[0]] },
        indexes: [{ name: `${nasty[4]}_2`, columns: [{ name: nasty[1] }] }],
        foreignKeys: [
          {
            name: `${nasty[5]}_2`,
            columns: [nasty[2]],
            refTable: nasty[3],
            refColumns: [nasty[0]],
          },
        ],
        checks: [
          {
            name: `${nasty[2]}_2`,
            expression: dialect === 'postgres' ? '("we""ird" > 0)' : '(`we"ird` > 0)',
          },
        ],
      });
      const source = snapshot(dialect, 'a', [{ name: schemaName, tables: nasty.map(table) }]);
      const target = snapshot(dialect, 'b', [{ name: schemaName }]);
      const { diff } = compareSchemas(source, target);
      const script = generateScript(diff, { include: 'all' });
      expect(script.statements.length).toBeGreaterThan(nasty.length);
      checkStatements(script.statements, dialect);
      const back = generateScript(compareSchemas(target, source).diff, { include: 'all' });
      checkStatements(back.statements, dialect);
    },
  );
});

describe('DDL rendering', () => {
  it('renders CREATE TABLE for PostgreSQL', () => {
    const table = golden('pg-tables', 'source').schemas[0]!.tables.find(
      (t) => t.name === 'orders',
    )!;
    expect(
      renderCreateTable(table, 'postgres', { schema: 'public', includeForeignKeys: false }),
    ).toBe(
      [
        'CREATE TABLE "public"."orders" (',
        '  "id" bigint GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 1) NOT NULL,',
        '  "customer_id" integer NOT NULL,',
        '  "total" numeric(12,2) NOT NULL,',
        '  "note" text,',
        '  "placed_at" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP,',
        '  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),',
        '  CONSTRAINT "orders_total_check" CHECK ((total >= (0)::numeric))',
        ')',
      ].join('\n'),
    );
  });

  it('renders CREATE TABLE for MySQL with inline keys and foreign keys', () => {
    const table = golden('my-create-table', 'source').schemas[0]!.tables.find(
      (t) => t.name === 'orders',
    )!;
    const sql = renderCreateTable(table, 'mysql');
    expect(sql).toContain(
      '  CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,',
    );
    expect(sql).toContain('  FULLTEXT KEY `ft_orders_note` (`note`),');
    expect(sql.endsWith(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci')).toBe(
      true,
    );
    expect(sql).not.toContain('AUTO_INCREMENT=');
    expect(renderCreateTable(table, 'mysql', { ignoreAutoIncrement: false })).toContain(
      'AUTO_INCREMENT=1',
    );
  });

  it('forward-engineers a whole snapshot in dependency order', () => {
    const script = renderSnapshotDdl(golden('pg-ordering', 'source'));
    const text = script.statements.join('\n');
    const at = (needle: string): number => text.indexOf(needle);
    expect(at('CREATE OR REPLACE FUNCTION public.next_code')).toBeLessThan(
      at('CREATE TABLE "public"."tickets"'),
    );
    expect(at('CREATE TABLE "public"."base"')).toBeLessThan(at('FOREIGN KEY ("base_id")'));
    expect(at('CREATE OR REPLACE FUNCTION public.open_tickets')).toBeLessThan(
      at('CREATE VIEW "public"."ticket_codes"'),
    );
    expect(at('CREATE VIEW "public"."ticket_codes"')).toBeLessThan(
      at('CREATE VIEW "public"."ticket_codes2"'),
    );
    expect(text).not.toContain('CREATE SCHEMA "public"');
  });
});

describe('renderHtmlReport', () => {
  it('is self-contained and escapes every value', () => {
    const source = snapshot('postgres', 'dev<db>', [
      {
        name: 'public',
        tables: [
          { name: '<script>alert(1)</script>', columns: [col('a', 1, 'integer')], comment: '"&\'' },
        ],
      },
    ]);
    const target = snapshot('postgres', 'prod', [{ name: 'public' }]);
    const { diff } = compareSchemas(source, target);
    const html = renderHtmlReport(diff, { title: 'Report <1>', script: generateScript(diff) });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Report &lt;1&gt;');
    expect(html).toContain('dev&lt;db&gt;');
    expect(html).not.toMatch(/\b(src|href)=/);
    expect(html).toContain('Side by side');
    const identical = renderHtmlReport(compareSchemas(target, target).diff);
    expect(identical).toContain('The databases are identical.');
  });
});
