import type { RdbReport } from '@querybara/ipc';
import { describe, expect, it, vi } from 'vitest';

import type { JobManager, RunnerRequestOptions } from '../src/main/jobs';
import { FileGrants } from '../src/main/jobs-api';
import { redisDumpHandlers } from '../src/main/redis-dump-api';
import type { RunnerRequest } from '../src/shared/job-protocol';

/**
 * Main's `redisDump.analyze`: only a file this window picked is read; the job runner's report
 * is checked before it reaches the page, and its progress is relayed.
 */

const report: RdbReport = {
  file: 'dump.rdb',
  size: 100,
  version: 11,
  bytes: 100,
  checksum: null,
  aux: {},
  createdAt: null,
  keys: 0,
  keyBytes: 0,
  expiring: 0,
  databases: [],
  types: [],
  expiry: [],
  patterns: [],
  biggest: [],
  longest: [],
  fieldsWithTtl: 0,
  functions: 0,
  moduleAux: [],
  durationMs: 3,
};

function setup(result: unknown = report) {
  const calls: { request: RunnerRequest; options: RunnerRequestOptions }[] = [];
  const jobs = {
    request: vi.fn(async (request: RunnerRequest, options: RunnerRequestOptions = {}) => {
      calls.push({ request, options });
      options.onProgress?.({ bytes: 50, total: 100 });
      options.onProgress?.({ nonsense: true });
      return result;
    }),
  } as unknown as JobManager;
  const grants = new FileGrants();
  return { handlers: redisDumpHandlers({ jobs }, grants), grants, calls };
}

describe('redisDump.analyze', () => {
  it('reads only a file picked in a dialog', async () => {
    const { handlers, calls } = setup();
    await expect(
      handlers.analyze(
        { path: '/etc/passwd' },
        { signal: new AbortController().signal, progress: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('passwd'),
    });
    expect(calls).toHaveLength(0);
  });

  it('asks the runner without a time limit, relays progress and checks the report', async () => {
    const { handlers, grants, calls } = setup();
    grants.grantRead('/data/dump.rdb');
    const progress: unknown[] = [];
    const signal = new AbortController().signal;
    const result = await handlers.analyze(
      { path: '/data/dump.rdb', delimiter: '/' },
      { signal, progress: (p) => progress.push(p) },
    );
    expect(result).toEqual(report);
    expect(calls[0]!.request).toEqual({
      kind: 'rdb-analyze',
      input: { path: '/data/dump.rdb', delimiter: '/' },
    });
    expect(calls[0]!.options).toMatchObject({ timeoutMs: null, signal });
    // Malformed progress from the runner is dropped.
    expect(progress).toEqual([{ bytes: 50, total: 100 }]);

    const bad = setup({ ...report, keys: -1 });
    bad.grants.grantRead('/data/dump.rdb');
    await expect(
      bad.handlers.analyze({ path: '/data/dump.rdb' }, { signal, progress: () => undefined }),
    ).rejects.toThrow();
  });
});
