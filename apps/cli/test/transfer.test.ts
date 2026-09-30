import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { JoineryError, schemaSnapshotSchema, type CellValue } from '@joinery/core';
import { InvalidArgumentError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  XlsxWorkbookWriter,
  ZipReader,
  fileSource,
  memorySink,
  openFileReader,
  readRows,
} from '@joinery/transfer';

import { describeRowError, exportFileName } from '../src/commands/transfer';
import { columnMap, delimiter } from '../src/options';
import { exportOptions, importOptions } from '../src/program';
import {
  FakeSession,
  ScriptedPrompter,
  column,
  memoryInput,
  run,
  tempDir,
  type FakeResult,
} from './helpers';

/**
 * `joinery import`, `export` and `run-file` in-process against a fake session: option parsing
 * and validation, the write rules, progress-free summaries on stderr, data on stdout for
 * `--out -`, and the exit codes (0 done, 1 rows skipped or statements failed, 2 failed).
 */

const URI = 'postgres://app:pw@h/db';
let dir = '';
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});

afterEach(() => cleanup());

const PEOPLE = schemaSnapshotSchema.parse({
  engine: 'postgres',
  database: 'db',
  capturedAt: '2026-09-29T10:00:00.000Z',
  schemas: [
    {
      name: 'public',
      tables: [
        {
          name: 'people',
          columns: [
            { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
            { name: 'full_name', ordinal: 2, dataType: 'text', nullable: true },
          ],
          primaryKey: { name: 'people_pkey', columns: ['id'] },
        },
      ],
    },
  ],
});

/** A session that knows `public.people` and answers statements like a server. */
function session(respond: (text: string) => FakeResult | undefined = () => undefined) {
  const s = new FakeSession('postgres', (text) => {
    const custom = respond(text);
    if (custom) return custom;
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      s.inTransaction = text === 'BEGIN';
    }
    if (text === 'SELECT current_schema()') {
      return { columns: [column('current_schema')], rows: [['public']] };
    }
    if (/^\s*select/i.test(text)) {
      return {
        columns: [column('id', 'integer'), column('full_name')],
        rows: [
          [1, 'Ada'],
          [2, 'Hopper, Grace'],
          [3, null],
        ],
      };
    }
    const command = text.trim().split(/\s+/)[0]!.toUpperCase();
    return { command, rowsAffected: null };
  });
  s.snapshot = PEOPLE;
  return s;
}

function inserted(s: FakeSession): CellValue[] {
  return s.executed
    .filter((e) => e.text.startsWith('INSERT'))
    .flatMap((e) => (Array.isArray(e.params) ? (e.params as CellValue[]) : []));
}

