import { parseSearchInfo, type SearchIndexInfo } from '@querybara/redis-tools';
import { describe, expect, it } from 'vitest';

import { classifyRedisCommand } from '../src/shared/redis-safety';
import {
  createPreview,
  definitionOfDraft,
  emptyDraft,
  mergeSuggestions,
  newField,
  querySnippet,
  resultColumns,
  sortableFields,
  type IndexDraft,
} from '../src/renderer/src/state/redis/search';

/**
 * The Search indexes tool's logic: a new index checked and turned into FT.CREATE, suggested
 * fields merged into the form, query snippets, result columns and the CLI's write rules for
 * FT.* commands.
 */

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function draft(patch: Partial<IndexDraft>): IndexDraft {
  return { ...emptyDraft('book:'), ...patch };
}

describe('a new index', () => {
  it('names itself from the prefix', () => {
    expect(emptyDraft('book:')).toMatchObject({
      name: 'idx_book',
      prefixes: 'book:',
      keyType: 'HASH',
    });
    expect(emptyDraft().name).toBe('');
  });

  it('becomes FT.CREATE once every field is complete', () => {
    const complete = draft({
      prefixes: 'book: novel:',
      fields: [
        newField({ identifier: 'title', type: 'TEXT', weight: '2', sortable: true }),
        newField({ identifier: 'tags', type: 'TAG', separator: ';', caseSensitive: true }),
        newField({ identifier: 'year', type: 'NUMERIC', sortable: true }),
        newField({ identifier: 'emb', type: 'VECTOR', dim: '384', algorithm: 'FLAT' }),
      ],
    });
    expect(createPreview(complete)).toBe(
      'FT.CREATE idx_book ON HASH PREFIX 2 book: novel: SCHEMA title TEXT WEIGHT 2 SORTABLE tags TAG SEPARATOR ";" CASESENSITIVE year NUMERIC SORTABLE emb VECTOR FLAT 6 TYPE FLOAT32 DIM 384 DISTANCE_METRIC COSINE',
    );
  });

  it('says what is missing', () => {
    const problem = (d: IndexDraft): string | undefined => {
      const result = definitionOfDraft(d);
      return 'problem' in result ? result.problem : undefined;
    };
    expect(problem(draft({ name: ' ' }))).toBe('Name the index');
    expect(problem(draft({ name: 'my index' }))).toBe('An index name has no spaces');
    expect(problem(draft({}))).toBe('Add at least one field');
    expect(problem(draft({ fields: [newField()] }))).toBe(
      'Every field needs a name or a JSON path',
    );
    expect(problem(draft({ keyType: 'JSON', fields: [newField({ identifier: 'name' })] }))).toBe(
      'name: JSON fields are paths starting with $',
    );
    expect(problem(draft({ keyType: 'JSON', fields: [newField({ identifier: '$.name' })] }))).toBe(
      '$.name: give the path a name to query it by',
    );
    expect(
      problem(draft({ fields: [newField({ identifier: 'a' }), newField({ identifier: 'A' })] })),
    ).toBe('A is used twice');
    expect(problem(draft({ fields: [newField({ identifier: 'v', type: 'VECTOR' })] }))).toBe(
      'v: a vector needs its dimension (1 to 32,768)',
    );
    expect(problem(draft({ fields: [newField({ identifier: 't', weight: '0' })] }))).toBe(
      't: the weight is a positive number',
    );
    expect(
      problem(draft({ fields: [newField({ identifier: 'g', type: 'TAG', separator: '' })] })),
    ).toBe('g: the separator is one character');
    expect(createPreview(draft({}))).toBeNull();
  });

  it('adds suggested fields it does not have yet', () => {
    const merged = mergeSuggestions(
      [newField({ identifier: 'title' }), newField({ identifier: '' })],
      [
        { identifier: 'title', type: 'TAG', seen: 3, example: 'Dune' },
        { identifier: 'year', type: 'NUMERIC', sortable: true, seen: 3, example: '1965' },
      ],
    );
    expect(merged.map((f) => [f.identifier, f.type, f.sortable, f.example])).toEqual([
      ['title', 'TEXT', false, undefined],
      ['year', 'NUMERIC', true, '1965'],
    ]);
  });
});

describe('queries', () => {
  it('starts a clause for each field type', () => {
    expect(querySnippet('title', 'TEXT')).toBe('@title:term');
    expect(querySnippet('tags', 'TAG', 'sci fi,classic')).toBe('@tags:{sci\\ fi}');
    expect(querySnippet('year', 'NUMERIC')).toBe('@year:[0 +inf]');
    expect(querySnippet('year', 'NUMERIC', '1965')).toBe('@year:[1965 1965]');
    expect(querySnippet('loc', 'GEO', '13.36,52.51')).toBe('@loc:[13.36 52.51 10 km]');
    expect(querySnippet('emb', 'VECTOR')).toBe('*=>[KNN 10 @emb $vector]');
  });

  it('orders result columns by the schema, the JSON document last', () => {
    const info = {
      fields: [
        { identifier: 'title', attribute: 'title', type: 'TEXT', options: {}, flags: ['SORTABLE'] },
        { identifier: 'year', attribute: 'year', type: 'NUMERIC', options: {}, flags: [] },
      ],
    } as unknown as SearchIndexInfo;
    expect(sortableFields(info)).toEqual(['title']);
    expect(
      resultColumns(
        [
          {
            key: enc('a'),
            score: null,
            fields: [
              ['year', enc('1')],
              ['$', enc('{}')],
            ],
          },
          {
            key: enc('b'),
            score: null,
            fields: [
              ['extra', enc('x')],
              ['title', enc('t')],
            ],
          },
        ],
        info,
      ),
    ).toEqual(['title', 'year', 'extra', '$']);
    expect(parseSearchInfo).toBeTypeOf('function');
  });
});

describe('FT.* in the CLI', () => {
  const classify = (line: string) => classifyRedisCommand(line.split(' '), undefined);

  it('reads, writes and destroys like the commands they are', () => {
    expect(classify('FT.SEARCH idx *')).toMatchObject({ write: false });
    expect(classify('FT.INFO idx')).toMatchObject({ write: false });
    expect(classify('FT._LIST')).toMatchObject({ write: false });
    expect(classify('FT.CREATE idx SCHEMA a TEXT')).toMatchObject({ write: true });
    expect(classify('FT.ALTER idx SCHEMA ADD b TAG')).toMatchObject({ write: true });
    expect(classify('FT.DROPINDEX idx DD')).toMatchObject({
      write: true,
      destructive: expect.stringContaining('drops a search index'),
    });
  });
});
