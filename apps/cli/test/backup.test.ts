import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ArchiveWriter, type BackupObject } from '@joinery/backup';
import { fileSink } from '@joinery/transfer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeConflicts,
  formatFromName,
  objectRef,
  selectObjects,
  selectionOf,
} from '../src/commands/backup';
import { backupOptions, restoreOptions } from '../src/commands/backup-cli';
import { FakeAdapter, FakeSession, ScriptedPrompter, column, run, tempDir } from './helpers';

/**
 * `joinery backup` and `joinery restore` in-process: flag parsing, the checks made before
 * anything connects (formats, encryption, read-only), passphrases from the environment or a
 * prompt and never from argv, `restore --list`, and the confirmation of a restore over what is
 * there, against a fake session.
 */

const URI = 'postgres://app:pw@h/db';
const PASSPHRASE = 'cli unit passphrase';
let dir = '';
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});

afterEach(() => cleanup());

const OBJECTS: BackupObject[] = [
  {
    id: 'schema:public',
    kind: 'schema',
    name: 'public',
    qualifiedName: 'public',
    dependsOn: [],
  },
  {
    id: 'table:public.orders',
    kind: 'table',
    schema: 'public',
    name: 'orders',
    qualifiedName: 'public.orders',
    dependsOn: ['schema:public'],
    data: { entry: 'data/0001-orders.sql', count: 2 },
  },
  {
    id: 'table:audit.orders',
    kind: 'table',
    schema: 'audit',
    name: 'orders',
    qualifiedName: 'audit.orders',
    dependsOn: [],
  },
];

async function archive(name: string, passphrase?: string): Promise<string> {
  const path = join(dir, name);
  const writer = await ArchiveWriter.create({
    sink: fileSink(path),
    ...(passphrase !== undefined
      ? { encryption: { passphrase, cost: { log2N: 10, r: 8, p: 1 } } }
      : {}),
  });
  await writer.add(
    'data/0001-orders.sql',
    'application/sql',
    'INSERT INTO orders VALUES (1), (2);',
  );
  await writer.finish({
    createdAt: '2026-09-29T12:00:00.000Z',
    producer: 'test',
    engine: 'postgres',
    serverVersion: '16.4',
    database: 'shop',
    objects: OBJECTS,
  });
  return path;
}

describe('flags', () => {
  it('reads the format from the file name', () => {
    expect(formatFromName('shop.jbak')).toBe('jbak');
    expect(formatFromName('shop.SQL')).toBe('sql');
    expect(formatFromName('shop.sql.gz')).toBe('sql-gz');
    expect(formatFromName('shop.dump')).toBe('custom');
    expect(formatFromName('shop.bak')).toBe('jbak');
  });

  it('turns table flags into a selection', () => {
    expect(objectRef('table', 'public.orders', true)).toEqual({
      kind: 'table',
      schema: 'public',
      name: 'orders',
    });
    expect(objectRef('table', 'my.table', false)).toEqual({ kind: 'table', name: 'my.table' });
    const options = backupOptions({
      out: 'x.jbak',
      schema: ['public'],
      table: ['orders'],
      excludeData: ['public.log'],
      schemaOnly: true,
    });
    expect(options).toMatchObject({ structure: true, data: false, compress: true, snapshot: true });
    expect(selectionOf(options, true)).toEqual({
      schemas: ['public'],
      include: [{ kind: 'table', name: 'orders' }],
      excludeData: [{ kind: 'table', schema: 'public', name: 'log' }],
    });
    expect(
      restoreOptions('x.jbak', { select: ['orders'], continue: true, keepExpiry: true }),
    ).toMatchObject({
      file: 'x.jbak',
      select: ['orders'],
      continueOnError: true,
      keepExpiry: true,
      structure: true,
      data: true,
    });
  });

  it('picks archive objects by id, qualified name or unique name', () => {
    expect(selectObjects(OBJECTS, ['public.orders'])).toEqual(['table:public.orders']);
    expect(selectObjects(OBJECTS, ['table:audit.orders', 'public'])).toEqual([
      'table:audit.orders',
      'schema:public',
    ]);
    expect(() => selectObjects(OBJECTS, ['orders'])).toThrow(/names 2 objects/);
    expect(() => selectObjects(OBJECTS, ['nope'])).toThrow(/no object "nope"/);
  });

  it('words what a restore changes', () => {
    expect(
      describeConflicts([
        { id: 't', kind: 'table', qualifiedName: 'public.orders', action: 'drop' },
        {
          id: 'database',
          kind: 'database',
          qualifiedName: 'the 2 objects already in the database',
          action: 'overwrite',
        },
      ]),
    ).toEqual([
      '  drop and recreate table public.orders',
      '  the 2 objects already in the database: the script runs over them',
    ]);
  });
});