describe('option parsing', () => {
  it('parses --map and --delimiter', () => {
    expect(columnMap('Full Name=full_name')).toEqual(['Full Name', 'full_name']);
    expect(columnMap(' a = b ')).toEqual(['a', 'b']);
    expect(() => columnMap('novalue')).toThrow(InvalidArgumentError);
    expect(() => columnMap('=x')).toThrow(InvalidArgumentError);
    expect(delimiter('tab')).toBe('\t');
    expect(delimiter('\\t')).toBe('\t');
    expect(delimiter('Semicolon')).toBe(';');
    expect(delimiter('|')).toBe('|');
    expect(() => delimiter(';;')).toThrow(InvalidArgumentError);
  });

  it('turns the flags into command options', () => {
    expect(
      importOptions({
        table: 'people',
        file: 'p.csv',
        header: false,
        mode: 'upsert',
        key: ['id'],
        transaction: 'per-batch',
        onError: 'skip',
        map: [['a', 'b']],
        null: '\\N',
        delimiter: ';',
        batchSize: 50,
        disableFkChecks: true,
        yes: true,
        database: 'shop',
      }),
    ).toEqual({
      table: 'people',
      file: 'p.csv',
      header: false,
      mode: 'upsert',
      create: false,
      onError: 'skip',
      transaction: 'per-batch',
      disableForeignKeyChecks: true,
      map: [['a', 'b']],
      yes: true,
      delimiter: ';',
      nullMarker: '\\N',
      key: ['id'],
      batchSize: 50,
      database: 'shop',
    });
    expect(
      exportOptions({
        table: ['a', 'b'],
        format: 'sql',
        out: 'x.sql',
        header: true,
        oneFile: true,
      }),
    ).toMatchObject({
      tables: ['a', 'b'],
      oneFile: true,
      gzip: false,
      header: true,
      yes: false,
    });
  });

  it.each([
    [['import', URI, '--file', 'x.csv'], "required option '--table <name>' not specified"],
    [['import', URI, '--table', 't'], "required option '--file <path>' not specified"],
    [
      ['import', URI, '--table', 't', '--file', 'x', '--mode', 'merge'],
      "argument 'merge' is invalid",
    ],
    [
      ['import', URI, '--table', 't', '--file', 'x', '--map', 'novalue'],
      'Use file_column=table_column',
    ],
    [['import', URI, '--table', 't', '--file', 'x', '--delimiter', 'ab'], 'Use one character'],
    [
      ['export', URI, '--table', 't', '--out', 'x'],
      "required option '--format <format>' not specified",
    ],
    [['export', URI, '--table', 't', '--format', 'pdf', '--out', 'x'], "argument 'pdf' is invalid"],
    [
      ['import', URI, '--table', 't', '--file', 'x', '--header-row', '-1'],
      'Expected a whole number',
    ],
    [['run-file', URI], "missing required argument 'file'"],
  ])('%j exits 2', async (argv, message) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('lists the commands in the help', async () => {
    const result = await run(['--help']);
    for (const command of ['import', 'export', 'run-file']) {
      expect(result.stdout).toContain(`${command} `);
    }
    const help = await run(['import', '--help']);
    expect(help.stdout).toContain('--map <file=column>');
    expect(help.stdout).toContain('Exit codes: 0 imported, 1 imported but rows were skipped');
    expect(help.stdout).toContain('--ssh <user@host[:port]>');
  });
});

describe('import', () => {
  it('matches columns by name and loads the file in one transaction', async () => {
    const s = session();
    writeFileSync(join(dir, 'people.csv'), 'ID,Full Name,ignored\n1,Ada,x\n2,"Hopper, Grace",y\n');
    const result = await run(['import', URI, '--table', 'people', '--file', 'people.csv'], {
      session: s,
      cwd: dir,
    });
    expect(result.stderr).toContain('warning: Not imported (no matching column): ignored');
    expect(result.stderr).toContain('Imported 2 rows into public.people');
    expect(result.code).toBe(0);
    expect(inserted(s)).toEqual([1, 'Ada', 2, 'Hopper, Grace']);
    const texts = s.executed.map((e) => e.text);
    const begin = texts.indexOf('BEGIN');
    const insert = texts.findIndex((text) => text.startsWith('INSERT INTO "public"."people"'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(begin);
    expect(texts.indexOf('COMMIT')).toBeGreaterThan(insert);
    expect(result.stdout).toBe('');
    expect(s.closed).toBe(true);
  });

  it('reads rows from stdin, with --map, and exits 1 when rows were skipped', async () => {
    const s = session();
    const result = await run(
      [
        'import',
        URI,
        '--table',
        'public.people',
        '--file',
        '-',
        '--map',
        'n=id',
        '--map',
        'who=full_name',
        '--on-error',
        'skip',
        '--delimiter',
        ';',
      ],
      { session: s, stdin: memoryInput(['n;who\n1;Ada\n', 'x;Bad\n3;Linus\n'], false) },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'skipped: row 2 (line 3), column id: id: "x" is not an integer',
    );
    expect(result.stderr).toContain('Imported 2 rows into public.people');
    expect(result.stderr).toContain('1 row skipped');
    expect(inserted(s)).toEqual([1, 'Ada', 3, 'Linus']);
  });

  it('stops at a failing row, rolls back and exits 2', async () => {
    const s = session((text) =>
      text.startsWith('INSERT')
        ? { error: new JoineryError({ code: 'SQL_ERROR', message: 'duplicate key' }) }
        : undefined,
    );
    writeFileSync(join(dir, 'p.csv'), 'id,full_name\n1,Ada\n');
    const result = await run(['import', URI, '--table', 'people', '--file', 'p.csv'], {
      session: s,
      cwd: dir,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('error: row 1 (line 2): duplicate key');
    expect(result.stderr).toContain('nothing was kept');
    expect(s.executed.map((e) => e.text)).toContain('ROLLBACK');
  });

  it('creates the table from the file with --create', async () => {
    const s = session();
    writeFileSync(join(dir, 'codes.csv'), 'code,price\nA,1.50\nB,2.25\n');
    const result = await run(
      ['import', URI, '--table', 'codes', '--file', 'codes.csv', '--create', '--key', 'code'],
      { session: s, cwd: dir },
    );
    expect(result.code).toBe(0);
    const create = s.executed.find((e) => e.text.startsWith('CREATE TABLE'))?.text;
    expect(create).toContain('"public"."codes"');
    expect(create).toContain('"price" numeric(3,2)');
    expect(create).toContain('PRIMARY KEY ("code")');
    expect(result.stderr).toContain('Created table public.codes');
  });

  it('refuses a read-only run and asks before replacing', async () => {
    writeFileSync(join(dir, 'p.csv'), 'id,full_name\n1,Ada\n');
    const s = session();
    const readOnly = await run(
      ['import', URI, '--table', 'people', '--file', 'p.csv', '--read-only'],
      { session: s, cwd: dir },
    );
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('is read-only, so nothing was imported');
    expect(s.executed.some((e) => e.text.startsWith('INSERT'))).toBe(false);

    const replace = await run(
      ['import', URI, '--table', 'people', '--file', 'p.csv', '--mode', 'replace'],
      { session: session(), cwd: dir },
    );
    expect(replace.code).toBe(2);
    expect(replace.stderr).toContain('Replace empties public.people before importing');
    expect(replace.stderr).toContain('--yes');

    const asked = new ScriptedPrompter(true, { confirm: ['yes'] });
    const confirmed = session();
    const ok = await run(
      ['import', URI, '--table', 'people', '--file', 'p.csv', '--mode', 'replace'],
      { session: confirmed, cwd: dir, prompter: asked },
    );
    expect(ok.code).toBe(0);
    expect(asked.asked).toEqual(['Replace empties public.people before importing. Continue?']);
    expect(confirmed.executed.map((e) => e.text)).toContain('TRUNCATE TABLE "public"."people"');
  });
});

describe('export', () => {
  it('writes CSV to stdout and a summary to stderr', async () => {
    const s = session();
    const result = await run(
      ['export', URI, '--table', 'people', '--format', 'csv', '--out', '-', '--null', 'NULL'],
      { session: s },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('id,full_name\r\n1,Ada\r\n2,"Hopper, Grace"\r\n3,NULL\r\n');
    expect(result.stderr).toContain('Exported 3 rows to stdout');
    expect(s.executed.map((e) => e.text)).toContain('SELECT * FROM "public"."people"');
  });

  it('writes a query result to a file, and several tables one file each', async () => {
    const s = session();
    const one = await run(
      ['export', URI, '--query', 'select 1', '--format', 'jsonl', '--out', 'out.jsonl'],
      { session: s, cwd: dir },
    );
    expect(one.code).toBe(0);
    expect(readFileSync(join(dir, 'out.jsonl'), 'utf8')).toBe(
      '{"id":1,"full_name":"Ada"}\n{"id":2,"full_name":"Hopper, Grace"}\n{"id":3,"full_name":null}\n',
    );
    const many = await run(
      ['export', URI, '--table', 'a', '--table', 'b', '--format', 'tsv', '--out', 'tables'],
      { session: session(), cwd: dir },
    );
    expect(many.code).toBe(0);
    expect(many.stderr).toContain('to 2 files in tables');
    expect(readFileSync(join(dir, 'tables', 'b.tsv'), 'utf8')).toBe(
      'id\tfull_name\r\n1\tAda\r\n2\tHopper, Grace\r\n3\t\r\n',
    );
  });

  it('applies the safety check to a --query, which runs as given', async () => {
    const s = session();
    const refused = await run(
      ['export', URI, '--query', 'delete from people returning *', '--format', 'csv', '--out', '-'],
      { session: s },
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('DELETE without WHERE removes every row');
    expect(s.executed.some((e) => e.text.startsWith('delete'))).toBe(false);
  });

  it('refuses combinations that cannot work', async () => {
    for (const [argv, message] of [
      [['--table', 'a', '--query', 'select 1', '--format', 'csv', '--out', 'x'], 'not both'],
      [['--query', 'select 1', '--format', 'sql-ddl', '--out', 'x'], 'exports tables'],
      [
        ['--table', 'a', '--table', 'b', '--format', 'csv', '--one-file', '--out', 'x'],
        'every format but csv, tsv and jsonl',
      ],
      [['--table', 'a', '--format', 'xlsx', '--out', '-'], 'An Excel workbook writes a file'],
      [['--table', 'a', '--format', 'csv', '--zip', '--out', '-'], '--zip writes a file'],
      [['--table', 'a', '--format', 'csv', '--zip', '--gzip', '--out', 'x'], 'not both'],
      [
        ['--table', 'a', '--table', 'b', '--format', 'csv', '--zip', '--one-file', '--out', 'x'],
        'leave out --one-file',
      ],
      [['--table', 'a', '--table', 'b', '--format', 'csv', '--out', '-'], 'need a folder'],
      [['--table', 'a', '--format', 'csv', '--gzip', '--out', '-'], '--gzip writes a file'],
    ] as const) {
      const result = await run(['export', URI, ...argv]);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });
});

/** A workbook with a title row above the header, on its second worksheet. */
async function workbook(): Promise<Buffer> {
  const sink = memorySink();
  const book = new XlsxWorkbookWriter(sink);
  const cover = book.sheet('Cover', { header: false });
  cover.begin([{ name: 'x', nativeType: 'text', kind: 'string' }]);
  await cover.page([['nothing here']], 1);
  await cover.end();
  const data = book.sheet('People', { header: false });
  data.begin([
    { name: 'a', nativeType: 'text', kind: 'string' },
    { name: 'b', nativeType: 'text', kind: 'string' },
  ]);
  await data.page(
    [
      ['Staff list', 'ID', '1', '2'],
      [null, 'Full Name', 'Ada', 'Grace'],
    ],
    4,
  );
  await data.end();
  await book.close();
  return Buffer.from(sink.bytes());
}

describe('Excel, XML and ZIP', () => {
  it('imports a worksheet by name and header row, from a file or from stdin', async () => {
    const book = await workbook();
    writeFileSync(join(dir, 'people.xlsx'), book);
    const argv = ['import', URI, '--table', 'people', '--sheet', 'People', '--header-row', '2'];
    const s = session();
    const fromFile = await run([...argv, '--file', 'people.xlsx'], { session: s, cwd: dir });
    expect(fromFile.stderr).toContain('Imported 2 rows into public.people');
    expect(fromFile.code).toBe(0);
    expect(inserted(s)).toEqual([1, 'Ada', 2, 'Grace']);

    const piped = session();
    const fromStdin = await run([...argv, '--file', '-'], {
      session: piped,
      stdin: memoryInput([book.subarray(0, 100), book.subarray(100)], false),
    });
    expect(fromStdin.code).toBe(0);
    expect(inserted(piped)).toEqual([1, 'Ada', 2, 'Grace']);
  });

  it('imports the XML rows at --row-path', async () => {
    writeFileSync(
      join(dir, 'people.xml'),
      '<export><table name="people"><row><id>7</id><full_name>Linus</full_name></row></table><meta><id>0</id></meta></export>',
    );
    const s = session();
    const result = await run(
      [
        'import',
        URI,
        '--table',
        'people',
        '--file',
        'people.xml',
        '--row-path',
        '/export/table/row',
      ],
      { session: s, cwd: dir },
    );
    expect(result.code).toBe(0);
    expect(inserted(s)).toEqual([7, 'Linus']);
  });

  it('exports Excel, XML, HTML and Markdown; several tables combined or zipped', async () => {
    const xlsx = await run(
      ['export', URI, '--table', 'people', '--format', 'xlsx', '--out', 'people.xlsx'],
      { session: session(), cwd: dir },
    );
    expect(xlsx.code).toBe(0);
    const rows: unknown[] = [];
    for await (const batch of readRows(fileSource(join(dir, 'people.xlsx')), { format: 'xlsx' })) {
      rows.push(...batch.rows);
    }
    expect(rows).toEqual([
      [1, 'Ada'],
      [2, 'Hopper, Grace'],
      [3, null],
    ]);

    const markdown = await run(
      ['export', URI, '--table', 'people', '--format', 'markdown', '--out', '-'],
      { session: session() },
    );
    expect(markdown.stdout).toBe(
      '| id | full_name |\n| ---: | --- |\n| 1 | Ada |\n| 2 | Hopper, Grace |\n| 3 | NULL |\n',
    );
    const xml = await run(['export', URI, '--query', 'select 1', '--format', 'xml', '--out', '-'], {
      session: session(),
    });
    expect(xml.stdout).toContain('<table name="query_result">');
    expect(xml.stdout).toContain('<full_name xsi:nil="true"/>');

    const html = await run(
      [
        'export',
        URI,
        '--table',
        'a',
        '--table',
        'b',
        '--format',
        'html',
        '--one-file',
        '--out',
        'ab.html',
      ],
      { session: session(), cwd: dir },
    );
    expect(html.code).toBe(0);
    expect(readFileSync(join(dir, 'ab.html'), 'utf8')).toContain('<h2>b</h2>');

    const zipped = await run(
      [
        'export',
        URI,
        '--table',
        'a',
        '--table',
        'b',
        '--format',
        'csv',
        '--zip',
        '--out',
        'ab.zip',
      ],
      { session: session(), cwd: dir },
    );
    expect(zipped.code).toBe(0);
    expect(zipped.stderr).toContain('from 2 tables to ab.zip');
    const zip = await ZipReader.open(await openFileReader(join(dir, 'ab.zip')));
    expect(zip.entries.map((entry) => entry.name)).toEqual(['a.csv', 'b.csv']);
    await zip.close();

    const query = await run(
      ['export', URI, '--query', 'select 1', '--format', 'json', '--zip', '--out', 'q.zip'],
      { session: session(), cwd: dir },
    );
    expect(query.code).toBe(0);
    const single = await ZipReader.open(await openFileReader(join(dir, 'q.zip')));
    expect(single.entries.map((entry) => entry.name)).toEqual(['query_result.json']);
    await single.close();
  });
});

describe('run-file', () => {
  const failing = () =>
    session((text) =>
      text.includes('missing')
        ? {
            error: new JoineryError({
              code: 'SQL_ERROR',
              message: 'relation "missing" does not exist',
            }),
          }
        : undefined,
    );

  it('continues past a failed statement and exits 1, or stops and exits 2', async () => {
    writeFileSync(
      join(dir, 's.sql'),
      'CREATE TABLE a (x int);\nINSERT INTO missing VALUES (1);\nINSERT INTO a VALUES (2);\n',
    );
    const s = failing();
    const result = await run(['run-file', URI, 's.sql', '--continue', '--error-log', 'e.log'], {
      session: s,
      cwd: dir,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error: relation "missing" does not exist');
    expect(result.stderr).toContain('at statement 2 (s.sql:2:1)');
    expect(result.stderr).toContain('Ran 3 statements');
    expect(result.stderr).toContain('1 failed');
    expect(readFileSync(join(dir, 'e.log'), 'utf8')).toContain('-- statement 2 (s.sql:2:1)');
    expect(s.executed.map((e) => e.text)).toEqual([
      'CREATE TABLE a (x int)',
      'INSERT INTO missing VALUES (1)',
      'INSERT INTO a VALUES (2)',
    ]);

    const stopped = failing();
    const stop = await run(['run-file', URI, 's.sql'], { session: stopped, cwd: dir });
    expect(stop.code).toBe(2);
    expect(stopped.executed).toHaveLength(2);
  });

  it('applies the safety rules to each statement', async () => {
    writeFileSync(join(dir, 'w.sql'), 'SELECT 1;\nDELETE FROM a;\n');
    const readOnly = session();
    const refused = await run(['run-file', URI, 'w.sql', '--read-only'], {
      session: readOnly,
      cwd: dir,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('Statement 2 writes, but');
    expect(readOnly.executed.map((e) => e.text)).toEqual(['SELECT 1']);

    const unconfirmed = await run(['run-file', URI, 'w.sql'], { session: session(), cwd: dir });
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('DELETE without WHERE removes every row');

    const yes = session();
    expect((await run(['run-file', URI, 'w.sql', '--yes'], { session: yes, cwd: dir })).code).toBe(
      0,
    );
    expect(yes.executed.map((e) => e.text)).toEqual(['SELECT 1', 'DELETE FROM a']);
  });
});

describe('helpers', () => {
  it('describes a failing row', () => {
    expect(describeRowError({ row: 3, line: 4, column: 'id', message: 'bad' })).toBe(
      'row 3 (line 4), column id: bad',
    );
    expect(describeRowError({ message: 'Unexpected end of file' })).toBe('Unexpected end of file');
  });

  it('names per-table files', () => {
    expect(exportFileName('orders', 'sql-ddl', true)).toBe('orders.sql.gz');
    expect(exportFileName('a/b', 'csv', false)).toBe('a_b.csv');
  });
});
