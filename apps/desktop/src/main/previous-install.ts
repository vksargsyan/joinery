import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, sep } from 'node:path';

import { ER_MODEL_FORMAT } from '@querybara/ipc';
import { migrate, openDatabase, type SqliteDatabase } from '@querybara/storage';

/**
 * Moves a 0.1.0 install's data into this app's data folder on first launch (ADR 0033). Version
 * 0.1.0 shipped under the app's previous name, so its data lives in a sibling folder of
 * `userData`. When this app has no store yet and that folder has one, the store, the known
 * hosts, the converted SSH keys and Chromium's `Local State` (which holds the safeStorage key on
 * Windows) are copied in. The old folder is only read, never changed.
 *
 * The store is copied first into a staging folder, checked, brought to this build's schema, its
 * stored values written under the old name translated, and only then renamed into place: the
 * new store's presence records that the move ran, so it runs once. Any failure leaves nothing
 * behind and the app starts with empty data.
 *
 * Saved passwords stay sealed as they were. On Windows the copied `Local State` lets
 * safeStorage open them. On macOS and Linux the key belongs to the old app's Keychain or
 * secret service entry, so they read as unreadable and the app asks for them once, as it does
 * for any saved secret it cannot open.
 */

// The app's name before 0.1.1: its data folder and its store file.
export const PREVIOUS_DIR_NAME = 'Joinery';
export const PREVIOUS_STORE_FILE = 'joinery.db';

/** This app's store file, in `userData`. */
export const STORE_FILE = 'querybara.db';
export const KNOWN_HOSTS_FILE = 'known_hosts';
export const SSH_KEYS_DIR = 'ssh-keys';
/** Chromium's own state; on Windows it holds the key safeStorage seals secrets with. */
export const LOCAL_STATE_FILE = 'Local State';

/** The id 0.1.0 used where a stored value carried the name in lower case. */
const PREVIOUS_ID = PREVIOUS_DIR_NAME.toLowerCase();
/** 0.1.0's backup archive format and extension, now `qbak`. */
const PREVIOUS_ARCHIVE_FORMAT = 'jbak';
const ARCHIVE_FORMAT = 'qbak';
const BACKUP_METHOD = 'querybara';
/** The connection option's default, sent as PostgreSQL's application_name and the like. */
const APPLICATION_NAME = 'Querybara';

export interface PreviousInstallOptions {
  /** Electron's `appData`: the folder that holds both apps' data folders. */
  readonly appDataDir: string;
  /** This app's `userData`. */
  readonly userDataDir: string;
  readonly log?: (message: string) => void;
}

export type PreviousInstallResult =
  | { readonly status: 'skipped'; readonly reason: 'has-data' | 'no-previous-data' }
  | { readonly status: 'migrated'; readonly from: string; readonly copied: readonly string[] }
  | { readonly status: 'failed'; readonly from: string; readonly error: string };

/**
 * Copies a 0.1.0 install's data into `userDataDir` once. Never throws: a failure is logged and
 * returned, and the caller opens a fresh store as usual.
 */
