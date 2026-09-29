import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  JsonLinesParser,
  JsonStreamParser,
  isJsonText,
  jsonText,
  parseJsonElement,
  type JsonElement,
  type SourceCell,
} from '../src';

/** Feeds text in chunks of the given sizes (cycled). */
function feed(
  parser: JsonStreamParser | JsonLinesParser,
  text: string,
  sizes: readonly number[],
): { elements: JsonElement[]; lines: number[]; errors: { line: number; message: string }[] } {
  const elements: JsonElement[] = [];
  const lines: number[] = [];
  const errors: { line: number; message: string }[] = [];
  const take = (out: ReturnType<JsonStreamParser['push']>): void => {
    elements.push(...out.elements);
    lines.push(...out.lines);
    errors.push(...out.errors);
  };
  let at = 0;
  let i = 0;
  while (at < text.length) {
    const size = Math.max(1, sizes[i++ % sizes.length] ?? 1);
    take(parser.push(text.slice(at, at + size)));
    at += size;
  }
  take(parser.end());
  return { elements, lines, errors };
}

/** Rebuilds the plain JavaScript value of a parsed cell (JsonText parsed back). */
function plain(cell: SourceCell): unknown {
  if (isJsonText(cell)) return JSON.parse(cell.$json) as unknown;
  if (typeof cell === 'bigint') return Number(cell);
  return cell;
}

function plainElement(element: JsonElement): unknown {
  switch (element.kind) {
    case 'object':
      return Object.fromEntries(element.keys.map((k, i) => [k, plain(element.values[i]!)]));
    case 'array':
      return element.values.map(plain);
    default:
      return plain(element.value);
  }
}

describe('JSON element parsing', () => {
  it('parses objects into keys and cells, keeping nested values as source text', () => {
    const element = parseJsonElement(
      '{ "id": 1, "tags": [1, "a" ], "meta": {"k": null}, "ok": true }',
    );
    expect(element).toEqual({
      kind: 'object',
      keys: ['id', 'tags', 'meta', 'ok'],
      values: [1, jsonText('[1, "a" ]'), jsonText('{"k": null}'), true],
    });
  });

  it('keeps numbers exact: bigint beyond 2^53, JsonText when a double would change the digits', () => {
    const element = parseJsonElement(
      '[9007199254740993, -12, 0.1, 1.50, 1e5, 123456789012345678901.5, -0]',
    );
    expect(element).toEqual({
      kind: 'array',
      values: [
        9007199254740993n,
        -12,
        0.1,
        jsonText('1.50'),
        jsonText('1e5'),
        jsonText('123456789012345678901.5'),
        -0,
      ],
    });
  });

  it('decodes string escapes, surrogate pairs included', () => {
    expect(parseJsonElement('"a\\"b\\\\c\\/d\\n\\t\\u00e9\\ud83d\\ude00"')).toEqual({
      kind: 'scalar',
      value: 'a"b\\c/d\n\té😀',
    });
  });

  it('keeps the last value of a duplicated key', () => {
    expect(parseJsonElement('{"a":1,"a":2}')).toEqual({ kind: 'object', keys: ['a'], values: [2] });
  });

  it('reports syntax errors with the line', () => {
    expect(() => parseJsonElement('{"a":\n  tru}', 3)).toThrow(/line 4/);
    expect(() => parseJsonElement('{"a" 1}')).toThrow(/expected ':'/);
    expect(() => parseJsonElement('[1,]')).toThrow(/Invalid JSON/);
    expect(() => parseJsonElement('"open')).toThrow(/unterminated string/);
    expect(() => parseJsonElement('{"a":[1,{]}}')).toThrow(/Invalid JSON/);
  });
});

describe('streaming JSON array', () => {
  it('yields the elements of a top-level array with their lines', () => {
    const text = '[\n  {"a": 1},\n  {"a": "x]}{"},\n  [1, 2],\n  "s",\n  null\n]\n';
    const { elements, lines } = feed(new JsonStreamParser('array'), text, [5]);
    expect(elements.map(plainElement)).toEqual([{ a: 1 }, { a: 'x]}{' }, [1, 2], 's', null]);
    expect(lines).toEqual([2, 3, 4, 5, 6]);
  });

  it('reads an empty array and tolerates a trailing comma', () => {
    expect(feed(new JsonStreamParser(), '[]', [1]).elements).toEqual([]);
    expect(feed(new JsonStreamParser(), '[1,2,]', [1]).elements).toHaveLength(2);
  });

  it('fails clearly on what is not an array, text after it and a missing bracket', () => {
    expect(() => feed(new JsonStreamParser('array'), '{"a":1}', [100])).toThrow(/top-level array/);
    expect(() => feed(new JsonStreamParser(), '[1] x', [100])).toThrow(/after the top-level array/);
    expect(() => feed(new JsonStreamParser(), '[1, 2', [100])).toThrow(/missing its closing/);
    expect(() => feed(new JsonStreamParser(), '[{"a":1', [100])).toThrow(/end of input/);
    expect(() => feed(new JsonStreamParser(), '[1 2]', [100])).toThrow(/line 1/);
  });

  it('auto mode reads a top-level object or concatenated values as a sequence', () => {
    const { elements } = feed(new JsonStreamParser('auto'), '{"a":1}\n{"a":2} {"a":3}', [3]);
    expect(elements.map(plainElement)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('gives the same elements for any chunking (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 13 }), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (values, sizes, pretty) => {
          const text = pretty ? JSON.stringify(values, null, 2) : JSON.stringify(values);
          const { elements } = feed(new JsonStreamParser('array'), text, sizes);
          // JSON.stringify drops -0's sign; compare through a JSON round trip.
          expect(JSON.parse(JSON.stringify(elements.map(plainElement)))).toEqual(JSON.parse(text));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('keeps nested JsonText identical to the source text for any chunking (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.dictionary(fc.string({ maxLength: 4 }), fc.jsonValue({ maxDepth: 3 })), {
          maxLength: 5,
        }),
        fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 4 }),
        (objects, sizes) => {
          const text = JSON.stringify(objects, null, 1);
          const whole = feed(new JsonStreamParser('array'), text, [text.length]).elements;
          expect(feed(new JsonStreamParser('array'), text, sizes).elements).toEqual(whole);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('JSON Lines', () => {
  it('parses one value per line, with CRLF, blank lines and no final newline', () => {
    const text = '{"a":1}\r\n\r\n{"a":2}\n  \n{"a":3}';
    const { elements, lines, errors } = feed(new JsonLinesParser(), text, [4]);
    expect(elements.map(plainElement)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(lines).toEqual([1, 3, 5]);
    expect(errors).toEqual([]);
  });

  it('reports a bad line and keeps going', () => {
    const { elements, errors } = feed(new JsonLinesParser(), '{"a":1}\n{"a":\n{"a":3}\n', [100]);
    expect(elements).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(2);
    expect(errors[0]!.message).toMatch(/line 2/);
  });
});
