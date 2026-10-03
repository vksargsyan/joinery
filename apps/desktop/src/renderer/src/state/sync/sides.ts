import { ENGINES, isSqlEngine, type EngineId } from '@querybara/core';
import type { JobInfo, SyncSide } from '@querybara/ipc';

/**
 * The two sides of a comparison as the setup form edits them (spec §13), and the checks that
 * run before a compare starts. Main and the job runner check again; these only save a round
 * trip and say what to fix.
 */

export type SideRole = 'source' | 'target';

export interface SideDraft {
  readonly profileId: string | undefined;
  /** PostgreSQL: the database to connect to; MySQL and MariaDB: the database to compare. */
  readonly database: string;
  /** PostgreSQL schemas, comma-separated; empty for every non-system schema. */
  readonly schemas: string;
}

/** What the setup needs to know about a connection. */
export interface SideProfile {
  readonly id: string;
  readonly name: string;
  readonly engine: EngineId;
  readonly defaultDatabase: string | undefined;
  readonly readOnly: boolean;
  readonly production: boolean;
  readonly confirmWrites: boolean;
}

export type ProfileLookup = (profileId: string) => SideProfile | undefined;

export const EMPTY_SIDE: SideDraft = { profileId: undefined, database: '', schemas: '' };

export function sideDraft(init: Partial<SideDraft> | undefined): SideDraft {
  return { ...EMPTY_SIDE, ...init };
}

/** "public, sales" → ['public', 'sales']. */
export function parseNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];
}

/** The side as the contract takes it. */
export function sideInput(draft: SideDraft, profile: SideProfile | undefined): SyncSide {
  const schemas = profile?.engine === 'postgres' ? parseNames(draft.schemas) : [];
  const database = draft.database.trim();
  return {
    profileId: draft.profileId ?? '',
    ...(database !== '' ? { database } : {}),
    ...(schemas.length > 0 ? { schemas } : {}),
  };
}

const family = (engine: EngineId): string => (engine === 'postgres' ? 'postgres' : 'mysql');

/**
 * Why the pair cannot be compared yet, or undefined. Structure compare pairs PostgreSQL with
 * PostgreSQL and MySQL or MariaDB with either; data compare also crosses families, with one
 * PostgreSQL schema.
 */
export function pairProblem(
  source: SideDraft,
  target: SideDraft,
  lookup: ProfileLookup,
  kind: 'structure' | 'data',
): string | undefined {
  const profiles: Partial<Record<SideRole, SideProfile>> = {};
  for (const [role, draft] of [
    ['source', source],
    ['target', target],
  ] as const) {
    if (draft.profileId === undefined) return `Choose the ${role} connection`;
    const profile = lookup(draft.profileId);
    if (!profile) return `The ${role} connection was deleted; choose another`;
    if (!isSqlEngine(profile.engine)) {
      return `${ENGINES[profile.engine].displayName} connections cannot be compared here`;
    }
    const database = draft.database.trim() || profile.defaultDatabase;
    if (profile.engine !== 'postgres' && !database) return `Choose the ${role} database`;
    profiles[role] = profile;
  }
  const from = profiles.source!;
  const to = profiles.target!;
  const sameDatabase =
    from.id === to.id &&
    (source.database.trim() || from.defaultDatabase) ===
      (target.database.trim() || to.defaultDatabase) &&
    parseNames(source.schemas).join() === parseNames(target.schemas).join();
  if (sameDatabase) return 'The source and the target are the same database';
  if (family(from.engine) !== family(to.engine)) {
    if (kind === 'structure') {
      return `The structure of ${ENGINES[from.engine].displayName} and ${ENGINES[to.engine].displayName} cannot be compared; move data across engines with data compare or transfer`;
    }
    const pgSide = from.engine === 'postgres' ? source : target;
    if (parseNames(pgSide.schemas).length !== 1) {
      return 'Name one PostgreSQL schema to compare with the MySQL or MariaDB database';
    }
  }
  return undefined;
}

/** Warnings worth showing before comparing (MySQL ↔ MariaDB, spec §13). */
export function pairWarnings(
  source: SideDraft,
  target: SideDraft,
  lookup: ProfileLookup,
): string[] {
  const from = source.profileId !== undefined ? lookup(source.profileId) : undefined;
  const to = target.profileId !== undefined ? lookup(target.profileId) : undefined;
  if (!from || !to || from.engine === to.engine) return [];
  if (from.engine !== 'postgres' && to.engine !== 'postgres') {
    return [
      `${ENGINES[from.engine].displayName} and ${ENGINES[to.engine].displayName} differ in places (types, defaults, JSON); the comparison warns where a script may not carry over.`,
    ];
  }
  return [];
}

/** Why a finished job did not do its work, for the panel's error line. */
export function jobFailure(job: JobInfo): string {
  const first = job.errors[0]?.message;
  const outcome = job.summary?.outcome;
  if (job.error)
    return job.error.hint ? `${job.error.message}. ${job.error.hint}` : job.error.message;
  if (first && outcome) return `${first}. ${outcome}`;
  return first ?? outcome ?? 'The job failed';
}

/** The side a comparison shows for a connection: its name and database. */
export function sideTitle(draft: SideDraft, lookup: ProfileLookup): string {
  const profile = draft.profileId !== undefined ? lookup(draft.profileId) : undefined;
  if (!profile) return '…';
  const database = draft.database.trim() || profile.defaultDatabase;
  return database ? `${profile.name} (${database})` : profile.name;
}
