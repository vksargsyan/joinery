import { describe, expect, it } from 'vitest';

import { isStatusReply, toRedisReply } from '../src';
import { asNumber, asRecord } from '../src/replies';

const b = (text: string): Buffer => Buffer.from(text);

describe('toRedisReply', () => {
  it('converts ioredis values into plain, structured-clone-safe replies', () => {
    const reply = toRedisReply([
      b('a'),
      '12',
      7,
      null,
      [],
      new Error('ERR x'),
      '-9223372036854775808',
    ]);
    expect(reply).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', value: new Uint8Array([97]) },
        { type: 'integer', value: 12 },
        { type: 'integer', value: 7 },
        { type: 'nil' },
        { type: 'array', items: [] },
        { type: 'error', value: 'ERR x' },
        { type: 'integer', value: -9223372036854775808n },
      ],
    });
    const bulk = toRedisReply(b('xyz'));
    expect(bulk.type === 'bulk' && bulk.value.constructor).toBe(Uint8Array);
    // Structured clone keeps everything.
    expect(structuredClone(reply)).toEqual(reply);
    expect(toRedisReply(b('OK'), true)).toEqual({ type: 'status', value: 'OK' });
  });

  it('never shares a Buffer pool slab', () => {
    const pooled = Buffer.from('hello');
    const reply = toRedisReply(pooled);
    expect(reply.type === 'bulk' && reply.value.buffer.byteLength).toBe(5);
  });
});

describe('isStatusReply', () => {
  const ok = new Uint8Array([79, 75]);
  it.each([
    [['SET', 'k', 'v'], true],
    [['set', 'k', 'v', 'GET'], false],
    [['PING'], true],
    [['PING', 'hi'], false],
    [['TYPE', 'k'], true],
    [['GET', 'k'], false],
    [['CONFIG', 'SET', 'x', 'y'], true],
    [['CONFIG', 'GET', 'x'], false],
    [['CLIENT', 'SETNAME', 'x'], true],
    [['JSON.SET', 'k', '$', '1'], true],
  ])('%j → %s', (args, expected) => {
    expect(isStatusReply(args, ok, false)).toBe(expected);
  });

  it('treats only a plain OK from module commands as a status', () => {
    expect(isStatusReply(['JSON.GET', 'k'], new TextEncoder().encode('{"a":1}'), false)).toBe(
      false,
    );
  });

  it('treats QUEUED as a status inside MULTI', () => {
    expect(isStatusReply(['GET', 'k'], new TextEncoder().encode('QUEUED'), true)).toBe(true);
    expect(isStatusReply(['GET', 'k'], new TextEncoder().encode('QUEUED'), false)).toBe(false);
  });
});

describe('readers', () => {
  it('reads numbers and flat maps', () => {
    expect(asNumber(b('inf'))).toBe(Infinity);
    expect(asNumber('-inf')).toBe(-Infinity);
    expect(asNumber(b('2.5'))).toBe(2.5);
    expect(asNumber(b('x'))).toBeNull();
    expect(asNumber(null)).toBeNull();
    expect(asRecord([b('a'), 1, b('b'), b('2')])).toEqual({ a: 1, b: b('2') });
  });
});
