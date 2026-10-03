import { QuerybaraError } from '@querybara/core';
import { toEjson, type WriteSummary } from '@querybara/mongo-tools';
import { describe, expect, it, vi } from 'vitest';

import { BulkFlow, bulkState, type BulkWrites } from '../src/renderer/src/state/mongo/bulk-flow';
import {
  EditorFlow,
  cloneState,
  editState,
  insertState,
  type EditorWrites,
} from '../src/renderer/src/state/mongo/editor-flow';
import {
  DocumentResults,
  crumbsOf,
  drillInto,
  pathLabel,
  tableOf,
} from '../src/renderer/src/state/mongo/results';

/** The collection view's result views, document editor and bulk writes (spec §9). */

const ORDERS = [
  {
    _id: 1,
    customer: { name: 'Ada', address: { city: 'London' } },
    items: [
      { sku: 'a', qty: 2, tags: ['red', 'big'] },
      { sku: 'b', qty: 1, tags: [] },
    ],
  },
  { _id: 2, customer: { name: 'Grace' }, items: [{ sku: 'c', qty: 5 }] },
];

function results(): DocumentResults {
  const r = new DocumentResults();
  r.begin();
  r.append(
    ORDERS.map((doc) => toEjson(doc)),
    false,
  );
  return r;
}

describe('table drill-down', () => {
  it('flattens nested fields and drills into one document’s array, with a breadcrumb back', () => {
    const r = results();
    const top = tableOf(r.values(), undefined, true);
    expect(top.columns.map((c) => c.key)).toEqual([
      '_id',
      'customer.name',
      'customer.address.city',
      'items',
    ]);
    const items = top.rows[0]!.cells[3]!;
    expect(items).toMatchObject({ type: 'array', text: '[ 2 elements ]', drill: ['items'] });
    const drill = drillInto(undefined, top.rows[0]!, items)!;
    expect(drill).toEqual({ document: 0, path: ['items'] });
    const inside = tableOf(r.values(), drill, true);
    expect(inside.columns.map((c) => c.key)).toEqual(['sku', 'qty', 'tags']);
    expect(inside.rows.map((row) => row.path)).toEqual([
      ['items', 0],
      ['items', 1],
    ]);
    // Deeper: the first item's tags, still in the first document.
    const tags = drillInto(drill, inside.rows[0]!, inside.rows[0]!.cells[2]!)!;
    expect(tags).toEqual({ document: 0, path: ['items', 0, 'tags'] });
    expect(tableOf(r.values(), tags, true).rows.map((row) => row.cells[0]!.text)).toEqual([
      'red',
      'big',
    ]);
    expect(crumbsOf(tags).map((c) => c.label)).toEqual([
      'Documents',
      'Document 1',
      'items',
      '[0]',
      'tags',
    ]);
    expect(crumbsOf(tags)[2]!.drill).toEqual(drill);
    expect(crumbsOf(tags)[0]!.drill).toBeUndefined();
    expect(pathLabel(['items', 0, 'tags'])).toBe('items[0].tags');
    // Without flattening, a sub-document is a cell to drill into.
    const unflat = tableOf(r.values(), undefined, false);
    expect(unflat.columns.map((c) => c.key)).toEqual(['_id', 'customer', 'items']);
    expect(unflat.rows[1]!.cells[1]).toMatchObject({ type: 'object', drill: ['customer'] });
  });

  it('keeps the documents, pages and edits them, and prints JSON two ways', () => {
    const r = results();
    expect(r.state.hasMore).toBe(false);
    r.replaceAt(1, toEjson({ _id: 2, customer: { name: 'Grace H.' } }));
    expect(r.values()[1]).toMatchObject({ customer: { name: 'Grace H.' } });
    r.setDrill({ document: 0, path: ['items'] });
    r.removeAt(0);
    expect(r.state.documents).toHaveLength(1);
    expect(r.state.drill).toBeUndefined();
    expect(r.json()).toBe("{ _id: 2, customer: { name: 'Grace H.' } }");
    r.setJsonStyle('ejson');
    expect(JSON.parse(r.json())).toEqual([{ _id: 2, customer: { name: 'Grace H.' } }]);
    const fetch = vi.fn(async () => undefined);
    r.begin(fetch);
    r.append([toEjson({ _id: 3 })], true);
    r.onVisibleEnd();
    expect(fetch).toHaveBeenCalledTimes(1);
    r.toggleNode('0:[]');
    expect(r.state.expanded).toEqual({ '0:[]': true });
  });
});

function summary(partial: Partial<WriteSummary> = {}): WriteSummary {
  return { dryRun: false, matchedCount: 0, modifiedCount: 0, deletedCount: 0, ...partial };
}

