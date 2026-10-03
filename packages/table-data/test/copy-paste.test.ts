import type { CellValue } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ChangeSet,
  DEFAULT,
  copyRows,
  mapPastedRows,
  parsePastedText,
  pasteIntoChangeSet,
  rowIdentity,
  rowKeyOf,
  type ColumnInfo,
  type ExistingRow,
} from '../src';
import { itemsFor } from './fixtures';

const pg = itemsFor('postgres');
const my = itemsFor('mysql');
const pick = (columns: readonly ColumnInfo[], ...names: string[]) =>
  names.map((n) => columns.find((c) => c.name === n)!);

const rows: CellValue[][] = [
  ['eu', 1, 'plain', '1.50', true, '{"a": [1]}', new Uint8Array([0xab])],
  ['eu', 9007199254740993n, 'tab\there "quoted",\nnew line|pipe', null, false, null, null],
];
const cols = pick(pg.columns, 'region', 'id', 'name', 'price', 'active', 'doc', 'data');

describe('copyRows', () => {
  it('writes TSV the way spreadsheets paste it', () => {
    expect(copyRows(rows, cols, 'tsv')).toBe(
      'eu\t1\tplain\t1.50\ttrue\t{"a": [1]}\t0xab\n' +
        'eu\t9007199254740993\t"tab\there ""quoted"",\nnew line|pipe"\t\tfalse\t\t',
    );
    expect(
      copyRows(rows.slice(0, 1), cols.slice(0, 2), 'tsv', { header: true, nullText: 'NULL' }),
    ).toBe('region\tid\neu\t1');
  });

  it('writes RFC 4180 CSV with a header and CRLF line breaks', () => {
    expect(copyRows(rows, cols, 'csv', { nullText: 'NULL' })).toBe(
      'region,id,name,price,active,doc,data\r\n' +
        'eu,1,plain,1.50,true,"{""a"": [1]}",0xab\r\n' +
        'eu,9007199254740993,"tab\there ""quoted"",\nnew line|pipe",NULL,false,NULL,NULL',
    );
  });

  it('writes JSON with exact numbers and embedded documents', () => {
    expect(copyRows(rows, cols, 'json')).toBe(
      [
        '[',
        '  {',
        '    "region": "eu",',
        '    "id": 1,',
        '    "name": "plain",',
        '    "price": 1.50,',
        '    "active": true,',
        '    "doc": {"a": [1]},',
        '    "data": "0xab"',
        '  },',
        '  {',
        '    "region": "eu",',
        '    "id": 9007199254740993,',
        '    "name": "tab\\there \\"quoted\\",\\nnew line|pipe",',
        '    "price": null,',
        '    "active": false,',
        '    "doc": null,',
        '    "data": null',
        '  }',
        ']',
      ].join('\n'),
    );
    expect(copyRows([], cols, 'json')).toBe('[]');
    expect(copyRows([[DEFAULT, 1]], cols.slice(0, 2), 'json')).toBe('[\n  {\n    "id": 1\n  }\n]');
  });

  it('writes a Markdown table', () => {
    expect(
      copyRows(
        rows.map((r) => r.slice(1, 4)),
        cols.slice(1, 4),
        'markdown',
      ),
    ).toBe(
      [
        '| id | name | price |',
        '| ---: | --- | ---: |',
        '| 1 | plain | 1.50 |',
        '| 9007199254740993 | tab\there "quoted",<br>new line\\|pipe | NULL |',
      ].join('\n'),
    );
  });

  it('writes INSERT statements, leaving out generated columns', () => {
    const columns = pick(my.columns, 'region', 'id', 'name', 'data', 'total');
    expect(
      copyRows(
        [
          ['eu', 1, "it's", new Uint8Array([1, 2]), '3.00'],
          ['eu', 2, DEFAULT, null, null],
        ],
        columns,
        'insert',
        { dialect: 'mysql', table: { name: 'items' } },
      ),
    ).toBe(
      "INSERT INTO `items` (`region`, `id`, `name`, `data`) VALUES ('eu', 1, 'it''s', X'0102');\n" +
        "INSERT INTO `items` (`region`, `id`, `name`, `data`) VALUES ('eu', 2, DEFAULT, NULL);",
    );
    expect(
      copyRows(
        [[1, true, new Uint8Array([255])]],
        pick(pg.columns, 'id', 'active', 'data'),
        'insert',
        {
          dialect: 'postgres',
          table: { schema: 'app', name: 'items' },
        },
      ),
    ).toBe(`INSERT INTO "app"."items" ("id", "active", "data") VALUES (1, TRUE, '\\xff'::bytea);`);
    expect(() => copyRows(rows, cols, 'insert')).toThrow(/needs the dialect and the table/);
  });

  it('writes UPDATE statements keyed by the identity', () => {
    const identity = rowIdentity(pg.table);
    const columns = pick(pg.columns, 'id', 'region', 'name', 'price', 'total');
    expect(
      copyRows([[5, 'eu', 'x', null, '1']], columns, 'update', {
        dialect: 'postgres',
        table: { name: 'items' },
        identity,
      }),
    ).toBe(`UPDATE "items" SET "name" = 'x', "price" = NULL WHERE "region" = 'eu' AND "id" = 5;`);
    expect(() =>
      copyRows([[5, 'x']], pick(pg.columns, 'id', 'name'), 'update', {
        dialect: 'postgres',
        table: { name: 'items' },
        identity,
      }),
    ).toThrow(/needs the key column region/);
    expect(() =>
      copyRows([['eu', 5]], pick(pg.columns, 'region', 'id'), 'update', {
        dialect: 'postgres',
        table: { name: 'items' },
        identity,
      }),
    ).toThrow(/at least one column besides the key/);
    expect(
      copyRows([[1, 'a']], pick(my.columns, 'qty', 'name'), 'update', {
        dialect: 'mysql',
        table: { name: 'items' },
        identity: { kind: 'all-columns', columns: ['qty', 'price'] },
      }),
    ).toBe("UPDATE `items` SET `name` = 'a' WHERE `qty` = 1 LIMIT 1;");
  });
});

