import { QuerybaraError } from '@querybara/core';
import {
  compactJson,
  parseAllocationExplain,
  parseDiskAllocation,
  parseJsonTree,
  parseResources,
  parseShards,
  parseSimulation,
  parseSnapshots,
  parseTaskList,
  parseTaskReply,
  resourcePath,
  resourcePutRequest,
  restoreBody,
  simulateBody,
  snapshotBody,
  stringAt,
  type SearchAllocationExplain,
  type SearchDiskAllocation,
  type SearchResourceInfo,
  type SearchResourceKind,
  type SearchShardInfo,
  type SearchSimulatedDocument,
  type SearchSnapshotInfo,
  type SearchTaskStatus,
} from '@querybara/search-tools';

import { queryString, segment, type SearchContext } from './context';
import { mapResponseError } from './errors';
import { assertJsonObject } from './indices';
import type {
  ReindexOptions,
  ResizeOptions,
  SearchOpOptions,
  SimulatePipelineOptions,
  SnapshotCreateOptions,
  SnapshotRestoreOptions,
} from './types';

/**
 * Administration services (spec §11): resizing indices (clone, shrink, split), reindex as a
 * server task and the Tasks API, shard allocation with its explanation and the disk
 * watermarks, the named resources (index and component templates, ILM or ISM policies, ingest
 * pipelines, snapshot repositories), pipeline simulation, and snapshots. Replies are read by
 * @querybara/search-tools, which the tests feed recorded replies too.
 */

// ---------------------------------------------------------------------------------------------
// Resize and reindex

export async function resizeIndex(
  ctx: SearchContext,
  kind: 'clone' | 'shrink' | 'split',
  source: string,
  target: string,
  opts: ResizeOptions = {},
): Promise<void> {
  if (kind === 'clone' && !ctx.facts.capabilities.cloneIndex) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'This cluster cannot clone indices (Elasticsearch 7.4 and later can)',
    });
  }
  if (opts.settings !== undefined && opts.settings.trim() !== '') {
    assertJsonObject(opts.settings, 'settings');
  }
  if (opts.aliases !== undefined && opts.aliases.trim() !== '') {
    assertJsonObject(opts.aliases, 'aliases');
  }
  const prepare: string[] = [];
  if (opts.blockSource) prepare.push('"index.blocks.write": true');
  if (kind === 'shrink' && opts.gatherOnNode) {
    prepare.push(`"index.routing.allocation.require._name": ${JSON.stringify(opts.gatherOnNode)}`);
  }
  if (prepare.length > 0) {
    await ctx.call(
      { method: 'PUT', path: `/${segment(source)}/_settings`, body: `{${prepare.join(', ')}}` },
      opts,
    );
    if (kind === 'shrink' && opts.gatherOnNode) {
      // The shard copies move to the node first; shrinking needs them there.
      await ctx.call(
        {
          method: 'GET',
          path: `/_cluster/health/${segment(source)}`,
          query: 'wait_for_no_relocating_shards=true&timeout=120s',
        },
        opts,
      );
    }
  }
  // The new index inherits the source's settings; it must not inherit the block and the pin.
  const extra = [
    '"index.blocks.write": null',
    ...(kind === 'shrink' ? ['"index.routing.allocation.require._name": null'] : []),
  ];
  const settings =
    opts.settings !== undefined && opts.settings.trim() !== ''
      ? `{${[...extra, compactJson(opts.settings).slice(1, -1)].filter((s) => s !== '').join(', ')}}`
      : `{${extra.join(', ')}}`;
  const body = `{"settings": ${settings}${
    opts.aliases !== undefined && opts.aliases.trim() !== '' ? `, "aliases": ${opts.aliases}` : ''
  }}`;
  await ctx.call(
    { method: 'POST', path: `/${segment(source)}/_${kind}/${segment(target)}`, body },
    opts,
  );
  if (opts.unblockSource) {
    await ctx.call(
      {
        method: 'PUT',
        path: `/${segment(source)}/_settings`,
        body:
          kind === 'shrink' && opts.gatherOnNode
            ? '{"index.blocks.write": null, "index.routing.allocation.require._name": null}'
            : '{"index.blocks.write": null}',
      },
      opts,
    );
  }
}

