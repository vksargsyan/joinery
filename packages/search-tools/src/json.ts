/**
 * Lossless JSON (ADR 0010). Elasticsearch documents and responses cross processes as JSON text,
 * so a 64-bit integer or a number written as `1.10` reaches the page and the console exactly as
 * the server sent it. This module reads that text without converting numbers: `parseJsonTree`
 * returns nodes that keep their source offsets (a hit's `_source` is a slice of the response),
 * and the formatters re-indent or compact the text token by token.
 */

export type JsonNode =
  | {
      readonly type: 'object';
      readonly start: number;
      readonly end: number;
      readonly members: readonly JsonMember[];
    }
  | {
      readonly type: 'array';
      readonly start: number;
      readonly end: number;
      readonly items: readonly JsonNode[];
    }
  | {
      readonly type: 'string';
      readonly start: number;
      readonly end: number;
      readonly value: string;
    }
  | {
      readonly type: 'number';
      readonly start: number;
      readonly end: number;
      /** The number as written, e.g. "12345678901234567890" or "1.10". */
      readonly text: string;
    }
  | {
      readonly type: 'boolean';
      readonly start: number;
      readonly end: number;
      readonly value: boolean;
    }
  | { readonly type: 'null'; readonly start: number; readonly end: number };

export interface JsonMember {
  readonly key: string;
  /** Offset of the key's opening quote. */
  readonly keyStart: number;
  readonly value: JsonNode;
}

/** A JSON syntax error at a 0-based UTF-16 offset of the text. */
export class JsonSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'JsonSyntaxError';
    this.offset = offset;
  }
}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 512;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

/** Skips JSON whitespace from `pos`; returns the next offset. */
function skipSpace(text: string, pos: number): number {
  while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
  return pos;
}

/**
 * Reads a JSON string literal starting at the quote at `pos`: its value and the offset after the
 * closing quote.
 */
export function readJsonString(text: string, pos: number): { value: string; end: number } {
  let i = pos + 1;
  let value = '';
  let run = i;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x22) {
      value += text.slice(run, i);
      return { value, end: i + 1 };
    }
    if (code === 0x5c) {
      value += text.slice(run, i);
      const next = text[i + 1];
      switch (next) {
        case '"':
        case '\\':
        case '/':
          value += next;
          i += 2;
          break;
        case 'b':
          value += '\b';
          i += 2;
          break;
        case 'f':
          value += '\f';
          i += 2;
          break;
        case 'n':
          value += '\n';
          i += 2;
          break;
        case 'r':
          value += '\r';
          i += 2;
          break;
        case 't':
          value += '\t';
          i += 2;
          break;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new JsonSyntaxError('Invalid \\u escape in a string', i);
          }
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          throw new JsonSyntaxError('Invalid escape in a string', i);
      }
      run = i;
      continue;
    }
    if (code < 0x20) throw new JsonSyntaxError('Unescaped control character in a string', i);
    i++;
  }
  throw new JsonSyntaxError('Unterminated string', pos);
}

/**
 * Parses JSON text into nodes that keep their offsets and the exact text of every number.
 * Throws JsonSyntaxError at the first error. Trailing text after the value is an error.
 */
export function parseJsonTree(text: string): JsonNode {
  const { node, end } = parseJsonValueAt(text, skipSpace(text, 0));
  const rest = skipSpace(text, end);
  if (rest < text.length) throw new JsonSyntaxError('Unexpected text after the JSON value', rest);
  return node;
}

/** Parses one JSON value starting at `pos` (no leading whitespace); returns it and its end. */
export function parseJsonValueAt(text: string, pos: number): { node: JsonNode; end: number } {
  const node = parseValue(text, pos, 0);
  return { node, end: node.end };
}

function parseValue(text: string, pos: number, depth: number): JsonNode {
  if (depth > MAX_DEPTH) throw new JsonSyntaxError('JSON nested too deeply', pos);
  const char = text[pos];
  switch (char) {
    case '{':
      return parseObject(text, pos, depth);
    case '[':
      return parseArray(text, pos, depth);
    case '"': {
      const { value, end } = readJsonString(text, pos);
      return { type: 'string', start: pos, end, value };
    }
    case 't':
      if (text.startsWith('true', pos))
        return { type: 'boolean', start: pos, end: pos + 4, value: true };
      break;
    case 'f':
      if (text.startsWith('false', pos)) {
        return { type: 'boolean', start: pos, end: pos + 5, value: false };
      }
      break;
    case 'n':
      if (text.startsWith('null', pos)) return { type: 'null', start: pos, end: pos + 4 };
      break;
    case undefined:
      throw new JsonSyntaxError('Unexpected end of JSON', pos);
    default: {
      NUMBER_RE.lastIndex = pos;
      const match = NUMBER_RE.exec(text);
      if (match) {
        return { type: 'number', start: pos, end: pos + match[0].length, text: match[0] };
      }
    }
  }
  throw new JsonSyntaxError(`Unexpected character ${JSON.stringify(char)}`, pos);
}

