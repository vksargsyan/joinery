import type { Session } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { resolveDbTransferOptions, type OpenedSession, type TransferPlan } from '../src';
import {
  runExecution,
  type Execution,
  type TransferUnit,
  type UnitContext,
} from '../src/db/pipeline';

/** The pipeline's orchestration, with fake sessions and units. */

const PLAN: TransferPlan = {
  sourceEngine: 'postgres',
  targetEngine: 'mysql',
  sourceVersion: '16',
  targetVersion: '8.4',
  tables: [],
  before: [],
  after: [],
  destructive: [],
  creates: [],
  problems: [],
  warnings: [],
};

let sessions = 0;
function fakeSession(label: string): OpenedSession & { closed: boolean } {
  const id = ++sessions;
  const opened = {
    session: { engine: 'postgres', serverVersion: `${label}-${id}` } as unknown as Session,
    closed: false,
    close: async () => {
      opened.closed = true;
    },
  };
  return opened;
}

function unit(
  name: string,
  work: (context: UnitContext) => Promise<void> = async () => undefined,
  finish?: () => Promise<void>,
): TransferUnit {
  return {
    source: name,
    target: name,
    async load(context) {
      await work(context);
      context.progress({ read: 10, written: 10, skipped: 0 });
      return {
        status: context.signal.aborted ? 'cancelled' : 'completed',
        read: 10,
        written: 10,
        skipped: 0,
        errors: [],
      };
    },
    ...(finish ? { finish } : {}),
  };
}

function run(execution: Execution, parallel: number, signal?: AbortSignal) {
  const opened: (OpenedSession & { closed: boolean })[] = [];
  const open = (label: string) => async () => {
    const session = fakeSession(label);
    opened.push(session);
    return session;
  };
  const control = { source: fakeSession('control-source'), target: fakeSession('control-target') };
  const summary = runExecution({
    execution,
    control,
    openSource: open('source'),
    openTarget: open('target'),
    options: resolveDbTransferOptions({ parallel }),
    ...(signal ? { signal } : {}),
  });
  return { summary, opened, control };
}

describe('runExecution', () => {
  it('runs units side by side, never more than `parallel` at once, each on its own sessions', async () => {
    let active = 0;
    let most = 0;
    const seen = new Set<Session>();
    const units = Array.from({ length: 7 }, (_, i) =>
      unit(`t${i}`, async (context) => {
        active++;
        most = Math.max(most, active);
        seen.add(context.target);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      }),
    );
    const { summary, opened, control } = run({ plan: PLAN, units }, 3);
    const result = await summary;
    expect(result.status).toBe('completed');
    expect(result.rowsWritten).toBe(70);
    expect(result.tables).toHaveLength(7);
    expect(most).toBe(3);
    expect(seen.size).toBe(3);
    // Two workers opened their own pair; the control pair is the caller's to close.
    expect(opened).toHaveLength(4);
    expect(opened.every((s) => s.closed)).toBe(true);
    expect(control.target.closed).toBe(false);
  });

  it('sets every target session up and undoes it, and prepares before any unit', async () => {
    const events: string[] = [];
    const execution: Execution = {
      plan: PLAN,
      setupSource: async () => {
        events.push('setup source');
      },
      setupTarget: async () => {
        events.push('setup target');
        return async () => {
          events.push('restore target');
        };
      },
      prepare: async () => {
        events.push('prepare');
      },
      units: [
        unit(
          'a',
          async () => void events.push('load a'),
          async () => void events.push('finish a'),
        ),
      ],
      complete: async (_target, completed) => {
        events.push(`complete ${[...completed].join(',')}`);
        return [];
      },
    };
    const result = await run(execution, 2).summary;
    expect(result.status).toBe('completed');
    expect(events).toEqual([
      'setup target',
      'setup source',
      'prepare',
      'load a',
      'finish a',
      'complete a',
      'restore target',
    ]);
  });

  it('stops the other tables when one fails, and reports it', async () => {
    const failing: TransferUnit = {
      source: 'bad',
      target: 'bad',
      load: async () => ({
        status: 'failed',
        read: 1,
        written: 0,
        skipped: 1,
        errors: [{ row: 1, message: 'boom' }],
      }),
    };
    const slow = unit(
      'slow',
      (context) =>
        new Promise((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    );
    const result = await run({ plan: PLAN, units: [slow, failing, unit('never')] }, 2).summary;
    expect(result.status).toBe('failed');
    expect(result.errors).toEqual([{ table: 'bad', row: 1, message: 'boom' }]);
    expect(result.tables.map((t) => [t.target, t.status])).toEqual([
      ['bad', 'failed'],
      ['slow', 'cancelled'],
    ]);
  });

  it('reports a failed finish as an error of the table, and keeps going', async () => {
    const result = await run(
      {
        plan: PLAN,
        units: [
          unit('a', undefined, async () => {
            throw new Error('index failed');
          }),
          unit('b'),
        ],
      },
      1,
    ).summary;
    expect(result.status).toBe('completed');
    expect(result.errors).toEqual([{ table: 'a', message: 'index failed' }]);
  });

  it('ends cancelled when the caller aborts', async () => {
    const controller = new AbortController();
    const units = [
      unit('a', async () => {
        controller.abort();
      }),
      unit('b'),
    ];
    const result = await run({ plan: PLAN, units }, 1, controller.signal).summary;
    expect(result.status).toBe('cancelled');
    expect(result.tables.map((t) => t.target)).toEqual(['a']);
  });

  it('fails without loading anything when the target cannot be prepared', async () => {
    const result = await run(
      {
        plan: PLAN,
        prepare: async () => {
          throw new Error('permission denied');
        },
        units: [unit('a')],
      },
      2,
    ).summary;
    expect(result.status).toBe('failed');
    expect(result.tables).toEqual([]);
    expect(result.errors).toEqual([{ message: 'permission denied' }]);
  });
});