export async function startReindex(
  ctx: SearchContext,
  opts: ReindexOptions,
): Promise<{ taskId: string }> {
  if (opts.source.length === 0) {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Name the index to copy from' });
  }
  if (opts.query !== undefined && opts.query.trim() !== '') assertJsonObject(opts.query, 'query');
  const source = [
    `"index": ${JSON.stringify(opts.source.length === 1 ? opts.source[0] : opts.source)}`,
    ...(opts.query !== undefined && opts.query.trim() !== '' ? [`"query": ${opts.query}`] : []),
  ];
  const dest = [
    `"index": ${JSON.stringify(opts.dest)}`,
    ...(opts.pipeline ? [`"pipeline": ${JSON.stringify(opts.pipeline)}`] : []),
    ...(opts.opType ? [`"op_type": ${JSON.stringify(opts.opType)}`] : []),
  ];
  const body = `{${[
    `"source": {${source.join(', ')}}`,
    `"dest": {${dest.join(', ')}}`,
    ...(opts.conflicts ? [`"conflicts": ${JSON.stringify(opts.conflicts)}`] : []),
    ...(opts.maxDocs !== undefined ? [`"max_docs": ${opts.maxDocs}`] : []),
  ].join(', ')}}`;
  const { node } = await ctx.json(
    {
      method: 'POST',
      path: '/_reindex',
      query: queryString({
        wait_for_completion: false,
        requests_per_second: opts.requestsPerSecond,
        slices: opts.slices,
      }),
      body,
    },
    opts,
  );
  const task = stringAt(node, 'task');
  if (task === undefined) {
    throw new QuerybaraError({
      code: 'INTERNAL',
      message: 'The reindex answered without a task id',
    });
  }
  return { taskId: task };
}

// ---------------------------------------------------------------------------------------------
// Tasks

function taskPath(taskId: string): string {
  if (!/^[^:/\s]+:\d+$/.test(taskId)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${taskId}" is not a task id (node:number)`,
    });
  }
  return `/_tasks/${encodeURIComponent(taskId)}`;
}

export async function getTask(
  ctx: SearchContext,
  taskId: string,
  opts: SearchOpOptions = {},
): Promise<SearchTaskStatus> {
  const { text } = await ctx.json({ method: 'GET', path: taskPath(taskId) }, opts);
  const status = parseTaskReply(text);
  return status.id === ':' ? { ...status, id: taskId } : status;
}

export async function listTasks(
  ctx: SearchContext,
  opts: SearchOpOptions & { readonly actions?: string } = {},
): Promise<SearchTaskStatus[]> {
  const { text } = await ctx.json(
    {
      method: 'GET',
      path: '/_tasks',
      query: queryString({ detailed: true, group_by: 'none', actions: opts.actions }),
    },
    opts,
  );
  return parseTaskList(text);
}

export async function cancelTask(
  ctx: SearchContext,
  taskId: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  await ctx.call({ method: 'POST', path: `${taskPath(taskId)}/_cancel` }, opts);
}

// ---------------------------------------------------------------------------------------------
// Allocation

export async function shards(
  ctx: SearchContext,
  opts: SearchOpOptions & { readonly index?: string } = {},
): Promise<SearchShardInfo[]> {
  const { text } = await ctx.json(
    {
      method: 'GET',
      path: opts.index ? `/_cat/shards/${segment(opts.index)}` : '/_cat/shards',
      query: queryString({
        format: 'json',
        bytes: 'b',
        h: 'index,shard,prirep,state,docs,store,node,unassigned.reason',
        s: 'index,shard,prirep',
      }),
    },
    opts,
  );
  return parseShards(text);
}

