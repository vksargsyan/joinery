import { fromEjson, formatShellInline, toEjson, type StagePreview } from '@joinery/mongo-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MainClient from '../src/renderer/src/lib/main-client';
import { AggregationEditor } from '../src/renderer/src/state/mongo/aggregation';
import {
  PROFILE_ID,
  answerConfirms,
  connectHost,
  disconnectAll,
  recorder,
  streamOf,
} from './mongo-tool-fixtures';

/** The aggregation editor against a fake host (spec §9): previews, runs, explain, saved pipelines. */

const main = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock('../src/renderer/src/lib/main-client', async (importOriginal) => ({
  ...(await importOriginal<typeof MainClient>()),
  mainApi: () => main.api,
}));

function fakeHost() {
  const rec = recorder();
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    mongo: {
      previewStage: async (input: {
        pipeline: string;
        stageIndex: number;
      }): Promise<StagePreview> => {
        rec.record('previewStage', input);
        return {
          documents: [toEjson({ stage: input.stageIndex })],
          pipeline: '[]',
          sampled: true,
          skippedStages: [],
          durationMs: 3.4,
        };
      },
      aggregate: (input: object) => {
        rec.record('aggregate', input);
        return streamOf([{ documents: [toEjson({ _id: 1 }), toEjson({ _id: 2 })] }]);
      },
      explain: async (input: object) => {
        rec.record('explain', input);
        return {
          plan: { id: '1', operation: 'COLLSCAN', detail: {}, children: [] },
          summary: { collectionScan: true, indexes: [] },
          raw: '{}',
        };
      },
    },
  };
  return { host, rec };
}

function pipelines() {
  const saved: { id: string; name: string; text: string; updatedAt: string }[] = [];
  const rec = recorder();
  main.api = {
    mongo: {
      pipelines: {
        list: async () => [...saved],
        save: async (input: { id?: string; name: string; text: string }) => {
          rec.record('save', input);
          const entry = {
            id: input.id ?? `p${saved.length + 1}`,
            name: input.name,
            text: input.text,
            updatedAt: 'now',
          };
          const at = saved.findIndex((p) => p.id === entry.id);
          if (at >= 0) saved[at] = entry;
          else saved.push(entry);
          return entry;
        },
        delete: async (input: { id: string }) => {
          rec.record('delete', input);
          saved.splice(
            saved.findIndex((p) => p.id === input.id),
            1,
          );
        },
      },
    },
  };
  return { saved, rec };
}

let confirms: ReturnType<typeof answerConfirms>;

beforeEach(() => {
  confirms = answerConfirms();
  pipelines();
});

afterEach(() => {
  confirms.stop();
  disconnectAll();
});

function editor(text?: string): AggregationEditor {
  return new AggregationEditor('agg', {
    profileId: PROFILE_ID,
    db: 'shop',
    collection: 'orders',
    ...(text !== undefined ? { text } : {}),
  });
}

const THREE = `[
  { $match: { status: 'open' } },
  // { $sort: { total: -1 } },
  { $limit: 5 }
]`;

