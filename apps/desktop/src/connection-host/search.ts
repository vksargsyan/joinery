import {
  JoineryError,
  type ConnectionProfile,
  type ExecOptions,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import type { SearchSession, isSearchSession } from '@joinery/driver-elasticsearch';
import type { HandlersOf, searchHostContractShape } from '@joinery/ipc';
import {
  classifyRequest,
  issuesOf,
  parseConsole,
  resourcePath,
  sqlRequest,
  type SearchResourceKind,
} from '@joinery/search-tools';

import {
  checkSearchWrite,
  decideSearchRequest,
  type SearchWritePolicy,
} from '../shared/search-writes';

/**
 * The connection host's `search.*` handlers (spec §11): each finds the call's session, checks
 * it is an Elasticsearch or OpenSearch session and calls the matching SearchSession service.
 * JSON text passes through untouched.
 *
 * The write rules (spec §4) are enforced here whatever the page sends (shared/search-writes):
 * read-only profiles refuse every write, destructive and blocking operations (deletes, close,
 * force merge, restores, a write block on a resize's source) need the page's `confirmed` on
 * every profile, and production (or confirm-writes) profiles need it for every write. The
 * console's raw requests and SQL statements are classified by method, path and body; reads
 * (searches, SQL SELECT, ES|QL, explanations, simulations) always run.
 */

type SearchHandlers = HandlersOf<typeof searchHostContractShape>;

export interface SearchHandlerContext {
  /** The session a call names; throws NOT_FOUND when it was closed. */
  readonly session: (sessionId: string) => Session;
  readonly profile: ConnectionProfile;
  readonly policy: SearchWritePolicy;
}

let isSearch: Promise<typeof isSearchSession> | undefined;

/**
 * A session as a SearchSession, or NOT_SUPPORTED. The driver is imported on demand (a host only
 * loads its own engine's driver); by the time such a session exists it is loaded.
 */
export async function asSearchSession(session: Session): Promise<SearchSession> {
  if (session.engine !== 'elasticsearch' && session.engine !== 'opensearch') throw notSearch();
  isSearch ??= import('@joinery/driver-elasticsearch').then((driver) => driver.isSearchSession);
  if (!(await isSearch)(session)) throw notSearch();
  return session;
}

function notSearch(): JoineryError {
  return new JoineryError({
    code: 'NOT_SUPPORTED',
    message: 'Elasticsearch services need an Elasticsearch or OpenSearch connection',
  });
}

/** Drops undefined values, so optional inputs are left out of the driver's options. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

const WRITE = { writes: true } as const;

function destructive(reason: string): { writes: true; destructive: string } {
  return { writes: true, destructive: reason };
}

function names(list: readonly string[]): string {
  return list.length === 1 ? list[0]! : `${list.length} indices`;
}

/**
 * The generic `execute` (the CLI's and a query tab's path) under the write rules: every request
 * of the console text is classified first; a refused one stops the run with READ_ONLY, one that
 * needs confirmation with CONFIRMATION_REQUIRED (the console asks, then sends it through
 * `search.request` with `confirmed`).
 */
export async function* executeSearchGuarded(
  session: Session,
  text: string,
  opts: ExecOptions,
  policy: SearchWritePolicy,
): AsyncGenerator<ResultChunk> {
  const parse = parseConsole(text);
  for (const request of parse.requests) {
    if (request.invalid) {
      const issue = issuesOf(parse, request)[0];
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: issue?.message ?? 'The request is not valid',
        ...(issue ? { position: issue.start } : {}),
      });
    }
    const decision = decideSearchRequest(
      {
        method: request.method,
        path: request.path,
        ...(request.body !== undefined ? { body: request.body } : {}),
      },
      policy,
    );
    if (decision.action === 'refuse') {
      throw new JoineryError({
        code: 'READ_ONLY',
        message: `${decision.safety.label}: ${decision.reason}`,
      });
    }
    if (decision.action === 'confirm') {
      throw new JoineryError({
        code: 'CONFIRMATION_REQUIRED',
        message: `${decision.safety.label} needs confirmation`,
        hint: 'Run it from the console, which asks first',
      });
    }
  }
  yield* session.execute(text, opts);
}

