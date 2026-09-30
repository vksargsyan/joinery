import { CONFIG_SECRET_MASK, buildConfigRows, type ConfigRow } from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import {
  ALL_NODES,
  applyOutcome,
  draftsAfterApply,
  editorKind,
  editorValue,
  groupConfigRows,
  pendingChanges,
  previewCommands,
  selectChoices,
  targetChoices,
  targetOf,
  updateDrafts,
} from '../src/renderer/src/state/redis/config-editor';

const rows = buildConfigRows([
  {
    node: 'a:1',
    role: 'primary',
    values: {
      maxmemory: '0',
      'maxmemory-policy': 'allkeys-lru',
      appendonly: 'no',
      databases: '16',
      port: '6379',
      'slowlog-max-len': '128',
      'module.option': 'x',
    },
    secrets: { requirepass: true },
  },
  {
    node: 'b:2',
    role: 'primary',
    values: {
      maxmemory: '1gb',
      'maxmemory-policy': 'allkeys-lru',
      appendonly: 'no',
      databases: '16',
      port: '6379',
      'slowlog-max-len': '128',
      'module.option': 'x',
    },
    secrets: { requirepass: true },
  },
]);
const row = (name: string): ConfigRow => rows.find((r) => r.name === name)!;

describe('listing parameters', () => {
  it('groups rows in display order and filters them', () => {
    const all = groupConfigRows(rows, { search: '', filter: 'all', drafts: {} });
    expect(all.map((g) => g.id)).toEqual([
      'memory',
      'persistence',
      'clients',
      'security',
      'latency',
      'general',
      'advanced',
    ]);
    expect(groupConfigRows(rows, { search: 'slow', filter: 'all', drafts: {} })).toEqual([
      expect.objectContaining({ id: 'latency', rows: [row('slowlog-max-len')] }),
    ]);
    const changed = groupConfigRows(rows, { search: '', filter: 'changed', drafts: {} });
    expect(changed.flatMap((g) => g.rows.map((r) => r.name))).toEqual(['maxmemory-policy']);
    const differs = groupConfigRows(rows, { search: '', filter: 'differs', drafts: {} });
    expect(differs.flatMap((g) => g.rows.map((r) => r.name))).toEqual(['maxmemory']);
    const pending = groupConfigRows(rows, {
      search: '',
      filter: 'pending',
      drafts: { hz: '1', 'slowlog-max-len': '5' },
    });
    expect(pending.flatMap((g) => g.rows.map((r) => r.name))).toEqual(['slowlog-max-len']);
  });

  it('gives each parameter the editor its type needs', () => {
    expect(editorKind(row('maxmemory-policy'), '7.0.0')).toBe('select');
    expect(editorKind(row('appendonly'), '7.0.0')).toBe('select');
    expect(editorKind(row('slowlog-max-len'), '7.0.0')).toBe('text');
    expect(editorKind(row('module.option'), '7.0.0')).toBe('text');
    expect(editorKind(row('requirepass'), '7.0.0')).toBe('secret');
    expect(editorKind(row('databases'), '7.0.0')).toBe('readonly');
    expect(editorKind(row('port'), '6.2.14')).toBe('readonly');
    expect(editorKind(row('port'), '7.0.0')).toBe('text');
    expect(selectChoices(row('appendonly'))).toEqual(['yes', 'no']);
    const odd = buildConfigRows([
      { node: 'a:1', role: 'primary', values: { 'maxmemory-policy': 'volatile-new' }, secrets: {} },
    ])[0]!;
    expect(selectChoices(odd)).toContain('volatile-new');
  });
});

