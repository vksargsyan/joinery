import {
  QuerybaraError,
  type CellValue,
  type SchemaSnapshot,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@querybara/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ChangeSet,
  DEFAULT,
  allColumnsIdentity,
  and,
  applyChanges,
  buildBrowseQuery,
  buildLookupQuery,
  buildReferencedRowQuery,
  condition,
  countRows,
  describeColumns,
  estimateRows,
  fetchPage,
  or,
  pageAfter,
  pageBefore,
  parseCellInput,
  planChanges,
  rowIdentity,
  rowKeyAt,
  sameValue,
  type BrowseOptions,
  type BrowsePage,
  type BrowseQuery,
  type ColumnInfo,
  type EditValue,
  type ExistingRow,
  type FilterNode,
  type RowIdentity,
  type SortTerm,
  type TableRef,
} from '../../src';
import { ScratchDatabase, configuredServers, query } from './helpers';

const BIG = 9007199254740993n;

function ddl(dialect: SqlDialect): string[] {
  if (dialect === 'postgres') {
    return [
      `CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')`,
      `CREATE TABLE items (
        region text NOT NULL,
        id bigint NOT NULL,
        name varchar(50),
        qty integer NOT NULL DEFAULT 0,
        price numeric(10,2),
        ratio real,
        active boolean,
        born date,
        at_time time,
        created timestamp(3),
        updated timestamptz,
        span interval,
        doc jsonb,
        raw json,
        data bytea,
        uid uuid,
        tags text[],
        feeling mood,
        note text DEFAULT 'none',
        total numeric GENERATED ALWAYS AS (price * qty) STORED,
        PRIMARY KEY (region, id)
      )`,
      `CREATE TABLE loose (a integer, b varchar(10), r real, j json)`,
      `CREATE TABLE customers (id bigint PRIMARY KEY, full_name varchar(100), email varchar(100))`,
      `CREATE TABLE orders (id serial PRIMARY KEY, customer_id bigint REFERENCES customers (id), note text DEFAULT 'n/a')`,
    ];
  }
  return [
    `CREATE TABLE items (
      region varchar(20) NOT NULL,
      id bigint unsigned NOT NULL,
      name varchar(50),
      qty int NOT NULL DEFAULT 0,
      price decimal(10,2),
      ratio float,
      active tinyint(1),
      born date,
      at_time time,
      created datetime(3),
      updated timestamp NULL,
      doc json,
      data varbinary(64),
      feeling enum('sad','ok','happy'),
      flags set('a','b','c'),
      note varchar(20) DEFAULT 'none',
      total decimal(20,2) GENERATED ALWAYS AS (price * qty) VIRTUAL,
      PRIMARY KEY (region, id)
    )`,
    `CREATE TABLE loose (a int, b varchar(10), r float, j json)`,
    `CREATE TABLE customers (id bigint PRIMARY KEY, full_name varchar(100), email varchar(100))`,
    `CREATE TABLE orders (
      id int AUTO_INCREMENT PRIMARY KEY,
      customer_id bigint,
      note varchar(20) DEFAULT 'n/a',
      FOREIGN KEY (customer_id) REFERENCES customers (id)
    )`,
  ];
}

const NAMES = ['alpha', 'Beta', 'beta', null, '', 'gamma', 'delta', 'Alpha', 'epsilon', null];
const RATIOS = [0.1, 0.25, 0.5, 0.1, null];

/** 60 rows with NULLs, ties and case variants in the sortable columns, and one key past 2^53. */
function seedRows(): CellValue[][] {
  return Array.from({ length: 60 }, (_v, i): CellValue[] => [
    ['eu', 'us', 'ap'][i % 3]!,
    i === 59 ? BIG : i + 1,
    NAMES[i % 10]!,
    i % 7,
    i % 4 === 0 ? null : `${(i * 37) % 100}.${i % 10}5`,
    RATIOS[i % 5]!,
    i % 6 === 0 ? null : `2026-0${1 + (i % 9)}-1${i % 9}`,
  ]);
}

interface BrowseCase {
  readonly label: string;
  readonly sort: SortTerm[];
  readonly filter?: FilterNode;
  readonly rawWhere?: string;
  readonly where: (dialect: SqlDialect) => string;
  readonly order: (dialect: SqlDialect) => string;
}

