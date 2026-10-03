import { MessageChannel } from 'node:worker_threads';

import {
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import { connectionHostContract, createClient, fromNodePort } from '@querybara/ipc';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAdapter } from '../src/connection-host/adapters';
import { ConnectionHost } from '../src/connection-host/host';
import { fakeSearchAdapter } from './fake-search-session';
import { profileInput } from './helpers';

/** The connection host's `search.*` handlers and their write rules (spec §4, §11). */

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

function searchProfile(presentation: ConnectionProfileInput['presentation'] = {}): ResolvedProfile {
  return {
    profile: connectionProfileSchema.parse(
      profileInput({
        name: 'Logs',
        engine: 'elasticsearch',
        endpoint: { kind: 'urls', urls: ['http://localhost:9200'] },
        tls: { mode: 'disable' },
        presentation,
      }),
    ),
    secrets: {},
  };
}

async function startHost(presentation: ConnectionProfileInput['presentation'] = {}) {
  const adapter = fakeSearchAdapter();
  const host = new ConnectionHost(adapter, searchProfile(presentation));
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId, session: adapter.sessions[1]! };
}

describe('search handlers', () => {
  it('passes reads and JSON text straight through', async () => {
    const { client, sessionId, session } = await startHost();
    expect((await client.search.clusterInfo({ sessionId })).version).toBe('9.4.0');
    const pages = [];
    for await (const page of client.search.documents.search({
      sessionId,
      target: 'logs',
      body: '{"query": {"match_all": {}}}',
      pageSize: 50,
    })) {
      pages.push(page);
    }
    expect(pages[0]!.hits[0]!.source).toBe('{"n":12345678901234567890}');
    expect(session.calls.find((c) => c.method === 'search')?.args.slice(0, 2)).toEqual([
      'logs',
      '{"query": {"match_all": {}}}',
    ]);
    expect(await client.search.documents.count({ sessionId, target: 'logs' })).toEqual({
      count: 7,
    });
    const response = await client.search.request({
      sessionId,
      request: { method: 'POST', path: '/logs/_search', body: '{}' },
    });
    expect(response.body).toBe('{"echo": "/logs/_search"}');
  });

  it('asks for confirmation of destructive operations on every profile', async () => {
    const { client, sessionId, session } = await startHost();
    await expect(
      client.search.indices.delete({ sessionId, names: ['logs'] }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('deletes the indices'),
    });
    await expect(
      client.search.request({ sessionId, request: { method: 'DELETE', path: '/logs' } }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      client.search.documents.deleteByQuery({
        sessionId,
        target: 'logs',
        query: '{"match_all":{}}',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      client.search.documents.bulk({ sessionId, ndjson: '{"delete":{"_index":"a","_id":"1"}}\n' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    for (const method of ['close', 'forceMerge'] as const) {
      await expect(
        client.search.indices[method]({ sessionId, names: ['logs'] }),
      ).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
    }
    expect(session.calls.map((c) => c.method)).not.toContain('deleteIndices');
    // A dry run only counts; other writes run without asking on a dev profile.
    expect(
      (
        await client.search.documents.deleteByQuery({
          sessionId,
          target: 'logs',
          query: '{}',
          dryRun: true,
        })
      ).dryRun,
    ).toBe(true);
    await client.search.indices.create({ sessionId, name: 'fresh' });
    await client.search.indices.delete({ sessionId, names: ['logs'], confirmed: true });
    expect(session.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['deleteByQuery', 'createIndex', 'deleteIndices']),
    );
  });

  it('refuses every write on a read-only profile, and still reads', async () => {
    const { client, sessionId, session } = await startHost({ readOnly: true });
    const refused = [
      () => client.search.indices.create({ sessionId, name: 'x', confirmed: true }),
      () => client.search.documents.index({ sessionId, index: 'x', source: '{}', confirmed: true }),
      () => client.search.aliases.update({ sessionId, actions: '{"actions":[]}', confirmed: true }),
      () =>
        client.search.request({
          sessionId,
          request: { method: 'PUT', path: '/x' },
          confirmed: true,
        }),
    ];
    for (const call of refused) await expect(call()).rejects.toMatchObject({ code: 'READ_ONLY' });
    const read = await client.search.request({
      sessionId,
      request: { method: 'POST', path: '/x/_search', body: '{}' },
    });
    expect(read.status).toBe(200);
    expect(
      session.calls.filter((c) => c.method !== 'request' && c.method !== 'clusterInfo'),
    ).toEqual([]);
  });

  it('asks before every write on a production profile', async () => {
    const { client, sessionId } = await startHost({ environment: 'production' });
    await expect(
      client.search.documents.update({ sessionId, index: 'x', id: '1', doc: '{"a":1}' }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('production'),
    });
    expect(
      await client.search.documents.update({
        sessionId,
        index: 'x',
        id: '1',
        doc: '{"a":1}',
        confirmed: true,
        ifSeqNo: 3,
        ifPrimaryTerm: 1,
      }),
    ).toMatchObject({ result: 'updated' });
  });

  it('guards the generic execute: reads run, writes that need a confirmation are stopped', async () => {
    const { client, sessionId, session } = await startHost();
    for await (const _chunk of client.execute({
      sessionId,
      text: 'GET /_cluster/health\nPOST /x/_search\n{}',
      executionId: newId(),
    })) {
      // Drain.
    }
    expect(session.calls.find((c) => c.method === 'execute')).toBeDefined();
    const run = async (text: string) => {
      for await (const _chunk of client.execute({ sessionId, text, executionId: newId() })) {
        // Drain.
      }
    };
    await expect(run('DELETE /logs')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(run('POST /x/_search\n{ "a": ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const readOnly = await startHost({ readOnly: true });
    await expect(
      (async () => {
        for await (const _chunk of readOnly.client.execute({
          sessionId: readOnly.sessionId,
          text: 'PUT /x',
          executionId: newId(),
        })) {
          // Drain.
        }
      })(),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  it('streams SQL pages and runs reads of the query and administration services', async () => {
    const { client, sessionId, session } = await startHost({ readOnly: true });
    const pages = [];
    for await (const page of client.search.sql.query({ sessionId, query: 'SELECT n FROM logs' })) {
      pages.push(page);
    }
    expect(pages.map((p) => p.rows)).toEqual([[['12345678901234567890']], [['2']]]);
    expect(pages[0]!.more).toBe(true);
    expect(await client.search.sql.translate({ sessionId, query: 'SELECT 1' })).toMatchObject({
      target: 'logs',
    });
    expect(await client.search.tasks.get({ sessionId, taskId: 'n1:7' })).toMatchObject({
      id: 'n1:7',
    });
    await client.search.pipelines.simulate({ sessionId, id: 'p', docs: '[{}]' });
    await client.search.resources.list({ sessionId, kind: 'ingest-pipeline' });
    await client.search.snapshots.list({ sessionId, repository: 'r' });
    expect(session.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining([
        'sql',
        'translateSql',
        'getTask',
        'simulatePipeline',
        'listResources',
        'listSnapshots',
      ]),
    );
  });

  it('confirms blocking and destructive administration on every profile', async () => {
    const { client, sessionId, session } = await startHost();
    // Blocking the source of a clone asks; a resize without a block is an ordinary write.
    await expect(
      client.search.indexAdmin.resize({
        sessionId,
        kind: 'clone',
        source: 'a',
        target: 'b',
        blockSource: true,
      }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('blocks writes to a'),
    });
    await client.search.indexAdmin.resize({ sessionId, kind: 'clone', source: 'a', target: 'c' });
    // A settings change that turns on a block asks too; lifting one does not.
    await expect(
      client.search.indices.putSettings({
        sessionId,
        index: 'a',
        body: '{"index.blocks.write": true}',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await client.search.indices.putSettings({
      sessionId,
      index: 'a',
      body: '{"index.blocks.write": null}',
    });
    // An alias update that deletes an index (remove_index) asks.
    await expect(
      client.search.aliases.update({
        sessionId,
        actions: '{"actions": [{"remove_index": {"index": "a"}}]}',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    for (const call of [
      () =>
        client.search.snapshots.restore({ sessionId, repository: 'r', snapshot: 's', indices: [] }),
      () => client.search.snapshots.delete({ sessionId, repository: 'r', snapshot: 's' }),
      () => client.search.resources.delete({ sessionId, kind: 'index-template', name: 't' }),
      () => client.search.resources.delete({ sessionId, kind: 'snapshot-repository', name: 'r' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    }
    expect(session.calls.map((c) => c.method)).not.toEqual(
      expect.arrayContaining(['restoreSnapshot']),
    );
    // Creating things, starting a reindex and cancelling a task run on a dev profile.
    expect(await client.search.indexAdmin.reindex({ sessionId, source: ['a'], dest: 'b' })).toEqual(
      { taskId: 'n1:7' },
    );
    await client.search.resources.put({
      sessionId,
      kind: 'ingest-pipeline',
      name: 'p',
      body: '{"processors": []}',
    });
    await client.search.snapshots.create({ sessionId, repository: 'r', snapshot: 's' });
    await client.search.tasks.cancel({ sessionId, taskId: 'n1:7' });
    await client.search.snapshots.restore({
      sessionId,
      repository: 'r',
      snapshot: 's',
      renamePattern: '(.+)',
      renameReplacement: 'restored-$1',
      confirmed: true,
    });
    expect(session.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining([
        'resizeIndex',
        'startReindex',
        'putResource',
        'createSnapshot',
        'cancelTask',
        'restoreSnapshot',
      ]),
    );
  });

  it('refuses administration writes on a read-only profile and asks on production', async () => {
    const readOnly = await startHost({ readOnly: true });
    for (const call of [
      () =>
        readOnly.client.search.indexAdmin.reindex({
          sessionId: readOnly.sessionId,
          source: ['a'],
          dest: 'b',
          confirmed: true,
        }),
      () =>
        readOnly.client.search.resources.put({
          sessionId: readOnly.sessionId,
          kind: 'index-template',
          name: 't',
          body: '{}',
          confirmed: true,
        }),
      () =>
        readOnly.client.search.tasks.cancel({
          sessionId: readOnly.sessionId,
          taskId: 'n1:7',
          confirmed: true,
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'READ_ONLY' });
    }
    const production = await startHost({ environment: 'production' });
    await expect(
      production.client.search.snapshots.create({
        sessionId: production.sessionId,
        repository: 'r',
        snapshot: 's',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('answers NOT_SUPPORTED on other engines', async () => {
    const { fakeMongoAdapter } = await import('./fake-mongo-session');
    const host = new ConnectionHost(fakeMongoAdapter(), {
      profile: connectionProfileSchema.parse(
        profileInput({ engine: 'mongodb', endpoint: { kind: 'host', host: 'm', port: 27017 } }),
      ),
      secrets: {},
    });
    await host.start();
    const channel = new MessageChannel();
    channels.push(channel);
    host.attach(fromNodePort(channel.port2));
    const client = createClient(fromNodePort(channel.port1), connectionHostContract);
    const { sessionId } = await client.openSession({});
    await expect(client.search.indices.list({ sessionId })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('loads the Elasticsearch driver with the SSH step check', async () => {
    const adapter = await loadAdapter('elasticsearch');
    expect(adapter.engine).toBe('elasticsearch');
    expect('checkWithSshStep' in adapter).toBe(true);
  });
});
