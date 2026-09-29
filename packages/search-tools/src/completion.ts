import {
  API_SPEC,
  isPlaceholder,
  matchEndpoints,
  type ApiEndpoint,
  type ApiSpec,
  type ApiType,
} from './api/spec';
import type { SearchDistribution } from './capabilities';
import { HTTP_METHODS, isRequestLine } from './console/parser';

/**
 * Autocomplete for the console (spec §11): methods at the start of a request line, endpoint
 * paths and index names after the method, query parameters after "?", and the keys (and enum
 * values) of request bodies from the API specification's types, following the JSON path at the
 * cursor through queries, aggregations, mappings and settings. Pure: the editor passes the
 * buffer, the cursor offset and the index names it knows.
 */

export type CompletionKind = 'method' | 'endpoint' | 'index' | 'parameter' | 'property' | 'value';

export interface CompletionItem {
  readonly label: string;
  readonly kind: CompletionKind;
  /** What to insert; with `snippet`, TextMate snippet syntax ($0, ${1:name}, ${1|a,b|}). */
  readonly insertText: string;
  readonly snippet: boolean;
  /** A short description: the endpoint, or the value type. */
  readonly detail?: string;
}

export interface ConsoleCompletion {
  /** The range the chosen item replaces: [from, to) in the buffer. */
  readonly from: number;
  readonly to: number;
  readonly items: readonly CompletionItem[];
}

export interface ConsoleCompletionOptions {
  /** Index, alias and data stream names to offer for {index} segments. */
  readonly indices?: readonly string[];
  /** Leaves out Elasticsearch-only APIs on OpenSearch and adds OpenSearch's own. */
  readonly distribution?: SearchDistribution;
  readonly spec?: ApiSpec;
}

/** API namespaces OpenSearch does not have (X-Pack and Elastic-only features). */
const ELASTIC_ONLY = new Set([
  'async_search',
  'autoscaling',
  'ccr',
  'connector',
  'enrich',
  'eql',
  'esql',
  'features',
  'fleet',
  'graph',
  'ilm',
  'inference',
  'license',
  'logstash',
  'migration',
  'ml',
  'monitoring',
  'profiling',
  'query_rules',
  'rollup',
  'search_application',
  'searchable_snapshots',
  'security',
  'shutdown',
  'simulate',
  'slm',
  'sql',
  'ssl',
  'streams',
  'synonyms',
  'text_structure',
  'transform',
  'watcher',
  'xpack',
]);
const ELASTIC_ONLY_ENDPOINTS = new Set(['open_point_in_time', 'close_point_in_time']);

/** OpenSearch endpoints the Elasticsearch specification does not describe. */
const OPENSEARCH_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    name: 'opensearch.sql',
    methods: ['POST'],
    paths: ['/_plugins/_sql'],
    params: ['format'],
    body: 'json',
    summary: 'Run a SQL query (SQL plugin).',
  },
  {
    name: 'opensearch.sql.explain',
    methods: ['POST'],
    paths: ['/_plugins/_sql/_explain'],
    body: 'json',
    summary: 'Translate a SQL query to Query DSL (SQL plugin).',
  },
  {
    name: 'opensearch.ppl',
    methods: ['POST'],
    paths: ['/_plugins/_ppl'],
    params: ['format'],
    body: 'json',
    summary: 'Run a PPL query (SQL plugin).',
  },
  {
    name: 'opensearch.create_pit',
    methods: ['POST'],
    paths: ['/{index}/_search/point_in_time'],
    params: [
      'keep_alive',
      'preference',
      'routing',
      'expand_wildcards',
      'allow_partial_pit_creation',
    ],
    summary: 'Open a point in time.',
  },
  {
    name: 'opensearch.delete_pit',
    methods: ['DELETE'],
    paths: ['/_search/point_in_time', '/_search/point_in_time/_all'],
    body: 'json',
    summary: 'Close points in time.',
  },
  {
    name: 'opensearch.ism.policies',
    methods: ['GET', 'PUT', 'DELETE'],
    paths: ['/_plugins/_ism/policies', '/_plugins/_ism/policies/{policy_id}'],
    body: 'json',
    summary: 'Index State Management policies.',
  },
  {
    name: 'opensearch.security.authinfo',
    methods: ['GET'],
    paths: ['/_plugins/_security/authinfo'],
    summary: 'Who the current user is (security plugin).',
  },
];

