import type { CommandCatalog, RedisReply } from '@querybara/redis-tools';
import { describe, expect, it } from 'vitest';

import {
  connectionHostContract,
  createClient,
  redisConfigApplyResultSchema,
  redisConfigSnapshotSchema,
  redisHostContractShape,
  redisKeyInfoSchema,
  redisReplySchema,
  redisScanInputSchema,
  redisCommandCatalogSchema,
  redisZSetEntrySchema,
  serve,
  type HandlersOf,
} from '../src';
import { portPair, unusedHandlers } from './helpers';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('redis schemas', () => {
  it('accepts reply trees with bytes, big integers, NaN doubles and maps', () => {
    const reply: RedisReply = {
      type: 'array',
      items: [
        { type: 'bulk', value: new Uint8Array([0xff, 0x00]) },
        { type: 'integer', value: 2n ** 64n },
        { type: 'double', value: Number.NaN },
        { type: 'nil' },
        {
          type: 'map',
          entries: [
            [
              { type: 'status', value: 'k' },
              { type: 'set', items: [{ type: 'boolean', value: true }] },
            ],
          ],
        },
        { type: 'verbatim', format: 'txt', value: enc('hi') },
      ],
    };
    expect(redisReplySchema.parse(reply)).toEqual(reply);
    expect(redisReplySchema.safeParse({ type: 'bulk', value: 'text' }).success).toBe(false);
    expect(redisReplySchema.safeParse({ type: 'array', items: [{ type: 'nope' }] }).success).toBe(
      false,
    );
  });

  it('keeps keys as bytes and scores that are infinite', () => {
    const info = {
      key: Buffer.from('user:1'),
      type: 'hash',
      kind: 'hash',
      ttlMs: -1,
      encoding: 'listpack',
      length: 3,
    };
    expect(redisKeyInfoSchema.parse(info).key).toBeInstanceOf(Uint8Array);
    expect(redisKeyInfoSchema.safeParse({ ...info, key: 'user:1' }).success).toBe(false);
    expect(
      redisZSetEntrySchema.parse({ member: enc('m'), score: -Infinity, scoreText: '-inf' }).score,
    ).toBe(-Infinity);
  });

  it('defaults the scan page size and bounds it', () => {
    expect(redisScanInputSchema.parse({ sessionId: 's' }).pageSize).toBe(500);
    expect(redisScanInputSchema.safeParse({ sessionId: 's', pageSize: 0 }).success).toBe(false);
    expect(redisScanInputSchema.parse({ sessionId: 's', match: enc('a*') }).match).toEqual(
      enc('a*'),
    );
  });

  it('validates the command catalog recursively', () => {
    const catalog: CommandCatalog = {
      source: 'docs',
      commands: {
        CONFIG: {
          name: 'CONFIG',
          docFlags: [],
          history: [],
          arguments: [],
          flags: [],
          aclCategories: ['slow'],
          tips: [],
          keySpecs: [],
          write: false,
          readOnly: false,
          blocking: false,
          dangerous: false,
          admin: false,
          subcommands: [
            {
              name: 'CONFIG GET',
              container: 'CONFIG',
              docFlags: [],
              history: [
                { version: '7.0.0', description: 'Added the ability to pass multiple parameters.' },
              ],
              arguments: [
                {
                  name: 'parameter',
                  type: 'string',
                  optional: false,
                  multiple: true,
                  multipleToken: false,
                  arguments: [],
                },
              ],
              subcommands: [],
              arity: -3,
              flags: ['admin'],
              aclCategories: ['admin'],
              tips: [],
              keySpecs: [],
              write: false,
              readOnly: false,
              blocking: false,
              dangerous: true,
              admin: true,
            },
          ],
        },
      },
    };
    expect(redisCommandCatalogSchema.parse(catalog)).toEqual(catalog);
  });
});

