import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { JoineryError } from '@joinery/core';
import {
  rdbReportOf,
  type RdbAnalyzeInput,
  type RdbAnalyzeProgress,
  type RdbReport,
} from '@joinery/ipc';
import { RdbError, analyzeRdb, displayBytes } from '@joinery/redis-tools';

/**
 * An RDB file analysed in the job runner (ADR 0022): read as a stream in 1 MiB chunks, summed
 * by redis-tools' `analyzeRdb`, and reported with key names as display text. Progress goes out
 * every 4 MiB; the signal stops the reading.
 */
export async function analyzeRdbFile(
  input: RdbAnalyzeInput,
  options: {
    readonly signal: AbortSignal;
    readonly onProgress: (progress: RdbAnalyzeProgress) => void;
  },
): Promise<RdbReport> {
  let size: number;
  try {
    size = (await stat(input.path)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new JoineryError({
      code: code === 'ENOENT' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
      message:
        code === 'ENOENT'
          ? `${input.path} does not exist`
          : `${input.path} cannot be read (${code})`,
    });
  }
  const started = performance.now();
  const stream = createReadStream(input.path, { highWaterMark: 1024 * 1024 });
  try {
    options.onProgress({ bytes: 0, total: size });
    const analysis = await analyzeRdb(stream as AsyncIterable<Uint8Array>, {
      signal: options.signal,
      progressBytes: 4 * 1024 * 1024,
      onProgress: (bytes) => options.onProgress({ bytes, total: size }),
      ...(input.delimiter !== undefined ? { delimiter: input.delimiter } : {}),
    });
    return rdbReportOf(
      analysis,
      {
        file: basename(input.path),
        size,
        durationMs: Math.round(performance.now() - started),
      },
      displayBytes,
    );
  } catch (error) {
    if (error instanceof RdbError) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: error.message,
        hint: 'Choose a dump.rdb file written by Redis or Valkey (SAVE, BGSAVE or --rdb)',
      });
    }
    throw error;
  } finally {
    stream.destroy();
  }
}
