import { MessageChannel } from 'node:worker_threads';

import { createClient, fromNodePort, mainContract, serve } from '@querybara/ipc';
import { openStore, type PreviousRun, type SecretSealer, type Store } from '@querybara/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { fakeHosts, profileInput } from './helpers';

/**
 * Saved table views and editor autosave through the main contract, over a real RPC port with an
 * in-memory store.
 */

const sealer: SecretSealer = {
  id: 'test-plain',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain),
  unseal: (sealed) => new TextDecoder().decode(sealed),
};

const open: { store: Store; channel: MessageChannel }[] = [];

afterEach(() => {
  for (const { store, channel } of open.splice(0)) {
    channel.port1.close();
    channel.port2.close();
    store.close();
  }
});

function setup(previousRun?: PreviousRun['ended']) {
  const store = openStore(':memory:', { sealer });
  const hosts = fakeHosts();
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor: new ConnectionSupervisor<string>({ spawn: hosts.spawn }),
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'host', remote: 'renderer' }),
      appInfo: () => ({
        name: 'Querybara',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
      ...(previousRun === undefined ? {} : { previousRun }),
    },
    { sendPort: () => {}, openFile: async () => null },
  );
  const channel = new MessageChannel();
  open.push({ store, channel });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  return { store, main: createClient(fromNodePort(channel.port1), mainContract) };
}

describe('saved grid views', () => {
  it('saves, lists, moves the default and deletes views of a table', async () => {
    const { main } = setup();
    const profile = await main.profiles.save({ profile: profileInput() });
    const table = { profileId: profile.id, database: null, schema: 'public', table: 'items' };
    const layout = {
      columns: [
        { name: 'id', pinned: true },
        { name: 'name', width: 300 },
      ],
    };
    const first = await main.gridViews.save({
      ...table,
      name: 'Wide names',
      layout,
      sort: [{ column: 'name', direction: 'asc' }],
      filter: null,
      isDefault: true,
    });
    const second = await main.gridViews.save({
      ...table,
      name: 'Plain',
      layout: { columns: [] },
      sort: [],
      filter: '{"mode":"raw","raw":"id > 2"}',
    });
    expect((await main.gridViews.list(table)).map((v) => [v.name, v.isDefault])).toEqual([
      ['Wide names', true],
      ['Plain', false],
    ]);
    await main.gridViews.setDefault({ table, id: second.id });
    expect((await main.gridViews.list(table))[0]).toMatchObject({ id: second.id, isDefault: true });

    // Losing the default was a change too, so the view is at version 2 now.
    const stale = { ...table, id: first.id, name: 'Renamed', layout, sort: [], filter: null };
    await expect(
      main.gridViews.save({ ...stale, expectedVersion: first.version }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const renamed = await main.gridViews.save({ ...stale, expectedVersion: 2 });
    expect(renamed).toMatchObject({ name: 'Renamed', version: 3, isDefault: false });
    await expect(
      main.gridViews.save({ ...table, name: 'plain', layout, sort: [], filter: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await main.gridViews.delete({ id: first.id });
    expect((await main.gridViews.list(table)).map((v) => v.name)).toEqual(['Plain']);
  });
});

describe('editor autosave', () => {
  it('restores the saved buffers with how the previous run ended', async () => {
    const { main } = setup('unclean');
    const profile = await main.profiles.save({ profile: profileInput() });
    expect(await main.autosave.restore()).toEqual({ previousRun: 'unclean', entries: [] });
    const entry = {
      id: 'tab-1',
      kind: 'sql' as const,
      profileId: profile.id,
      database: null,
      title: 'Local query',
      text: 'SELECT 1',
      cursor: 8,
      position: 0,
    };
    await main.autosave.save({ upsert: [entry], remove: [] });
    await main.autosave.save({
      upsert: [{ ...entry, id: 'tab-2', text: 'SELECT 2', position: 1 }],
      remove: ['tab-1'],
    });
    const restored = await main.autosave.restore();
    expect(restored.entries).toEqual([
      { ...entry, id: 'tab-2', text: 'SELECT 2', position: 1, savedAt: expect.any(String) },
    ]);
  });

  it('reports a first run when main was given no previous run', async () => {
    const { main } = setup();
    expect((await main.autosave.restore()).previousRun).toBe('none');
  });
});
