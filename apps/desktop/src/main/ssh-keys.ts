import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { JoineryError } from '@joinery/core';
import type { PrivateKeyInfo } from '@joinery/ipc';
import { expandHome, importPrivateKey } from '@joinery/tunnel';

/**
 * SSH private keys picked in the connection dialog (spec §4). Main reads and checks the file, so
 * key material never reaches the renderer: the dialog gets the format, type and fingerprint, and
 * whether a passphrase is needed. A PuTTY key is converted to PEM on import and the copy saved
 * under `keysDir` with owner-only permissions; the profile then points at the copy.
 */

/** Real key files are a few KiB; anything much larger is the wrong file. */
const MAX_KEY_FILE_BYTES = 256 * 1024;

export async function inspectPrivateKey(
  path: string,
  passphrase: string | undefined,
  keysDir: string,
): Promise<PrivateKeyInfo> {
  const file = expandHome(path);
  const text = await readKeyFile(file, path);
  const key = importPrivateKey(text, passphrase);
  const keyPath = key.converted === undefined ? path : await saveConverted(keysDir, file, key);
  return {
    format: key.format,
    encrypted: key.encrypted,
    locked: key.needsPassphrase,
    ...(key.keyType !== undefined ? { keyType: key.keyType } : {}),
    ...(key.fingerprintSha256 !== undefined ? { fingerprintSha256: key.fingerprintSha256 } : {}),
    ...(key.comment ? { comment: key.comment.slice(0, 1000) } : {}),
    keyPath,
    converted: key.converted !== undefined,
  };
}

async function readKeyFile(file: string, shown: string): Promise<string> {
  const unreadable = (reason: string, cause?: unknown): JoineryError =>
    new JoineryError(
      {
        code: 'VALIDATION_FAILED',
        message: `Cannot read the key file "${shown}" (${reason})`,
        hint: 'Choose the private key file (not the .pub file) and check that Joinery can read it',
      },
      cause === undefined ? undefined : { cause },
    );
  try {
    const info = await stat(file);
    if (!info.isFile()) throw unreadable('not a file');
    if (info.size > MAX_KEY_FILE_BYTES) throw unreadable('too large for a private key');
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof JoineryError) throw error;
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    throw unreadable(code, error);
  }
}

/** Saves a converted PuTTY key as `<name>-<digest>.pem`, replacing an earlier import of it. */
async function saveConverted(
  dir: string,
  source: string,
  key: { readonly converted?: string },
): Promise<string> {
  const stem = basename(source, extname(source)).replace(/[^A-Za-z0-9._-]+/g, '_') || 'key';
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const target = join(dir, `${stem}-${digest}.pem`);
  const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temp, key.converted ?? '', { mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw new JoineryError(
      {
        code: 'INTERNAL',
        message: 'The converted PuTTY key could not be saved',
        hint: `Check that Joinery can write to ${dir}`,
      },
      { cause: error },
    );
  }
  return target;
}
