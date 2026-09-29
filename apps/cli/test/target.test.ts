import { join } from 'node:path';
import { inspect } from 'node:util';

import { JoineryError } from '@joinery/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Reporter } from '../src/reporter';
import { StoreHandle } from '../src/store';
import {
  isConnectionUri,
  passwordEnvName,
  redactUri,
  resolveTarget,
  resolvedProfile,
  type TargetDeps,
} from '../src/target';
import { FakeAdapter, FakeSession, MemoryStream, ScriptedPrompter, run, tempDir } from './helpers';

const PASSWORD = 's3cret-Pa55';
const URI = `postgres://app:${PASSWORD}@db.example:6543/shop`;

function deps(
  store: StoreHandle,
  env: Record<string, string> = {},
  prompter = new ScriptedPrompter(false),
): TargetDeps & { stderr: MemoryStream } {
  const stderr = new MemoryStream();
  return { store, env, prompter, reporter: new Reporter(stderr, { verbose: true }), stderr };
}

describe('target syntax', () => {
  it('tells URIs from profile names', () => {
    expect(isConnectionUri('postgres://h/db')).toBe(true);
    expect(isConnectionUri('jdbc:postgresql://h/db')).toBe(true);
    expect(isConnectionUri('MariaDB://h')).toBe(true);
    expect(isConnectionUri('prod db')).toBe(false);
    expect(isConnectionUri('c:\\path')).toBe(false);
  });

  it('redacts passwords in URIs', () => {
    expect(redactUri(URI)).toBe('postgres://app:***@db.example:6543/shop');
    expect(redactUri('mysql://h/db?user=a&password=x&ssl=1')).toBe(
      'mysql://h/db?user=a&password=***&ssl=1',
    );
    expect(redactUri('prod')).toBe('prod');
  });

  it('derives the per-profile password variable', () => {
    expect(passwordEnvName('Prod DB')).toBe('JOINERY_PASSWORD_PROD_DB');
    expect(passwordEnvName('my-app.eu')).toBe('JOINERY_PASSWORD_MY_APP_EU');
    expect(passwordEnvName('--x--')).toBe('JOINERY_PASSWORD_X');
  });
});

describe('URI targets', () => {
  let dir: string;
  let cleanup: () => void;
  let store: StoreHandle;
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    store = new StoreHandle({ path: join(dir, 'joinery.db'), source: '--store' }, {});
  });
  afterEach(() => {
    store.close();
    cleanup();
  });

  it('uses the URI password for the run only and never shows it', async () => {
    const d = deps(store);
    const target = await resolveTarget(URI, {}, d);
    const resolved = resolvedProfile(target);
    const auth = resolved.profile.auth;
    expect(auth.method).toBe('password');
    const ref = auth.method === 'password' ? auth.password : undefined;
    expect(resolved.secrets[ref!.id]).toBe(PASSWORD);
    expect(target.passwordKnown).toBe(true);
    expect(JSON.stringify(target)).not.toContain(PASSWORD);
    expect(inspect(target, { depth: 10 })).not.toContain(PASSWORD);
    expect(String(target.secrets)).not.toContain(PASSWORD);
    expect(target.label).toBe('PostgreSQL db.example:6543/shop');
    expect(d.stderr.text()).not.toContain(PASSWORD);
    // Nothing is stored.
    expect(store.exists).toBe(false);
  });

  it('defaults TLS to verify-full, honours sslmode, and --tls overrides both', async () => {
    const d = deps(store);
    expect((await resolveTarget('postgres://h/db', {}, d)).profile.tls.mode).toBe('verify-full');
    expect((await resolveTarget('postgres://h/db?sslmode=require', {}, d)).profile.tls.mode).toBe(
      'require',
    );
    expect(
      (await resolveTarget('mysql://h/db?ssl-mode=disabled', { tls: 'verify-ca' }, d)).profile.tls
        .mode,
    ).toBe('verify-ca');
  });

  it('takes JOINERY_PASSWORD when the URI has no password, and --database', async () => {
    const target = await resolveTarget(
      'mariadb://root@h/db',
      { database: 'other' },
      deps(store, { JOINERY_PASSWORD: 'from-env' }),
    );
    expect(target.profile.engine).toBe('mariadb');
    expect(target.profile.options.defaultDatabase).toBe('other');
    expect(Object.values(resolvedProfile(target).secrets)).toEqual(['from-env']);
    const bare = await resolveTarget('postgres://u@h/db', {}, deps(store));
    expect(bare.passwordKnown).toBe(false);
  });

  it('refuses engines the CLI does not drive', async () => {
    await expect(
      resolveTarget('https://es.example.com:9200', {}, deps(store)),
    ).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('reads Redis URIs with their database and password', async () => {
    const target = await resolveTarget('redis://app:s3cret@cache:6380/2', {}, deps(store));
    expect(target.profile).toMatchObject({
      engine: 'redis',
      endpoint: { kind: 'host', host: 'cache', port: 6380 },
      options: { defaultDatabase: '2' },
    });
    expect(target.passwordKnown).toBe(true);
    expect(JSON.stringify(target)).not.toContain('s3cret');
  });

  it('applies --read-only to the safety policy', async () => {
    const target = await resolveTarget('postgres://h/db', { readOnly: true }, deps(store));
    expect(target.policy.readOnly).toBe(true);
    expect(target.readOnlySource).toBe('flag');
  });
});

