import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { JoineryError } from '@joinery/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FakeSession,
  FakeSignals,
  ScriptedPrompter,
  column,
  memoryInput,
  run,
  tempDir,
  type FakeResult,
} from './helpers';

const URI = 'postgres://app:pw@h/db';

/** A session that answers SELECTs with rows and everything else with a status. */
function session(
  respond: (text: string) => FakeResult | undefined = () => undefined,
  engine: 'postgres' | 'mariadb' = 'postgres',
): FakeSession {
  return new FakeSession(engine, (text) => {
    const custom = respond(text);
    if (custom) return custom;
    if (/^\s*select/i.test(text)) {
      return {
        columns: [column('id', 'integer'), column('name')],
        rows: [
          [1, 'a'],
          [2, 'b'],
          [3, null],
        ],
      };
    }
    const command = text.trim().split(/\s+/)[0]!.toUpperCase();
    return { command, rowsAffected: command === 'INSERT' ? 1 : null };
  });
}

describe('query', () => {
  it('runs statements in order and streams results to stdout, messages to stderr', async () => {
    const s = session();
    const result = await run(
      ['query', URI, '--format', 'csv', '-e', 'insert into t values (1); select * from t; -- done'],
      { session: s },
    );
    expect(result.code).toBe(0);
    expect(s.executed.map((e) => e.text)).toEqual(['insert into t values (1)', 'select * from t']);
    expect(result.stdout).toBe('id,name\n1,a\n2,b\n3,\n');
    expect(result.stderr).toContain('[1] INSERT · 1 row affected');
    expect(result.stderr).toContain('[2] 3 rows');
    expect(s.closed).toBe(true);
  });

  it('stops at the first error by default and exits 2', async () => {
    const s = session((text) =>
      text.includes('bad')
        ? {
            error: new JoineryError({
              code: 'SQL_ERROR',
              message: 'relation "bad" does not exist',
              sqlState: '42P01',
              position: 14,
            }),
          }
        : undefined,
    );
    const result = await run(['query', URI, '-e', 'select 1; select * from bad; select 2'], {
      session: s,
    });
    expect(result.code).toBe(2);
    expect(s.executed).toHaveLength(2);
    expect(result.stderr).toContain('error: relation "bad" does not exist');
    expect(result.stderr).toContain('SQLSTATE 42P01, position 15');
    expect(result.stderr).toContain('at statement 2');
    expect(result.stderr).toMatch(/LINE 1: select \* from bad\n {24}\^/);
  });

  it('keeps going with --continue and still exits 2', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const s = session((text) =>
        text.includes('bad')
          ? { error: new JoineryError({ code: 'SQL_ERROR', message: 'boom' }) }
          : undefined,
      );
      const log = join(dir, 'errors.log');
      const result = await run(
        ['query', URI, '--continue', '--error-log', log, '-e', 'select 1; bad; select 2'],
        { session: s },
      );
      expect(result.code).toBe(2);
      expect(s.executed).toHaveLength(3);
      expect(result.stderr).toContain('Ran 3 statements in 0 ms, 1 failed');
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(log, 'utf8')).toContain('-- error: boom\nbad');
    } finally {
      cleanup();
    }
  });

  it('streams a file through the splitter, including MySQL DELIMITER blocks', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, 'script.sql');
      writeFileSync(
        file,
        '﻿create table t (id int);\nDELIMITER //\ncreate procedure p() begin select 1; select 2; end //\nDELIMITER ;\ncall p();\n',
      );
      const s = session(undefined, 'mariadb');
      const result = await run(['query', 'mariadb://u:p@h/db', '-f', file, '-q'], { session: s });
      expect(result.code).toBe(0);
      expect(s.executed.map((e) => e.text)).toEqual([
        'create table t (id int)',
        'create procedure p() begin select 1; select 2; end',
        'call p()',
      ]);
    } finally {
      cleanup();
    }
  });

  it('reads SQL from stdin when it is not a terminal', async () => {
    const s = session();
    const result = await run(['query', URI, '--format', 'jsonl'], {
      session: s,
      stdin: memoryInput(['select * ', 'from t;\nselect 1'], false),
    });
    expect(result.code).toBe(0);
    expect(s.executed.map((e) => e.text)).toEqual(['select * from t', 'select 1']);
    expect(result.stdout.trim().split('\n')).toHaveLength(6);
  });

  it('asks for SQL when stdin is a terminal and nothing was given', async () => {
    const result = await run(['query', URI]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No SQL to run');
  });

  it('stops each result set at --row-limit', async () => {
    const result = await run(
      ['query', URI, '--format', 'csv', '--row-limit', '2', '-e', 'select 1'],
      {
        session: session(),
      },
    );
    expect(result.stdout).toBe('id,name\n1,a\n2,b\n');
    expect(result.stderr).toContain('row limit 2 reached');
    const exact = await run([
      'query',
      URI,
      '--format',
      'csv',
      '--row-limit',
      '3',
      '-e',
      'select 1',
    ]);
    expect(exact.stderr).not.toContain('row limit');
  });

  it('binds --param values in the driver form', async () => {
    const s = session();
    const result = await run(
      [
        'query',
        URI,
        '-e',
        'select * from t where id = :id and name = :name or id = :id',
        '-p',
        'id=7',
        '--param',
        ':name=x',
      ],
      { session: s },
    );
    expect(result.code).toBe(0);
    expect(s.executed[0]).toEqual({
      text: 'select * from t where id = $1 and name = $2 or id = $1',
      params: ['7', 'x'],
    });
  });

  it('fails clearly when a parameter has no value and asks for it on a terminal', async () => {
    const s = session();
    const missing = await run(['query', URI, '-e', 'select :a, :b', '-p', 'a=1'], { session: s });
    expect(missing.code).toBe(2);
    expect(s.executed).toHaveLength(0);
    const prompter = new ScriptedPrompter(true, { text: ['2'] });
    const asked = await run(['query', URI, '-e', 'select :a, :b', '-p', 'a=1'], {
      session: s,
      prompter,
    });
    expect(asked.code).toBe(0);
    expect(prompter.asked).toEqual(['Value for :b: ']);
    expect(s.executed[0]?.params).toEqual(['1', '2']);
  });

  it('cancels the running statement on Ctrl+C and exits 130', async () => {
    const signals = new FakeSignals();
    const s = session((text) => (text.includes('sleep') ? { hang: true } : undefined));
    const pending = run(['query', URI, '-e', 'select pg_sleep(30); select 1'], {
      session: s,
      signals,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    signals.interrupt();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(s.executed).toHaveLength(1);
    expect(s.cancelled).toHaveLength(1);
    expect(result.stderr).toContain('Cancelling');
    expect(s.closed).toBe(true);
    expect(signals.listeners).toBe(0);
  });

  it('rolls back a transaction the script left open', async () => {
    const s = session();
    s.inTransaction = true;
    const result = await run(['query', URI, '-e', 'select 1'], { session: s });
    expect(result.code).toBe(0);
    expect(s.inTransaction).toBe(false);
    expect(result.stderr).toContain('rolled back');
  });
});

describe('query safety', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('refuses a risky statement without --yes when nobody can confirm', async () => {
    const s = session();
    const result = await run(['query', URI, '-e', 'select 1; delete from users'], { session: s });
    expect(result.code).toBe(2);
    expect(s.executed.map((e) => e.text)).toEqual(['select 1']);
    expect(result.stderr).toContain(
      'Statement 2 needs confirmation: DELETE without WHERE removes every row',
    );
    expect(result.stderr).toContain('--yes');
  });

  it('runs it with --yes, and asks on a terminal', async () => {
    const s = session();
    expect((await run(['query', URI, '--yes', '-e', 'drop table t'], { session: s })).code).toBe(0);
    expect(s.executed).toHaveLength(1);

    const prompter = new ScriptedPrompter(true, { confirm: ['no'] });
    const declined = await run(['query', URI, '-e', 'truncate t'], { session: s, prompter });
    expect(declined.code).toBe(2);
    expect(s.executed).toHaveLength(1);
    expect(declined.stderr).toContain('TRUNCATE removes every row');

    const all = new ScriptedPrompter(true, { confirm: ['all'] });
    const accepted = await run(['query', URI, '-e', 'drop table a; drop table b'], {
      session: s,
      prompter: all,
    });
    expect(accepted.code).toBe(0);
    expect(all.asked).toHaveLength(1);
    expect(s.executed).toHaveLength(3);
  });

  it('never prompts when the SQL comes from stdin', async () => {
    const s = session();
    const prompter = new ScriptedPrompter(true, { confirm: ['yes'] });
    const result = await run(['query', URI], {
      session: s,
      prompter,
      stdin: memoryInput(['delete from t'], false),
    });
    expect(result.code).toBe(2);
    expect(prompter.asked).toHaveLength(0);
  });

  it('refuses writes on read-only profiles, and confirms every write on production', async () => {
    const store = ['--store', join(dir, 'joinery.db')];
    await run([...store, 'profiles', 'add', 'ro', 'postgres://u@h/db', '--read-only']);
    await run([
      ...store,
      'profiles',
      'add',
      'prod',
      'postgres://u@h/db',
      '--environment',
      'production',
    ]);
    const s = session();

    const readOnly = await run(
      [...store, 'query', 'ro', '--yes', '-e', 'insert into t values (1)'],
      {
        session: s,
      },
    );
    expect(readOnly.code).toBe(2);
    expect(readOnly.stderr).toContain('is read-only');
    expect(s.executed).toHaveLength(0);
    expect((await run([...store, 'query', 'ro', '-e', 'select 1'], { session: s })).code).toBe(0);

    const prod = await run([...store, 'query', 'prod', '-e', 'update t set a = 1 where id = 2'], {
      session: s,
    });
    expect(prod.code).toBe(2);
    expect(prod.stderr).toContain('writes to the production connection "prod"');
    const confirmed = await run(
      [...store, 'query', 'prod', '--yes', '-e', 'update t set a = 1 where id = 2'],
      {
        session: s,
      },
    );
    expect(confirmed.code).toBe(0);

    const flag = await run(['query', URI, '--read-only', '-e', 'create table x (a int)'], {
      session: s,
    });
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain('--read-only was given');
  });
});