export function migratePreviousInstall(options: PreviousInstallOptions): PreviousInstallResult {
  const log = options.log ?? ((message: string) => console.info(message));
  const userData = options.userDataDir;
  const from = join(options.appDataDir, PREVIOUS_DIR_NAME);
  if (existsSync(join(userData, STORE_FILE))) return { status: 'skipped', reason: 'has-data' };
  const oldStore = join(from, PREVIOUS_STORE_FILE);
  if (from === userData || !isFile(oldStore)) {
    return { status: 'skipped', reason: 'no-previous-data' };
  }
  let staging: string | undefined;
  try {
    mkdirSync(userData, { recursive: true });
    staging = join(userData, `.moving-${randomBytes(4).toString('hex')}`);
    mkdirSync(staging, { mode: 0o700 });
    const staged = stageStore(oldStore, join(staging, STORE_FILE));
    const db = openDatabase(staged);
    try {
      checkIntegrity(db);
      migrate(db);
      db.transaction(() => translate(db, from, userData));
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    const copied = [STORE_FILE, ...copyFiles(from, userData)];
    // Another start may have created a store meanwhile; theirs wins.
    if (existsSync(join(userData, STORE_FILE))) return { status: 'skipped', reason: 'has-data' };
    renameSync(staged, join(userData, STORE_FILE));
    if (process.platform !== 'win32') chmodSync(join(userData, STORE_FILE), 0o600);
    log(`[migrate] Copied the data of version 0.1.0 from ${from}: ${copied.join(', ')}`);
    return { status: 'migrated', from, copied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `[migrate] Could not copy the data of version 0.1.0 from ${from}; starting fresh: ${message}`,
    );
    return { status: 'failed', from, error: message };
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Copies the store and its write-ahead log, without the shared-memory index, which SQLite
 * rebuilds from the log. If the old app writes while the copy runs, the copy is taken again.
 */
function stageStore(oldStore: string, staged: string): string {
  const files = [oldStore, `${oldStore}-wal`];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = files.map(stamp);
    rmSync(staged, { force: true });
    rmSync(`${staged}-wal`, { force: true });
    copyFileSync(oldStore, staged);
    if (existsSync(`${oldStore}-wal`)) copyFileSync(`${oldStore}-wal`, `${staged}-wal`);
    if (files.map(stamp).join() === before.join()) break;
  }
  if (process.platform !== 'win32') chmodSync(staged, 0o600);
  return staged;
}

function checkIntegrity(db: SqliteDatabase): void {
  const row = db.get('PRAGMA quick_check');
  const result = row ? Object.values(row)[0] : undefined;
  if (result !== 'ok') throw new Error(`the old store is damaged (${String(result)})`);
}

/** Copies the files beside the store that this app has not got yet. */
function copyFiles(from: string, userData: string): string[] {
  const copied: string[] = [];
  for (const name of [KNOWN_HOSTS_FILE, LOCAL_STATE_FILE]) {
    const source = join(from, name);
    if (!isFile(source) || existsSync(join(userData, name))) continue;
    copyFileSync(source, join(userData, name), constants.COPYFILE_EXCL);
    copied.push(name);
  }
  const keys = join(from, SSH_KEYS_DIR);
  if (isDirectory(keys)) {
    const target = join(userData, SSH_KEYS_DIR);
    cpSync(keys, target, { recursive: true, force: false, errorOnExist: false });
    if (process.platform !== 'win32') chmodSync(target, 0o700);
    copied.push(SSH_KEYS_DIR);
  }
  return copied;
}

/**
 * Rewrites the stored values 0.1.0 wrote under its name, or with paths into its folder, as this
 * build reads them. Runs in the staged copy's transaction.
 */
function translate(db: SqliteDatabase, from: string, userData: string): void {
  // ER model drafts this build would otherwise read as no draft.
  db.run(
    `UPDATE er_model_drafts SET document = json_set(document, '$.format', ?)
     WHERE json_valid(document) AND json_extract(document, '$.format') = ?`,
    [ER_MODEL_FORMAT, `${PREVIOUS_ID}.er-model`],
  );
  // Scheduled backups: the archive format, the built-in method and the file name template.
  const backups = `kind = 'backup' AND json_valid(task)`;
  db.run(
    `UPDATE schedules SET task = json_set(task, '$.job.format', ?)
     WHERE ${backups} AND json_extract(task, '$.job.format') = ?`,
    [ARCHIVE_FORMAT, PREVIOUS_ARCHIVE_FORMAT],
  );
  db.run(
    `UPDATE schedules SET task = json_set(task, '$.job.method', ?)
     WHERE ${backups} AND json_extract(task, '$.job.method') = ?`,
    [BACKUP_METHOD, PREVIOUS_ID],
  );
  db.run(
    `UPDATE schedules SET task = json_set(task, '$.output.fileName',
       substr(json_extract(task, '$.output.fileName'), 1,
         length(json_extract(task, '$.output.fileName')) - 4) || ?)
     WHERE ${backups} AND json_extract(task, '$.output.fileName') LIKE ?`,
    [ARCHIVE_FORMAT, `%.${PREVIOUS_ARCHIVE_FORMAT}`],
  );
  // Profiles: the default application name, and SSH keys converted into the old folder.
  const oldKeys = join(from, SSH_KEYS_DIR) + sep;
  const newKeys = join(userData, SSH_KEYS_DIR) + sep;
  for (const row of db.all('SELECT id, data FROM profiles')) {
    const text = row['data'];
    if (typeof text !== 'string') continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    const options = isRecord(data) ? data['options'] : undefined;
    let changed = false;
    if (isRecord(options) && options['applicationName'] === PREVIOUS_DIR_NAME) {
      options['applicationName'] = APPLICATION_NAME;
      changed = true;
    }
    const moved = movePaths(data, oldKeys, newKeys);
    if (changed || moved.changed) {
      db.run('UPDATE profiles SET data = ? WHERE id = ?', [
        JSON.stringify(moved.value),
        row['id']!,
      ]);
    }
  }
}

function movePaths(
  value: unknown,
  oldPrefix: string,
  newPrefix: string,
): { value: unknown; changed: boolean } {
  if (typeof value === 'string' && value.startsWith(oldPrefix)) {
    return { value: newPrefix + value.slice(oldPrefix.length), changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const moved = movePaths(item, oldPrefix, newPrefix);
      changed ||= moved.changed;
      return moved.value;
    });
    return { value: next, changed };
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const moved = movePaths(item, oldPrefix, newPrefix);
      changed ||= moved.changed;
      next[key] = moved.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function stamp(path: string): string {
  try {
    const info = statSync(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return 'none';
  }
}
