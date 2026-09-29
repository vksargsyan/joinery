import { JoineryError } from '@joinery/core';
import { suggestNext } from '@joinery/redis-tools';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RedisSession } from '../../src';
import {
  REDIS_URL,
  cleanup,
  connect,
  newPrefix,
  replies,
  run,
  sleep,
  standaloneProfile,
} from './helpers';

/** The CLI path: execute, structured replies, refusals, transactions and cancel. */
describe.skipIf(!REDIS_URL)('CLI execute (standalone)', () => {
  let session: RedisSession;
  let p: string;

  beforeAll(async () => {
    session = await connect(standaloneProfile());
  });
  afterAll(async () => {
    await session?.close();
  });
  beforeEach(() => {
    p = newPrefix();
  });
  afterEach(async () => {
    if (session.inTransaction) await run(session, 'discard');
    await session.useDatabase('0').catch(() => undefined);
    await cleanup(session, p);
  });

  it('formats replies like redis-cli, one result set per line', async () => {
    const chunks = await run(
      session,
      `set ${p}s "hello world"\nget ${p}s\nget ${p}none\nrpush ${p}l a "b c"\nlrange ${p}l 0 -1\ntype ${p}l`,
    );
    expect(chunks.filter((c) => c.type === 'columns')).toHaveLength(6);
    expect(chunks.at(-1)).toMatchObject({ type: 'end', rowCount: 6 });
    expect(chunks.find((c) => c.type === 'status')).toMatchObject({ command: 'SET' });
    expect(
      await replies(
        session,
        `set ${p}s "hello world"\nget ${p}s\nget ${p}none\nrpush ${p}l2 a "b c"\nlrange ${p}l2 0 -1\ntype ${p}l2\nping\nping hi`,
      ),
    ).toEqual([
      'OK',
      '"hello world"',
      '(nil)',
      '(integer) 2',
      '1) "a"\n2) "b c"',
      'list',
      'PONG',
      '"hi"',
    ]);
    // A value that happens to read OK is still a bulk string.
    expect(await replies(session, `set ${p}ok OK\nget ${p}ok`)).toEqual(['OK', '"OK"']);
    expect(await replies(session, `set ${p}bin "\\x00\\xff"\nget ${p}bin`)).toEqual([
      'OK',
      '"\\x00\\xff"',
    ]);
  });

  it('returns structured replies from command()', async () => {
    expect(await session.command(['SET', `${p}n`, '10'])).toEqual({ type: 'status', value: 'OK' });
    expect(await session.command(['INCRBY', `${p}n`, '9007199254740990'])).toEqual({
      type: 'integer',
      value: 9007199254741000n,
    });
    expect(await session.command(['GET', `${p}n`])).toEqual({
      type: 'bulk',
      value: new TextEncoder().encode('9007199254741000'),
    });
    expect(await session.command(['LPUSH', `${p}n`, 'x'])).toEqual({
      type: 'error',
      value: 'WRONGTYPE Operation against a key holding the wrong kind of value',
    });
    expect(await session.command(['MGET', `${p}n`, `${p}none`])).toMatchObject({
      type: 'array',
      items: [{ type: 'bulk' }, { type: 'nil' }],
    });
  });

  it('throws error replies from execute with a hint', async () => {
    await session.command(['SET', `${p}s`, 'x']);
    const wrong = await run(session, `lpush ${p}s x`).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ code: 'SQL_ERROR', engineCode: 'WRONGTYPE' });
    const unknown = (await run(session, 'frobnicate x').catch((e: unknown) => e)) as JoineryError;
    expect(unknown.code).toBe('SQL_ERROR');
    expect(unknown.hint).toMatch(/does not exist/);
    const syntax = (await run(session, 'get "unterminated').catch(
      (e: unknown) => e,
    )) as JoineryError;
    expect(syntax.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['subscribe news', /Pub\/Sub/],
    ['psubscribe n*', /Pub\/Sub/],
    ['monitor', /Monitor/],
    ['sync', /replication/],
    ['blpop k 0', /timeout/],
    ['bzmpop 0 1 k MIN', /timeout/],
    ['xread block 0 streams s $', /BLOCK/],
    ['wait 1 0', /timeout/],
    ['hello 3', /HELLO/],
    ['client reply off', /Replies/],
    ['quit', /disconnect/],
  ])('refuses %j', async (text, hint) => {
    const error = (await run(session, text).catch((e: unknown) => e)) as JoineryError;
    expect(error.code).toBe('NOT_SUPPORTED');
    expect(`${error.message} ${error.hint}`).toMatch(hint);
  });

  it('tracks SELECT and MULTI/EXEC', async () => {
    expect(await replies(session, 'select 3')).toEqual(['OK']);
    expect(session.database).toBe(3);
    await session.command(['SET', `${p}in3`, 'x']);
    await session.useDatabase('db0');
    expect(session.database).toBe(0);
    expect(await session.exists([`${p}in3`])).toBe(0);
    await session.useDatabase('3');
    expect(await session.exists([`${p}in3`])).toBe(1);
    await session.command(['DEL', `${p}in3`]);
    await session.useDatabase('0');

    expect(await replies(session, `multi\nset ${p}t 1\nincr ${p}t`)).toEqual([
      'OK',
      'QUEUED',
      'QUEUED',
    ]);
    expect(session.inTransaction).toBe(true);
    const busy = await session.getString(`${p}t`).catch((e: unknown) => e);
    expect(busy).toMatchObject({ code: 'CONFLICT' });
    expect(await replies(session, 'exec')).toEqual(['1) "OK"\n2) (integer) 2']);
    expect(session.inTransaction).toBe(false);
    expect((await session.keyInfo([`${p}t`]))[0]!.type).toBe('string');
  });

  it('cancels a blocking command with CLIENT KILL and recovers', async () => {
    await session.useDatabase('2');
    const started = performance.now();
    const pending = run(session, `blpop ${p}queue 20`, 'blocking-1').catch((e: unknown) => e);
    await sleep(300);
    await session.cancel('blocking-1');
    const error = (await pending) as JoineryError;
    expect(error).toBeInstanceOf(JoineryError);
    expect(error.code).toBe('CANCELLED');
    expect(performance.now() - started).toBeLessThan(5000);
    // The connection comes back in the same database.
    expect(await replies(session, 'ping')).toEqual(['PONG']);
    const info = await session.command(['CLIENT', 'INFO']);
    expect(new TextDecoder().decode((info as { value: Uint8Array }).value)).toMatch(/ db=2 /);
    expect(session.database).toBe(2);
    await session.cancel('finished-or-unknown');
  });

  it('cancels through an AbortSignal', async () => {
    const controller = new AbortController();
    const chunks = (async () => {
      for await (const _chunk of session.execute(`brpop ${p}q2 20`, {
        executionId: 'signal-1',
        signal: controller.signal,
      })) {
        // drain
      }
    })().catch((e: unknown) => e);
    await sleep(300);
    controller.abort();
    expect(await chunks).toMatchObject({ code: 'CANCELLED' });
  });

  it('serves command docs for autocomplete', async () => {
    const catalog = await session.commandDocs();
    expect(Object.keys(catalog.commands).length).toBeGreaterThan(200);
    expect(catalog.commands['SET']!.write).toBe(true);
    if (Number(session.server.redisVersion.split('.')[0]) >= 7) {
      expect(catalog.source).toBe('docs');
      const words = suggestNext(catalog, ['set', 'k', 'v'], 'e').suggestions.map((s) => s.text);
      expect(words).toEqual(['EX', 'EXAT']);
    } else {
      // Redis 6.2 has no COMMAND DOCS: names and flags only.
      expect(catalog.source).toBe('info');
    }
    expect(await session.commandDocs()).toBe(catalog);
  });
});
