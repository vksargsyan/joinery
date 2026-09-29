import {
  JoineryError,
  capabilitiesFor,
  newId,
  toColumnChunk,
  type BrowseNode,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type PlanNode,
  type ResultChunk,
  type SchemaSnapshot,
} from '@joinery/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_APP_SETTINGS,
  appSettingsPatchSchema,
  connectionHostContract,
  createClient,
  mainContract,
  parseRequest,
  safeProfileSchema,
  serve,
  type HandlersOf,
} from '../src';
import { portPair } from './helpers';

const now = '2026-09-29T10:00:00.000Z';

function profile(overrides: Partial<ConnectionProfileInput> = {}): ConnectionProfileInput {
  return {
    id: 'p1',
    name: 'Local Postgres',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: { method: 'password', user: 'app', password: { id: newId(), policy: 'save' } },
    tls: { mode: 'verify-full', keyPassphrase: { id: newId(), policy: 'ask' } },
    ssh: {
      hops: [
        { host: 'bastion', user: 'ops', auth: { method: 'password', password: { id: newId() } } },
      ],
    },
    proxy: { kind: 'socks5', host: 'proxy', port: 1080, password: { id: newId() } },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('connectionHostContract', () => {
  const plan: PlanNode = {
    id: '1',
    operation: 'Hash Join',
    totalCost: 42.5,
    detail: { 'Join Type': 'Inner' },
    children: [
      { id: '2', operation: 'Seq Scan', relation: 'users', detail: {}, children: [] },
      { id: '3', operation: 'Index Scan', index: 'orders_pkey', detail: {}, children: [] },
    ],
  };
  const snapshot: SchemaSnapshot = {
    engine: 'postgres',
    database: 'app',
    options: {},
    schemas: [],
    extensions: [],
    capturedAt: now,
  };

  function setup() {
    const ports = portPair();
    const closed: string[] = [];
    const handlers: HandlersOf<typeof connectionHostContract> = {
      openSession: () => ({ sessionId: 's1' }),
      closeSession: () => {},
      async *execute({ executionId, pageSize = 1000 }) {
        try {
          yield {
            type: 'columns',
            resultIndex: 0,
            columns: [
              { name: 'id', nativeType: 'int8', kind: 'bigint' },
              { name: 'payload', nativeType: 'bytea', kind: 'binary', nullable: true },
              { name: 'score', nativeType: 'float8', kind: 'float' },
            ],
          };
          for (let page = 0; page < 3; page++) {
            const rows = Array.from({ length: pageSize }, (_, r) => {
              const n = page * pageSize + r;
              return [BigInt(n) + 2n ** 62n, n % 2 ? null : new Uint8Array([n & 255]), n / 3];
            });
            yield toColumnChunk(0, 3, rows);
          }
          yield { type: 'end', durationMs: 12, rowCount: 3 * pageSize };
        } finally {
          closed.push(executionId);
        }
      },
      cancel: () => {},
      introspect: (_input, { progress }) => {
        progress({ phase: 'tables', completed: 1, total: 2 });
        return snapshot;
      },
      browse: ({ path }) => [
        { kind: 'table', name: 'users', path: [...path, 'users'], hasChildren: true },
      ],
      explain: () => plan,
      begin: () => {},
      commit: () => {},
      rollback: () => {},
      sessionState: () => ({ inTransaction: true }),
      ping: () => {},
      serverInfo: () => ({
        engine: 'postgres',
        serverVersion: '16.4',
        capabilities: capabilitiesFor('postgres', '16.4'),
      }),
    };
    serve(ports.server, connectionHostContract, handlers);
    return { host: createClient(ports.client, connectionHostContract), closed };
  }

  it('streams a result set as validated column chunks', async () => {
    const { host, closed } = setup();
    const { sessionId } = await host.openSession({});
    const chunks: ResultChunk[] = [];
    for await (const chunk of host.execute({
      sessionId,
      text: 'select 1',
      executionId: 'e1',
      pageSize: 10,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.type)).toEqual(['columns', 'rows', 'rows', 'rows', 'end']);
    const rows = chunks[1];
    if (rows?.type !== 'rows') throw new Error('expected rows');
    expect(rows.rowCount).toBe(10);
    expect(rows.data[0]?.[3]).toBe(3n + 2n ** 62n);
    expect(rows.data[1]?.[0]).toEqual(new Uint8Array([0]));
    expect(rows.data[1]?.[1]).toBeNull();
    expect(closed).toEqual(['e1']);
  });

  it('closes the driver cursor when the renderer stops at a row limit', async () => {
    const { host, closed } = setup();
    for await (const chunk of host.execute({
      sessionId: 's1',
      text: 'select',
      executionId: 'e2',
    })) {
      if (chunk.type === 'rows') break;
    }
    await expect.poll(() => closed).toEqual(['e2']);
  });

  it('caps pages at 1,000 rows', async () => {
    const { host } = setup();
    const stream = host.execute({
      sessionId: 's1',
      text: 'select',
      executionId: 'e3',
      pageSize: 5000,
    });
    await expect(stream.next()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('round-trips browse, explain, introspect with progress, and serverInfo', async () => {
    const { host } = setup();
    const parent: BrowseNode = {
      kind: 'schema',
      name: 'public',
      path: ['app', 'public'],
      hasChildren: true,
    };
    const nodes = await host.browse({ sessionId: 's1', path: parent.path });
    expect(nodes).toEqual([
      { kind: 'table', name: 'users', path: ['app', 'public', 'users'], hasChildren: true },
    ]);
    expect(await host.explain({ sessionId: 's1', text: 'select 1' })).toEqual(plan);
    const progress: unknown[] = [];
    expect(
      await host.introspect({ sessionId: 's1' }, { onProgress: (p) => progress.push(p) }),
    ).toEqual(snapshot);
    expect(progress).toEqual([{ phase: 'tables', completed: 1, total: 2 }]);
    const info = await host.serverInfo();
    expect(info.capabilities.transactionalDdl).toBe(true);
    await expect(host.ping()).resolves.toBeUndefined();
  });
});

type SchemaDef = { readonly type: string } & Readonly<Record<string, unknown>>;

function defOf(schema: unknown): SchemaDef {
  return (schema as { _zod: { def: SchemaDef } })._zod.def;
}

const SECRET_KEY = /pass(word|phrase)?$|secret|token|api_?key|credential|private_?key/i;

function unwrap(schema: unknown): unknown {
  const def = defOf(schema);
  return ['optional', 'nullable', 'default', 'prefault', 'readonly', 'nonoptional'].includes(
    def.type,
  )
    ? unwrap(def.innerType)
    : schema;
}

function isSecretRef(schema: unknown): boolean {
  const def = defOf(unwrap(schema));
  return (
    def.type === 'object' &&
    Object.keys(def.shape as object)
      .sort()
      .join() === 'id,policy'
  );
}

const LEAF_TYPES = new Set([
  'string',
  'number',
  'int',
  'boolean',
  'bigint',
  'literal',
  'enum',
  'void',
  'undefined',
  'null',
  'date',
  'template_literal',
]);

interface SecretReport {
  /** Where a secret could travel: a secret-named non-SecretRef field, or a node taking anything. */
  readonly carriers: string[];
  /** Where SecretRefs (id + policy, never a value) appear. */
  readonly refs: string[];
}

/** Walks a schema; fails closed on node types it does not know. */
function inspectSecrets(
  schema: unknown,
  path: string,
  report: SecretReport = { carriers: [], refs: [] },
): SecretReport {
  const def = defOf(schema);
  switch (def.type) {
    case 'object':
      for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
        if (isSecretRef(child)) report.refs.push(`${path}.${key}`);
        else if (SECRET_KEY.test(key)) report.carriers.push(`${path}.${key}`);
        else inspectSecrets(child, `${path}.${key}`, report);
      }
      break;
    case 'array':
      inspectSecrets(def.element, `${path}[]`, report);
      break;
    case 'union':
      for (const option of def.options as unknown[]) inspectSecrets(option, path, report);
      break;
    case 'intersection':
      inspectSecrets(def.left, path, report);
      inspectSecrets(def.right, path, report);
      break;
    case 'record':
      inspectSecrets(def.valueType, `${path}{}`, report);
      break;
    case 'pipe':
      inspectSecrets(def.in, path, report);
      inspectSecrets(def.out, path, report);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
      inspectSecrets(def.innerType, path, report);
      break;
    default:
      if (!LEAF_TYPES.has(def.type)) report.carriers.push(`${path} (${def.type})`);
  }
  return report;
}

describe('mainContract never hands a secret to the renderer', () => {
  it('has no output, item or progress schema that can carry a secret value', () => {
    const report: SecretReport = { carriers: [], refs: [] };
    for (const [path, entry] of mainContract.methods) {
      inspectSecrets(entry.result, path, report);
      if (entry.progress) inspectSecrets(entry.progress, `${path} progress`, report);
    }
    expect(report.carriers).toEqual([]);
    // The walk does reach the profile's secrets, and finds only references there.
    expect(report.refs).toEqual(
      expect.arrayContaining([
        'profiles.get.auth.password',
        'profiles.get.auth.apiKey',
        'profiles.get.auth.token',
        'profiles.get.tls.keyPassphrase',
        'profiles.get.ssh.hops[].auth.password',
        'profiles.get.ssh.hops[].auth.passphrase',
        'profiles.get.proxy.password',
        'profiles.list[].auth.password',
        'profiles.save.auth.password',
      ]),
    );
  });

  it('catches the leaks the check is meant for', () => {
    const leaky = z.object({
      auth: z.object({ password: z.string() }),
      extra: z.unknown(),
      blob: z.map(z.string(), z.string()),
    });
    expect(inspectSecrets(leaky, 'x').carriers).toEqual([
      'x.auth.password',
      'x.extra (unknown)',
      'x.blob (map)',
    ]);
  });

  it('only accepts secrets, never returns them', () => {
    const secretMethods = [...mainContract.methods.values()].filter((m) =>
      m.path.startsWith('secrets.'),
    );
    expect(secretMethods.map((m) => m.path).sort()).toEqual(['secrets.clear', 'secrets.set']);
    for (const method of secretMethods) expect(defOf(method.result).type).toBe('void');
  });

  it('strips fields outside the schema before a profile leaves main', async () => {
    const ports = portPair();
    const stored = { ...safeProfileSchema.parse(profile()), version: 3 };
    const leaky = { ...stored, password: 'hunter2', auth: { ...stored.auth, secret: 'hunter2' } };
    const notUsed = (): never => {
      throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'not used' });
    };
    const emptyPage = { entries: [], nextCursor: null };
    serve(ports.server, mainContract, {
      profiles: {
        list: () => [leaky],
        get: () => leaky,
        save: ({ profile }) => ({ ...profile, password: 'hunter2', version: 1 }),
        delete: notUsed,
        parseUri: notUsed,
        secretStatus: notUsed,
      },
      folders: { list: () => [], save: notUsed, delete: notUsed },
      secrets: { set: notUsed, clear: notUsed },
      testConnection: notUsed,
      openConnection: notUsed,
      closeConnection: notUsed,
      connectionEvents: notUsed,
      history: { list: () => emptyPage, search: () => emptyPage, add: notUsed },
      settings: { get: () => DEFAULT_APP_SETTINGS, set: () => DEFAULT_APP_SETTINGS },
      app: {
        info: () => ({
          name: 'Joinery',
          version: '0.0.0',
          platform: 'linux',
          arch: 'x64',
          versions: { node: '22' },
        }),
        openExternal: notUsed,
      },
      dialogs: { openFile: notUsed },
    });
    const main = createClient(ports.client, mainContract);
    for (const received of [
      await main.profiles.get({ id: 'p1' }),
      ...(await main.profiles.list()),
    ]) {
      expect(JSON.stringify(received)).not.toContain('hunter2');
      expect(received).toEqual(stored);
    }
    const saved = await main.profiles.save({ profile: profile({ id: 'p2' }) });
    expect(saved).toMatchObject({ id: 'p2', version: 1 });
    expect(JSON.stringify(saved)).not.toContain('hunter2');
    expectTypeOf(saved).toExtend<ConnectionProfile>();
    expectTypeOf(saved.version).toEqualTypeOf<number>();
  });
});

describe('safeProfileSchema', () => {
  it('accepts a profile whose secrets are all references', () => {
    expect(safeProfileSchema.safeParse(profile()).success).toBe(true);
  });

  it('rejects a password or token inside an endpoint URI or URL', () => {
    for (const uri of [
      'postgresql://app:hunter2@db:5432/app',
      'mongodb://app:hunter2@h1:27017,h2:27017/app',
      'postgresql://db/app?sslmode=require&password=hunter2',
      'redis://:hunter2@cache:6379/0',
    ]) {
      const result = safeProfileSchema.safeParse(profile({ endpoint: { kind: 'uri', uri } }));
      expect(result.success, uri).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain('hunter2');
    }
    for (const uri of [
      'postgresql://app@db:5432/app',
      'mongodb://h1:27017,h2:27017/app?replicaSet=rs0',
    ]) {
      expect(
        safeProfileSchema.safeParse(profile({ endpoint: { kind: 'uri', uri } })).success,
        uri,
      ).toBe(true);
    }
    const search = profile({
      engine: 'elasticsearch',
      endpoint: { kind: 'urls', urls: ['https://es1:9200', 'https://elastic:hunter2@es2:9200'] },
    });
    const result = safeProfileSchema.safeParse(search);
    expect(result.error?.issues[0]?.path).toEqual(['endpoint', 'urls', 1]);
  });

  it('rejects a secret typed in as a SecretRef id', () => {
    const result = safeProfileSchema.safeParse(
      profile({ auth: { method: 'password', user: 'app', password: { id: 'hunter2' } } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('hunter2');
  });
});

describe('parseRequest', () => {
  it('validates a payload for a known method and types it', () => {
    const request = parseRequest(mainContract, 'history.list', undefined);
    expect(request).toEqual({ method: 'history.list', input: { limit: 100 } });
    expectTypeOf(request.input).toEqualTypeOf<{
      profileId?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    }>();
  });

  it('returns a union to narrow on when the method is only known at runtime', () => {
    const method: string = 'secrets.set';
    const refId = newId();
    const request = parseRequest(mainContract, method, { profileId: 'p1', refId, value: 's3cret' });
    if (request.method !== 'secrets.set') throw new Error('expected secrets.set');
    expectTypeOf(request.input).toEqualTypeOf<{
      profileId: string;
      refId: string;
      value: string;
    }>();
    expect(request.input).toEqual({ profileId: 'p1', refId, value: 's3cret' });
  });

  it('throws NOT_FOUND for an unknown method', () => {
    for (const method of ['profiles.nope', 'profiles', 42, undefined]) {
      expect(() => parseRequest(mainContract, method, {})).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
    }
  });

  it('throws VALIDATION_FAILED without echoing the payload', () => {
    let caught: unknown;
    try {
      parseRequest(mainContract, 'secrets.set', {
        profileId: 'p1',
        refId: 'hunter2',
        value: 'hunter2',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JoineryError);
    const error = caught as JoineryError;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('refId');
    expect(JSON.stringify(error.toJSON())).not.toContain('hunter2');
  });

  it('accepts partial settings patches', () => {
    expect(appSettingsPatchSchema.parse({ editor: { fontSize: 14 } })).toEqual({
      editor: { fontSize: 14 },
    });
    expect(() => parseRequest(mainContract, 'settings.set', { editor: { fontSize: 2 } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('desktop additions', () => {
  function serveMain(overrides: Partial<HandlersOf<typeof mainContract>> = {}) {
    const ports = portPair();
    const notUsed = (): never => {
      throw new JoineryError({ code: 'NOT_SUPPORTED', message: 'not used' });
    };
    const emptyPage = { entries: [], nextCursor: null };
    const handlers: HandlersOf<typeof mainContract> = {
      profiles: {
        list: () => [],
        get: notUsed,
        save: notUsed,
        delete: notUsed,
        parseUri: notUsed,
        secretStatus: notUsed,
      },
      folders: { list: () => [], save: notUsed, delete: notUsed },
      secrets: { set: notUsed, clear: notUsed },
      testConnection: notUsed,
      openConnection: notUsed,
      closeConnection: notUsed,
      connectionEvents: notUsed,
      history: { list: () => emptyPage, search: () => emptyPage, add: notUsed },
      settings: { get: () => DEFAULT_APP_SETTINGS, set: () => DEFAULT_APP_SETTINGS },
      app: {
        info: notUsed,
        openExternal: () => {},
      },
      dialogs: { openFile: () => ({ path: null }) },
      ...overrides,
    };
    serve(ports.server, mainContract, handlers);
    return createClient(ports.client, mainContract);
  }

  it('reports the transaction state of a session', async () => {
    const ports = portPair();
    const handlers = {
      sessionState: ({ sessionId }: { sessionId: string }) => ({
        inTransaction: sessionId === 'open',
      }),
    };
    serve(ports.server, connectionHostContract, {
      ...(Object.fromEntries(
        [...connectionHostContract.methods.keys()].map((path) => [path, () => undefined]),
      ) as unknown as HandlersOf<typeof connectionHostContract>),
      ...handlers,
    });
    const host = createClient(ports.client, connectionHostContract);
    expect(await host.sessionState({ sessionId: 'open' })).toEqual({ inTransaction: true });
    expect(await host.sessionState({ sessionId: 'idle' })).toEqual({ inTransaction: false });
  });

  it('returns a parsed URI as a safe draft and never the password', async () => {
    const draft = safeProfileSchema.parse(profile({ id: newId() }));
    const main = serveMain({
      profiles: {
        list: () => [],
        get: () => {
          throw new Error('not used');
        },
        save: () => {
          throw new Error('not used');
        },
        delete: () => {},
        parseUri: ({ uri }) => ({
          profile: uri.includes('leak')
            ? { ...draft, endpoint: { kind: 'uri', uri: 'postgresql://app:hunter2@db/app' } }
            : { ...draft, password: 'hunter2' },
          passwordFound: true,
          ignoredParams: [],
        }),
        secretStatus: () => ({ canSave: false, missing: [] }),
      },
    });
    const parsed = await main.profiles.parseUri({ uri: 'postgresql://app:hunter2@db/app' });
    expect(parsed.passwordFound).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    // A handler that let the password through in the endpoint fails validation on the way out.
    await expect(main.profiles.parseUri({ uri: 'leak://x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(main.profiles.parseUri({ uri: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reports missing secrets by reference only', async () => {
    const refId = newId();
    const main = serveMain({
      profiles: {
        list: () => [],
        get: () => {
          throw new Error('not used');
        },
        save: () => {
          throw new Error('not used');
        },
        delete: () => {},
        parseUri: () => {
          throw new Error('not used');
        },
        secretStatus: ({ profileId }) => ({
          canSave: profileId === undefined,
          missing:
            profileId === 'bad'
              ? [{ refId: 'hunter2', policy: 'ask', unreadable: false }]
              : [{ refId, policy: 'ask', unreadable: false, value: 'hunter2' } as never],
        }),
      },
    });
    expect(await main.profiles.secretStatus({})).toEqual({
      canSave: true,
      missing: [{ refId, policy: 'ask', unreadable: false }],
    });
    const status = await main.profiles.secretStatus({ profileId: 'p1' });
    expect(JSON.stringify(status)).not.toContain('hunter2');
    await expect(main.profiles.secretStatus({ profileId: 'bad' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('streams connection events until the caller stops', async () => {
    let stopped = false;
    const main = serveMain({
      async *connectionEvents(_input, { signal }) {
        try {
          yield { connectionId: 'c1', profileId: 'p1', state: 'ready' } as const;
          yield {
            connectionId: 'c1',
            profileId: 'p1',
            state: 'restarting',
            attempt: 1,
            message: 'The connection host exited with code 1',
          } as const;
          // A long-lived stream waits on its signal, which aborts when the caller stops.
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
        } finally {
          stopped = true;
        }
      },
    });
    const seen: string[] = [];
    for await (const event of main.connectionEvents()) {
      seen.push(`${event.state}${event.attempt ?? ''}`);
      if (seen.length === 2) break;
    }
    expect(seen).toEqual(['ready', 'restarting1']);
    await expect.poll(() => stopped).toBe(true);
  });

  it('only accepts https links for the system browser', async () => {
    const main = serveMain();
    await expect(
      main.app.openExternal({ url: 'https://joinery.dev/docs' }),
    ).resolves.toBeUndefined();
    for (const url of [
      'http://joinery.dev',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'joinery://app/index.html',
    ]) {
      await expect(main.app.openExternal({ url }), url).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('validates open-file dialog filters', async () => {
    const main = serveMain();
    expect(
      await main.dialogs.openFile({
        filters: [{ name: 'Certificates', extensions: ['pem', '*'] }],
      }),
    ).toEqual({ path: null });
    await expect(
      main.dialogs.openFile({ filters: [{ name: 'Bad', extensions: ['../x'] }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
