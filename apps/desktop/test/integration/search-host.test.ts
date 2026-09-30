import { randomBytes } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import {
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';
import { connectionHostContract, createClient, fromNodePort, type Client } from '@joinery/ipc';
import { parseConnectionUri } from '@joinery/storage';
import { afterAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { ConnectionHost } from '../../src/connection-host/host';

/**
 * The connection host's `search.*` services against the real servers (spec §11): the adapter
 * the app loads, a profile parsed from the test URL as "Fill from URI" does, and the renderer's
 * RPC client on a port. Indices are named for the run and deleted afterwards.
 */

const SERVERS = [
  { engine: 'elasticsearch' as const, url: process.env['JOINERY_TEST_ELASTICSEARCH_URL'] },
  { engine: 'opensearch' as const, url: process.env['JOINERY_TEST_OPENSEARCH_URL'] },
].filter((s): s is { engine: 'elasticsearch' | 'opensearch'; url: string } => s.url !== undefined);

type HostClient = Client<(typeof connectionHostContract)['shape']>;

/**
 * An index name in SQL: double quotes on Elasticsearch, backquotes on OpenSearch, whose SQL
 * plugin reads a double-quoted name as a string.
 */
function sqlName(engine: 'elasticsearch' | 'opensearch', index: string): string {
  return engine === 'opensearch' ? `\`${index}\`` : `"${index}"`;
}

function resolvedFromUrl(
  engine: 'elasticsearch' | 'opensearch',
  url: string,
  presentation: ConnectionProfileInput['presentation'] = {},
): ResolvedProfile {
  const parsed = parseConnectionUri(url, { engine });
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: newId(),
    presentation,
    createdAt: now,
    updatedAt: now,
  });
  const ref = profile.auth.method === 'password' ? profile.auth.password : undefined;
  return {
    profile,
    secrets: ref && parsed.password !== undefined ? { [ref.id]: parsed.password } : {},
  };
}

const hosts: ConnectionHost[] = [];
const channels: MessageChannel[] = [];

async function start(
  engine: 'elasticsearch' | 'opensearch',
  url: string,
  presentation: ConnectionProfileInput['presentation'] = {},
): Promise<{ client: HostClient; sessionId: string }> {
  const host = new ConnectionHost(
    await loadAdapter(engine),
    resolvedFromUrl(engine, url, presentation),
  );
  const info = await host.start();
  expect(info).toMatchObject({ engine, capabilities: { queryCancel: true } });
  hosts.push(host);
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId };
}

afterAll(async () => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  await Promise.all(hosts.map((host) => host.shutdown()));
});