describe('aggregation editor', () => {
  it('previews each stage on a sample with the chosen sampling, skipping disabled stages', async () => {
    const { host, rec } = fakeHost();
    connectHost(host);
    const e = editor(THREE);
    e.setAutoPreview(false);
    e.setSampleSize(250);
    e.setSampling('sample');
    await e.previewAll();
    const previews = rec.of('previewStage');
    // The disabled stage is not sent for its own preview.
    expect(previews.map((c) => c.input['stageIndex'])).toEqual([0, 2]);
    expect(previews[1]!.input).toMatchObject({
      sampleSize: 250,
      sampling: 'sample',
      disabled: [1],
      limit: 20,
    });
    // The whole pipeline up to the stage goes along, the disabled stage included.
    expect(formatShellInline(fromEjson(previews[1]!.input['pipeline'] as string))).toBe(
      "[ { $match: { status: 'open' } }, { $sort: { total: -1 } }, { $limit: 5 } ]",
    );
    const [first, second, third] = e.state.stages;
    expect(e.state.previews[first!.id]).toMatchObject({ status: 'done', durationMs: 3 });
    expect(e.state.previews[second!.id]).toMatchObject({ status: 'skipped' });
    expect(e.state.previews[third!.id]?.documents).toEqual([toEjson({ stage: 2 })]);
    await e.dispose();
  });

  it('does not preview past a stage that does not parse, and re-previews after edits', async () => {
    vi.useFakeTimers();
    try {
      const { host, rec } = fakeHost();
      connectHost(host);
      const e = editor(THREE);
      const [first, , third] = e.state.stages;
      e.setBody(first!.id, '{ status: }');
      expect(e.state.checks[first!.id]?.issue).toMatchObject({ column: 11 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(rec.of('previewStage')).toHaveLength(0);
      expect(e.state.previews[third!.id]).toMatchObject({
        status: 'error',
        message: 'Fix stage 1 to preview this one.',
      });
      e.setBody(first!.id, "{ status: 'shipped' }");
      await vi.advanceTimersByTimeAsync(1000);
      expect(rec.of('previewStage').map((c) => c.input['stageIndex'])).toEqual([0, 2]);
      await e.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the cards and the pipeline text in step', () => {
    const e = editor(THREE);
    e.setAutoPreview(false);
    const ids = e.state.stages.map((s) => s.id);
    e.setMode('text');
    expect(e.state.text).toBe(THREE);
    e.setText("[\n  { $match: { status: 'open' } },\n  { $count: 'n' }\n]");
    expect(e.state.stages.map((s) => s.operator)).toEqual(['$match', '$count']);
    expect(e.state.stages[0]!.id).toBe(ids[0]);
    e.setText('[ { $match: ');
    expect(e.state.textIssue).toBeDefined();
    expect(e.state.stages).toHaveLength(2);
    e.setMode('stages');
    e.moveStage(1, 0);
    e.toggleStage(e.state.stages[1]!.id);
    expect(e.state.text).toBe("[\n  { $count: 'n' },\n  // { $match: { status: 'open' } }\n]");
  });

  it('runs the enabled stages into the result views and explains them', async () => {
    const { host, rec } = fakeHost();
    connectHost(host);
    const e = editor(THREE);
    e.setAutoPreview(false);
    await e.run();
    expect(formatShellInline(fromEjson(rec.of('aggregate')[0]!.input['pipeline'] as string))).toBe(
      "[ { $match: { status: 'open' } }, { $limit: 5 } ]",
    );
    expect(rec.of('aggregate')[0]!.input['confirmed']).toBeUndefined();
    expect(e.results.state.documents).toHaveLength(2);
    expect(confirms.asked).toHaveLength(0);
    await e.explain('queryPlanner');
    expect(rec.of('explain')[0]!.input).toMatchObject({
      target: { kind: 'aggregate' },
      verbosity: 'queryPlanner',
    });
    expect(e.state.tab).toBe('explain');
    await e.dispose();
  });

  it('asks before a pipeline that writes with $out, showing the command', async () => {
    const { host, rec } = fakeHost();
    connectHost(host);
    const e = editor("[{ $match: {} }, { $out: 'archive' }]");
    e.setAutoPreview(false);
    confirms.answer(false);
    await e.run();
    expect(rec.of('aggregate')).toHaveLength(0);
    expect(confirms.asked[0]).toMatchObject({
      title: 'Run the pipeline and write its results ($out)?',
      detail: "db.getSiblingDB('shop').orders.aggregate([ { $match: {} }, { $out: 'archive' } ])",
    });
    confirms.answer(true);
    await e.run();
    expect(rec.of('aggregate')[0]!.input['confirmed']).toBe(true);
    await e.dispose();
  });

  it('refuses a writing pipeline on a read-only connection', async () => {
    const { host, rec } = fakeHost();
    connectHost(host, { readOnly: true });
    const e = editor("[{ $merge: { into: 'x' } }]");
    e.setAutoPreview(false);
    await e.init();
    await e.run();
    expect(rec.of('aggregate')).toHaveLength(0);
    expect(e.state.notice).toMatchObject({ kind: 'error' });
    await e.dispose();
  });

  it('saves, lists, loads and deletes named pipelines for the collection', async () => {
    const store = pipelines();
    const { host } = fakeHost();
    connectHost(host);
    const e = editor(THREE);
    e.setAutoPreview(false);
    await e.init();
    expect(await e.save('Open orders')).toBe(true);
    expect(store.rec.of('save')[0]!.input).toMatchObject({
      profileId: PROFILE_ID,
      db: 'shop',
      collection: 'orders',
      name: 'Open orders',
      text: THREE,
    });
    expect(e.state.saved.map((p) => p.name)).toEqual(['Open orders']);
    e.addStage(2, '$project');
    expect(await e.save()).toBe(true);
    expect(store.rec.of('save')[1]!.input).toMatchObject({ id: 'p1', name: 'Open orders' });
    expect(store.saved[0]!.text).toContain('$project');
    const other = editor();
    await other.init();
    other.load('p1');
    expect(other.state.stages.map((s) => [s.operator, s.enabled])).toEqual([
      ['$match', true],
      ['$sort', false],
      ['$limit', true],
      ['$project', true],
    ]);
    await other.deleteSaved('p1');
    expect(confirms.asked.at(-1)?.title).toBe('Delete the saved pipeline "Open orders"?');
    expect(other.state.saved).toEqual([]);
    expect(other.state.current).toBeUndefined();
    await e.dispose();
    await other.dispose();
  });
});
