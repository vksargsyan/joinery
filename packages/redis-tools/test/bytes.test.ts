import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  compareBytes,
  displayBytes,
  escapeGlob,
  fromHex,
  indexOfBytes,
  parseDisplayBytes,
  toBytes,
  toHex,
  tryUtf8,
} from '../src';
import { enc } from './fixtures';

describe('displayBytes / parseDisplayBytes', () => {
  it('shows valid UTF-8 as text and escapes everything else', () => {
    expect(displayBytes(enc('user:42:profile'))).toBe('user:42:profile');
    expect(displayBytes(enc('héllo ✓ 🚀'))).toBe('héllo ✓ 🚀');
    expect(displayBytes(Uint8Array.of(0x00, 0x41, 0xff, 0x0a, 0x5c))).toBe('\\x00A\\xff\\n\\\\');
    // A valid sequence next to an invalid byte keeps its text.
    expect(displayBytes(Uint8Array.of(0xc3, 0xa9, 0xc3))).toBe('é\\xc3');
    // Overlong encodings and surrogates are not valid UTF-8.
    expect(displayBytes(Uint8Array.of(0xc0, 0x80))).toBe('\\xc0\\x80');
    expect(displayBytes(Uint8Array.of(0xed, 0xa0, 0x80))).toBe('\\xed\\xa0\\x80');
    // C1 controls are escaped.
    expect(displayBytes(Uint8Array.of(0xc2, 0x85))).toBe('\\xc2\\x85');
  });

  it('parses the display form and plain text', () => {
    expect(parseDisplayBytes('\\x00A\\xff\\n\\\\')).toEqual(
      Uint8Array.of(0x00, 0x41, 0xff, 0x0a, 0x5c),
    );
    expect(parseDisplayBytes('héllo')).toEqual(enc('héllo'));
    expect(parseDisplayBytes('a\\"b')).toEqual(enc('a"b'));
    expect(parseDisplayBytes('trailing\\')).toEqual(enc('trailing\\'));
    expect(parseDisplayBytes('\\xZZ')).toEqual(enc('xZZ'));
  });

  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(parseDisplayBytes(displayBytes(bytes))).toEqual(bytes);
      }),
      { numRuns: 2000 },
    );
  });

  it('leaves plain text without backslashes or controls unchanged', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), (text) => {
        fc.pre(
          ![...text].some(
            (ch) =>
              ch === '\\' ||
              ch.charCodeAt(0) < 0x20 ||
              (ch.charCodeAt(0) >= 0x7f && ch.charCodeAt(0) <= 0x9f),
          ),
        );
        expect(displayBytes(enc(text))).toBe(text);
        expect(parseDisplayBytes(text)).toEqual(enc(text));
      }),
    );
  });
});

describe('byte helpers', () => {
  it('escapes glob metacharacters', () => {
    expect(new TextDecoder().decode(escapeGlob(enc('a*b?[c]\\d')))).toBe('a\\*b\\?\\[c\\]\\\\d');
    const plain = enc('plain');
    expect(escapeGlob(plain)).toBe(plain);
  });

  it('compares, searches and converts', () => {
    expect(compareBytes(enc('a'), enc('b'))).toBeLessThan(0);
    expect(compareBytes(enc('ab'), enc('a'))).toBeGreaterThan(0);
    expect(compareBytes(enc('a'), enc('a'))).toBe(0);
    expect(indexOfBytes(enc('a::b::c'), enc('::'), 2)).toBe(4);
    expect(indexOfBytes(enc('abc'), enc('x'))).toBe(-1);
    expect(toHex(Uint8Array.of(0, 255, 16))).toBe('00ff10');
    expect(fromHex('00 ff 10')).toEqual(Uint8Array.of(0, 255, 16));
    expect(() => fromHex('abc')).toThrow(/even/);
    expect(toBytes('é')).toEqual(Uint8Array.of(0xc3, 0xa9));
    expect(tryUtf8(Uint8Array.of(0xff))).toBeUndefined();
  });
});