describe('drafts and pending changes', () => {
  it('keeps a draft only while it differs from the current value', () => {
    let drafts = updateDrafts({}, row('slowlog-max-len'), '256');
    expect(drafts).toEqual({ 'slowlog-max-len': '256' });
    expect(editorValue(row('slowlog-max-len'), drafts)).toBe('256');
    drafts = updateDrafts(drafts, row('slowlog-max-len'), '128');
    expect(drafts).toEqual({});
    // A differing value shows empty until something is chosen; choosing nothing drops the draft.
    expect(editorValue(row('maxmemory'), {})).toBe('');
    expect(updateDrafts({ maxmemory: '1gb' }, row('maxmemory'), '')).toEqual({});
    // Secrets never show their value, and an empty password field means no change.
    expect(editorValue(row('requirepass'), {})).toBe('');
    expect(updateDrafts({}, row('requirepass'), '')).toEqual({});
    expect(updateDrafts({}, row('requirepass'), 'hunter2')).toEqual({ requirepass: 'hunter2' });
  });

  it('validates and normalises drafts, leaving out those that mean the current value', () => {
    const pending = pendingChanges(rows, {
      maxmemory: '2GB',
      'maxmemory-policy': 'ALLKEYS-LRU',
      'slowlog-max-len': 'many',
      requirepass: 'hunter2',
    });
    expect(pending).toEqual([
      { name: 'maxmemory', value: '2gb', secret: false, current: undefined },
      { name: 'requirepass', value: 'hunter2', secret: true, current: CONFIG_SECRET_MASK },
      {
        name: 'slowlog-max-len',
        value: 'many',
        secret: false,
        current: '128',
        error: 'Must be a whole number',
      },
    ]);
  });

  it('previews the exact commands with secrets masked', () => {
    const changes = [
      { name: 'maxmemory', value: '2gb' },
      { name: 'requirepass', value: 'hunter2' },
    ];
    expect(previewCommands(changes, true)).toEqual([
      `CONFIG SET maxmemory 2gb requirepass ${CONFIG_SECRET_MASK}`,
    ]);
    expect(previewCommands(changes, false)).toEqual([
      'CONFIG SET maxmemory 2gb',
      `CONFIG SET requirepass ${CONFIG_SECRET_MASK}`,
    ]);
    expect(previewCommands([{ name: 'save', value: '' }], true)).toEqual(['CONFIG SET save ""']);
  });

  it('keeps what failed on any node pending after an apply', () => {
    const result = {
      atomic: false,
      nodes: [
        {
          node: 'a:1',
          parameters: [
            { name: 'maxmemory', applied: true },
            { name: 'hz', applied: true },
          ],
        },
        {
          node: 'b:2',
          parameters: [
            { name: 'maxmemory', applied: true },
            { name: 'hz', applied: false, error: 'ERR nope' },
          ],
        },
      ],
    };
    expect(applyOutcome(result)).toEqual({
      applied: ['maxmemory'],
      failed: [{ name: 'hz', node: 'b:2', error: 'ERR nope' }],
    });
    expect(draftsAfterApply({ maxmemory: '1gb', hz: '20', other: 'x' }, result)).toEqual({
      hz: '20',
      other: 'x',
    });
  });
});

describe('targets', () => {
  it('offers every primary, every node and each node in Cluster mode', () => {
    const nodes = [
      { address: 'a:1', role: 'primary' as const },
      { address: 'b:2', role: 'primary' as const },
      { address: 'c:3', role: 'replica' as const },
    ];
    expect(targetChoices(nodes, 'cluster')).toEqual([
      { value: '', label: 'All primaries (2)' },
      { value: ALL_NODES, label: 'All nodes (3)' },
      { value: 'a:1', label: 'a:1 (primary)' },
      { value: 'b:2', label: 'b:2 (primary)' },
      { value: 'c:3', label: 'c:3 (replica)' },
    ]);
    expect(targetOf('')).toEqual({});
    expect(targetOf(ALL_NODES)).toEqual({ replicas: true });
    expect(targetOf('c:3')).toEqual({ node: 'c:3' });
  });

  it('offers the master and its replicas in Sentinel mode', () => {
    expect(
      targetChoices(
        [
          { address: 'm:1', role: 'primary' },
          { address: 'r:2', role: 'replica' },
        ],
        'sentinel',
      ),
    ).toEqual([
      { value: '', label: 'm:1 (master)' },
      { value: 'r:2', label: 'r:2 (replica)' },
    ]);
    expect(targetChoices([{ address: 's:1', role: 'primary' }], 'standalone')).toHaveLength(1);
  });
});
