import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STORE_FILE_NAME,
  StoreHandle,
  UNAVAILABLE_SEALER_ID,
  cliSealer,
  defaultDataDir,
  resolveStorePath,
} from '../src/store';
import { tempDir } from './helpers';

describe('default store location', () => {
  it('matches Electron userData for "Querybara" on each platform', () => {
    expect(defaultDataDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/Querybara');
    expect(defaultDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/ada')).toBe(
      '/xdg/Querybara',
    );
    expect(defaultDataDir('freebsd', {}, '/home/ada')).toBe('/home/ada/.config/Querybara');
    expect(defaultDataDir('darwin', {}, '/Users/ada')).toBe(
      '/Users/ada/Library/Application Support/Querybara',
    );
    expect(
      defaultDataDir('win32', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'C:\\Users\\ada'),
    ).toBe('C:\\Users\\ada\\AppData\\Roaming\\Querybara');
    expect(defaultDataDir('win32', {}, 'C:\\Users\\ada')).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\Querybara',
    );
  });

  it('puts the desktop store file querybara.db there', () => {
    const location = resolveStorePath({
      env: {},
      platform: 'darwin',
      homedir: '/Users/ada',
      cwd: '/',
    });
    expect(location).toEqual({
      path: '/Users/ada/Library/Application Support/Querybara/querybara.db',
      source: 'default',
    });
    expect(STORE_FILE_NAME).toBe('querybara.db');
  });
});

describe('store path precedence', () => {
  const base = { platform: 'linux' as const, homedir: '/home/ada', cwd: '/work' };

  it('prefers --store, then QUERYBARA_STORE, then QUERYBARA_USER_DATA_DIR', () => {
    const env = { QUERYBARA_STORE: '/env/store.db', QUERYBARA_USER_DATA_DIR: '/data' };
    expect(resolveStorePath({ ...base, env, flag: 'my.db' })).toEqual({
      path: '/work/my.db',
      source: '--store',
    });
    expect(resolveStorePath({ ...base, env })).toEqual({
      path: '/env/store.db',
      source: 'QUERYBARA_STORE',
    });
    expect(resolveStorePath({ ...base, env: { QUERYBARA_USER_DATA_DIR: 'rel' } })).toEqual({
      path: '/work/rel/querybara.db',
      source: 'QUERYBARA_USER_DATA_DIR',
    });
  });

  it('resolves Windows paths with Windows rules', () => {
    const location = resolveStorePath({
      platform: 'win32',
      homedir: 'C:\\Users\\ada',
      cwd: 'C:\\work',
      env: { QUERYBARA_STORE: 'stores\\a.db' },
    });
    expect(location.path).toBe('C:\\work\\stores\\a.db');
  });

  it('treats an existing directory as the folder holding querybara.db', () => {
    const { dir, cleanup } = tempDir();
    try {
      mkdirSync(join(dir, 'data'));
      const location = resolveStorePath({ ...base, cwd: dir, env: {}, flag: 'data' });
      expect(location.path).toBe(join(dir, 'data', 'querybara.db'));
    } finally {
      cleanup();
    }
  });
});

describe('StoreHandle', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

  it('does not create a store for reads, and creates it for writes', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const handle = new StoreHandle({ path: join(dir, 'querybara.db'), source: '--store' }, {});
    expect(handle.open({ create: false })).toBeUndefined();
    expect(handle.exists).toBe(false);
    const store = handle.require();
    expect(store.profiles.count()).toBe(0);
    expect(handle.exists).toBe(true);
    handle.close();
  });

  it('seals with QUERYBARA_PASSPHRASE and cannot save without it', () => {
    expect(cliSealer({ QUERYBARA_PASSPHRASE: 'pp' }).isAvailable()).toBe(true);
    const none = cliSealer({});
    expect(none.id).toBe(UNAVAILABLE_SEALER_ID);
    expect(none.isAvailable()).toBe(false);
    expect(() => none.seal('x')).toThrow(/QUERYBARA_PASSPHRASE/);
  });
});
