import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { QuerybaraError } from '@querybara/core';
import type { HandlersOf, MongoSavedPipeline, mainContract } from '@querybara/ipc';
import type { SavedQuery, Store } from '@querybara/storage';
import { z } from 'zod';

import { checkMongoWrite } from '../shared/mongo-writes';
import type { FileGrants } from './jobs-api';
import type { ConnectionSupervisor } from './supervisor';

/**
 * The main contract's `mongo.*` handlers: GridFS files moved by path (spec §9, GridFS browser).
 * As for jobs (ADR 0006), a file is read only when this window picked it with
 * `dialogs.openFile`, and written only where its `dialogs.saveFile` pointed; an upload also
 * passes the connection's write rules. The connection's host then streams the file between the
 * disk and the server, so the bytes never pass through main's IPC or the renderer.
 *
 * Saved aggregation pipelines are saved queries of the local store, scoped to the profile and
 * database and tagged with the collection, so they stay with the connection and go when it does.
 * Exported text (a JSON Schema) is written under the same file grants as a download.
 */

type MongoMainHandlers = HandlersOf<typeof mainContract>['mongo'];

const uploadResultSchema = z.object({ id: z.string() });
const downloadResultSchema = z.object({ bytes: z.number().int().nonnegative() });

/** The tag that marks a saved query as an aggregation pipeline. */
export const PIPELINE_TAG = 'mongodb:pipeline';

/** The tag naming the collection a saved pipeline belongs to. */
export function pipelineCollectionTag(collection: string): string {
  return `collection:${collection}`;
}

function toSavedPipeline(query: SavedQuery): MongoSavedPipeline {
  return { id: query.id, name: query.name, text: query.text, updatedAt: query.updatedAt };
}

export function mongoMainHandlers<P>(
  services: {
    readonly supervisor: ConnectionSupervisor<P>;
    readonly store: Pick<Store, 'savedQueries'>;
  },
  grants: FileGrants,
): MongoMainHandlers {
  const { supervisor, store } = services;
  const pipelinesOf = (scope: { profileId: string; db: string; collection: string }) =>
    store.savedQueries
      .list({ profileId: scope.profileId })
      .filter(
        (query) =>
          query.database === scope.db &&
          query.tags.includes(PIPELINE_TAG) &&
          query.tags.includes(pipelineCollectionTag(scope.collection)),
      );
  const profileOf = (connectionId: string) => {
    const profile = supervisor.profileOf(connectionId);
    if (!profile) {
      throw new QuerybaraError({
        code: 'CONNECTION_FAILED',
        message: 'The connection is closed',
        hint: 'Reconnect and try again.',
      });
    }
    if (profile.engine !== 'mongodb') {
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: 'GridFS needs a MongoDB connection',
      });
    }
    return profile;
  };

  return {
    gridfs: {
      upload: async (input, { signal, progress }) => {
        grants.checkRead(input.path);
        const profile = profileOf(input.connectionId);
        const filename = input.filename ?? basename(input.path);
        checkMongoWrite(
          profile,
          input,
          `Uploading ${filename} to the ${input.bucket.bucket} bucket of ${input.bucket.db}`,
          false,
        );
        const result = await supervisor.request(
          input.connectionId,
          {
            kind: 'gridfs-upload',
            bucket: input.bucket,
            path: input.path,
            filename,
            ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            ...(input.chunkSizeBytes !== undefined ? { chunkSizeBytes: input.chunkSizeBytes } : {}),
          },
          { signal, onProgress: progress },
        );
        return uploadResultSchema.parse(result);
      },
      download: async (input, { signal, progress }) => {
        grants.checkWrite(input.path);
        profileOf(input.connectionId);
        const result = await supervisor.request(
          input.connectionId,
          { kind: 'gridfs-download', bucket: input.bucket, id: input.id, path: input.path },
          { signal, onProgress: progress },
        );
        return downloadResultSchema.parse(result);
      },
    },
    pipelines: {
      list: async (scope) => pipelinesOf(scope).map(toSavedPipeline),
      save: async ({ id, name, text, ...scope }) => {
        const existing = id === undefined ? undefined : store.savedQueries.get(id);
        if (existing && !pipelinesOf(scope).some((query) => query.id === existing.id)) {
          throw new QuerybaraError({
            code: 'NOT_FOUND',
            message: 'That saved pipeline belongs to another collection',
          });
        }
        if (existing)
          return toSavedPipeline(store.savedQueries.update(existing.id, { name, text }));
        return toSavedPipeline(
          store.savedQueries.create({
            name,
            text,
            profileId: scope.profileId,
            database: scope.db,
            tags: [PIPELINE_TAG, pipelineCollectionTag(scope.collection)],
          }),
        );
      },
      delete: async ({ id }) => {
        const query = store.savedQueries.get(id);
        if (query?.tags.includes(PIPELINE_TAG)) store.savedQueries.delete(id);
      },
    },
    writeText: async ({ path, text }) => {
      grants.checkWrite(path);
      const bytes = Buffer.from(text, 'utf8');
      await writeFile(path, bytes);
      return { bytes: bytes.length };
    },
  };
}