describe('profile targets', () => {
  let dir: string;
  let cleanup: () => void;
  const storeArgs = (): string[] => ['--store', join(dir, 'joinery.db')];

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  async function addProfile(env: Record<string, string>, ...args: string[]): Promise<void> {
    const result = await run([...storeArgs(), 'profiles', 'add', ...args], { env });
    expect(result.stderr).not.toContain(PASSWORD);
    expect(result.code).toBe(0);
  }

  function withStore<T>(env: Record<string, string>, fn: (handle: StoreHandle) => T): T {
    const handle = new StoreHandle({ path: join(dir, 'joinery.db'), source: '--store' }, env);
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  }

  it('unseals a password saved with JOINERY_PASSPHRASE', async () => {
    const env = { JOINERY_PASSPHRASE: 'correct horse' };
    await addProfile(env, 'Shop DB', URI, '--environment', 'production');
    const target = await withStore(env, (store) => resolveTarget('shop db', {}, deps(store, env)));
    expect(Object.values(target.secrets)).toEqual([PASSWORD]);
    expect(target.label).toBe('Shop DB');
    expect(target.policy).toMatchObject({ production: true, confirmWrites: true, readOnly: false });
  });

  it('falls back to JOINERY_PASSWORD_<PROFILE> when the saved value is unreadable here', async () => {
    await addProfile({ JOINERY_PASSPHRASE: 'one' }, 'Shop DB', URI);
    const env = { JOINERY_PASSPHRASE: 'another', JOINERY_PASSWORD_SHOP_DB: 'env-pw' };
    const target = await withStore(env, (store) => resolveTarget('Shop DB', {}, deps(store, env)));
    expect(Object.values(target.secrets)).toEqual(['env-pw']);
  });

  it('prompts when there is a terminal, and explains what to set when there is not', async () => {
    await addProfile({}, 'Shop DB', URI, '--password-policy', 'ask');
    const prompter = new ScriptedPrompter(true, { secret: ['typed'] });
    const target = await withStore({}, (store) =>
      resolveTarget('Shop DB', {}, deps(store, {}, prompter)),
    );
    expect(Object.values(target.secrets)).toEqual(['typed']);
    expect(prompter.asked).toEqual(['Password for Shop DB: ']);

    const error = await withStore({}, (store) =>
      resolveTarget('Shop DB', {}, deps(store)).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(JoineryError);
    expect((error as JoineryError).message).toContain('not available');
    expect((error as JoineryError).hint).toContain('JOINERY_PASSWORD_SHOP_DB');
  });

  it('finds profiles by id and case-insensitive name, and reports unknown ones', async () => {
    await addProfile({}, 'Alpha', 'postgres://a@h/db');
    await addProfile({}, 'Beta', 'postgres://b@h/db');
    await withStore({}, async (store) => {
      const beta = store.require().profiles.list()[1]!;
      expect((await resolveTarget(beta.id, {}, deps(store))).label).toBe('Beta');
      expect((await resolveTarget('alpha', {}, deps(store))).label).toBe('Alpha');
      await expect(resolveTarget('gamma', {}, deps(store))).rejects.toMatchObject({
        code: 'NOT_FOUND',
        hint: expect.stringContaining('profiles list'),
      });
    });
  });

  it('says where it looked when the store does not exist', async () => {
    const result = await run([...storeArgs(), 'test', 'nowhere']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No profile named "nowhere"');
    expect(result.stderr).toContain(join(dir, 'joinery.db'));
  });
});

describe('connecting', () => {
  it('asks for the password after an authentication failure when it can', async () => {
    const session = new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 1 }));
    const adapter = new FakeAdapter('postgres', session, (resolved) =>
      Object.keys(resolved.secrets).length === 0
        ? new JoineryError({ code: 'AUTH_FAILED', message: 'password authentication failed' })
        : undefined,
    );
    const prompter = new ScriptedPrompter(true, { secret: ['late-pw'] });
    const result = await run(['query', 'postgres://app@h/db', '-e', 'select 1'], {
      adapter,
      session,
      prompter,
    });
    expect(result.code).toBe(0);
    expect(adapter.connects).toHaveLength(2);
    expect(Object.values(adapter.connects[1]!.secrets)).toEqual(['late-pw']);

    const failing = await run(['query', 'postgres://app@h/db', '-e', 'select 1'], {
      adapter,
      session,
    });
    expect(failing.code).toBe(2);
    expect(failing.stderr).toContain('error: password authentication failed');
    expect(failing.stderr).toContain('set JOINERY_PASSWORD, or run in a terminal');
  });

  it('never prints a URI password, even with --verbose', async () => {
    const result = await run(['--verbose', 'query', URI, '-e', 'select 1']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('debug: target PostgreSQL db.example:6543/shop');
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
  });
});
