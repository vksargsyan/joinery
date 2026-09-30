import {
  connectionProfileSchema,
  type ConnectionCheckResult,
  type ResolvedProfile,
} from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { runConnectionCheck } from '../src/main/checker';
import { fakeHosts, profileInput } from './helpers';

const resolved: ResolvedProfile = {
  profile: connectionProfileSchema.parse(profileInput()),
  secrets: { s1: 'hunter2' },
};

const steps: ConnectionCheckResult[] = [
  { step: 'dns', status: 'ok', durationMs: 1 },
  { step: 'tcp', status: 'ok', durationMs: 2 },
  { step: 'tls', status: 'failed', durationMs: 3, message: 'no TLS', hint: 'Disable TLS' },
  { step: 'auth', status: 'skipped', durationMs: 0 },
];

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('Test Connection in a short-lived host', () => {
  it('streams every step the host reports, then kills the process', async () => {
    const hosts = fakeHosts((process, message) => {
      if (message.type !== 'check') return;
      setImmediate(() => {
        for (const result of steps) process.emit({ type: 'check-step', result });
        process.emit({ type: 'check-done' });
      });
    });
    expect(await collect(runConnectionCheck(hosts.spawn, resolved))).toEqual(steps);
    const [host] = hosts.processes;
    expect(host?.messagesOfType('check')[0]?.resolved.secrets).toEqual({ s1: 'hunter2' });
    expect(host?.killed).toBe(true);
  });

  it('reports a host that fails or dies', async () => {
    const failing = fakeHosts((process, message) => {
      if (message.type === 'check') {
        setImmediate(() =>
          process.emit({
            type: 'failed',
            error: { code: 'NOT_SUPPORTED', message: 'MongoDB is not supported yet' },
          }),
        );
      }
    });
    await expect(collect(runConnectionCheck(failing.spawn, resolved))).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });

    const crashing = fakeHosts((process, message) => {
      if (message.type === 'check') {
        setImmediate(() => {
          process.emit({ type: 'check-step', result: steps[0] });
          process.exit(134);
        });
      }
    });
    const seen: ConnectionCheckResult[] = [];
    await expect(
      (async () => {
        for await (const step of runConnectionCheck(crashing.spawn, resolved)) seen.push(step);
      })(),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(seen).toEqual([steps[0]]);
  });

  it('kills the process when the caller stops or aborts', async () => {
    const hosts = fakeHosts((process, message) => {
      if (message.type === 'check') {
        setImmediate(() => process.emit({ type: 'check-step', result: steps[0] }));
      }
    });
    for await (const step of runConnectionCheck(hosts.spawn, resolved)) {
      expect(step.step).toBe('dns');
      break;
    }
    expect(hosts.processes[0]?.killed).toBe(true);

    const controller = new AbortController();
    const stalled = fakeHosts();
    const run = collect(runConnectionCheck(stalled.spawn, resolved, { signal: controller.signal }));
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stalled.processes[0]?.killed).toBe(true);
  });

  it('times out a check that never finishes', async () => {
    const hosts = fakeHosts();
    await expect(
      collect(runConnectionCheck(hosts.spawn, resolved, { timeoutMs: 20 })),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(hosts.processes[0]?.killed).toBe(true);
  });
});
