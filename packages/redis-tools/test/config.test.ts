import { describe, expect, it } from 'vitest';

import {
  CONFIG_GROUPS,
  CONFIG_SECRET_MASK,
  buildConfigRows,
  canonicalConfigName,
  configErrorParameter,
  configGroupOf,
  configParameter,
  configParameters,
  configSetCommands,
  filterConfigRows,
  formatConfigBytes,
  friendlyConfigValue,
  humanConfigBytes,
  isConfigMutable,
  isSecretConfig,
  parseConfigBytes,
  sameConfigValue,
  validateConfigValue,
  versionAtLeast,
  type ConfigNodeValues,
} from '../src';

describe('parameter metadata', () => {
  it('is consistent: unique names, known groups, typed values and valid defaults', () => {
    const names = new Set<string>();
    const groups = new Set(CONFIG_GROUPS.map((g) => g.id));
    for (const meta of configParameters()) {
      for (const name of [meta.name, ...(meta.aliases ?? [])]) {
        expect(names.has(name), name).toBe(false);
        names.add(name);
      }
      expect(groups.has(meta.group), meta.name).toBe(true);
      expect(meta.description.length, meta.name).toBeGreaterThan(10);
      if (meta.type === 'enum' || meta.type === 'boolean')
        expect(meta.values?.length).toBeGreaterThan(1);
      if (meta.default !== undefined) {
        expect(validateConfigValue(meta.name, meta.default), meta.name).toMatchObject({ ok: true });
      }
    }
    expect(configParameters().length).toBeGreaterThan(120);
  });

  it('finds parameters by name or alias and knows which change at runtime', () => {
    expect(configParameter('maxmemory-policy')).toMatchObject({
      type: 'enum',
      default: 'noeviction',
    });
    expect(configParameter('slave-read-only')?.name).toBe('replica-read-only');
    expect(canonicalConfigName('hash-max-ziplist-entries')).toBe('hash-max-listpack-entries');
    expect(canonicalConfigName('some-module.option')).toBe('some-module.option');
    expect(isConfigMutable('maxmemory', '6.2.14')).toBe(true);
    expect(isConfigMutable('databases', '7.2.4')).toBe(false);
    expect(isConfigMutable('port', '6.2.14')).toBe(false);
    expect(isConfigMutable('port', '7.0.0')).toBe(true);
    expect(isConfigMutable('unknown-param', '7.0.0')).toBe(true);
    expect(versionAtLeast('7.0.15', '7.0.0')).toBe(true);
    expect(versionAtLeast('6.2.14', '7.0.0')).toBe(false);
    expect(versionAtLeast('unknown', '6.2.0')).toBe(false);
  });

  it('treats passwords as secrets, including unknown parameters named like one', () => {
    for (const name of [
      'requirepass',
      'masterauth',
      'primaryauth',
      'tls-key-file-pass',
      'search.password',
    ]) {
      expect(isSecretConfig(name), name).toBe(true);
    }
    for (const name of ['maxmemory', 'masteruser', 'tls-auth-clients', 'acl-pubsub-default']) {
      expect(isSecretConfig(name), name).toBe(false);
    }
  });

  it('groups unknown parameters by their name', () => {
    expect(configGroupOf('maxmemory')).toBe('memory');
    expect(configGroupOf('cluster-new-thing')).toBe('cluster');
    expect(configGroupOf('lazyfree-lazy-future')).toBe('memory');
    expect(configGroupOf('tls-new-option')).toBe('security');
    expect(configGroupOf('search.timeout')).toBe('advanced');
    expect(configGroupOf('something-else')).toBe('advanced');
  });
});

