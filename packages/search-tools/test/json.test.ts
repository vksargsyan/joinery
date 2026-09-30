import { describe, expect, it } from 'vitest';

import {
  JsonSyntaxError,
  compactJson,
  formatJson,
  member,
  nodeText,
  numberAt,
  parseJsonTree,
  stringAt,
  toLooseJson,
} from '../src';

describe('parseJsonTree', () => {
  it('keeps numbers as written and offsets into the text', () => {
    const text = '{"id": 12345678901234567890, "price": 1.10, "tags": ["a", "b"], "ok": true}';
    const root = parseJsonTree(text);
    const id = member(root, 'id');
    expect(id).toMatchObject({ type: 'number', text: '12345678901234567890' });
    expect(nodeText(text, member(root, 'price')!)).toBe('1.10');
    expect(nodeText(text, member(root, 'tags')!)).toBe('["a", "b"]');
    expect(stringAt(root, 'tags', 1)).toBe('b');
    expect(numberAt(root, 'price')).toBe(1.1);
  });

  it('decodes string escapes', () => {
    const root = parseJsonTree('{"s": "a\\"b\\n\\u00e9\\\\"}');
    expect(stringAt(root, 's')).toBe('a"b\né\\');
  });

  it('reports the offset of the first error', () => {
    const cases: [string, number][] = [
      ['{"a": 1,}', 8],
      ['{"a" 1}', 5],
      ['[1, 2', 5],
      ['{"a": tru}', 6],
      ['"unterminated', 0],
      ['{"a": 1} x', 9],
      ['01', 1],
    ];
    for (const [text, offset] of cases) {
      let caught: unknown;
      try {
        parseJsonTree(text);
      } catch (error) {
        caught = error;
      }
      expect(caught, text).toBeInstanceOf(JsonSyntaxError);
      expect((caught as JsonSyntaxError).offset, text).toBe(offset);
    }
  });

  it('converts to plain values with bigints beyond the safe range', () => {
    const value = toLooseJson(parseJsonTree('{"big": 9007199254740993, "small": 42, "f": 0.5}'));
    expect(value).toEqual({ big: 9007199254740993n, small: 42, f: 0.5 });
  });

  it('refuses absurd nesting instead of overflowing the stack', () => {
    expect(() => parseJsonTree('['.repeat(10_000))).toThrow(JsonSyntaxError);
  });
});

describe('formatJson and compactJson', () => {
  const source = '{"a":1.10,"b":[1,{"c":"x\\"y"}],"d":{},"e":[],"big":123456789012345678901234}';

  it('re-indents without touching a token', () => {
    expect(formatJson(source)).toBe(
      [
        '{',
        '  "a": 1.10,',
        '  "b": [',
        '    1,',
        '    {',
        '      "c": "x\\"y"',
        '    }',
        '  ],',
        '  "d": {},',
        '  "e": [],',
        '  "big": 123456789012345678901234',
        '}',
      ].join('\n'),
    );
  });

  it('compacts formatted text back to the same tokens', () => {
    expect(compactJson(formatJson(source, { indent: 4 }))).toBe(source);
  });
});
