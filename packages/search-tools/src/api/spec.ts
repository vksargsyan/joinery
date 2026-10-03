import data from './spec.json' with { type: 'json' };

/**
 * The console's API data (ADR 0010): endpoints and request body types generated from the open
 * Elasticsearch API specification (github.com/elastic/elasticsearch-specification, Apache
 * License 2.0) by `scripts/generate-api-spec.mjs`, which records the branch and date in
 * `source`. Regenerate it with `pnpm --filter @querybara/search-tools generate:api`.
 *
 * Type references are compact strings:
 *
 * - `s`, `n`, `b` and `null`: string, number, boolean and null; `*` any value (user data);
 * - a type key (a name in `types`);
 * - `[]X`: an array of X; `{}X`: an object with keys of the user's choice and X values; `{1}X`:
 *   the same with exactly one key (`"term": { "<field>": ... }`);
 * - `(A|B)`: one of several types; `enum:x`: the literal string x.
 */

export interface ApiEndpoint {
  /** The specification's name, e.g. "search" or "indices.create". */
  readonly name: string;
  readonly methods: readonly string[];
  /** URL templates such as "/{index}/_search". */
  readonly paths: readonly string[];
  /** Query parameter names. */
  readonly params?: readonly string[];
  readonly body?: 'json' | 'ndjson';
  /** The body's type reference, for the endpoints whose bodies complete key by key. */
  readonly type?: string;
  /** The first line of the endpoint's description. */
  readonly summary?: string;
  /** "beta" or "experimental"; absent when stable. */
  readonly stability?: string;
  /** The Elasticsearch version that added the endpoint, when the specification says. */
  readonly since?: string;
}

export type ApiType =
  | {
      readonly props: Readonly<Record<string, string>>;
      /** Alternative property names, e.g. aggs → aggregations. */
      readonly aliases?: Readonly<Record<string, string>>;
    }
  | { readonly enum: readonly string[] }
  | { readonly ref: string };

export interface ApiSpec {
  readonly source: {
    readonly repository: string;
    readonly branch: string;
    readonly license: string;
    readonly generated: string;
  };
  readonly endpoints: readonly ApiEndpoint[];
  readonly types: Readonly<Record<string, ApiType>>;
}

/** The generated API data. */
export const API_SPEC: ApiSpec = data as ApiSpec;

/** One URL template split into segments; placeholders are "{name}". */
function templateSegments(template: string): string[] {
  return template.split('/').filter((s) => s !== '');
}

export function isPlaceholder(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

/** An endpoint and the URL template a path matched. */
export interface EndpointMatch {
  readonly endpoint: ApiEndpoint;
  readonly template: string;
  /** Placeholder values from the path, e.g. { index: "orders" }. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The endpoints a request's method and path match, most specific first (more literal
 * segments). Placeholders match any segment that does not start with "_" (an API name), except
 * document ids, which may.
 */
export function matchEndpoints(
  method: string,
  path: string,
  spec: ApiSpec = API_SPEC,
): EndpointMatch[] {
  const upper = method.toUpperCase();
  const segments = path
    .split('?')[0]!
    .split('/')
    .filter((s) => s !== '');
  const matches: { match: EndpointMatch; literals: number }[] = [];
  for (const endpoint of spec.endpoints) {
    if (!endpoint.methods.includes(upper)) continue;
    for (const template of endpoint.paths) {
      const parts = templateSegments(template);
      if (parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let literals = 0;
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const segment = segments[i]!;
        if (isPlaceholder(part)) {
          const name = part.slice(1, -1);
          if (segment.startsWith('_') && name !== 'id' && segment !== '_all') {
            ok = false;
            break;
          }
          params[name] = segment;
        } else if (part === segment) {
          literals++;
        } else {
          ok = false;
          break;
        }
      }
      if (ok) matches.push({ match: { endpoint, template, params }, literals });
    }
  }
  matches.sort((a, b) => b.literals - a.literals);
  return matches.map((m) => m.match);
}

/** The endpoint a request calls, if the specification knows it. */
export function endpointFor(
  method: string,
  path: string,
  spec: ApiSpec = API_SPEC,
): ApiEndpoint | undefined {
  return matchEndpoints(method, path, spec)[0]?.endpoint;
}