describe('joinery backup', () => {
  it('refuses options that do not go together before connecting', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const adapter = new FakeAdapter('postgres', session);
    const cases: [string[], RegExp][] = [
      [['--out', 'x.sql', '--encrypt'], /Encryption needs the Joinery archive/],
      [['--out', 'x.dump'], /custom format is written by pg_dump/],
      [['--out', 'x.jbak', '--native'], /do not write Joinery archives/],
      [
        ['--out', 'x.jbak', '--format', 'custom', '--native', '--schema-only', '--data-only'],
        /cannot be used with/,
      ],
    ];
    for (const [flags, message] of cases) {
      const result = await run(['backup', URI, ...flags], { adapter, cwd: dir });
      expect(result.code, flags.join(' ')).toBe(2);
      expect(result.stderr).toMatch(message);
    }
    const mongo = await run(['backup', 'mongodb://h/app', '--out', 'x.sql'], { adapter, cwd: dir });
    expect(mongo.stderr).toMatch(/MongoDB backups are Joinery archives/);
    expect(adapter.connects).toHaveLength(0);
  });

  it('takes the passphrase from the environment or a prompt, never from argv', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const adapter = new FakeAdapter('postgres', session);
    const none = await run(['backup', URI, '--out', 'x.jbak', '--encrypt'], { adapter, cwd: dir });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('Encrypting the backup needs a passphrase');
    expect(none.stderr).toContain('JOINERY_BACKUP_PASSPHRASE');
    const short = await run(['backup', URI, '--out', 'x.jbak', '--encrypt'], {
      adapter,
      cwd: dir,
      prompter: new ScriptedPrompter(true, { secret: ['short'] }),
    });
    expect(short.stderr).toContain('at least 8 characters');
    const mismatch = await run(['backup', URI, '--out', 'x.jbak', '--encrypt'], {
      adapter,
      cwd: dir,
      prompter: new ScriptedPrompter(true, { secret: [PASSPHRASE, `${PASSPHRASE}!`] }),
    });
    expect(mismatch.stderr).toContain('do not match');
    expect(adapter.connects).toHaveLength(0);
    const unknown = await run(['backup', URI, '--out', 'x.jbak', '--passphrase', PASSPHRASE], {
      adapter,
      cwd: dir,
    });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown option '--passphrase'");
  });
});

describe('joinery restore', () => {
  it('lists an archive, unlocking it with the passphrase from the environment', async () => {
    await archive('plain.jbak');
    await archive('sealed.jbak', PASSPHRASE);
    const adapter = new FakeAdapter(
      'postgres',
      new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 })),
    );
    const plain = await run(['restore', URI, 'plain.jbak', '--list'], { adapter, cwd: dir });
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout.split('\n')).toEqual([
      'schema:public\tschema\tpublic',
      'table:public.orders\ttable\tpublic.orders\t2',
      'table:audit.orders\ttable\taudit.orders',
      '',
    ]);
    const locked = await run(['restore', URI, 'sealed.jbak', '--list'], { adapter, cwd: dir });
    expect(locked.code).toBe(2);
    expect(locked.stderr).toContain('needs its passphrase');
    const wrong = await run(['restore', URI, 'sealed.jbak', '--list'], {
      adapter,
      cwd: dir,
      env: { JOINERY_BACKUP_PASSPHRASE: 'not the passphrase' },
    });
    expect(wrong.stderr).toMatch(/passphrase is wrong/);
    const sealed = await run(['restore', URI, 'sealed.jbak', '--list', '--passphrase-env', 'KEY'], {
      adapter,
      cwd: dir,
      env: { KEY: PASSPHRASE },
    });
    expect(sealed.code, sealed.stderr).toBe(0);
    expect(sealed.stdout).toContain('table:public.orders');
    expect(`${sealed.stdout}${sealed.stderr}${wrong.stderr}`).not.toContain(PASSPHRASE);
    expect(adapter.connects).toHaveLength(0);
  });

  it('refuses a read-only target and a selection that is not there', async () => {
    await archive('plain.jbak');
    const adapter = new FakeAdapter(
      'postgres',
      new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 })),
    );
    const readOnly = await run(['restore', URI, 'plain.jbak', '--read-only'], {
      adapter,
      cwd: dir,
    });
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('is read-only, so nothing can be restored');
    const missing = await run(['restore', URI, 'plain.jbak', '--select', 'nope'], {
      adapter,
      cwd: dir,
    });
    expect(missing.stderr).toContain('The backup has no object "nope"');
    const create = await run(['restore', URI, 'plain.jbak', '--create-database'], {
      adapter,
      cwd: dir,
    });
    expect(create.stderr).toContain('--create-database needs --database');
    expect(adapter.connects).toHaveLength(0);
  });

  it('lists what a script runs over and needs --yes to go on', async () => {
    writeFileSync(join(dir, 'shop.sql'), 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n');
    const session = new FakeSession('postgres', (text) =>
      /count\(\*\)/i.test(text)
        ? { columns: [column('count', 'integer')], rows: [[2]] }
        : { command: 'OK', rowsAffected: 0 },
    );
    const adapter = new FakeAdapter('postgres', session);
    const refused = await run(['restore', URI, 'shop.sql'], { adapter, cwd: dir });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('the 2 objects already in the database');
    expect(refused.stderr).toContain('needs confirmation');
    expect(session.executed.some((e) => e.text.startsWith('CREATE TABLE t'))).toBe(false);

    const asked = new ScriptedPrompter(true, { confirm: ['no'] });
    const declined = await run(['restore', URI, 'shop.sql'], {
      adapter,
      cwd: dir,
      prompter: asked,
    });
    expect(declined.code).toBe(2);
    expect(asked.asked).toEqual(['Run shop.sql over the 2 objects already in the database?']);

    const done = await run(['restore', URI, 'shop.sql', '--yes'], { adapter, cwd: dir });
    expect(done.code, done.stderr).toBe(0);
    expect(done.stderr).toContain('Restored shop.sql');
    expect(session.executed.some((e) => e.text.startsWith('CREATE TABLE t'))).toBe(true);
  });
});