export async function allocationExplain(
  ctx: SearchContext,
  shard: { readonly index: string; readonly shard: number; readonly primary: boolean } | undefined,
  opts: SearchOpOptions = {},
): Promise<SearchAllocationExplain> {
  const request = {
    method: 'POST',
    path: '/_cluster/allocation/explain',
    ...(shard
      ? {
          body: `{"index": ${JSON.stringify(shard.index)}, "shard": ${shard.shard}, "primary": ${shard.primary}}`,
        }
      : {}),
  };
  const response = await ctx.send(request, opts);
  if (
    response.status === 400 &&
    !shard &&
    /no unassigned shards|unable to find any unassigned shards/i.test(response.body)
  ) {
    throw new QuerybaraError({
      code: 'NOT_FOUND',
      message: 'Every shard is assigned: there is nothing to explain',
      hint: 'Pick a shard to see why it is where it is',
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw mapResponseError(response.status, response.body, ctx.errorContext());
  }
  return parseAllocationExplain(response.body);
}

export async function diskAllocation(
  ctx: SearchContext,
  opts: SearchOpOptions = {},
): Promise<SearchDiskAllocation> {
  const [settings, allocation] = await Promise.all([
    ctx.json(
      {
        method: 'GET',
        path: '/_cluster/settings',
        query: 'include_defaults=true&filter_path=*.cluster.routing.allocation.disk',
      },
      opts,
    ),
    ctx.json({ method: 'GET', path: '/_cat/allocation', query: 'format=json&bytes=b' }, opts),
  ]);
  return parseDiskAllocation(settings.text, allocation.text);
}

// ---------------------------------------------------------------------------------------------
// Named resources

/** Refuses a resource kind the cluster does not have. */
function checkKind(ctx: SearchContext, kind: SearchResourceKind): void {
  if (kind === 'lifecycle-policy' && !ctx.facts.capabilities.lifecycle) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'This cluster has no index lifecycle management (the OSS distribution lacks it)',
    });
  }
  if (
    (kind === 'index-template' || kind === 'component-template') &&
    !ctx.facts.capabilities.composableTemplates
  ) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message:
        'This cluster has only legacy index templates (Elasticsearch 7.8 added composable ones)',
    });
  }
}

function resourceName(name: string): string {
  if (name === '' || /[\s/\\*?"<>|,#]/.test(name)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `"${name}" is not a valid name: no spaces, slashes, commas or wildcards`,
    });
  }
  return name;
}

export async function listResources(
  ctx: SearchContext,
  kind: SearchResourceKind,
  opts: SearchOpOptions & { readonly includeHidden?: boolean } = {},
): Promise<SearchResourceInfo[]> {
  checkKind(ctx, kind);
  const request = { method: 'GET', path: resourcePath(kind) };
  const response = await ctx.send(request, opts);
  // Some list endpoints answer 404 while nothing of the kind exists yet.
  if (response.status === 404) return [];
  if (response.status < 200 || response.status >= 300) {
    throw mapResponseError(response.status, response.body, ctx.errorContext());
  }
  return parseResources(kind, response.body, {
    ...(opts.includeHidden !== undefined ? { includeHidden: opts.includeHidden } : {}),
  });
}

export async function putResource(
  ctx: SearchContext,
  kind: SearchResourceKind,
  name: string,
  body: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  checkKind(ctx, kind);
  assertJsonObject(body, 'definition');
  const request = resourcePutRequest(kind, resourceName(name), body);
  await ctx.call({ method: request.method, path: request.path, body }, opts);
}

export async function deleteResource(
  ctx: SearchContext,
  kind: SearchResourceKind,
  name: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  checkKind(ctx, kind);
  await ctx.call({ method: 'DELETE', path: resourcePath(kind, resourceName(name)) }, opts);
}

