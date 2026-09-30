import { describe, expect, it } from 'vitest';

import {
  commandLine,
  definitionOf,
  hashFields,
  jsonFields,
  parseSearchInfo,
  parseSearchReply,
  searchCreateArgs,
  suggestFieldType,
  suggestSearchFields,
  utf8Text,
  type SearchIndexDefinition,
} from '../src';
import { enc, recorded } from './fixtures';

/**
 * RediSearch replies recorded from Redis 8.2 (test/fixtures/ft-*-8.2.resp: a hash index with
 * TEXT, NUMERIC, TAG and GEO fields, a JSON index, a vector index with a filter) and from
 * valkey-search (the valkey-bundle image), and the FT.CREATE built from definitions.
 */

describe('parseSearchInfo', () => {
  it('reads a hash index: definition, fields with options and flags, figures', () => {
    const info = parseSearchInfo(recorded('ft-info-books-8.2.resp'));
    expect(info).toMatchObject({
      name: 'books',
      keyType: 'HASH',
      prefixes: ['book:'],
      filter: null,
      documents: 3,
      terms: 10,
      records: 20,
      indexing: false,
      percentIndexed: 1,
      failures: 0,
      lastError: null,
      lastErrorKey: null,
    });
    expect(info.memoryBytes).toBeGreaterThan(0);
    expect(info.fields).toEqual([
      {
        identifier: 'title',
        attribute: 'title',
        type: 'TEXT',
        options: { WEIGHT: '2' },
        flags: ['SORTABLE'],
      },
      {
        identifier: 'author',
        attribute: 'author',
        type: 'TEXT',
        options: { WEIGHT: '1' },
        flags: ['NOSTEM'],
      },
      {
        identifier: 'year',
        attribute: 'year',
        type: 'NUMERIC',
        options: {},
        flags: ['SORTABLE', 'UNF'],
      },
      {
        identifier: 'tags',
        attribute: 'tags',
        type: 'TAG',
        options: { SEPARATOR: ',' },
        flags: [],
      },
      { identifier: 'price', attribute: 'price', type: 'NUMERIC', options: {}, flags: [] },
      { identifier: 'loc', attribute: 'loc', type: 'GEO', options: {}, flags: [] },
    ]);
    const stats = new Map(info.stats);
    expect(stats.get('num_docs')).toBe('3');
    expect(stats.get('gc_stats.bytes_collected')).toBe('0');
    expect(stats.get('dialect_stats.dialect_2')).toBe('0');
    expect(stats.get('Index Errors.indexing failures')).toBe('0');
  });

  it('reads a JSON index with paths and names, and a vector index with its filter', () => {
    const users = parseSearchInfo(recorded('ft-info-users-8.2.resp'));
    expect(users).toMatchObject({ keyType: 'JSON', prefixes: ['user:'] });
    expect(users.fields.map((f) => [f.identifier, f.attribute, f.type])).toEqual([
      ['$.name', 'name', 'TEXT'],
      ['$.age', 'age', 'NUMERIC'],
      ['$.tags[*]', 'tags', 'TAG'],
    ]);

    const vecs = parseSearchInfo(recorded('ft-info-vecs-8.2.resp'));
    expect(vecs.filter).toBe('@year>0');
    expect(vecs.fields[0]).toMatchObject({
      identifier: 'emb',
      type: 'VECTOR',
      options: {
        algorithm: 'HNSW',
        data_type: 'FLOAT32',
        dim: '4',
        distance_metric: 'COSINE',
        M: '16',
        ef_construction: '200',
      },
    });
    expect(vecs.fields[1]).toMatchObject({ type: 'TAG', flags: ['CASESENSITIVE'] });
  });

  it('reads valkey-search, which nests vector settings and writes flags with 0 or 1', () => {
    const info = parseSearchInfo(recorded('ft-info-valkey-search.resp'));
    expect(info).toMatchObject({ name: 'vidx', keyType: 'HASH', prefixes: ['v:'], documents: 1 });
    const [emb, num, tag] = info.fields;
    expect(emb).toMatchObject({ identifier: 'emb', type: 'VECTOR' });
    expect(emb!.options).toMatchObject({
      'index.dimensions': '4',
      'index.distance_metric': 'COSINE',
      'index.data_type': 'FLOAT32',
      'index.algorithm.name': 'HNSW',
    });
    expect(num).toMatchObject({ type: 'NUMERIC' });
    // CASESENSITIVE 0: not a flag.
    expect(tag).toMatchObject({ type: 'TAG', options: { SEPARATOR: ',' }, flags: [] });
    expect(definitionOf(info).fields[0]).toMatchObject({
      type: 'VECTOR',
      vector: { algorithm: 'HNSW', dim: 4, distance: 'COSINE', dataType: 'FLOAT32' },
    });
  });
});

