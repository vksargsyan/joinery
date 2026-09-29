import {
  JoineryError,
  connectionProfileSchema,
  toColumnChunk,
  type ConnectionProfileInput,
  type ResultChunk,
} from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { fromEjson, toEjson, type DocumentPage, type FindQuery } from '@joinery/mongo-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HostClient } from '../src/renderer/src/lib/main-client';
import { useConnections } from '../src/renderer/src/state/connections';
import { keys, queryClient } from '../src/renderer/src/state/data';
import { useDialogs, type Prompt } from '../src/renderer/src/state/dialogs';
import { CollectionView, PAGE_SIZE } from '../src/renderer/src/state/mongo/collection-view';
import { MongoConsole } from '../src/renderer/src/state/mongo/console';
import { profileInput } from './helpers';

/**
 * The collection view and the console driven against a fake connection host (spec §9): the query
 * bar and find() text kept in step, pages fetched as the view scrolls, the editor's conflict flow,
 * bulk writes counted before they run, deletes, explain, and the console's write rules.
 */

interface Call {
  readonly method: string;
  readonly input: Record<string, unknown>;
}

const PROFILE_ID = 'mongo-profile';

function stored(presentation: ConnectionProfileInput['presentation'] = {}): StoredProfile {
  return {
    ...connectionProfileSchema.parse(
      profileInput({
        id: PROFILE_ID,
        name: 'Shop',
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        presentation,
      }),
    ),
    version: 1,
  };
}

/** A connection host whose collection holds `count` orders; it records every call. */
function fakeHost(count: number) {
  const calls: Call[] = [];
  let documents = Array.from({ length: count }, (_, i) => toEjson({ _id: i + 1, total: i * 10 }));
  const record = (method: string, input: object): void => {
    calls.push({ method, input: input as Record<string, unknown> });
  };
  const summary = (partial: object) => ({
    dryRun: false,
    matchedCount: 0,
    modifiedCount: 0,
    deletedCount: 0,
    ...partial,
  });
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    cancel: async (input: object) => record('cancel', input),
    browse: async () => [
      { kind: 'database', name: 'shop', path: ['shop'], hasChildren: true },
      { kind: 'database', name: 'admin', path: ['admin'], hasChildren: true },
    ],
    execute: (input: { text: string }) => {
      record('execute', input);
      return (async function* (): AsyncGenerator<ResultChunk> {
        if (input.text.includes('boom')) {
          throw new JoineryError({
            code: 'VALIDATION_FAILED',
            message: 'Unexpected }',
            position: 7,
          });
        }
        yield {
          type: 'columns',
          resultIndex: 0,
          columns: [{ name: 'document', nativeType: 'document', kind: 'json' }],
        };
        yield toColumnChunk(0, 1, [[toEjson({ ok: 1 })]]);
        yield { type: 'status', command: 'ping', rowsAffected: null };
        yield { type: 'end', durationMs: 3, rowCount: 1 };
      })();
    },
    mongo: {
      serverInfo: async () => ({
        version: '8.0.4',
        topology: 'replicaSet',
        members: [],
        modules: [],
      }),
      useDatabase: async (input: object) => record('useDatabase', input),
      find: (input: { query: FindQuery; pageSize?: number }) => {
        record('find', input);
        const size = input.pageSize ?? 1000;
        const filter = input.query.filter;
        const matching =
          filter && filter.includes('_id')
            ? documents.filter((doc) => filter === `{"_id":${JSON.stringify(JSON.parse(doc)._id)}}`)
            : documents;
        return (async function* (): AsyncGenerator<DocumentPage> {
          for (let i = 0; i < matching.length; i += size)
            yield { documents: matching.slice(i, i + size) };
        })();
      },
      estimatedCount: async () => ({ count: documents.length }),
      count: async (input: object) => {
        record('count', input);
        return { count: documents.length };
      },
      explain: async (input: object) => {
        record('explain', input);
        return {
          plan: { id: '1', operation: 'COLLSCAN', detail: { collectionScan: true }, children: [] },
          summary: { collectionScan: true, indexes: [], nReturned: documents.length },
          raw: '{}',
        };
      },
      replaceOne: async (input: { original: string; replacement: string }) => {
        record('replaceOne', input);
        const at = documents.indexOf(input.original);
        if (at < 0) {
          const id = JSON.parse(input.original)._id;
          const current = documents.find(
            (doc) => JSON.stringify(JSON.parse(doc)._id) === JSON.stringify(id),
          );
          throw new JoineryError({
            code: 'CONFLICT',
            message: 'The document changed',
            detail: current!,
          });
        }
        documents[at] = input.replacement;
        return summary({ matchedCount: 1, modifiedCount: 1 });
      },
      insertOne: async (input: { document: string }) => {
        record('insertOne', input);
        documents.push(input.document);
        return { insertedId: '"x"' };
      },
      deleteOne: async (input: { id: string }) => {
        record('deleteOne', input);
        const before = documents.length;
        documents = documents.filter((doc) => JSON.stringify(JSON.parse(doc)._id) !== input.id);
        return summary({ deletedCount: before - documents.length, matchedCount: 1 });
      },
      updateMany: async (input: { dryRun?: boolean }) => {
        record('updateMany', input);
        return summary({
          dryRun: input.dryRun === true,
          matchedCount: documents.length,
          modifiedCount: input.dryRun ? 0 : documents.length,
        });
      },
      deleteMany: async (input: { dryRun?: boolean }) => {
        record('deleteMany', input);
        const n = documents.length;
        if (!input.dryRun) documents = [];
        return summary({
          dryRun: input.dryRun === true,
          matchedCount: n,
          deletedCount: input.dryRun ? 0 : n,
        });
      },
    },
  };
  return {
    host: host as unknown as HostClient,
    calls,
    change(id: number, patch: object) {
      documents = documents.map((doc) => {
        const value = JSON.parse(doc) as { _id: { $numberInt: string } };
        return Number(value._id.$numberInt) === id
          ? toEjson({ ...(fromEjson(doc) as object), ...patch })
          : doc;
      });
    },
  };
}

