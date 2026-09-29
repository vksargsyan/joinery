import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import { JoineryError } from '@joinery/core';
import { createPassphraseSealer, openStore, type SecretSealer, type Store } from '@joinery/storage';

/** The desktop app's store file name inside Electron `userData` (apps/desktop main process). */
export const STORE_FILE_NAME = 'joinery.db';
/** Electron app name, and so the `userData` folder name. */
export const APP_DIR_NAME = 'Joinery';

export interface StorePathInput {
  /** --store */
  readonly flag?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly cwd: string;
}

export interface StoreLocation {
  readonly path: string;
  /** Where the path came from, for --verbose and error hints. */
  readonly source: '--store' | 'JOINERY_STORE' | 'JOINERY_USER_DATA_DIR' | 'default';
}

/**
 * The directory Electron uses as `userData` for an app named "Joinery": `~/.config/Joinery`
 * (or `$XDG_CONFIG_HOME/Joinery`) on Linux, `~/Library/Application Support/Joinery` on macOS
 * and `%APPDATA%\Joinery` on Windows. The CLI shares the desktop app's store there.
 */
export function defaultDataDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  homedir: string,
): string {
  switch (platform) {
    case 'win32':
      return win32.join(env['APPDATA'] || win32.join(homedir, 'AppData', 'Roaming'), APP_DIR_NAME);
    case 'darwin':
      return posix.join(homedir, 'Library', 'Application Support', APP_DIR_NAME);
    default:
      return posix.join(env['XDG_CONFIG_HOME'] || posix.join(homedir, '.config'), APP_DIR_NAME);
  }
}

/**
 * Where the local store lives: `--store`, then `JOINERY_STORE`, then `JOINERY_USER_DATA_DIR`
 * (the desktop app's own override of `userData`), then the desktop app's default. A path that
 * is an existing directory means the store file inside it.
 */
export function resolveStorePath(input: StorePathInput): StoreLocation {
  const path = input.platform === 'win32' ? win32 : posix;
  const pick = (): StoreLocation => {
    if (input.flag) return { path: path.resolve(input.cwd, input.flag), source: '--store' };
    const fromEnv = input.env['JOINERY_STORE'];
    if (fromEnv) return { path: path.resolve(input.cwd, fromEnv), source: 'JOINERY_STORE' };
    const userData = input.env['JOINERY_USER_DATA_DIR'];
    if (userData) {
      return {
        path: path.join(path.resolve(input.cwd, userData), STORE_FILE_NAME),
        source: 'JOINERY_USER_DATA_DIR',
      };
    }
    return {
      path: path.join(defaultDataDir(input.platform, input.env, input.homedir), STORE_FILE_NAME),
      source: 'default',
    };
  };
  const location = pick();
  if (location.source !== 'JOINERY_USER_DATA_DIR' && location.source !== 'default') {
    try {
      if (statSync(location.path).isDirectory()) {
        return { ...location, path: path.join(location.path, STORE_FILE_NAME) };
      }
    } catch {
      // Not there yet: it is the file to create.
    }
  }
  return location;
}

/** Sealer id of the CLI when no JOINERY_PASSPHRASE is set: nothing can be saved or unsealed. */
export const UNAVAILABLE_SEALER_ID = 'joinery-cli-none';

/**
 * The CLI cannot use Electron safeStorage, so it seals with a passphrase from
 * JOINERY_PASSPHRASE. Without one, saving a secret fails with a hint, and values sealed by the
 * desktop app (or another passphrase) read as unreadable, which the target resolver turns into
 * an environment variable lookup or a prompt.
 */
export function cliSealer(env: Readonly<Record<string, string | undefined>>): SecretSealer {
  const passphrase = env['JOINERY_PASSPHRASE'];
  if (passphrase) return createPassphraseSealer(passphrase);
  const unavailable = (): never => {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: 'Secrets cannot be saved without JOINERY_PASSPHRASE',
      hint: 'Set JOINERY_PASSPHRASE to seal saved passwords with a passphrase',
    });
  };
  return {
    id: UNAVAILABLE_SEALER_ID,
    isAvailable: () => false,
    seal: unavailable,
    unseal: unavailable,
  };
}

/**
 * Opens the store on first use. Commands that only read (list, show, resolving a profile) do
 * not create a store that does not exist yet, so a CI job that only uses URIs leaves no file
 * behind.
 */
export class StoreHandle {
  #store: Store | undefined;

  constructor(
    readonly location: StoreLocation,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  get exists(): boolean {
    return this.#store !== undefined || existsSync(this.location.path);
  }

  /** The store, or undefined when it does not exist and `create` is false. */
  open(options: { readonly create: boolean }): Store | undefined {
    if (this.#store) return this.#store;
    if (!options.create && !existsSync(this.location.path)) return undefined;
    this.#store = openStore(this.location.path, { sealer: cliSealer(this.env) });
    return this.#store;
  }

  /** The store, creating it when needed. */
  require(): Store {
    this.#store ??= openStore(this.location.path, { sealer: cliSealer(this.env) });
    return this.#store;
  }

  close(): void {
    this.#store?.close();
    this.#store = undefined;
  }
}
