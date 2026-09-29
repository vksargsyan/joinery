import { JoineryError } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  DATA_TYPE_PATTERN,
  createClient,
  jobInfoSchema,
  jobSpecSchema,
  mainContract,
  parseRequest,
  serve,
  type HandlersOf,
  type JobEvent,
  type JobInfo,
} from '../src';
import { portPair } from './helpers';

/**
 * The job and transfer additions to the main contract (spec §3, §12, §14): job specs validate
 * paths, formats and column types before anything starts; progress and job records stream to
 * the renderer; and nothing in them can carry a secret.
 */

const job: JobInfo = {
  id: 'j1',
  kind: 'import',
  title: 'Import people.csv into public.people',
  profileId: 'p1',
  profileName: 'Shop',
  state: 'running',
  cancelling: false,
  createdAt: '2026-09-29T10:00:00.000Z',
  progress: { phase: 'Importing', rowsWritten: 10, bytes: 100, totalBytes: 400, elapsedMs: 20 },
  errors: [],
  log: [{ at: '2026-09-29T10:00:01.000Z', level: 'info', message: 'Connected' }],
  target: { file: '/data/people.csv', table: 'public.people', format: 'csv' },
};

function serveJobs(handlers: Partial<HandlersOf<typeof mainContract>['jobs']>) {
  const ports = portPair();
  const notUsed = (): never => {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'not used' });
  };
  const all = Object.fromEntries(
    [...mainContract.methods.keys()].map((path) => [path, notUsed]),
  ) as Record<string, unknown>;
  const tree: Record<string, unknown> = {};
  for (const [path, handler] of Object.entries(all)) {
    const parts = path.split('.');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = handler;
  }
  tree['jobs'] = { ...(tree['jobs'] as object), ...handlers };
  serve(ports.server, mainContract, tree as unknown as HandlersOf<typeof mainContract>);
  return createClient(ports.client, mainContract);
}

describe('jobs contract', () => {
  it('streams job events and returns job ids', async () => {
    const events: JobEvent[] = [
      { type: 'job', job },
      { type: 'progress', jobId: 'j1', progress: { phase: 'Importing', elapsedMs: 30 } },
      { type: 'log', jobId: 'j1', entry: job.log[0]! },
      { type: 'removed', jobId: 'j1' },
    ];
    const main = serveJobs({
      start: () => ({ jobId: 'j2' }),
      async *events() {
        yield* events;
      },
    });
    const received: JobEvent[] = [];
    for await (const event of main.jobs.events()) received.push(event);
    expect(received).toEqual(events);
    expect(
      await main.jobs.start({
        job: {
          kind: 'run-sql-file',
          profileId: 'p1',
          path: '/data/migrate.sql',
          onError: 'continue',
        },
      }),
    ).toEqual({ jobId: 'j2' });
  });

  it('strips anything outside the job record before it reaches the renderer', async () => {
    const main = serveJobs({
      list: () => [{ ...job, secrets: { s1: 'hunter2' }, resolved: { password: 'hunter2' } }],
    });
    const [listed] = await main.jobs.list();
    expect(listed).toEqual(job);
    expect(JSON.stringify(listed)).not.toContain('hunter2');
    expect(Object.keys(jobInfoSchema.shape)).not.toContain('secrets');
  });

  it('validates job specs', () => {
    const base = {
      kind: 'import',
      profileId: 'p1',
      file: { path: '/data/people.csv', format: 'csv' },
      table: { name: 'people' },
      mapping: [{ source: 'id', target: 'id' }],
      mode: 'append',
    };
    expect(jobSpecSchema.safeParse(base).success).toBe(true);
    expect(jobSpecSchema.safeParse({ ...base, mapping: [] }).success).toBe(false);
    expect(jobSpecSchema.safeParse({ ...base, mode: 'merge' }).success).toBe(false);
    expect(jobSpecSchema.safeParse({ ...base, file: { path: '', format: 'csv' } }).success).toBe(
      false,
    );
    expect(jobSpecSchema.safeParse({ ...base, file: { path: '/x', format: 'xlsx' } }).success).toBe(
      false,
    );
    const create = (dataType: string) =>
      jobSpecSchema.safeParse({
        ...base,
        create: {
          columns: [{ source: 'id', name: 'id', dataType, nullable: false }],
          primaryKey: ['id'],
        },
      }).success;
    expect(create('numeric(10,2)')).toBe(true);
    expect(create("text DEFAULT 'x'")).toBe(false);
    expect(
      jobSpecSchema.safeParse({
        kind: 'export',
        profileId: 'p1',
        source: { kind: 'tables', tables: [] },
        format: 'csv',
        output: { kind: 'file', path: '/x.csv' },
      }).success,
    ).toBe(false);
    expect(() =>
      parseRequest(mainContract, 'dialogs.saveFile', { defaultName: '../../etc/passwd' }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(parseRequest(mainContract, 'dialogs.saveFile', { defaultName: 'orders.csv' })).toEqual({
      method: 'dialogs.saveFile',
      input: { defaultName: 'orders.csv' },
    });
  });

  it('accepts column types, not SQL', () => {
    for (const type of [
      'integer',
      'double precision',
      'numeric(10,2)',
      'varchar(255)',
      'timestamp(3) with time zone',
      'int unsigned',
      'decimal(65, 30)',
      'text[]',
      'public.my_type',
    ]) {
      expect(DATA_TYPE_PATTERN.test(type), type).toBe(true);
    }
    for (const bad of [
      '',
      'int; drop table x',
      "varchar(10) default 'x'",
      'int -- comment',
      'text)',
      'int /* x */',
      'enum("a")',
    ]) {
      expect(DATA_TYPE_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
