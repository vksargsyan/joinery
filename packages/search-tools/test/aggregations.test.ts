import { describe, expect, it } from 'vitest';

import { aggregationTable, aggregationTree, aggregationsOf } from '../src';

const NESTED = `{
  "by_status": {
    "doc_count_error_upper_bound": 0,
    "sum_other_doc_count": 0,
    "buckets": [
      {
        "key": "paid",
        "doc_count": 3,
        "total": { "value": 12345678901234567890 },
        "by_day": {
          "buckets": [
            { "key_as_string": "2026-09-01", "key": 1788220800000, "doc_count": 2, "total": { "value": 10.50 } },
            { "key_as_string": "2026-09-02", "key": 1788307200000, "doc_count": 1, "total": { "value": 2 } }
          ]
        }
      },
      { "key": "open", "doc_count": 1, "total": { "value": 5 }, "by_day": { "buckets": [] } }
    ]
  },
  "stats": { "count": 4, "min": 1, "max": 9, "avg": 4.5, "sum": 18 },
  "late": { "doc_count": 2, "avg_total": { "value": null } }
}`;

describe('aggregationTree', () => {
  it('shows aggregations, buckets and metrics with exact values', () => {
    const [byStatus, stats, late] = aggregationTree(NESTED);
    expect(byStatus).toMatchObject({ label: 'by_status', type: 'aggregation', kind: 'buckets' });
    const paid = byStatus!.children[0]!;
    expect(paid).toMatchObject({ label: 'paid', type: 'bucket', docCount: 3 });
    expect(paid.children[0]).toMatchObject({
      label: 'total',
      type: 'value',
      value: '12345678901234567890',
    });
    expect(paid.children[1]!.children.map((b) => b.label)).toEqual(['2026-09-01', '2026-09-02']);
    expect(paid.children[1]!.children[0]!.children[0]!.value).toBe('10.50');
    expect(stats).toMatchObject({ kind: 'metrics' });
    expect(stats!.children.map((c) => [c.label, c.value])).toEqual([
      ['count', '4'],
      ['min', '1'],
      ['max', '9'],
      ['avg', '4.5'],
      ['sum', '18'],
    ]);
    expect(late).toMatchObject({ kind: 'single-bucket', docCount: 2 });
    expect(late!.children[0]).toMatchObject({ label: 'avg_total', value: 'null' });
  });

  it('reads keyed buckets, composite keys, percentiles and top hits', () => {
    const tree = aggregationTree(`{
      "ranges": { "buckets": { "cheap": { "to": 10, "doc_count": 4 }, "dear": { "from": 10, "doc_count": 1 } } },
      "pairs": { "after_key": {"a": 2}, "buckets": [ { "key": { "a": 1, "b": "x" }, "doc_count": 7 } ] },
      "p": { "values": { "50.0": 3, "99.0": 9, "99.0_as_string": "9.0" } },
      "top": { "hits": { "total": { "value": 12, "relation": "eq" }, "hits": [] } }
    }`);
    expect(tree[0]!.children.map((b) => [b.label, b.docCount])).toEqual([
      ['cheap', 4],
      ['dear', 1],
    ]);
    expect(tree[1]!.children[0]!.label).toBe('a=1, b=x');
    expect(tree[2]!.children.map((c) => [c.label, c.value])).toEqual([
      ['50.0', '3'],
      ['99.0', '9.0'],
    ]);
    expect(tree[3]).toMatchObject({ type: 'value', value: '12 hits' });
  });
});

describe('aggregationTable', () => {
  it('makes one row per innermost bucket, with parent metrics repeated', () => {
    const table = aggregationTable(NESTED);
    expect(table.columns).toEqual([
      'stats.count',
      'stats.min',
      'stats.max',
      'stats.avg',
      'stats.sum',
      'by_status',
      'by_status › total',
      'by_day',
      'by_day › total',
      'late › avg_total',
    ]);
    const rows = table.rows.map((row) =>
      Object.fromEntries(table.columns.map((c, i) => [c, row[i]]).filter(([, v]) => v !== '')),
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      by_status: 'paid',
      'by_status › total': '12345678901234567890',
      by_day: '2026-09-01',
      'by_day › total': '10.50',
    });
    expect(rows[1]).toMatchObject({
      by_status: 'paid',
      by_day: '2026-09-02',
      'by_day › total': '2',
    });
    // A bucket whose sub-aggregation has no buckets still has its row.
    expect(rows[2]).toMatchObject({ by_status: 'open', 'by_status › total': '5' });
    expect(rows[2]!['by_day']).toBeUndefined();
    expect(rows[3]).toMatchObject({ 'late › avg_total': 'null' });
    expect(rows.every((row) => row['stats.sum'] === '18')).toBe(true);
  });

  it('adds a count column where buckets have no metric', () => {
    const table = aggregationTable(
      '{"terms": {"buckets": [{"key": "a", "doc_count": 2}, {"key": 1, "doc_count": 1}]}}',
    );
    expect(table).toEqual({
      columns: ['terms', 'terms count'],
      rows: [
        ['a', '2'],
        ['1', '1'],
      ],
    });
  });

  it('finds the aggregations of a search response', () => {
    expect(aggregationsOf('{"hits": {}, "aggregations": {"x": {"value": 1}}}')).toBe(
      '{"x": {"value": 1}}',
    );
    expect(aggregationsOf('{"hits": {}}')).toBeUndefined();
    expect(aggregationsOf('not json')).toBeUndefined();
  });
});