describe('memory values', () => {
  it('parses sizes as the server does: k is 1000, kb is 1024', () => {
    expect(parseConfigBytes('4096')).toBe(4096);
    expect(parseConfigBytes('1k')).toBe(1000);
    expect(parseConfigBytes('1kb')).toBe(1024);
    expect(parseConfigBytes('100MB')).toBe(100 * 1024 * 1024);
    expect(parseConfigBytes('2g')).toBe(2e9);
    expect(parseConfigBytes('1 gb')).toBe(1024 ** 3);
    expect(parseConfigBytes('1.5gb')).toBeUndefined();
    expect(parseConfigBytes('lots')).toBeUndefined();
    expect(parseConfigBytes('1tb')).toBeUndefined();
  });

  it('formats sizes for the server and for people', () => {
    expect(formatConfigBytes(104857600)).toBe('100mb');
    expect(formatConfigBytes(1073741824)).toBe('1gb');
    expect(formatConfigBytes(1000)).toBe('1000');
    expect(formatConfigBytes(0)).toBe('0');
    expect(humanConfigBytes(104857600)).toBe('100 MB');
    expect(humanConfigBytes(1536)).toBe('1.5 KB');
    expect(humanConfigBytes(12)).toBe('12 B');
    expect(friendlyConfigValue('maxmemory', '67108864')).toBe('64 MB');
    expect(friendlyConfigValue('maxmemory', '0')).toBeUndefined();
    expect(friendlyConfigValue('cluster-node-timeout', '15000')).toBe('15 s');
    expect(friendlyConfigValue('repl-backlog-ttl', '3600')).toBe('1 h');
    expect(friendlyConfigValue('slowlog-log-slower-than', '10000')).toBe('10 ms');
    expect(friendlyConfigValue('timeout', '30')).toBeUndefined();
    expect(friendlyConfigValue('requirepass', '1gb')).toBeUndefined();
  });
});

describe('validation', () => {
  it.each([
    ['maxmemory-policy', 'ALLKEYS-LRU', 'allkeys-lru'],
    ['appendonly', 'Yes', 'yes'],
    ['maxmemory', '100MB', '100mb'],
    ['maxmemory-clients', '10%', '10%'],
    ['slowlog-log-slower-than', '-1', '-1'],
    ['list-max-listpack-size', '-2', '-2'],
    ['save', ' 3600  1 300 100 ', '3600 1 300 100'],
    ['save', '', ''],
    [
      'client-output-buffer-limit',
      'normal 0 0 0 replica 256mb 64mb 60',
      'normal 0 0 0 replica 256mb 64mb 60',
    ],
    ['oom-score-adj-values', '0 200 800', '0 200 800'],
    ['latency-tracking-info-percentiles', '50 99 99.9', '50 99 99.9'],
    ['notify-keyspace-events', 'KEA', 'KEA'],
    ['shutdown-on-sigint', 'save now', 'save now'],
    ['requirepass', ' with spaces ', ' with spaces '],
    ['some-module.option', 'anything goes', 'anything goes'],
  ])('accepts %s = "%s"', (name, input, value) => {
    expect(validateConfigValue(name, input)).toEqual({ ok: true, value });
  });

  it.each([
    ['maxmemory-policy', 'sometimes', /one of noeviction/],
    ['appendonly', 'true', /yes or no/],
    ['maxmemory', '1.5gb', /size/],
    ['maxmemory', '10%', /size/],
    ['maxmemory-samples', '0', /at least 1/],
    ['maxmemory-samples', '65', /at most 64/],
    ['hz', 'fast', /whole number/],
    ['save', '3600', /pairs/],
    ['client-output-buffer-limit', 'normal 0 0', /groups of four/],
    ['client-output-buffer-limit', 'vip 0 0 0', /client class/],
    ['oom-score-adj-values', '0 200', /three/],
    ['latency-tracking-info-percentiles', '50 101', /0 to 100/],
    ['notify-keyspace-events', 'KEQ', /flag letters/],
    ['shutdown-on-sigint', 'save later', /"later"/],
    ['timeout', '1\n2', /line breaks/],
  ])('refuses %s = "%s"', (name, input, error) => {
    const result = validateConfigValue(name, input);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(error);
  });

  it('compares values by meaning', () => {
    expect(sameConfigValue('maxmemory', '64mb', '67108864')).toBe(true);
    expect(sameConfigValue('maxmemory', '64m', '67108864')).toBe(false);
    expect(sameConfigValue('appendonly', 'YES', 'yes')).toBe(true);
    expect(sameConfigValue('hz', '010', '10')).toBe(true);
    expect(sameConfigValue('hz', '', '0')).toBe(false);
    expect(sameConfigValue('save', '3600  1', '3600 1')).toBe(true);
    expect(sameConfigValue('dir', '/a', '/a/')).toBe(false);
    expect(sameConfigValue('requirepass', 'x', 'X')).toBe(false);
  });
});