describe('redis configuration schemas', () => {
  it('carries secrets only as whether they are set', () => {
    const snapshot = {
      multiSet: true,
      nodes: [
        {
          node: '127.0.0.1:6379',
          role: 'primary',
          values: { maxmemory: '0' },
          secrets: { requirepass: true },
        },
      ],
    };
    expect(redisConfigSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const leaking = {
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], secrets: { requirepass: 'x' } }],
    };
    expect(redisConfigSnapshotSchema.safeParse(leaking).success).toBe(false);
  });

  it('bounds the changes of one CONFIG SET call', () => {
    const set = redisHostContractShape.config.set.input;
    const change = { name: 'maxmemory', value: '1gb' };
    expect(set.safeParse({ sessionId: 's', changes: [change] }).success).toBe(true);
    expect(set.safeParse({ sessionId: 's', changes: [] }).success).toBe(false);
    expect(set.safeParse({ sessionId: 's', changes: [{ name: '', value: '1' }] }).success).toBe(
      false,
    );
    expect(
      set.safeParse({ sessionId: 's', changes: [change], node: '10.0.0.1:7000', replicas: true })
        .success,
    ).toBe(true);
    expect(
      redisConfigApplyResultSchema.parse({
        atomic: true,
        nodes: [{ node: 'a:1', parameters: [{ name: 'maxmemory', applied: false, error: 'ERR' }] }],
      }).nodes[0]?.parameters[0]?.error,
    ).toBe('ERR');
  });
});

describe('redis contract', () => {
  it('declares streams, progress and nested namespaces', () => {
    const methods = connectionHostContract.methods;
    expect(methods.get('redis.scan')?.kind).toBe('stream');
    expect(methods.get('redis.subscribe')?.kind).toBe('stream');
    expect(methods.get('redis.monitor')?.kind).toBe('stream');
    expect(methods.get('redis.bulkDelete')?.progress).toBeDefined();
    expect(methods.get('redis.bigKeys')?.progress).toBeDefined();
    expect(methods.get('redis.key.rename')?.kind).toBe('unary');
    expect(methods.get('redis.stream.claim')?.kind).toBe('unary');
    expect(methods.get('redis.config.set')?.kind).toBe('unary');
    expect(methods.get('redis.config.resetStat')?.kind).toBe('unary');
  });

  it('carries bytes and big integers across a port unchanged', async () => {
    const ports = portPair();
    const redis: HandlersOf<typeof redisHostContractShape> = {
      ...unusedHandlers(redisHostContractShape),
      command: ({ args }) => ({
        reply: {
          type: 'array',
          items: [
            { type: 'bulk', value: Buffer.from(args[1] as Uint8Array) },
            { type: 'integer', value: 2n ** 70n },
          ],
        },
        durationMs: 1,
        database: 0,
        inTransaction: false,
      }),
      scan: async function* () {
        yield {
          keys: [
            {
              key: Buffer.from([0xff]),
              type: 'string',
              kind: 'string',
              ttlMs: -1,
              encoding: null,
              length: 1,
            },
          ],
          cursor: '0',
          done: true,
          calls: 1,
          budgetExhausted: false,
        };
      },
    };
    serve(ports.server, connectionHostContract, {
      ...unusedHandlers(connectionHostContract.shape),
      redis,
    });
    const client = createClient(ports.client, connectionHostContract);
    const result = await client.redis.command({
      sessionId: 's',
      args: ['GET', new Uint8Array([0, 0xff])],
    });
    expect(result.reply).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', value: new Uint8Array([0, 0xff]) },
        { type: 'integer', value: 2n ** 70n },
      ],
    });
    const pages = [];
    for await (const page of client.redis.scan({ sessionId: 's' })) pages.push(page);
    expect(pages[0]?.keys[0]?.key).toEqual(new Uint8Array([0xff]));
    await expect(client.redis.bulkDelete({ sessionId: 's', match: 'x*' })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    client.dispose();
  });
});
