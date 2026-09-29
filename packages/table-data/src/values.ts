import type { CellValue, LargeValueHandle } from '@joinery/core';

/**
 * The value a staged edit or insert writes: a cell value, or DEFAULT (spec §7: NULL, empty
 * string and DEFAULT are distinct states). DEFAULT is a frozen marker object rather than a
 * symbol so change sets, pasted rows and plans survive structured clone across MessagePorts;
 * test for it with `isDefault`, never by identity.
 */
export interface DefaultValue {
  readonly $default: true;
}

/** Use the column default: omitted from INSERT, `SET col = DEFAULT` in UPDATE. */
export const DEFAULT: DefaultValue = Object.freeze({ $default: true as const });

export type EditValue = CellValue | DefaultValue;

/** Whether a value is the DEFAULT marker (also after structured clone). */
export function isDefault(value: unknown): value is DefaultValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    (value as { $default?: unknown }).$default === true
  );
}

/** A preview of a value too large to ship inline; it cannot be written or matched on. */
export function isLargeValue(value: unknown): value is LargeValueHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    typeof (value as { $handle?: unknown }).$handle === 'string'
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether two values are the same for change tracking: editing a cell back to this value
 * clears the edit. NULL, '' and DEFAULT all differ; bytes compare by content; a number and a
 * bigint of equal integer value are the same (drivers pick the type by magnitude); -0 and 0
 * differ, NaN equals NaN.
 */
export function sameValue(a: EditValue | undefined, b: EditValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isDefault(a) || isDefault(b)) return isDefault(a) && isDefault(b);
  if (a === null || b === null) return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b);
  }
  if (isLargeValue(a) || isLargeValue(b)) {
    return isLargeValue(a) && isLargeValue(b) && a.$handle === b.$handle;
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = typeof a === 'number' && Number.isInteger(a) ? BigInt(a) : a;
    const y = typeof b === 'number' && Number.isInteger(b) ? BigInt(b) : b;
    return x === y;
  }
  return Object.is(a, b);
}

/** Lower-case hex of some bytes (no prefix). */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
