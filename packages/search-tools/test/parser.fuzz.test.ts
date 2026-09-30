import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  HTTP_METHODS,
  compactJson,
  completeConsole,
  formatJson,
  parseConsole,
  parseJsonTree,
  requestAt,
  type HttpMethod,
} from '../src';

/**
 * Property tests for the console parser (spec §20: fuzz the statement splitter; the console
 * buffer is Elasticsearch's). Random buffers never throw and keep their ranges ordered; random
 * requests written with comments, blank lines and any indentation parse back exactly.
 */

const RUNS = 400;

const segment = fc.stringMatching(/^[a-z0-9_.-]{1,12}$/);
const path = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => `/${parts.join('/')}`);
const query = fc.option(
  fc.stringMatching(/^[a-z_]{1,8}=[a-z0-9]{0,6}(&[a-z_]{1,8}=[a-z0-9]{0,6}){0,2}$/),
  {
    nil: undefined,
  },
);
const jsonObject = fc
  .dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 5 })
  .map((value) => JSON.stringify(value));
const comment = fc.constantFrom('', '# note', '// note', '/* note */');
const indent = fc.constantFrom('', '  ', '\t');

interface Generated {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: string | undefined;
  readonly body: string | undefined;
  readonly pretty: boolean;
  readonly before: string;
  readonly after: string;
}

const request: fc.Arbitrary<Generated> = fc.record({
  method: fc.constantFrom(...HTTP_METHODS),
  path,
  query,
  body: fc.option(jsonObject, { nil: undefined }),
  pretty: fc.boolean(),
  before: comment,
  after: indent,
});

function render(r: Generated, lowerCase: boolean): string {
  const method = lowerCase ? r.method.toLowerCase() : r.method;
  const line = `${method} ${r.path}${r.query ? `?${r.query}` : ''}`;
  const body =
    r.body === undefined
      ? ''
      : `\n${(r.pretty ? formatJson(r.body) : r.body)
          .split('\n')
          .map((l) => `${r.after}${l}`)
          .join('\n')}`;
  return `${r.before}\n${line}${body}\n`;
}

describe('parseConsole (property tests)', () => {
  it('never throws, and keeps request ranges ordered and inside the text', () => {
    const noise = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc
        .array(
          fc.oneof(
            fc.constantFrom(
              'GET ',
              'POST /x\n',
              '{',
              '}',
              '[',
              ']',
              '"',
              '"""',
              '\n',
              '#',
              '//',
              '/*',
              '*/',
              ':',
              ',',
            ),
            fc.string({ maxLength: 5 }),
          ),
          { maxLength: 60 },
        )
        .map((parts) => parts.join('')),
    );
    fc.assert(
      fc.property(noise, (text) => {
        const parse = parseConsole(text);
        let previous = -1;
        for (const r of parse.requests) {
          expect(r.start).toBeGreaterThan(previous);
          expect(r.end).toBeGreaterThanOrEqual(r.urlEnd);
          expect(r.end).toBeLessThanOrEqual(text.length);
          previous = r.start;
          if (r.body !== undefined) expect(r.invalid).toBe(false);
        }
        for (const issue of parse.issues) {
          expect(issue.start).toBeGreaterThanOrEqual(0);
          expect(issue.start).toBeLessThanOrEqual(text.length);
        }
        // Completion never throws either, wherever the cursor is.
        completeConsole(text, Math.floor(text.length / 2));
        completeConsole(text, text.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('parses generated requests back exactly', () => {
    fc.assert(
      fc.property(
        fc.array(request, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        (requests, lowerCase) => {
          const text = requests.map((r) => render(r, lowerCase)).join('\n');
          const parse = parseConsole(text);
          expect(parse.issues).toEqual([]);
          expect(parse.requests).toHaveLength(requests.length);
          parse.requests.forEach((parsed, i) => {
            const expected = requests[i]!;
            expect(parsed.method).toBe(expected.method);
            expect(parsed.path).toBe(expected.path);
            expect(parsed.query).toBe(expected.query ?? '');
            if (expected.body === undefined) {
              expect(parsed.body).toBeUndefined();
            } else if (parsed.bodyKind === 'ndjson') {
              expect(parsed.body).toBe(`${compactJson(expected.body)}\n`);
            } else {
              expect(compactJson(parsed.body!)).toBe(compactJson(expected.body));
            }
            expect(requestAt(parse.requests, parsed.start)).toBe(parsed);
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('keeps every number token of a body as typed', () => {
    const number = fc.oneof(
      fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).map(String),
      fc
        .double({ noNaN: true, noDefaultInfinity: true })
        .map((n) => `${n}`.replace('Infinity', '1')),
      fc.constantFrom('1.10', '0.0', '1e3', '-0', '12345678901234567890'),
    );
    fc.assert(
      fc.property(fc.array(number, { minLength: 1, maxLength: 6 }), (numbers) => {
        const body = `{"values": [${numbers.join(', ')}]}`;
        const parse = parseConsole(`POST /n/_doc\n${body}\n`);
        const sent = parse.requests[0]!.body!;
        const node = parseJsonTree(sent);
        const values = node.type === 'object' ? node.members[0]!.value : undefined;
        expect(
          values?.type === 'array' ? values.items.map((v) => sent.slice(v.start, v.end)) : [],
        ).toEqual(numbers);
      }),
      { numRuns: RUNS },
    );
  });
});
