import { MessageChannel } from 'node:worker_threads';

import {
  JoineryError,
  capabilitiesFor,
  connectionProfileSchema,
  type ConnectionProfile,
  type DriverAdapter,
  type ExplainOptions,
  type ExplainResult,
  type ResolvedProfile,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import { connectionHostContract, createClient, fromNodePort } from '@joinery/ipc';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionHost, checkExplainAnalyze } from '../src/connection-host/host';
import { profileInput } from './helpers';

/** A session that records what it was asked to explain. */
class ExplainSession implements Session {
  readonly engine = 'postgres' as const;
  readonly serverVersion = '16.4';
  readonly inTransaction = false;
  readonly explained: { text: string; opts: ExplainOptions | undefined }[] = [];

  capabilities() {
    return capabilitiesFor('postgres', this.serverVersion);
  }

  // eslint-disable-next-line require-yield
  async *execute(): AsyncGenerator<ResultChunk> {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'no' });
  }

  async cancel(): Promise<void> {}

  introspect(): never {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'no' });
  }

  async browse() {
    return [];
  }

  async explainPlan(text: string, opts?: ExplainOptions): Promise<ExplainResult> {
    this.explained.push({ text, opts });
    return {
      plan: { id: '0', operation: 'Seq Scan', relation: 'items', detail: {}, children: [] },
      raw: '[{"Plan": {"Node Type": "Seq Scan"}}]',
      rawFormat: 'json',
      rolledBack: opts?.analyze === true,
    };
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

function profile(presentation: Partial<ConnectionProfile['presentation']> = {}) {
  const parsed = connectionProfileSchema.parse(profileInput());
  return { ...parsed, presentation: { ...parsed.presentation, ...presentation } };
}

async function startHost(readOnly = false) {
  const sessions: ExplainSession[] = [];
  const adapter: DriverAdapter = {
    engine: 'postgres',
    capabilities: (version) => capabilitiesFor('postgres', version),
    async connect() {
      const session = new ExplainSession();
      sessions.push(session);
      return session;
    },
  };
  const resolved: ResolvedProfile = { profile: profile({ readOnly }), secrets: {} };
  const host = new ConnectionHost(adapter, resolved);
  await host.start();
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId, sessions };
}

describe('EXPLAIN ANALYZE write rules', () => {
  it('lets reads and estimated plans through on every profile', () => {
    const readOnly = profile({ readOnly: true });
    expect(() => checkExplainAnalyze(readOnly, 'SELECT * FROM items', false)).not.toThrow();
    expect(() => checkExplainAnalyze(profile(), 'SELECT 1', false)).not.toThrow();
  });

  it('refuses a writing statement on a read-only profile, even when confirmed', () => {
    expect(() =>
      checkExplainAnalyze(profile({ readOnly: true }), 'DELETE FROM items', true),
    ).toThrow(expect.objectContaining({ code: 'READ_ONLY' }));
  });

  it('asks for confirmation of a writing statement everywhere else', () => {
    expect(() => checkExplainAnalyze(profile(), 'UPDATE items SET qty = 0', false)).toThrow(
      expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }),
    );
    expect(() => checkExplainAnalyze(profile(), 'UPDATE items SET qty = 0', true)).not.toThrow();
  });
});

describe('explainPlan through the connection host', () => {
  it('returns the plan and raw output, and enforces the rules before the driver runs', async () => {
    const { client, sessionId, sessions } = await startHost();
    const session = sessions[1]!;
    const estimated = await client.explainPlan({ sessionId, text: 'DELETE FROM items' });
    expect(estimated).toMatchObject({ rawFormat: 'json', rolledBack: false });
    expect(estimated.plan.operation).toBe('Seq Scan');

    await expect(
      client.explainPlan({ sessionId, text: 'DELETE FROM items', options: { analyze: true } }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(session.explained).toHaveLength(1);

    const analyzed = await client.explainPlan({
      sessionId,
      text: 'DELETE FROM items',
      options: { analyze: true, buffers: true },
      confirmed: true,
    });
    expect(analyzed.rolledBack).toBe(true);
    expect(session.explained.at(-1)).toEqual({
      text: 'DELETE FROM items',
      opts: { analyze: true, buffers: true },
    });
  });

  it('refuses ANALYZE of a write on a read-only profile', async () => {
    const { client, sessionId, sessions } = await startHost(true);
    await expect(
      client.explainPlan({
        sessionId,
        text: 'INSERT INTO items VALUES (1)',
        options: { analyze: true },
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(sessions[1]!.explained).toHaveLength(0);
    await expect(
      client.explainPlan({ sessionId, text: 'SELECT 1', options: { analyze: true } }),
    ).resolves.toMatchObject({ rolledBack: true });
  });
});
