import { JsonSyntaxError, compactJson, parseJsonTree, readJsonString } from '../json';

/**
 * The Kibana Dev Tools console syntax (spec §11): a buffer of requests, each a request line
 * (`GET /orders/_search?size=5`) followed by an optional JSON body, or by NDJSON lines for
 * `_bulk` and `_msearch`. The parser also takes Kibana's extensions:
 *
 * - `#` and `//` line comments and `/* *\/` block comments, between and inside bodies;
 * - triple-quoted strings (`"""..."""`) inside bodies, sent as ordinary JSON strings, so a
 *   Painless script or a query can span lines without escapes;
 * - lower-case methods and paths without the leading slash (`get _cat/indices`).
 *
 * Numbers and strings are copied as typed (the body is never re-serialised), so a 64-bit id or
 * `1.10` reaches the server exactly. Every request keeps its offsets in the buffer, so the editor
 * can find the request at the cursor and map a server error position back into the text.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Maps a run of the sent body to the buffer: `sent` in the body is `source` in the buffer. */
export interface BodySegment {
  readonly sent: number;
  readonly source: number;
}

export interface ConsoleRequest {
  readonly method: HttpMethod;
  /** The URL as typed after the method: path and query string, trimmed. */
  readonly url: string;
  /** The path with a leading slash, without the query string. */
  readonly path: string;
  /** The query string without "?" ('' when there is none). */
  readonly query: string;
  /** What is sent: JSON text, or NDJSON lines each ending in "\n". */
  readonly body?: string;
  readonly bodyKind: 'none' | 'json' | 'ndjson';
  /** Offset of the method's first character in the buffer. */
  readonly start: number;
  /** Offset just after the request line, or after its last body value. */
  readonly end: number;
  /** The 0-based line of the request line. */
  readonly line: number;
  readonly urlStart: number;
  readonly urlEnd: number;
  /** Where each run of the sent body came from (for server error positions). */
  readonly bodyMap: readonly BodySegment[];
  /** The body could not be read; `issues` says why, and the request must not be sent. */
  readonly invalid: boolean;
}

export interface ConsoleIssue {
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

export interface ConsoleParse {
  readonly requests: readonly ConsoleRequest[];
  readonly issues: readonly ConsoleIssue[];
}

const METHOD_RE = /(GET|POST|PUT|DELETE|HEAD|PATCH)(?=[ \t])/iy;
/** Endpoints whose bodies are NDJSON: bulk, multi-search and the text structure finder. */
const NDJSON_PATH_RE =
  /(^|\/)(_bulk|_msearch(\/template)?|_fleet_msearch|_find_structure|_ml\/anomaly_detectors\/[^/]+\/_data)$/;

function isLineSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d;
}

function isSpace(code: number): boolean {
  return isLineSpace(code) || code === 0x0a;
}

/** True when only spaces precede `pos` on its line. */
function atLineStart(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) return true;
    if (!isLineSpace(code)) return false;
  }
  return true;
}

function lineEnd(text: string, pos: number): number {
  const end = text.indexOf('\n', pos);
  return end === -1 ? text.length : end;
}

function nextLine(text: string, pos: number): number {
  const end = text.indexOf('\n', pos);
  return end === -1 ? text.length : end + 1;
}

/** A request line starts at `pos` (a method at the start of a line, then a space). */
export function isRequestLine(text: string, pos: number): boolean {
  if (!atLineStart(text, pos)) return false;
  METHOD_RE.lastIndex = pos;
  return METHOD_RE.test(text);
}

/**
 * Skips whitespace and comments from `pos`. Returns the next offset; an unterminated block
 * comment is reported and ends the text.
 */
function skipTrivia(text: string, pos: number, issues: ConsoleIssue[]): number {
  let i = pos;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i++;
    } else if (code === 0x23 /* # */ || (code === 0x2f && text[i + 1] === '/')) {
      i = lineEnd(text, i);
    } else if (code === 0x2f && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        issues.push({ start: i, end: text.length, message: 'Unterminated block comment' });
        return text.length;
      }
      i = close + 2;
    } else {
      break;
    }
  }
  return i;
}