describe('document editor', () => {
  const doc = toEjson({ _id: 1, total: 120, at: new Date('2026-01-01T00:00:00Z') });

  it('opens documents as shell text; a clone leaves out the _id', () => {
    expect(editState(doc)).toMatchObject({
      mode: 'edit',
      original: doc,
      text: "{\n  _id: 1,\n  total: 120,\n  at: ISODate('2026-01-01T00:00:00.000Z')\n}",
    });
    expect(cloneState(doc).text).toBe(
      "{\n  total: 120,\n  at: ISODate('2026-01-01T00:00:00.000Z')\n}",
    );
    expect(insertState().mode).toBe('insert');
  });

  it('checks the text as it is typed and saves an edit as an optimistic replace', async () => {
    const writes: EditorWrites = {
      replace: vi.fn(async () => summary({ matchedCount: 1, modifiedCount: 1 })),
      insert: vi.fn(),
    };
    const flow = new EditorFlow(editState(doc), writes);
    flow.setText('{ _id: 1, total: }');
    expect(flow.state.issue).toMatchObject({ line: 1 });
    expect(await flow.save()).toEqual({ ok: false });
    expect(writes.replace).not.toHaveBeenCalled();
    flow.setText(
      "{ _id: 1, total: NumberDecimal('120.50'), note: UUID('0f8fad5b-d9cb-469f-a165-70867728950e') }",
    );
    const saved = await flow.save();
    expect(saved.ok).toBe(true);
    expect(writes.replace).toHaveBeenCalledWith(
      doc,
      '{"_id":{"$numberInt":"1"},"total":{"$numberDecimal":"120.50"},"note":{"$binary":{"base64":"D4+tW9nLRp+hZXCGdyiVDg==","subType":"04"}}}',
    );
    expect(flow.state).toMatchObject({ status: 'saved' });
  });

  it('shows a conflict with the current version, then reloads it or overwrites it', async () => {
    const current = toEjson({ _id: 1, total: 999 });
    let attempts = 0;
    const writes: EditorWrites = {
      replace: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new QuerybaraError({
            code: 'CONFLICT',
            message: 'The document changed',
            detail: current,
          });
        }
        return summary({ matchedCount: 1, modifiedCount: 1 });
      }),
      insert: vi.fn(),
    };
    const states: string[] = [];
    const flow = new EditorFlow(editState(doc), writes, (state) => states.push(state.status));
    flow.setText('{ _id: 1, total: 5 }');
    expect(await flow.save()).toEqual({ ok: false });
    expect(flow.state).toMatchObject({
      status: 'conflict',
      current: { ejson: current, text: '{ _id: 1, total: 999 }' },
    });
    // Overwrite: replaces the current version (not the one first read) with the edit.
    expect((await flow.overwrite()).ok).toBe(true);
    expect(writes.replace).toHaveBeenLastCalledWith(current, toEjson({ _id: 1, total: 5 }));
    expect(states).toContain('conflict');

    const again = new EditorFlow(editState(doc), {
      replace: async () => {
        throw new QuerybaraError({ code: 'CONFLICT', message: 'changed', detail: current });
      },
      insert: vi.fn(),
    });
    await again.save();
    again.reload();
    expect(again.state).toMatchObject({
      status: 'editing',
      original: current,
      text: '{ _id: 1, total: 999 }',
    });
  });

  it('lists the validator rules a document failed, and stays quiet when a write is cancelled', async () => {
    const flow = new EditorFlow(insertState('{ name: 1 }'), {
      replace: vi.fn(),
      insert: async () => {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'Document failed validation: name: bsonType string expected, got int',
          detail: 'name: bsonType string expected, got int\nmissing required field: email',
        });
      },
    });
    expect(await flow.save()).toEqual({ ok: false });
    expect(flow.state.error).toEqual({
      message: 'Document failed validation: name: bsonType string expected, got int',
      lines: ['name: bsonType string expected, got int', 'missing required field: email'],
    });
    const cancelled = new EditorFlow(insertState('{}'), {
      replace: vi.fn(),
      insert: async () => {
        throw new QuerybaraError({ code: 'CANCELLED', message: 'Not saved' });
      },
    });
    await cancelled.save();
    expect(cancelled.state).toMatchObject({ status: 'editing', error: undefined });
  });
});

describe('bulk update and delete', () => {
  const filter = toEjson({ status: 'open' });

  function writes(confirmAnswer: boolean): BulkWrites & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      update: async (f, update, dryRun) => {
        calls.push(['update', f, update, dryRun]);
        return summary({ dryRun, matchedCount: 7, modifiedCount: dryRun ? 0 : 7 });
      },
      delete: async (f, dryRun) => {
        calls.push(['delete', f, dryRun]);
        return summary({ dryRun, matchedCount: 3, deletedCount: dryRun ? 0 : 3 });
      },
      confirm: async (matched) => {
        calls.push(['confirm', matched]);
        return confirmAnswer;
      },
    };
  }

  it('counts the matches with a dry run before anything is written', async () => {
    const w = writes(true);
    const flow = new BulkFlow(bulkState('update', filter), w);
    expect(await flow.run()).toBe(false);
    flow.setUpdateText('{ $set: { flagged: true } }');
    expect(await flow.count()).toBe(7);
    expect(flow.state).toMatchObject({ step: 'counted', matched: 7 });
    expect(await flow.run()).toBe(true);
    expect(w.calls).toEqual([
      ['update', filter, '{"$set":{"flagged":true}}', true],
      ['confirm', 7],
      ['update', filter, '{"$set":{"flagged":true}}', false],
    ]);
    expect(flow.state).toMatchObject({ step: 'done', result: { modifiedCount: 7 } });
  });

  it('writes nothing when the confirmation is declined, and checks the update text', async () => {
    const w = writes(false);
    const flow = new BulkFlow(bulkState('delete', filter), w);
    await flow.count();
    expect(await flow.run()).toBe(false);
    expect(w.calls).toEqual([
      ['delete', filter, true],
      ['confirm', 3],
    ]);
    const update = new BulkFlow(bulkState('update', filter), writes(true));
    update.setUpdateText('{ $set: { a: } }');
    expect(update.state.issue).toMatchObject({ line: 1 });
    update.setUpdateText('[{ $set: { total: { $add: ["$total", 1] } } }]');
    expect(update.state.issue).toBeUndefined();
    expect(await update.count()).toBe(7);
    // A new update text needs a new count.
    update.setUpdateText('{ $unset: { a: 1 } }');
    expect(update.state).toMatchObject({ step: 'editing', matched: undefined });
  });
});
