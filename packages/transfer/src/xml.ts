import { JoineryError } from '@joinery/core';

/**
 * A streaming, SAX-style XML parser (spec §12: XML import, and the parts of an xlsx workbook).
 * Text is pushed in chunks split anywhere; the handler hears element starts (with their
 * attributes), ends and character data as they complete, so memory holds one markup token,
 * never the document.
 *
 * It checks well-formedness (one root, matching end tags, quoted and unique attributes, known
 * entities) and reports errors with their line. For safety it never expands entities a DTD
 * declares and never fetches anything: the DOCTYPE is skipped, and a reference to an entity
 * other than the five predefined ones and character references is an error. Line ends are
 * normalised to LF and attribute values have their whitespace normalised, as XML 1.0 says.
 * Namespaces are not resolved: names are reported as written (`x:row`).
 */

export interface XmlHandler {
  /** An element starts. `attributes` alternates names and values: [name0, value0, name1...]. */
  open(name: string, attributes: string[], line: number): void;
  /** An element ends; `<empty/>` closes right after it opens. */
  close(name: string): void;
  /** Character data, entities decoded (CDATA as is). One text node may arrive in pieces. */
  text(text: string): void;
}

export interface XmlParserOptions {
  /** Longest markup token (a tag, comment, CDATA section...) in characters (default 64 Mi). */
  readonly maxTokenLength?: number;
}

/** The value of attribute `name` in an `open` attribute list. */
export function attribute(attributes: readonly string[], name: string): string | undefined {
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1];
  }
  return undefined;
}

/** A name without its namespace prefix. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

const LT = 60;
const GT = 62;
const SLASH = 47;
const QUESTION = 63;
const BANG = 33;
const EQUALS = 61;
const DQUOTE = 34;
const SQUOTE = 39;

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 9 || c === 13;
}

/** Characters that end a name. */
function endsName(c: number): boolean {
  return isSpace(c) || c === SLASH || c === GT || c === EQUALS || Number.isNaN(c);
}