function parseObject(text: string, start: number, depth: number): JsonNode {
  const members: JsonMember[] = [];
  let pos = skipSpace(text, start + 1);
  if (text[pos] === '}') return { type: 'object', start, end: pos + 1, members };
  for (;;) {
    if (text[pos] !== '"') {
      throw new JsonSyntaxError(
        pos >= text.length ? 'Unterminated object' : 'Expected a quoted property name',
        pos,
      );
    }
    const key = readJsonString(text, pos);
    const keyStart = pos;
    pos = skipSpace(text, key.end);
    if (text[pos] !== ':') throw new JsonSyntaxError('Expected ":" after the property name', pos);
    pos = skipSpace(text, pos + 1);
    const value = parseValue(text, pos, depth + 1);
    members.push({ key: key.value, keyStart, value });
    pos = skipSpace(text, value.end);
    if (text[pos] === ',') {
      pos = skipSpace(text, pos + 1);
      continue;
    }
    if (text[pos] === '}') return { type: 'object', start, end: pos + 1, members };
    throw new JsonSyntaxError(
      pos >= text.length ? 'Unterminated object' : 'Expected "," or "}"',
      pos,
    );
  }
}

function parseArray(text: string, start: number, depth: number): JsonNode {
  const items: JsonNode[] = [];
  let pos = skipSpace(text, start + 1);
  if (text[pos] === ']') return { type: 'array', start, end: pos + 1, items };
  for (;;) {
    const item = parseValue(text, pos, depth + 1);
    items.push(item);
    pos = skipSpace(text, item.end);
    if (text[pos] === ',') {
      pos = skipSpace(text, pos + 1);
      continue;
    }
    if (text[pos] === ']') return { type: 'array', start, end: pos + 1, items };
    throw new JsonSyntaxError(
      pos >= text.length ? 'Unterminated array' : 'Expected "," or "]"',
      pos,
    );
  }
}

/** The source text of a node. */
export function nodeText(text: string, node: JsonNode): string {
  return text.slice(node.start, node.end);
}

/** The value of an object member, if the node is an object that has it (the last one wins). */
export function member(node: JsonNode | undefined, key: string): JsonNode | undefined {
  if (node?.type !== 'object') return undefined;
  for (let i = node.members.length - 1; i >= 0; i--) {
    if (node.members[i]!.key === key) return node.members[i]!.value;
  }
  return undefined;
}

/** The node at a path of member keys and array indexes, if there is one. */
export function nodeAt(
  node: JsonNode | undefined,
  path: readonly (string | number)[],
): JsonNode | undefined {
  let current = node;
  for (const step of path) {
    if (current === undefined) return undefined;
    current =
      typeof step === 'number'
        ? current.type === 'array'
          ? current.items[step]
          : undefined
        : member(current, step);
  }
  return current;
}

/** A string member's value, or undefined. */
export function stringAt(
  node: JsonNode | undefined,
  ...path: (string | number)[]
): string | undefined {
  const found = nodeAt(node, path);
  return found?.type === 'string' ? found.value : undefined;
}

/**
 * A number member as a JS number (for counts and sizes, where an approximation of a huge value
 * is fine), or undefined. Numeric strings count too: the _cat APIs send numbers as strings.
 */
export function numberAt(
  node: JsonNode | undefined,
  ...path: (string | number)[]
): number | undefined {
  const found = nodeAt(node, path);
  if (found?.type === 'number') return Number(found.text);
  if (found?.type === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(found.value.trim())) {
    return Number(found.value);
  }
  return undefined;
}

/** A boolean member, or undefined. */
export function booleanAt(
  node: JsonNode | undefined,
  ...path: (string | number)[]
): boolean | undefined {
  const found = nodeAt(node, path);
  if (found?.type === 'boolean') return found.value;
  if (found?.type === 'string' && (found.value === 'true' || found.value === 'false')) {
    return found.value === 'true';
  }
  return undefined;
}

