import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bitAt,
  bitsView,
  countBits,
  decodeGeoScore,
  decodeMessagePack,
  detectHyperLogLog,
  detectJson,
  detectValueFormat,
  encodeGeoScore,
  encodeMessagePack,
  geohashString,
  hexDump,
  jsonTextToMessagePack,
  looksLikeMessagePack,
  messagePackToJsonText,
  parseDisplayBytes,
  setBitOffsets,
} from '../src';
import { enc } from './fixtures';

/** PFADD k a b c on Redis 7.0 (sparse encoding), as GET returns it. */
const SPARSE_HLL = parseDisplayBytes(
  'HYLL\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x80`\\xf3\\x80P\\xb1\\x84K\\xfb\\x80BZ',
);

describe('MessagePack', () => {
  it('decodes and encodes maps, arrays, binary and 64-bit integers', () => {
    const bytes = encodeMessagePack({
      id: 1,
      tags: ['a', 'b'],
      big: 2n ** 60n,
      raw: Uint8Array.of(1, 2),
    });
    expect(decodeMessagePack(bytes)).toEqual({
      id: 1,
      tags: ['a', 'b'],
      big: 2n ** 60n,
      raw: Uint8Array.of(1, 2),
    });
    expect(JSON.parse(messagePackToJsonText(bytes))).toEqual({
      id: 1,
      tags: ['a', 'b'],
      big: { $bigint: '1152921504606846976' },
      raw: { $binary: '0102' },
    });
    // The editor round trip: MessagePack → JSON text → MessagePack.
    expect(jsonTextToMessagePack(messagePackToJsonText(bytes))).toEqual(bytes);
  });

  it('round-trips JSON-compatible values', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }).filter(withoutProtoKeys), (value) => {
        const normalised: unknown = JSON.parse(JSON.stringify(value));
        expect(decodeMessagePack(encodeMessagePack(normalised))).toEqual(normalised);
      }),
      { numRuns: 300 },
    );
  });

  it('refuses a "__proto__" key both ways instead of dropping it', () => {
    expect(() => encodeMessagePack(JSON.parse('{"a":{"__proto__":[]}}'))).toThrow('__proto__');
    // 81 a9 "__proto__" 90: a one-entry map whose key is "__proto__".
    const bytes = Uint8Array.of(0x81, 0xa9, ...enc('__proto__'), 0x90);
    expect(() => decodeMessagePack(bytes)).toThrow();
    expect(looksLikeMessagePack(bytes)).toBe(false);
  });

  it('claims only complete maps and arrays', () => {
    expect(looksLikeMessagePack(encodeMessagePack({ a: 1 }))).toBe(true);
    expect(looksLikeMessagePack(encodeMessagePack([1, 2]))).toBe(true);
    expect(looksLikeMessagePack(enc('a'))).toBe(false);
    expect(looksLikeMessagePack(Uint8Array.of(0x92, 0x01))).toBe(false);
    expect(looksLikeMessagePack(new Uint8Array([...encodeMessagePack([1]), 0]))).toBe(false);
  });
});

describe('text, JSON and hex views', () => {
  it('detects JSON objects and arrays only', () => {
    expect(detectJson(enc(' {"a": [1, 2]} '))?.pretty).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(detectJson(enc('42'))).toBeUndefined();
    expect(detectJson(enc('{broken'))).toBeUndefined();
    expect(detectJson(Uint8Array.of(0x7b, 0xff))).toBeUndefined();
  });

  it('picks the default view of a string value', () => {
    expect(detectValueFormat(new Uint8Array(0))).toBe('empty');
    expect(detectValueFormat(enc('hello\nworld'))).toBe('text');
    expect(detectValueFormat(enc('[1,2]'))).toBe('json');
    expect(detectValueFormat(encodeMessagePack({ a: 'b' }))).toBe('messagepack');
    expect(detectValueFormat(SPARSE_HLL)).toBe('hyperloglog');
    expect(detectValueFormat(Uint8Array.of(0, 1, 2, 0xff))).toBe('binary');
  });

  it('dumps hex with offsets and ASCII', () => {
    expect(hexDump(enc('hello world\n'))).toBe(
      '00000000  68 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |hello world.|',
    );
    expect(hexDump(new Uint8Array(17), { offset: 32 }).split('\n')[1]).toMatch(/^00000030 {2}00 /);
  });
});

describe('bitmaps', () => {
  it('reads bits in GETBIT order', () => {
    const bytes = Uint8Array.of(0b1000_0001, 0b0100_0000);
    expect(bitAt(bytes, 0)).toBe(1);
    expect(bitAt(bytes, 7)).toBe(1);
    expect(bitAt(bytes, 9)).toBe(1);
    expect(bitAt(bytes, 100)).toBe(0);
    expect(bitsView(bytes, 6, 4)).toEqual([0, 1, 0, 1]);
    expect(countBits(bytes)).toBe(3);
    expect(setBitOffsets(bytes)).toEqual([0, 7, 9]);
    expect(setBitOffsets(bytes, 10, 4)).toEqual([32, 39, 41]);
  });
});

describe('HyperLogLog', () => {
  it('recognises the HYLL header', () => {
    expect(detectHyperLogLog(SPARSE_HLL)).toEqual({ encoding: 'sparse', cachedCardinality: null });
    const dense = new Uint8Array(16 + 12288);
    dense.set(enc('HYLL'));
    dense[8] = 42;
    expect(detectHyperLogLog(dense)).toEqual({ encoding: 'dense', cachedCardinality: 42 });
    expect(detectHyperLogLog(enc('HYLLnot really a hll'))).toBeUndefined();
    expect(detectHyperLogLog(enc('short'))).toBeUndefined();
  });
});

describe('geo', () => {
  it('matches GEOADD scores, GEOPOS and GEOHASH', () => {
    expect(encodeGeoScore(13.361389, 38.115556)).toBe(3479099956230698);
    expect(encodeGeoScore(15.087269, 37.502669)).toBe(3479447370796909);
    const palermo = decodeGeoScore(3479099956230698);
    expect(palermo.longitude).toBeCloseTo(13.36138933897018433, 12);
    expect(palermo.latitude).toBeCloseTo(38.11555639549629859, 12);
    expect(geohashString(palermo.longitude, palermo.latitude)).toBe('sqc8b49rny0');
    const catania = decodeGeoScore(3479447370796909);
    expect(geohashString(catania.longitude, catania.latitude)).toBe('sqdtr74hyu0');
    expect(() => encodeGeoScore(0, 89)).toThrow(RangeError);
  });
});

/** True when no object in the value has a "__proto__" key, which MessagePack maps refuse. */
function withoutProtoKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(withoutProtoKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(
      ([key, item]) => key !== '__proto__' && withoutProtoKeys(item),
    );
  }
  return true;
}