export async function simulatePipeline(
  ctx: SearchContext,
  pipeline: string | undefined,
  docs: string,
  opts: SimulatePipelineOptions = {},
): Promise<SearchSimulatedDocument[]> {
  if (pipeline !== undefined) assertJsonObject(pipeline, 'pipeline');
  try {
    parseJsonTree(docs);
  } catch (error) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The documents are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (pipeline === undefined && opts.id === undefined) {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Give a pipeline to simulate' });
  }
  const { text } = await ctx.json(
    {
      method: 'POST',
      path:
        pipeline === undefined
          ? `/_ingest/pipeline/${segment(opts.id!)}/_simulate`
          : '/_ingest/pipeline/_simulate',
      query: queryString({ verbose: opts.verbose }),
      body: simulateBody(pipeline, docs),
    },
    opts,
  );
  return parseSimulation(text);
}

// ---------------------------------------------------------------------------------------------
// Snapshots

export async function listSnapshots(
  ctx: SearchContext,
  repository: string,
  opts: SearchOpOptions = {},
): Promise<SearchSnapshotInfo[]> {
  const { text } = await ctx.json(
    { method: 'GET', path: `/_snapshot/${segment(repository)}/_all` },
    opts,
  );
  return parseSnapshots(text);
}

export async function createSnapshot(
  ctx: SearchContext,
  repository: string,
  snapshot: string,
  opts: SnapshotCreateOptions = {},
): Promise<void> {
  await ctx.call(
    {
      method: 'PUT',
      path: `/_snapshot/${segment(repository)}/${segment(snapshot)}`,
      query: queryString({ wait_for_completion: opts.waitForCompletion ?? false }),
      body: snapshotBody({
        ...(opts.indices ? { indices: opts.indices } : {}),
        ...(opts.includeGlobalState !== undefined
          ? { includeGlobalState: opts.includeGlobalState }
          : {}),
        ...(opts.ignoreUnavailable !== undefined
          ? { ignoreUnavailable: opts.ignoreUnavailable }
          : {}),
      }),
    },
    opts,
  );
}

export async function restoreSnapshot(
  ctx: SearchContext,
  repository: string,
  snapshot: string,
  opts: SnapshotRestoreOptions = {},
): Promise<void> {
  await ctx.call(
    {
      method: 'POST',
      path: `/_snapshot/${segment(repository)}/${segment(snapshot)}/_restore`,
      query: queryString({ wait_for_completion: opts.waitForCompletion ?? false }),
      body: restoreBody({
        ...(opts.indices ? { indices: opts.indices } : {}),
        ...(opts.renamePattern !== undefined ? { renamePattern: opts.renamePattern } : {}),
        ...(opts.renameReplacement !== undefined
          ? { renameReplacement: opts.renameReplacement }
          : {}),
        ...(opts.includeGlobalState !== undefined
          ? { includeGlobalState: opts.includeGlobalState }
          : {}),
        ...(opts.includeAliases !== undefined ? { includeAliases: opts.includeAliases } : {}),
      }),
    },
    opts,
  );
}

export async function deleteSnapshot(
  ctx: SearchContext,
  repository: string,
  snapshot: string,
  opts: SearchOpOptions = {},
): Promise<void> {
  await ctx.call(
    { method: 'DELETE', path: `/_snapshot/${segment(repository)}/${segment(snapshot)}` },
    opts,
  );
}

export async function verifyRepository(
  ctx: SearchContext,
  repository: string,
  opts: SearchOpOptions = {},
): Promise<string[]> {
  const { node } = await ctx.json(
    { method: 'POST', path: `/_snapshot/${segment(repository)}/_verify` },
    opts,
  );
  const nodes =
    node.type === 'object' ? node.members.find((m) => m.key === 'nodes')?.value : undefined;
  return nodes?.type === 'object'
    ? nodes.members.map((m) => stringAt(m.value, 'name') ?? m.key)
    : [];
}
