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

  it('matches names case-insensitively on request (MySQL family)', () => {
    const source = snapshot('mariadb', 'a', [
      { name: 'a', tables: [{ name: 'Users', columns: [col('Id', 1, 'int')] }] },
    ]);
    const target = snapshot('mariadb', 'b', [
      { name: 'b', tables: [{ name: 'users', columns: [col('id', 1, 'int')] }] },
    ]);
    expect(compareSchemas(source, target).summary.total).toBe(2);
    expect(compareSchemas(source, target, { ignoreNameCase: true }).diff.identical).toBe(true);
  });

  it('warns that InnoDB will not lower AUTO_INCREMENT below existing values', () => {
    const table = (autoIncrement: string) => ({
      name: 't',
      columns: [col('id', 1, 'int', { nullable: false, autoIncrement: true })],
      primaryKey: { name: 'PRIMARY', columns: ['id'] },
      options: { engine: 'InnoDB', autoIncrement },
    });
    const at = (value: string) => snapshot('mysql', 'a', [{ name: 'a', tables: [table(value)] }]);
    const warningsOf = (from: string, to: string) =>
      compareSchemas(at(to), at(from), { ignoreAutoIncrement: false }).diff.operations.flatMap(
        (op) => op.warnings.map((w) => w.code),
      );
    expect(warningsOf('500', '1000')).toEqual([]);
    expect(warningsOf('1000', '1')).toEqual(['may-fail']);
  });

  it('compares PostgreSQL name case even when asked not to, and says so', () => {
    // A script cannot reach "Users" as users: the names are different objects there.
    const source = snapshot('postgres', 'a', [
      { name: 'public', tables: [{ name: 'Users', columns: [col('Id', 1, 'integer')] }] },
    ]);
    const target = snapshot('postgres', 'b', [
      { name: 'public', tables: [{ name: 'users', columns: [col('id', 1, 'integer')] }] },
    ]);
    const { diff } = compareSchemas(source, target, { ignoreNameCase: true });
    expect(diff.operations.map((op) => op.id).sort()).toEqual([
      'table:public.Users:create',
      'table:public.users:drop',
    ]);
    expect(diff.warnings.map((w) => w.message).join()).toMatch(/case-sensitive/);
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

  describe('MySQL triggers and renames', () => {
    // MySQL and MariaDB move a trigger with its table (its ON clause follows a table rename) but
    // never rewrite its body: a renamed column or table the body uses leaves the trigger broken.
    const trigger = (name: string, table: string, body: string) => ({
      name,
      timing: 'BEFORE',
      events: ['INSERT'],
      definition: `CREATE TRIGGER \`${name}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW ${body}`,
    });
    const table = (name: string, a: string, triggers: unknown[]) => ({
      name,
      columns: [col('id', 1, 'int'), col(a, 2, 'int'), col('b', 3, 'int')],
      triggers,
    });
    const log = { name: 'log', columns: [col('n', 1, 'int')] };
    const at = (engine: 'mysql' | 'mariadb', tables: unknown[]) =>
      snapshot(engine, 'a', [{ name: 'a', tables: [...tables, log] }]);

    for (const engine of ['mysql', 'mariadb'] as const) {
      it(`re-creates a trigger whose body uses a renamed column, after the rename (${engine})`, () => {
        const source = at(engine, [
          table('t', 'a2', [trigger('trg', 't', 'SET NEW.b = NEW.a2 + 1')]),
        ]);
        const target = at(engine, [
          table('t', 'a', [trigger('trg', 't', 'SET NEW.b = NEW.a + 1')]),
        ]);
        const { diff } = compareSchemas(source, target, {
          renames: [{ objectKind: 'column', table: 't', from: 'a', to: 'a2' }],
        });
        const rename = diff.operations.find((op) => op.objectKind === 'column')!;
        const rebuild = diff.operations.find((op) => op.objectKind === 'trigger')!;
        expect(rebuild).toMatchObject({
          id: 'trigger:t.trg:rebuild',
          kind: 'alter',
          statements: [
            'DROP TRIGGER IF EXISTS `trg`',
            'CREATE TRIGGER `trg` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.b = NEW.a2 + 1',
          ],
          selected: true,
        });
        expect(rebuild.dependsOn).toContain(rename.id);
        expect(rebuild.warnings.map((w) => w.code)).toEqual(['rebuild']);
        const statements = generateScript(diff).statements;
        expect(statements.indexOf(rebuild.statements[1]!)).toBeGreaterThan(
          statements.indexOf(rename.statements[0]!),
        );
        // Unticking the rename unticks the rebuild, which needs the new column name.
        const unticked = setOperationSelected(diff, rename.id, false);
        expect(unticked.operations.find((op) => op.id === rebuild.id)!.selected).toBe(false);
      });
    }

    it('leaves a trigger that moves with its renamed table alone, and re-creates one whose body names the table', () => {
      const source = at('mysql', [
        table('t2', 'a', [
          trigger('trg', 't2', 'SET NEW.b = NEW.a + 1'),
          trigger('trg_count', 't2', 'SET NEW.b = (SELECT COUNT(*) FROM t2)'),
        ]),
      ]);
      const target = at('mysql', [
        table('t', 'a', [
          trigger('trg', 't', 'SET NEW.b = NEW.a + 1'),
          trigger('trg_count', 't', 'SET NEW.b = (SELECT COUNT(*) FROM t)'),
        ]),
      ]);
      const { diff } = compareSchemas(source, target, {
        renames: [{ objectKind: 'table', from: 't', to: 't2' }],
      });
      expect(diff.operations.map((op) => op.id).sort()).toEqual([
        'table:t2:rename',
        'trigger:t2.trg_count:rebuild',
      ]);
      const rebuild = diff.operations.find((op) => op.objectKind === 'trigger')!;
      expect(rebuild.dependsOn).toEqual(['table:t2:rename']);
      expect(rebuild.statements[1]).toBe(
        'CREATE TRIGGER `trg_count` BEFORE INSERT ON `t2` FOR EACH ROW SET NEW.b = (SELECT COUNT(*) FROM t2)',
      );
    });

    it('re-creates a trigger of another table whose body uses the renamed column', () => {
      const other = (column: string) => ({
        name: 'audit',
        columns: [col('id', 1, 'int')],
        triggers: [trigger('audit_bi', 'audit', `INSERT INTO t (${column}) VALUES (NEW.id)`)],
      });
      const source = at('mariadb', [table('t', 'a2', []), other('a2')]);
      const target = at('mariadb', [table('t', 'a', []), other('a')]);
      const { diff } = compareSchemas(source, target, {
        renames: [{ objectKind: 'column', table: 't', from: 'a', to: 'a2' }],
      });
      expect(diff.operations.map((op) => op.id).sort()).toEqual([
        'column:t.a2:rename',
        'trigger:audit.audit_bi:rebuild',
      ]);
    });

    it('keeps comparing a changed trigger as a change', () => {
      const source = at('mysql', [
        table('t', 'a2', [trigger('trg', 't', 'SET NEW.b = NEW.a2 * 2')]),
      ]);
      const target = at('mysql', [table('t', 'a', [trigger('trg', 't', 'SET NEW.b = NEW.a + 1')])]);
      const { diff } = compareSchemas(source, target, {
        renames: [{ objectKind: 'column', table: 't', from: 'a', to: 'a2' }],
      });
      const op = diff.operations.find((o) => o.objectKind === 'trigger')!;
      expect(op).toMatchObject({ id: 'trigger:t.trg:alter', changes: ['definition changed'] });
      expect(op.dependsOn).toContain('column:t.a2:rename');
    });

    it('keeps PostgreSQL triggers, which follow renames, untouched', () => {
      const pgTrigger = (column: string) => ({
        name: 'trg',
        timing: 'BEFORE',
        events: ['UPDATE'],
        definition: `CREATE TRIGGER trg BEFORE UPDATE ON public.t FOR EACH ROW WHEN ((old.${column} IS DISTINCT FROM new.${column})) EXECUTE FUNCTION public.f()`,
      });
      const pgAt = (column: string) =>
        snapshot('postgres', 'a', [
          {
            name: 'public',
            tables: [
              { name: 't', columns: [col(column, 1, 'integer')], triggers: [pgTrigger(column)] },
            ],
          },
        ]);
      const { diff } = compareSchemas(pgAt('a2'), pgAt('a'), {
        renames: [{ objectKind: 'column', table: 't', from: 'a', to: 'a2' }],
      });
      expect(diff.operations.map((op) => op.id)).toEqual(['column:public.t.a2:rename']);
    });
  });

  describe('PostgreSQL literal casts in checks and index expressions', () => {
    // Hand-written (model, designer) expressions against what PostgreSQL 16 prints for them.
    const columns = [
      col('id', 1, 'integer'),
      col('price', 2, 'numeric(10,2)'),
      col('qty', 3, 'integer'),
      col('big', 4, 'bigint'),
      col('ratio', 5, 'double precision'),
      col('d', 6, 'date'),
      col('m', 7, 'public.mood'),
      col('v', 8, 'character varying(10)'),
    ];
    const at = (checks: string[], indexes: unknown[] = []) =>
      snapshot('postgres', 'a', [
        {
          name: 'public',
          tables: [
            {
              name: 't',
              columns,
              checks: checks.map((expression, i) => ({ name: `c${i}`, expression })),
              indexes,
            },
          ],
        },
      ]);
    const same = (written: string, reported: string): boolean =>
      compareSchemas(at([written]), at([reported])).diff.identical;

    it.each([
      ['price > 0', '(price > (0)::numeric)'],
      ['0 < price', '((0)::numeric < price)'],
      ['price >= -1', "(price >= ('-1'::integer)::numeric)"],
      ['price < 1.5', '(price < 1.5)'],
      ["price > '5'", "(price > '5'::numeric)"],
      ['ratio >= 0.5', '(ratio >= (0.5)::double precision)'],
      ['ratio > 0', '(ratio > (0)::double precision)'],
      ['ratio > -2.5', "(ratio > ('-2.5'::numeric)::double precision)"],
      ["d > '2020-01-01'", "(d > '2020-01-01'::date)"],
      ['big < 3000000000', "(big < '3000000000'::bigint)"],
      ['big > -5', "(big > '-5'::integer)"],
      ["m <> 'bad'", "(m <> 'bad'::mood)"],
      ['price > 0::numeric', '(price > (0)::numeric)'],
    ])('%s reads back as %s', (written, reported) => {
      expect(same(written, reported)).toBe(true);
    });

    it.each([
      // A cast of the column is never dropped.
      ["v <> 'x'", "((v)::text <> 'x'::text)"],
      // Casts that change the meaning: integer division, a typmod, a type that is not the column's.
      ['qty / 2 > 1', '((qty / (2)::numeric) > 1)'],
      ['price > 1.234', '(price > (1.234)::numeric(10,2))'],
      ['qty > 0', '(qty > (0)::numeric)'],
      // Only literals: nothing says which type they were meant to have.
      ['2 / 3 > 0', '(((2)::numeric / (3)::numeric) > 0)'],
    ])('%s differs from %s', (written, reported) => {
      expect(same(written, reported)).toBe(false);
    });

    it('compares partial-index predicates and index expressions the same way', () => {
      const index = (name: string, part: Record<string, unknown>, where?: string) => ({
        name,
        columns: [part],
        ...(where !== undefined ? { where } : {}),
      });
      const written = at(
        [],
        [
          index('i1', { name: 'price' }, 'price > 0'),
          index('i2', { name: null, expression: 'price * 2' }),
          index('i3', { name: 'd' }, "d > '2020-01-01'"),
        ],
      );
      const reported = at(
        [],
        [
          index('i1', { name: 'price' }, '(price > (0)::numeric)'),
          index('i2', { name: null, expression: '(price * 2::numeric)' }),
          index('i3', { name: 'd' }, "(d > '2020-01-01'::date)"),
        ],
      );
      expect(compareSchemas(written, reported).diff.operations).toEqual([]);
      expect(compareSchemas(reported, written).diff.operations).toEqual([]);
    });

    it('follows column renames when matching the column type', () => {
      const renamed = snapshot('postgres', 'a', [
        {
          name: 'public',
          tables: [
            {
              name: 't',
              columns: [col('amount', 1, 'numeric(10,2)')],
              checks: [{ name: 'c', expression: 'amount > 0' }],
            },
          ],
        },
      ]);
      const live = snapshot('postgres', 'b', [
        {
          name: 'public',
          tables: [
            {
              name: 't',
              columns: [col('price', 1, 'numeric(10,2)')],
              checks: [{ name: 'c', expression: '(price > (0)::numeric)' }],
            },
          ],
        },
      ]);
      const { diff } = compareSchemas(renamed, live, {
        renames: [{ objectKind: 'column', table: 't', from: 'price', to: 'amount' }],
      });
      expect(diff.operations.map((op) => op.id)).toEqual(['column:public.t.amount:rename']);
    });
  });

  it('compares an unreported InnoDB row format as the server default (DYNAMIC)', () => {
    // MySQL 8.4 and MariaDB 11.4 report ROW_FORMAT only when it was declared (DEFAULT is not),
    // and InnoDB stores a table without one as DYNAMIC (innodb_default_row_format).
    const at = (options: Record<string, string>) =>
      snapshot('mysql', 'a', [
        { name: 'a', tables: [{ name: 't', columns: [col('id', 1, 'int')], options }] },
      ]);
    const alter = (source: Record<string, string>, target: Record<string, string>) =>
      compareSchemas(at(source), at(target)).diff.operations.flatMap((op) => op.statements);
    const innodb = { engine: 'InnoDB' };
    expect(alter({ ...innodb, rowFormat: 'COMPACT' }, innodb)).toEqual([
      'ALTER TABLE `t` ROW_FORMAT=COMPACT',
    ]);
    expect(alter({ rowFormat: 'COMPRESSED' }, {})).toEqual([
      'ALTER TABLE `t` ROW_FORMAT=COMPRESSED',
    ]);
    expect(alter(innodb, { ...innodb, rowFormat: 'COMPACT' })).toEqual([
      'ALTER TABLE `t` ROW_FORMAT=DEFAULT',
    ]);
    expect(alter({ ...innodb, rowFormat: 'DYNAMIC' }, innodb)).toEqual([]);
    expect(alter(innodb, { ...innodb, rowFormat: 'Dynamic' })).toEqual([]);
    expect(alter({ ...innodb, rowFormat: 'DEFAULT' }, innodb)).toEqual([]);
    // Other engines pick their format from the columns: still compared only when both declare it.
    const myisam = { engine: 'MyISAM' };
    expect(alter({ ...myisam, rowFormat: 'FIXED' }, myisam)).toEqual([]);
    expect(alter({ ...myisam, rowFormat: 'FIXED' }, { ...myisam, rowFormat: 'DYNAMIC' })).toEqual([
      'ALTER TABLE `t` ROW_FORMAT=FIXED',
    ]);
  });

  it('compares type spellings equal to what the servers report for them', () => {
    const pgTable = (type: string) => ({ name: 't', columns: [col('a', 1, type)] });
    const pgAt = (type: string) =>
      snapshot('postgres', 'a', [{ name: 'public', tables: [pgTable(type)] }]);
    expect(compareSchemas(pgAt('numeric(5)'), pgAt('numeric(5,0)')).diff.identical).toBe(true);
    expect(compareSchemas(pgAt('numeric(5)'), pgAt('numeric(5,1)')).diff.identical).toBe(false);

    const myAt = (engine: 'mysql' | 'mariadb', types: string[]) =>
      snapshot(engine, 'a', [
        {
          name: 'a',
          tables: [{ name: 't', columns: types.map((t, i) => col(`c${i}`, i + 1, t)) }],
        },
      ]);
    const model = ['int(5) zerofill', 'bigint zerofill', 'long varbinary', 'long varchar'];
    const reported = [
      'int(5) unsigned zerofill',
      'bigint(20) unsigned zerofill',
      'mediumblob',
      'mediumtext',
    ];
    expect(compareSchemas(myAt('mysql', model), myAt('mysql', reported)).diff.identical).toBe(true);
    // MySQL reports GEOMETRYCOLLECTION as geomcollection, MariaDB as geometrycollection.
    const mysql = myAt('mysql', ['geomcollection']);
    const mariadb = myAt('mariadb', ['geometrycollection']);
    expect(compareSchemas(mysql, mariadb).diff.operations).toEqual([]);
    expect(compareSchemas(mariadb, mysql).diff.operations).toEqual([]);
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

  it('keeps the default selection deployable around unticked destructive changes', () => {
    const selected = (name: string, id: string) =>
      compareSchemas(golden(name, 'source'), golden(name, 'target')).diff.operations.find(
        (op) => op.id === id,
      )!;
    // The new predicate `f > 0` only works once the text column f is an integer.
    expect(selected('pg-column-types', 'index:public.t.t_f:alter')).toMatchObject({
      dependsOn: ['column:public.t.f:alter'],
      selected: false,
    });
    // MINVALUE..2024 overlaps the partition 2023..2024 until that one is dropped.
    expect(selected('pg-partition-kinds', 'partition:public.r_min:create')).toMatchObject({
      dependsOn: ['partition:public.r_2023:drop'],
      selected: false,
    });
    expect(selected('pg-partition-kinds', 'partition:public.r_2024:create').dependsOn).toEqual([]);
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
