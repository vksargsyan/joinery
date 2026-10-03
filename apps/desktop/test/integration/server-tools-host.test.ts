import { randomBytes } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import {
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type EngineId,
  type ResolvedProfile,
} from '@querybara/core';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';
import { connectionHostContract, createClient, fromNodePort, type Client } from '@querybara/ipc';
import { parseConnectionUri } from '@querybara/storage';
import { afterAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { ConnectionHost } from '../../src/connection-host/host';

/**
 * The connection host's `serverTools.*` services over a port against the real servers (spec
 * §15): every read of every engine crosses the zod-validated contract (so the schemas hold for
 * real data), and the write rules are enforced by the host for read-only and production
 * profiles whatever the page sends.
 */

type HostClient = Client<(typeof connectionHostContract)['shape']>;

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const SQL_TARGETS = (
  [
    ['postgres', PG_URL],
    ['mysql', process.env['QUERYBARA_TEST_MYSQL_URL']],
    ['mariadb', process.env['QUERYBARA_TEST_MARIADB_URL']],
  ] as const
).filter((entry): entry is readonly ['postgres' | 'mysql' | 'mariadb', string] => !!entry[1]);

const hosts: ConnectionHost[] = [];
const channels: MessageChannel[] = [];

afterAll(async () => {
  await Promise.all(hosts.map((h) => h.shutdown()));
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

function sqlProfile(
  engine: 'postgres' | 'mysql' | 'mariadb',
  url: string,
  presentation: ConnectionProfileInput['presentation'] = {},
): ResolvedProfile {
  return resolvedProfileFromUrl(url, { engine, presentation, name: `Server tools ${engine}` });
}

function mongoProfile(url: string): ResolvedProfile {
  const parsed = new URL(url);
  parsed.searchParams.set('tls', 'false');
  const uri = parseConnectionUri(parsed.toString());
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...uri.profile,
    id: newId(),
    createdAt: now,
    updatedAt: now,
  });
  const ref = profile.auth.method === 'password' ? profile.auth.password : undefined;
  return {
    profile,
    secrets: ref && uri.password !== undefined ? { [ref.id]: uri.password } : {},
  };
}

async function open(
  engine: EngineId,
  resolved: ResolvedProfile,
): Promise<{ client: HostClient; sessionId: string }> {
  const host = new ConnectionHost(await loadAdapter(engine), resolved);
  await host.start();
  hosts.push(host);
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId };
}

for (const [engine, url] of SQL_TARGETS) {
  describe(`server tools over the host: ${engine}`, () => {
    it('reads every tab through the contract', async () => {
      const { client, sessionId } = await open(engine, sqlProfile(engine, url));
      const tools = client.serverTools;
      const info = await tools.info({ sessionId });
      expect(info.engine).toBe(engine);
      const monitor = await tools.monitor({ sessionId });
      expect(monitor.tiles.length).toBeGreaterThan(5);
      const sessions = await tools.sessions({ sessionId, options: { includeIdle: true } });
      expect(sessions.sessions.some((s) => s.own)).toBe(true);
      const top = await tools.topQueries({ sessionId, options: { limit: 5 } });
      expect(top.unavailable !== null || top.queries.length > 0).toBe(true);
      const accounts = await tools.accounts({ sessionId });
      expect(accounts.accounts.length).toBeGreaterThan(0);
      const grantee = accounts.accounts.find((a) => !a.builtin && a.name !== '')!;
      const matrix = await tools.grants({
        sessionId,
        grantee:
          grantee.host !== undefined
            ? { name: grantee.name, host: grantee.host }
            : { name: grantee.name },
      });
      expect(matrix.rows.length).toBeGreaterThan(0);
      const targets = await tools.maintenanceTargets({ sessionId });
      expect(targets.containers.length).toBeGreaterThan(0);
      const settings = await tools.settings({ sessionId });
      expect(settings.settings.length).toBeGreaterThan(100);
      if (engine === 'postgres') {
        const details = await tools.accessDetails({ sessionId });
        expect(details.schemas).toContain(details.schema);
      } else {
        await expect(tools.accessDetails({ sessionId })).rejects.toMatchObject({
          code: 'NOT_SUPPORTED',
        });
      }
    });
  });
}

describe.skipIf(!PG_URL)('server tools write rules in the host (PostgreSQL)', () => {
  const role = `st_host_${randomBytes(4).toString('hex')}`;

  it('refuses every change on a read-only profile, but previews it', async () => {
    const { client, sessionId } = await open(
      'postgres',
      sqlProfile('postgres', PG_URL!, { readOnly: true }),
    );
    const action = {
      kind: 'createAccount',
      account: { name: role },
      role: true,
      options: {},
    } as const;
    expect((await client.serverTools.preview({ sessionId, action })).statements).toEqual([
      `CREATE ROLE "${role}" WITH NOLOGIN`,
    ]);
    await expect(
      client.serverTools.run({ sessionId, action, confirmed: true }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    // Session settings stay allowed: they change nothing for anyone else.
    await client.serverTools.run({
      sessionId,
      action: { kind: 'setting', name: 'work_mem', value: '8MB', scope: 'session' },
      confirmed: true,
    });
  });

  it('needs confirmation for every change on production, and for kills everywhere', async () => {
    const production = await open(
      'postgres',
      sqlProfile('postgres', PG_URL!, { environment: 'production' }),
    );
    const create = {
      kind: 'createAccount',
      account: { name: role },
      role: true,
      options: {},
    } as const;
    await expect(
      production.client.serverTools.run({ sessionId: production.sessionId, action: create }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    try {
      const result = await production.client.serverTools.run({
        sessionId: production.sessionId,
        action: create,
        confirmed: true,
      });
      expect(result.statements).toEqual([`CREATE ROLE "${role}" WITH NOLOGIN`]);
    } finally {
      await production.client.serverTools
        .run({
          sessionId: production.sessionId,
          action: { kind: 'dropAccount', account: { name: role }, role: true },
          confirmed: true,
        })
        .catch(() => undefined);
    }
    const dev = await open('postgres', sqlProfile('postgres', PG_URL!));
    await expect(
      dev.client.serverTools.run({
        sessionId: dev.sessionId,
        action: { kind: 'session', operation: 'terminate', id: '1' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
});

describe.skipIf(!MONGO_URL)('server tools over the host: mongodb', () => {
  it('reads the tabs MongoDB has and points users to its own editor', async () => {
    const { client, sessionId } = await open('mongodb', mongoProfile(MONGO_URL!));
    const tools = client.serverTools;
    const info = await tools.info({ sessionId });
    expect(info).toMatchObject({ engine: 'mongodb', access: [] });
    const monitor = await tools.monitor({ sessionId });
    expect(monitor.sections.find((s) => s.id === 'replica-set')?.table.rows.length).toBeGreaterThan(
      0,
    );
    const sessions = await tools.sessions({ sessionId, options: { includeIdle: false } });
    // The tools' own $currentOp is listed, marked as theirs.
    expect(sessions.sessions.filter((s) => s.own)).toHaveLength(1);
    const top = await tools.topQueries({ sessionId, options: { database: 'admin' } });
    expect(top.profiler?.database).toBe('admin');
    expect((await tools.settings({ sessionId })).settings.length).toBeGreaterThan(50);
    const targets = await tools.maintenanceTargets({ sessionId, container: 'admin' });
    expect(targets.container).toBe('admin');
    await expect(tools.accounts({ sessionId })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});