/** Answers the confirmations the views ask, recording their titles and commands. */
let answer = true;
const asked: { title: string; detail?: string }[] = [];
let unsubscribe: () => void = () => undefined;

function connectTo(
  host: HostClient,
  presentation: ConnectionProfileInput['presentation'] = {},
): void {
  queryClient.setQueryData(keys.profiles, [stored(presentation)]);
  useConnections.setState({
    byProfile: {
      [PROFILE_ID]: {
        profileId: PROFILE_ID,
        status: 'ready',
        host,
        generation: 1,
        connectionId: 'c1',
      },
    },
  });
}

beforeEach(() => {
  answer = true;
  asked.length = 0;
  unsubscribe = useDialogs.subscribe((state) => {
    const prompt: Prompt | undefined = state.queue[0];
    if (prompt?.kind !== 'confirm') return;
    asked.push({
      title: prompt.title,
      ...(prompt.detail !== undefined ? { detail: prompt.detail } : {}),
    });
    prompt.resolve(answer);
  });
});

afterEach(() => {
  unsubscribe();
  useConnections.setState({ byProfile: {} });
  queryClient.clear();
});

function view(): CollectionView {
  return new CollectionView('panel', {
    profileId: PROFILE_ID,
    db: 'shop',
    collection: 'orders',
    kind: 'collection',
  });
}

