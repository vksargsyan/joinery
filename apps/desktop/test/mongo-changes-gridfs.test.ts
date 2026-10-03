import { QuerybaraError } from '@querybara/core';
import {
  formatShellInline,
  fromEjson,
  toEjson,
  type ChangeEvent,
  type GridFsFileInfo,
} from '@querybara/mongo-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MainClient from '../src/renderer/src/lib/main-client';
import {
  ChangeStreamViewer,
  EMPTY_CHANGE_LOG,
  STANDALONE_TEXT,
  appendChanges,
  changeEntry,
  scopeLabel,
  watchPipeline,
} from '../src/renderer/src/state/mongo/change-stream';
import {
  GridFsBrowser,
  contentTypeFor,
  decodeText,
  deleteFileCommand,
  nameFilter,
  pageOf,
  pageQuery,
  previewKindOf,
  renameFileCommand,
} from '../src/renderer/src/state/mongo/gridfs';
import {
  PROFILE_ID,
  answerConfirms,
  connectHost,
  disconnectAll,
  recorder,
  streamOf,
} from './mongo-tool-fixtures';

/** The change stream viewer and the GridFS browser (spec §9). */

const main = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../src/renderer/src/lib/main-client', async (importOriginal) => ({
  ...(await importOriginal<typeof MainClient>()),
  mainApi: () => main.api,
}));

let seq = 0;
function event(operationType: string, doc: Record<string, unknown>): ChangeEvent {
  seq += 1;
  const token = { _data: `token-${seq}` };
  const body = {
    _id: token,
    operationType,
    ns: { db: 'shop', coll: 'orders' },
    documentKey: { _id: doc['_id'] },
    ...(operationType === 'update'
      ? { updateDescription: { updatedFields: { total: 5 }, removedFields: ['note'] } }
      : {}),
    ...(operationType !== 'delete' ? { fullDocument: doc } : {}),
  };
  return {
    operationType,
    event: toEjson(body),
    resumeToken: toEjson(token),
    ns: { db: 'shop', collection: 'orders' },
    documentKey: toEjson({ _id: doc['_id'] }),
    clusterTime: '2026-09-29T10:00:00.000Z',
  };
}

describe('change log', () => {
  it('shows the key, updated and removed fields and the full document of each event', () => {
    const update = changeEntry(event('update', { _id: 7, total: 5 }), 1);
    expect(update).toMatchObject({
      seq: 1,
      operationType: 'update',
      namespace: 'shop.orders',
      documentKey: '7',
      updatedFields: '{ total: 5 }',
      removedFields: ['note'],
      fullDocument: '{ _id: 7, total: 5 }',
    });
    const removed = changeEntry(event('delete', { _id: 'x' }), 2);
    expect(removed).toMatchObject({
      documentKey: "'x'",
      fullDocument: undefined,
      updatedFields: undefined,
    });
  });

  it('keeps the newest events up to its capacity and counts every operation', () => {
    let log = EMPTY_CHANGE_LOG;
    log = appendChanges(log, [event('insert', { _id: 1 }), event('insert', { _id: 2 })], 3);
    log = appendChanges(log, [event('update', { _id: 1 }), event('delete', { _id: 2 })], 3);
    expect(log.entries.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(log.dropped).toBe(1);
    expect(log.counts).toEqual({ insert: 2, update: 1, delete: 1 });
    expect(appendChanges(log, [])).toBe(log);
  });

  it('reads the optional filter as a $match or a whole pipeline', () => {
    expect(watchPipeline('')).toEqual({ pipeline: undefined });
    const match = watchPipeline("{ operationType: 'insert' }");
    expect('pipeline' in match && formatShellInline(fromEjson(match.pipeline!))).toBe(
      "[ { $match: { operationType: 'insert' } } ]",
    );
    const stage = watchPipeline("{ $match: { 'fullDocument.total': { $gt: 1 } } }");
    expect('pipeline' in stage && formatShellInline(fromEjson(stage.pipeline!))).toBe(
      "[ { $match: { 'fullDocument.total': { $gt: 1 } } } ]",
    );
    const array = watchPipeline('[{ $project: { documentKey: 1 } }]');
    expect('pipeline' in array && array.pipeline).toBe(toEjson([{ $project: { documentKey: 1 } }]));
    expect(watchPipeline('{ a: }')).toMatchObject({ issue: { column: 6 } });
    expect(watchPipeline('[1]')).toMatchObject({ issue: expect.anything() });
    expect(scopeLabel({ kind: 'cluster' })).toBe('the whole deployment');
  });
});

/** A host whose change streams yield what the test pushes, until closed. */
function watchHost(topology = 'replicaSet') {
  const rec = recorder();
  const streams: { push: (e: ChangeEvent) => void; closed: boolean }[] = [];
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    mongo: {
      serverInfo: async () => ({ version: '8.0.4', topology, members: [], modules: [] }),
      watch: (input: object, call?: { signal?: AbortSignal }) => {
        rec.record('watch', input);
        const queue: ChangeEvent[] = [];
        let wake: (() => void) | undefined;
        const entry = {
          closed: false,
          push(e: ChangeEvent) {
            queue.push(e);
            wake?.();
          },
        };
        streams.push(entry);
        const close = () => {
          entry.closed = true;
          wake?.();
        };
        call?.signal?.addEventListener('abort', close);
        if (topology === 'standalone') {
          // eslint-disable-next-line require-yield
          return (async function* () {
            throw new QuerybaraError({ code: 'NOT_SUPPORTED', message: 'standalone' });
          })();
        }
        return (async function* () {
          try {
            while (!entry.closed) {
              if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
              while (queue.length > 0) yield queue.shift()!;
            }
          } finally {
            entry.closed = true;
          }
        })();
      },
    },
  };
  return { host, rec, streams };
}

