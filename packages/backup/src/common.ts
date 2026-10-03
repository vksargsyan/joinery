import { QuerybaraError } from '@querybara/core';

import type { RestoreConflict } from './types';
import { plural } from './util';

/** Rules every engine's backup and restore share. */

/** A file-name-safe rendering of an object name, for archive entry names. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 80) || '_';
}

/**
 * The write rule for restores (spec §14), applied in the process that runs the restore:
 * restoring over existing objects is destructive, so it refuses to start unless the caller
 * confirmed every one of the conflicts it found just now.
 */
export function checkConfirmed(
  conflicts: readonly RestoreConflict[],
  confirmed: readonly string[] | undefined,
): void {
  const ok = new Set(confirmed ?? []);
  const missing = conflicts.filter((c) => !ok.has(c.id));
  if (missing.length === 0) return;
  const drops = missing.filter((c) => c.action === 'drop');
  const names = missing
    .slice(0, 10)
    .map((c) => c.qualifiedName)
    .join(', ');
  const more = missing.length > 10 ? ', …' : '';
  throw new QuerybaraError({
    code: 'CONFIRMATION_REQUIRED',
    message:
      drops.length > 0
        ? `Restoring drops ${plural(drops.length, 'existing object')} first and needs confirmation: ${names}${more}`
        : `Restoring writes over existing data and needs confirmation: ${names}${more}`,
  });
}