describe('parseSearchReply', () => {
  it('reads documents with scores and fields', () => {
    const result = parseSearchReply(recorded('ft-search-books-8.2.resp'), { withScores: true });
    expect(result.total).toBe(2);
    expect(result.documents.map((d) => utf8Text(d.key))).toEqual(['book:2', 'book:1']);
    expect(result.documents[0]!.score).toBeGreaterThan(0);
    const fields = Object.fromEntries(
      result.documents[1]!.fields.map(([name, value]) => [name, utf8Text(value)]),
    );
    expect(fields).toMatchObject({ title: 'Dune', year: '1965', loc: '13.36,52.51' });
  });

  it('reads a JSON index document and a NOCONTENT reply', () => {
    const users = parseSearchReply(recorded('ft-search-users-8.2.resp'));
    expect(users.documents[0]!.fields.map(([name, value]) => [name, utf8Text(value)])).toEqual([
      ['$', '{"name":"Ada","age":36,"tags":["math","code"]}'],
    ]);
    const keys = parseSearchReply(recorded('ft-search-nocontent-8.2.resp'), { noContent: true });
    expect(keys.total).toBe(3);
    expect(keys.documents.map((d) => [utf8Text(d.key), d.fields])).toEqual(
      expect.arrayContaining([['book:1', []]]),
    );
  });
});

describe('FT.CREATE', () => {
  const books: SearchIndexDefinition = {
    name: 'books',
    keyType: 'HASH',
    prefixes: ['book:'],
    fields: [
      { identifier: 'title', type: 'TEXT', weight: 2, sortable: true },
      { identifier: 'author', type: 'TEXT', noStem: true },
      { identifier: 'year', type: 'NUMERIC', sortable: true },
      { identifier: 'tags', type: 'TAG', separator: ',', caseSensitive: true },
      { identifier: 'loc', type: 'GEO' },
      {
        identifier: 'embedding',
        type: 'VECTOR',
        vector: { algorithm: 'HNSW', dim: 384, distance: 'COSINE', dataType: 'FLOAT32', m: 32 },
      },
    ],
  };

  it('builds the arguments', () => {
    expect(searchCreateArgs(books)).toEqual([
      'books',
      'ON',
      'HASH',
      'PREFIX',
      '1',
      'book:',
      'SCHEMA',
      'title',
      'TEXT',
      'WEIGHT',
      '2',
      'SORTABLE',
      'author',
      'TEXT',
      'NOSTEM',
      'year',
      'NUMERIC',
      'SORTABLE',
      'tags',
      'TAG',
      'CASESENSITIVE',
      'loc',
      'GEO',
      'embedding',
      'VECTOR',
      'HNSW',
      '8',
      'TYPE',
      'FLOAT32',
      'DIM',
      '384',
      'DISTANCE_METRIC',
      'COSINE',
      'M',
      '32',
    ]);
    expect(
      searchCreateArgs({
        name: 'people',
        keyType: 'JSON',
        prefixes: ['p:', 'person:'],
        filter: '@age > 18',
        fields: [{ identifier: '$.name', attribute: 'name', type: 'TEXT' }],
      }),
    ).toEqual([
      'people',
      'ON',
      'JSON',
      'PREFIX',
      '2',
      'p:',
      'person:',
      'FILTER',
      '@age > 18',
      'SCHEMA',
      '$.name',
      'AS',
      'name',
      'TEXT',
    ]);
  });

  it('writes the command as a line, quoted where needed', () => {
    expect(
      commandLine('FT.CREATE', ['idx', 'ON', 'HASH', 'FILTER', '@age > 18', 'SEPARATOR', ';']),
    ).toBe('FT.CREATE idx ON HASH FILTER "@age > 18" SEPARATOR ";"');
    expect(commandLine('FT.SEARCH', ['idx', 'say "hi"', ''])).toBe(
      'FT.SEARCH idx "say \\"hi\\"" ""',
    );
  });

  it('rebuilds an index definition from its info', () => {
    const info = parseSearchInfo(recorded('ft-info-books-8.2.resp'));
    expect(searchCreateArgs(definitionOf(info))).toEqual([
      'books',
      'ON',
      'HASH',
      'PREFIX',
      '1',
      'book:',
      'SCHEMA',
      'title',
      'TEXT',
      'WEIGHT',
      '2',
      'SORTABLE',
      'author',
      'TEXT',
      'NOSTEM',
      'year',
      'NUMERIC',
      'SORTABLE',
      'tags',
      'TAG',
      'price',
      'NUMERIC',
      'loc',
      'GEO',
    ]);
    const users = parseSearchInfo(recorded('ft-info-users-8.2.resp'));
    expect(searchCreateArgs(definitionOf(users))).toEqual([
      'users',
      'ON',
      'JSON',
      'PREFIX',
      '1',
      'user:',
      'SCHEMA',
      '$.name',
      'AS',
      'name',
      'TEXT',
      '$.age',
      'AS',
      'age',
      'NUMERIC',
      '$.tags[*]',
      'AS',
      'tags',
      'TAG',
    ]);
    const vecs = parseSearchInfo(recorded('ft-info-vecs-8.2.resp'));
    expect(commandLine('FT.CREATE', searchCreateArgs(definitionOf(vecs)))).toBe(
      'FT.CREATE vecs ON HASH PREFIX 1 v: FILTER "@year>0" SCHEMA emb VECTOR HNSW 10 TYPE FLOAT32 DIM 4 DISTANCE_METRIC COSINE M 16 EF_CONSTRUCTION 200 code TAG CASESENSITIVE',
    );
  });
});