const BROWSE_CASES: BrowseCase[] = [
  { label: 'key order', sort: [], where: () => '', order: () => 'region, id' },
  {
    label: 'nullable text with a filter',
    sort: [{ column: 'name', direction: 'asc' }],
    filter: condition('qty', '>', 2),
    where: () => 'qty > 2',
    order: () => 'name ASC, region, id',
  },
  {
    label: 'decimal descending, float ascending, case-insensitive contains',
    sort: [
      { column: 'price', direction: 'desc' },
      { column: 'ratio', direction: 'asc' },
    ],
    filter: condition('name', 'contains', 'A'),
    where: (d) => (d === 'postgres' ? "name ILIKE '%a%'" : "name LIKE '%a%'"),
    order: () => 'price DESC, ratio ASC, region, id',
  },
  {
    label: 'explicit NULL placement and an OR group',
    sort: [
      { column: 'born', direction: 'desc', nulls: 'first' },
      { column: 'id', direction: 'desc' },
    ],
    filter: or(condition('born', 'is-null'), condition('born', '>=', '2026-03-01')),
    where: () => "born IS NULL OR born >= '2026-03-01'",
    order: (d) =>
      d === 'postgres'
        ? 'born DESC NULLS FIRST, id DESC, region'
        : 'born IS NULL DESC, born DESC, id DESC, region',
  },
  {
    label: 'raw condition, float descending',
    sort: [{ column: 'ratio', direction: 'desc' }],
    rawWhere: 'id > 10',
    where: () => 'id > 10',
    order: () => 'ratio DESC, region, id',
  },
];

const servers = configuredServers();

if (servers.length === 0) {
  describe.skip('table data on real servers (set QUERYBARA_TEST_*_URL)', () => {
    it('needs a server', () => undefined);
  });
}

