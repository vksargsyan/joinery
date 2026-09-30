import { formatConsoleRequest } from './console/parser';
import { compactJson, formatJson, member, nodeText, parseJsonTree, type JsonNode } from './json';
import type { SearchRequest } from './wire';

/**
 * Index administration helpers (spec §11) that both the page and the connection host use:
 * index name rules, the settings a new index can copy from an old one, alias actions (with the
 * atomic swap), and the reindex plan the mapping editor offers when a mapping change cannot be
 * applied in place: create the new index, `_reindex` into it as a server task, refresh, and
 * move the alias in one `_aliases` call.
 */

const FORBIDDEN_NAME_CHARS = /[\\/*?"<>| ,#:]/;

/** Why an index name is not allowed, or undefined when it is. */
export function indexNameProblem(name: string): string | undefined {
  if (name === '') return 'Name the index';
  if (name !== name.toLowerCase()) return 'Index names are lower case';
  if (name === '.' || name === '..') return 'An index cannot be named "." or ".."';
  if (/^[-_+]/.test(name)) return 'An index name cannot start with -, _ or +';
  const forbidden = FORBIDDEN_NAME_CHARS.exec(name);
  if (forbidden) {
    return `An index name cannot contain ${forbidden[0] === ' ' ? 'spaces' : `"${forbidden[0]}"`}`;
  }
  if (new TextEncoder().encode(name).length > 255) return 'An index name is at most 255 bytes';
  return undefined;
}

/**
 * The next versioned name for a copy of an index: "orders-v3" after "orders-v2", "orders-v2"
 * after "orders", skipping names in `taken`.
 */
export function nextIndexName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const match = /^(.*?)([-_]v)(\d+)$/.exec(name);
  const base = match ? match[1]! : name;
  const separator = match ? match[2]! : '-v';
  let version = match ? Number(match[3]) + 1 : 2;
  while (used.has(`${base}${separator}${version}`)) version++;
  return `${base}${separator}${version}`;
}

/** Index settings that belong to one index and are never copied to another. */
const PRIVATE_SETTINGS = [
  'index.uuid',
  'index.creation_date',
  'index.creation_date_string',
  'index.provided_name',
  'index.version',
  'index.resize',
  'index.blocks',
  'index.routing.allocation.initial_recovery',
  'index.verified_before_close',
  'index.number_of_routing_shards',
  'index.lifecycle.indexing_complete',
  'index.frozen',
  'index.history',
  'index.shrink',
  'index.replication',
  'index.store.snapshot',
  'index.plugins.index_state_management.auto_manage',
];

function flattenSettings(text: string, node: JsonNode, prefix: string, out: Map<string, string>) {
  if (node.type === 'object') {
    for (const m of node.members) {
      flattenSettings(text, m.value, prefix === '' ? m.key : `${prefix}.${m.key}`, out);
    }
    return;
  }
  out.set(prefix, compactJson(nodeText(text, node)));
}

/**
 * The settings of an index (a `GET /<index>/_settings` reply, a `settings` object, or its
 * `index` object; nested or flat) that a new index can take over: shards, replicas, analysis,
 * refresh interval and the like, without what belongs to the old index (uuid, creation date,
 * version, blocks, resize and routing state). Returns a flat settings object as JSON text.
 */
