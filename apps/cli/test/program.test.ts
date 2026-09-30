import { JoineryError } from '@joinery/core';
import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/program';
import {
  actionList,
  compareFlags,
  ignoreList,
  nonNegativeInteger,
  param,
  renameRule,
  tlsMode,
} from '../src/options';
import { FakeAdapter, FakeSession, ScriptedPrompter, run } from './helpers';

describe('help and version', () => {
  it('prints help with every command, targets and exit codes', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    for (const command of ['test', 'query', 'compare', 'data-compare', 'ddl', 'profiles']) {
      expect(result.stdout).toContain(`${command} `);
    }
    expect(result.stdout).toContain('JOINERY_PASSWORD_<NAME>');
    expect(result.stdout).toContain('130 interrupted');
  });

  it('prints per-command help with examples', async () => {
    const query = await run(['query', '--help']);
    expect(query.code).toBe(0);
    expect(query.stdout).toContain('--format <format>');
    expect(query.stdout).toContain('Examples:');
    const compare = await run(['help', 'compare']);
    expect(compare.stdout).toContain('diff(1)');
    const add = await run(['profiles', 'add', '--help']);
    expect(add.stdout).toContain('--password-policy');
  });

  it('prints the version', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });
});

describe('argument validation exits 2 with a message', () => {
  it.each([
    [['query', 'x', '--format', 'xml', '-e', 'select 1'], "argument 'xml' is invalid"],
    [['query', 'x', '--row-limit', '-1', '-e', 'select 1'], 'Expected a whole number'],
    [['query', 'x', '--continue', '--stop-on-error', '-e', '1'], 'cannot be used with'],
    [['query', 'x', '-p', 'novalue', '-e', 'select 1'], 'Use name=value'],
    [['query'], "missing required argument 'target'"],
    [['compare', 'a', 'b', '--ignore', 'colour'], 'Unknown: colour'],
    [['compare', 'a', 'b', '--rename', 'column:x=y'], 'the table is required'],
    [['data-compare', 'a', 'b'], "required option '--table <name>' not specified"],
    [['data-compare', 'a', 'b', '--table', 't', '--actions', 'upsert'], 'Unknown: upsert'],
    [['test', 'x', '--tls', 'maybe'], 'Use one of: disable, require, verify-ca, verify-full'],
    [['frobnicate'], "unknown command 'frobnicate'"],
    [['query', 'x', '--bogus'], "unknown option '--bogus'"],
  ])('%j', async (argv, message) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('rejects -e together with -f', async () => {
    const result = await run(['query', 'postgres://h/db', '-e', 'select 1', '-f', 'x.sql']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('either -e <sql> or -f <file>');
  });
});

describe('option parsers', () => {
  it('parses --rename rules', () => {
    expect(renameRule('table:old_users=users')).toEqual({
      objectKind: 'table',
      from: 'old_users',
      to: 'users',
    });
    expect(renameRule('view:app.v_old=v_new')).toEqual({
      objectKind: 'view',
      schema: 'app',
      from: 'v_old',
      to: 'v_new',
    });
    expect(renameRule('column:users.mail=email')).toEqual({
      objectKind: 'column',
      table: 'users',
      from: 'mail',
      to: 'email',
    });
    expect(renameRule('index:app.users.ix_a=ix_b')).toEqual({
      objectKind: 'index',
      schema: 'app',
      table: 'users',
      from: 'ix_a',
      to: 'ix_b',
    });
    for (const bad of ['sequence:a=b', 'table:a', 'table:=b', 'table:a.b.c=d', 'column:a=b']) {
      expect(() => renameRule(bad)).toThrow(InvalidArgumentError);
    }
  });

  it('maps --ignore onto compare options, keeping the engine defaults unless told not to', () => {
    const names = ignoreList('comments, name-case', ['names']);
    expect(names).toEqual(['names', 'comments', 'name-case']);
    const flags = compareFlags(names, true);
    expect(flags).toMatchObject({
      ignoreComments: true,
      ignoreNameCase: true,
      ignoreNames: true,
      ignoreDefiner: true,
      ignoreOwnership: true,
      ignoreCollation: false,
    });
    expect(compareFlags(['comments'], false)).toMatchObject({
      ignoreComments: true,
      ignoreDefiner: false,
      ignoreAutoIncrement: false,
    });
  });

  it('parses the smaller values', () => {
    expect(param('id=4=2')).toEqual(['id', '4=2']);
    expect(param('$1=x')).toEqual(['1', 'x']);
    expect(param('empty=')).toEqual(['empty', '']);
    expect(nonNegativeInteger('0')).toBe(0);
    expect(() => nonNegativeInteger('1.5')).toThrow(InvalidArgumentError);
    expect(actionList('insert,insert,delete')).toEqual(['insert', 'delete']);
    expect(tlsMode('verify-ca')).toBe('verify-ca');
  });
});

describe('exit codes', () => {
  it('maps driver errors to 2 with the hint', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const adapter = new FakeAdapter(
      'postgres',
      session,
      () =>
        new JoineryError({
          code: 'CONNECTION_FAILED',
          message: 'Connection refused',
          hint: 'Is the server running?',
        }),
    );
    const result = await run(['query', 'postgres://h/db', '-e', 'select 1'], { adapter, session });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('error: Connection refused\n  hint: Is the server running?\n');
  });

  it('exits 1 when a connection test step fails and 0 when all pass', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const ok = await run(['test', 'postgres://u:pw@h/db'], { session });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('✓ TCP');
    expect(ok.stdout).toContain('Connection OK.');
    const failing = new FakeAdapter(
      'postgres',
      session,
      () => new JoineryError({ code: 'AUTH_FAILED', message: 'bad password', hint: 'Check it' }),
    );
    const failed = await run(['test', 'postgres://u:pw@h/db'], { adapter: failing, session });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('✗ Auth    bad password');
    expect(failed.stdout).toContain('hint: Check it');
    expect(failed.stdout).toContain('Connection failed at the Auth step.');
  });

  it('retries a connection test with a prompted password after an auth failure', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
    const adapter = new FakeAdapter('postgres', session, (resolved) =>
      Object.keys(resolved.secrets).length === 0
        ? new JoineryError({ code: 'AUTH_FAILED', message: 'password required' })
        : undefined,
    );
    const prompter = new ScriptedPrompter(true, { secret: ['pw'] });
    const result = await run(['test', 'postgres://u@h/db', '--json'], {
      adapter,
      session,
      prompter,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });
});
