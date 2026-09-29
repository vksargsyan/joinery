import { MessageChannel } from 'node:worker_threads';

import { schemaSnapshotSchema, type SchemaSnapshot } from '@joinery/core';
import { createClient, fromNodePort, mainContract, serve } from '@joinery/ipc';
import { openStore, type SecretSealer, type Store } from '@joinery/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { fakeHosts, profileInput } from './helpers';

/**
 * The metadata cache and snippet methods of the main contract, served over a real RPC port with
 * an in-memory store: snapshots round-trip per profile and database, and snippets are filtered
 * by engine.
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

function setup() {
  const store = openStore(':memory:', { sealer });
  const hosts = fakeHosts();
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor: new ConnectionSupervisor<string>({ spawn: hosts.spawn }),
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'host', remote: 'renderer' }),
      appInfo: () => ({
        name: 'Joinery',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
    },
    { sendPort: () => {}, openFile: async () => null },
  );
  const channel = new MessageChannel();
  open.push({ store, channel });
  serve(fromNodePort(channel.port2), mainContract, handlers);
  return { store, main: createClient(fromNodePort(channel.port1), mainContract) };
}

function snapshot(database: string, table = 'orders'): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    database,
    schemas: [
      {
        name: 'public',
        tables: [
          {
            name: table,
            columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: false }],
          },
        ],
      },
    ],
    capturedAt: '2026-09-29T10:00:00.000Z',
  });
}

describe('metadata cache methods', () => {
  it('stores snapshots per profile and database and reads them back', async () => {
    const { main } = setup();
    const a = await main.profiles.save({ profile: profileInput() });
    const b = await main.profiles.save({ profile: profileInput() });

    expect(await main.metadata.get({ profileId: a.id })).toEqual([]);
    const info = await main.metadata.put({ profileId: a.id, snapshot: snapshot('shop') });
    expect(info).toMatchObject({ profileId: a.id, database: 'shop' });
    await main.metadata.put({ profileId: a.id, snapshot: snapshot('crm') });
    await main.metadata.put({ profileId: b.id, snapshot: snapshot('shop', 'invoices') });
    // A refresh replaces the database's snapshot.
    await main.metadata.put({ profileId: a.id, snapshot: snapshot('shop', 'order_lines') });

    const cached = await main.metadata.get({ profileId: a.id });
    expect(cached.map((entry) => entry.database)).toEqual(['crm', 'shop']);
    expect(cached[1]?.snapshot.schemas[0]?.tables[0]?.name).toBe('order_lines');
    const onlyShop = await main.metadata.get({ profileId: a.id, databases: ['shop', 'nope'] });
    expect(onlyShop.map((entry) => entry.database)).toEqual(['shop']);
    const other = await main.metadata.get({ profileId: b.id });
    expect(other[0]?.snapshot.schemas[0]?.tables[0]?.name).toBe('invoices');
  });

  it('drops one database or every database of a profile', async () => {
    const { main } = setup();
    const a = await main.profiles.save({ profile: profileInput() });
    await main.metadata.put({ profileId: a.id, snapshot: snapshot('shop') });
    await main.metadata.put({ profileId: a.id, snapshot: snapshot('crm') });
    expect(await main.metadata.invalidate({ profileId: a.id, database: 'crm' })).toEqual({
      dropped: 1,
    });
    expect((await main.metadata.get({ profileId: a.id })).map((e) => e.database)).toEqual(['shop']);
    expect(await main.metadata.invalidate({ profileId: a.id })).toEqual({ dropped: 1 });
    expect(await main.metadata.get({ profileId: a.id })).toEqual([]);
  });

  it('refuses snapshots for unknown profiles', async () => {
    const { main } = setup();
    await expect(
      main.metadata.put({ profileId: 'missing', snapshot: snapshot('shop') }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('snippets.list', () => {
  it('lists the library, filtered by engine', async () => {
    const { main, store } = setup();
    store.snippets.create({ name: 'Select all', prefix: 'sel', body: 'SELECT * FROM ${1:t}' });
    store.snippets.create({
      name: 'Vacuum',
      prefix: 'vac',
      body: 'VACUUM ANALYZE ${1:t}',
      engines: ['postgres'],
    });
    expect((await main.snippets.list()).map((s) => s.name)).toEqual(['Select all', 'Vacuum']);
    expect((await main.snippets.list({ engine: 'mysql' })).map((s) => s.prefix)).toEqual(['sel']);
    expect((await main.snippets.list({ engine: 'postgres' })).map((s) => s.prefix)).toEqual([
      'sel',
      'vac',
    ]);
  });
});
