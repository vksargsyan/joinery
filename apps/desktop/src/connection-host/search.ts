import {
  JoineryError,
  type ConnectionProfile,
  type ExecOptions,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import type { SearchSession, isSearchSession } from '@joinery/driver-elasticsearch';
import type { HandlersOf, searchHostContractShape } from '@joinery/ipc';
import { classifyRequest, issuesOf, parseConsole } from '@joinery/search-tools';

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
 * read-only profiles refuse every write, destructive operations need the page's `confirmed`
 * on every profile, and production (or confirm-writes) profiles need it for every write. The
 * console's raw requests are classified by method, path and body.
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
        write(confirmed, `Changing the settings of ${index}`);
        await s.putSettings(index, body, { signal });
      },
    },

    aliases: {
      list: async ({ sessionId, includeHidden }, { signal }) =>
        (await session(sessionId)).listAliases(defined({ includeHidden, signal })),
      update: async ({ sessionId, actions, confirmed }, { signal }) => {
        const s = await session(sessionId);
        write(confirmed, 'Changing aliases');
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
  };
}
