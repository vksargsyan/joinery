import {
  JoineryError,
  capabilitiesFor,
  type DriverAdapter,
  type ResolvedProfile,
  type ResultChunk,
  type Session,
} from '@joinery/core';
import { ElasticSearchSession, type SearchSession } from '@joinery/driver-elasticsearch';
import { searchCapabilities, type SearchRequest } from '@joinery/search-tools';

/**
 * A SearchSession double for the connection host's `search.*` handlers: it records every call
 * (method and arguments) and answers with small canned values. It passes `isSearchSession`,
 * which checks for the driver's session class, because its prototype is that class's; every
 * method it answers is an own property, so none of the real ones runs.
 */

export interface FakeSearchSession extends SearchSession {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
  closed: boolean;
}

export function fakeSearchSession(): FakeSearchSession {
  const calls: FakeSearchSession['calls'] = [];
  const record =
    <T>(method: string, answer: (...args: unknown[]) => T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return answer(...args);
    };
  const unused = (method: string) => () => {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: `${method} is not faked` });
  };
  const write = (index: unknown, id: unknown, result: string) => ({
    index: String(index),
    id: String(id ?? 'generated'),
    result,
    seqNo: 1,
    primaryTerm: 1,
  });
  const capabilities = searchCapabilities({ distribution: 'elasticsearch', version: '9.4.0' });
  const state = { closed: false };
  const fake = {
    engine: 'elasticsearch' as const,
    distribution: 'elasticsearch' as const,
    serverVersion: '9.4.0',
    searchCapabilities: capabilities,
    inTransaction: false,
    calls,
    get closed() {
      return state.closed;
    },
    capabilities: () => capabilitiesFor('elasticsearch', '9.4.0'),
    async *execute(text: string): AsyncGenerator<ResultChunk> {
      calls.push({ method: 'execute', args: [text] });
      yield { type: 'end', durationMs: 1, rowCount: 0 };
    },
    cancel: async () => undefined,
    introspect: unused('introspect'),
    browse: async () => [],
    ping: async () => undefined,
    close: async () => {
      state.closed = true;
    },
    clusterInfo: record('clusterInfo', () => ({
      distribution: 'elasticsearch' as const,
      version: '9.4.0',
      clusterName: 'test',
      plugins: [],
      capabilities,
    })),
    clusterHealth: unused('clusterHealth'),
    nodes: unused('nodes'),
    nodeStats: unused('nodeStats'),
    listIndices: record('listIndices', () => []),
    createIndex: record('createIndex', () => undefined),
    deleteIndices: record('deleteIndices', () => undefined),
    openIndices: record('openIndices', () => undefined),
    closeIndices: record('closeIndices', () => undefined),
    refresh: record('refresh', () => undefined),
    flush: record('flush', () => undefined),
    forceMerge: record('forceMerge', () => undefined),
    getMapping: record('getMapping', () => '{}'),
    putMapping: record('putMapping', () => undefined),
    getSettings: record('getSettings', () => '{}'),
    putSettings: record('putSettings', () => undefined),
    listAliases: record('listAliases', () => []),
    updateAliases: record('updateAliases', () => undefined),
    listDataStreams: record('listDataStreams', () => []),
    async *search(...args: unknown[]) {
      calls.push({ method: 'search', args });
      yield {
        hits: [{ index: String(args[0]), id: '1', score: 1, source: '{"n":12345678901234567890}' }],
        took: 1,
        timedOut: false,
        paging: 'pit' as const,
      };
    },
    count: record('count', () => 7),
    getDocument: record('getDocument', (index, id) => ({
      index: String(index),
      id: String(id),
      found: true,
      source: '{}',
    })),
    indexDocument: record('indexDocument', (index, _source, opts) =>
      write(index, (opts as { id?: string } | undefined)?.id, 'created'),
    ),
    updateDocument: record('updateDocument', (index, id) => write(index, id, 'updated')),
    deleteDocument: record('deleteDocument', (index, id) => write(index, id, 'deleted')),
    bulk: record('bulk', () => ({ took: 1, errors: false, items: [] })),
    deleteByQuery: record('deleteByQuery', (_target, _query, opts) => ({
      dryRun: (opts as { dryRun?: boolean } | undefined)?.dryRun === true,
      total: 3,
      deleted: (opts as { dryRun?: boolean } | undefined)?.dryRun === true ? 0 : 3,
      versionConflicts: 0,
      failures: 0,
      took: 1,
      timedOut: false,
    })),
    request: record('request', (request) => ({
      status: 200,
      contentType: 'application/json',
      body: `{"echo": ${JSON.stringify((request as SearchRequest).path)}}`,
      durationMs: 1,
      warnings: [],
      truncated: false,
    })),
    async *sql(...args: unknown[]) {
      calls.push({ method: 'sql', args });
      yield {
        columns: [{ name: 'n', type: 'long' }],
        rows: [['12345678901234567890']],
        more: true,
      };
      yield { columns: [{ name: 'n', type: 'long' }], rows: [['2']] };
    },
    translateSql: record('translateSql', () => ({
      dsl: '{"size":1000}',
      target: 'logs',
      raw: '{"size":1000}',
    })),
    esql: record('esql', () => ({ columns: [], rows: [] })),
    resizeIndex: record('resizeIndex', () => undefined),
    startReindex: record('startReindex', () => ({ taskId: 'n1:7' })),
    getTask: record('getTask', (taskId) => ({
      id: String(taskId),
      action: 'indices:data/write/reindex',
      completed: false,
      cancellable: true,
      cancelled: false,
      failures: 0,
    })),
    listTasks: record('listTasks', () => []),
    cancelTask: record('cancelTask', () => undefined),
    shards: record('shards', () => []),
    allocationExplain: unused('allocationExplain'),
    diskAllocation: unused('diskAllocation'),
    listResources: record('listResources', () => []),
    putResource: record('putResource', () => undefined),
    deleteResource: record('deleteResource', () => undefined),
    simulatePipeline: record('simulatePipeline', () => []),
    listSnapshots: record('listSnapshots', () => []),
    createSnapshot: record('createSnapshot', () => undefined),
    restoreSnapshot: record('restoreSnapshot', () => undefined),
    deleteSnapshot: record('deleteSnapshot', () => undefined),
    verifyRepository: record('verifyRepository', () => ['es1']),
  };
  Object.setPrototypeOf(fake, ElasticSearchSession.prototype);
  return fake as unknown as FakeSearchSession;
}

/** An adapter whose sessions are fake search sessions. */
export function fakeSearchAdapter(): DriverAdapter & {
  sessions: FakeSearchSession[];
  profiles: ResolvedProfile[];
} {
  const sessions: FakeSearchSession[] = [];
  const profiles: ResolvedProfile[] = [];
  return {
    engine: 'elasticsearch',
    sessions,
    profiles,
    capabilities: (version) => capabilitiesFor('elasticsearch', version),
    async connect(resolved): Promise<Session> {
      profiles.push(resolved);
      const session = fakeSearchSession();
      sessions.push(session);
      return session;
    },
  };
}
