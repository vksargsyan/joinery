import { describe, expect, it } from 'vitest';

import {
  bulkDeleteLines,
  bulkUpdateLines,
  classifyRequest,
  documentColumns,
  flatRecord,
  flattenSource,
  partialDocument,
  valueJsonOf,
} from '../src';

describe('flattenSource', () => {
  it('names leaves by dotted path and keeps numbers as written', () => {
    const fields = flattenSource(
      '{"id": 1234567890123456789, "price": 1.10, "customer": {"name": "Ada", "address": {"city": "Paris"}}, "ok": true, "gone": null}',
    );
    expect(fields).toEqual([
      { path: 'id', kind: 'number', text: '1234567890123456789' },
      { path: 'price', kind: 'number', text: '1.10' },
      { path: 'customer.name', kind: 'string', text: 'Ada' },
      { path: 'customer.address.city', kind: 'string', text: 'Paris' },
      { path: 'ok', kind: 'boolean', text: 'true' },
      { path: 'gone', kind: 'null', text: 'null' },
    ]);
  });

  it('keeps arrays and empty objects as one compact JSON cell', () => {
    expect(flattenSource('{"tags": [ "a", {"b": 2} ], "meta": {}}')).toEqual([
      { path: 'tags', kind: 'array', text: '["a",{"b":2}]' },
      { path: 'meta', kind: 'object', text: '{}' },
    ]);
  });

  it('stops flattening at the depth limit', () => {
    expect(flattenSource('{"a": {"b": {"c": 1}}}', { maxDepth: 1 })).toEqual([
      { path: 'a', kind: 'object', text: '{"b":{"c":1}}' },
    ]);
  });

  it('keeps keys that contain dots, and the last duplicate wins in a record', () => {
    const record = flatRecord('{"a.b": 1, "x": 1, "x": 2}');
    expect([...record.keys()]).toEqual(['a.b', 'x']);
    expect(record.get('x')?.text).toBe('2');
  });
});

describe('documentColumns', () => {
  it('puts the given columns first, then fields in order of appearance, up to a limit', () => {
    const records = [flatRecord('{"b": 1, "a": 2}'), flatRecord('{"c": 3, "a": 4}')];
    expect(documentColumns(records, { first: ['a'] })).toEqual({
      columns: ['a', 'b', 'c'],
      truncated: false,
    });
    expect(documentColumns(records, { limit: 2 })).toEqual({
      columns: ['b', 'a'],
      truncated: true,
    });
  });
});

describe('bulk lines', () => {
  it('deletes and updates documents at the version they were read', () => {
    const targets = [
      { index: 'a', id: '1', seqNo: 4, primaryTerm: 1 },
      { index: 'b', id: 'x"y', routing: 'r' },
    ];
    expect(bulkDeleteLines(targets)).toBe(
      '{"delete":{"_index":"a","_id":"1","if_seq_no":4,"if_primary_term":1}}\n{"delete":{"_index":"b","_id":"x\\"y","routing":"r"}}\n',
    );
    expect(bulkUpdateLines(targets.slice(0, 1), '{ "n" : 12345678901234567890 }')).toBe(
      '{"update":{"_index":"a","_id":"1","if_seq_no":4,"if_primary_term":1}}\n{"doc":{"n":12345678901234567890}}\n',
    );
    expect(
      classifyRequest({ method: 'POST', path: '/_bulk', body: bulkDeleteLines(targets) })
        .destructive,
    ).toBeDefined();
    expect(
      classifyRequest({ method: 'POST', path: '/_bulk', body: bulkUpdateLines(targets, '{}') })
        .destructive,
    ).toBeUndefined();
  });
});

describe('partial documents', () => {
  it('reads typed values as JSON and anything else as a string', () => {
    expect(valueJsonOf('42')).toBe('42');
    expect(valueJsonOf(' [1, 2] ')).toBe('[1,2]');
    expect(valueJsonOf('"quoted"')).toBe('"quoted"');
    expect(valueJsonOf('plain text')).toBe('"plain text"');
    expect(valueJsonOf('12345678901234567890')).toBe('12345678901234567890');
  });

  it('nests a dotted path', () => {
    expect(partialDocument('customer.address.city', '"Oslo"')).toBe(
      '{"customer":{"address":{"city":"Oslo"}}}',
    );
    expect(() => partialDocument('', '1')).toThrow();
  });
});
