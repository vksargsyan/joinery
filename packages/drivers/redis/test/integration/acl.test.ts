import type { ConnectionCheckResult } from '@joinery/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RedisSession } from '../../src';
import {
  REDIS_ACL_USER,
  REDIS_URL,
  aclProfile,
  adapter,
  cleanup,
  connect,
  dec,
  newPrefix,
  standaloneProfile,
} from './helpers';

/**
 * A restricted ACL user (keys ~app:*, everything but @dangerous): what it may not do is
 * reported gracefully instead of failing the session.
 */
describe.skipIf(!REDIS_URL || !REDIS_ACL_USER)('restricted ACL user', () => {
  let app: RedisSession;
  let admin: RedisSession;
  let p: string;
  let appPrefix: string;

  beforeAll(async () => {
    app = await connect(aclProfile());
    admin = await connect(standaloneProfile());
  });
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });
  beforeEach(() => {
    p = newPrefix();
    appPrefix = `app:${p}`;
  });
  afterEach(async () => {
    await cleanup(admin, p);
    await cleanup(admin, appPrefix);
  });

  it('connects without INFO or CONFIG', async () => {
    expect(await app.aclWhoAmI()).toBe('app');
    expect(app.server).toMatchObject({ role: 'master', databasesExact: false });
    expect(app.server.version).toMatch(/^\d+\.\d+/);
    expect(app.server.databases).toBeGreaterThanOrEqual(1);
    expect(await app.configGet('maxmemory')).toEqual({ values: {}, denied: true });
    expect(await app.latencyMonitorThreshold()).toBeNull();
  });

  it('scans the whole keyspace but only touches its own keys', async () => {
    await admin.setString(`${p}secret`, 'x');
    await app.setString(`${appPrefix}mine`, 'y');
    const page = await app.scanPage({ match: `*${p}*`, limit: 100 });
    expect(page.keys.map(dec).sort()).toEqual([`${appPrefix}mine`, `${p}secret`]);
    const [mine, secret] = await app.keyInfo([`${appPrefix}mine`, `${p}secret`]);
    expect(mine).toMatchObject({ type: 'string', kind: 'string', length: 1 });
    expect(secret).toMatchObject({ kind: 'unknown', type: '' });
    expect(secret!.error).toMatch(/NOPERM/);
    const memory = await app.memoryUsage([`${appPrefix}mine`, `${p}secret`]);
    expect(memory[0]).toBeGreaterThan(0);
    expect(memory[1]).toBeNull();
  });

  it('bulk-deletes what it may and counts what it may not', async () => {
    await admin.setString(`${p}a`, 'x');
    await app.setString(`${appPrefix}b`, 'y');
    const result = await app.bulkDelete({ match: `*${p}*` });
    expect(result).toMatchObject({ matched: 2, deleted: 1, failed: 1 });
    expect(await admin.exists([`${p}a`])).toBe(1);
  });

  it('builds a big-key report with NOPERM keys unsized', async () => {
    await admin.setString(`${p}a`, 'x');
    await app.setString(`${appPrefix}b`, 'y');
    const report = await app.bigKeys({ match: `*${p}*` });
    expect(report.sampled).toBe(2);
    expect(report.memoryDenied).toBe(true);
    expect(report.largest.map((k) => dec(k.key))).toEqual([`${appPrefix}b`]);
  });

  it('surfaces NOPERM with a hint in the CLI and in dangerous tools', async () => {
    const reply = await app.command(['GET', `${p}secret`]);
    expect(reply).toMatchObject({ type: 'error' });
    const denied = await app.slowlogGet().catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: 'SQL_ERROR', engineCode: 'NOPERM' });
    expect((denied as { hint: string }).hint).toMatch(/ACL SETUSER/);
    const catalog = await app.commandDocs();
    expect(catalog.commands['GET']).toBeDefined();
  });

  it('fails Test Connection on a wrong ACL password with a hint', async () => {
    const resolved = aclProfile();
    const wrong = { ...resolved, secrets: { password: 'wrong' } };
    const steps: ConnectionCheckResult[] = [];
    for await (const step of adapter.checkConnection(wrong)) steps.push(step);
    const auth = steps.find((s) => s.step === 'auth')!;
    expect(auth.status).toBe('failed');
    expect(auth.hint).toMatch(/ACL user must also be enabled/);
  });
});
