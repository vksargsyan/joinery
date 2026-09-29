/**
 * Keeps secret values out of logs (spec §18). Objects that carry plaintext hide it from
 * JSON.stringify, util.inspect / console.log and string conversion, while plain property access
 * still works. Structured clone (MessagePort, utilityProcess) copies only enumerable own
 * properties, so the values still reach the connection host.
 */

export const REDACTED = '[redacted]';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const RESERVED_IDS = new Set(['toJSON', 'toString']);

/** True for ids that would collide with the redaction hooks of `secretRecord`. */
export function isReservedSecretId(id: string): boolean {
  return RESERVED_IDS.has(id);
}

/**
 * A frozen `id -> plaintext` record whose JSON, inspect and string forms show `[redacted]` for
 * every value. Reserved ids are skipped (the secret store refuses to hold them).
 */
export function secretRecord(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> {
  const record = Object.create(null) as Record<string, string>;
  const ids: string[] = [];
  for (const [id, value] of entries) {
    if (isReservedSecretId(id)) continue;
    record[id] = value;
    ids.push(id);
  }
  const redacted = (): Record<string, string> =>
    Object.fromEntries(ids.map((id) => [id, REDACTED]));
  Object.defineProperties(record, {
    toJSON: { value: redacted, enumerable: false },
    toString: { value: () => `[secrets: ${ids.length}]`, enumerable: false },
    [INSPECT]: { value: redacted, enumerable: false },
  });
  return Object.freeze(record);
}

/**
 * Sets `key` on `target` as a non-enumerable property: reachable by name, skipped by JSON,
 * inspect and object spread. Does nothing when `value` is undefined.
 */
export function defineHiddenSecret(target: object, key: string, value: string | undefined): void {
  if (value !== undefined) {
    Object.defineProperty(target, key, { value, enumerable: false, writable: false });
  }
}