function endpointsFor(options: ConsoleCompletionOptions): readonly ApiEndpoint[] {
  const spec = options.spec ?? API_SPEC;
  if (options.distribution !== 'opensearch') return spec.endpoints;
  return [
    ...spec.endpoints.filter(
      (e) => !ELASTIC_ONLY.has(e.name.split('.')[0]!) && !ELASTIC_ONLY_ENDPOINTS.has(e.name),
    ),
    ...OPENSEARCH_ENDPOINTS,
  ];
}

// ---------------------------------------------------------------------------------------------
// Type references (see api/spec.ts for the grammar)

type RefNode =
  | { readonly k: 'array'; readonly of: RefNode }
  | { readonly k: 'dict'; readonly single: boolean; readonly of: RefNode }
  | { readonly k: 'union'; readonly items: readonly RefNode[] }
  | { readonly k: 'enum'; readonly value: string }
  | { readonly k: 'scalar'; readonly name: 's' | 'n' | 'b' | 'null' | '*' }
  | { readonly k: 'type'; readonly key: string };

function parseRef(ref: string): RefNode {
  let i = 0;
  const read = (): RefNode => {
    if (ref.startsWith('[]', i)) {
      i += 2;
      return { k: 'array', of: read() };
    }
    if (ref.startsWith('{1}', i)) {
      i += 3;
      return { k: 'dict', single: true, of: read() };
    }
    if (ref.startsWith('{}', i)) {
      i += 2;
      return { k: 'dict', single: false, of: read() };
    }
    if (ref[i] === '(') {
      i++;
      const items: RefNode[] = [read()];
      while (ref[i] === '|') {
        i++;
        items.push(read());
      }
      if (ref[i] === ')') i++;
      return { k: 'union', items };
    }
    let end = i;
    while (end < ref.length && ref[end] !== '|' && ref[end] !== ')') end++;
    const word = ref.slice(i, end);
    i = end;
    if (word.startsWith('enum:')) return { k: 'enum', value: word.slice(5) };
    if (word === 's' || word === 'n' || word === 'b' || word === 'null' || word === '*') {
      return { k: 'scalar', name: word };
    }
    return { k: 'type', key: word };
  };
  return read();
}

/** A type reference resolved one level: the shapes a value of it can take. */
type Shape =
  | {
      readonly k: 'object';
      readonly name: string;
      readonly props: Readonly<Record<string, string>>;
      readonly aliases: Readonly<Record<string, string>>;
    }
  | { readonly k: 'dict'; readonly single: boolean; readonly of: RefNode }
  | { readonly k: 'array'; readonly of: RefNode }
  | { readonly k: 'enum'; readonly values: readonly string[] }
  | { readonly k: 'scalar'; readonly name: 's' | 'n' | 'b' | 'null' | '*' };

function shapesOf(node: RefNode, spec: ApiSpec, depth = 0): Shape[] {
  if (depth > 12) return [];
  switch (node.k) {
    case 'array':
      return [{ k: 'array', of: node.of }];
    case 'dict':
      return [{ k: 'dict', single: node.single, of: node.of }];
    case 'union':
      return node.items.flatMap((item) => shapesOf(item, spec, depth + 1));
    case 'enum':
      return [{ k: 'enum', values: [node.value] }];
    case 'scalar':
      return [{ k: 'scalar', name: node.name }];
    case 'type': {
      const type: ApiType | undefined = spec.types[node.key];
      if (!type) return [{ k: 'scalar', name: '*' }];
      if ('props' in type) {
        return [{ k: 'object', name: node.key, props: type.props, aliases: type.aliases ?? {} }];
      }
      if ('enum' in type) return [{ k: 'enum', values: type.enum }];
      return shapesOf(parseRef(type.ref), spec, depth + 1);
    }
  }
}

