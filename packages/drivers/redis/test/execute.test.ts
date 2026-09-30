import { JoineryError, type ResultChunk } from '@joinery/core';
import { array, bulk, integer, status, type RedisReply } from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import { assertAllowed } from '../src';
import { executeText } from '../src/execute';

const ctx = { where: 'cache:6379', phase: 'command' as const };

async function collect(
  text: string,
  replies: RedisReply[],
  cluster = false,
): Promise<{ chunks: ResultChunk[]; seen: string[][] }> {
  const seen: string[][] = [];
  const chunks: ResultChunk[] = [];
  const run = async (args: readonly Uint8Array[], index: number) => {
    seen.push(args.map((a) => new TextDecoder().decode(a)));
    return { reply: replies[index]!, ...(cluster ? { node: '10.0.0.1:7000' } : {}) };
  };
  for await (const chunk of executeText(text, { executionId: 'e' }, run, ctx, cluster))
    chunks.push(chunk);
  return { chunks, seen };
}

describe('assertAllowed', () => {
  it.each([
    ['subscribe', 'a'],
    ['PSUBSCRIBE', 'a*'],
    ['ssubscribe', 'a'],
    ['monitor'],
    ['sync'],
    ['psync', '?', '-1'],
    ['blpop', 'a', 'b', '0'],
    ['brpoplpush', 'a', 'b', '0.0'],
    ['blmpop', '0', '1', 'k', 'LEFT'],
    ['xread', 'COUNT', '1', 'BLOCK', '0', 'STREAMS', 's', '$'],
    ['xreadgroup', 'GROUP', 'g', 'c', 'BLOCK', '0', 'STREAMS', 's', '>'],
    ['wait', '1', '0'],
    ['waitaof', '1', '0', '0'],
    ['hello', '3'],
    ['client', 'reply', 'off'],
    ['quit'],
    ['reset'],
  ])('refuses %s', (...words) => {
    expect(() => assertAllowed(words)).toThrow(JoineryError);
  });

  it.each([
    ['blpop', 'a', '5'],
    ['xread', 'BLOCK', '100', 'STREAMS', 's', '$'],
    ['xread', 'STREAMS', 's', '0'],
    ['wait', '1', '100'],
    ['hello'],
    ['hello', '2'],
    ['client', 'list'],
    ['get', 'subscribe'],
  ])('allows %s', (...words) => {
    expect(() => assertAllowed(words)).not.toThrow();
  });
});

describe('executeText', () => {
  it('yields one result set per command with the redis-cli text', async () => {
    const { chunks, seen } = await collect('set k "a b"\nlrange l 0 -1', [
      status('OK'),
      array([bulk('x'), integer(2)]),
    ]);
    expect(seen).toEqual([
      ['set', 'k', 'a b'],
      ['lrange', 'l', '0', '-1'],
    ]);
    expect(chunks.map((c) => c.type)).toEqual([
      'columns',
      'rows',
      'status',
      'columns',
      'rows',
      'status',
      'end',
    ]);
    expect(chunks[1]).toEqual({ type: 'rows', resultIndex: 0, rowCount: 1, data: [['OK']] });
    expect(chunks[4]).toMatchObject({ resultIndex: 1, data: [['1) "x"\n2) (integer) 2']] });
    expect(chunks[5]).toEqual({ type: 'status', command: 'LRANGE', rowsAffected: null });
    expect(chunks.at(-1)).toMatchObject({ type: 'end', rowCount: 2 });
  });

  it('adds the node column in Cluster mode', async () => {
    const { chunks } = await collect('get k', [bulk('v')], true);
    expect(chunks[0]).toMatchObject({ columns: [{ name: 'reply' }, { name: 'node' }] });
    expect(chunks[1]).toMatchObject({ data: [['"v"'], ['10.0.0.1:7000']] });
  });

  it('refuses before running anything, and throws error replies', async () => {
    await expect(collect('get a\nmonitor', [bulk('v')])).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    await expect(
      collect('lpush s x', [{ type: 'error', value: 'WRONGTYPE Operation against a key' }]),
    ).rejects.toMatchObject({
      code: 'SQL_ERROR',
      engineCode: 'WRONGTYPE',
    });
    await expect(collect('get "open', [])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const { chunks } = await collect('   \n', []);
    expect(chunks).toEqual([{ type: 'end', durationMs: expect.any(Number), rowCount: 0 }]);
  });
});
