import { randomBytes } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import { newId, rowAt, type ResolvedProfile, type Session } from '@querybara/core';
import { createMysqlAdapter } from '@querybara/driver-mysql';
import { createPostgresAdapter } from '@querybara/driver-postgres';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';
import { connectionHostContract, createClient, fromNodePort, type Client } from '@querybara/ipc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConnectionHost } from '../../src/connection-host/host';

/**
 * The visual explain through the connection host against real servers (spec §6): the plan with
 * the server's raw output, EXPLAIN ANALYZE of a write only when confirmed and always rolled back,
 * and refused on a read-only profile before anything runs.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const MYSQL_URL = process.env['QUERYBARA_TEST_MYSQL_URL'];

type HostClient = Client<(typeof connectionHostContract)['shape']>;

const channels: MessageChannel[] = [];
const hosts: ConnectionHost[] = [];

afterAll(async () => {
  await Promise.all(hosts.map((host) => host.shutdown()));
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

async function open(
  adapter: ConstructorParameters<typeof ConnectionHost>[0],
  resolved: ResolvedProfile,
): Promise<{ client: HostClient; sessionId: string }> {
  const host = new ConnectionHost(adapter, resolved);
  await host.start();
  hosts.push(host);
  const channel = new MessageChannel();
  channels.push(channel);
  host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  const { sessionId } = await client.openSession({});
  return { client, sessionId };
}

function readOnly(resolved: ResolvedProfile): ResolvedProfile {
  const { profile } = resolved;
  return {
    ...resolved,
    profile: { ...profile, presentation: { ...profile.presentation, readOnly: true } },
  };
}

async function scalar(session: Session, sql: string): Promise<unknown> {
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.rowCount > 0) return rowAt(chunk, 0)[0];
  }
  return undefined;
}

describe.skipIf(!PG_URL)('explainPlan on PostgreSQL', () => {
  const table = `querybara_explain_${randomBytes(4).toString('hex')}`;
  let direct: Session;

  beforeAll(async () => {
    direct = await createPostgresAdapter().connect(resolvedProfileFromUrl(PG_URL!));
    await scalar(direct, `CREATE TABLE ${table} (id integer PRIMARY KEY, qty integer)`);
    await scalar(direct, `INSERT INTO ${table} SELECT g, g FROM generate_series(1, 100) g`);
  });

  afterAll(async () => {
    await scalar(direct, `DROP TABLE IF EXISTS ${table}`);
    await direct.close();
  });

  it('returns the plan with the raw JSON output', async () => {
    const { client, sessionId } = await open(
      createPostgresAdapter(),
      resolvedProfileFromUrl(PG_URL!),
    );
    const result = await client.explainPlan({ sessionId, text: `SELECT * FROM ${table}` });
    expect(result).toMatchObject({ rawFormat: 'json', rolledBack: false });
    expect(result.plan).toMatchObject({ operation: 'Seq Scan', relation: table });
    expect(JSON.parse(result.raw)[0].Plan['Node Type']).toBe('Seq Scan');
  });

  it('analyzes a DELETE only when confirmed, and rolls it back', async () => {
    const { client, sessionId } = await open(
      createPostgresAdapter(),
      resolvedProfileFromUrl(PG_URL!),
    );
    const request = {
      sessionId,
      text: `DELETE FROM ${table} WHERE id <= 50`,
      options: { analyze: true, buffers: true },
    };
    await expect(client.explainPlan(request)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const result = await client.explainPlan({ ...request, confirmed: true });
    expect(result.rolledBack).toBe(true);
    expect(result.plan.operation).toBe('Delete');
    expect(result.plan.children[0]?.actualRows).toBe(50);
    expect(await scalar(direct, `SELECT count(*) FROM ${table}`)).toBe(100);
    expect(await client.sessionState({ sessionId })).toEqual({ inTransaction: false });
  });

  it('keeps an open transaction open, rolling back to a savepoint', async () => {
    const { client, sessionId } = await open(
      createPostgresAdapter(),
      resolvedProfileFromUrl(PG_URL!),
    );
    await client.begin({ sessionId });
    await client.explainPlan({
      sessionId,
      text: `UPDATE ${table} SET qty = 0`,
      options: { analyze: true },
      confirmed: true,
    });
    expect(await client.sessionState({ sessionId })).toEqual({ inTransaction: true });
    await client.rollback({ sessionId });
    expect(await scalar(direct, `SELECT count(*) FROM ${table} WHERE qty = 0`)).toBe(0);
  });

  it('refuses to analyze a write on a read-only profile, but explains it', async () => {
    const { client, sessionId } = await open(
      createPostgresAdapter(),
      readOnly(resolvedProfileFromUrl(PG_URL!)),
    );
    const text = `DELETE FROM ${table}`;
    await expect(
      client.explainPlan({ sessionId, text, options: { analyze: true }, confirmed: true }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(client.explainPlan({ sessionId, text })).resolves.toMatchObject({
      rolledBack: false,
    });
    expect(await scalar(direct, `SELECT count(*) FROM ${table}`)).toBe(100);
  });
});

describe.skipIf(!MYSQL_URL)('explainPlan on MySQL', () => {
  it('returns the JSON estimate and the EXPLAIN ANALYZE tree text', async () => {
    const { client, sessionId } = await open(
      createMysqlAdapter(),
      resolvedProfileFromUrl(MYSQL_URL!),
    );
    const estimated = await client.explainPlan({ sessionId, text: 'SELECT 1 FROM DUAL' });
    expect(estimated.rawFormat).toBe('json');
    const analyzed = await client.explainPlan({
      sessionId,
      text: 'SELECT * FROM information_schema.SCHEMATA',
      options: { analyze: true },
    });
    expect(analyzed).toMatchObject({ rawFormat: 'text', rolledBack: true });
    expect(analyzed.raw).toMatch(/^-> /);
  });
});
