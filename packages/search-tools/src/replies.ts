import {
  booleanAt,
  compactJson,
  member,
  nodeAt,
  nodeText,
  numberAt,
  parseJsonTree,
  stringAt,
  type JsonNode,
} from './json';
import type {
  SearchAllocationExplain,
  SearchDiskAllocation,
  SearchNodeDisk,
  SearchRequest,
  SearchResourceInfo,
  SearchResourceKind,
  SearchShardInfo,
  SearchSimulatedDocument,
  SearchSimulatedProcessor,
  SearchSnapshotInfo,
  SearchTaskStatus,
} from './wire';

/**
 * Readers for the administration replies of spec §11 (tasks, shards, allocation explain, disk
 * watermarks, templates, lifecycle policies, pipelines, repositories, snapshots, pipeline
 * simulation) and the requests of the named resources. Shared by the driver, which fetches,
 * and the tests, which feed them recorded replies.
 */

function iso(millis: number | undefined): string | undefined {
  return millis !== undefined && millis > 0 && millis < 8.64e15
    ? new Date(millis).toISOString()
    : undefined;
}

function reasonOf(node: JsonNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'string') return node.value;
  let deepest = stringAt(node, 'reason') ?? stringAt(node, 'type');
  for (let c = member(node, 'caused_by'); c !== undefined; c = member(c, 'caused_by')) {
    deepest = stringAt(c, 'reason') ?? deepest;
  }
  return deepest;
}

function taskOf(
  id: string,
  task: JsonNode,
  extra: { completed: boolean; response?: JsonNode; error?: JsonNode },
): SearchTaskStatus {
  const status = member(task, 'status');
  const started = iso(numberAt(task, 'start_time_in_millis'));
  const nanos = numberAt(task, 'running_time_in_nanos');
  const description = stringAt(task, 'description');
  const response = extra.response;
  const failures = member(response, 'failures');
  const firstFailure = failures?.type === 'array' ? failures.items[0] : undefined;
  const error =
    reasonOf(extra.error) ?? reasonOf(member(firstFailure, 'cause')) ?? reasonOf(firstFailure);
  const progressSource = response ?? status;
  const progress =
    progressSource !== undefined && numberAt(progressSource, 'total') !== undefined
      ? {
          total: numberAt(progressSource, 'total') ?? 0,
          created: numberAt(progressSource, 'created') ?? 0,
          updated: numberAt(progressSource, 'updated') ?? 0,
          deleted: numberAt(progressSource, 'deleted') ?? 0,
          noops: numberAt(progressSource, 'noops') ?? 0,
          versionConflicts: numberAt(progressSource, 'version_conflicts') ?? 0,
          batches: numberAt(progressSource, 'batches') ?? 0,
        }
      : undefined;
  return {
    id,
    action: stringAt(task, 'action') ?? '',
    ...(description !== undefined ? { description } : {}),
    completed: extra.completed,
    cancellable: booleanAt(task, 'cancellable') ?? false,
    // A cancelled by-query or reindex task says so in its response ("canceled": "by user request").
    cancelled:
      (booleanAt(task, 'cancelled') ?? false) || stringAt(response, 'canceled') !== undefined,
    ...(started !== undefined ? { startedAt: started } : {}),
    ...(nanos !== undefined ? { runningTimeMs: Math.round(nanos / 1e6) } : {}),
    ...(progress ? { progress } : {}),
    failures: failures?.type === 'array' ? failures.items.length : 0,
    ...(error !== undefined ? { error } : {}),
  };
}