describe('rows', () => {
  const node = (
    name: string,
    values: Record<string, string>,
    secrets: Record<string, boolean> = {},
  ): ConfigNodeValues => ({ node: name, role: 'primary', values, secrets });

  it('folds aliases, marks defaults and sorts by group', () => {
    const rows = buildConfigRows([
      node(
        'a:1',
        {
          'replica-read-only': 'yes',
          'slave-read-only': 'yes',
          'hash-max-ziplist-entries': '512',
          maxmemory: '100mb',
          'maxmemory-policy': 'noeviction',
          'module.option': 'x',
        },
        { requirepass: true },
      ),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      'maxmemory',
      'maxmemory-policy',
      'replica-read-only',
      'requirepass',
      'hash-max-ziplist-entries',
      'module.option',
    ]);
    const replica = rows.find((r) => r.name === 'replica-read-only')!;
    expect(replica).toMatchObject({
      aliases: ['slave-read-only'],
      isDefault: true,
      differs: false,
    });
    // Only the old name on 6.2: it keeps its name and gets the canonical metadata.
    expect(rows.find((r) => r.name === 'hash-max-ziplist-entries')!.meta?.name).toBe(
      'hash-max-listpack-entries',
    );
    expect(rows.find((r) => r.name === 'maxmemory')!.isDefault).toBe(false);
    expect(rows.find((r) => r.name === 'module.option')).toMatchObject({
      meta: undefined,
      group: 'advanced',
      isDefault: undefined,
    });
    expect(rows.find((r) => r.name === 'requirepass')).toMatchObject({
      secret: true,
      secretSet: true,
      value: CONFIG_SECRET_MASK,
    });
  });

  it('keeps each node’s value where the nodes differ', () => {
    const rows = buildConfigRows([
      node('a:1', { maxmemory: '0', hz: '10' }, { requirepass: true }),
      node('b:2', { maxmemory: '1gb', hz: '10' }, { requirepass: false }),
      node('c:3', { maxmemory: '0' }, { requirepass: true }),
    ]);
    const memory = rows.find((r) => r.name === 'maxmemory')!;
    expect(memory).toMatchObject({ differs: true, value: undefined, isDefault: undefined });
    expect(memory.byNode).toEqual([
      { node: 'a:1', value: '0' },
      { node: 'b:2', value: '1gb' },
      { node: 'c:3', value: '0' },
    ]);
    // Missing on one node counts as a difference.
    expect(rows.find((r) => r.name === 'hz')!.differs).toBe(true);
    expect(rows.find((r) => r.name === 'requirepass')).toMatchObject({
      differs: true,
      secretSet: false,
    });
  });

  it('filters by every word of the search, in names, descriptions and values', () => {
    const rows = buildConfigRows([
      node('a:1', { maxmemory: '0', 'maxmemory-policy': 'allkeys-lru', 'slowlog-max-len': '128' }),
    ]);
    expect(filterConfigRows(rows, 'maxmemory').map((r) => r.name)).toEqual([
      'maxmemory',
      'maxmemory-policy',
    ]);
    expect(filterConfigRows(rows, 'LRU').map((r) => r.name)).toEqual(['maxmemory-policy']);
    expect(filterConfigRows(rows, 'slow log entries').map((r) => r.name)).toEqual([
      'slowlog-max-len',
    ]);
    expect(filterConfigRows(rows, '  ')).toHaveLength(3);
  });
});

describe('commands', () => {
  const changes = [
    { name: 'maxmemory', value: '100mb' },
    { name: 'requirepass', value: 'hunter2' },
  ];

  it('sends every pair in one command where the server takes several', () => {
    expect(configSetCommands(changes, { multi: true })).toEqual([
      ['CONFIG', 'SET', 'maxmemory', '100mb', 'requirepass', 'hunter2'],
    ]);
    expect(configSetCommands(changes, { multi: false, mask: true })).toEqual([
      ['CONFIG', 'SET', 'maxmemory', '100mb'],
      ['CONFIG', 'SET', 'requirepass', CONFIG_SECRET_MASK],
    ]);
    expect(configSetCommands([], { multi: true })).toEqual([]);
  });

  it('finds the parameter a CONFIG SET error names, on every version', () => {
    expect(
      configErrorParameter(
        "ERR CONFIG SET failed (possibly related to argument 'maxmemory-policy') - argument(s) must be one of",
      ),
    ).toBe('maxmemory-policy');
    expect(
      configErrorParameter("ERR Unknown option or number of arguments for CONFIG SET - 'nope'"),
    ).toBe('nope');
    expect(configErrorParameter("ERR Invalid argument 'x' for CONFIG SET 'hz'")).toBe('hz');
    expect(configErrorParameter('ERR Unsupported CONFIG parameter: nope')).toBe('nope');
    expect(configErrorParameter('ERR unknown command')).toBeUndefined();
  });
});
