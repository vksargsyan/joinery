import {
  QuerybaraError,
  secretRefsOf,
  type ConnectionProfile,
  type ResolvedProfile,
} from '@querybara/core';
import type { Store } from '@querybara/storage';

/**
 * Builds the ResolvedProfile main sends to a connection host: stored and session secrets from
 * the SecretStore, overlaid with the one-call `transient` values the renderer typed (unsaved
 * profiles, "ask every time"). Only refs the profile actually has are taken from `transient`.
 *
 * The secrets record hides its values from JSON, inspect and string conversion, like the
 * store's own, so an accidental log line never shows them (spec §18); structured clone still
 * copies them to the host.
 */
export function resolveProfile(
  store: Store,
  profile: ConnectionProfile,
  transient: Readonly<Record<string, string>> = {},
  options: { readonly requireAll?: boolean } = {},
): ResolvedProfile {
  const stored = store.secrets.resolve(profile);
  const values = new Map<string, string>(Object.entries(stored.secrets));
  for (const ref of secretRefsOf(profile)) {
    const typed = Object.hasOwn(transient, ref.id) ? transient[ref.id] : undefined;
    if (typed === undefined) continue;
    values.set(ref.id, typed);
    // A session secret typed after a restart is remembered for the rest of the session.
    if (ref.policy === 'session') store.secrets.set(ref, typed);
  }
  if (options.requireAll === true) {
    const missing = stored.missing.filter((ref) => !values.has(ref.id));
    if (missing.length > 0) {
      throw new QuerybaraError({
        code: 'AUTH_FAILED',
        message:
          missing.length === 1
            ? 'A secret for this connection is needed'
            : `${missing.length} secrets for this connection are needed`,
        hint: 'Enter the password when asked, or save it in the connection settings.',
      });
    }
  }
  return { profile, secrets: redactedRecord(values) };
}

/**
 * Saves again the values typed for saved secrets whose sealed copy cannot be opened here: sealed
 * on another machine, or by version 0.1.0, whose keychain entry carried the app's previous name.
 * Without this the user is asked for them on every connect. Call it only once the typed values
 * have worked, so a mistyped password is not kept. Never throws: a value that cannot be sealed
 * stays unreadable and is asked for again next time.
 */
export function resaveUnreadableSecrets(
  store: Store,
  profile: ConnectionProfile,
  typed: Readonly<Record<string, string>>,
): void {
  if (!store.secrets.canSave()) return;
  for (const ref of store.secrets.resolve(profile).unreadable) {
    const value = Object.hasOwn(typed, ref.id) ? typed[ref.id] : undefined;
    if (value === undefined) continue;
    try {
      store.secrets.set(ref, value);
    } catch {
      // The connection still works; the user is asked again next time.
    }
  }
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** A frozen id → value record whose JSON, inspect and string forms show "[redacted]". */
export function redactedRecord(
  values: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const record = Object.create(null) as Record<string, string>;
  for (const [id, value] of values) {
    if (id === 'toJSON' || id === 'toString') continue;
    record[id] = value;
  }
  const ids = Object.keys(record);
  const redacted = (): Record<string, string> =>
    Object.fromEntries(ids.map((id) => [id, '[redacted]']));
  Object.defineProperties(record, {
    toJSON: { value: redacted, enumerable: false },
    toString: { value: () => `[secrets: ${ids.length}]`, enumerable: false },
    [INSPECT]: { value: redacted, enumerable: false },
  });
  return Object.freeze(record);
}
