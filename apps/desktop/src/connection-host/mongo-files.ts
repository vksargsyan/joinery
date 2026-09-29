import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

import { JoineryError, type Session } from '@joinery/core';

import type { HostRequest } from '../shared/host-protocol';
import { asMongoSession } from './mongo';

/**
 * Runs the file work main hands this host (spec §9, GridFS browser): uploads read a file main
 * checked against the window's read grants, downloads write where its save dialog pointed. Bytes
 * go between the disk and the server here, so they never pass through main or the renderer.
 * Progress is reported at most every 256 KiB.
 */

export interface HostRequestOptions {
  readonly signal: AbortSignal;
  readonly progress: (progress: { readonly bytes: number; readonly total?: number }) => void;
}

const PROGRESS_STEP = 256 * 1024;

export async function runHostRequest(
  session: Session,
  request: HostRequest,
  options: HostRequestOptions,
): Promise<unknown> {
  const mongo = await asMongoSession(session);
  const { signal, progress } = options;
  switch (request.kind) {
    case 'gridfs-upload': {
      const total = (await stat(request.path)).size;
      const source = createReadStream(request.path);
      let bytes = 0;
      let reported = 0;
      source.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes - reported >= PROGRESS_STEP) {
          reported = bytes;
          progress({ bytes, total });
        }
      });
      try {
        const id = await mongo.uploadFile(request.bucket, source, {
          filename: request.filename,
          signal,
          ...(request.contentType !== undefined ? { contentType: request.contentType } : {}),
          ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
          ...(request.chunkSizeBytes !== undefined
            ? { chunkSizeBytes: request.chunkSizeBytes }
            : {}),
        });
        progress({ bytes: total, total });
        return { id };
      } finally {
        source.destroy();
      }
    }
    case 'gridfs-download': {
      let total: number | undefined;
      for await (const page of mongo.listFiles(request.bucket, {
        filter: `{"_id":${request.id}}`,
        limit: 1,
      })) {
        total = page.files[0]?.length;
      }
      if (total === undefined) {
        throw new JoineryError({ code: 'NOT_FOUND', message: 'The GridFS file does not exist' });
      }
      const out = createWriteStream(request.path);
      let bytes = 0;
      let reported = 0;
      try {
        for await (const chunk of mongo.downloadFile(request.bucket, request.id, { signal })) {
          if (!out.write(chunk)) await once(out, 'drain', { signal });
          bytes += chunk.length;
          if (bytes - reported >= PROGRESS_STEP) {
            reported = bytes;
            progress({ bytes, total });
          }
        }
        out.end();
        await finished(out);
      } catch (error) {
        out.destroy();
        await unlink(request.path).catch(() => undefined);
        throw error;
      }
      progress({ bytes, total });
      return { bytes };
    }
  }
}
