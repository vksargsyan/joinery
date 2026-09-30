import { JoineryError } from '@joinery/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  XmlParser,
  attribute,
  decodeHexEscapes,
  decodeXmlName,
  escapeXmlAttribute,
  escapeXmlText,
  localName,
  xmlName,
  type XmlHandler,
} from '../src';

type Event =
  | readonly ['open', string, readonly string[], number]
  | readonly ['close', string]
  | readonly ['text', string];

/** Parses `chunks` and returns the events, with adjacent text merged. */
function events(chunks: readonly string[]): Event[] {
  const out: Event[] = [];
  const handler: XmlHandler = {
    open: (name, attributes, line) => out.push(['open', name, attributes, line]),
    close: (name) => out.push(['close', name]),
    text: (text) => {
      const last = out[out.length - 1];
      if (last?.[0] === 'text') out[out.length - 1] = ['text', last[1] + text];
      else out.push(['text', text]);
    },
  };
  const parser = new XmlParser(handler);
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return out;
}

function parse(text: string): Event[] {
  return events([text]);
}

/** Splits text at the given (sorted, deduplicated) cut points. */
function split(text: string, cuts: readonly number[]): string[] {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const at of points) {
    out.push(text.slice(from, at));
    from = at;
  }
  out.push(text.slice(from));
  return out;
}