afterEach(() => disconnectAll());

describe('change stream viewer', () => {
  it('lists changes live, pauses keeping the resume token and resumes from it', async () => {
    const { host, rec, streams } = watchHost();
    connectHost(host);
    const v = new ChangeStreamViewer('cs', {
      profileId: PROFILE_ID,
      scope: { kind: 'collection', ns: { db: 'shop', collection: 'orders' } },
    });
    await v.init();
    v.setPipelineText("{ operationType: { $in: ['insert', 'update'] } }");
    void v.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(rec.of('watch')[0]!.input).toMatchObject({
      scope: { kind: 'collection' },
      options: { fullDocument: 'updateLookup' },
    });
    expect(rec.of('watch')[0]!.input['pipeline']).toContain('$match');
    const first = event('insert', { _id: 1 });
    streams[0]!.push(first);
    streams[0]!.push(event('update', { _id: 1 }));
    await vi.waitFor(() => expect(v.state.log.entries).toHaveLength(2));
    expect(v.state.status).toBe('watching');
    await v.pause();
    expect(v.state.status).toBe('paused');
    expect(streams[0]!.closed).toBe(true);
    const token = v.state.resumeToken;
    expect(token).toBeDefined();
    void v.start();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(rec.of('watch')[1]!.input).toMatchObject({ options: { resumeAfter: token } });
    streams[1]!.push(event('delete', { _id: 1 }));
    await vi.waitFor(() => expect(v.state.log.entries).toHaveLength(3));
    v.select(3);
    v.clear();
    expect(v.state.log.entries).toEqual([]);
    expect(v.state.selected).toBeUndefined();
    await v.stop();
    expect(v.state).toMatchObject({ status: 'stopped', resumeToken: undefined });
    void v.start();
    await vi.waitFor(() => expect(streams).toHaveLength(3));
    expect(rec.of('watch')[2]!.input['options']).not.toHaveProperty('resumeAfter');
    // The sequence goes on after a clear.
    streams[2]!.push(event('insert', { _id: 2 }));
    await vi.waitFor(() => expect(v.state.log.entries[0]?.seq).toBe(4));
    await v.dispose();
  });

  it('says up front that a standalone server has no change streams', async () => {
    const { host, rec } = watchHost('standalone');
    connectHost(host);
    const v = new ChangeStreamViewer('cs', { profileId: PROFILE_ID, scope: { kind: 'cluster' } });
    await v.init();
    expect(v.state.standalone).toBe(true);
    await v.start();
    expect(rec.of('watch')).toHaveLength(0);
    expect(v.state).toMatchObject({ status: 'error', error: STANDALONE_TEXT });
    await v.dispose();
  });
});

