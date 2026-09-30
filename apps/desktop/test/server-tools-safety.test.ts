import {
  JoineryError,
  capabilitiesFor,
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ServerAction,
  type Session,
} from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { serverToolsHandlers } from '../src/connection-host/server-tools';
import {
  checkServerAction,
  decideServerAction,
  serverActionRule,
} from '../src/shared/server-tools-safety';
import { profileInput } from './helpers';

/** The server tools' write rules (spec §4, §15), and that the host enforces them. */

function profile(presentation: ConnectionProfileInput['presentation'] = {}) {
  return connectionProfileSchema.parse(profileInput({ name: 'Shop', presentation }));
}

const dev = profile();
const production = profile({ environment: 'production' });
const confirming = profile({ confirmWrites: true });
const readOnly = profile({ readOnly: true });

const kill: ServerAction = { kind: 'session', operation: 'terminate', id: '42' };
const createUser: ServerAction = {
  kind: 'createAccount',
  account: { name: 'app' },
  role: false,
  options: {},
};
const check: ServerAction = {
  kind: 'maintenance',
  operation: 'check',
  targets: [{ container: 'shop', name: 'orders' }],
  options: [],
};
const analyze: ServerAction = { ...check, operation: 'analyze' };
const vacuumFull: ServerAction = { ...check, operation: 'vacuum', options: ['full'] };
const sessionSet: ServerAction = {
  kind: 'setting',
  name: 'work_mem',
  value: '1MB',
  scope: 'session',
};
const globalSet: ServerAction = { ...sessionSet, scope: 'global' };

describe('server tools write rules', () => {
  it('confirms kills, maintenance, settings, drops and revokes on every profile', () => {
    for (const action of [kill, analyze, vacuumFull, globalSet, sessionSet, check]) {
      expect(decideServerAction(dev, action).action).toBe('confirm');
    }
    for (const action of [
      { kind: 'dropAccount', account: { name: 'a' }, role: false },
      { kind: 'revoke', grantee: { name: 'a' }, object: { kind: 'global' }, privileges: ['X'] },
      { kind: 'revokeRole', role: { name: 'r' }, member: { name: 'a' } },
      { kind: 'dropPolicy', schema: 's', table: 't', name: 'p' },
      { kind: 'rowSecurity', schema: 's', table: 't', enabled: false },
      { kind: 'topQueries', operation: 'reset' },
    ] as ServerAction[]) {
      expect(decideServerAction(dev, action)).toMatchObject({
        action: 'confirm',
        destructive: true,
      });
    }
  });

  it('runs other changes directly, unless the profile confirms writes', () => {
    expect(decideServerAction(dev, createUser)).toEqual({ action: 'run' });
    expect(decideServerAction(confirming, createUser)).toMatchObject({
      action: 'confirm',
      reason: '"Shop" confirms every change',
    });
    expect(decideServerAction(production, createUser)).toMatchObject({
      action: 'confirm',
      reason: 'Creating app on a production connection',
    });
  });

  it('marks what disrupts other clients as destructive', () => {
    expect(serverActionRule(kill).destructive).toBe(true);
    expect(serverActionRule(vacuumFull).destructive).toBe(true);
    expect(serverActionRule(analyze).destructive).toBe(false);
    expect(
      serverActionRule({ ...check, operation: 'reindex', options: ['concurrently'] }).destructive,
    ).toBe(false);
    expect(serverActionRule({ ...check, operation: 'reindex', options: [] }).destructive).toBe(
      true,
    );
  });

  it('refuses changes on a read-only profile, but not checks or session settings', () => {
    for (const action of [kill, createUser, analyze, globalSet]) {
      expect(decideServerAction(readOnly, action).action).toBe('refuse');
    }
    expect(decideServerAction(readOnly, check).action).toBe('confirm');
    expect(decideServerAction(readOnly, sessionSet).action).toBe('confirm');
    expect(() => checkServerAction(readOnly, kill, true)).toThrow(
      expect.objectContaining({ code: 'READ_ONLY' }),
    );
  });

  it('needs the confirmation flag whenever it asks', () => {
    expect(() => checkServerAction(dev, kill, undefined)).toThrow(
      expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }),
    );
    expect(() => checkServerAction(dev, kill, true)).not.toThrow();
    expect(() => checkServerAction(dev, createUser, undefined)).not.toThrow();
    expect(() => checkServerAction(production, createUser, false)).toThrow(
      expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }),
    );
  });
});

/** A PostgreSQL session whose every statement fails with a sentinel: nothing may reach it. */
function sentinelSession(): { session: Session; statements: string[] } {
  const statements: string[] = [];
  const session: Session = {
    engine: 'postgres',
    serverVersion: '16.4',
    inTransaction: false,
    capabilities: () => capabilitiesFor('postgres', '16.4'),
    execute: (text: string) => {
      statements.push(text);
      return (async function* () {
        throw new JoineryError({ code: 'INTERNAL', message: 'sentinel' });
        yield* [];
      })();
    },
    cancel: async () => undefined,
    introspect: () => Promise.reject(new Error('unused')),
    browse: async () => [],
    ping: async () => undefined,
    close: async () => undefined,
  };
  return { session, statements };
}

describe('the connection host', () => {
  const context = { signal: new AbortController().signal, progress: () => undefined };

  it('checks the write rules before an action reaches the server', async () => {
    const { session, statements } = sentinelSession();
    const readOnlyHost = serverToolsHandlers({ session: () => session, profile: readOnly });
    await expect(
      readOnlyHost.run({ sessionId: 's', action: kill, confirmed: true }, context),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    const productionHost = serverToolsHandlers({ session: () => session, profile: production });
    await expect(
      productionHost.run({ sessionId: 's', action: createUser }, context),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(statements).toEqual([]);

    // Allowed through, the action reaches the session (which fails with the sentinel).
    await expect(
      productionHost.run({ sessionId: 's', action: createUser, confirmed: true }, context),
    ).rejects.toMatchObject({ message: 'sentinel' });
    expect(statements.length).toBeGreaterThan(0);
  });

  it('says Redis has its own tools', async () => {
    const { session } = sentinelSession();
    const redis = { ...session, engine: 'redis' as const };
    const host = serverToolsHandlers({ session: () => redis, profile: dev });
    await expect(host.info({ sessionId: 's' }, context)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: expect.stringContaining('Redis has its own'),
    });
  });
});
