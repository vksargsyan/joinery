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
  it('matches Electron userData for "Joinery" on each platform', () => {
    expect(defaultDataDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/Joinery');
    expect(defaultDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/ada')).toBe('/xdg/Joinery');
    expect(defaultDataDir('freebsd', {}, '/home/ada')).toBe('/home/ada/.config/Joinery');
    expect(defaultDataDir('darwin', {}, '/Users/ada')).toBe(
      '/Users/ada/Library/Application Support/Joinery',
    );
    expect(
      defaultDataDir('win32', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'C:\\Users\\ada'),
    ).toBe('C:\\Users\\ada\\AppData\\Roaming\\Joinery');
    expect(defaultDataDir('win32', {}, 'C:\\Users\\ada')).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\Joinery',
    );
  });

  it('puts the desktop store file joinery.db there', () => {
    const location = resolveStorePath({
      env: {},
      platform: 'darwin',
      homedir: '/Users/ada',
      cwd: '/',
    });
    expect(location).toEqual({
      path: '/Users/ada/Library/Application Support/Joinery/joinery.db',
      source: 'default',
    });
    expect(STORE_FILE_NAME).toBe('joinery.db');
  });
});

describe('store path precedence', () => {
  const base = { platform: 'linux' as const, homedir: '/home/ada', cwd: '/work' };

  it('prefers --store, then JOINERY_STORE, then JOINERY_USER_DATA_DIR', () => {
    const env = { JOINERY_STORE: '/env/store.db', JOINERY_USER_DATA_DIR: '/data' };
    expect(resolveStorePath({ ...base, env, flag: 'my.db' })).toEqual({
      path: '/work/my.db',
      source: '--store',
    });
    expect(resolveStorePath({ ...base, env })).toEqual({
      path: '/env/store.db',
      source: 'JOINERY_STORE',
    });
    expect(resolveStorePath({ ...base, env: { JOINERY_USER_DATA_DIR: 'rel' } })).toEqual({
      path: '/work/rel/joinery.db',
      source: 'JOINERY_USER_DATA_DIR',
    });
  });

  it('resolves Windows paths with Windows rules', () => {
    const location = resolveStorePath({
      platform: 'win32',
      homedir: 'C:\\Users\\ada',
      cwd: 'C:\\work',
      env: { JOINERY_STORE: 'stores\\a.db' },
    });
    expect(location.path).toBe('C:\\work\\stores\\a.db');
  });

  it('treats an existing directory as the folder holding joinery.db', () => {
    const { dir, cleanup } = tempDir();
    try {
      mkdirSync(join(dir, 'data'));
      const location = resolveStorePath({ ...base, cwd: dir, env: {}, flag: 'data' });
      expect(location.path).toBe(join(dir, 'data', 'joinery.db'));
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
    const handle = new StoreHandle({ path: join(dir, 'joinery.db'), source: '--store' }, {});
    expect(handle.open({ create: false })).toBeUndefined();
    expect(handle.exists).toBe(false);
    const store = handle.require();
    expect(store.profiles.count()).toBe(0);
    expect(handle.exists).toBe(true);
    handle.close();
  });

  it('seals with JOINERY_PASSPHRASE and cannot save without it', () => {
    expect(cliSealer({ JOINERY_PASSPHRASE: 'pp' }).isAvailable()).toBe(true);
    const none = cliSealer({});
    expect(none.id).toBe(UNAVAILABLE_SEALER_ID);
    expect(none.isAvailable()).toBe(false);
    expect(() => none.seal('x')).toThrow(/JOINERY_PASSPHRASE/);
  });
});