describe('suggested fields', () => {
  it('types sample values', () => {
    expect(suggestFieldType(['1965', '1984', '-3.5e2'])).toBe('NUMERIC');
    expect(suggestFieldType(['13.36,52.51', '-73.98,40.75'])).toBe('GEO');
    expect(suggestFieldType(['scifi,classic', 'romance'])).toBe('TAG');
    expect(suggestFieldType(['red', 'green', 'red', 'red', 'green', 'red'])).toBe('TAG');
    expect(suggestFieldType(['A long title about dune', 'Neuromancer and cyberspace'])).toBe(
      'TEXT',
    );
    expect(suggestFieldType([])).toBe('TEXT');
  });

  it('suggests hash fields and JSON paths from sample documents', () => {
    const hash = suggestSearchFields(
      [
        hashFields([
          [enc('title'), enc('Dune')],
          [enc('year'), enc('1965')],
          [enc('blob'), Uint8Array.from([0xff, 0xfe])],
        ]),
        hashFields([
          [enc('title'), enc('Emma')],
          [enc('year'), enc('1815')],
        ]),
      ],
      'HASH',
    );
    expect(hash.map((f) => [f.identifier, f.type, f.seen])).toEqual([
      ['title', 'TEXT', 2],
      ['year', 'NUMERIC', 2],
    ]);
    expect(hash[1]).toMatchObject({ sortable: true, example: '1965' });

    const fields = jsonFields(
      '[{"name":"Ada","age":36,"tags":["math","code"],"address":{"city":"London"},"weird key":1}]',
    );
    expect(fields).toEqual([
      ['$.name', 'Ada'],
      ['$.age', '36'],
      ['$.tags[*]', 'math,code'],
      ['$.address.city', 'London'],
      ['$["weird key"]', '1'],
    ]);
    const json = suggestSearchFields([fields], 'JSON');
    expect(json.find((f) => f.identifier === '$.tags[*]')).toMatchObject({
      attribute: 'tags',
      type: 'TAG',
    });
    expect(json.find((f) => f.identifier === '$.address.city')).toMatchObject({
      attribute: 'address_city',
    });
    expect(jsonFields('not json')).toEqual([]);
  });
});
