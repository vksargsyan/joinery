import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { WireReader, mpint, wireString } from '../src/wire';

const toBigInt = (bytes: Buffer): bigint =>
  bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString('hex')}`);

describe('SSH wire encoding', () => {
  it('encodes mpints minimally and as positive numbers', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (bytes) => {
        const value = Buffer.from(bytes);
        const content = new WireReader(mpint(value)).string();
        expect(toBigInt(content)).toBe(toBigInt(value));
        if (content.length > 0) {
          // Positive: the sign bit is clear, and there is no redundant leading zero byte.
          expect(content[0]! & 0x80).toBe(0);
          if (content[0] === 0) expect(content[1]! & 0x80).not.toBe(0);
        }
      }),
    );
  });

  it('round-trips strings and fails on truncation', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 5 }), (values) => {
        const reader = new WireReader(Buffer.concat(values.map((v) => wireString(v))));
        for (const value of values) expect(reader.text()).toBe(value);
        expect(reader.remaining).toBe(0);
      }),
    );
    expect(() => new WireReader(Buffer.from([0, 0, 0, 9, 1])).string()).toThrow(/truncated/);
  });
});