/** `GET /_tasks/<id>`: the task, whether it completed, its progress and failures. */
export function parseTaskReply(body: string): SearchTaskStatus {
  const root = parseJsonTree(body);
  const task = member(root, 'task');
  const node = stringAt(task, 'node') ?? '';
  const number = nodeAt(task, ['id']);
  const id = `${node}:${number?.type === 'number' ? number.text : ''}`;
  const response = member(root, 'response');
  const error = member(root, 'error');
  return taskOf(id, task ?? root, {
    completed: booleanAt(root, 'completed') ?? false,
    ...(response !== undefined ? { response } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

/** `GET /_tasks?detailed=true` in either grouping (`group_by=none` or by nodes). */
export function parseTaskList(body: string): SearchTaskStatus[] {
  const root = parseJsonTree(body);
  const out: SearchTaskStatus[] = [];
  const add = (task: JsonNode): void => {
    const node = stringAt(task, 'node') ?? '';
    const number = member(task, 'id');
    out.push(
      taskOf(`${node}:${number?.type === 'number' ? number.text : ''}`, task, { completed: false }),
    );
  };
  const tasks = member(root, 'tasks');
  if (tasks?.type === 'array') tasks.items.forEach(add);
  else if (tasks?.type === 'object') tasks.members.forEach((m) => add(m.value));
  const nodes = member(root, 'nodes');
  if (nodes?.type === 'object') {
    for (const n of nodes.members) {
      const list = member(n.value, 'tasks');
      if (list?.type === 'object') list.members.forEach((m) => add(m.value));
    }
  }
  return out.sort((a, b) => (b.runningTimeMs ?? 0) - (a.runningTimeMs ?? 0));
}

/** `_cat/shards?format=json&bytes=b`. */
export function parseShards(body: string): SearchShardInfo[] {
  const root = parseJsonTree(body);
  if (root.type !== 'array') return [];
  return root.items.map((item) => {
    const reason = stringAt(item, 'unassigned.reason');
    return {
      index: stringAt(item, 'index') ?? '',
      shard: numberAt(item, 'shard') ?? 0,
      primary: stringAt(item, 'prirep') === 'p',
      state: stringAt(item, 'state') ?? '',
      node: stringAt(item, 'node') ?? null,
      docs: numberAt(item, 'docs') ?? null,
      storeBytes: numberAt(item, 'store') ?? null,
      ...(reason !== undefined ? { unassignedReason: reason } : {}),
    };
  });
}

/** `POST /_cluster/allocation/explain`, summarised. */
export function parseAllocationExplain(body: string): SearchAllocationExplain {
  const root = parseJsonTree(body);
  const decisions = member(root, 'node_allocation_decisions');
  const explanation =
    stringAt(root, 'allocate_explanation') ??
    stringAt(root, 'rebalance_explanation') ??
    stringAt(root, 'move_explanation');
  const currentNode = stringAt(root, 'current_node', 'name');
  const canAllocate =
    stringAt(root, 'can_allocate') ?? stringAt(root, 'can_remain_on_current_node');
  const reason = stringAt(root, 'unassigned_info', 'reason');
  const details = stringAt(root, 'unassigned_info', 'details');
  return {
    index: stringAt(root, 'index') ?? '',
    shard: numberAt(root, 'shard') ?? 0,
    primary: booleanAt(root, 'primary') ?? false,
    currentState: stringAt(root, 'current_state') ?? '',
    ...(currentNode !== undefined ? { currentNode } : {}),
    ...(explanation !== undefined ? { explanation } : {}),
    ...(canAllocate !== undefined ? { canAllocate } : {}),
    ...(reason !== undefined ? { unassignedReason: reason } : {}),
    ...(details !== undefined ? { unassignedDetails: details } : {}),
    decisions:
      decisions?.type === 'array'
        ? decisions.items.map((d) => {
            const deciders = member(d, 'deciders');
            return {
              node: stringAt(d, 'node_name') ?? stringAt(d, 'node_id') ?? '',
              decision: stringAt(d, 'node_decision') ?? '',
              reasons:
                deciders?.type === 'array'
                  ? deciders.items
                      .filter((x) => stringAt(x, 'decision') !== 'YES')
                      .map(
                        (x) =>
                          `${stringAt(x, 'decider') ?? ''}: ${stringAt(x, 'explanation') ?? ''}`,
                      )
                  : [],
            };
          })
        : [],
    raw: body,
  };
}

const DISK_PREFIX = ['cluster', 'routing', 'allocation', 'disk'];

/**
 * A disk allocation setting (`key` relative to `cluster.routing.allocation.disk`, e.g.
 * "watermark.low"), transient over persistent over the default (which includes the node's
 * elasticsearch.yml). Settings come flat (`flat_settings=true`) or nested, where the server
 * still writes some keys with dots ("flood_stage.max_headroom").
 */
function diskSetting(root: JsonNode, key: string): string | undefined {
  const text = (node: JsonNode | undefined): string | undefined =>
    node?.type === 'string'
      ? node.value
      : node?.type === 'boolean'
        ? String(node.value)
        : node?.type === 'number'
          ? node.text
          : undefined;
  for (const scope of ['transient', 'persistent', 'defaults']) {
    const settings = member(root, scope);
    const flat = text(member(settings, [...DISK_PREFIX, key].join('.')));
    if (flat !== undefined) return flat;
    const disk = nodeAt(settings, DISK_PREFIX);
    const parts = key.split('.');
    // The first part is an object level ("watermark"), the rest may be one dotted key.
    const nested =
      text(member(disk, key)) ??
      text(nodeAt(disk, parts)) ??
      text(member(member(disk, parts[0]!), parts.slice(1).join('.')));
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * The disk watermarks (`GET /_cluster/settings?include_defaults=true`, nested or flat) and
 * each node's disk (`GET /_cat/allocation?format=json&bytes=b`).
 */
export function parseDiskAllocation(
  settingsBody: string,
  allocationBody: string,
): SearchDiskAllocation {
  const settings = parseJsonTree(settingsBody);
  const allocation = parseJsonTree(allocationBody);
  const nodes: SearchNodeDisk[] = [];
  let unassigned = 0;
  if (allocation.type === 'array') {
    for (const item of allocation.items) {
      const node = stringAt(item, 'node') ?? '';
      const shards = numberAt(item, 'shards') ?? 0;
      if (node === 'UNASSIGNED') {
        unassigned += shards;
        continue;
      }
      nodes.push({
        node,
        shards,
        diskUsedBytes: numberAt(item, 'disk.used') ?? null,
        diskAvailableBytes: numberAt(item, 'disk.avail') ?? null,
        diskTotalBytes: numberAt(item, 'disk.total') ?? null,
        diskPercent: numberAt(item, 'disk.percent') ?? null,
      });
    }
  }
  const headroom = {
    low: diskSetting(settings, 'watermark.low.max_headroom'),
    high: diskSetting(settings, 'watermark.high.max_headroom'),
    floodStage: diskSetting(settings, 'watermark.flood_stage.max_headroom'),
  };
  return {
    thresholdEnabled: diskSetting(settings, 'threshold_enabled') !== 'false',
    low: diskSetting(settings, 'watermark.low') ?? '85%',
    high: diskSetting(settings, 'watermark.high') ?? '90%',
    floodStage: diskSetting(settings, 'watermark.flood_stage') ?? '95%',
    ...(headroom.low !== undefined ||
    headroom.high !== undefined ||
    headroom.floodStage !== undefined
      ? {
          maxHeadroom: {
            ...(headroom.low !== undefined ? { low: headroom.low } : {}),
            ...(headroom.high !== undefined ? { high: headroom.high } : {}),
            ...(headroom.floodStage !== undefined ? { floodStage: headroom.floodStage } : {}),
          },
        }
      : {}),
    nodes,
    unassignedShards: unassigned,
  };
}

/**
 * A watermark as the used-disk percentage it stands for ("85%" → 85, "0.9" → 90), or undefined
 * when it is an absolute free-space value ("500mb"), which depends on the disk's size.
 */
export function watermarkPercent(value: string): number | undefined {
  const text = value.trim();
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (percent) return Number(percent[1]);
  const ratio = /^(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(text);
  if (ratio) return Number(ratio[1]) * 100;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Named resources

/** Where a resource kind lives. */
export function resourcePath(kind: SearchResourceKind, name?: string): string {
  const tail = name === undefined ? '' : `/${encodeURIComponent(name)}`;
  switch (kind) {
    case 'index-template':
      return `/_index_template${tail}`;
    case 'component-template':
      return `/_component_template${tail}`;
    case 'legacy-template':
      return `/_template${tail}`;
    case 'lifecycle-policy':
      return `/_ilm/policy${tail}`;
    case 'ingest-pipeline':
      return `/_ingest/pipeline${tail}`;
    case 'snapshot-repository':
      return `/_snapshot${tail}`;
  }
}

/** The request that creates or replaces a resource with `body` (the JSON its PUT takes). */
export function resourcePutRequest(
  kind: SearchResourceKind,
  name: string,
  body: string,
): SearchRequest {
  return { method: 'PUT', path: resourcePath(kind, name), body };
}

/** Members the server adds that its PUT refuses. */
const READ_ONLY_MEMBERS = new Set([
  'created_date',
  'created_date_millis',
  'modified_date',
  'modified_date_millis',
]);

/** An object's text without the read-only members (compact JSON, other tokens untouched). */
function editable(text: string, node: JsonNode): string {
  if (node.type !== 'object') return compactJson(nodeText(text, node));
  return `{${node.members
    .filter((m) => !READ_ONLY_MEMBERS.has(m.key))
    .map((m) => `${JSON.stringify(m.key)}:${compactJson(nodeText(text, m.value))}`)
    .join(',')}}`;
}

/** A string or an array of strings as "a, b". */
function list(node: JsonNode | undefined): string {
  if (node?.type === 'array') {
    return node.items.flatMap((i) => (i.type === 'string' ? [i.value] : [])).join(', ');
  }
  return node?.type === 'string' ? node.value : '';
}

function keysOf(node: JsonNode | undefined): string {
  return node?.type === 'object' ? node.members.map((m) => m.key).join(', ') : '';
}

function summaryOf(
  pairs: readonly (readonly [string, string | undefined])[],
): SearchResourceInfo['summary'] {
  return pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined && pair[1] !== '')
    .map(([label, value]) => ({ label, value }));
}

/**
 * The resources of a kind from its list reply (`GET /_index_template`, `/_ilm/policy`,
 * `/_ingest/pipeline`, `/_snapshot`...), sorted by name. Hidden (dot-prefixed) resources are
 * left out unless `includeHidden`.
 */
export function parseResources(
  kind: SearchResourceKind,
  body: string,
  options: { readonly includeHidden?: boolean } = {},
): SearchResourceInfo[] {
  const root = parseJsonTree(body);
  const out: SearchResourceInfo[] = [];
  const push = (info: SearchResourceInfo): void => {
    if (!options.includeHidden && info.name.startsWith('.')) return;
    out.push(info);
  };
  switch (kind) {
    case 'index-template':
    case 'component-template': {
      const key = kind === 'index-template' ? 'index_templates' : 'component_templates';
      const inner = kind === 'index-template' ? 'index_template' : 'component_template';
      const items = member(root, key);
      if (items?.type !== 'array') break;
      for (const item of items.items) {
        const template = member(item, inner);
        if (!template) continue;
        const parts = member(template, 'template');
        push({
          kind,
          name: stringAt(item, 'name') ?? '',
          summary:
            kind === 'index-template'
              ? summaryOf([
                  ['Index patterns', list(member(template, 'index_patterns'))],
                  ['Priority', numberAt(template, 'priority')?.toString()],
                  ['Composed of', list(member(template, 'composed_of'))],
                  ['Data stream', member(template, 'data_stream') ? 'yes' : undefined],
                ])
              : summaryOf([
                  ['Defines', keysOf(parts)],
                  ['Version', numberAt(template, 'version')?.toString()],
                ]),
          body: editable(body, template),
        });
      }
      break;
    }
    case 'legacy-template':
    case 'ingest-pipeline':
    case 'snapshot-repository': {
      if (root.type !== 'object') break;
      for (const m of root.members) {
        const value = m.value;
        const processors = member(value, 'processors');
        push({
          kind,
          name: m.key,
          summary:
            kind === 'legacy-template'
              ? summaryOf([
                  ['Index patterns', list(member(value, 'index_patterns'))],
                  ['Order', numberAt(value, 'order')?.toString()],
                ])
              : kind === 'ingest-pipeline'
                ? summaryOf([
                    ['Description', stringAt(value, 'description')],
                    [
                      'Processors',
                      processors?.type === 'array'
                        ? processors.items
                            .map((p) => (p.type === 'object' ? (p.members[0]?.key ?? '') : ''))
                            .join(', ')
                        : undefined,
                    ],
                  ])
                : summaryOf([
                    ['Type', stringAt(value, 'type')],
                    [
                      'Location',
                      stringAt(value, 'settings', 'location') ??
                        stringAt(value, 'settings', 'url') ??
                        stringAt(value, 'settings', 'bucket') ??
                        stringAt(value, 'settings', 'container'),
                    ],
                  ]),
          body: editable(body, value),
        });
      }
      break;
    }
    case 'lifecycle-policy': {
      if (root.type !== 'object') break;
      for (const m of root.members) {
        const policy = member(m.value, 'policy');
        if (!policy) continue;
        const inUse = member(member(m.value, 'in_use_by'), 'indices');
        push({
          kind,
          name: m.key,
          summary: summaryOf([
            ['Phases', keysOf(member(policy, 'phases'))],
            ['Used by', inUse?.type === 'array' ? `${inUse.items.length} indices` : undefined],
            ['Version', numberAt(m.value, 'version')?.toString()],
          ]),
          body: `{"policy":${editable(body, policy)}}`,
        });
      }
      break;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Snapshots

/** `GET /_snapshot/<repository>/_all`: newest first. */
export function parseSnapshots(body: string): SearchSnapshotInfo[] {
  const root = parseJsonTree(body);
  const snapshots = member(root, 'snapshots');
  if (snapshots?.type !== 'array') return [];
  const strings = (node: JsonNode | undefined): string[] =>
    node?.type === 'array' ? node.items.flatMap((i) => (i.type === 'string' ? [i.value] : [])) : [];
  return snapshots.items
    .map((item) => {
      const uuid = stringAt(item, 'uuid');
      const startedAt = iso(numberAt(item, 'start_time_in_millis'));
      const endedAt = iso(numberAt(item, 'end_time_in_millis'));
      const duration = numberAt(item, 'duration_in_millis');
      return {
        snapshot: stringAt(item, 'snapshot') ?? '',
        ...(uuid !== undefined ? { uuid } : {}),
        state: stringAt(item, 'state') ?? '',
        indices: strings(member(item, 'indices')).sort(),
        dataStreams: strings(member(item, 'data_streams')).sort(),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(duration !== undefined ? { durationMs: duration } : {}),
        shardsTotal: numberAt(item, 'shards', 'total') ?? 0,
        shardsFailed: numberAt(item, 'shards', 'failed') ?? 0,
      };
    })
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

export interface SnapshotOptions {
  /** Index names or patterns; all indices when empty. */
  readonly indices?: readonly string[];
  readonly includeGlobalState?: boolean;
  readonly ignoreUnavailable?: boolean;
}

/** The body of `PUT /_snapshot/<repository>/<snapshot>`. */
export function snapshotBody(options: SnapshotOptions): string {
  return `{${[
    ...(options.indices && options.indices.length > 0
      ? [`"indices": ${JSON.stringify(options.indices.join(','))}`]
      : []),
    `"include_global_state": ${options.includeGlobalState ?? false}`,
    `"ignore_unavailable": ${options.ignoreUnavailable ?? true}`,
  ].join(', ')}}`;
}

export interface RestoreOptions {
  readonly indices?: readonly string[];
  /** A regular expression over index names, e.g. "(.+)". */
  readonly renamePattern?: string;
  /** Its replacement, e.g. "restored-$1". */
  readonly renameReplacement?: string;
  readonly includeGlobalState?: boolean;
  readonly includeAliases?: boolean;
}

/** The body of `POST /_snapshot/<repository>/<snapshot>/_restore`. */
export function restoreBody(options: RestoreOptions): string {
  const rename =
    options.renamePattern !== undefined &&
    options.renamePattern !== '' &&
    options.renameReplacement !== undefined
      ? [
          `"rename_pattern": ${JSON.stringify(options.renamePattern)}`,
          `"rename_replacement": ${JSON.stringify(options.renameReplacement)}`,
        ]
      : [];
  return `{${[
    ...(options.indices && options.indices.length > 0
      ? [`"indices": ${JSON.stringify(options.indices.join(','))}`]
      : []),
    ...rename,
    `"include_global_state": ${options.includeGlobalState ?? false}`,
    `"include_aliases": ${options.includeAliases ?? false}`,
  ].join(', ')}}`;
}

/**
 * The names a restore gives the indices: each matching `pattern` renamed with `replacement`
 * (Java's `$1` group syntax), the others unchanged. Undefined for an invalid pattern.
 */
export function restoredNames(
  indices: readonly string[],
  pattern: string | undefined,
  replacement: string | undefined,
): string[] | undefined {
  if (pattern === undefined || pattern === '' || replacement === undefined) return [...indices];
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return undefined;
  }
  return indices.map((index) => index.replace(re, replacement));
}

// ---------------------------------------------------------------------------------------------
// Ingest pipeline simulation

/** The body of `POST /_ingest/pipeline/_simulate`: a pipeline (or none, with an id) and docs. */
export function simulateBody(pipeline: string | undefined, docs: string): string {
  const root = parseJsonTree(docs);
  const items = root.type === 'array' ? root.items : [root];
  const wrapped = items.map((item) => {
    // Accept bare sources as well as {"_source": ...} (with _index, _id...).
    const text = compactJson(nodeText(docs, item));
    return member(item, '_source') !== undefined ? text : `{"_source":${text}}`;
  });
  return `{${pipeline !== undefined ? `"pipeline": ${compactJson(pipeline)}, ` : ''}"docs": [${wrapped.join(', ')}]}`;
}

function simulatedSource(text: string, doc: JsonNode | undefined): string | undefined {
  const source = member(doc, '_source');
  return source ? nodeText(text, source) : undefined;
}

/** A simulate reply (verbose or not), one entry per document. */
export function parseSimulation(body: string): SearchSimulatedDocument[] {
  const root = parseJsonTree(body);
  const docs = member(root, 'docs');
  if (docs?.type !== 'array') return [];
  return docs.items.map((item) => {
    const results = member(item, 'processor_results');
    if (results?.type === 'array') {
      const processors: SearchSimulatedProcessor[] = results.items.map((r) => {
        const tag = stringAt(r, 'tag');
        const error = reasonOf(member(r, 'error'));
        const source = simulatedSource(body, member(r, 'doc'));
        return {
          processor: stringAt(r, 'processor_type') ?? '',
          ...(tag !== undefined ? { tag } : {}),
          status: stringAt(r, 'status') ?? (error !== undefined ? 'error' : 'success'),
          ...(error !== undefined ? { error } : {}),
          ...(source !== undefined ? { source } : {}),
        };
      });
      const last = [...processors].reverse().find((p) => p.source !== undefined);
      const failed = processors.find((p) => p.status === 'error');
      const dropped = processors.some((p) => p.status === 'dropped');
      return {
        ...(last?.source !== undefined && !failed && !dropped ? { source: last.source } : {}),
        ...(failed?.error !== undefined ? { error: failed.error } : {}),
        dropped,
        processors,
      };
    }
    const error = reasonOf(member(item, 'error'));
    const source = simulatedSource(body, member(item, 'doc'));
    return {
      ...(source !== undefined ? { source } : {}),
      ...(error !== undefined ? { error } : {}),
      dropped: item.type === 'null' || (source === undefined && error === undefined),
      processors: [],
    };
  });
}
