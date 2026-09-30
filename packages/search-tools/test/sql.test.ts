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
  it('builds the SQL API requests', () => {
    expect(sqlRequest('SELECT 1', { fetchSize: 50, timeZone: 'UTC' })).toEqual({
      method: 'POST',
      path: '/_sql',
      query: 'format=json',
      body: '{"query": "SELECT 1", "fetch_size": 50, "time_zone": "UTC"}',
    });
    expect(sqlRequest('SELECT "a"')).toEqual({
      method: 'POST',
      path: '/_sql',
      query: 'format=json',
      body: '{"query": "SELECT \\"a\\"", "fetch_size": 1000}',
    });
    expect(sqlCursorRequest('c1')).toEqual({
      method: 'POST',
      path: '/_sql',
      query: 'format=json',
      body: '{"cursor": "c1"}',
    });
    expect(sqlCloseRequest('c1').path).toBe('/_sql/close');
    expect(sqlTranslateRequest('SELECT 1').path).toBe('/_sql/translate');
    expect(esqlRequest('FROM logs | LIMIT 5')).toMatchObject({ path: '/_query' });
  });

  it('classifies SQL, translate, cursor and ES|QL requests as reads', () => {
    for (const request of [
      sqlRequest('SELECT 1'),
      sqlCursorRequest('c'),
      sqlCloseRequest('c'),
      sqlTranslateRequest('SELECT 1'),
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
    expect(sqlFromTarget('SELECT 1 FROM "we""ird"')).toBe('we"ird');
    expect(sqlFromTarget('SELECT 1')).toBeUndefined();
  });

  it('takes Elasticsearch translate replies as the DSL', () => {
    const body = '{"size":1000,"query":{"term":{"a":{"value":1}}},"_source":false}';
    expect(translatedDsl(body)).toBe(body);
    expect(translatedDsl('{"error": "x"}')).toBeUndefined();
    expect(translatedDsl('not json')).toBeUndefined();
  });
});