describe('collection view', () => {
  it('keeps the fields and the find() text in step, both ways', () => {
    const v = view();
    expect(v.state.findText).toBe('db.orders.find({})');
    v.setField('filter', '{ total: { $gt: 100 } }');
    v.setField('sort', '{ total: -1 }');
    expect(v.state.findText).toBe('db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 })');
    v.setField('limit', 'x');
    expect(v.state.issues.limit).toMatchObject({ message: 'Limit must be a whole number' });
    // The text keeps the last valid query while a field is wrong.
    expect(v.state.findText).toBe('db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 })');
    v.setFindText("db.orders.find({ status: 'open' }, { total: 1 }).limit(5)");
    expect(v.state.fields).toEqual({
      filter: "{ status: 'open' }",
      projection: '{ total: 1 }',
      sort: '',
      skip: '',
      limit: '5',
    });
    expect(v.state.issues).toEqual({});
    v.setFindText("db.orders.find({ status: 'open' }");
    expect(v.state.findIssue).toMatchObject({ line: 1 });
    expect(v.state.fields.filter).toBe("{ status: 'open' }");
  });

  it('runs the query and fetches the next page as the view scrolls', async () => {
    const fake = fakeHost(250);
    connectTo(fake.host);
    const v = view();
    await v.init();
    expect(v.results.state.documents).toHaveLength(PAGE_SIZE);
    expect(v.results.state.hasMore).toBe(true);
    await expect.poll(() => v.state.estimate).toBe(250);
    v.results.onVisibleEnd();
    await expect.poll(() => v.results.state.documents.length).toBe(200);
    v.results.onVisibleEnd();
    await expect.poll(() => v.results.state.hasMore).toBe(false);
    expect(v.results.state.documents).toHaveLength(250);
    expect(fake.calls.filter((c) => c.method === 'find')).toHaveLength(1);
    await v.countExactly();
    expect(v.state.exactCount).toBe(250);
    await v.dispose();
  });

  it('edits a document, shows a concurrent change as a conflict, and overwrites after asking', async () => {
    const fake = fakeHost(3);
    connectTo(fake.host);
    const v = view();
    await v.init();
    v.openEditor('edit', 0);
    expect(v.state.editor).toMatchObject({ mode: 'edit', index: 0, text: '{ _id: 1, total: 0 }' });
    fake.change(1, { total: 42, by: 'someone else' });
    v.setEditorText('{ _id: 1, total: 7 }');
    expect(await v.saveEditor()).toBe(false);
    expect(v.state.editor).toMatchObject({
      status: 'conflict',
      current: { text: "{ _id: 1, total: 42, by: 'someone else' }" },
    });
    expect(await v.overwriteEditor()).toBe(true);
    expect(asked.at(-1)).toMatchObject({ title: 'Overwrite the newer version?' });
    expect(v.state.editor).toBeUndefined();
    expect(v.results.state.documents[0]).toBe(toEjson({ _id: 1, total: 7 }));
    expect(v.state.notice).toMatchObject({ kind: 'success', text: 'Document saved' });

    v.openEditor('clone', 1);
    expect(v.state.editor?.text).toBe('{ total: 10 }');
    expect(await v.saveEditor()).toBe(true);
    expect(fake.calls.find((c) => c.method === 'insertOne')?.input).toMatchObject({
      document: '{"total":{"$numberInt":"10"}}',
    });
  });

  it('counts a bulk update with a dry run, then writes after the confirmation', async () => {
    const fake = fakeHost(4);
    connectTo(fake.host);
    const v = view();
    v.setField('filter', "{ status: 'open' }");
    await v.init();
    v.openBulk('update');
    v.setBulkUpdateText('{ $set: { flagged: true } }');
    await v.countBulk();
    expect(v.state.bulk).toMatchObject({ step: 'counted', matched: 4 });
    expect(await v.runBulk()).toBe(true);
    expect(asked.at(-1)).toEqual({
      title: 'Update 4 documents?',
      detail:
        "db.getSiblingDB('shop').orders.updateMany({ status: 'open' }, { $set: { flagged: true } })",
    });
    const updates = fake.calls.filter((c) => c.method === 'updateMany').map((c) => c.input);
    expect(updates).toMatchObject([
      { dryRun: true, filter: '{"status":"open"}' },
      { dryRun: false, confirmed: true, update: '{"$set":{"flagged":true}}' },
    ]);

    answer = false;
    v.openBulk('delete');
    await expect.poll(() => v.state.bulk?.step).toBe('counted');
    expect(await v.runBulk()).toBe(false);
    expect(fake.calls.filter((c) => c.method === 'deleteMany')).toHaveLength(1);
  });

  it('deletes one document after showing its command, and explains the query', async () => {
    const fake = fakeHost(2);
    connectTo(fake.host);
    const v = view();
    await v.init();
    await v.deleteDocument(1);
    expect(asked.at(-1)).toEqual({
      title: 'Delete this document?',
      detail: "db.getSiblingDB('shop').orders.deleteOne({ _id: 2 })",
    });
    expect(v.results.state.documents).toHaveLength(1);
    await v.explain('queryPlanner');
    expect(v.state.tab).toBe('explain');
    expect(v.state.explain).toMatchObject({
      verbosity: 'queryPlanner',
      result: { summary: { collectionScan: true } },
    });
    expect(fake.calls.find((c) => c.method === 'explain')?.input).toMatchObject({
      target: { kind: 'find', query: { filter: '{}' } },
      verbosity: 'queryPlanner',
    });
  });

  it('writes nothing on a read-only profile, and asks before every write on production', async () => {
    const readOnly = fakeHost(2);
    connectTo(readOnly.host, { readOnly: true });
    const v = view();
    await v.init();
    v.openEditor('edit', 0);
    expect(v.state.editor).toBeUndefined();
    expect(v.state.notice).toMatchObject({ text: 'This connection is read-only.' });
    await v.deleteDocument(0);
    expect(readOnly.calls.some((c) => c.method === 'deleteOne')).toBe(false);

    const production = fakeHost(2);
    connectTo(production.host, { environment: 'production' });
    const p = view();
    await p.init();
    p.openEditor('insert');
    p.setEditorText('{ total: 1 }');
    answer = false;
    expect(await p.saveEditor()).toBe(false);
    expect(asked.at(-1)).toEqual({
      title: 'Insert the document?',
      detail: "db.getSiblingDB('shop').orders.insertOne({ total: 1 })",
    });
    answer = true;
    expect(await p.saveEditor()).toBe(true);
    expect(production.calls.find((c) => c.method === 'insertOne')?.input).toMatchObject({
      confirmed: true,
    });
  });
});

