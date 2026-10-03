import { versionConflict } from './errors';

/**
 * Every syncable row (profiles, folders, saved queries, snippets, settings) carries a version
 * that each write bumps by one (spec §16: per-item versions for sync).
 */
export interface WriteOptions {
  /**
   * Optimistic concurrency: fail unless the stored version equals this (0 means "must not exist
   * yet"). Guards against the desktop app and querybara-cli overwriting each other's edits.
   */
  readonly expectedVersion?: number;
}

export function checkVersion(
  what: string,
  id: string,
  expected: number | undefined,
  actual: number,
): void {
  if (expected !== undefined && expected !== actual) {
    throw versionConflict(what, id, expected, actual);
  }
}

/** Drops keys whose value is undefined, so a patch overrides only the fields it names. */
export function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
