import { describe, expect, it } from 'vitest';

import { SessionGate } from '../src';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SessionGate', () => {
  it('runs operations one at a time, in order', async () => {
    const gate = new SessionGate();
    const log: string[] = [];
    const op = (name: string, ms: number) =>
      gate.run(async () => {
        log.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([op('a', 10), op('b', 1), op('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(gate.busy).toBe(false);
  });

  it('releases the gate when an operation fails', async () => {
    const gate = new SessionGate();
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('preempts an open result when another operation arrives', async () => {
    const gate = new SessionGate();
    const lease = await gate.acquire();
    let closed = false;
    lease.setPreemptHandler(async () => {
      await tick();
      closed = true;
    });
    expect(gate.holdsOpenResult).toBe(true);
    const next = gate.run(async () => (closed ? 'ran after close' : 'ran too early'));
    await expect(next).resolves.toBe('ran after close');
    // Releasing the preempted lease again is harmless.
    lease.release();
    expect(gate.busy).toBe(false);
  });

  it('preempts as soon as a handler is set when someone is already waiting', async () => {
    const gate = new SessionGate();
    const lease = await gate.acquire();
    const waiting = gate.run(async () => 'second');
    await tick();
    let preempted = false;
    lease.setPreemptHandler(async () => {
      preempted = true;
    });
    await expect(waiting).resolves.toBe('second');
    expect(preempted).toBe(true);
  });

  it('does not preempt a plain operation', async () => {
    const gate = new SessionGate();
    const lease = await gate.acquire();
    let second = false;
    const waiting = gate.run(async () => {
      second = true;
    });
    await tick();
    expect(second).toBe(false);
    lease.release();
    await waiting;
    expect(second).toBe(true);
  });
});
