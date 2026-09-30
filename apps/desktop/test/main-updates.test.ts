import { MessageChannel } from 'node:worker_threads';

import {
  DEFAULT_APP_SETTINGS,
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type AppSettings,
} from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers, readAppSettings } from '../src/main/api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { NO_POLICY } from '../src/main/update-policy';
import { AppCommands, UpdateController } from '../src/main/updates';
import { fakeHosts } from './helpers';

/**
 * The update preferences, status and menu commands through the main contract (spec §20), over a
 * real RPC server so the zod schemas check both ways.
 */

const sealer: SecretSealer = {
  id: 'test-plain',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain),
  unseal: (sealed) => new TextDecoder().decode(sealed),
};

const stores: Store[] = [];
const channels: MessageChannel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = openStore(':memory:', { sealer });
  stores.push(store);
  const hosts = fakeHosts();
  const changed: AppSettings[] = [];
  const updates = new UpdateController({
    currentVersion: '0.1.0',
    settings: readAppSettings(store, DEFAULT_APP_SETTINGS),
    environment: {
      availability: { enabled: false, reason: 'test-build' },
      policy: NO_POLICY,
      install: 'linux-other',
    },
    createUpdater: () => Promise.reject(new Error('not used')),
  });
  const commands = new AppCommands();
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor: new ConnectionSupervisor<string>({ spawn: hosts.spawn }),
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'l', remote: 'r' }),
      appInfo: () => ({
        name: 'Joinery',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '22' },
      }),
      openExternal: async () => {},
      updates,
      appCommands: commands,
      onSettingsChanged: (settings) => {
        changed.push(settings);
        updates.applySettings(settings);
      },
    },
    { sendPort: () => undefined, openFile: async () => null },
  );
  const channel = new MessageChannel();
  channels.push(channel);
  serve(fromNodePort(channel.port2), mainContract, handlers);
  const main = createClient(fromNodePort(channel.port1), mainContract);
  return { main, store, updates, commands, changed };
}

describe('updates through the main contract', () => {
  it('keeps the channel and automatic checks as settings the updater follows', async () => {
    const { main, store, updates, changed } = setup();
    await updates.start();
    expect(await main.settings.get()).toMatchObject({
      updateChannel: 'stable',
      updateAutoCheck: true,
    });
    const next = await main.settings.set({ updateChannel: 'beta', updateAutoCheck: false });
    expect(next).toMatchObject({ updateChannel: 'beta', updateAutoCheck: false });
    expect(changed.at(-1)).toMatchObject({ updateChannel: 'beta', updateAutoCheck: false });
    expect(updates.status()).toMatchObject({ channel: 'beta', autoCheck: false });
    // Stored as a patch over the defaults: read back the same way at the next start.
    expect(readAppSettings(store, DEFAULT_APP_SETTINGS)).toMatchObject({
      updateChannel: 'beta',
      updateAutoCheck: false,
    });
  });

  it('streams the status, answers a check and refuses a restart with nothing ready', async () => {
    const { main, updates } = setup();
    await updates.start();
    const abort = new AbortController();
    const stream = main.updates.status(undefined, { signal: abort.signal })[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.value).toMatchObject({
      currentVersion: '0.1.0',
      state: { state: 'off', reason: 'test-build' },
      requestId: 0,
    });
    await main.updates.check();
    const second = await stream.next();
    expect(second.value).toMatchObject({ state: { state: 'off' }, requestId: 1 });
    await expect(main.updates.install()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    abort.abort();
  });

  it('relays menu commands to the page', async () => {
    const { main, commands } = setup();
    const abort = new AbortController();
    const stream = main.app.commands(undefined, { signal: abort.signal })[Symbol.asyncIterator]();
    const next = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    commands.send('about');
    expect((await next).value).toEqual({ command: 'about' });
    abort.abort();
  });
});