export function copyableSettings(text: string): string {
  let node = parseJsonTree(text);
  // Unwrap `{"<index>": {"settings": ...}}` and `{"settings": ...}`.
  if (
    member(node, 'settings') === undefined &&
    node.type === 'object' &&
    node.members.length === 1
  ) {
    const inner = member(node.members[0]!.value, 'settings');
    if (inner) node = inner;
  }
  node = member(node, 'settings') ?? node;
  const flat = new Map<string, string>();
  flattenSettings(text, node, '', flat);
  const entries = [...flat].map(([key, value]): [string, string] => [
    key.startsWith('index.') ? key : `index.${key}`,
    value,
  ]);
  const kept = entries.filter(
    ([key]) => !PRIVATE_SETTINGS.some((p) => key === p || key.startsWith(`${p}.`)),
  );
  return `{${kept.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
}

/** One alias of one index, as `_aliases` actions take it. */
export interface AliasTarget {
  readonly index: string;
  readonly alias: string;
  readonly isWriteIndex?: boolean;
  /** A filter query (JSON text). */
  readonly filter?: string;
  readonly routing?: string;
}

/** `{"actions": [...]}` that adds and removes aliases in one atomic call. */
export function aliasActions(
  add: readonly AliasTarget[],
  remove: readonly Pick<AliasTarget, 'index' | 'alias'>[],
  options: { readonly removeIndices?: readonly string[] } = {},
): string {
  const actions = [
    ...remove.map(
      (r) =>
        `{"remove": {"index": ${JSON.stringify(r.index)}, "alias": ${JSON.stringify(r.alias)}}}`,
    ),
    ...add.map((a) => {
      const fields = [
        `"index": ${JSON.stringify(a.index)}`,
        `"alias": ${JSON.stringify(a.alias)}`,
        ...(a.isWriteIndex !== undefined ? [`"is_write_index": ${a.isWriteIndex}`] : []),
        ...(a.filter !== undefined && a.filter.trim() !== ''
          ? [`"filter": ${compactJson(a.filter)}`]
          : []),
        ...(a.routing !== undefined && a.routing !== ''
          ? [`"routing": ${JSON.stringify(a.routing)}`]
          : []),
      ];
      return `{"add": {${fields.join(', ')}}}`;
    }),
    ...(options.removeIndices ?? []).map(
      (i) => `{"remove_index": {"index": ${JSON.stringify(i)}}}`,
    ),
  ];
  return `{"actions": [${actions.join(', ')}]}`;
}

/**
 * Moves an alias from the indices it points at to another index in one call, so searches
 * through the alias never see neither or both.
 */
export function aliasSwapActions(
  alias: string,
  from: readonly string[],
  to: string,
  options: { readonly isWriteIndex?: boolean } = {},
): string {
  return aliasActions(
    [
      {
        index: to,
        alias,
        ...(options.isWriteIndex !== undefined ? { isWriteIndex: options.isWriteIndex } : {}),
      },
    ],
    from.filter((index) => index !== to).map((index) => ({ index, alias })),
  );
}

/** How the reindex plan points clients at the new index. */
export type ReindexCutover =
  /** Move these aliases from the old index to the new one. */
  | { readonly kind: 'aliases'; readonly aliases: readonly string[] }
  /** Delete the old index and give its name to the new one as an alias (destructive). */
  | { readonly kind: 'replace' }
  /** Leave the old index as it is; clients switch themselves. */
  | { readonly kind: 'none' };

export interface ReindexPlanInput {
  readonly source: string;
  readonly target: string;
  /** The new index's mapping (a bare mapping object, JSON text). */
  readonly mappings: string;
  /** The new index's settings (JSON text, e.g. from copyableSettings). */
  readonly settings?: string;
  readonly cutover: ReindexCutover;
  /** An ingest pipeline the documents go through on the way. */
  readonly pipeline?: string;
}

export interface ReindexStep {
  readonly kind: 'create' | 'reindex' | 'refresh' | 'aliases';
  readonly title: string;
  readonly request: SearchRequest;
  /** Why this step always asks (it deletes the old index). */
  readonly destructive?: string;
}

export interface ReindexPlan {
  readonly steps: readonly ReindexStep[];
  /** The steps as console text, to review or run by hand. */
  readonly consoleText: string;
}

/** The reindex plan (see the module comment). */
export function reindexPlan(input: ReindexPlanInput): ReindexPlan {
  const problem = indexNameProblem(input.target);
  if (problem) throw new Error(problem);
  if (input.target === input.source) throw new Error('The new index needs another name');
  const mappings = compactJson(input.mappings);
  const settings =
    input.settings !== undefined && input.settings.trim() !== ''
      ? compactJson(input.settings)
      : undefined;
  const dest = [
    `"index": ${JSON.stringify(input.target)}`,
    ...(input.pipeline ? [`"pipeline": ${JSON.stringify(input.pipeline)}`] : []),
  ];
  const steps: ReindexStep[] = [
    {
      kind: 'create',
      title: `Create ${input.target} with the new mapping`,
      request: {
        method: 'PUT',
        path: `/${encodeURIComponent(input.target)}`,
        body: `{${settings !== undefined ? `"settings": ${settings}, ` : ''}"mappings": ${mappings}}`,
      },
    },
    {
      kind: 'reindex',
      title: `Copy the documents from ${input.source} (a server task)`,
      request: {
        method: 'POST',
        path: '/_reindex',
        query: 'wait_for_completion=false',
        body: `{"source": {"index": ${JSON.stringify(input.source)}}, "dest": {${dest.join(', ')}}}`,
      },
    },
    {
      kind: 'refresh',
      title: `Refresh ${input.target}`,
      request: { method: 'POST', path: `/${encodeURIComponent(input.target)}/_refresh` },
    },
  ];
  const cutover = input.cutover;
  if (cutover.kind === 'aliases' && cutover.aliases.length > 0) {
    steps.push({
      kind: 'aliases',
      title: `Move ${cutover.aliases.join(', ')} to ${input.target} in one step`,
      request: {
        method: 'POST',
        path: '/_aliases',
        body: aliasActions(
          cutover.aliases.map((alias) => ({ index: input.target, alias })),
          cutover.aliases.map((alias) => ({ index: input.source, alias })),
        ),
      },
    });
  } else if (cutover.kind === 'replace') {
    steps.push({
      kind: 'aliases',
      title: `Delete ${input.source} and give its name to ${input.target} as an alias, in one step`,
      request: {
        method: 'POST',
        path: '/_aliases',
        body: aliasActions([{ index: input.target, alias: input.source }], [], {
          removeIndices: [input.source],
        }),
      },
      destructive: `deletes ${input.source} and its documents`,
    });
  }
  const consoleText = steps
    .map((step) => {
      const body = step.request.body !== undefined ? formatJson(step.request.body) : undefined;
      return `# ${step.title}\n${formatConsoleRequest({
        method: step.request.method,
        path: step.request.path,
        ...(step.request.query !== undefined ? { query: step.request.query } : {}),
        ...(body !== undefined ? { body } : {}),
        bodyKind: 'json',
      })}`;
    })
    .join('\n\n');
  return { steps, consoleText: `${consoleText}\n` };
}
