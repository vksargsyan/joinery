import { describe, expect, it } from 'vitest';

import { classifyRequest } from '../src';

describe('classifyRequest', () => {
  const read = (method: string, path: string, body?: string) =>
    classifyRequest({ method, path, ...(body !== undefined ? { body } : {}) });

  it('reads with GET, HEAD and the search family', () => {
    for (const [method, path] of [
      ['GET', '/orders/_doc/1'],
      ['HEAD', '/orders'],
      ['POST', '/orders/_search'],
      ['POST', '/_msearch'],
      ['POST', '/orders/_count'],
      ['POST', '/_search/scroll'],
      ['POST', '/orders/_pit'],
      ['DELETE', '/_pit'],
      ['DELETE', '/_search/scroll'],
      ['DELETE', '/_search/point_in_time'],
      ['POST', '/_sql'],
      ['POST', '/_query'],
      ['POST', '/_plugins/_sql'],
      ['POST', '/_ingest/pipeline/p/_simulate'],
      ['post', '/orders/_validate/query'],
      ['POST', '/orders/_search/template'],
    ]) {
      expect(read(method!, path!), `${method} ${path}`).toMatchObject({ writes: false });
    }
  });

  it('marks deletes, closes, delete by query and force merge destructive', () => {
    expect(read('DELETE', '/orders')).toEqual({
      writes: true,
      destructive: 'deletes the index and all its documents',
      label: 'DELETE /orders',
    });
    expect(read('DELETE', '/_all').destructive).toBe('deletes every index');
    expect(read('DELETE', '/orders/_doc/1').destructive).toBe('deletes the document');
    expect(read('DELETE', '/_data_stream/logs').destructive).toContain('backing indices');
    expect(read('POST', '/orders/_close').destructive).toContain('closes');
    expect(read('POST', '/orders/_delete_by_query').destructive).toContain('deletes every');
    expect(read('POST', '/orders/_update_by_query').destructive).toContain('changes every');
    expect(read('POST', '/_forcemerge').destructive).toContain('force-merges');
    expect(read('DELETE', '/orders/_alias/current').destructive).toBe('removes aliases');
    expect(read('DELETE', '/_ingest/pipeline/p').destructive).toBe('deletes the ingest pipeline');
  });

  it('marks a bulk request destructive only when it deletes', () => {
    const index = '{"index":{"_id":"1"}}\n{"a":1}\n';
    expect(read('POST', '/_bulk', index)).toEqual({ writes: true, label: 'POST /_bulk' });
    expect(read('POST', '/_bulk', `${index}{"delete":{"_id":"2"}}\n`).destructive).toContain(
      'deletes documents',
    );
  });

  it('treats everything else that is not a read as a write', () => {
    for (const [method, path] of [
      ['PUT', '/orders'],
      ['POST', '/orders/_doc'],
      ['PUT', '/orders/_mapping'],
      ['POST', '/_aliases'],
      ['POST', '/orders/_refresh'],
      ['POST', '/_reindex'],
      ['PUT', '/_cluster/settings'],
      ['PATCH', '/anything'],
    ]) {
      const safety = read(method!, path!);
      expect(safety, `${method} ${path}`).toMatchObject({ writes: true });
      expect(safety.destructive).toBeUndefined();
    }
  });

  it('decodes percent-encoded paths before classifying', () => {
    expect(read('POST', '/orders/%5Fclose').destructive).toContain('closes');
  });

  it('treats a SQL DELETE through the OpenSearch plugin as destructive', () => {
    expect(
      read('POST', '/_plugins/_sql', '{"query": "DELETE FROM logs WHERE a = 1"}').destructive,
    ).toBeDefined();
  });
});
