import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JoineryError,
  connectionProfileSchema,
  type ConnectionCheckResult,
  type ResolvedProfile,
} from '@joinery/core';
import type { ConnectionEvent, HostKeyPromptEvent } from '@joinery/ipc';
import { FileKnownHosts, MemoryKnownHosts, type KnownHostsStore } from '@joinery/tunnel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostKeyBridge } from '../src/connection-host/host-keys';
import { runConnectionCheck } from '../src/main/checker';
import {
  HostKeyBroker,
  hostKeyPromptEvents,
  isPermanentFailure,
  type HostKeyVerification,
} from '../src/main/host-keys';
import { ConnectionSupervisor } from '../src/main/supervisor';
import type { HostToMain } from '../src/shared/host-protocol';
import { SERVER_INFO, fakeHosts, flush, profileInput } from './helpers';

const OLD = { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:oldOLDold0123456789abcdefghij' };
const NEW = { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:newNEWnew0123456789abcdefghij' };
const context = { profileName: 'Prod over SSH', purpose: 'connect' } as const;
const request = (key = NEW, host = 'bastion.example.com') => ({
  requestId: 'r1',
  host,
  port: 22,
  key,
});

/** A broker with one listening window that answers each question with `answer`. */
function brokerWith<S extends KnownHostsStore = MemoryKnownHosts>(
  store: S = new MemoryKnownHosts() as unknown as S,
  answer?: (event: Extract<HostKeyPromptEvent, { type: 'open' }>) => string | undefined,
  timeoutMs?: number,
) {
  const broker = new HostKeyBroker({ store, ...(timeoutMs ? { timeoutMs } : {}) });
  const events: HostKeyPromptEvent[] = [];
  const unsubscribe = broker.subscribe((event) => {
    events.push(event);
    if (event.type !== 'open') return;
    const given = answer?.(event);
    if (given !== undefined) {
      queueMicrotask(() => broker.answer(event.prompt.promptId, given as never));
    }
  });
  return { broker, store, events, unsubscribe };
}

describe('HostKeyBroker: known-hosts decisions', () => {
  it('trusts a remembered key without asking', async () => {
    const store = new MemoryKnownHosts([{ host: 'bastion.example.com', port: 22, ...NEW }]);
    const { broker, events } = brokerWith(store, () => 'cancel');
    expect(await broker.verify(request(NEW, 'BASTION.example.com'), context)).toEqual({
      decision: 'trust',
    });
    expect(events).toEqual([]);
  });

  it('refuses a new key when no window listens', async () => {
    const broker = new HostKeyBroker({ store: new MemoryKnownHosts() });
    expect(await broker.verify(request(), context)).toEqual({ decision: 'reject' });
  });

  it('asks about a new key: trust once does not remember it, trust and remember does', async () => {
    let reply = 'trust-once';
    const { broker, store, events } = brokerWith(new MemoryKnownHosts(), () => reply);
    expect(await broker.verify(request(), context)).toEqual({ decision: 'trust' });
    expect(store.entries()).toEqual([]);
    const opened = events.find((e) => e.type === 'open');
    expect(opened).toMatchObject({
      type: 'open',
      prompt: {
        kind: 'unknown',
        host: 'bastion.example.com',
        port: 22,
        key: NEW,
        known: [],
        profileName: 'Prod over SSH',
        purpose: 'connect',
      },
    });
    expect(events.at(-1)).toEqual({
      type: 'closed',
      promptId: opened?.type === 'open' ? opened.prompt.promptId : '',
    });

    reply = 'trust-remember';
    expect(await broker.verify(request(), context)).toEqual({ decision: 'trust' });
    expect(store.entries()).toEqual([{ host: 'bastion.example.com', port: 22, ...NEW }]);
    reply = 'cancel';
    const asked = events.length;
    expect(await broker.verify(request(), context)).toEqual({ decision: 'trust' });
    expect(events).toHaveLength(asked);
  });

  it('refuses a new key the user cancels', async () => {
    const { broker, store } = brokerWith(new MemoryKnownHosts(), () => 'cancel');
    expect(await broker.verify(request(), context)).toEqual({ decision: 'reject' });
    expect(store.entries()).toEqual([]);
  });

  it('warns about a changed key and offers no way to trust it directly', async () => {
    const store = new MemoryKnownHosts([{ host: 'bastion.example.com', port: 22, ...OLD }]);
    for (const answer of ['cancel', 'trust-remember', 'trust-once']) {
      const { broker, events, unsubscribe } = brokerWith(store, () => answer);
      const verdict = await broker.verify(request(), context);
      expect(verdict.decision).toBe('reject');
      expect(verdict.error).toMatchObject({ code: 'SSH_FAILED', engineCode: 'HOST_KEY_CHANGED' });
      expect(verdict.error?.message).toMatch(/CHANGED.*man-in-the-middle/);
      expect(events[0]).toMatchObject({
        type: 'open',
        prompt: { kind: 'changed', key: NEW, known: [OLD] },
      });
      expect(store.entries()).toEqual([{ host: 'bastion.example.com', port: 22, ...OLD }]);
      unsubscribe();
    }
  });

  it('asks about the new key once the user removed the remembered one', async () => {
    const store = new MemoryKnownHosts([{ host: 'bastion.example.com', port: 22, ...OLD }]);
    const { broker, events } = brokerWith(store, (event) =>
      event.prompt.kind === 'changed' ? 'forget-known' : 'trust-remember',
    );
    expect(await broker.verify(request(), context)).toEqual({ decision: 'trust' });
    expect(
      events.filter((e) => e.type === 'open').map((e) => e.type === 'open' && e.prompt.kind),
    ).toEqual(['changed', 'unknown']);
    expect(store.entries()).toEqual([{ host: 'bastion.example.com', port: 22, ...NEW }]);
  });

  it('refuses when the user removes the old key but does not trust the new one', async () => {
    const store = new MemoryKnownHosts([{ host: 'bastion.example.com', port: 22, ...OLD }]);
    const { broker } = brokerWith(store, (event) =>
      event.prompt.kind === 'changed' ? 'forget-known' : 'forget-known',
    );
    expect(await broker.verify(request(), context)).toEqual({ decision: 'reject' });
    expect(store.entries()).toEqual([]);
  });

  it('cancels a question nobody answers in time, and tells the window to close it', async () => {
    vi.useFakeTimers();
    try {
      const { broker, events } = brokerWith(new MemoryKnownHosts(), undefined, 1000);
      const verdict = broker.verify(request(), context);
      await vi.advanceTimersByTimeAsync(999);
      expect(events.map((e) => e.type)).toEqual(['open']);
      await vi.advanceTimersByTimeAsync(1);
      expect(await verdict).toEqual({ decision: 'reject' });
      expect(events.map((e) => e.type)).toEqual(['open', 'closed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels open questions when the last window stops listening', async () => {
    const { broker, events, unsubscribe } = brokerWith();
    const verdict = broker.verify(request(), context);
    await flush();
    expect(events.map((e) => e.type)).toEqual(['open']);
    unsubscribe();
    expect(await verdict).toEqual({ decision: 'reject' });
  });

  it('asks once when several hosts present the same key at the same time', async () => {
    const { broker, events } = brokerWith();
    const first = broker.verify(request(), context);
    const second = broker.verify(
      { ...request(), requestId: 'r2' },
      { ...context, purpose: 'test' },
    );
    await flush();
    const opened = events.filter((e) => e.type === 'open');
    expect(opened).toHaveLength(1);
    broker.answer(opened[0]!.type === 'open' ? opened[0]!.prompt.promptId : '', 'trust-once');
    expect(await Promise.all([first, second])).toEqual([
      { decision: 'trust' },
      { decision: 'trust' },
    ]);
  });

  it('replays open questions to a window that starts listening late', async () => {
    const broker = new HostKeyBroker({ store: new MemoryKnownHosts() });
    const early = broker.subscribe(() => undefined);
    const verdict = broker.verify(request(), context);
    await flush();
    const controller = new AbortController();
    const stream = hostKeyPromptEvents(broker, controller.signal);
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: 'open', prompt: { host: 'bastion.example.com' } });
    early();
    const promptId =
      first.value && first.value.type === 'open' ? first.value.prompt.promptId : 'none';
    broker.answer(promptId, 'trust-once');
    expect(await verdict).toEqual({ decision: 'trust' });
    expect((await stream.next()).value).toEqual({ type: 'closed', promptId });
    controller.abort();
    expect((await stream.next()).done).toBe(true);
  });

  it('remembers keys in a known_hosts file readable by the owner only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joinery-known-hosts-'));
    try {
      const path = join(dir, 'known_hosts');
      const { broker } = brokerWith(new FileKnownHosts(path), () => 'trust-remember');
      expect(await broker.verify(request(), context)).toEqual({ decision: 'trust' });
      expect(readFileSync(path, 'utf8')).toBe(
        `[bastion.example.com]:22 ssh-ed25519 ${NEW.fingerprintSha256}\n`,
      );
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      // A second broker (the next app start, or joinery-cli) trusts it without asking.
      const again = new HostKeyBroker({ store: new FileKnownHosts(path) });
      expect(await again.verify(request(), context)).toEqual({ decision: 'trust' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies the failures that restarting cannot fix', () => {
    const fail = (data: ConstructorParameters<typeof JoineryError>[0]) => new JoineryError(data);
    expect(
      isPermanentFailure(
        fail({ code: 'SSH_FAILED', message: 'x', engineCode: 'HOST_KEY_CHANGED' }),
      ),
    ).toBe(true);
    expect(
      isPermanentFailure(fail({ code: 'SSH_FAILED', message: 'x', engineCode: 'AUTH_REJECTED' })),
    ).toBe(true);
    expect(isPermanentFailure(fail({ code: 'AUTH_FAILED', message: 'x' }))).toBe(true);
    expect(
      isPermanentFailure(
        fail({ code: 'SSH_FAILED', message: 'x', engineCode: 'SSH_DISCONNECTED' }),
      ),
    ).toBe(false);
    expect(isPermanentFailure(fail({ code: 'CONNECTION_FAILED', message: 'x' }))).toBe(false);
  });
});

describe('HostKeyBridge: the connection host asks main', () => {
  it('posts each host key and settles with main’s decision', async () => {
    const posted: HostToMain[] = [];
    const bridge = new HostKeyBridge((message) => posted.push(message));
    const trusted = bridge.verifier('bastion', 2222, NEW);
    const refused = bridge.verifier('jump', 22, OLD);
    const changed = bridge.verifier('db-ssh', 22, NEW);
    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({ type: 'host-key', host: 'bastion', port: 2222, key: NEW });
    const id = (index: number): string => {
      const message = posted[index];
      return message?.type === 'host-key' ? message.requestId : '';
    };
    expect(new Set([id(0), id(1), id(2)]).size).toBe(3);
    expect(bridge.pendingCount).toBe(3);

    bridge.settle({ type: 'host-key-decision', requestId: 'unknown', decision: 'trust' });
    bridge.settle({ type: 'host-key-decision', requestId: id(1), decision: 'reject' });
    bridge.settle({ type: 'host-key-decision', requestId: id(0), decision: 'trust' });
    bridge.settle({
      type: 'host-key-decision',
      requestId: id(2),
      decision: 'reject',
      error: { code: 'SSH_FAILED', message: 'CHANGED', engineCode: 'HOST_KEY_CHANGED' },
    });
    await expect(trusted).resolves.toBe('trust');
    await expect(refused).resolves.toBe('reject');
    await expect(changed).rejects.toMatchObject({ engineCode: 'HOST_KEY_CHANGED' });
    expect(bridge.pendingCount).toBe(0);
  });
});

const resolved: ResolvedProfile = {
  profile: connectionProfileSchema.parse(profileInput({ id: 'p1', name: 'Prod over SSH' })),
  secrets: {},
};

/** A verification that answers only when the test says so. */
function manualVerification() {
  const calls: { request: unknown; context: unknown; answer: (trust: boolean) => void }[] = [];
  const verification: HostKeyVerification = {
    verify: (req, ctx) =>
      new Promise((resolve) => {
        calls.push({
          request: req,
          context: ctx,
          answer: (trust) => resolve({ decision: trust ? 'trust' : 'reject' }),
        });
      }),
  };
  return { verification, calls };
}

describe('host key questions from host processes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the supervisor forwards them and the ready timeout waits for the answer', async () => {
    vi.useFakeTimers();
    const hosts = fakeHosts();
    const { verification, calls } = manualVerification();
    const supervisor = new ConnectionSupervisor<string>({
      spawn: hosts.spawn,
      readyTimeoutMs: 1_000,
      hostKeys: verification,
    });
    const opening = supervisor.open('p1', () => resolved).catch((error: unknown) => error);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    const host = hosts.processes[0]!;
    host.emit({ type: 'host-key', ...request() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.killed).toBe(false);
    expect(calls[0]?.context).toEqual({ profileName: 'Prod over SSH', purpose: 'connect' });
    expect(calls[0]?.request).toMatchObject({ requestId: 'r1', host: 'bastion.example.com' });
    calls[0]!.answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.messagesOfType('host-key-decision')).toEqual([
      { type: 'host-key-decision', requestId: 'r1', decision: 'trust' },
    ]);
    // The timeout runs again once the question is answered.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await opening).toMatchObject({ code: 'TIMEOUT' });
  });

  it('restarts a host whose tunnel dropped, and stops at a host key it must not trust', async () => {
    vi.useFakeTimers();
    const hosts = fakeHosts();
    const supervisor = new ConnectionSupervisor<string>({
      spawn: hosts.spawn,
      backoffMs: [100],
      maxRestarts: 5,
    });
    const events: ConnectionEvent[] = [];
    supervisor.subscribe((event) => events.push(event));
    const opening = supervisor.open('p1', () => resolved);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'ready', info: SERVER_INFO });
    await opening;
    hosts.processes[0]!.emit({
      type: 'failed',
      error: {
        code: 'SSH_FAILED',
        message: 'The SSH connection to ops@bastion:22 was lost: the connection closed',
        engineCode: 'SSH_DISCONNECTED',
      },
    });
    expect(hosts.processes[0]!.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      state: 'restarting',
      attempt: 1,
      message: 'The SSH connection to ops@bastion:22 was lost: the connection closed',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(hosts.processes).toHaveLength(2);
    // The restarted host's tunnel meets a changed host key: no more restarts.
    hosts.processes[1]!.emit({
      type: 'failed',
      error: {
        code: 'SSH_FAILED',
        message: 'WARNING: the host key of the SSH server bastion:22 has CHANGED.',
        hint: 'Ask the administrator',
        engineCode: 'HOST_KEY_CHANGED',
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts.processes).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      state: 'failed',
      message:
        'WARNING: the host key of the SSH server bastion:22 has CHANGED. Ask the administrator',
    });
    expect(supervisor.findByProfile('p1')).toBeUndefined();
  });

  it('Test Connection forwards them and its timeout waits for the answer', async () => {
    vi.useFakeTimers();
    const { verification, calls } = manualVerification();
    const step: ConnectionCheckResult = { step: 'ssh', status: 'ok', durationMs: 5 };
    const hosts = fakeHosts((process, message) => {
      if (message.type === 'check') {
        setTimeout(() => process.emit({ type: 'host-key', ...request() }), 0);
      }
      if (message.type === 'host-key-decision') {
        setTimeout(() => {
          process.emit({ type: 'check-step', result: step });
          process.emit({ type: 'check-done' });
        }, 0);
      }
    });
    const results: ConnectionCheckResult[] = [];
    const running = (async () => {
      for await (const result of runConnectionCheck(hosts.spawn, resolved, {
        timeoutMs: 1_000,
        hostKeys: verification,
      })) {
        results.push(result);
      }
    })();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls[0]?.context).toEqual({ profileName: 'Prod over SSH', purpose: 'test' });
    calls[0]!.answer(false);
    await vi.advanceTimersByTimeAsync(10);
    await running;
    expect(hosts.processes[0]!.messagesOfType('host-key-decision')[0]).toMatchObject({
      decision: 'reject',
    });
    expect(results).toEqual([step]);
  });

  it('refuses every host key when nothing can answer', async () => {
    const hosts = fakeHosts();
    const supervisor = new ConnectionSupervisor<string>({ spawn: hosts.spawn });
    void supervisor.open('p1', () => resolved).catch(() => undefined);
    await vi.waitFor(() => expect(hosts.processes).toHaveLength(1));
    hosts.processes[0]!.emit({ type: 'host-key', ...request() });
    await vi.waitFor(() =>
      expect(hosts.processes[0]!.messagesOfType('host-key-decision')[0]).toMatchObject({
        decision: 'reject',
      }),
    );
    supervisor.closeAll();
  });
});