export function searchHandlers(context: SearchHandlerContext): SearchHandlers {
  const { policy } = context;
  const session = (sessionId: string): Promise<SearchSession> =>
    asSearchSession(context.session(sessionId));
  const write = (
    confirmed: boolean | undefined,
    what: string,
    operation: { readonly writes: boolean; readonly destructive?: string } = WRITE,
  ): void => checkSearchWrite(policy, operation, confirmed, what);

  return {
    clusterInfo: async ({ sessionId }, { signal }) =>
      (await session(sessionId)).clusterInfo({ signal }),
    clusterHealth: async ({ sessionId, index }, { signal }) =>
      (await session(sessionId)).clusterHealth(defined({ index, signal })),
    nodes: async ({ sessionId }, { signal }) => (await session(sessionId)).nodes({ signal }),
    nodeStats: async ({ sessionId, metrics }, { signal }) =>
      (await session(sessionId)).nodeStats(defined({ metrics, signal })),

    indices: {
      list: async ({ sessionId, pattern, includeHidden }, { signal }) =>
        (await session(sessionId)).listIndices(defined({ pattern, includeHidden, signal })),
      create: async ({ sessionId, name, body, confirmed }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, `Creating the index ${name}`);
        await s.createIndex(name, body, { signal });
      },
      delete: async ({ sessionId, names: list, confirmed, executionId, timeoutMs }, { signal }) => {
        const s = await session(sessionId);
        write(
          confirmed,
          `Deleting ${names(list)}`,
          destructive('deletes the indices and all their documents'),
        );
        await s.deleteIndices(list, defined({ executionId, timeoutMs, signal }));
      },
      open: async ({ sessionId, names: list, confirmed, executionId, timeoutMs }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, `Opening ${names(list)}`);
        await s.openIndices(list, defined({ executionId, timeoutMs, signal }));
      },
      close: async ({ sessionId, names: list, confirmed, executionId, timeoutMs }, { signal }) => {
        const s = await session(sessionId);
        write(
          confirmed,
          `Closing ${names(list)}`,
          destructive('closes indices: they cannot be searched or written until reopened'),
        );
        await s.closeIndices(list, defined({ executionId, timeoutMs, signal }));
      },
      refresh: async (
        { sessionId, names: list, confirmed, executionId, timeoutMs },
        { signal },
      ) => {
        const s = await session(sessionId);
        write(confirmed, `Refreshing ${names(list)}`);
        await s.refresh(list, defined({ executionId, timeoutMs, signal }));
      },
      flush: async ({ sessionId, names: list, confirmed, executionId, timeoutMs }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, `Flushing ${names(list)}`);
        await s.flush(list, defined({ executionId, timeoutMs, signal }));
      },
      forceMerge: async (input, { signal }) => {
        const { sessionId, names: list, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(
          confirmed,
          `Force-merging ${names(list)}`,
          destructive('force-merges segments: heavy I/O, and deleted documents are gone for good'),
        );
        await s.forceMerge(list, defined({ ...options, signal }));
      },
      getMapping: async ({ sessionId, index }, { signal }) =>
        (await session(sessionId)).getMapping(index, { signal }),
      putMapping: async ({ sessionId, index, body, confirmed }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, `Changing the mapping of ${index}`);
        await s.putMapping(index, body, { signal });
      },
      getSettings: async ({ sessionId, index, includeDefaults, flatSettings }, { signal }) =>
        (await session(sessionId)).getSettings(
          index,
          defined({ includeDefaults, flatSettings, signal }),
        ),
      putSettings: async ({ sessionId, index, body, confirmed }, { signal }) => {
        const s = await session(sessionId);
        // Turning on a block (write, read, read_only...) is blocking: it always asks.
        write(
          confirmed,
          `Changing the settings of ${index}`,
          classifyRequest({ method: 'PUT', path: `/${index}/_settings`, body }),
        );
        await s.putSettings(index, body, { signal });
      },
    },

    aliases: {
      list: async ({ sessionId, includeHidden }, { signal }) =>
        (await session(sessionId)).listAliases(defined({ includeHidden, signal })),
      update: async ({ sessionId, actions, confirmed }, { signal }) => {
        const s = await session(sessionId);
        // A remove_index action deletes an index: classified like the request it sends.
        write(
          confirmed,
          'Changing aliases',
          classifyRequest({ method: 'POST', path: '/_aliases', body: actions }),
        );
        await s.updateAliases(actions, { signal });
      },
    },

    dataStreams: {
      list: async ({ sessionId, includeHidden }, { signal }) =>
        (await session(sessionId)).listDataStreams(defined({ includeHidden, signal })),
    },

    documents: {
      async *search({ sessionId, target, body, ...options }, { signal }) {
        const s = await session(sessionId);
        yield* s.search(target, body, defined({ ...options, signal }));
      },
      count: async ({ sessionId, target, query, executionId }, { signal }) => ({
        count: await (
          await session(sessionId)
        ).count(target, query, defined({ executionId, signal })),
      }),
      get: async ({ sessionId, index, id, routing }, { signal }) =>
        (await session(sessionId)).getDocument(index, id, defined({ routing, signal })),
      index: async (input, { signal }) => {
        const { sessionId, index, source, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(confirmed, `Indexing a document into ${index}`);
        return s.indexDocument(index, source, defined({ ...options, signal }));
      },
      update: async (input, { signal }) => {
        const { sessionId, index, id, doc, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(confirmed, `Updating the document ${id} in ${index}`);
        return s.updateDocument(index, id, doc, defined({ ...options, signal }));
      },
      delete: async (input, { signal }) => {
        const { sessionId, index, id, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(
          confirmed,
          `Deleting the document ${id} from ${index}`,
          destructive('deletes the document'),
        );
        return s.deleteDocument(index, id, defined({ ...options, signal }));
      },
      bulk: async (input, { signal }) => {
        const { sessionId, ndjson, confirmed, ...options } = input;
        const s = await session(sessionId);
        const safety = classifyRequest({ method: 'POST', path: '/_bulk', body: ndjson });
        write(confirmed, 'A bulk request', safety);
        return s.bulk(ndjson, defined({ ...options, signal }));
      },
      deleteByQuery: async (input, { signal }) => {
        const { sessionId, target, query, confirmed, dryRun, ...options } = input;
        const s = await session(sessionId);
        if (dryRun !== true) {
          write(
            confirmed,
            `Deleting by query from ${target}`,
            destructive('deletes every document the query matches'),
          );
        }
        return s.deleteByQuery(target, query, defined({ ...options, dryRun, signal }));
      },
    },

    request: async (
      { sessionId, request, confirmed, maxBytes, executionId, timeoutMs },
      { signal },
    ) => {
      const s = await session(sessionId);
      const safety = classifyRequest(request);
      write(confirmed, safety.label, safety);
      return s.request(request, defined({ maxBytes, executionId, timeoutMs, signal }));
    },

    sql: {
      async *query({ sessionId, query, confirmed, ...options }, { signal }) {
        const s = await session(sessionId);
        const dialect = s.searchCapabilities.sql;
        // The OpenSearch plugin runs DELETE statements: classified like the request it sends.
        if (dialect !== null) {
          const safety = classifyRequest(sqlRequest(dialect, query));
          write(confirmed, 'The SQL statement', safety);
        }
        yield* s.sql(query, defined({ ...options, signal }));
      },
      translate: async ({ sessionId, query }, { signal }) =>
        (await session(sessionId)).translateSql(query, { signal }),
    },

    esql: {
      query: async ({ sessionId, query, executionId }, { signal }) =>
        (await session(sessionId)).esql(query, defined({ executionId, signal })),
    },

    indexAdmin: {
      resize: async (input, { signal }) => {
        const { sessionId, kind, source, target, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(
          confirmed,
          `${kind === 'clone' ? 'Cloning' : kind === 'shrink' ? 'Shrinking' : 'Splitting'} ${source} into ${target}`,
          options.blockSource
            ? destructive(`blocks writes to ${source} while it is copied`)
            : WRITE,
        );
        await s.resizeIndex(kind, source, target, defined({ ...options, signal }));
      },
      reindex: async (input, { signal }) => {
        const { sessionId, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(confirmed, `Reindexing ${options.source.join(', ')} into ${options.dest}`);
        return s.startReindex(defined({ ...options, signal }));
      },
    },

    tasks: {
      get: async ({ sessionId, taskId }, { signal }) =>
        (await session(sessionId)).getTask(taskId, { signal }),
      list: async ({ sessionId, actions }, { signal }) =>
        (await session(sessionId)).listTasks(defined({ actions, signal })),
      cancel: async ({ sessionId, taskId, confirmed }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, `Cancelling the task ${taskId}`);
        await s.cancelTask(taskId, { signal });
      },
    },

    allocation: {
      shards: async ({ sessionId, index }, { signal }) =>
        (await session(sessionId)).shards(defined({ index, signal })),
      explain: async ({ sessionId, shard }, { signal }) =>
        (await session(sessionId)).allocationExplain(shard, { signal }),
      disk: async ({ sessionId }, { signal }) =>
        (await session(sessionId)).diskAllocation({ signal }),
    },

    resources: {
      list: async ({ sessionId, kind, includeHidden }, { signal }) =>
        (await session(sessionId)).listResources(kind, defined({ includeHidden, signal })),
      put: async (input, { signal }) => {
        const { sessionId, kind, name, body, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(confirmed, `Saving the ${RESOURCE_NAMES[kind]} ${name}`);
        await s.putResource(kind, name, body, defined({ ...options, signal }));
      },
      delete: async ({ sessionId, kind, name, confirmed }, { signal }) => {
        const s = await session(sessionId);
        const safety = classifyRequest({
          method: 'DELETE',
          path: resourcePath(kind, s.searchCapabilities.lifecycle ?? 'ilm', name),
        });
        write(confirmed, `Deleting the ${RESOURCE_NAMES[kind]} ${name}`, safety);
        await s.deleteResource(kind, name, { signal });
      },
    },

    pipelines: {
      simulate: async ({ sessionId, pipeline, docs, id, verbose }, { signal }) =>
        (await session(sessionId)).simulatePipeline(
          pipeline,
          docs,
          defined({ id, verbose, signal }),
        ),
    },

    snapshots: {
      list: async ({ sessionId, repository }, { signal }) =>
        (await session(sessionId)).listSnapshots(repository, { signal }),
      create: async (input, { signal }) => {
        const { sessionId, repository, snapshot, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(confirmed, `Creating the snapshot ${snapshot}`);
        await s.createSnapshot(repository, snapshot, defined({ ...options, signal }));
      },
      restore: async (input, { signal }) => {
        const { sessionId, repository, snapshot, confirmed, ...options } = input;
        const s = await session(sessionId);
        write(
          confirmed,
          `Restoring the snapshot ${snapshot}`,
          classifyRequest({
            method: 'POST',
            path: `/_snapshot/${repository}/${snapshot}/_restore`,
          }),
        );
        await s.restoreSnapshot(repository, snapshot, defined({ ...options, signal }));
      },
      delete: async ({ sessionId, repository, snapshot, confirmed }, { signal }) => {
        const s = await session(sessionId);
        write(
          confirmed,
          `Deleting the snapshot ${snapshot}`,
          destructive('deletes the snapshot (its data in the repository is gone)'),
        );
        await s.deleteSnapshot(repository, snapshot, { signal });
      },
      verifyRepository: async ({ sessionId, repository, confirmed }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, `Verifying the repository ${repository}`);
        return s.verifyRepository(repository, { signal });
      },
    },
  };
}

/** What messages call each kind of named resource. */
const RESOURCE_NAMES: Readonly<Record<SearchResourceKind, string>> = {
  'index-template': 'index template',
  'component-template': 'component template',
  'legacy-template': 'legacy template',
  'lifecycle-policy': 'lifecycle policy',
  'ingest-pipeline': 'ingest pipeline',
  'snapshot-repository': 'snapshot repository',
};
