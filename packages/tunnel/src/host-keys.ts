import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { QuerybaraError } from '@querybara/core';

import { hostLabel } from './errors';

/**
 * SSH host key verification. Querybara never accepts an unknown host key silently: every SSH
 * connection asks a HostKeyVerifier, which trusts a key it knows, rejects a changed key loudly,
 * and decides about a new key by policy (reject, accept-new, or ask the user).
 */

export interface HostKeyInfo {
  /** The host key's algorithm, e.g. ssh-ed25519 or ssh-rsa. */
  readonly algorithm: string;
  /** `SHA256:…` (unpadded base64), exactly as `ssh-keygen -lf` and OpenSSH print it. */
  readonly fingerprintSha256: string;
}

export type HostKeyDecision = 'trust' | 'reject';

/**
 * Decides whether to trust the host key an SSH server presented. `host` and `port` are the hop as
 * the profile names it (for a jump host's next hop, the name the previous hop resolves). It may
 * prompt the user: the connect timeout is paused while it runs. Throwing a QuerybaraError rejects
 * the key with that error.
 */
export type HostKeyVerifier = (
  host: string,
  port: number,
  key: HostKeyInfo,
) => HostKeyDecision | Promise<HostKeyDecision>;

export interface KnownHostKey extends HostKeyInfo {
  readonly host: string;
  readonly port: number;
}

/** Remembered host key fingerprints, per host and port. */
export interface KnownHostsStore {
  lookup(host: string, port: number): Promise<readonly KnownHostKey[]>;
  remember(key: KnownHostKey): Promise<void>;
  /** Forgets every key of host:port, e.g. after the user confirmed a changed key out of band. */
  forget(host: string, port: number): Promise<void>;
}

const normalHost = (host: string): string => host.toLowerCase();
const storeKey = (host: string, port: number): string => `[${normalHost(host)}]:${port}`;

/** An in-process known-hosts store, for tests and for trust that lasts one app session. */
export class MemoryKnownHosts implements KnownHostsStore {
  private readonly keys = new Map<string, KnownHostKey[]>();

  constructor(initial: readonly KnownHostKey[] = []) {
    for (const key of initial) this.add(key);
  }

  async lookup(host: string, port: number): Promise<readonly KnownHostKey[]> {
    return [...(this.keys.get(storeKey(host, port)) ?? [])];
  }

  async remember(key: KnownHostKey): Promise<void> {
    this.add(key);
  }

  async forget(host: string, port: number): Promise<void> {
    this.keys.delete(storeKey(host, port));
  }

  /** Every remembered key. */
  entries(): KnownHostKey[] {
    return [...this.keys.values()].flat();
  }

  private add(key: KnownHostKey): void {
    const id = storeKey(key.host, key.port);
    const list = this.keys.get(id) ?? [];
    if (!list.some((k) => k.fingerprintSha256 === key.fingerprintSha256)) {
      list.push({ ...key, host: normalHost(key.host) });
    }
    this.keys.set(id, list);
  }
}

const LINE = /^\[(.+)\]:(\d+)\s+(\S+)\s+(SHA256:[A-Za-z0-9+/]+)\s*$/;

/**
 * A known-hosts file of fingerprints, one `[host]:port algorithm SHA256:…` line per key; `#`
 * comments and blank lines are kept. The file is re-read on every lookup, so several processes
 * (the app and querybara-cli) can share it, and written atomically with owner-only permissions.
 */