describe('XmlParser', () => {
  it('reports elements, attributes, text and lines', () => {
    expect(
      parse('<?xml version="1.0"?>\n<a x="1" y=\'two\'>\n  <b/>text<c>more</c>\n</a>\n'),
    ).toEqual([
      ['open', 'a', ['x', '1', 'y', 'two'], 2],
      ['text', '\n  '],
      ['open', 'b', [], 3],
      ['close', 'b'],
      ['text', 'text'],
      ['open', 'c', [], 3],
      ['text', 'more'],
      ['close', 'c'],
      ['text', '\n'],
      ['close', 'a'],
    ]);
  });

  it('decodes entities and character references, CDATA as is, and skips comments', () => {
    expect(
      parse(
        '<r a="&lt;&amp;&quot;&apos;&#65;&#x42;">&lt;x&gt; &amp; &#8364;&#x1F600;<!-- <no> --><![CDATA[<raw> &amp;]]></r>',
      ),
    ).toEqual([
      ['open', 'r', ['a', `<&"'AB`], 1],
      ['text', '<x> & €😀<raw> &amp;'],
      ['close', 'r'],
    ]);
  });

  it('normalises line ends in text and whitespace in attribute values', () => {
    expect(parse('<r a="1\t2\r\n3" b="&#10;kept">x\r\ny\rz</r>')).toEqual([
      ['open', 'r', ['a', '1 2 3', 'b', '\nkept'], 1],
      ['text', 'x\ny\nz'],
      ['close', 'r'],
    ]);
  });

  it('skips the DOCTYPE and never expands entities it declares', () => {
    const doctype = '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY lol "lol">]>';
    expect(parse(`${doctype}<r>ok</r>`)).toEqual([
      ['open', 'r', [], 1],
      ['text', 'ok'],
      ['close', 'r'],
    ]);
    expect(() => parse(`${doctype}<r>&xxe;</r>`)).toThrow(/"&xxe;" is not defined/);
  });

  it('keeps names as written and offers local names and attribute lookup', () => {
    const [open] = parse('<x:row xmlns:x="urn:x" x:id="7"/>');
    expect(open).toEqual(['open', 'x:row', ['xmlns:x', 'urn:x', 'x:id', '7'], 1]);
    expect(localName('x:row')).toBe('row');
    expect(attribute(open![2] as string[], 'x:id')).toBe('7');
    expect(attribute(open![2] as string[], 'id')).toBeUndefined();
  });

  it.each([
    ['<a><b></a>', /line 1: expected <\/b> but found <\/a>/],
    ['<a>\n<b>\n</a>', /line 3: expected <\/b>/],
    ['<a></a><b/>', /a second root element/],
    ['<a/>text', /text outside the root/],
    ['text<a/>', /text outside the root/],
    ['<a x=1/>', /is not quoted/],
    ['<a x="1" x="2"/>', /appears twice/],
    ['<a x="<"/>', /"<" is not allowed/],
    ['<a>&unknown;</a>', /not defined/],
    ['<a>&#0;</a>', /not a valid character/],
    ['<a>&amp</a>', /not terminated/],
    ['<a>', /<a> is not closed/],
    ['<a><!-- open', /a comment is not terminated/],
    ['', /no root element/],
    ['</a>', /closes nothing/],
    ['<1a/>', /not a valid tag/],
    ['<a x="1"y="2"/>', /separated by spaces/],
  ])('rejects %j', (text, message) => {
    let error: unknown;
    try {
      parse(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JoineryError);
    expect((error as JoineryError).code).toBe('VALIDATION_FAILED');
    expect((error as Error).message).toMatch(message);
  });

  it('refuses a token longer than the limit instead of buffering it', () => {
    const parser = new XmlParser({ open() {}, close() {}, text() {} }, { maxTokenLength: 100 });
    parser.push('<r><!-- ');
    expect(() => parser.push('x'.repeat(200))).toThrow(/longer than 100 characters/);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests

interface Node {
  readonly name: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly children: readonly (Node | string)[];
}

const nameArb = fc.stringMatching(/^[A-Za-z_][\w.-]{0,6}$/);
const textArb = fc.string({ unit: 'binary', maxLength: 12 }).map((s) =>
  // Characters XML cannot carry, and CR (normalised), are not part of well-formed input.
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u{0}-\u{8}\u{B}\u{C}\u{D}\u{E}-\u{1F}\u{D800}-\u{DFFF}\u{FFFE}\u{FFFF}]/gu, ''),
);

const nodeArb: fc.Arbitrary<Node> = fc.letrec<{ node: Node }>((tie) => ({
  node: fc.record({
    name: nameArb,
    attributes: fc.uniqueArray(fc.tuple(nameArb, textArb), {
      maxLength: 3,
      selector: ([name]) => name,
    }),
    children: fc.array(fc.oneof({ depthSize: 'small' }, textArb, tie('node')), { maxLength: 4 }),
  }),
})).node;

function serialize(node: Node): string {
  const attributes = node.attributes.map(([n, v]) => ` ${n}="${escapeXmlAttribute(v)}"`).join('');
  const inner = node.children
    .map((child, i) =>
      typeof child === 'string'
        ? i % 2 === 0
          ? escapeXmlText(child)
          : `<![CDATA[${child.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
        : serialize(child),
    )
    .join('');
  return inner === ''
    ? `<${node.name}${attributes}/>`
    : `<${node.name}${attributes}>${inner}</${node.name}>`;
}

/** Events a tree should produce, with adjacent text merged and empty text left out. */
function expected(node: Node): Event[] {
  const out: Event[] = [];
  const walk = (n: Node): void => {
    out.push(['open', n.name, n.attributes.flat(), -1]);
    for (const child of n.children) {
      if (typeof child !== 'string') walk(child);
      else if (child !== '') {
        const last = out[out.length - 1];
        if (last?.[0] === 'text') out[out.length - 1] = ['text', last[1] + child];
        else out.push(['text', child]);
      }
    }
    out.push(['close', n.name]);
  };
  walk(node);
  return out;
}

const withoutLines = (list: Event[]): Event[] =>
  list.map((event) => (event[0] === 'open' ? ['open', event[1], event[2], -1] : event));

describe('XmlParser fuzz', () => {
  it('parses any well-formed document the same however it is chunked', () => {
    fc.assert(
      fc.property(nodeArb, fc.array(fc.nat(), { maxLength: 12 }), (tree, cuts) => {
        const text = `<?xml version="1.0"?>\n<!-- generated -->\n${serialize(tree)}\n`;
        const whole = parse(text);
        expect(withoutLines(whole)).toEqual(expected(tree));
        expect(events(split(text, cuts))).toEqual(whole);
      }),
      { numRuns: 300 },
    );
  });

  it('either parses or fails with a validation error on mangled input, never anything else', () => {
    const base = '<a x="1"><b>t&amp;u</b><![CDATA[c]]><!-- d --><e/></a>';
    const mangled = fc
      .array(
        fc.tuple(
          fc.nat({ max: base.length }),
          fc.nat({ max: 4 }),
          fc.constantFrom('<', '>', '&', '"', "'", '/', '!', '?', ']', '-', ' ', 'z', ';', '='),
        ),
        { minLength: 1, maxLength: 5 },
      )
      .map((edits) =>
        edits.reduce(
          (text, [at, remove, insert]) => text.slice(0, at) + insert + text.slice(at + remove),
          base,
        ),
      );
    fc.assert(
      fc.property(
        fc.oneof(mangled, fc.string({ maxLength: 40 })),
        fc.array(fc.nat(), { maxLength: 4 }),
        (text, cuts) => {
          try {
            events(split(text, cuts));
          } catch (error) {
            expect(error).toBeInstanceOf(JoineryError);
            expect((error as JoineryError).code).toBe('VALIDATION_FAILED');
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('XML escaping', () => {
  it('maps column names to XML names and back (SQL/XML)', () => {
    expect(xmlName('id')).toBe('id');
    expect(xmlName('Order No')).toBe('Order_x0020_No');
    expect(xmlName('1st')).toBe('_x0031_st');
    expect(xmlName('xmlData')).toBe('_x0078_mlData');
    expect(xmlName('a:b')).toBe('a_x003A_b');
    expect(xmlName('_x0041_')).toBe('_x005F_x0041_');
    expect(xmlName('')).toBe('_');
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 1, maxLength: 10 }), (name) => {
        const mapped = xmlName(name);
        expect(decodeXmlName(mapped)).toBe(name);
        const [open] = parse(`<${mapped}/>`);
        expect(open![1]).toBe(mapped);
      }),
      { numRuns: 300 },
    );
  });

  it('escapes text and attributes so the parser reads them back', () => {
    fc.assert(
      fc.property(textArb, textArb, (text, value) => {
        const [open, content] = parse(
          `<r a="${escapeXmlAttribute(value)}">${escapeXmlText(text)}</r>`,
        );
        expect(open![2]).toEqual(['a', value]);
        if (text !== '') expect(content).toEqual(['text', text]);
      }),
      { numRuns: 300 },
    );
    expect(escapeXmlText('a\r\nb')).toBe('a&#13;\nb');
    expect(escapeXmlText('bell\u{7}')).toBe('bell_x0007_');
    expect(escapeXmlText('_x0041_', true)).toBe('_x005F_x0041_');
    expect(decodeHexEscapes(escapeXmlText('_x0041_\u{1}', true))).toBe('_x0041_\u{1}');
  });
});
