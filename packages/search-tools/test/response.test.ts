import { describe, expect, it } from 'vitest';

import { parseSearchError, parseSearchReply, searchCapabilities, versionAtLeast } from '../src';

describe('parseSearchReply', () => {
  it('slices each _source out of the reply as typed', () => {
    const body =
      '{"took":3,"timed_out":false,"_shards":{},"hits":{"total":{"value":2,"relation":"eq"},"max_score":1.0,' +
      '"hits":[{"_index":"a","_id":"1","_score":1.0,"_seq_no":4,"_primary_term":1,"_source":{"n":12345678901234567890,"f":1.10},"sort":[1,"x"]},' +
      '{"_index":"a","_id":"2","_score":null,"_source":{}}]},"aggregations":{"t":{"value":2}},"pit_id":"p1"}';
    const page = parseSearchReply(body);
    expect(page.hits).toEqual([
      {
        index: 'a',
        id: '1',
        score: 1,
        source: '{"n":12345678901234567890,"f":1.10}',
        sort: '[1,"x"]',
        seqNo: 4,
        primaryTerm: 1,
      },
      { index: 'a', id: '2', score: null, source: '{}' },
    ]);
    expect(page).toMatchObject({
      total: { value: 2, relation: 'eq' },
      took: 3,
      timedOut: false,
      aggregations: '{"t":{"value":2}}',
      pitId: 'p1',
    });
  });

  it('reads the 6.x numeric total', () => {
    expect(parseSearchReply('{"took":1,"hits":{"total":7,"hits":[]}}').total).toEqual({
      value: 7,
      relation: 'eq',
    });
  });
});

describe('parseSearchError', () => {
  it('reads type, reason, root cause and the parse position', () => {
    const body = JSON.stringify({
      error: {
        root_cause: [
          { type: 'parsing_exception', reason: 'unknown query [match_al]', line: 2, col: 25 },
        ],
        type: 'parsing_exception',
        reason: 'unknown query [match_al]',
        line: 2,
        col: 25,
        caused_by: { type: 'named_object_not_found_exception', reason: '[2:25] unknown field' },
      },
      status: 400,
    });
    expect(parseSearchError(body)).toEqual({
      type: 'parsing_exception',
      reason: 'unknown query [match_al]',
      causedBy: '[2:25] unknown field',
      line: 2,
      column: 25,
    });
  });

  it('finds positions written into the reason', () => {
    const reason = "[3:1] Unexpected character ('}' (code 125))";
    expect(
      parseSearchError(JSON.stringify({ error: { type: 'x_content_parse_exception', reason } })),
    ).toMatchObject({ line: 3, column: 1 });
    const jackson = 'Unexpected character at [Source: REDACTED; line: 4, column: 7]';
    expect(
      parseSearchError(
        JSON.stringify({ error: { type: 'json_parse_exception', reason: jackson } }),
      ),
    ).toMatchObject({ line: 4, column: 7 });
  });

  it('reads the plain error form and non-JSON bodies', () => {
    expect(parseSearchError('{"error":"no handler found for uri [/x] and method [GET]"}')).toEqual({
      type: '',
      reason: 'no handler found for uri [/x] and method [GET]',
    });
    expect(parseSearchError('<html>Bad gateway</html>')).toEqual({
      type: '',
      reason: '<html>Bad gateway</html>',
    });
    expect(parseSearchError('')).toBeUndefined();
  });
});

describe('searchCapabilities', () => {
  it('follows Elasticsearch versions and flavours', () => {
    expect(searchCapabilities({ distribution: 'elasticsearch', version: '9.4.0' })).toMatchObject({
      esql: true,
      sql: 'elasticsearch',
      dataStreams: true,
      lifecycle: 'ilm',
      pointInTime: true,
      shardDocSort: true,
      security: 'elasticsearch',
    });
    expect(searchCapabilities({ distribution: 'elasticsearch', version: '8.10.4' }).esql).toBe(
      false,
    );
    expect(searchCapabilities({ distribution: 'elasticsearch', version: '7.17.28' })).toMatchObject(
      {
        esql: false,
        pointInTime: true,
        dataStreams: true,
      },
    );
    expect(
      searchCapabilities({ distribution: 'elasticsearch', version: '7.10.2', buildFlavor: 'oss' }),
    ).toMatchObject({ sql: null, lifecycle: null, pointInTime: false, dataStreams: false });
  });

  it('follows OpenSearch versions and plugins', () => {
    expect(
      searchCapabilities({ distribution: 'opensearch', version: '3.5.0', plugins: [] }),
    ).toMatchObject({
      esql: false,
      sql: null,
      lifecycle: null,
      pointInTime: true,
      security: null,
    });
    expect(
      searchCapabilities({
        distribution: 'opensearch',
        version: '2.19.1',
        plugins: ['opensearch-sql', 'opensearch-index-management', 'opensearch-security'],
      }),
    ).toMatchObject({ sql: 'opensearch', ppl: true, lifecycle: 'ism', security: 'opensearch' });
    expect(searchCapabilities({ distribution: 'opensearch', version: '2.3.0' }).pointInTime).toBe(
      false,
    );
  });

  it('compares versions numerically', () => {
    expect(versionAtLeast('8.11.0', '8.11')).toBe(true);
    expect(versionAtLeast('8.9.3', '8.11')).toBe(false);
    expect(versionAtLeast('10.0.0', '9.4')).toBe(true);
  });
});
