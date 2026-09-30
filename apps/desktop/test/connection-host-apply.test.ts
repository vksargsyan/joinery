import { MessageChannel } from 'node:worker_threads';

import {
  capabilitiesFor,
  connectionProfileSchema,
  toColumnChunk,
  type BrowseNode,
  type DriverAdapter,
  type ExecOptions,
  type ResolvedProfile,
  type ResultChunk,
  type Session,
  type TableDef,
} from '@joinery/core';
import { connectionHostContract, createClient, fromNodePort } from '@joinery/ipc';
import { ChangeSet, describeColumns, planChanges, rowIdentity } from '@joinery/table-data';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../src/connection-host/host';
import { profileInput } from './helpers';

/**
 * The host side of Apply (spec §7): the change plan runs on the tab's own session in one
 * transaction, a statement that touches no row rolls everything back as a CONFLICT, and a
 * read-only profile refuses the plan whatever the page sends.
 */

const table: TableDef = {
  name: 'items',
  kind: 'table',
  columns: [
    {
      name: 'id',
      ordinal: 1,
      dataType: 'integer',
      nullable: false,
      default: null,
      autoIncrement: false,
    },
    {
      name: 'name',
      ordinal: 2,
      dataType: 'text',
      nullable: true,
      default: null,
      autoIncrement: false,
    },
  ],
  primaryKey: { name: 'items_pkey', columns: ['id'] },
  uniques: [],
  indexes: [],
  foreignKeys: [],
  checks: [],
  triggers: [],
  options: {},
};

class RecordingSession implements Session {
  readonly engine = 'postgres' as const;
  readonly serverVersion = '16.4';
  inTransaction = false;
  readonly executed: string[] = [];
  /** Rows an UPDATE touches: 0 simulates a row changed by someone else. */
  touched = 1;

  capabilities() {
    return capabilitiesFor('postgres', this.serverVersion);
  }

  async *execute(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    this.executed.push(text);
    if (text === 'BEGIN') this.inTransaction = true;
    if (text === 'COMMIT' || text === 'ROLLBACK') this.inTransaction = false;
    if (/^UPDATE/.test(text)) {
      const params = (opts.params ?? []) as unknown[];
      if (this.touched > 0) {
        yield {
          type: 'columns',
          resultIndex: 0,
          columns: [
            { name: 'id', nativeType: 'int4', kind: 'integer' },
            { name: 'name', nativeType: 'text', kind: 'string' },
          ],
        };
        yield toColumnChunk(0, 2, [[params[1] as number, params[0] as string]]);
      }
      yield { type: 'status', command: 'UPDATE', rowsAffected: this.touched };
    }
    yield { type: 'end', durationMs: 1, rowCount: 0 };
  }

  async cancel(): Promise<void> {}
  introspect(): never {
    throw new Error('not used');
  }
  async browse(): Promise<BrowseNode[]> {
    return [];
  }
  async begin(): Promise<void> {
    this.executed.push('BEGIN');
    this.inTransaction = true;
  }
  async commit(): Promise<void> {
    this.executed.push('COMMIT');
    this.inTransaction = false;
  }
  async rollback(): Promise<void> {
    this.executed.push('ROLLBACK');
    this.inTransaction = false;
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

async function start(readOnly: boolean) {
  const sessions: RecordingSession[] = [];
  const adapter: DriverAdapter = {
    engine: 'postgres',
    capabilities: (version) => capabilitiesFor('postgres', version),
    async connect() {
      const session = new RecordingSession();
      sessions.push(session);
      return session;
    },
  };
  const input = profileInput();
  const resolved: ResolvedProfile = {
    profile: connectionProfileSchema.parse({
      ...input,
      presentation: { environment: 'dev', readOnly },
    }),
    secrets: {},
  };
  const host = new ConnectionHost(adapter, resolved);
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId, session: sessions[1]! };
}

function plan() {
  const columns = describeColumns(table, { dialect: 'postgres' });
  const identity = rowIdentity(table);
  const changes = ChangeSet.empty().edit(
    { key: 'n1', values: { id: 1, name: 'old' } },
    'name',
    'new',
  );
  return planChanges(changes, {
    dialect: 'postgres',
    table: { schema: 'public', name: 'items' },
    columns,
    identity,
  });
}

describe('connection host applyChanges', () => {
  it('runs the plan in one transaction and returns the rows as written', async () => {
    const { client, sessionId, session } = await start(false);
    const result = await client.applyChanges({ sessionId, plan: plan() });
    expect(result.rows).toEqual([{ kind: 'update', key: 'n1', newKey: 'n1', row: [1, 'new'] }]);
    expect(session.executed[0]).toBe('BEGIN');
    expect(session.executed[1]).toMatch(
      /^UPDATE "public"."items" SET "name" = \$1 WHERE "id" = \$2/,
    );
    expect(session.executed.at(-1)).toBe('COMMIT');
  });

  it('rolls back and reports a CONFLICT when the row was changed by someone else', async () => {
    const { client, sessionId, session } = await start(false);
    session.touched = 0;
    await expect(client.applyChanges({ sessionId, plan: plan() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(session.executed.at(-1)).toBe('ROLLBACK');
    expect(session.executed).not.toContain('COMMIT');
  });

  it('refuses the plan on a read-only profile without touching the session', async () => {
    const { client, sessionId, session } = await start(true);
    await expect(client.applyChanges({ sessionId, plan: plan() })).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    expect(session.executed).toEqual([]);
  });
});
