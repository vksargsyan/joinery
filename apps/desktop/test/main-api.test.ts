import { MessageChannel } from 'node:worker_threads';

import { type ConnectionCheckResult } from '@joinery/core';
import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type MainContract,
  type PortLike,
} from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import type { PortPayload } from '../src/shared/bridge';
import { SERVER_INFO, fakeHosts, profileInput, type FakeHostProcess } from './helpers';

/**
 * The main contract handlers behind a real RPC server, with an in-memory store and fake
 * connection hosts. Everything the renderer receives is recorded to prove that no secret ever
 * travels towards it (spec §3, §18), while the hosts do get what they need.
 */

const SECRET = 'hunter2-Sup3r$ecret';
const ASKED = 'typed-at-connect-9f1c';

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const open: { store: Store; ports: MessageChannel[] }[] = [];

afterEach(() => {
  for (const { store, ports } of open.splice(0)) {
    for (const channel of ports) {
      channel.port1.close();
      channel.port2.close();
    }
    store.close();
  }
});

function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? [...v] : v,
  );
}

function setup(options: { canSave?: boolean } = {}) {
  const store = openStore(':memory:', {
    sealer: { ...sealer, isAvailable: () => options.canSave ?? true },
  });
  const hosts = fakeHosts((process, message) => {
    if (message.type === 'connect') {
      setImmediate(() => process.emit({ type: 'ready', info: SERVER_INFO }));
    }
    if (message.type === 'check') {
      setImmediate(() => {
        const result: ConnectionCheckResult = { step: 'auth', status: 'ok', durationMs: 1 };
        process.emit({ type: 'check-step', result });
        process.emit({ type: 'check-done' });
      });
    }
  });
  const supervisor = new ConnectionSupervisor<string>({ spawn: hosts.spawn });
  const sentPorts: { payload: PortPayload; port: string }[] = [];
  let channels = 0;
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor,
      spawnHost: hosts.spawn,
      createChannel: () => {
        channels++;
        return { local: `host-end-${channels}`, remote: `renderer-end-${channels}` };
      },
      appInfo: () => ({
        name: 'Joinery',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
    },
    {
      sendPort: (payload, port) => sentPorts.push({ payload, port }),
      openFile: async () => null,
    },
  );
  const channel = new MessageChannel();
  open.push({ store, ports: [channel] });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  // Everything that reaches the renderer's end of the port.
  const received: unknown[] = [];
  const recorded: PortLike = fromNodePort(channel.port1);
  const renderer: PortLike = {
    ...recorded,
    onMessage: (listener) =>
      recorded.onMessage((data) => {
        received.push(data);
        listener(data);
      }),
  };
  const main: Client<MainContract['shape']> = createClient(renderer, mainContract);
  const leaked = (): boolean => {
    const everything = serialise(received) + serialise(sentPorts);
    return everything.includes(SECRET) || everything.includes(ASKED);
  };
  return { store, hosts, supervisor, main, sentPorts, received, leaked };
}

async function saveProfileWithPassword(
  main: Client<MainContract['shape']>,
  policy: 'save' | 'session' | 'ask',
) {
  const passwordId = crypto.randomUUID();
  const saved = await main.profiles.save({
    profile: profileInput({
      auth: { method: 'password', user: 'app', password: { id: passwordId, policy } },
    }),
  });
  if (policy !== 'ask') {
    await main.secrets.set({ profileId: saved.id, refId: passwordId, value: SECRET });
  }
  return { saved, passwordId };
}

function connectMessages(hosts: { processes: FakeHostProcess[] }) {
  return hosts.processes.flatMap((p) => p.messagesOfType('connect'));
}

