import type {
  GrantMatrix,
  MonitorSnapshot,
  MonitorTile,
  ServerAccount,
  ServerSession,
  ServerSetting,
} from '@joinery/core';
import { describe, expect, it } from 'vitest';

import {
  confirmationMessage,
  statementsText,
} from '../src/renderer/src/state/server-tools/actions';
import { formatCell, formatMs, formatValue } from '../src/renderer/src/state/server-tools/format';
import {
  deriveMonitor,
  pushSample,
  rateBetween,
  ratioBetween,
} from '../src/renderer/src/state/server-tools/monitor';
import {
  accountAction,
  accountForm,
  canSignal,
  filterSessions,
  filterSettings,
  grantGroups,
  sessionKey,
  toggleGrant,
} from '../src/renderer/src/state/server-tools/view';

/** View models of the server tools tabs (spec §15). */

function snapshot(at: number, tiles: MonitorTile[]): MonitorSnapshot {
  return { at, uptimeSeconds: at / 1000, tiles, sections: [], notices: [] };
}

describe('the monitor view', () => {
  it('turns counters into rates and counter pairs into interval ratios', () => {
    const samples = [0, 5000, 10000, 15000].map((at, i) =>
      snapshot(at, [
        {
          id: 'qps',
          label: 'Queries/s',
          kind: 'rate',
          unit: 'count',
          counter: [100, 600, 1100, 50][i]!,
        },
        { id: 'net', label: 'Sent/s', kind: 'rate', unit: 'bytes', counter: 1024 * 10 * i },
        {
          id: 'hit',
          label: 'Hit ratio',
          kind: 'ratio',
          hits: [90, 180, 180, 270][i]!,
          total: [100, 200, 200, 300][i]!,
        },
        { id: 'lat', label: 'Read latency', kind: 'ratio', unit: 'ms', hits: 5 * i, total: 10 * i },
        {
          id: 'conn',
          label: 'Connections',
          kind: 'gauge',
          unit: 'count',
          value: i === 2 ? null : 10 + i,
        },
      ]),
    );
    const view = deriveMonitor(samples);
    const tile = (id: string) => view.tiles.find((t) => t.id === id)!;
    // 500 per 5 s, twice; then a counter reset (1100 → 50) gives no rate for that window.
    expect(tile('qps').series).toEqual([100, 100]);
    expect(tile('qps').value).toBe('100');
    expect(tile('net')).toMatchObject({ value: '2 KB/s' });
    // 90/100 once, then an idle interval, then 90/100 again.
    expect(tile('hit').series).toEqual([0.9, 0.9]);
    expect(tile('hit').value).toBe('90.0%');
    expect(tile('lat')).toMatchObject({ value: '0.50 ms', unit: 'ms' });
    expect(tile('conn')).toMatchObject({ value: '13', series: [10, 11, 13] });
    expect(view.uptimeSeconds).toBe(15);
    expect(view.samples).toBe(4);
  });

  it('shows the ratio since start before a second sample, and waits for a rate', () => {
    const view = deriveMonitor([
      snapshot(0, [
        { id: 'hit', label: 'Hit', kind: 'ratio', hits: 1, total: 4, detail: 'cache' },
        { id: 'qps', label: 'Q', kind: 'rate', unit: 'count', counter: 5 },
      ]),
    ]);
    expect(view.tiles[0]).toMatchObject({ value: '25.0%', detail: 'cache · since start' });
    expect(view.tiles[1]!.value).toBe('…');
    expect(deriveMonitor([]).tiles).toEqual([]);
  });

  it('computes rates and ratios only over sound intervals', () => {
    expect(rateBetween({ at: 0, value: 10 }, { at: 2000, value: 30 })).toBe(10);
    expect(rateBetween({ at: 0, value: 30 }, { at: 2000, value: 10 })).toBeUndefined();
    expect(rateBetween({ at: 0, value: null }, { at: 2000, value: 10 })).toBeUndefined();
    expect(ratioBetween({ hits: 1, total: 2 }, { hits: 1, total: 2 })).toBeUndefined();
    expect(ratioBetween({ hits: 1, total: 2 }, { hits: 4, total: 6 })).toBe(0.75);
  });

  it('keeps the newest samples', () => {
    expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
});

describe('formatting', () => {
  it('formats by unit', () => {
    expect(formatValue(0.1234, 'ratio')).toBe('12.3%');
    expect(formatValue(2048, 'bytes')).toBe('2 KB');
    expect(formatValue(90, 'seconds')).toBe('1 min');
    expect(formatValue(1234567, 'count')).toBe('1,234,567');
    expect(formatValue(null, 'count')).toBe('—');
    expect(formatMs(0.5)).toBe('0.50 ms');
    expect(formatMs(1500)).toBe('1.5 s');
    expect(formatCell(true, undefined)).toBe('Yes');
    expect(formatCell('4096', 'bytes')).toBe('4 KB');
    expect(formatCell('', 'text')).toBe('—');
    expect(formatCell('2026-09-29 21:47:57.1+00', 'time')).toBe(
      new Date('2026-09-29T21:47:57.1+00:00').toLocaleString(),
    );
    expect(formatCell('not a time', 'time')).toBe('not a time');
  });
});

function session(overrides: Partial<ServerSession>): ServerSession {
  return {
    id: '1',
    user: 'app',
    database: 'shop',
    client: '10.0.0.1',
    application: null,
    state: 'active',
    durationMs: null,
    wait: null,
    query: 'select 1',
    blockedBy: [],
    own: false,
    background: false,
    idle: false,
    detail: {},
    ...overrides,
  };
}

describe('sessions', () => {
  it('filters on any column and sorts the longest running first', () => {
    const list = [
      session({ id: '2', durationMs: 10 }),
      session({ id: '3', durationMs: 5000, query: 'UPDATE orders SET x = 1' }),
      session({ id: '10', user: 'etl', durationMs: null }),
    ];
    expect(filterSessions(list, { text: '' }).map((s) => s.id)).toEqual(['3', '2', '10']);
    expect(filterSessions(list, { text: 'orders' }).map((s) => s.id)).toEqual(['3']);
    expect(filterSessions(list, { text: 'ETL' }).map((s) => s.id)).toEqual(['10']);
  });

  it('never signals its own session or an idle MongoDB connection', () => {
    expect(canSignal(session({}))).toBe(true);
    expect(canSignal(session({ own: true }))).toBe(false);
    expect(canSignal(session({ id: '' }))).toBe(false);
    expect(sessionKey(session({ id: '', client: 'c', detail: { desc: 'conn4' } }))).toBe(
      '~c~conn4',
    );
  });
});

describe('the grants matrix', () => {
  const matrix: GrantMatrix = {
    grantee: { name: 'app' },
    scope: 'public',
    scopes: ['public'],
    privileges: { database: ['CONNECT'], table: ['SELECT', 'INSERT'], function: [] },
    rows: [
      {
        object: { kind: 'database', name: 'shop' },
        label: 'shop',
        type: 'database',
        privileges: { CONNECT: 'implied' },
      },
      {
        object: { kind: 'table', schema: 'public', name: 'orders' },
        label: 'public.orders',
        type: 'table',
        privileges: { SELECT: 'granted', INSERT: 'none' },
      },
      {
        object: { kind: 'table', schema: 'public', name: 'items' },
        label: 'public.items',
        type: 'view',
        privileges: { SELECT: 'grantable' },
      },
      {
        object: { kind: 'function', schema: 'public', name: 'f' },
        label: 'public.f()',
        type: 'function',
        privileges: {},
      },
    ],
    notices: [],
  };

  it('groups rows by object kind with their own columns, and filters them', () => {
    const groups = grantGroups(matrix);
    expect(groups.map((g) => [g.kind, g.privileges, g.rows.length])).toEqual([
      ['database', ['CONNECT'], 1],
      ['table', ['SELECT', 'INSERT'], 2],
    ]);
    expect(grantGroups(matrix, 'ITEMS').map((g) => g.rows.map((r) => r.label))).toEqual([
      ['public.items'],
    ]);
  });

  it('grants what is not granted and revokes what is', () => {
    const orders = matrix.rows[1]!;
    expect(toggleGrant({ name: 'app' }, orders, 'SELECT', true)).toEqual({
      kind: 'revoke',
      grantee: { name: 'app' },
      object: orders.object,
      privileges: ['SELECT'],
    });
    expect(toggleGrant({ name: 'app' }, orders, 'INSERT', true)).toEqual({
      kind: 'grant',
      grantee: { name: 'app' },
      object: orders.object,
      privileges: ['INSERT'],
      grantOption: true,
    });
    // Held another way: granting it explicitly.
    expect(toggleGrant({ name: 'app' }, matrix.rows[0]!, 'CONNECT', false).kind).toBe('grant');
  });
});

describe('account forms', () => {
  const pgUser: ServerAccount = {
    name: 'app',
    kind: 'user',
    canLogin: true,
    superuser: false,
    attributes: ['CREATEDB'],
    memberOf: [],
    connectionLimit: 5,
    validUntil: null,
    builtin: false,
  };

  it('creates PostgreSQL roles with only the attributes set', () => {
    const form = {
      ...accountForm('postgres', undefined, true),
      name: 'readers',
      createDb: true,
      connectionLimit: '3',
    };
    expect(accountAction('postgres', form)).toEqual({
      kind: 'createAccount',
      account: { name: 'readers' },
      role: true,
      options: { createDb: true, connectionLimit: 3 },
    });
  });

  it('alters only what changed, and renames', () => {
    const form = {
      ...accountForm('postgres', pgUser),
      createDb: false,
      superuser: true,
      password: 'x',
      connectionLimit: '',
      name: 'app2',
    };
    expect(accountAction('postgres', form, pgUser)).toEqual({
      kind: 'alterAccount',
      account: { name: 'app' },
      options: { password: 'x', superuser: true, createDb: false, connectionLimit: -1 },
      rename: { name: 'app2' },
    });
    expect(accountAction('postgres', accountForm('postgres', pgUser), pgUser)).toEqual({
      kind: 'alterAccount',
      account: { name: 'app' },
      options: {},
    });
  });

  it('creates MySQL users at a host and MariaDB roles without one', () => {
    const user = {
      ...accountForm('mysql'),
      name: 'app',
      host: '10.%',
      password: 'p',
      locked: true,
      connectionLimit: '4',
    };
    expect(accountAction('mysql', user)).toEqual({
      kind: 'createAccount',
      account: { name: 'app', host: '10.%' },
      role: false,
      options: { password: 'p', locked: true, connectionLimit: 4 },
    });
    const role = { ...accountForm('mariadb', undefined, true), name: 'r' };
    expect(role.host).toBe('');
    expect(accountAction('mariadb', role)).toEqual({
      kind: 'createAccount',
      account: { name: 'r' },
      role: true,
      options: {},
    });
    const mysqlUser: ServerAccount = {
      ...pgUser,
      host: '%',
      attributes: [],
      locked: false,
      connectionLimit: null,
    };
    expect(
      accountAction('mysql', { ...accountForm('mysql', mysqlUser), locked: true }, mysqlUser),
    ).toEqual({
      kind: 'alterAccount',
      account: { name: 'app', host: '%' },
      options: { locked: true },
    });
  });
});

describe('settings and confirmations', () => {
  const setting = (name: string, source: string | null): ServerSetting => ({
    name,
    value: '1',
    unit: null,
    category: 'Resource Usage',
    description: `About ${name}`,
    source,
    type: 'integer',
    enumValues: [],
    min: null,
    max: null,
    defaultValue: null,
    scopes: ['global'],
    restartRequired: false,
    pendingRestart: false,
  });

  it('filters settings by text and by being changed', () => {
    const list = [
      setting('work_mem', 'default'),
      setting('shared_buffers', 'configuration file'),
      setting('x', null),
    ];
    expect(filterSettings(list, { text: 'MEM', changedOnly: false }).map((s) => s.name)).toEqual([
      'work_mem',
    ]);
    expect(
      filterSettings(list, { text: 'resource', changedOnly: true }).map((s) => s.name),
    ).toEqual(['shared_buffers']);
  });

  it('shows statements as they would be pasted', () => {
    expect(statementsText('postgres', ['VACUUM t', 'SELECT 1'])).toBe('VACUUM t;\nSELECT 1;');
    expect(statementsText('mongodb', ['db.adminCommand({ killOp: 1, op: 5 })'])).toBe(
      'db.adminCommand({ killOp: 1, op: 5 })',
    );
    expect(
      confirmationMessage(
        {
          title: 't',
          summary: 'On shop.orders.',
          statements: ['A', 'B'],
          notices: [{ level: 'warning', message: 'Locks the table', hint: 'Run it at night' }],
        },
        'Running VACUUM on a production connection',
      ),
    ).toBe(
      'On shop.orders. Locks the table (Run it at night). Running VACUUM on a production connection. This runs, in order:',
    );
  });
});