describe('GridFS helpers', () => {
  it('filters by name, safely, and pages one file beyond what it shows', () => {
    expect(nameFilter('  ')).toBeUndefined();
    expect(formatShellInline(fromEjson(nameFilter('report (1).pdf')!))).toBe(
      '{ filename: /report \\(1\\)\\.pdf/i }',
    );
    const query = pageQuery(2, 'x', 10);
    expect(query).toMatchObject({ skip: 20, limit: 11 });
    expect(fromEjson(query.sort)).toBeDefined();
    const files = Array.from({ length: 11 }, (_, i) => ({ id: String(i) }) as GridFsFileInfo);
    expect(pageOf(files, 10)).toMatchObject({ hasNext: true });
    expect(pageOf(files, 10).files).toHaveLength(10);
    expect(pageOf(files.slice(0, 4), 10)).toMatchObject({ hasNext: false });
  });

  it('previews text and images, and never binary', () => {
    expect(previewKindOf({ filename: 'a.PNG' })).toEqual({ kind: 'image', mime: 'image/png' });
    expect(previewKindOf({ filename: 'x', contentType: 'image/webp' })).toEqual({
      kind: 'image',
      mime: 'image/webp',
    });
    expect(previewKindOf({ filename: 'notes.md' })).toEqual({ kind: 'text' });
    expect(previewKindOf({ filename: 'data', contentType: 'application/json' })).toEqual({
      kind: 'text',
    });
    expect(previewKindOf({ filename: 'app.bin' })).toEqual({ kind: 'none' });
    expect(contentTypeFor('photo.JPG')).toBe('image/jpeg');
    expect(contentTypeFor('data.json')).toBe('application/json');
    expect(contentTypeFor('archive.bin')).toBeUndefined();
    expect(decodeText(new TextEncoder().encode('héllo'), false)).toBe('héllo');
    expect(decodeText(new Uint8Array([104, 0, 105]), false)).toBeUndefined();
    expect(decodeText(new Uint8Array([0xc3]), false)).toBeUndefined();
    // A cut in the middle of a character is fine when the file was truncated.
    expect(decodeText(new Uint8Array([104, 0xc3]), true)).toBe('h�');
  });

  it('shows what delete and rename run on the bucket collections', () => {
    const bucket = { db: 'files', bucket: 'fs' };
    const oid = '{"$oid":"650000000000000000000001"}';
    expect(deleteFileCommand(bucket, oid)).toBe(
      [
        "db.getSiblingDB('files').getCollection('fs.files').deleteOne({ _id: ObjectId('650000000000000000000001') })",
        "db.getSiblingDB('files').getCollection('fs.chunks').deleteMany({ files_id: ObjectId('650000000000000000000001') })",
      ].join('\n'),
    );
    expect(renameFileCommand(bucket, '"a"', "it's.txt")).toBe(
      "db.getSiblingDB('files').getCollection('fs.files').updateOne({ _id: 'a' }, { $set: { filename: 'it\\'s.txt' } })",
    );
  });
});

