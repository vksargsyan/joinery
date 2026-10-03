import { QuerybaraError } from '@querybara/core';
import { commandLine, definitionOf, searchCreateArgs } from '@querybara/redis-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RedisSession } from '../../src';
import { REDIS_URL, cleanup, connect, dec, newPrefix, standaloneProfile } from './helpers';

/**
 * RediSearch against the test server: a hash index and a JSON index created from suggested
 * fields, described, queried (scores, sort, return, paging, params), explained, and dropped,
 * once with its documents. Servers without the search module (Redis 7.4 without Stack) refuse
 * with NOT_SUPPORTED, which the first test checks instead.
 */

describe.skipIf(!REDIS_URL)('RediSearch', () => {
  let session: RedisSession;
  let supported = true;
  const p = newPrefix();
  const books = `${p.replace(/:/g, '_')}books`;
  const users = `${p.replace(/:/g, '_')}users`;

  beforeAll(async () => {
    session = await connect(standaloneProfile());
    const listed = await session.searchIndexes().catch((e: unknown) => e);
    supported = !(listed instanceof QuerybaraError);
    if (!supported) return;
    for (const [id, title, author, year, tags] of [
      ['1', 'Dune', 'Frank Herbert', '1965', 'scifi,classic'],
      ['2', 'Neuromancer', 'William Gibson', '1984', 'scifi,cyberpunk'],
      ['3', 'Emma', 'Jane Austen', '1815', 'classic,romance'],
    ] as const) {
      await session.command([
        'HSET',
        `${p}book:${id}`,
        'title',
        title,
        'author',
        author,
        'year',
        year,
        'tags',
        tags,
      ]);
    }
    for (const [id, doc] of [
      ['1', { name: 'Ada', age: 36, tags: ['math', 'code'] }],
      ['2', { name: 'Grace', age: 85, tags: ['navy', 'code'] }],
    ] as const) {
      await session.command(['JSON.SET', `${p}user:${id}`, '$', JSON.stringify(doc)]);
    }
  });

  afterAll(async () => {
    if (supported) {
      for (const index of [books, users])
        await session.searchDrop(index, false).catch(() => undefined);
    }
    await cleanup(session, p);
    await session?.close();
  });

  it('lists indexes, or says the module is missing', async () => {
    const listed = await session.searchIndexes().catch((e: unknown) => e);
    if (!supported) {
      expect(listed).toMatchObject({
        code: 'NOT_SUPPORTED',
        message: expect.stringContaining('search module'),
      });
      return;
    }
    expect(Array.isArray(listed)).toBe(true);
  });

  it('suggests fields from sample hashes and creates an index from them', async () => {
    if (!supported) return;
    const suggested = await session.searchSuggest('HASH', `${p}book:`);
    expect(suggested.map((f) => [f.identifier, f.type])).toEqual(
      expect.arrayContaining([
        ['year', 'NUMERIC'],
        ['tags', 'TAG'],
      ]),
    );
    await session.searchCreate({
      name: books,
      keyType: 'HASH',
      prefixes: [`${p}book:`],
      fields: [
        { identifier: 'title', type: 'TEXT', weight: 2, sortable: true },
        { identifier: 'author', type: 'TEXT', noStem: true },
        { identifier: 'year', type: 'NUMERIC', sortable: true },
        { identifier: 'tags', type: 'TAG' },
      ],
    });
    expect(await session.searchIndexes()).toContain(books);
    await expect
      .poll(async () => (await session.searchInfo(books)).documents, { timeout: 5000 })
      .toBe(3);
    const info = await session.searchInfo(books);
    expect(info).toMatchObject({ keyType: 'HASH', prefixes: [`${p}book:`], indexing: false });
    expect(info.fields.map((f) => [f.attribute, f.type])).toEqual([
      ['title', 'TEXT'],
      ['author', 'TEXT'],
      ['year', 'NUMERIC'],
      ['tags', 'TAG'],
    ]);
    // The info rebuilds the command that made the index.
    expect(commandLine('FT.CREATE', searchCreateArgs(definitionOf(info)))).toContain(
      'SCHEMA title TEXT WEIGHT 2 SORTABLE author TEXT NOSTEM year NUMERIC SORTABLE tags TAG',
    );
  });

  it('queries with scores, sort, returned fields, paging and parameters', async () => {
    if (!supported) return;
    const scifi = await session.searchQuery(books, '@tags:{scifi}', {
      withScores: true,
      sortBy: 'year',
      sortDescending: true,
      returnFields: ['title', 'year'],
    });
    expect(scifi.total).toBe(2);
    expect(scifi.documents.map((d) => dec(d.key))).toEqual([`${p}book:2`, `${p}book:1`]);
    expect(scifi.documents[0]!.score).not.toBeNull();
    // With SORTBY the sort field comes first.
    expect(
      Object.fromEntries(scifi.documents[0]!.fields.map(([name, value]) => [name, dec(value)])),
    ).toEqual({ title: 'Neuromancer', year: '1984' });

    const page = await session.searchQuery(books, '*', { sortBy: 'year', offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.documents.map((d) => dec(d.key))).toEqual([`${p}book:1`]);

    const params = await session.searchQuery(books, '@year:[$from $to]', {
      params: { from: '1900', to: '2000' },
      dialect: 2,
      noContent: true,
    });
    expect(params.total).toBe(2);
    expect(params.documents.every((d) => d.fields.length === 0)).toBe(true);

    const explained = await session.searchExplain(books, '@title:dune @year:[1900 2000]');
    expect(explained).toMatch(/INTERSECT/);
    expect(explained).toMatch(/NUMERIC/);

    await expect(session.searchQuery(books, '((')).rejects.toMatchObject({
      message: expect.stringMatching(/syntax/i),
    });
  });

  it('indexes JSON documents by path, and drops an index with its documents', async () => {
    if (!supported) return;
    const suggested = await session.searchSuggest('JSON', `${p}user:`);
    expect(suggested.find((f) => f.identifier === '$.tags[*]')).toMatchObject({
      attribute: 'tags',
      type: 'TAG',
    });
    await session.searchCreate({
      name: users,
      keyType: 'JSON',
      prefixes: [`${p}user:`],
      fields: [
        { identifier: '$.name', attribute: 'name', type: 'TEXT' },
        { identifier: '$.age', attribute: 'age', type: 'NUMERIC', sortable: true },
        { identifier: '$.tags[*]', attribute: 'tags', type: 'TAG' },
      ],
    });
    await expect
      .poll(async () => (await session.searchInfo(users)).documents, { timeout: 5000 })
      .toBe(2);
    const coders = await session.searchQuery(users, '@tags:{code}', { sortBy: 'age' });
    // A JSON index returns the document as `$` (after the sort field).
    const documents = coders.documents.map((d) => dec(d.fields.find(([name]) => name === '$')![1]));
    expect(documents).toEqual([
      expect.stringContaining('"Ada"'),
      expect.stringContaining('"Grace"'),
    ]);

    await session.searchDrop(users, true);
    expect(await session.searchIndexes()).not.toContain(users);
    expect(await session.command(['EXISTS', `${p}user:1`, `${p}user:2`])).toMatchObject({
      type: 'integer',
      value: 0,
    });
  });
});
