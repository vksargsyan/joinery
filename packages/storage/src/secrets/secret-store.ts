import {
  QuerybaraError,
  secretRefSchema,
  secretRefsOf,
  type ConnectionProfile,
  type SecretRef,
  type SecretRefInput,
} from '@querybara/core';

import type { RepositoryContext } from '../internal/context';
import { parseOrThrow } from '../internal/errors';
import { isReservedSecretId, secretRecord } from '../internal/redact';
import { readBlob, readText } from '../internal/rows';
import type { SqliteDatabase } from '../sqlite';
import type { SecretSealer } from './sealer';

/** The outcome of `SecretStore.resolve`: what can be used now and what to prompt for. */
export interface ResolvedSecrets {
  /** Plaintext by SecretRef.id. JSON, inspect and string forms show `[redacted]` instead. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Refs without a usable value: the caller prompts for these. Includes `unreadable`. */
  readonly missing: readonly SecretRef[];
  /** Saved refs whose sealed value exists but cannot be unsealed (other machine, new keychain). */
  readonly unreadable: readonly SecretRef[];
}

type Lookup =
  | { readonly status: 'found'; readonly value: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' };

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Secret values for connection profiles (spec §4). Each `SecretRef` carries the user's policy:
 *
 * - `save`: sealed by the `SecretSealer` and stored in the `secrets` table.
 * - `session`: kept in this process's memory until `clearSession()` or exit.
 * - `ask`: never stored; `resolve` always reports it missing so the caller prompts.
 *
 * Plaintext never reaches the database file, error messages, or the JSON / inspect form of any
 * object this class returns (spec §18).
 */
export class SecretStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;
  readonly #sealer: SecretSealer;
  readonly #session = new Map<string, string>();

  constructor(context: RepositoryContext, sealer: SecretSealer) {
    this.#db = context.db;
    this.#now = context.now;
    this.#sealer = sealer;
  }

  /** Whether secrets with the `save` policy can be stored on this machine right now. */
  canSave(): boolean {
    return this.#sealer.isAvailable();
  }

  /**
   * Stores `value` as the ref's policy says. Changing a ref's policy moves the value: saving
   * drops the in-memory copy, `session` deletes the sealed copy, and `ask` deletes both.
   */
  set(refInput: SecretRefInput, value: string): void {
    const ref = parseSecretRef(refInput);
    if (typeof value !== 'string') {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'Secret values must be strings',
      });
    }
    switch (ref.policy) {
      case 'save': {
        if (!this.#sealer.isAvailable()) {
          throw new QuerybaraError({
            code: 'NOT_SUPPORTED',
            message: 'Secure storage is not available, so the secret cannot be saved',
            hint: 'Choose "remember for this session" or "ask every time" instead.',
          });
        }
        const sealed = this.#seal(value);
        const now = this.#now();
        this.#db.run(
          `INSERT INTO secrets (id, sealer, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             sealer = excluded.sealer, sealed = excluded.sealed, updated_at = excluded.updated_at`,
          [ref.id, this.#sealer.id, sealed, now, now],
        );
        this.#session.delete(ref.id);
        return;
      }
      case 'session':
        this.#session.set(ref.id, value);
        this.#deleteSealed(ref.id);
        return;
      case 'ask':
        this.#session.delete(ref.id);
        this.#deleteSealed(ref.id);
        return;
    }
  }

  /** The value for one ref, or undefined when the caller must prompt for it. */
  get(refInput: SecretRefInput): string | undefined {
    const lookup = this.#lookup(parseSecretRef(refInput));
    return lookup.status === 'found' ? lookup.value : undefined;
  }

  /**
   * Collects the values of every secret `profile` references (`secretRefsOf`), so the
   * connection host can connect, and lists the ones the user must be asked for.
   */
  resolve(profile: ConnectionProfile): ResolvedSecrets {
    const values: [string, string][] = [];
    const missing: SecretRef[] = [];
    const unreadable: SecretRef[] = [];
    const seen = new Set<string>();
    for (const ref of secretRefsOf(profile)) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const lookup = this.#lookup(ref);
      if (lookup.status === 'found') {
        values.push([ref.id, lookup.value]);
        continue;
      }
      missing.push(ref);
      if (lookup.status === 'unreadable') unreadable.push(ref);
    }
    return { secrets: secretRecord(values), missing, unreadable };
  }

  /** Deletes the sealed and in-memory copies of a secret. */
  delete(ref: SecretRefInput | string): void {
    const id = typeof ref === 'string' ? ref : parseSecretRef(ref).id;
    this.#session.delete(id);
    this.#deleteSealed(id);
  }

  /** Forgets every "remember for this session" value, e.g. when the app locks or quits. */
  clearSession(): void {
    this.#session.clear();
  }

  /** Drops in-memory values for secrets whose profiles were deleted. */
  forgetSession(ids: Iterable<string>): void {
    for (const id of ids) this.#session.delete(id);
  }

  toJSON(): { sealer: string; sessionSecrets: number } {
    return { sealer: this.#sealer.id, sessionSecrets: this.#session.size };
  }

  toString(): string {
    return `[SecretStore ${this.#sealer.id}]`;
  }

  [INSPECT](): string {
    return this.toString();
  }

  #lookup(ref: SecretRef): Lookup {
    if (ref.policy === 'ask') return { status: 'missing' };
    const remembered = this.#session.get(ref.id);
    if (remembered !== undefined) return { status: 'found', value: remembered };
    if (ref.policy === 'session') return { status: 'missing' };
    const row = this.#db.get('SELECT sealer, sealed FROM secrets WHERE id = ?', [ref.id]);
    if (!row) return { status: 'missing' };
    if (readText(row, 'sealer') !== this.#sealer.id || !this.#sealer.isAvailable()) {
      return { status: 'unreadable' };
    }
    try {
      return { status: 'found', value: this.#sealer.unseal(readBlob(row, 'sealed')) };
    } catch {
      return { status: 'unreadable' };
    }
  }

  #seal(value: string): Uint8Array {
    try {
      return this.#sealer.seal(value);
    } catch (error) {
      // The sealer is pluggable, so its error text is not trusted to be free of the value.
      const reason = error instanceof Error ? error.message : '';
      throw new QuerybaraError({
        code: 'INTERNAL',
        message: 'The secret could not be sealed',
        ...(reason && (value === '' || !reason.includes(value)) ? { detail: reason } : {}),
      });
    }
  }

  #deleteSealed(id: string): void {
    this.#db.run('DELETE FROM secrets WHERE id = ?', [id]);
  }
}

function parseSecretRef(input: SecretRefInput): SecretRef {
  const ref = parseOrThrow(secretRefSchema, input, 'secret reference');
  if (isReservedSecretId(ref.id)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${ref.id}" is reserved and cannot be a secret id`,
    });
  }
  return ref;
}

/**
 * Deletes the sealed values among `ids` that no profile references any more, and returns the
 * ids that are now unreferenced (their session copies should go too). Runs inside the caller's
 * transaction.
 */
export function deleteUnreferencedSecrets(db: SqliteDatabase, ids: Iterable<string>): string[] {
  const released: string[] = [];
  for (const id of new Set(ids)) {
    if (db.get('SELECT 1 AS used FROM profile_secrets WHERE secret_id = ? LIMIT 1', [id])) continue;
    db.run('DELETE FROM secrets WHERE id = ?', [id]);
    released.push(id);
  }
  return released;
}