/** The shapes found by following one step (a member key or an array element) from `shapes`. */
function step(shapes: readonly Shape[], key: string | number, spec: ApiSpec): Shape[] {
  const next: Shape[] = [];
  for (const shape of shapes) {
    if (typeof key === 'number') {
      if (shape.k === 'array') next.push(...shapesOf(shape.of, spec));
      continue;
    }
    if (shape.k === 'object') {
      const ref = shape.props[key] ?? shape.props[shape.aliases[key] ?? ''];
      if (ref !== undefined) next.push(...shapesOf(parseRef(ref), spec));
    } else if (shape.k === 'dict') {
      next.push(...shapesOf(shape.of, spec));
    }
  }
  return next;
}

/** A short type name for the item detail. */
function describeRef(node: RefNode): string {
  switch (node.k) {
    case 'array':
      return `${describeRef(node.of)}[]`;
    case 'dict':
      return `{ [key]: ${describeRef(node.of)} }`;
    case 'union':
      return node.items.map(describeRef).join(' | ');
    case 'enum':
      return JSON.stringify(node.value);
    case 'scalar':
      return { s: 'string', n: 'number', b: 'boolean', null: 'null', '*': 'any' }[node.name];
    case 'type':
      return node.key;
  }
}

/** The value template inserted after a property name. */
function valueTemplate(ref: string, spec: ApiSpec): string {
  const shapes = shapesOf(parseRef(ref), spec);
  const kinds = new Set(shapes.map((s) => s.k));
  if (kinds.has('object') || kinds.has('dict')) return '{\n\t$0\n}';
  if (kinds.has('array') && kinds.size === 1) return '[\n\t$0\n]';
  const enums = shapes.flatMap((s) => (s.k === 'enum' ? s.values : []));
  if (enums.length > 0 && shapes.every((s) => s.k === 'enum')) {
    const choices = [...new Set(enums)].map((v) => v.replace(/[|,\\$}]/g, '\\$&'));
    return `"\${1|${choices.join(',')}|}"`;
  }
  if (shapes.length > 0 && shapes.every((s) => s.k === 'scalar' && s.name === 's')) return '"$0"';
  if (shapes.length > 0 && shapes.every((s) => s.k === 'scalar' && s.name === 'b')) {
    return '${1|true,false|}';
  }
  return '$0';
}

// ---------------------------------------------------------------------------------------------
// Where the cursor is

function lineStartOf(text: string, offset: number): number {
  // lastIndexOf clamps a negative start to 0, which would find a newline at 0 forever.
  if (offset <= 0) return 0;
  const nl = text.lastIndexOf('\n', offset - 1);
  return nl === -1 ? 0 : nl + 1;
}

function firstNonSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/** The request line above the cursor's line (its offset), if the cursor is in a body. */
function requestLineAbove(text: string, lineStart: number): number | undefined {
  let line = lineStart;
  while (line > 0) {
    line = lineStartOf(text, line - 1);
    const first = firstNonSpace(text, line);
    if (isRequestLine(text, first)) return first;
  }
  return undefined;
}

interface BodyContext {
  /** Keys and indexes from the body's root to the object or array the cursor is in. */
  readonly path: readonly (string | number)[];
  readonly position: 'key' | 'value';
  /** Keys already in the object the cursor is in. */
  readonly present: ReadonlySet<string>;
  /** Where the partial word or string being typed starts. */
  readonly from: number;
}

type Frame =
  | {
      kind: 'object';
      key: string | undefined;
      keys: Set<string>;
      expect: 'key' | 'colon' | 'value' | 'comma';
    }
  | { kind: 'array'; index: number; expect: 'value' | 'comma' };

/**
 * Reads the body from `start` up to the cursor tolerantly (it is usually half typed) and says
 * where the cursor is: a key or a value position, and the JSON path to it. Undefined inside a
 * string value, a comment, or outside any object.
 */