describe('command console', () => {
  it('runs command documents on the chosen database and shows their documents', async () => {
    const fake = fakeHost(0);
    connectTo(fake.host);
    const shell = new MongoConsole('console', { profileId: PROFILE_ID, database: 'shop' });
    await shell.init();
    expect(shell.state.databases).toEqual(['shop', 'admin']);
    await shell.run('{ ping: 1 }');
    expect(shell.results.state.documents).toEqual([toEjson({ ok: 1 })]);
    expect(shell.state).toMatchObject({ pane: 'results', command: 'ping', running: false });
    expect(fake.calls.find((c) => c.method === 'useDatabase')?.input).toMatchObject({
      database: 'shop',
    });
    await shell.run('{ ping: boom }');
    expect(shell.state.errorMarker).toEqual({ offset: 7, message: 'Unexpected }' });
    expect(shell.state.pane).toBe('messages');
  });

  it('refuses writes on a read-only profile and asks before destructive commands', async () => {
    const fake = fakeHost(0);
    connectTo(fake.host, { readOnly: true });
    const shell = new MongoConsole('console', { profileId: PROFILE_ID, database: 'shop' });
    await shell.init();
    await shell.run('{ insert: "orders", documents: [{}] }');
    expect(shell.state.messages.at(-1)?.text).toContain('read-only');
    expect(fake.calls.some((c) => c.method === 'execute')).toBe(false);

    connectTo(fake.host);
    const writable = new MongoConsole('console2', { profileId: PROFILE_ID, database: 'shop' });
    await writable.init();
    answer = false;
    await writable.run('{ drop: "orders" }');
    expect(asked.at(-1)).toMatchObject({ title: 'Run drop?', detail: '{ drop: "orders" }' });
    expect(fake.calls.some((c) => c.method === 'execute')).toBe(false);
  });
});