/**
 * A JSON value without the risk of losing digits: integers outside the safe range become
 * bigint, other numbers stay numbers. For reading small structured replies; documents stay text.
 */
export type LooseJson =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly LooseJson[]
  | { readonly [key: string]: LooseJson };

/** Converts a node to a plain value (see LooseJson). Duplicate keys: the last one wins. */
export function toLooseJson(node: JsonNode): LooseJson {
  switch (node.type) {
    case 'object': {
      const out: Record<string, LooseJson> = Object.create(null) as Record<string, LooseJson>;
      for (const m of node.members) out[m.key] = toLooseJson(m.value);
      return out;
    }
    case 'array':
      return node.items.map(toLooseJson);
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'number': {
      if (/^-?\d+$/.test(node.text)) {
        const value = Number(node.text);
        return Number.isSafeInteger(value) ? value : BigInt(node.text);
      }
      return Number(node.text);
    }
  }
}

export interface FormatJsonOptions {
  /** Spaces per level; default 2. */
  readonly indent?: number;
}

/**
 * Re-indents JSON text (Kibana's "auto indent") without touching any token: numbers, strings
 * and escapes are copied as written. Throws JsonSyntaxError for invalid JSON.
 */
export function formatJson(text: string, options: FormatJsonOptions = {}): string {
  const node = parseJsonTree(text);
  const unit = ' '.repeat(options.indent ?? 2);
  const parts: string[] = [];
  const write = (value: JsonNode, level: number): void => {
    const pad = unit.repeat(level + 1);
    if (value.type === 'object') {
      if (value.members.length === 0) {
        parts.push('{}');
        return;
      }
      parts.push('{\n');
      value.members.forEach((m, i) => {
        parts.push(pad, text.slice(m.keyStart, keyEnd(text, m)), ': ');
        write(m.value, level + 1);
        parts.push(i < value.members.length - 1 ? ',\n' : '\n');
      });
      parts.push(unit.repeat(level), '}');
    } else if (value.type === 'array') {
      if (value.items.length === 0) {
        parts.push('[]');
        return;
      }
      parts.push('[\n');
      value.items.forEach((item, i) => {
        parts.push(pad);
        write(item, level + 1);
        parts.push(i < value.items.length - 1 ? ',\n' : '\n');
      });
      parts.push(unit.repeat(level), ']');
    } else {
      parts.push(text.slice(value.start, value.end));
    }
  };
  write(node, 0);
  return parts.join('');
}

/** Removes insignificant whitespace (for an NDJSON line). Tokens are copied as written. */
export function compactJson(text: string): string {
  const node = parseJsonTree(text);
  const parts: string[] = [];
  const write = (value: JsonNode): void => {
    if (value.type === 'object') {
      parts.push('{');
      value.members.forEach((m, i) => {
        if (i > 0) parts.push(',');
        parts.push(text.slice(m.keyStart, keyEnd(text, m)), ':');
        write(m.value);
      });
      parts.push('}');
    } else if (value.type === 'array') {
      parts.push('[');
      value.items.forEach((item, i) => {
        if (i > 0) parts.push(',');
        write(item);
      });
      parts.push(']');
    } else {
      parts.push(text.slice(value.start, value.end));
    }
  };
  write(node);
  return parts.join('');
}

/**
 * JSON on one line, a space after each colon and comma (`{"term": {"a": 1}}`), for a query bar.
 * Tokens are copied as written.
 */
export function inlineJson(text: string): string {
  const node = parseJsonTree(text);
  const parts: string[] = [];
  const write = (value: JsonNode): void => {
    if (value.type === 'object') {
      parts.push('{');
      value.members.forEach((m, i) => {
        if (i > 0) parts.push(', ');
        parts.push(text.slice(m.keyStart, keyEnd(text, m)), ': ');
        write(m.value);
      });
      parts.push('}');
    } else if (value.type === 'array') {
      parts.push('[');
      value.items.forEach((item, i) => {
        if (i > 0) parts.push(', ');
        write(item);
      });
      parts.push(']');
    } else {
      parts.push(text.slice(value.start, value.end));
    }
  };
  write(node);
  return parts.join('');
}

function keyEnd(text: string, m: JsonMember): number {
  return readJsonString(text, m.keyStart).end;
}

/** A JSON string literal for `value` (the same escaping as JSON.stringify). */
export function quoteJson(value: string): string {
  return JSON.stringify(value);
}
