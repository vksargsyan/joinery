import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScriptedPrompter, run, tempDir, type RunResult } from './helpers';

const PASSWORD = 'Hunter2-very-secret';
const PASSPHRASE = 'store passphrase';
const EXPORT_PASSPHRASE = 'export passphrase';

describe('profiles', () => {
  let dir: string;
  let cleanup: () => void;
  let outputs: RunResult[];
  const cli = async (
    argv: readonly string[],
    env: Record<string, string> = {},
    prompter?: ScriptedPrompter,
  ): Promise<RunResult> => {
    const result = await run(['--store', join(dir, 'querybara.db'), ...argv], {
      env,
      cwd: dir,
      ...(prompter ? { prompter } : {}),
    });
    outputs.push(result);
    return result;
  };

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    outputs = [];
  });
  afterEach(() => {
    // No command, whatever it did, ever printed the password or a passphrase.
    for (const output of outputs) {
      for (const secret of [PASSWORD, PASSPHRASE, EXPORT_PASSPHRASE]) {
        expect(output.stdout).not.toContain(secret);
        expect(output.stderr).not.toContain(secret);
      }
    }
    cleanup();
  });

  it('lists nothing without creating a store', async () => {
    const result = await cli(['profiles', 'list']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('No profiles');
    expect(existsSync(join(dir, 'querybara.db'))).toBe(false);
    expect(JSON.parse((await cli(['profiles', 'list', '--json'])).stdout)).toEqual([]);
  });

  it('adds, lists and shows profiles without printing secrets', async () => {
    const env = { QUERYBARA_PASSPHRASE: PASSPHRASE };
    const added = await cli(
      [
        'profiles',
        'add',
        'Shop',
        `postgres://app:${PASSWORD}@db.example:6543/shop?sslmode=verify-ca`,
        '--environment',
        'production',
        '--folder',
        'Team/Backend',
        '--tag',
        'eu',
      ],
      env,
    );
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('Added profile "Shop" (PostgreSQL at db.example:6543');
    expect(added.stderr).toContain('saved, sealed with QUERYBARA_PASSPHRASE');

    const list = await cli(['profiles', 'list'], env);
    expect(list.stdout).toMatch(
      /Shop\s+\| PostgreSQL\s+\| db\.example:6543\s+\| shop\s+\| app\s+\| production\s+\| Team\/Backend/,
    );

    const show = await cli(['profiles', 'show', 'shop'], env);
    expect(show.stdout).toContain('TLS:          verify-ca');
    expect(show.stdout).toContain('Password:     saved (readable here)');
    expect(show.stdout).toContain('Tags:         eu');

    const json = JSON.parse((await cli(['profiles', 'show', 'Shop', '--json'], env)).stdout) as {
      secrets: { status: string; policy: string }[];
      presentation: { environment: string };
    };
    expect(json.secrets).toEqual([
      expect.objectContaining({ policy: 'save', status: 'available' }),
    ]);
    expect(json.presentation.environment).toBe('production');

    // Without the passphrase the value is there but unreadable.
    const locked = await cli(['profiles', 'show', 'Shop']);
    expect(locked.stdout).toContain('saved, but not readable here');

    // The database file holds only the sealed value.
    expect(readFileSync(join(dir, 'querybara.db')).includes(Buffer.from(PASSWORD))).toBe(false);
  });

  it('does not save a URI password without a passphrase, and refuses --password-policy save', async () => {
    const added = await cli(['profiles', 'add', 'Shop', `postgres://app:${PASSWORD}@h/db`]);
    expect(added.code).toBe(0);
    expect(added.stderr).toContain('The password in the URI was not saved');
    const show = await cli(['profiles', 'show', 'Shop']);
    expect(show.stdout).toContain('Password:     asked every time');

    const refused = await cli([
      'profiles',
      'add',
      'Other',
      `postgres://app:${PASSWORD}@h/db`,
      '--password-policy',
      'save',
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('QUERYBARA_PASSPHRASE');
  });

  it('prompts for a password to save when the URI has none', async () => {
    const prompter = new ScriptedPrompter(true, { secret: [PASSWORD] });
    const added = await cli(
      ['profiles', 'import-uri', 'mysql://root@127.0.0.1:3307/app', '--password-policy', 'save'],
      { QUERYBARA_PASSPHRASE: PASSPHRASE },
      prompter,
    );
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('Added profile "127.0.0.1:3307/app"');
    expect(prompter.asked).toEqual(['Password for 127.0.0.1:3307/app: ']);
  });

  it('refuses duplicate names unless --replace, which keeps the id', async () => {
    await cli(['profiles', 'add', 'Shop', 'postgres://a@h1/db']);
    const id = (
      JSON.parse((await cli(['profiles', 'list', '--json'])).stdout) as { id: string }[]
    )[0]!.id;
    const duplicate = await cli(['profiles', 'add', 'shop', 'postgres://a@h2/db']);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain('already exists');
    expect((await cli(['profiles', 'add', 'Shop', 'postgres://a@h2/db', '--replace'])).code).toBe(
      0,
    );
    const after = JSON.parse((await cli(['profiles', 'list', '--json'])).stdout) as {
      id: string;
      endpoint: { host: string };
    }[];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id, endpoint: { host: 'h2' } });
  });

  it('removes a profile only when confirmed', async () => {
    await cli(['profiles', 'add', 'Shop', 'postgres://a@h/db']);
    const refused = await cli(['profiles', 'remove', 'Shop']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--yes');
    expect((await cli(['profiles', 'rm', 'Shop', '--yes'])).stdout).toContain(
      'Removed profile "Shop"',
    );
    expect(JSON.parse((await cli(['profiles', 'list', '--json'])).stdout)).toEqual([]);
  });

  it('exports and imports an encrypted file with folders and secrets', async () => {
    const env = {
      QUERYBARA_PASSPHRASE: PASSPHRASE,
      QUERYBARA_EXPORT_PASSPHRASE: EXPORT_PASSPHRASE,
    };
    await cli(
      ['profiles', 'add', 'Shop', `postgres://app:${PASSWORD}@h/db`, '--folder', 'A/B'],
      env,
    );
    await cli(['profiles', 'add', 'Other', 'mysql://root@h/db'], env);
    const exported = await cli(
      ['profiles', 'export', 'out.jnx', '--include-secrets', '--profile', 'Shop'],
      env,
    );
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain('Exported 1 profile with 1 secret to out.jnx');
    expect(readFileSync(join(dir, 'out.jnx')).includes(Buffer.from(PASSWORD))).toBe(false);

    // Into a fresh store.
    const fresh = join(dir, 'fresh.db');
    const imported = await run(['--store', fresh, 'profiles', 'import', 'out.jnx'], {
      env,
      cwd: dir,
    });
    outputs.push(imported);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain('Imported 1 profile from out.jnx, 1 secret saved');
    const show = await run(['--store', fresh, 'profiles', 'show', 'Shop'], { env, cwd: dir });
    outputs.push(show);
    expect(show.stdout).toContain('Folder:       A/B');
    expect(show.stdout).toContain('saved (readable here)');

    // Again: it exists, so it is skipped unless --replace.
    const again = await run(['--store', fresh, 'profiles', 'import', 'out.jnx'], { env, cwd: dir });
    outputs.push(again);
    expect(again.stderr).toContain('1 profile already existed');

    const wrong = await cli(['profiles', 'import', 'out.jnx'], {
      QUERYBARA_EXPORT_PASSPHRASE: 'wrong',
    });
    expect(wrong.code).toBe(2);
  });

  it('needs an export passphrase from the environment or a terminal', async () => {
    await cli(['profiles', 'add', 'Shop', 'postgres://a@h/db']);
    const result = await cli(['profiles', 'export', 'out.jnx']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('QUERYBARA_EXPORT_PASSPHRASE');
  });
});