describe.skipIf(SERVERS.length === 0).each(SERVERS)(
  '$engine through the connection host',
  (server) => {
    const index = `joinery-host-${randomBytes(4).toString('hex')}`;

    it('creates an index, writes and pages documents, and cleans up under the write rules', async () => {
      const { client, sessionId } = await start(server.engine, server.url);
      try {
        await client.search.indices.create({
          sessionId,
          name: index,
          body: '{"settings": {"number_of_replicas": 0}}',
        });
        const bulk = Array.from(
          { length: 12 },
          (_, i) => `{"index":{"_id":"${i}"}}\n{"n":${i},"big":1234567890123456789}\n`,
        ).join('');
        expect(
          (await client.search.documents.bulk({ sessionId, ndjson: bulk, index, refresh: true }))
            .errors,
        ).toBe(false);
        const pages = [];
        for await (const page of client.search.documents.search({
          sessionId,
          target: index,
          body: '{"sort": [{"n": "asc"}]}',
          pageSize: 5,
        })) {
          pages.push(page);
        }
        expect(pages.map((p) => p.hits.length)).toEqual([5, 5, 2]);
        expect(pages[0]!.hits[0]!.source).toBe('{"n":0,"big":1234567890123456789}');
        const list = await client.search.indices.list({ sessionId, pattern: index });
        expect(list[0]).toMatchObject({ name: index, health: 'green', docsCount: 12 });
        const nodes = await client.browse({ sessionId, path: ['indices'] });
        expect(nodes.find((n) => n.name === index)).toMatchObject({ kind: 'index' });

        // The console's raw request: reads run; a delete needs the page's confirmation.
        const count = await client.search.request({
          sessionId,
          request: { method: 'GET', path: `/${index}/_count` },
        });
        expect(count.body).toContain('"count":12');
        await expect(
          client.search.request({ sessionId, request: { method: 'DELETE', path: `/${index}` } }),
        ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      } finally {
        await client.search.indices
          .delete({ sessionId, names: [index], confirmed: true })
          .catch(() => undefined);
      }
      expect(await client.search.indices.list({ sessionId, pattern: `${index}*` })).toEqual([]);
    });

    it('runs console text through execute and refuses writes on a read-only profile', async () => {
      const { client, sessionId } = await start(server.engine, server.url, { readOnly: true });
      const rows: string[] = [];
      for await (const chunk of client.execute({
        sessionId,
        text: 'GET /_cluster/health\n\nPOST /_search\n{"size": 0}',
        executionId: newId(),
      })) {
        if (chunk.type === 'rows') rows.push(String(chunk.data[0]![0]));
      }
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('"cluster_name"');
      await expect(
        client.search.indices.create({ sessionId, name: `${index}-ro`, confirmed: true }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      await expect(
        client.search.request({
          sessionId,
          request: { method: 'PUT', path: `/${index}-ro` },
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      const info = await client.search.clusterInfo({ sessionId });
      expect(info.distribution).toBe(server.engine);
    });

    it('resizes, reindexes as a task, explains allocation and runs SQL through the host', async () => {
      const { client, sessionId } = await start(server.engine, server.url);
      const source = `${index}-src`;
      const clone = `${index}-clone`;
      const copy = `${index}-copy`;
      try {
        await client.search.indices.create({
          sessionId,
          name: source,
          body: '{"settings": {"number_of_replicas": 0}, "mappings": {"properties": {"k": {"type": "keyword"}}}}',
        });
        await client.search.documents.bulk({
          sessionId,
          ndjson: '{"index":{}}\n{"k":"a"}\n{"index":{}}\n{"k":"b"}\n{"index":{}}\n{"k":"a"}\n',
          index: source,
          refresh: true,
        });
        // Blocking the source's writes needs the page's confirmation.
        await expect(
          client.search.indexAdmin.resize({
            sessionId,
            kind: 'clone',
            source,
            target: clone,
            blockSource: true,
            unblockSource: true,
          }),
        ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
        await client.search.indexAdmin.resize({
          sessionId,
          kind: 'clone',
          source,
          target: clone,
          blockSource: true,
          unblockSource: true,
          confirmed: true,
        });
        expect(await client.search.documents.count({ sessionId, target: clone })).toEqual({
          count: 3,
        });

        const { taskId } = await client.search.indexAdmin.reindex({
          sessionId,
          source: [source],
          dest: copy,
        });
        let task = await client.search.tasks.get({ sessionId, taskId });
        for (let i = 0; i < 200 && !task.completed; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          task = await client.search.tasks.get({ sessionId, taskId });
        }
        expect(task).toMatchObject({ completed: true, progress: { total: 3, created: 3 } });

        const shards = await client.search.allocation.shards({ sessionId, index: source });
        expect(shards[0]).toMatchObject({ index: source, primary: true, state: 'STARTED' });
        const explain = await client.search.allocation.explain({
          sessionId,
          shard: { index: source, shard: 0, primary: true },
        });
        expect(explain.currentState).toBe('started');
        expect((await client.search.allocation.disk({ sessionId })).nodes.length).toBeGreaterThan(
          0,
        );

        const info = await client.search.clusterInfo({ sessionId });
        if (info.capabilities.sql !== null) {
          const rows: string[][] = [];
          for await (const page of client.search.sql.query({
            sessionId,
            query: `SELECT k, COUNT(*) AS c FROM ${sqlName(server.engine, source)} GROUP BY k ORDER BY k`,
          })) {
            rows.push(...page.rows.map((r) => [...r]));
          }
          expect(rows).toEqual([
            ['"a"', '2'],
            ['"b"', '1'],
          ]);
        }
        const simulated = await client.search.pipelines.simulate({
          sessionId,
          pipeline: '{"processors": [{"uppercase": {"field": "k"}}]}',
          docs: '[{"k": "x"}]',
        });
        expect(simulated[0]!.source).toContain('"X"');
      } finally {
        await client.search.indices
          .delete({ sessionId, names: [source, clone, copy], confirmed: true })
          .catch(() => undefined);
      }
    });
  },
);
