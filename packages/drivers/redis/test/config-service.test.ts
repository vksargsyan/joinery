import { QuerybaraError } from '@querybara/core';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { mapRedisError } from '../src';
import type { Arg, RedisConnection } from '../src/client';
import {
  configApply,
  configRead,
  configResetStat,
  configRewrite,
  type ConfigContext,
} from '../src/config-service';
import type { RedisServerInfo } from '../src/types';

function reply(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

/**
 * A standalone server of the given version: `answer` sees each command's words and returns
 * the raw reply (as ioredis would) or an error reply to throw.
 */
function server(version: string, answer: (words: string[]) => unknown) {
  const sent: string[][] = [];
  const main = {} as Redis;
  const where = 'cache:6379';
  const conn = {
    isCluster: false,
    primaries: () => [main],
    replicas: () => [],
    context: (phase: 'connect' | 'command', command?: string) => ({
      where,
      phase,
      ...(command !== undefined ? { command } : {}),
    }),
  } as unknown as RedisConnection;
  const info: RedisServerInfo = {
    flavor: 'redis',
    version,
    redisVersion: version,
    topology: 'standalone',
    role: 'master',
    modules: [],
    databases: 16,
    databasesExact: true,
    clusterMode: false,
  };
  const ctx: ConfigContext = {
    conn,
    server: info,
    keyDelimiter: ':',
    database: 0,
    nodes: () => [{ address: where, host: 'cache', port: 6379, role: 'primary' }],
    nodeFor: () => main,
    scanNodes: () => [main],
    inDatabase: () => Promise.reject(new Error('unused')),
    transaction: () => Promise.reject(new Error('unused')),
    call: async (args: readonly Arg[]) => {
      const words = args.map(String);
      sent.push(words);
      const raw = answer(words);
      if (raw instanceof Error) {
        throw mapRedisError(raw, { where, phase: 'command', command: 'CONFIG' });
      }
      return raw;
    },
  };
  return { ctx, sent };
}

const buf = (text: string): Buffer => Buffer.from(text);

describe('reading the configuration', () => {
  it('masks secret parameters and says whether they are set', async () => {
    const { ctx } = server('7.2.4', () =>
      ['maxmemory', '0', 'requirepass', 's3cret', 'masterauth', '', 'tls-key-file-pass', 'x'].map(
        buf,
      ),
    );
    const snapshot = await configRead(ctx);
    expect(snapshot).toEqual({
      multiSet: true,
      nodes: [
        {
          node: 'cache:6379',
          role: 'primary',
          values: { maxmemory: '0' },
          secrets: { requirepass: true, masterauth: false, 'tls-key-file-pass': true },
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('s3cret');
  });

  it('explains a CONFIG that was renamed away or refused by ACL', async () => {
    const renamed = server('7.0.0', () =>
      reply("ERR unknown command 'CONFIG', with args beginning with: 'GET' '*' "),
    );
    const error = await configRead(renamed.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuerybaraError);
    expect(error).toMatchObject({
      code: 'NOT_SUPPORTED',
      message: expect.stringContaining('renamed or disabled'),
      hint: expect.stringContaining('provider'),
    });
    const denied = server('7.0.0', () =>
      reply("NOPERM User app has no permissions to run the 'config|get' command"),
    );
    await expect(configRead(denied.ctx)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      engineCode: 'NOPERM',
      message: 'The ACL user may not run CONFIG GET',
    });
  });

  it('keeps network failures as they are', async () => {
    const { ctx } = server('7.0.0', () => new Error('Connection is closed.'));
    const error = await configRead(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});

describe('applying changes', () => {
  it('sends one CONFIG SET with every pair on Redis 7+', async () => {
    const { ctx, sent } = server('7.0.15', () => buf('OK'));
    const result = await configApply(ctx, [
      { name: 'maxmemory', value: '100mb' },
      { name: 'maxmemory-policy', value: 'allkeys-lru' },
    ]);
    expect(sent).toEqual([
      ['config', 'set', 'maxmemory', '100mb', 'maxmemory-policy', 'allkeys-lru'],
    ]);
    expect(result).toEqual({
      atomic: true,
      nodes: [
        {
          node: 'cache:6379',
          parameters: [
            { name: 'maxmemory', applied: true },
            { name: 'maxmemory-policy', applied: true },
          ],
        },
      ],
    });
  });

  it('names the refused parameter of an all-or-nothing call and marks the rest unapplied', async () => {
    const { ctx } = server('7.2.4', () =>
      reply(
        "ERR CONFIG SET failed (possibly related to argument 'maxmemory-policy') - argument(s) must be one of the following: noeviction",
      ),
    );
    const result = await configApply(ctx, [
      { name: 'maxmemory', value: '1gb' },
      { name: 'maxmemory-policy', value: 'sometimes' },
    ]);
    expect(result.nodes[0]!.parameters).toEqual([
      {
        name: 'maxmemory',
        applied: false,
        error:
          'Not applied: the server applies these changes all or none, and it refused maxmemory-policy',
      },
      {
        name: 'maxmemory-policy',
        applied: false,
        error: expect.stringContaining('must be one of'),
      },
    ]);
  });

  it('sets one parameter at a time on Redis 6.2, each with its own outcome', async () => {
    const { ctx, sent } = server('6.2.14', (words) =>
      words[2] === 'maxmemory-policy'
        ? reply(`ERR Invalid argument '${words[3]}' for CONFIG SET 'maxmemory-policy'`)
        : buf('OK'),
    );
    const result = await configApply(ctx, [
      { name: 'maxmemory', value: '1gb' },
      { name: 'maxmemory-policy', value: 'sometimes' },
      { name: 'timeout', value: '30' },
    ]);
    expect(sent).toEqual([
      ['config', 'set', 'maxmemory', '1gb'],
      ['config', 'set', 'maxmemory-policy', 'sometimes'],
      ['config', 'set', 'timeout', '30'],
    ]);
    expect(result.atomic).toBe(false);
    expect(result.nodes[0]!.parameters).toEqual([
      { name: 'maxmemory', applied: true },
      {
        name: 'maxmemory-policy',
        applied: false,
        error: "ERR Invalid argument 'sometimes' for CONFIG SET 'maxmemory-policy'",
      },
      { name: 'timeout', applied: true },
    ]);
  });

  it('never echoes a secret the server quotes in its error', async () => {
    const { ctx } = server('6.2.14', (words) =>
      reply(`ERR Invalid argument '${words[3]}' for CONFIG SET '${words[2]}'`),
    );
    const result = await configApply(ctx, [{ name: 'masterauth', value: 'hunter2' }]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.nodes[0]!.parameters[0]!.error).toContain('••••••••');
  });

  it('fails the whole call when CONFIG SET itself is refused', async () => {
    const { ctx } = server('7.0.0', () =>
      reply("NOPERM User app has no permissions to run the 'config|set' command"),
    );
    await expect(configApply(ctx, [{ name: 'timeout', value: '1' }])).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: 'The ACL user may not run CONFIG SET',
    });
  });

  it('refuses a parameter changed twice or without a name, and does nothing without changes', async () => {
    const { ctx, sent } = server('7.0.0', () => buf('OK'));
    await expect(
      configApply(ctx, [
        { name: 'timeout', value: '1' },
        { name: 'TIMEOUT', value: '2' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(configApply(ctx, [{ name: ' ', value: '1' }])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await configApply(ctx, [])).toEqual({ atomic: false, nodes: [] });
    expect(sent).toEqual([]);
  });
});

describe('rewrite and reset', () => {
  it('reports per node, with a clear message for a server without a configuration file', async () => {
    const { ctx, sent } = server('7.0.0', (words) =>
      words[1] === 'rewrite' ? reply('ERR The server is running without a config file') : buf('OK'),
    );
    expect(await configRewrite(ctx)).toEqual([
      {
        node: 'cache:6379',
        ok: false,
        error:
          'The server was started without a configuration file, so there is nothing to rewrite',
      },
    ]);
    expect(await configResetStat(ctx)).toEqual([{ node: 'cache:6379', ok: true }]);
    expect(sent).toEqual([
      ['config', 'rewrite'],
      ['config', 'resetstat'],
    ]);
  });

  it('knows only the one server outside Cluster and Sentinel', async () => {
    const { ctx } = server('7.0.0', () => buf('OK'));
    await expect(configRewrite(ctx, { node: '10.0.0.9:6379' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await configRewrite(ctx, { node: 'cache:6379' })).toEqual([
      { node: 'cache:6379', ok: true },
    ]);
  });
});