export class FileKnownHosts implements KnownHostsStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async lookup(host: string, port: number): Promise<readonly KnownHostKey[]> {
    const id = storeKey(host, port);
    return (await this.read()).keys.filter((key) => storeKey(key.host, key.port) === id);
  }

  remember(key: KnownHostKey): Promise<void> {
    return this.update((lines, keys) => {
      const id = storeKey(key.host, key.port);
      const known = keys.some(
        (k) => storeKey(k.host, k.port) === id && k.fingerprintSha256 === key.fingerprintSha256,
      );
      return known ? lines : [...lines, formatLine(key)];
    });
  }

  forget(host: string, port: number): Promise<void> {
    const id = storeKey(host, port);
    return this.update((lines) =>
      lines.filter((line) => {
        const match = LINE.exec(line.trim());
        return !match || storeKey(match[1]!, Number(match[2])) !== id;
      }),
    );
  }

  private async read(): Promise<{ lines: string[]; keys: KnownHostKey[] }> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { lines: [], keys: [] };
      }
      throw new QuerybaraError(
        {
          code: 'SSH_FAILED',
          message: `Cannot read the known hosts file ${this.path}`,
          hint: 'Check that the file exists and that Querybara can read it',
        },
        { cause: error },
      );
    }
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const keys: KnownHostKey[] = [];
    for (const line of lines) {
      const match = LINE.exec(line.trim());
      if (!match) continue;
      keys.push({
        host: match[1]!,
        port: Number(match[2]),
        algorithm: match[3]!,
        fingerprintSha256: match[4]!,
      });
    }
    return { lines, keys };
  }

  private update(change: (lines: string[], keys: KnownHostKey[]) => string[]): Promise<void> {
    const run = this.writing.then(async () => {
      const { lines, keys } = await this.read();
      const next = change(lines, keys);
      if (next === lines) return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(temp, next.length ? `${next.join('\n')}\n` : '', { mode: 0o600 });
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true });
        throw new QuerybaraError(
          {
            code: 'SSH_FAILED',
            message: `Cannot write the known hosts file ${this.path}`,
            hint: 'Check that Querybara can write to that folder',
          },
          { cause: error },
        );
      }
    });
    this.writing = run.catch(() => undefined);
    return run;
  }
}

function formatLine(key: KnownHostKey): string {
  return `${storeKey(key.host, key.port)} ${key.algorithm} ${key.fingerprintSha256}`;
}

/** What to do with a host key the store does not know yet. */
export type UnknownHostKeyPolicy = 'reject' | 'accept-new' | HostKeyVerifier;

/**
 * The loud error for a host key that differs from the remembered one: it may be a
 * man-in-the-middle attack, so Querybara refuses to connect (engineCode HOST_KEY_CHANGED).
 */
export function hostKeyChangedError(
  host: string,
  port: number,
  presented: HostKeyInfo,
  known: readonly HostKeyInfo[],
): QuerybaraError {
  const expected = known.map((k) => `${k.algorithm} ${k.fingerprintSha256}`).join(', ');
  return new QuerybaraError({
    code: 'SSH_FAILED',
    message:
      `WARNING: the host key of the SSH server ${hostLabel(host, port)} has CHANGED ` +
      `(expected ${expected}, got ${presented.algorithm} ${presented.fingerprintSha256}). ` +
      'Someone could be intercepting this connection (a man-in-the-middle attack), or the server was reinstalled. Querybara did not connect.',
    hint: "Ask the server's administrator whether its host key changed. Only if it did, forget the old key for this host and connect again to trust the new one",
    engineCode: 'HOST_KEY_CHANGED',
  });
}

/**
 * A verifier backed by a known-hosts store: a remembered fingerprint is trusted, a different key
 * for a known host throws hostKeyChangedError, and a new host follows `onUnknown` — `reject`
 * (strict), `accept-new` (trust on first use, like OpenSSH's StrictHostKeyChecking=accept-new),
 * or a verifier that asks the user. Trusted new keys are remembered.
 */
export function knownHostsVerifier(
  store: KnownHostsStore,
  onUnknown: UnknownHostKeyPolicy,
): HostKeyVerifier {
  return async (host, port, key) => {
    const known = await store.lookup(host, port);
    if (known.some((k) => k.fingerprintSha256 === key.fingerprintSha256)) return 'trust';
    if (known.length > 0) throw hostKeyChangedError(host, port, key, known);
    const decision =
      onUnknown === 'reject'
        ? 'reject'
        : onUnknown === 'accept-new'
          ? 'trust'
          : await onUnknown(host, port, key);
    if (decision === 'trust') await store.remember({ host, port, ...key });
    return decision;
  };
}