describe('GridFS browser', () => {
  let confirms: ReturnType<typeof answerConfirms>;
  beforeEach(() => {
    confirms = answerConfirms();
  });
  afterEach(() => confirms.stop());

  function file(i: number, name = `file-${i}.txt`): GridFsFileInfo {
    return {
      id: toEjson(`f${i}`),
      filename: name,
      length: 5,
      chunkSize: 255 * 1024,
      uploadDate: '2026-09-29T10:00:00.000Z',
      contentType: 'text/plain',
    };
  }

  function gridHost(count: number) {
    const rec = recorder();
    let files = Array.from({ length: count }, (_, i) => file(i));
    const host = {
      openSession: async () => ({ sessionId: 's1' }),
      closeSession: async () => undefined,
      browse: async () => [],
      mongo: {
        gridfs: {
          list: (input: { skip: number; limit: number; filter?: string }) => {
            rec.record('list', input);
            const matching = input.filter ? files.filter((f) => f.filename.includes('9')) : files;
            return streamOf([{ files: matching.slice(input.skip, input.skip + input.limit) }]);
          },
          read: async (input: object) => {
            rec.record('read', input);
            return { bytes: new TextEncoder().encode('hello'), truncated: false };
          },
          delete: async (input: { id: string }) => {
            rec.record('delete', input);
            files = files.filter((f) => f.id !== input.id);
          },
          rename: async (input: object) => rec.record('rename', input),
        },
      },
    };
    return { host, rec };
  }

  it('pages the files, filters by name and previews text', async () => {
    const { host, rec } = gridHost(120);
    connectHost(host);
    const b = new GridFsBrowser('fs', { profileId: PROFILE_ID, db: 'files', bucket: 'fs' });
    await b.init();
    expect(b.state.files).toHaveLength(50);
    expect(b.state.hasNext).toBe(true);
    await b.goToPage(2);
    expect(b.state.files).toHaveLength(20);
    expect(b.state.hasNext).toBe(false);
    await b.goToPage(3);
    expect(b.state.page).toBe(2);
    expect(rec.of('list').at(-1)!.input).toMatchObject({ skip: 100, limit: 51 });
    b.setSearch('9');
    await b.load();
    expect(b.state.page).toBe(0);
    expect(rec.of('list').at(-1)!.input['filter']).toBe(nameFilter('9'));
    await b.select(b.state.files[0]!.id);
    expect(b.state.preview).toMatchObject({ status: 'text', text: 'hello' });
    expect(rec.of('read')[0]!.input).toMatchObject({ maxBytes: 256 * 1024 });
    await b.dispose();
  });

  it('deletes after a confirmation and renames', async () => {
    const { host, rec } = gridHost(3);
    connectHost(host);
    const b = new GridFsBrowser('fs', { profileId: PROFILE_ID, db: 'files', bucket: 'fs' });
    await b.init();
    const target = b.state.files[1]!;
    confirms.answer(false);
    expect(await b.delete(target.id)).toBe(false);
    expect(confirms.asked[0]!.title).toBe('Delete file-1.txt?');
    confirms.answer(true);
    expect(await b.delete(target.id)).toBe(true);
    expect(rec.of('delete')[0]!.input).toMatchObject({ id: target.id, confirmed: true });
    expect(b.state.files.map((f) => f.filename)).toEqual(['file-0.txt', 'file-2.txt']);
    expect(await b.rename(b.state.files[0]!.id, 'renamed.txt')).toBe(true);
    expect(rec.of('rename')[0]!.input).toMatchObject({ filename: 'renamed.txt' });
    await b.dispose();
  });

  it('uploads and downloads through main with progress', async () => {
    const { host } = gridHost(1);
    connectHost(host);
    const progress: unknown[] = [];
    const calls: Record<string, unknown>[] = [];
    main.api = {
      dialogs: {
        openFile: async () => ({ path: '/home/me/report.txt' }),
        saveFile: async () => ({ path: '/tmp/out.txt' }),
      },
      mongo: {
        gridfs: {
          upload: async (
            input: Record<string, unknown>,
            call: { onProgress: (p: unknown) => void },
          ) => {
            calls.push(input);
            call.onProgress({ bytes: 3, total: 6 });
            progress.push('upload');
            return { id: '"new"' };
          },
          download: async (
            input: Record<string, unknown>,
            call: { onProgress: (p: unknown) => void },
          ) => {
            calls.push(input);
            call.onProgress({ bytes: 5 });
            return { bytes: 5 };
          },
        },
      },
    };
    const b = new GridFsBrowser('fs', { profileId: PROFILE_ID, db: 'files', bucket: 'fs' });
    await b.init();
    expect(await b.upload()).toBe(true);
    expect(calls[0]).toMatchObject({
      connectionId: 'c1',
      bucket: { db: 'files', bucket: 'fs' },
      path: '/home/me/report.txt',
      contentType: 'text/plain',
      confirmed: true,
    });
    expect(b.state.notice).toMatchObject({ text: 'Uploaded report.txt' });
    expect(await b.download(b.state.files[0]!.id)).toBe(true);
    expect(calls[1]).toMatchObject({ path: '/tmp/out.txt', id: b.state.files[0]!.id });
    expect(b.state.transfer).toBeUndefined();
    await b.dispose();
  });
});