function validCodePoint(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

class LocalError extends Error {}

/** Decodes entity and character references in `text`. */
function decodeReferences(text: string): string {
  let out = '';
  let from = 0;
  for (let amp = text.indexOf('&'); amp >= 0; amp = text.indexOf('&', from)) {
    const semi = text.indexOf(';', amp);
    if (semi < 0) throw new LocalError('an entity reference is not terminated by ";"');
    out += text.slice(from, amp);
    const name = text.slice(amp + 1, semi);
    if (name.startsWith('#')) {
      const code = /^#x[0-9a-fA-F]+$/.test(name)
        ? Number.parseInt(name.slice(2), 16)
        : /^#[0-9]+$/.test(name)
          ? Number.parseInt(name.slice(1), 10)
          : Number.NaN;
      if (!validCodePoint(code)) throw new LocalError(`"&${name};" is not a valid character`);
      out += String.fromCodePoint(code);
    } else {
      const value = PREDEFINED[name];
      if (value === undefined) {
        throw new LocalError(`the entity "&${name};" is not defined (DTD entities are not read)`);
      }
      out += value;
    }
    from = semi + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** Text as XML sees it: line ends normalised to LF, references decoded. */
function decodeText(raw: string): string {
  const text = raw.indexOf('\r') >= 0 ? raw.replace(/\r\n?/g, '\n') : raw;
  return text.indexOf('&') >= 0 ? decodeReferences(text) : text;
}

/** An attribute value: whitespace characters become spaces, then references are decoded. */
function decodeAttribute(raw: string): string {
  let special = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === LT) throw new LocalError('"<" is not allowed in an attribute value');
    if (c === 38 || c === 9 || c === 10 || c === 13) special = true;
  }
  if (!special) return raw;
  const spaced = raw.replace(/\r\n|[\t\n\r]/g, ' ');
  return spaced.indexOf('&') >= 0 ? decodeReferences(spaced) : spaced;
}

/** Incremental XML parser; see the module comment. */
export class XmlParser {
  readonly #handler: XmlHandler;
  readonly #maxToken: number;
  #buf = '';
  #pos = 0;
  #line = 1;
  /** Index of the next LF at or after `#pos` in `#buf`: -1 none, -2 not looked for yet. */
  #newline = -2;
  readonly #stack: string[] = [];
  #rootSeen = false;
  #ended = false;
  #start = true;

  constructor(handler: XmlHandler, options: XmlParserOptions = {}) {
    this.#handler = handler;
    this.#maxToken = options.maxTokenLength ?? 64 * 1024 * 1024;
  }

  /** Line of the parser's position (1-based). */
  get line(): number {
    return this.#line;
  }

  /** Elements open now. */
  get depth(): number {
    return this.#stack.length;
  }

  push(chunk: string): void {
    if (this.#ended) throw new Error('XmlParser.push() called after end()');
    this.#buf = this.#pos < this.#buf.length ? this.#buf.slice(this.#pos) + chunk : chunk;
    this.#pos = 0;
    this.#newline = -2;
    this.#run(false);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#run(true);
    if (this.#stack.length > 0) {
      throw this.#error(`the element <${this.#stack[this.#stack.length - 1]!}> is not closed`);
    }
    if (!this.#rootSeen) throw this.#error('there is no root element');
  }

  #error(message: string): JoineryError {
    return new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `Invalid XML on line ${this.#line}: ${message}`,
    });
  }

  /** Advances to `to`, counting the line breaks passed. */
  #advance(to: number): void {
    const buf = this.#buf;
    if (this.#newline === -2) this.#newline = buf.indexOf('\n', this.#pos);
    while (this.#newline >= 0 && this.#newline < to) {
      this.#line++;
      this.#newline = buf.indexOf('\n', this.#newline + 1);
    }
    this.#pos = to;
  }

  #text(raw: string): void {
    if (raw.length === 0) return;
    if (this.#stack.length === 0) {
      const rest = this.#start ? raw.replace(/^\ufeff/, '') : raw;
      if (/[^ \t\r\n]/.test(rest)) throw this.#error('text outside the root element');
      return;
    }
    try {
      this.#handler.text(decodeText(raw));
    } catch (error) {
      if (error instanceof LocalError) throw this.#error(error.message);
      throw error;
    }
  }

  /** Waits for more input, unless the token is already too long or the input has ended. */
  #incomplete(from: number, what: string): boolean {
    if (this.#ended) throw this.#error(`${what} is not terminated`);
    if (this.#buf.length - from > this.#maxToken) {
      throw this.#error(`${what} is longer than ${this.#maxToken} characters`);
    }
    return true;
  }

  #run(final: boolean): void {
    const buf = this.#buf;
    while (this.#pos < buf.length) {
      const pos = this.#pos;
      const lt = buf.indexOf('<', pos);
      if (lt !== pos) {
        let end = lt < 0 ? buf.length : lt;
        if (lt < 0 && !final) {
          // Hold back a reference or a CR that the next chunk may complete.
          const amp = buf.lastIndexOf('&');
          if (amp >= pos && buf.indexOf(';', amp) < 0) end = amp;
          if (end > pos && buf.charCodeAt(end - 1) === 13) end--;
          if (end - pos === 0 && buf.length - pos > this.#maxToken) {
            throw this.#error('an entity reference is not terminated by ";"');
          }
        }
        this.#text(buf.slice(pos, end));
        this.#advance(end);
        if (lt < 0) return;
        continue;
      }
      this.#start = false;
      const next = buf.charCodeAt(lt + 1);
      if (Number.isNaN(next)) {
        if (this.#incomplete(lt, 'a tag')) return;
      }
      if (next === SLASH) {
        const gt = buf.indexOf('>', lt + 2);
        if (gt < 0) {
          if (this.#incomplete(lt, 'an end tag')) return;
        }
        let name = buf.slice(lt + 2, gt);
        if (isSpace(name.charCodeAt(name.length - 1))) name = name.trimEnd();
        const open = this.#stack.pop();
        if (open === undefined) throw this.#error(`</${name}> closes nothing`);
        if (open !== name) throw this.#error(`expected </${open}> but found </${name}>`);
        this.#advance(gt + 1);
        this.#handler.close(name);
        continue;
      }
      if (next === QUESTION) {
        const end = buf.indexOf('?>', lt + 2);
        if (end < 0) {
          if (this.#incomplete(lt, 'a processing instruction')) return;
        }
        this.#advance(end + 2);
        continue;
      }
      if (next === BANG) {
        if (buf.length - lt < 9 && !final) {
          if (this.#incomplete(lt, 'markup')) return;
        }
        if (buf.startsWith('<!--', lt)) {
          const end = buf.indexOf('-->', lt + 4);
          if (end < 0) {
            if (this.#incomplete(lt, 'a comment')) return;
          }
          this.#advance(end + 3);
          continue;
        }
        if (buf.startsWith('<![CDATA[', lt)) {
          const end = buf.indexOf(']]>', lt + 9);
          if (end < 0) {
            if (this.#incomplete(lt, 'a CDATA section')) return;
          }
          if (this.#stack.length === 0) throw this.#error('CDATA outside the root element');
          const raw = buf.slice(lt + 9, end);
          if (raw !== '') {
            this.#handler.text(raw.indexOf('\r') >= 0 ? raw.replace(/\r\n?/g, '\n') : raw);
          }
          this.#advance(end + 3);
          continue;
        }
        if (buf.startsWith('<!DOCTYPE', lt)) {
          if (this.#rootSeen) throw this.#error('a DOCTYPE after the root element');
          const end = this.#doctypeEnd(lt + 9);
          if (end < 0) {
            if (this.#incomplete(lt, 'the DOCTYPE')) return;
          }
          this.#advance(end + 1);
          continue;
        }
        throw this.#error('unexpected "<!"');
      }
      if (!this.#startTag(lt) && this.#incomplete(lt, 'a tag')) return;
    }
  }

  /** The `>` that ends a DOCTYPE, skipping its internal subset and quoted strings. */
  #doctypeEnd(from: number): number {
    const buf = this.#buf;
    let quote = 0;
    let bracket = 0;
    for (let i = from; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === DQUOTE || c === SQUOTE) quote = c;
      else if (c === 91) bracket++;
      else if (c === 93) bracket--;
      else if (c === GT && bracket <= 0) return i;
    }
    return -1;
  }

  /**
   * Parses a start tag in one pass: its name, its attributes, `>` or `/>`. Returns false when
   * the buffer ends inside it (the caller waits for more); malformed markup throws.
   */
  #startTag(lt: number): boolean {
    const buf = this.#buf;
    const length = buf.length;
    let i = lt + 1;
    while (i < length && !endsName(buf.charCodeAt(i))) i++;
    if (i >= length) return false;
    const name = buf.slice(lt + 1, i);
    const first = name.charCodeAt(0);
    if (name === '' || (first >= 48 && first <= 57) || first === 46 || first === 45) {
      throw this.#error(`"<${name}" is not a valid tag`);
    }
    const attributes: string[] = [];
    let selfClosing = false;
    for (;;) {
      while (i < length && isSpace(buf.charCodeAt(i))) i++;
      if (i >= length) return false;
      const c = buf.charCodeAt(i);
      if (c === GT) {
        i++;
        break;
      }
      if (c === SLASH) {
        if (i + 1 >= length) return false;
        if (buf.charCodeAt(i + 1) !== GT) throw this.#error(`<${name}>: unexpected "/"`);
        selfClosing = true;
        i += 2;
        break;
      }
      if (c === LT) throw this.#error('"<" inside a tag');
      const nameStart = i;
      while (i < length && !endsName(buf.charCodeAt(i))) i++;
      const attrName = buf.slice(nameStart, i);
      while (i < length && isSpace(buf.charCodeAt(i))) i++;
      if (i >= length) return false;
      if (attrName === '') throw this.#error(`<${name}>: unexpected "${buf[i] ?? ''}"`);
      if (buf.charCodeAt(i) !== EQUALS) {
        throw this.#error(`<${name}>: attribute "${attrName}" has no value`);
      }
      i++;
      while (i < length && isSpace(buf.charCodeAt(i))) i++;
      if (i >= length) return false;
      const quote = buf.charCodeAt(i);
      if (quote !== DQUOTE && quote !== SQUOTE) {
        throw this.#error(`<${name}>: the value of "${attrName}" is not quoted`);
      }
      const close = buf.indexOf(quote === DQUOTE ? '"' : "'", i + 1);
      if (close < 0) return false;
      let value: string;
      try {
        value = decodeAttribute(buf.slice(i + 1, close));
      } catch (error) {
        if (error instanceof LocalError) throw this.#error(`<${name}>: ${error.message}`);
        throw error;
      }
      for (let a = 0; a < attributes.length; a += 2) {
        if (attributes[a] === attrName) {
          throw this.#error(`<${name}>: attribute "${attrName}" appears twice`);
        }
      }
      attributes.push(attrName, value);
      i = close + 1;
      if (i >= length) return false;
      const after = buf.charCodeAt(i);
      if (!isSpace(after) && after !== SLASH && after !== GT) {
        throw this.#error(`<${name}>: attributes must be separated by spaces`);
      }
    }
    if (this.#stack.length === 0) {
      if (this.#rootSeen) throw this.#error('a second root element');
      this.#rootSeen = true;
    }
    const line = this.#line;
    this.#advance(i);
    this.#handler.open(name, attributes, line);
    if (selfClosing) this.#handler.close(name);
    else this.#stack.push(name);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Characters XML 1.0 cannot hold, even as references. */
const INVALID_XML =
  // eslint-disable-next-line no-control-regex
  /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{FFFE}\u{FFFF}\u{D800}-\u{DFFF}]/gu;

function hexEscape(char: string): string {
  return `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`;
}

/** Decodes `_xHHHH_` escapes (OOXML strings, SQL/XML names). */
export function decodeHexEscapes(text: string): string {
  if (text.indexOf('_x') < 0) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Text as XML character data: `&`, `<`, `>` escaped, CR kept as `&#13;`, and characters XML
 * 1.0 cannot hold written as `_xHHHH_`. With `escapeUnderscores` (OOXML strings) a literal
 * `_xHHHH_` is written `_x005F_xHHHH_`, so decoding gives the text back exactly.
 */
export function escapeXmlText(text: string, escapeUnderscores = false): string {
  let out = text;
  if (escapeUnderscores && out.indexOf('_x') >= 0) {
    out = out.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_');
  }
  INVALID_XML.lastIndex = 0;
  if (INVALID_XML.test(out)) {
    INVALID_XML.lastIndex = 0;
    out = out.replace(INVALID_XML, hexEscape);
  }
  if (!/[&<>\r]/.test(out)) return out;
  return out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/** Text as a double-quoted attribute value. */
export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}

const NAME_START =
  /[A-Z_a-z\u{C0}-\u{D6}\u{D8}-\u{F6}\u{F8}-\u{2FF}\u{370}-\u{37D}\u{37F}-\u{1FFF}\u{200C}-\u{200D}\u{2070}-\u{218F}\u{2C00}-\u{2FEF}\u{3001}-\u{D7FF}\u{F900}-\u{FDCF}\u{FDF0}-\u{FFFD}\u{10000}-\u{EFFFF}]/u;
const NAME_CHAR =
  /[-.0-9A-Z_a-z\u{B7}\u{C0}-\u{D6}\u{D8}-\u{F6}\u{F8}-\u{37D}\u{37F}-\u{1FFF}\u{200C}-\u{200D}\u{203F}-\u{2040}\u{2070}-\u{218F}\u{2C00}-\u{2FEF}\u{3001}-\u{D7FF}\u{F900}-\u{FDCF}\u{FDF0}-\u{FFFD}\u{10000}-\u{EFFFF}]/u;

/**
 * An XML element name for a column name, by the SQL/XML identifier mapping (as SQL Server's
 * FOR XML writes it): characters a name cannot hold, the `x` of a leading `xml` and the `_` of
 * a literal `_xHHHH_` become `_xHHHH_` (`_xHHHHHH_` beyond the BMP), so `decodeXmlName` gives
 * the column name back.
 */
export function xmlName(name: string): string {
  if (name === '') return '_';
  const chars = [...name];
  let out = '';
  chars.forEach((char, i) => {
    if (
      char === '_' &&
      /^x(?:[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6})_/.test(chars.slice(i + 1, i + 9).join(''))
    ) {
      out += '_x005F_';
    } else if ((i === 0 ? NAME_START : NAME_CHAR).test(char) && !(i === 0 && /^xml/i.test(name))) {
      out += char;
    } else {
      const code = char.codePointAt(0)!;
      out += `_x${code
        .toString(16)
        .toUpperCase()
        .padStart(code > 0xffff ? 6 : 4, '0')}_`;
    }
  });
  return out;
}

/** A column name from an XML name: SQL/XML `_xHHHH_` and `_xHHHHHH_` escapes decoded. */
export function decodeXmlName(name: string): string {
  if (name.indexOf('_x') < 0) return name;
  return name.replace(/_x([0-9A-Fa-f]{6}|[0-9A-Fa-f]{4})_/g, (match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code > 0x10ffff ? match : String.fromCodePoint(code);
  });
}
