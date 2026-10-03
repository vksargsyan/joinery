import { connectionProfileSchema, type ResolvedProfile } from '@querybara/core';
import type { ConnectionEvent } from '@querybara/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSupervisor } from '../src/main/supervisor';
import { SERVER_INFO, fakeHosts, profileInput } from './helpers';

const resolved: ResolvedProfile = {
  profile: connectionProfileSchema.parse(profileInput({ id: 'p1' })),
  secrets: { s1: 'hunter2' },
};

function setup(options: { maxRestarts?: number; stableAfterMs?: number } = {}) {
  const hosts = fakeHosts();
  let now = 0;
  const supervisor = new ConnectionSupervisor<string>({
    spawn: hosts.spawn,
    backoffMs: [100, 200, 400],
    readyTimeoutMs: 5_000,
    shutdownGraceMs: 50,
    now: () => now,
    ...options,
  });
  const events: ConnectionEvent[] = [];
  supervisor.subscribe((event) => events.push(event));
  return {
    supervisor,
    hosts,
    events,
    states: () => events.map((e) => (e.attempt ? `${e.state}#${e.attempt}` : e.state)),
    advanceClock: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionSupervisor', () => {
  it('starts a host with the resolved profile and resolves once it is ready', async () => {
    const { supervisor, hosts, states } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    const host = hosts.processes[0]!;
    expect(host.messagesOfType('connect')[0]?.resolved.secrets).toEqual({ s1: 'hunter2' });
    host.emit({ type: 'ready', info: SERVER_INFO });
    const opened = await opening;
    expect(opened.info).toEqual(SERVER_INFO);
    expect(states()).toEqual(['connecting', 'ready']);
  });

  it('joins the open connection instead of starting a second host', async () => {
    const { supervisor, hosts } = setup();
    const resolve = vi.fn(() => resolved);
    const first = supervisor.open('p1', resolve);
    const second = supervisor.open('p1', resolve);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    const [a, b] = await Promise.all([first, second]);
    expect(a.connectionId).toBe(b.connectionId);
    expect(resolve).toHaveBeenCalledTimes(1);
    const third = await supervisor.open('p1', resolve);
    expect(third.connectionId).toBe(a.connectionId);
    expect(hosts.processes).toHaveLength(1);
  });

  it('reports a failed first start to the caller and does not restart it', async () => {
    const { supervisor, hosts, states } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({
      type: 'failed',
      error: { code: 'AUTH_FAILED', message: 'password authentication failed' },
    });
    await expect(opening).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(hosts.processes[0]!.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts.processes).toHaveLength(1);
    expect(states()).toEqual(['connecting', 'failed']);
    expect(supervisor.findByProfile('p1')).toBeUndefined();
  });

  it('restarts a crashed host with exponential backoff and publishes each step', async () => {
    const { supervisor, hosts, states, events } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    await opening;

    hosts.processes[0]!.exit(1);
    expect(events.at(-1)).toMatchObject({ state: 'restarting', attempt: 1 });
    expect(events.at(-1)?.message).toContain('code 1');
    await vi.advanceTimersByTimeAsync(99);
    expect(hosts.processes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hosts.processes).toHaveLength(2);
    // The restarted host reconnects with the same resolved profile.
    expect(hosts.processes[1]!.messagesOfType('connect')[0]?.resolved).toEqual(resolved);

    // It dies again before it is ready: the next delay doubles.
    hosts.processes[1]!.exit(null);
    await vi.advanceTimersByTimeAsync(199);
    expect(hosts.processes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hosts.processes).toHaveLength(3);
    hosts.processes[2]!.emit({ type: 'ready', info: SERVER_INFO });
    expect(states()).toEqual(['connecting', 'ready', 'restarting#1', 'restarting#2', 'ready']);
  });

  it('lets callers wait through a restart', async () => {
    const { supervisor, hosts } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    const { connectionId } = await opening;
    hosts.processes[0]!.exit(1);
    const rejoined = supervisor.open('p1', () => resolved);
    await vi.advanceTimersByTimeAsync(100);
    hosts.processes[1]!.emit({ type: 'ready', info: SERVER_INFO });
    await expect(rejoined).resolves.toMatchObject({ connectionId });
  });

  it('gives up after the maximum number of consecutive restarts', async () => {
    const { supervisor, hosts, events } = setup({ maxRestarts: 2 });
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    await opening;
    hosts.processes[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(100);
    hosts.processes[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(200);
    hosts.processes[2]!.exit(1);
    expect(events.at(-1)).toMatchObject({ state: 'failed' });
    expect(events.at(-1)?.message).toContain('gave up after 2 restarts');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts.processes).toHaveLength(3);
    // Opening again starts a fresh connection.
    const again = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(4));
    hosts.processes[3]!.emit({ type: 'ready', info: SERVER_INFO });
    await expect(again).resolves.toBeDefined();
  });

  it('starts the backoff over after the host was stable', async () => {
    const { supervisor, hosts, events, advanceClock } = setup({ stableAfterMs: 1_000 });
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    await opening;
    hosts.processes[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(100);
    hosts.processes[1]!.emit({ type: 'ready', info: SERVER_INFO });
    advanceClock(5_000);
    hosts.processes[1]!.exit(1);
    expect(events.at(-1)).toMatchObject({ state: 'restarting', attempt: 1 });
  });

  it('keeps other connections running when one host crashes', async () => {
    const { supervisor, hosts } = setup();
    const other: ResolvedProfile = {
      profile: connectionProfileSchema.parse(profileInput({ id: 'p2' })),
      secrets: {},
    };
    const a = supervisor.open('p1', () => resolved);
    const b = supervisor.open('p2', () => other);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(2));
    for (const host of hosts.processes) host.emit({ type: 'ready', info: SERVER_INFO });
    const [first, second] = await Promise.all([a, b]);
    hosts.processes[0]!.exit(1);
    expect(supervisor.findByProfile('p2')).toEqual({
      connectionId: second.connectionId,
      state: 'ready',
    });
    expect(supervisor.findByProfile('p1')).toEqual({
      connectionId: first.connectionId,
      state: 'restarting',
    });
    expect(hosts.processes[1]!.killed).toBe(false);
  });

  it('transfers ports to a ready host only', async () => {
    const { supervisor, hosts } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    const host = hosts.processes[0]!;
    host.emit({ type: 'ready', info: SERVER_INFO });
    const { connectionId } = await opening;
    supervisor.attach(connectionId, 'port-1');
    expect(host.sent.at(-1)).toEqual({ message: { type: 'attach' }, ports: ['port-1'] });
    host.exit(1);
    expect(() => supervisor.attach(connectionId, 'port-2')).toThrow(
      expect.objectContaining({ code: 'CONNECTION_FAILED' }),
    );
    expect(() => supervisor.attach('unknown', 'port-3')).toThrow();
  });

  it('shuts a host down on close and never restarts it', async () => {
    const { supervisor, hosts, states } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    const host = hosts.processes[0]!;
    host.emit({ type: 'ready', info: SERVER_INFO });
    const { connectionId } = await opening;
    supervisor.close(connectionId);
    expect(host.messagesOfType('shutdown')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(host.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts.processes).toHaveLength(1);
    expect(states()).toEqual(['connecting', 'ready', 'closed']);
  });

  it('fails a start that does not become ready in time', async () => {
    const { supervisor, hosts } = setup();
    const opening = supervisor.open('p1', () => resolved);
    const assertion = expect(opening).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(hosts.processes[0]!.killed).toBe(true);
  });

  it('ignores malformed messages from a host', async () => {
    const { supervisor, hosts } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    const host = hosts.processes[0]!;
    host.emit({ type: 'ready' });
    host.emit('ready');
    host.emit({ type: 'ready', info: SERVER_INFO });
    await expect(opening).resolves.toBeDefined();
  });

  it('describes the current connections to late subscribers', async () => {
    const { supervisor, hosts } = setup();
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    const { connectionId } = await opening;
    expect(supervisor.snapshot()).toEqual([{ connectionId, profileId: 'p1', state: 'ready' }]);
  });
});
