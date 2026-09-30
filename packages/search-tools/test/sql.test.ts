import { describe, expect, it } from 'vitest';

import {
  cellDisplay,
  classifyRequest,
  esqlRequest,
  parseTableReply,
  sqlCloseRequest,
  sqlCursorRequest,
  sqlFromTarget,
  sqlRequest,
  sqlTranslateRequest,
  translatedDsl,
} from '../src';

describe('SQL and ES|QL requests', () => {
  it('builds the SQL API and SQL plugin requests', () => {
    expect(sqlRequest('elasticsearch', 'SELECT 1', { fetchSize: 50, timeZone: 'UTC' })).toEqual({
      method: 'POST',
      path: '/_sql',
      query: 'format=json',
      body: '{"query": "SELECT 1", "fetch_size": 50, "time_zone": "UTC"}',
    });
    expect(sqlRequest('opensearch', 'SELECT "a"')).toEqual({
      method: 'POST',
      path: '/_plugins/_sql',
      query: 'format=jdbc',
      body: '{"query": "SELECT \\"a\\"", "fetch_size": 1000}',
    });
    expect(sqlCursorRequest('elasticsearch', 'c1').body).toBe('{"cursor": "c1"}');
    expect(sqlCloseRequest('opensearch', 'c1').path).toBe('/_plugins/_sql/close');
    expect(sqlTranslateRequest('elasticsearch', 'SELECT 1').path).toBe('/_sql/translate');
    expect(sqlTranslateRequest('opensearch', 'SELECT 1').path).toBe('/_plugins/_sql/_explain');
    expect(esqlRequest('FROM logs | LIMIT 5')).toMatchObject({ path: '/_query' });
  });

  it('classifies SQL, translate, cursor and ES|QL requests as reads', () => {
    for (const request of [
      sqlRequest('elasticsearch', 'SELECT 1'),
      sqlRequest('opensearch', 'SELECT 1'),
      sqlCursorRequest('elasticsearch', 'c'),
      sqlCloseRequest('elasticsearch', 'c'),
      sqlCloseRequest('opensearch', 'c'),
      sqlTranslateRequest('elasticsearch', 'SELECT 1'),
      sqlTranslateRequest('opensearch', 'SELECT 1'),
      esqlRequest('FROM x'),
    ]) {
      expect(classifyRequest(request).writes, request.path).toBe(false);
    }
  });
});

describe('parseTableReply', () => {
  it('reads Elasticsearch SQL with exact cells and a cursor', () => {
    const table = parseTableReply(
      '{"columns":[{"name":"id","type":"long"},{"name":"name","type":"keyword"}],"rows":[[12345678901234567890,"Ada"],[2,null]],"cursor":"abc"}',
    );
    expect(table).toEqual({
      columns: [
        { name: 'id', type: 'long' },
        { name: 'name', type: 'keyword' },
      ],
      rows: [
        ['12345678901234567890', '"Ada"'],
        ['2', 'null'],
      ],
      cursor: 'abc',
    });
    // A later page has no columns.
    expect(parseTableReply('{"rows":[[3,"Bo"]]}')).toEqual({ columns: [], rows: [['3', '"Bo"']] });
  });

  it('reads the OpenSearch JDBC format', () => {
    expect(
      parseTableReply(
        '{"schema":[{"name":"n","alias":"count","type":"integer"}],"datarows":[[4]],"total":1,"size":1,"status":200}',
      ),
    ).toEqual({ columns: [{ name: 'n', type: 'integer' }], rows: [['4']], total: 1 });
  });

  it('reads ES|QL with its partial flag and time', () => {
    expect(
      parseTableReply(
        '{"took":3,"is_partial":true,"columns":[{"name":"x","type":"double"}],"values":[[1.10]]}',
      ),
    ).toEqual({
      columns: [{ name: 'x', type: 'double' }],
      rows: [['1.10']],
      partial: true,
      tookMs: 3,
    });
  });

  it('shows strings unquoted and other cells as written', () => {
    expect(cellDisplay('"a \\"b\\""')).toBe('a "b"');
    expect(cellDisplay('1.10')).toBe('1.10');
    expect(cellDisplay('{ "a" : [1, 2] }')).toBe('{"a":[1,2]}');
    expect(cellDisplay('null')).toBe('null');
  });
});

describe('Translate to DSL', () => {
  it('finds the FROM target', () => {
    expect(sqlFromTarget('SELECT * FROM logs WHERE a = 1')).toBe('logs');
    expect(sqlFromTarget('select a from "logs-*" limit 5')).toBe('logs-*');
    expect(sqlFromTarget('SELECT 1 FROM `my-index`')).toBe('my-index');
    expect(sqlFromTarget('SELECT 1')).toBeUndefined();
  });

  it('takes Elasticsearch translate replies as the DSL', () => {
    const body = '{"size":1000,"query":{"term":{"a":{"value":1}}},"_source":false}';
    expect(translatedDsl('elasticsearch', body)).toBe(body);
    expect(translatedDsl('elasticsearch', '{"error": "x"}')).toBeUndefined();
  });

  it('digs the DSL out of an OpenSearch explain plan', () => {
    const plan = JSON.stringify({
      root: {
        name: 'ProjectOperator',
        children: [
          {
            name: 'OpenSearchIndexScan',
            description: {
              request:
                'OpenSearchQueryRequest(indexName=logs, sourceBuilder={"from":0,"size":200,"query":{"term":{"level":{"value":"error"}}},"_source":{"includes":["msg"]}}, searchDone=false)',
            },
          },
        ],
      },
    });
    expect(translatedDsl('opensearch', plan)).toBe(
      '{"from":0,"size":200,"query":{"term":{"level":{"value":"error"}}},"_source":{"includes":["msg"]}}',
    );
    // The legacy engine answers with the DSL itself.
    expect(translatedDsl('opensearch', '{"from":0,"size":10}')).toBe('{"from":0,"size":10}');
    expect(translatedDsl('opensearch', '{"calcite":{"logical":"LogicalProject"}}')).toBeUndefined();
  });
});