describe('parsePastedText', () => {
  it('reads Excel and Google Sheets clipboard TSV', () => {
    expect(parsePastedText('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parsePastedText('"multi\nline"\t"with ""quotes"""\n"tab\there"\tx')).toEqual([
      ['multi\nline', 'with "quotes"'],
      ['tab\there', 'x'],
    ]);
    expect(parsePastedText('a\t\tc\n\t\n')).toEqual([
      ['a', '', 'c'],
      ['', ''],
    ]);
    expect(parsePastedText('5" pipe\t"unterminated\nx')).toEqual([
      ['5" pipe', '"unterminated'],
      ['x'],
    ]);
    expect(parsePastedText('"not" quoted\ty')).toEqual([['"not" quoted', 'y']]);
    expect(parsePastedText('a\rb')).toEqual([['a'], ['b']]);
    expect(parsePastedText('single')).toEqual([['single']]);
    expect(parsePastedText('')).toEqual([]);
  });

  it('round-trips copied TSV', () => {
    const cell = fc.oneof(
      fc.string(),
      fc.constantFrom('', '"', '""', '\t', '\n', '\r\n', 'a"b', '"lead', 'x\ty\nz'),
    );
    const matrix = fc
      .array(fc.array(cell, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 })
      .filter((m) => !(m.at(-1)!.length === 1 && m.at(-1)![0] === ''));
    fc.assert(
      fc.property(matrix, (m) => {
        const width = Math.max(...m.map((r) => r.length));
        const columns = Array.from({ length: width }, (_v, i) => ({
          ...pick(pg.columns, 'name')[0]!,
          name: `c${i}`,
        }));
        const text = copyRows(m, columns.slice(0, width), 'tsv');
        const padded = m.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
        expect(parsePastedText(text)).toEqual(padded);
      }),
      { numRuns: 500 },
    );
  });
});

describe('mapPastedRows and pasteIntoChangeSet', () => {
  const columns = pick(pg.columns, 'region', 'id', 'name', 'qty', 'price');

  it('parses each cell for its column, with per-cell errors and overflow', () => {
    const mapped = mapPastedRows(
      [
        ['7', 'x', '3', '1.5', 'extra'],
        ['nope', '', 'NULL', '1.234'],
      ],
      columns,
      1,
      { nullText: 'NULL' },
    );
    expect(mapped.errors).toBe(3);
    expect(mapped.overflow).toBe(1);
    expect(mapped.rows[0]).toEqual([
      { column: 'id', text: '7', value: 7 },
      { column: 'name', text: 'x', value: 'x' },
      { column: 'qty', text: '3', value: 3 },
      { column: 'price', text: '1.5', value: '1.50' },
    ]);
    expect(mapped.rows[1]!.map((c) => c.error ?? c.value)).toEqual([
      'Expected a whole number',
      '',
      'The column cannot be NULL',
      'At most 2 digits after the decimal point',
    ]);
  });

  it('edits target rows, inserts the rest, and skips errors and deleted rows', () => {
    const identity = rowIdentity(pg.table);
    const loaded = (id: number): ExistingRow => {
      const values = { region: 'eu', id, name: 'n', qty: 1 };
      return { key: rowKeyOf(identity, values)!, values };
    };
    const [r1, r2] = [loaded(1), loaded(2)];
    const base = ChangeSet.empty().delete(r2);
    const pasted = mapPastedRows(
      [
        ['a', '5'],
        ['b', '6'],
        ['c', 'x'],
      ],
      columns,
      2,
    );
    const result = pasteIntoChangeSet(base, pasted, { rows: [r1, r2] });
    expect(result.inserted).toEqual(['+1']);
    expect(result.skipped).toBe(3);
    expect(result.changes.staged(r1.key, 'name')).toBe('a');
    expect(result.changes.staged(r1.key, 'qty')).toBe(5);
    expect(result.changes.status(r2.key)).toBe('deleted');
    expect([...result.changes.insertedRows()[0]!.values]).toEqual([['name', 'c']]);
    const noInsert = pasteIntoChangeSet(ChangeSet.empty(), pasted, {
      rows: [r1],
      insertRemaining: false,
    });
    expect(noInsert.inserted).toEqual([]);
    expect(noInsert.skipped).toBe(4);
  });
});