function bodyContext(text: string, start: number, offset: number): BodyContext | undefined {
  const stack: Frame[] = [];
  let i = start;
  const valueDone = (): void => {
    const top = stack[stack.length - 1];
    if (top) top.expect = 'comma';
  };
  const path = (): (string | number)[] =>
    stack.flatMap((frame, index): (string | number)[] => {
      if (index === stack.length - 1) return [];
      return frame.kind === 'object' ? (frame.key === undefined ? [] : [frame.key]) : [frame.index];
    });
  while (i < offset) {
    const char = text[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i++;
    } else if (char === '#' || (char === '/' && text[i + 1] === '/')) {
      const nl = text.indexOf('\n', i);
      if (nl === -1 || nl >= offset) return undefined;
      i = nl + 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1 || close + 2 > offset) return undefined;
      i = close + 2;
    } else if (char === '{') {
      stack.push({ kind: 'object', key: undefined, keys: new Set(), expect: 'key' });
      i++;
    } else if (char === '[') {
      stack.push({ kind: 'array', index: 0, expect: 'value' });
      i++;
    } else if (char === '}' || char === ']') {
      stack.pop();
      valueDone();
      i++;
    } else if (char === ':') {
      const top = stack[stack.length - 1];
      if (top?.kind === 'object') top.expect = 'value';
      i++;
    } else if (char === ',') {
      const top = stack[stack.length - 1];
      if (top?.kind === 'object') {
        top.expect = 'key';
        top.key = undefined;
      } else if (top?.kind === 'array') {
        top.index++;
        top.expect = 'value';
      }
      i++;
    } else if (char === '"') {
      const triple = text.startsWith('"""', i);
      let end: number;
      if (triple) {
        const close = text.indexOf('"""', i + 3);
        if (close === -1 || close + 3 > offset) return undefined;
        end = close + 3;
      } else {
        end = i + 1;
        while (end < offset && text[end] !== '"' && text[end] !== '\n') {
          end += text[end] === '\\' ? 2 : 1;
        }
        if (end >= offset || text[end] === '\n') {
          // The cursor is inside this string.
          const top = stack[stack.length - 1];
          if (top?.kind === 'object' && top.expect === 'key') {
            return { path: path(), position: 'key', present: top.keys, from: i };
          }
          if (
            (top?.kind === 'object' && top.expect === 'value') ||
            (top?.kind === 'array' && top.expect === 'value')
          ) {
            return { path: pathTo(stack), position: 'value', present: new Set(), from: i };
          }
          return undefined;
        }
        end += 1;
      }
      const top = stack[stack.length - 1];
      if (top?.kind === 'object' && top.expect === 'key' && !triple) {
        try {
          top.key = JSON.parse(text.slice(i, end)) as string;
        } catch {
          top.key = text.slice(i + 1, end - 1);
        }
        top.keys.add(top.key);
        top.expect = 'colon';
      } else {
        valueDone();
      }
      i = end;
    } else {
      // A bare word: a number or literal, or a key typed without its quotes.
      let end = i;
      while (end < offset && /[^\s{}[\]:,"]/.test(text[end]!)) end++;
      if (end >= offset) {
        const top = stack[stack.length - 1];
        if (top?.kind === 'object' && top.expect === 'key') {
          return { path: path(), position: 'key', present: top.keys, from: i };
        }
        if (top && top.expect === 'value') {
          return { path: pathTo(stack), position: 'value', present: new Set(), from: i };
        }
        return undefined;
      }
      valueDone();
      i = end;
    }
  }
  const top = stack[stack.length - 1];
  if (!top) return undefined;
  if (top.kind === 'object') {
    if (top.expect === 'key')
      return { path: path(), position: 'key', present: top.keys, from: offset };
    if (top.expect === 'value') {
      return { path: pathTo(stack), position: 'value', present: new Set(), from: offset };
    }
    return undefined;
  }
  return top.expect === 'value'
    ? { path: pathTo(stack), position: 'value', present: new Set(), from: offset }
    : undefined;
}

/** The path to the value position at the top of the stack (the current key or element). */
function pathTo(stack: readonly Frame[]): (string | number)[] {
  return stack.flatMap((frame): (string | number)[] =>
    frame.kind === 'object' ? (frame.key === undefined ? [] : [frame.key]) : [frame.index],
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * Completions at `offset` of a console buffer, or undefined where there are none (inside a
 * string value or a comment).
 */
export function completeConsole(
  text: string,
  offset: number,
  options: ConsoleCompletionOptions = {},
): ConsoleCompletion | undefined {
  const spec = options.spec ?? API_SPEC;
  const lineStart = lineStartOf(text, offset);
  const first = firstNonSpace(text, lineStart);
  const prefix = text.slice(lineStart, offset);
  const word = /^\s*[A-Za-z]*$/.test(prefix);

  const requestLine = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)[ \t]+(\S*)$/i.exec(prefix);
  if (requestLine) {
    const method = requestLine[1]!.toUpperCase();
    const url = requestLine[2]!;
    return url.includes('?')
      ? parameterCompletion(method, url, offset, options)
      : pathCompletion(method, url, offset, options);
  }
  if (isRequestLine(text, first)) return word ? methodCompletion(first, offset) : undefined;
  const above = requestLineAbove(text, lineStart);
  const context =
    above === undefined ? undefined : bodyContext(text, text.indexOf('\n', above) + 1, offset);
  if (!context) return word ? methodCompletion(first, offset) : undefined;

  const header = /^(GET|POST|PUT|DELETE|HEAD|PATCH)[ \t]+(\S*)/i.exec(text.slice(above));
  if (!header) return undefined;
  const method = header[1]!.toUpperCase();
  const path = header[2]!.split('?')[0]!;
  const endpoint = matchEndpoints(method, path.startsWith('/') ? path : `/${path}`, {
    ...spec,
    endpoints: endpointsFor(options),
  })[0]?.endpoint;
  if (!endpoint?.type) return undefined;
  // NDJSON bodies (bulk, msearch) complete each line as one element of the body's array.
  const rootRef =
    endpoint.body === 'ndjson' && endpoint.type.startsWith('[]')
      ? endpoint.type.slice(2)
      : endpoint.type;
  let shapes = shapesOf(parseRef(rootRef), spec);
  for (const key of context.path) shapes = step(shapes, key, spec);
  // An editor that closed the quote already: replace it too.
  const to = text[offset] === '"' && text[context.from] === '"' ? offset + 1 : offset;
  if (context.position === 'key') {
    return { from: context.from, to, items: keyItems(shapes, context.present, spec) };
  }
  // Inside a string only enum values fit.
  const inString = text[context.from] === '"';
  const items = valueItems(shapes).filter((item) => !inString || item.label.startsWith('"'));
  return items.length > 0 ? { from: context.from, to, items } : undefined;
}

function methodCompletion(from: number, to: number): ConsoleCompletion {
  return {
    from,
    to,
    items: HTTP_METHODS.map((method) => ({
      label: method,
      kind: 'method' as const,
      insertText: `${method} `,
      snippet: false,
    })),
  };
}

const INDEX_PLACEHOLDERS = new Set(['index', 'target', 'alias', 'name', 'indices']);

function snippetPath(segments: readonly string[]): string {
  let n = 0;
  return segments
    .map((segment) =>
      isPlaceholder(segment) ? `\${${++n}:${segment.slice(1, -1)}}` : segment.replace(/\$/g, '\\$'),
    )
    .join('/');
}

function pathCompletion(
  method: string,
  url: string,
  offset: number,
  options: ConsoleCompletionOptions,
): ConsoleCompletion {
  const leadingSlash = url.startsWith('/');
  const typed = (leadingSlash ? url.slice(1) : url).split('/');
  const current = typed.pop() ?? '';
  const from = offset - current.length;
  const items = new Map<string, CompletionItem>();
  let offersIndices = false;
  for (const endpoint of endpointsFor(options)) {
    if (!endpoint.methods.includes(method)) continue;
    for (const template of endpoint.paths) {
      const parts = template.split('/').filter((s) => s !== '');
      if (parts.length <= typed.length) continue;
      const fits = typed.every((segment, i) => {
        const part = parts[i]!;
        return isPlaceholder(part)
          ? !segment.startsWith('_') || segment === '_all'
          : part === segment;
      });
      if (!fits) continue;
      const rest = parts.slice(typed.length);
      const head = rest[0]!;
      if (isPlaceholder(head) && INDEX_PLACEHOLDERS.has(head.slice(1, -1))) offersIndices = true;
      const label = rest.join('/');
      if (items.has(label)) continue;
      items.set(label, {
        label,
        kind: 'endpoint',
        insertText: snippetPath(rest),
        snippet: rest.some(isPlaceholder),
        detail: endpoint.summary ? `${endpoint.name}: ${endpoint.summary}` : endpoint.name,
      });
    }
  }
  const out = [...items.values()];
  if (offersIndices) {
    for (const name of options.indices ?? []) {
      out.push({ label: name, kind: 'index', insertText: name, snippet: false, detail: 'index' });
    }
  }
  return { from, to: offset, items: out };
}

function parameterCompletion(
  method: string,
  url: string,
  offset: number,
  options: ConsoleCompletionOptions,
): ConsoleCompletion | undefined {
  const q = url.indexOf('?');
  const path = url.slice(0, q);
  const params = url.slice(q + 1);
  const current = params.split('&').pop() ?? '';
  if (current.includes('=')) return undefined;
  const spec = options.spec ?? API_SPEC;
  const matched = matchEndpoints(method, path.startsWith('/') ? path : `/${path}`, {
    ...spec,
    endpoints: endpointsFor(options),
  });
  const names = new Set<string>(['pretty', 'human', 'error_trace', 'filter_path']);
  for (const match of matched.slice(0, 1))
    for (const p of match.endpoint.params ?? []) names.add(p);
  const typed = new Set(
    params
      .split('&')
      .slice(0, -1)
      .map((p) => p.split('=')[0]),
  );
  return {
    from: offset - current.length,
    to: offset,
    items: [...names]
      .filter((name) => !typed.has(name))
      .map((name) => ({
        label: name,
        kind: 'parameter' as const,
        insertText:
          name === 'pretty' || name === 'human' || name === 'error_trace' ? name : `${name}=`,
        snippet: false,
      })),
  };
}

function keyItems(
  shapes: readonly Shape[],
  present: ReadonlySet<string>,
  spec: ApiSpec,
): CompletionItem[] {
  const items = new Map<string, CompletionItem>();
  for (const shape of shapes) {
    if (shape.k !== 'object') continue;
    for (const [name, ref] of Object.entries(shape.props)) {
      if (present.has(name) || items.has(name)) continue;
      items.set(name, {
        label: name,
        kind: 'property',
        insertText: `"${name}": ${valueTemplate(ref, spec)}`,
        snippet: true,
        detail: describeRef(parseRef(ref)),
      });
    }
    for (const [alias, target] of Object.entries(shape.aliases)) {
      const ref = shape.props[target];
      if (ref === undefined || present.has(alias) || present.has(target) || items.has(alias)) {
        continue;
      }
      items.set(alias, {
        label: alias,
        kind: 'property',
        insertText: `"${alias}": ${valueTemplate(ref, spec)}`,
        snippet: true,
        detail: `${target} (alias)`,
      });
    }
  }
  return [...items.values()];
}

function valueItems(shapes: readonly Shape[]): CompletionItem[] {
  const items = new Map<string, CompletionItem>();
  const add = (label: string, insertText: string, snippet = false): void => {
    if (!items.has(label)) items.set(label, { label, kind: 'value', insertText, snippet });
  };
  for (const shape of shapes) {
    if (shape.k === 'enum')
      for (const value of shape.values) add(`"${value}"`, JSON.stringify(value));
    else if (shape.k === 'scalar' && shape.name === 'b') {
      add('true', 'true');
      add('false', 'false');
    } else if (shape.k === 'object' || shape.k === 'dict') add('{}', '{\n\t$0\n}', true);
    else if (shape.k === 'array') add('[]', '[\n\t$0\n]', true);
  }
  return [...items.values()];
}
