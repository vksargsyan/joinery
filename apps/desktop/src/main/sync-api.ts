import {
  ENGINES,
  JoineryError,
  isSqlEngine,
  requiresWriteConfirmation,
  type ConnectionProfile,
} from '@joinery/core';
import {
  comparisonDefinitionSchema,
  type ComparisonDefinition,
  type HandlersOf,
  type SavedComparison,
  type mainContract,
} from '@joinery/ipc';
import type { JsonValue, SavedComparisonRecord, Store, StoredProfile } from '@joinery/storage';

import type { FileGrants } from './jobs-api';
import { resolveProfile } from './secrets';
import type { SyncService } from './sync';

/**
 * The main contract's `sync.*` handlers (spec §13): which connections may be compared, the
 * write rules for applying (checked here and again in the job runner, whatever the page sends:
 * a read-only target refuses, a production or confirm-writes target needs `confirmed`), the
 * file grants for exports, and saved comparisons in the local store.
 */

type SyncHandlers = HandlersOf<typeof mainContract>['sync'];

function unavailable(): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message: 'Comparisons cannot run here' });
}

const family = (profile: ConnectionProfile): string =>
  profile.engine === 'postgres' ? 'postgres' : 'mysql';

/** The write rules for applying to a target (spec §4). */
export function checkSyncApply(profile: ConnectionProfile, confirmed: boolean | undefined): void {
  if (profile.presentation.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: `"${profile.name}" is read-only, so nothing can be applied to it`,
    });
  }
  if (requiresWriteConfirmation(profile) && confirmed !== true) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `Applying to ${profile.presentation.environment === 'production' ? 'a production connection' : `"${profile.name}"`} needs confirmation`,
    });
  }
}

/** A stored comparison for the page; a definition an older app wrote reads as empty. */
export function toSavedComparison(record: SavedComparisonRecord): SavedComparison {
  const parsed = comparisonDefinitionSchema.safeParse(record.definition);
  const definition: ComparisonDefinition = parsed.success
    ? parsed.data
    : { source: {}, target: {} };
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    source: { profileId: record.sourceProfileId, ...definition.source },
    target: { profileId: record.targetProfileId, ...definition.target },
    ...(definition.structure !== undefined ? { structure: definition.structure } : {}),
    ...(definition.data !== undefined ? { data: definition.data } : {}),
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

export function syncHandlers(
  services: { readonly store: Store; readonly sync?: SyncService | undefined },
  grants: FileGrants,
): SyncHandlers {
  const { store } = services;
  const service = (): SyncService => {
    if (!services.sync) throw unavailable();
    return services.sync;
  };
  const sqlProfile = (profileId: string, role: 'source' | 'target'): StoredProfile => {
    const profile = store.profiles.get(profileId);
    if (!profile) {
      throw new JoineryError({ code: 'NOT_FOUND', message: `The ${role} connection was deleted` });
    }
    if (!isSqlEngine(profile.engine)) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `${ENGINES[profile.engine].displayName} connections cannot be compared here`,
        hint: 'Structure and data compare work with MySQL, MariaDB and PostgreSQL.',
      });
    }
    return profile;
  };
  const resolve = (profile: StoredProfile, secrets: Readonly<Record<string, string>> = {}) =>
    resolveProfile(store, profile, secrets, { requireAll: true });

  return {
    structure: {
      compare: ({ source, target, options, secrets }) => {
        const from = sqlProfile(source.profileId, 'source');
        const to = sqlProfile(target.profileId, 'target');
        if (family(from) !== family(to)) {
          throw new JoineryError({
            code: 'NOT_SUPPORTED',
            message: `Cannot compare the structure of ${ENGINES[from.engine].displayName} with ${ENGINES[to.engine].displayName}`,
            hint: 'Pair PostgreSQL with PostgreSQL, and MySQL or MariaDB with MySQL or MariaDB.',
          });
        }
        const jobId = service().startStructureCompare(
          { source, target, options },
          { source: resolve(from, secrets), target: resolve(to, secrets) },
        );
        return { jobId };
      },
      result: ({ jobId }) => service().structureResult(jobId),
      script: ({ jobId, selected }) => service().structureScript(jobId, selected),
      apply: ({ jobId, selected, scriptSha256, confirmed, secrets }) => {
        const sync = service();
        const target = sqlProfile(sync.structureTarget(jobId), 'target');
        checkSyncApply(target, confirmed);
        const applyId = sync.startStructureApply(
          { jobId, selected, scriptSha256, confirmed: confirmed === true },
          resolve(target, secrets),
        );
        return { jobId: applyId };
      },
      export: ({ jobId, selected, format, path }) => {
        grants.checkWrite(path);
        return service().exportStructure({ jobId, selected, format, path });
      },
    },
    data: {
      compare: ({ source, target, options, tables, secrets }) => {
        const from = sqlProfile(source.profileId, 'source');
        const to = sqlProfile(target.profileId, 'target');
        const jobId = service().startDataCompare(
          { source, target, options, ...(tables !== undefined ? { tables } : {}) },
          { source: resolve(from, secrets), target: resolve(to, secrets) },
        );
        return { jobId };
      },
      result: ({ jobId }) => service().dataResult(jobId),
      rows: (input) => service().dataRows(input),
      preview: (input) => service().dataPreview(input),
      apply: ({ jobId, tables, actions, confirmed, secrets }) => {
        const sync = service();
        const target = sqlProfile(sync.dataTarget(jobId), 'target');
        checkSyncApply(target, confirmed);
        const applyId = sync.startDataApply(
          { jobId, tables, actions, confirmed: confirmed === true },
          resolve(target, secrets),
        );
        return { jobId: applyId };
      },
      export: ({ jobId, tables, actions, path }) => {
        grants.checkWrite(path);
        return service().exportData({ jobId, tables, actions, path });
      },
    },
    discard: ({ jobId }) => {
      services.sync?.discard(jobId);
    },
    saved: {
      list: () => store.comparisons.list().map(toSavedComparison),
      save: ({ id, name, kind, source, target, structure, data, expectedVersion }) => {
        const definition = comparisonDefinitionSchema.parse({
          source: { database: source.database, schemas: source.schemas },
          target: { database: target.database, schemas: target.schemas },
          structure: kind === 'structure' ? (structure ?? {}) : undefined,
          data: kind === 'data' ? data : undefined,
        });
        // A JSON round trip drops the undefined fields the store refuses.
        const json = JSON.parse(JSON.stringify(definition)) as Record<string, JsonValue>;
        const existing = id !== undefined ? store.comparisons.get(id) : undefined;
        if (existing && existing.kind !== kind) {
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: `"${existing.name}" is a ${existing.kind} comparison`,
          });
        }
        const record = existing
          ? store.comparisons.update(
              existing.id,
              {
                name,
                sourceProfileId: source.profileId,
                targetProfileId: target.profileId,
                definition: json,
              },
              expectedVersion !== undefined ? { expectedVersion } : {},
            )
          : store.comparisons.create({
              ...(id !== undefined ? { id } : {}),
              name,
              kind,
              sourceProfileId: source.profileId,
              targetProfileId: target.profileId,
              definition: json,
            });
        return toSavedComparison(record);
      },
      delete: ({ id }) => {
        store.comparisons.delete(id);
      },
    },
  };
}
