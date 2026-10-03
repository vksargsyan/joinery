import { QuerybaraError, type MonitorSnapshot, type ServerAction } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  createClient,
  defineContract,
  monitorSnapshotSchema,
  serve,
  serverActionSchema,
  serverToolsHostContractShape,
  topQueriesSchema,
} from '../src';
import { portPair } from './helpers';

/** The server tools contract (spec §15): action and snapshot schemas, and a round trip. */

const actions: ServerAction[] = [
  { kind: 'session', operation: 'terminate', id: '4211' },
  {
    kind: 'maintenance',
    operation: 'vacuum',
    targets: [{ container: 'public', name: 'orders' }],
    options: ['analyze'],
  },
  { kind: 'setting', name: 'work_mem', value: null, scope: 'system' },
  { kind: 'topQueries', operation: 'reset', database: 'shop' },
  { kind: 'profiler', database: 'shop', level: 1, slowMs: 100, sampleRate: 0.5 },
  {
    kind: 'createAccount',
    account: { name: 'app', host: '%' },
    role: false,
    options: { password: 'x', connectionLimit: -1, validUntil: null },
  },
  { kind: 'alterAccount', account: { name: 'app' }, options: {}, rename: { name: 'b' } },
  { kind: 'dropAccount', account: { name: 'app' }, role: false },
  {
    kind: 'grant',
    grantee: { name: 'app' },
    object: { kind: 'function', schema: 's', name: 'f', signature: 'x integer' },
    privileges: ['EXECUTE'],
    grantOption: true,
  },
  { kind: 'revoke', grantee: { name: 'app' }, object: { kind: 'global' }, privileges: ['PROCESS'] },
  { kind: 'grantRole', role: { name: 'r' }, member: { name: 'app' }, admin: true },
  { kind: 'revokeRole', role: { name: 'r' }, member: { name: 'app' } },
  {
    kind: 'defaultPrivileges',
    operation: 'grant',
    objectType: 'tables',
    grantee: 'PUBLIC',
    privileges: ['SELECT'],
  },
  {
    kind: 'createPolicy',
    schema: 'public',
    table: 't',
    name: 'p',
    permissive: true,
    command: 'SELECT',
    roles: [],
    using: 'true',
  },
  { kind: 'dropPolicy', schema: 'public', table: 't', name: 'p' },
  { kind: 'rowSecurity', schema: 'public', table: 't', enabled: true, forced: false },
];

describe('server tools schemas', () => {
  it('accepts every action kind as it is', () => {
    for (const action of actions) expect(serverActionSchema.parse(action)).toEqual(action);
  });

  it('refuses malformed actions', () => {
    const bad: unknown[] = [
      { kind: 'session', operation: 'restart', id: '1' },
      { kind: 'maintenance', operation: 'defrag', targets: [], options: [] },
      { kind: 'setting', name: 'x', value: '1', scope: 'cluster' },
      { kind: 'profiler', database: 'x', level: 3 },
      { kind: 'profiler', database: 'x', level: 1, sampleRate: 0 },
      { kind: 'grant', grantee: { host: '%' }, object: { kind: 'table' }, privileges: [] },
      {
        kind: 'createPolicy',
        schema: 's',
        table: 't',
        name: 'p',
        permissive: true,
        command: 'MERGE',
        roles: [],
      },
      { kind: 'drop', what: 'everything' },
    ];
    for (const action of bad) expect(serverActionSchema.safeParse(action).success).toBe(false);
  });

  it('carries monitor tiles of every kind and top queries with a fix', () => {
    const snapshot: MonitorSnapshot = {
      at: 1,
      uptimeSeconds: null,
      tiles: [
        { id: 'a', label: 'A', kind: 'gauge', unit: 'bytes', value: null },
        { id: 'b', label: 'B', kind: 'rate', unit: 'count', counter: 10, detail: 'd' },
        { id: 'c', label: 'C', kind: 'ratio', hits: 1, total: 2, unit: 'ms' },
      ],
      sections: [
        {
          id: 's',
          title: 'S',
          table: { columns: [{ key: 'k', label: 'K', unit: 'time' }], rows: [{ k: null }] },
          empty: 'none',
          notice: { level: 'info', message: 'm' },
        },
      ],
      notices: [],
    };
    expect(monitorSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const top = {
      unavailable: {
        reason: 'not-installed' as const,
        message: 'm',
        fix: { kind: 'topQueries' as const, operation: 'enable' as const },
      },
      queries: [],
      detailColumns: [],
      notices: [],
      resettable: false,
      profiler: null,
    };
    expect(topQueriesSchema.parse(top)).toEqual(top);
  });
});

describe('server tools contract', () => {
  it('previews and runs actions over a port, with errors intact', async () => {
    const ports = portPair();
    const contract = defineContract({ serverTools: serverToolsHostContractShape });
    const seen: unknown[] = [];
    serve(ports.server, contract, {
      serverTools: {
        info: () => {
          throw new QuerybaraError({ code: 'NOT_SUPPORTED', message: 'no' });
        },
        monitor: () => ({ at: 1, uptimeSeconds: 5, tiles: [], sections: [], notices: [] }),
        sessions: () => ({ sessions: [], detailColumns: [], notices: [], truncated: false }),
        topQueries: () => ({
          unavailable: null,
          queries: [],
          detailColumns: [],
          notices: [],
          resettable: false,
          profiler: null,
        }),
        accounts: () => ({ accounts: [], notices: [] }),
        grants: ({ grantee }) => ({
          grantee,
          scope: null,
          scopes: [],
          privileges: {},
          rows: [],
          notices: [],
        }),
        accessDetails: () => ({
          schema: 'public',
          schemas: [],
          defaultPrivileges: [],
          tables: [],
          notices: [],
        }),
        maintenanceTargets: () => ({
          containers: [],
          container: null,
          targets: [],
          detailColumns: [],
          notices: [],
        }),
        settings: () => ({ settings: [], notices: [] }),
        preview: ({ action }) => ({
          title: action.kind,
          summary: '',
          statements: ['SELECT 1'],
          notices: [],
        }),
        run: ({ action, confirmed }) => {
          seen.push({ action, confirmed });
          if (confirmed !== true) {
            throw new QuerybaraError({ code: 'CONFIRMATION_REQUIRED', message: 'confirm it' });
          }
          return { statements: ['SELECT 1'], messages: [], table: null, durationMs: 1 };
        },
      },
    });
    const client = createClient(ports.client, contract);
    const action = actions[0]!;
    expect(await client.serverTools.preview({ sessionId: 's', action })).toMatchObject({
      statements: ['SELECT 1'],
    });
    await expect(client.serverTools.run({ sessionId: 's', action })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(await client.serverTools.run({ sessionId: 's', action, confirmed: true })).toMatchObject(
      { durationMs: 1 },
    );
    await expect(client.serverTools.info({ sessionId: 's' })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    // A malformed action never reaches the handler.
    await expect(
      client.serverTools.run({
        sessionId: 's',
        action: { kind: 'session', operation: 'restart', id: '1' } as unknown as ServerAction,
      }),
    ).rejects.toBeDefined();
    expect(seen).toHaveLength(2);
  });
});