/** One body value read from the buffer: the text to send and where its runs came from. */
interface ScannedValue {
  readonly text: string;
  readonly map: BodySegment[];
  readonly start: number;
  readonly end: number;
  readonly multiline: boolean;
}

class ScanError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const LITERAL_RE = /-?[0-9][0-9.eE+-]*|true|false|null/y;

/**
 * Reads one JSON value with the console's extensions (comments are dropped, triple-quoted
 * strings become JSON strings); the result is validated as JSON afterwards.
 */
function scanValue(text: string, start: number): ScannedValue {
  const out: string[] = [];
  const map: BodySegment[] = [];
  let length = 0;
  const copy = (from: number, to: number): void => {
    if (to <= from) return;
    map.push({ sent: length, source: from });
    const part = text.slice(from, to);
    out.push(part);
    length += part.length;
  };
  const emit = (value: string, source: number): void => {
    map.push({ sent: length, source });
    out.push(value);
    length += value.length;
  };
  const stack: { char: string; at: number }[] = [];
  let i = start;
  let first = true;
  for (;;) {
    if (!first) {
      // Whitespace (line breaks included) is kept, so the body stays readable and the server's
      // line and column still point at the right place; comments go.
      let j = i;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (isSpace(code)) {
          j++;
        } else if (code === 0x23 || (code === 0x2f && text[j + 1] === '/')) {
          copy(i, j);
          j = lineEnd(text, j);
          i = j;
        } else if (code === 0x2f && text[j + 1] === '*') {
          copy(i, j);
          const close = text.indexOf('*/', j + 2);
          if (close === -1) throw new ScanError('Unterminated block comment', j);
          j = close + 2;
          i = j;
        } else {
          break;
        }
      }
      copy(i, j);
      i = j;
    }
    first = false;
    const char = text[i];
    if (char === undefined) {
      const open = stack[stack.length - 1];
      throw new ScanError(
        open ? `Missing "${open.char === '{' ? '}' : ']'}" to close this body` : 'Unexpected end',
        open ? open.at : i,
      );
    }
    if (char === '{' || char === '[') {
      stack.push({ char, at: i });
      copy(i, i + 1);
      i++;
      continue;
    }
    if (char === '}' || char === ']') {
      const open = stack.pop();
      if (!open || (open.char === '{') !== (char === '}')) {
        throw new ScanError(`Unexpected "${char}"`, i);
      }
      copy(i, i + 1);
      i++;
      if (stack.length === 0) break;
      continue;
    }
    if (char === '"') {
      if (text.startsWith('"""', i)) {
        const close = text.indexOf('"""', i + 3);
        if (close === -1) throw new ScanError('Unterminated triple-quoted string', i);
        emit(JSON.stringify(text.slice(i + 3, close)), i);
        i = close + 3;
      } else {
        let end: number;
        try {
          end = readJsonString(text, i).end;
        } catch (error) {
          throw new ScanError(
            error instanceof JsonSyntaxError ? error.message : 'Invalid string',
            error instanceof JsonSyntaxError ? error.offset : i,
          );
        }
        copy(i, end);
        i = end;
      }
      if (stack.length === 0) break;
      continue;
    }
    if (char === ',' || char === ':') {
      copy(i, i + 1);
      i++;
      continue;
    }
    LITERAL_RE.lastIndex = i;
    const literal = LITERAL_RE.exec(text);
    if (literal) {
      copy(i, i + literal[0].length);
      i += literal[0].length;
      if (stack.length === 0) break;
      continue;
    }
    if (stack.length > 0 && isRequestLine(text, i)) {
      const open = stack[stack.length - 1]!;
      throw new ScanError(`Missing "${open.char === '{' ? '}' : ']'}" to close this body`, open.at);
    }
    throw new ScanError(`Unexpected ${JSON.stringify(char)}`, i);
  }
  const body = out.join('');
  return { text: body, map, start, end: i, multiline: text.slice(start, i).includes('\n') };
}