for (const server of servers) {
  const dialect = server.engine;

  describe(`table data on ${dialect}`, () => {
    const scratch = new ScratchDatabase(server);
    let session: Session;
    let tables: Map<string, TableDef>;
    let snapshot: SchemaSnapshot;
    let schema: string;

    const ref = (name: string): TableRef =>
      dialect === 'postgres' ? { schema: 'public', name } : { name };
    const columnsOf = (name: string): ColumnInfo[] =>
      describeColumns(tables.get(name)!, { dialect, schema, snapshot });

    beforeAll(async () => {
      session = await scratch.create();
      for (const statement of ddl(dialect)) await query(session, statement);
      const insert =
        dialect === 'postgres'
          ? 'INSERT INTO items (region, id, name, qty, price, ratio, born) VALUES ($1, $2, $3, $4, $5, $6, $7)'
          : 'INSERT INTO items (region, id, name, qty, price, ratio, born) VALUES (?, ?, ?, ?, ?, ?, ?)';
      for (const row of seedRows()) await query(session, insert, row);
      await query(
        session,
        "INSERT INTO customers VALUES (1, 'Annabel Ray', 'annabel@example.com')",
      );
      await query(session, "INSERT INTO customers VALUES (2, 'Bob Stone', 'bob@example.com')");
      await query(session, "INSERT INTO customers VALUES (3, 'Anne Smith', 'anne@example.com')");
      snapshot = await session.introspect();
      schema = snapshot.schemas[0]!.name;
      tables = new Map(snapshot.schemas.flatMap((s) => s.tables).map((t) => [t.name, t]));
    });

    afterAll(async () => {
      await scratch.drop();
    });

    function itemsOptions(
      extra: Partial<BrowseOptions> = {},
    ): Omit<BrowseOptions, 'page' | 'limit'> {
      return {
        dialect,
        table: ref('items'),
        columns: columnsOf('items'),
        identity: rowIdentity(tables.get('items')!),
        select: ['name', 'qty'],
        ...extra,
      };
    }

    const keyText = (q: BrowseQuery, row: readonly CellValue[]): string =>
      q.identityIndexes.map((i) => String(row[i])).join('/');

    async function readForward(
      options: Omit<BrowseOptions, 'page' | 'limit'>,
      limit: number,
    ): Promise<string[]> {
      const keys: string[] = [];
      let page: BrowsePage = { kind: 'first' };
      for (let guard = 0; guard < 200; guard++) {
        const q = buildBrowseQuery({ ...options, page, limit });
        expect(q.paging).toBe('keyset');
        const result = await fetchPage(session, q);
        keys.push(...result.rows.map((row) => keyText(q, row)));
        if (result.complete) break;
        page = pageAfter(q, result.rows.at(-1)!);
      }
      return keys;
    }

    async function readBackward(
      options: Omit<BrowseOptions, 'page' | 'limit'>,
      limit: number,
    ): Promise<string[]> {
      const keys: string[] = [];
      let page: BrowsePage = { kind: 'last' };
      for (let guard = 0; guard < 200; guard++) {
        const q = buildBrowseQuery({ ...options, page, limit });
        const result = await fetchPage(session, q);
        keys.unshift(...result.rows.map((row) => keyText(q, row)));
        if (result.complete) break;
        page = pageBefore(q, result.rows[0]!);
      }
      return keys;
    }

    it('identifies rows by the composite primary key and reads column types from the snapshot', () => {
      expect(rowIdentity(tables.get('items')!)).toMatchObject({
        kind: 'primary-key',
        columns: ['region', 'id'],
      });
      const columns = columnsOf('items');
      const col = (name: string) => columns.find((c) => c.name === name)!;
      expect(col('price')).toMatchObject({ kind: 'decimal', precision: 10, scale: 2 });
      expect(col('feeling').enumValues).toEqual(['sad', 'ok', 'happy']);
      expect(col('doc').kind).toBe('json');
      expect(col('total').generated).toBe(true);
    });

    for (const c of BROWSE_CASES) {
      it(`pages by keyset forward and backward exactly like a direct query: ${c.label}`, async () => {
        const options = itemsOptions({
          sort: c.sort,
          ...(c.filter ? { filter: c.filter } : {}),
          ...(c.rawWhere ? { rawWhere: c.rawWhere } : {}),
        });
        const where = c.where(dialect);
        const direct = await query(
          session,
          `SELECT region, id FROM items${where ? ` WHERE ${where}` : ''} ORDER BY ${c.order(dialect)}`,
        );
        const expected = direct.map((row) => `${String(row[0])}/${String(row[1])}`);
        expect(expected.length).toBeGreaterThan(5);
        expect(await readForward(options, 7)).toEqual(expected);
        expect(await readBackward(options, 5)).toEqual(expected);
        const offset = buildBrowseQuery({
          ...options,
          page: { kind: 'offset', offset: 3 },
          limit: 4,
        });
        const page = await fetchPage(session, offset);
        expect(page.rows.map((row) => keyText(offset, row))).toEqual(expected.slice(3, 7));
        const total = await countRows(session, options);
        expect(total).toBe(expected.length);
      });
    }

    it('estimates row counts with and without a filter', async () => {
      await query(session, dialect === 'postgres' ? 'ANALYZE items' : 'ANALYZE TABLE items');
      const plain = await estimateRows(session, itemsOptions());
      expect(plain).not.toBeNull();
      expect(plain!).toBeGreaterThanOrEqual(0);
      const filtered = await estimateRows(
        session,
        itemsOptions({ filter: condition('qty', '>', 3) }),
      );
      expect(typeof filtered).toBe('number');
    });

    async function loadRows(
      table: string,
      filter: FilterNode,
      identity: RowIdentity,
    ): Promise<ExistingRow[]> {
      const q = buildBrowseQuery({
        dialect,
        table: ref(table),
        columns: columnsOf(table),
        identity,
        filter,
        limit: 100,
        ...(identity.kind === 'all-columns' ? { page: { kind: 'offset', offset: 0 } } : {}),
      });
      const page = await fetchPage(session, q);
      return page.rows.map((row) => {
        const values: Record<string, CellValue> = {};
        q.columns.forEach((name, i) => (values[name] = row[i] ?? null));
        return { key: rowKeyAt(identity, q.columns, row)!, values };
      });
    }

    const parse = (columns: ColumnInfo[], name: string, text: string): EditValue => {
      const result = parseCellInput(
        text,
        columns.find((c) => c.name === name)!,
      );
      if (!result.ok) throw new Error(`${name}: ${result.error}`);
      return result.value;
    };

    it('applies a mixed change set in one transaction, writing NULL, empty text and DEFAULT', async () => {
      const table = tables.get('items')!;
      const identity = rowIdentity(table);
      const columns = columnsOf('items');
      const [r1, r2, r3] = await loadRows(
        'items',
        and(condition('region', '=', 'us'), condition('id', 'in', [2, 5, 8])),
        identity,
      );
      const typed: Record<string, EditValue> =
        dialect === 'postgres'
          ? {
              active: parse(columns, 'active', 'yes'),
              at_time: parse(columns, 'at_time', '9:30'),
              created: parse(columns, 'created', '2026-09-29T14:30:00.125'),
              span: parse(columns, 'span', '1 day 02:00:00'),
              doc: parse(columns, 'doc', '{"k": [1, 2]}'),
              raw: parse(columns, 'raw', '{"raw": true}'),
              data: parse(columns, 'data', '0x010203'),
              uid: parse(columns, 'uid', '123E4567-E89B-12D3-A456-426614174000'),
              tags: parse(columns, 'tags', '["a b", "c"]'),
              feeling: parse(columns, 'feeling', 'ok'),
            }
          : {
              active: parse(columns, 'active', 'true'),
              at_time: parse(columns, 'at_time', '-12:30'),
              created: parse(columns, 'created', '2026-09-29 14:30:00.125'),
              doc: parse(columns, 'doc', '{"k": [1, 2]}'),
              data: parse(columns, 'data', '0x010203'),
              feeling: parse(columns, 'feeling', 'OK'),
              flags: parse(columns, 'flags', 'c,a'),
            };
      const changes = ChangeSet.empty()
        .edit(r1!, 'name', 'edited')
        .edit(r1!.key, 'price', null)
        .edit(r1!.key, 'note', '')
        .edit(r2!, 'qty', DEFAULT)
        .edit(r2!.key, 'name', null)
        .delete(r3!)
        .insert({
          region: 'zz',
          id: parse(columns, 'id', '9007199254740995'),
          name: 'new',
          price: parse(columns, 'price', '9.9'),
          ratio: parse(columns, 'ratio', '0.1'),
          born: parse(columns, 'born', '2026-9-29'),
          ...typed,
        })
        .insert({ region: 'zz', id: 1, name: null, note: null });
      const plan = planChanges(changes, {
        dialect,
        table: ref('items'),
        columns,
        identity,
        returning: session.capabilities().returning,
      });
      expect(plan.previewSql).toContain('DELETE FROM');
      const result = await applyChanges(session, plan);
      expect(result.rows.map((r) => r.kind)).toEqual([
        'delete',
        'update',
        'update',
        'insert',
        'insert',
      ]);

      const read = await query(
        session,
        `SELECT region, id, name, qty, price, note FROM items WHERE region IN ('us', 'zz') AND id IN (2, 5, 8, 1, 9007199254740995) ORDER BY region, id`,
      );
      expect(read.map((row) => row.map((v) => (typeof v === 'bigint' ? v.toString() : v)))).toEqual(
        [
          ['us', 2, 'edited', 1, null, ''],
          ['us', 5, null, 0, null, 'none'],
          ['zz', 1, null, 0, null, null],
          ['zz', '9007199254740995', 'new', 0, '9.90', 'none'],
        ],
      );

      // Rows come back as written, server defaults included, keyed by their identity.
      const inserted = result.rows[3]!;
      expect(inserted.newKey).toBe(rowKeyAt(identity, ['region', 'id'], ['zz', 9007199254740995n]));
      const row = new Map(plan.columns.map((name, i) => [name, inserted.row![i]]));
      expect(row.get('note')).toBe('none');
      expect(row.get('qty')).toBe(0);
      for (const [name, value] of Object.entries(typed)) {
        expect(
          sameValue(row.get(name) as EditValue, value),
          `${name}: ${String(row.get(name))}`,
        ).toBe(true);
      }
      expect(row.get('total')).toBe('0.00');
      const updated = result.rows[1]!;
      expect(updated.row![plan.columns.indexOf('name')]).toBe('edited');
    });

    it('rolls back everything with CONFLICT when another session changed a row', async () => {
      const identity = rowIdentity(tables.get('items')!);
      const columns = columnsOf('items');
      const [a, b, c] = await loadRows(
        'items',
        and(condition('region', '=', 'ap'), condition('id', 'in', [3, 6, 9])),
        identity,
      );
      const other = await scratch.connect();
      await query(other, "UPDATE items SET name = 'theirs' WHERE region = 'ap' AND id = 6");
      const changes = ChangeSet.empty().edit(a!, 'name', 'mine').edit(b!, 'name', 'mine');
      const plan = planChanges(changes, { dialect, table: ref('items'), columns, identity });
      const error = await applyChanges(session, plan).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QuerybaraError);
      expect((error as QuerybaraError).code).toBe('CONFLICT');
      expect((error as QuerybaraError).message).toContain("region = 'ap', id = 6");
      expect(session.inTransaction).toBe(false);
      const names = await query(
        session,
        "SELECT id, name FROM items WHERE region = 'ap' AND id IN (3, 6) ORDER BY id",
      );
      expect(names.map((r) => r[1])).toEqual([a!.values['name'], 'theirs']);

      await query(other, "DELETE FROM items WHERE region = 'ap' AND id = 9");
      const gone = planChanges(ChangeSet.empty().delete(c!), {
        dialect,
        table: ref('items'),
        columns,
        identity,
      });
      await expect(applyChanges(session, gone)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('does not report a conflict for an UPDATE that stores the value already there', async () => {
      const identity = rowIdentity(tables.get('items')!);
      const [row] = await loadRows(
        'items',
        and(condition('region', '=', 'eu'), condition('id', '=', 1)),
        identity,
      );
      expect(row!.values['qty']).toBe(0);
      const plan = planChanges(ChangeSet.empty().edit(row!, 'qty', DEFAULT), {
        dialect,
        table: ref('items'),
        columns: columnsOf('items'),
        identity,
      });
      const result = await applyChanges(session, plan);
      expect(result.rows[0]!.newKey).toBe(row!.key);
    });

    it('edits a table without a key through the all-columns identity', async () => {
      const table = tables.get('loose')!;
      expect(rowIdentity(table).kind).toBe('none');
      const identity = allColumnsIdentity(table, { dialect });
      expect(identity.warning).toMatch(/r: floating-point/);
      await query(
        session,
        `INSERT INTO loose (a, b, r, j) VALUES (1, 'x', 0.1, '{"a": 1}'), (1, 'x', 0.1, '{"a": 1}'), (2, 'Y', NULL, NULL), (2, 'y', NULL, NULL)`,
      );
      const rows = await loadRows('loose', condition('a', 'is-not-null'), identity);
      const duplicate = rows.find((r) => r.values['a'] === 1)!;
      const lower = rows.find((r) => r.values['b'] === 'y')!;
      const columns = columnsOf('loose');
      const plan = planChanges(ChangeSet.empty().edit(duplicate, 'b', 'z').delete(lower), {
        dialect,
        table: ref('loose'),
        columns,
        identity,
        returning: session.capabilities().returning,
      });
      const result = await applyChanges(session, plan);
      expect(result.rows[1]!.row).not.toBeNull();
      const after = await query(session, 'SELECT a, b FROM loose ORDER BY a, b');
      expect(after.map((r) => `${String(r[0])}${String(r[1])}`).sort()).toEqual(['1x', '1z', '2Y']);
    });

    it('reads generated keys back and fills DEFAULT columns on insert', async () => {
      const table = tables.get('orders')!;
      const identity = rowIdentity(table);
      const columns = columnsOf('orders');
      expect(columns[0]!.autoIncrement).toBe(true);
      const plan = planChanges(
        ChangeSet.empty().insert({ customer_id: 2 }).insert({ customer_id: null, note: DEFAULT }),
        {
          dialect,
          table: ref('orders'),
          columns,
          identity,
          returning: session.capabilities().returning,
        },
      );
      const result = await applyChanges(session, plan);
      const [first, second] = result.rows;
      expect(first!.row).toEqual([1, 2, 'n/a']);
      expect(second!.row).toEqual([2, null, 'n/a']);
      expect(first!.newKey).toBe(rowKeyAt(identity, ['id'], [1]));
    });

    it('opens referenced rows and lists lookup options for foreign keys', async () => {
      const fk = tables.get('orders')!.foreignKeys[0]!;
      const referencedColumns = columnsOf('customers');
      const lookup = buildLookupQuery(fk, { dialect, schema, referencedColumns, search: 'ANN' });
      expect(lookup.labelColumn).toBe('full_name');
      const options = await query(session, lookup.sql, lookup.params);
      expect(options).toEqual([
        [1, 'Annabel Ray'],
        [3, 'Anne Smith'],
      ]);
      const byKey = buildLookupQuery(fk, { dialect, schema, referencedColumns, search: '2' });
      expect(await query(session, byKey.sql, byKey.params)).toEqual([[2, 'Bob Stone']]);
      const referenced = buildReferencedRowQuery(fk, [2], { dialect, schema, referencedColumns })!;
      expect(await query(session, referenced.sql, referenced.params)).toEqual([
        [2, 'Bob Stone', 'bob@example.com'],
      ]);
      const filtered = buildBrowseQuery({
        dialect,
        table: referenced.table,
        columns: referencedColumns,
        identity: rowIdentity(tables.get('customers')!),
        filter: referenced.filter,
        limit: 10,
      });
      expect((await fetchPage(session, filtered)).rows).toEqual([
        [2, 'Bob Stone', 'bob@example.com'],
      ]);
    });
  });
}
