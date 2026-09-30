import { MessageChannel } from 'node:worker_threads';

import {
  JoineryError,
  capabilitiesFor,
  connectionProfileSchema,
  toColumnChunk,
  type BrowseNode,
  type DriverAdapter,
  type ExecOptions,
  type ResolvedProfile,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import {
  DEFAULT_STREAM_WINDOW,
  connectionHostContract,
  createClient,
  fromNodePort,
} from '@joinery/ipc';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../src/connection-host/host';
import { profileInput } from './helpers';

class FakeSession implements Session {
  readonly engine = 'postgres' as const;
  readonly serverVersion = '16.4';
  inTransaction = false;
  closed = false;
  pagesPulled = 0;
  cursorClosed = false;
  readonly cancelled: string[] = [];

  constructor(readonly database: string | undefined) {}

  capabilities() {
    return capabilitiesFor('postgres', this.serverVersion);
  }

  async *execute(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    if (text === 'boom') {
      throw new JoineryError({ code: 'SQL_ERROR', message: 'syntax error', position: 0 });
    }
    try {
      yield {
        type: 'columns',
        resultIndex: 0,
        columns: [{ name: 'n', nativeType: 'int4', kind: 'integer' }],
      };
      const pageSize = opts.pageSize ?? 1000;
      for (let page = 0; page < 20; page++) {
        this.pagesPulled++;
        yield toColumnChunk(
          0,
          1,
          Array.from({ length: pageSize }, (_, i) => [page * pageSize + i]),
        );
      }
      yield { type: 'end', durationMs: 1, rowCount: 20 * pageSize };
    } finally {
      this.cursorClosed = true;
    }
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.push(executionId);
  }

  introspect(): never {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'no' });
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    return [{ kind: 'schema', name: 'public', path: [...path, 'public'], hasChildren: true }];
  }

  async begin(): Promise<void> {
    this.inTransaction = true;
  }

  async commit(): Promise<void> {
    this.inTransaction = false;
  }

  async rollback(): Promise<void> {
    this.inTransaction = false;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeAdapter(): DriverAdapter & { sessions: FakeSession[]; profiles: ResolvedProfile[] } {
  const sessions: FakeSession[] = [];
  const profiles: ResolvedProfile[] = [];
  return {
    engine: 'postgres',
    sessions,
    profiles,
    capabilities: (version) => capabilitiesFor('postgres', version),
    async connect(resolved) {
      profiles.push(resolved);
      const session = new FakeSession(resolved.profile.options.defaultDatabase);
      sessions.push(session);
      return session;
    },
  };
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

async function startHost() {
  const adapter = fakeAdapter();
  const resolved: ResolvedProfile = {
    profile: connectionProfileSchema.parse(profileInput()),
    secrets: {},
  };
  const host = new ConnectionHost(adapter, resolved);
  const info = await host.start();
  const attach = () => {
    const channel = new MessageChannel();
    channels.push(channel);
    host.attach(fromNodePort(channel.port2));
    return { client: createClient(fromNodePort(channel.port1), connectionHostContract), channel };
  };
  return { adapter, host, info, attach };
}

describe('connection host', () => {
  it('connects a metadata session at start and reports the server', async () => {
    const { info, adapter, attach } = await startHost();
    expect(info).toMatchObject({ engine: 'postgres', serverVersion: '16.4' });
    expect(adapter.sessions).toHaveLength(1);
    const { client } = attach();
    expect(await client.serverInfo()).toEqual(info);
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('opens one session per tab, optionally in another database', async () => {
    const { adapter, attach } = await startHost();
    const { client } = attach();
    const a = await client.openSession({});
    const b = await client.openSession({ database: 'analytics' });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(adapter.sessions.map((s) => s.database)).toEqual([undefined, undefined, 'analytics']);
    await client.closeSession(a);
    expect(adapter.sessions[1]?.closed).toBe(true);
    await expect(client.browse({ sessionId: a.sessionId, path: [] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await client.browse({ sessionId: b.sessionId, path: ['db'] })).toEqual([
      { kind: 'schema', name: 'public', path: ['db', 'public'], hasChildren: true },
    ]);
  });

  it('streams results with backpressure and closes the cursor when the tab stops', async () => {
    const { adapter, attach } = await startHost();
    const { client } = attach();
    const { sessionId } = await client.openSession({});
    const session = adapter.sessions[1]!;
    const stream = client.execute({ sessionId, text: 'select', executionId: 'e1', pageSize: 100 });
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: 'columns' });
    const second = await stream.next();
    expect(second.value).toMatchObject({ type: 'rows', rowCount: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The host reads ahead by at most the stream window while nobody consumes.
    expect(session.pagesPulled).toBeLessThanOrEqual(DEFAULT_STREAM_WINDOW + 2);
    expect(session.cursorClosed).toBe(false);
    await stream.return();
    await expect.poll(() => session.cursorClosed).toBe(true);
  });

  it('passes driver errors through with their position', async () => {
    const { attach } = await startHost();
    const { client } = attach();
    const { sessionId } = await client.openSession({});
    const stream = client.execute({ sessionId, text: 'boom', executionId: 'e2' });
    await expect(stream.next()).rejects.toMatchObject({ code: 'SQL_ERROR', position: 0 });
  });

  it('cancels through the session and tracks transactions', async () => {
    const { adapter, attach } = await startHost();
    const { client } = attach();
    const { sessionId } = await client.openSession({});
    await client.cancel({ sessionId, executionId: 'e3' });
    expect(adapter.sessions[1]?.cancelled).toEqual(['e3']);
    expect(await client.sessionState({ sessionId })).toEqual({ inTransaction: false });
    await client.begin({ sessionId });
    expect(await client.sessionState({ sessionId })).toEqual({ inTransaction: true });
    await client.rollback({ sessionId });
    expect(await client.sessionState({ sessionId })).toEqual({ inTransaction: false });
    await expect(client.explain({ sessionId, text: 'select 1' })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it("closes a port's sessions when the port goes away, leaving other ports' alone", async () => {
    const { adapter, host, attach } = await startHost();
    const first = attach();
    const second = attach();
    await first.client.openSession({});
    await second.client.openSession({});
    expect(host.sessionCount).toBe(2);
    first.channel.port1.close();
    await expect.poll(() => adapter.sessions[1]?.closed).toBe(true);
    expect(adapter.sessions[2]?.closed).toBe(false);
    expect(host.sessionCount).toBe(1);
    await host.shutdown();
    expect(adapter.sessions.every((s) => s.closed)).toBe(true);
  });
});