describe('main contract handlers', () => {
  it('seals a saved password and never returns it', async () => {
    const { main, store, leaked } = setup();
    const { saved, passwordId } = await saveProfileWithPassword(main, 'save');
    expect(await main.profiles.list()).toHaveLength(1);
    expect(await main.profiles.get({ id: saved.id })).toMatchObject({ id: saved.id, version: 1 });
    expect(await main.profiles.secretStatus({ profileId: saved.id })).toEqual({
      canSave: true,
      missing: [],
    });
    const row = store.db.get('SELECT sealed FROM secrets WHERE id = ?', [passwordId]);
    expect(new TextDecoder().decode(row?.['sealed'] as Uint8Array)).not.toContain(SECRET);
    expect(leaked()).toBe(false);
  });

  it('sends the resolved secrets to the connection host, and only a port id to the renderer', async () => {
    const { main, hosts, sentPorts, leaked } = setup();
    const { saved, passwordId } = await saveProfileWithPassword(main, 'save');
    const { connectionId } = await main.openConnection({ profileId: saved.id });

    const [connect] = connectMessages(hosts);
    expect(connect?.resolved.secrets[passwordId]).toBe(SECRET);
    expect(connect?.resolved.profile.id).toBe(saved.id);
    // The host got one end of the channel, the renderer the other, tagged by connection id only.
    expect(hosts.processes[0]?.sent.at(-1)).toEqual({
      message: { type: 'attach' },
      ports: ['host-end-1'],
    });
    expect(sentPorts).toEqual([
      { payload: { kind: 'connection', connectionId }, port: 'renderer-end-1' },
    ]);
    // Joining again hands out a new port to the same host.
    expect(await main.openConnection({ profileId: saved.id })).toEqual({ connectionId });
    expect(hosts.processes).toHaveLength(1);
    expect(sentPorts).toHaveLength(2);
    expect(leaked()).toBe(false);
  });

  it('asks for "ask every time" secrets and passes the typed value straight to the host', async () => {
    const { main, hosts, store, leaked } = setup();
    const { saved, passwordId } = await saveProfileWithPassword(main, 'ask');
    expect(await main.profiles.secretStatus({ profileId: saved.id })).toEqual({
      canSave: true,
      missing: [{ refId: passwordId, policy: 'ask', unreadable: false, label: 'Password' }],
    });
    await expect(main.openConnection({ profileId: saved.id })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(hosts.processes).toHaveLength(0);

    await main.openConnection({ profileId: saved.id, secrets: { [passwordId]: ASKED } });
    expect(connectMessages(hosts)[0]?.resolved.secrets[passwordId]).toBe(ASKED);
    // Nothing was stored for an "ask" secret.
    expect(store.db.get('SELECT count(*) AS n FROM secrets')?.['n']).toBe(0);
    expect(store.secrets.get({ id: passwordId, policy: 'ask' })).toBeUndefined();
    expect(leaked()).toBe(false);
  });

  it('remembers a session secret typed after a restart for the rest of the session', async () => {
    const { main, store } = setup();
    const { saved, passwordId } = await saveProfileWithPassword(main, 'session');
    store.secrets.clearSession();
    expect((await main.profiles.secretStatus({ profileId: saved.id })).missing).toEqual([
      { refId: passwordId, policy: 'session', unreadable: false, label: 'Password' },
    ]);
    await main.openConnection({ profileId: saved.id, secrets: { [passwordId]: ASKED } });
    expect(store.secrets.get({ id: passwordId, policy: 'session' })).toBe(ASKED);
  });

  it('refuses to save a secret when the system has no secure storage', async () => {
    const { main } = setup({ canSave: false });
    expect((await main.profiles.secretStatus({})).canSave).toBe(false);
    const passwordId = crypto.randomUUID();
    const saved = await main.profiles.save({
      profile: profileInput({
        auth: { method: 'password', password: { id: passwordId, policy: 'save' } },
      }),
    });
    await expect(
      main.secrets.set({ profileId: saved.id, refId: passwordId, value: SECRET }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('runs Test Connection on an unsaved profile with one-call secrets', async () => {
    const { main, hosts, leaked } = setup();
    const passwordId = crypto.randomUUID();
    const profile = profileInput({
      auth: { method: 'password', password: { id: passwordId, policy: 'ask' } },
    });
    const steps: ConnectionCheckResult[] = [];
    for await (const step of main.testConnection({ profile, secrets: { [passwordId]: ASKED } })) {
      steps.push(step);
    }
    expect(steps).toEqual([{ step: 'auth', status: 'ok', durationMs: 1 }]);
    const check = hosts.processes[0]?.messagesOfType('check')[0];
    expect(check?.resolved.secrets[passwordId]).toBe(ASKED);
    expect(hosts.processes[0]?.killed).toBe(true);
    expect(await main.profiles.list()).toEqual([]);
    expect(leaked()).toBe(false);
  });

  it('only accepts secrets for references the profile has', async () => {
    const { main } = setup();
    const { saved } = await saveProfileWithPassword(main, 'save');
    await expect(
      main.secrets.set({ profileId: saved.id, refId: crypto.randomUUID(), value: SECRET }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      main.secrets.set({ profileId: saved.id, refId: 'not-a-uuid', value: SECRET }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('parses a pasted URI without handing its password back', async () => {
    const { main, leaked } = setup();
    const parsed = await main.profiles.parseUri({
      uri: `postgresql://app:${encodeURIComponent(SECRET)}@db.example.com:6543/sales?sslmode=require`,
    });
    expect(parsed.passwordFound).toBe(true);
    expect(parsed.profile).toMatchObject({
      engine: 'postgres',
      endpoint: { kind: 'host', host: 'db.example.com', port: 6543 },
      tls: { mode: 'require' },
      options: { defaultDatabase: 'sales' },
    });
    expect(leaked()).toBe(false);
    await expect(main.profiles.parseUri({ uri: 'nonsense://' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('deletes a profile, its secrets and its connection', async () => {
    const { main, store, supervisor } = setup();
    const { saved, passwordId } = await saveProfileWithPassword(main, 'save');
    await main.openConnection({ profileId: saved.id });
    await main.profiles.delete({ id: saved.id });
    expect(supervisor.findByProfile(saved.id)).toBeUndefined();
    expect(await main.profiles.list()).toEqual([]);
    expect(store.secrets.get({ id: passwordId, policy: 'save' })).toBeUndefined();
  });

  it('records and searches history, and merges settings', async () => {
    const { main } = setup();
    const { saved } = await saveProfileWithPassword(main, 'save');
    await main.history.add({
      profileId: saved.id,
      text: 'select * from orders',
      status: 'success',
      rowCount: 3,
      durationMs: 5,
    });
    await main.history.add({
      profileId: saved.id,
      text: 'selec 1',
      status: 'error',
      error: 'syntax error',
    });
    expect((await main.history.list({ profileId: saved.id })).entries).toHaveLength(2);
    const found = await main.history.search({ query: 'orders' });
    expect(found.entries.map((e) => e.text)).toEqual(['select * from orders']);

    expect((await main.settings.get()).editor.fontSize).toBe(13);
    const next = await main.settings.set({ editor: { fontSize: 15 }, theme: 'light' });
    expect(next.editor).toMatchObject({ fontSize: 15, tabSize: 2 });
    expect((await main.settings.get()).theme).toBe('light');
  });

  it('streams connection events', async () => {
    const { main, supervisor } = setup();
    const { saved } = await saveProfileWithPassword(main, 'save');
    const events = main.connectionEvents();
    const opened = await main.openConnection({ profileId: saved.id });
    const seen: string[] = [];
    for await (const event of events) {
      seen.push(event.state);
      if (event.state === 'ready') break;
    }
    expect(seen).toEqual(['connecting', 'ready']);
    supervisor.close(opened.connectionId);
  });

  it('opens only https links externally', async () => {
    const { main } = setup();
    await expect(main.app.openExternal({ url: 'https://joinery.dev' })).resolves.toBeUndefined();
    await expect(main.app.openExternal({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('resolved profiles', () => {
  it('hide secret values from JSON, inspect and string conversion but keep them readable', async () => {
    const { inspect } = await import('node:util');
    const { redactedRecord } = await import('../src/main/secrets');
    const record = redactedRecord(new Map([['s1', SECRET]]));
    expect(record['s1']).toBe(SECRET);
    expect(JSON.stringify({ secrets: record })).not.toContain(SECRET);
    expect(inspect(record)).not.toContain(SECRET);
    expect(String(record)).not.toContain(SECRET);
    // Structured clone (the utility process's parent port) still carries the value.
    expect({ ...structuredClone(record) }).toEqual({ s1: SECRET });
  });
});