/** The buffer offset of an offset in a sent body. */
export function sourceOffset(map: readonly BodySegment[], sent: number): number | undefined {
  let found: BodySegment | undefined;
  for (const segment of map) {
    if (segment.sent > sent) break;
    found = segment;
  }
  return found ? found.source + (sent - found.sent) : undefined;
}

/** The index of the character at 1-based `line` and `column` of `text`. */
export function offsetOfLineColumn(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + Math.max(column - 1, 0), text.length);
}

/** The body kind an endpoint takes: NDJSON for bulk-style endpoints, else JSON. */
export function bodyKindForPath(path: string): 'json' | 'ndjson' {
  return NDJSON_PATH_RE.test(path.replace(/\/+$/, '')) ? 'ndjson' : 'json';
}

/** Splits "orders/_search?size=5" into a path with a leading slash and the query string. */
export function splitUrl(url: string): { path: string; query: string } {
  const q = url.indexOf('?');
  const rawPath = (q === -1 ? url : url.slice(0, q)).trim();
  const query = q === -1 ? '' : url.slice(q + 1).trim();
  return { path: rawPath.startsWith('/') ? rawPath : `/${rawPath}`, query };
}

function lineOf(text: string, pos: number): number {
  let line = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Parses a console buffer into its requests (see the module comment). Never throws. */
export function parseConsole(text: string): ConsoleParse {
  const requests: ConsoleRequest[] = [];
  const issues: ConsoleIssue[] = [];
  let pos = 0;
  while (pos < text.length) {
    pos = skipTrivia(text, pos, issues);
    if (pos >= text.length) break;
    if (!isRequestLine(text, pos)) {
      const end = lineEnd(text, pos);
      issues.push({
        start: pos,
        end: Math.max(end, pos + 1),
        message: 'Expected a request such as GET /_search',
      });
      pos = nextLine(text, pos);
      continue;
    }
    METHOD_RE.lastIndex = pos;
    const method = METHOD_RE.exec(text)![1]!.toUpperCase() as HttpMethod;
    const start = pos;
    const eol = lineEnd(text, pos);
    let urlStart = pos + method.length;
    while (urlStart < eol && isLineSpace(text.charCodeAt(urlStart))) urlStart++;
    let urlEnd = eol;
    // A trailing comment after whitespace: "GET _search   # all indices".
    const comment = /[ \t](#|\/\/)/.exec(text.slice(urlStart, eol));
    if (comment) urlEnd = urlStart + comment.index;
    while (urlEnd > urlStart && isLineSpace(text.charCodeAt(urlEnd - 1))) urlEnd--;
    const url = text.slice(urlStart, urlEnd);
    const { path, query } = splitUrl(url);
    const line = lineOf(text, start);
    if (url === '') {
      issues.push({ start, end: eol, message: 'The request needs a path, e.g. GET /_search' });
    }

    // The body: JSON values until the next request line.
    const values: ScannedValue[] = [];
    let invalid = url === '';
    let end = urlEnd;
    let next = nextLine(text, eol);
    for (;;) {
      const at = skipTrivia(text, next, issues);
      if (at >= text.length || isRequestLine(text, at)) {
        next = at;
        break;
      }
      const char = text[at];
      if (char !== '{' && char !== '[' && char !== '"') {
        issues.push({
          start: at,
          end: Math.max(lineEnd(text, at), at + 1),
          message: 'Expected a JSON body or the next request',
        });
        invalid = true;
        next = recover(text, at);
        break;
      }
      try {
        const value = scanValue(text, at);
        values.push(value);
        end = value.end;
        next = value.end;
      } catch (error) {
        const offset = error instanceof ScanError ? error.offset : at;
        issues.push({
          start: offset,
          end: offset + 1,
          message: error instanceof Error ? error.message : 'Invalid body',
        });
        invalid = true;
        next = recover(text, offset);
        end = Math.max(end, Math.min(next, text.length));
        break;
      }
    }

    let bodyKind: ConsoleRequest['bodyKind'] = 'none';
    let body: string | undefined;
    const bodyMap: BodySegment[] = [];
    if (values.length > 0 && !invalid) {
      bodyKind = values.length > 1 ? 'ndjson' : bodyKindForPath(path);
      for (const value of values) {
        try {
          parseJsonTree(value.text);
        } catch (error) {
          const sent = error instanceof JsonSyntaxError ? error.offset : 0;
          const source = sourceOffset(value.map, sent) ?? value.start;
          issues.push({
            start: source,
            end: source + 1,
            message: error instanceof Error ? error.message : 'Invalid JSON',
          });
          invalid = true;
        }
      }
      if (!invalid) {
        if (bodyKind === 'json') {
          body = values[0]!.text;
          bodyMap.push(...values[0]!.map);
        } else {
          const lines: string[] = [];
          let length = 0;
          for (const value of values) {
            // NDJSON needs each value on one line.
            const lineText = value.multiline ? compactJson(value.text) : value.text;
            if (value.multiline) bodyMap.push({ sent: length, source: value.start });
            else
              for (const s of value.map) bodyMap.push({ sent: length + s.sent, source: s.source });
            lines.push(lineText);
            length += lineText.length + 1;
          }
          body = `${lines.join('\n')}\n`;
        }
      }
    }
    requests.push({
      method,
      url,
      path,
      query,
      ...(body !== undefined ? { body } : {}),
      bodyKind: body === undefined ? 'none' : bodyKind,
      start,
      end: Math.max(end, urlEnd),
      line,
      urlStart,
      urlEnd,
      bodyMap,
      invalid,
    });
    pos = next;
  }
  return { requests, issues };
}

/** After a body error: the next request line from the error's line on (or the end). */
function recover(text: string, offset: number): number {
  let line = offset;
  while (line > 0 && text.charCodeAt(line - 1) !== 0x0a) line--;
  for (let at = line; at < text.length; at = nextLine(text, at)) {
    let first = at;
    while (first < text.length && isLineSpace(text.charCodeAt(first))) first++;
    if (at > line || first >= offset) {
      if (isRequestLine(text, first)) return first;
    }
  }
  return text.length;
}

/**
 * The request the cursor is in: the one whose text contains `offset`, else the last one that
 * starts before it (the cursor on a blank line after a request). Undefined before the first.
 */
export function requestAt(
  requests: readonly ConsoleRequest[],
  offset: number,
): ConsoleRequest | undefined {
  let found: ConsoleRequest | undefined;
  for (const request of requests) {
    if (request.start > offset) break;
    found = request;
  }
  return found;
}

/** The requests that overlap a selection [start, end). */
export function requestsIn(
  requests: readonly ConsoleRequest[],
  start: number,
  end: number,
): ConsoleRequest[] {
  if (end <= start) {
    const one = requestAt(requests, start);
    return one ? [one] : [];
  }
  return requests.filter((r) => r.start < end && r.end >= start);
}

/** The issues that fall inside a request's text. */
export function issuesOf(parse: ConsoleParse, request: ConsoleRequest): ConsoleIssue[] {
  return parse.issues.filter((i) => i.start >= request.start && i.start <= request.end);
}

/**
 * The buffer offset of a server error position (1-based line and column in the body sent), or
 * undefined when it falls outside the body.
 */
export function bodyErrorOffset(
  request: ConsoleRequest,
  line: number,
  column: number,
): number | undefined {
  if (request.body === undefined) return undefined;
  return sourceOffset(request.bodyMap, offsetOfLineColumn(request.body, line, column));
}

/** The request as console text: the request line and its body, re-indented when it is JSON. */
export function formatConsoleRequest(request: {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: string;
  readonly body?: string;
  readonly bodyKind?: 'none' | 'json' | 'ndjson';
}): string {
  const line = `${request.method} ${request.path}${request.query ? `?${request.query}` : ''}`;
  if (request.body === undefined || request.body === '') return line;
  if (request.bodyKind === 'ndjson') return `${line}\n${request.body.replace(/\n$/, '')}`;
  return `${line}\n${request.body}`;
}
