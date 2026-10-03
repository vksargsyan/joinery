import { QuerybaraError } from '@querybara/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { quoteRepr, splitArgs, splitCommands, tokenizeLine } from '../src';
import { enc } from './fixtures';

const text = (args: Uint8Array[]): string[] => args.map((a) => new TextDecoder().decode(a));

describe('splitArgs (redis-cli sdssplitargs)', () => {
  it.each([
    ['set key "hello world"', ['set', 'key', 'hello world']],
    ["set key 'it\\'s'", ['set', 'key', "it's"]],
    ['  get   key  ', ['get', 'key']],
    ['a\tb\r\nc', ['a', 'b', 'c']],
    ['"\\x41\\x42"', ['AB']],
    ['"\\x4"', ['x4']],
    ['"a\\nb\\tc\\"d\\\\e\\qf"', ['a\nb\tc"d\\eqf']],
    ["'a\\nb'", ['a\\nb']],
    ['foo"bar baz"', ['foobar baz']],
    ["x'y'", ['xy']],
    ['\'\' ""', ['', '']],
    ['"é 🚀"', ['é 🚀']],
    ['', []],
    ['a\u000bb', ['a\u000bb']],
  ])('%j', (line, expected) => {
    expect(text(splitArgs(line))).toEqual(expected);
  });

  it('keeps raw bytes from \\x escapes', () => {
    expect(splitArgs('"\\x00\\xff\\xC3\\xa9"')[0]).toEqual(Uint8Array.of(0, 0xff, 0xc3, 0xa9));
  });

  it.each([
    ['"foo"bar', 5],
    ["'foo'bar", 5],
    ['get "unterminated', 17],
    ["get 'unterminated", 17],
  ])('rejects %j', (line, position) => {
    let caught: unknown;
    try {
      splitArgs(line);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuerybaraError);
    expect((caught as QuerybaraError).code).toBe('VALIDATION_FAILED');
    expect((caught as QuerybaraError).message).toMatch(/^Invalid argument\(s\)/);
    expect((caught as QuerybaraError).position).toBe(position);
  });
});

describe('tokenizeLine', () => {
  it('reports positions and a partial last token while typing', () => {
    const result = tokenizeLine('set "my key');
    expect(result.unterminated).toBe(true);
    expect(result.tokens.map((t) => [t.text, t.start, t.end, t.quoted])).toEqual([
      ['set', 0, 3, false],
      ['my key', 4, 11, true],
    ]);
  });

  it('marks tokens that start a new line', () => {
    const result = tokenizeLine('set a "x\ny"\nget a');
    expect(result.tokens.map((t) => [t.text, t.lineStart])).toEqual([
      ['set', false],
      ['a', false],
      ['x\ny', false],
      ['get', true],
      ['a', false],
    ]);
  });

  it('never throws and keeps token offsets in order', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (line) => {
        const result = tokenizeLine(line);
        let previous = 0;
        for (const t of result.tokens) {
          expect(t.start).toBeGreaterThanOrEqual(previous);
          expect(t.end).toBeGreaterThanOrEqual(t.start);
          expect(t.end).toBeLessThanOrEqual(line.length);
          previous = t.end;
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('round-trips any arguments quoted the way redis-cli prints them', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 24 }), { maxLength: 8 }), (args) => {
        const line = args.map((a) => quoteRepr(a)).join(' ');
        expect(splitArgs(line)).toEqual(args);
      }),
      { numRuns: 2000 },
    );
  });

  it('splits unquoted words on whitespace like String.split', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-zA-Z0-9:_.*-]{1,12}$/), { maxLength: 8 }),
        fc.constantFrom(' ', '  ', '\t', ' \t '),
        (words, sep) => {
          expect(text(splitArgs(words.join(sep)))).toEqual(words);
        },
      ),
    );
  });
});

describe('splitCommands', () => {
  it('splits commands on unquoted line breaks and skips blank lines', () => {
    const commands = splitCommands('set a 1\nget a\n\n  del "x\ny"  \r\n');
    expect(commands.map(text)).toEqual([
      ['set', 'a', '1'],
      ['get', 'a'],
      ['del', 'x\ny'],
    ]);
    expect(splitCommands('')).toEqual([]);
    expect(splitCommands('ping')[0]).toEqual([enc('ping')]);
  });
});
