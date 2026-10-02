import { JoineryError } from '@joinery/core';
import {
  rdbAnalyzeProgressSchema,
  rdbReportSchema,
  type HandlersOf,
  type mainContract,
} from '@joinery/ipc';

import type { JobManager } from './jobs';
import type { FileGrants } from './jobs-api';

type RedisDumpHandlers = HandlersOf<typeof mainContract>['redisDump'];

/**
 * The `redisDump.*` namespace (ADR 0022): an RDB file the window picked is analysed by the job
 * runner, with progress, for as long as the file takes; closing the panel cancels it.
 */
export function redisDumpHandlers(
  services: { readonly jobs?: JobManager | undefined },
  grants: FileGrants,
): RedisDumpHandlers {
  return {
    analyze: async (input, { signal, progress }) => {
      grants.checkRead(input.path);
      if (!services.jobs) {
        throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'Jobs cannot run here' });
      }
      const result = await services.jobs.request(
        { kind: 'rdb-analyze', input },
        {
          timeoutMs: null,
          signal,
          onProgress: (value) => {
            const parsed = rdbAnalyzeProgressSchema.safeParse(value);
            if (parsed.success) progress(parsed.data);
          },
        },
      );
      return rdbReportSchema.parse(result);
    },
  };
}
