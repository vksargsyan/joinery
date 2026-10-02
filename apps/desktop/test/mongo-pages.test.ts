import { describe, expect, it } from 'vitest';

import { lastPage, pageWindow, queryTotal } from '../src/renderer/src/state/mongo/pages';

/** A collection view's pages: each a find() with its own skip and limit, inside the query's. */

describe('pageWindow', () => {
  it('reads each page at its skip', () => {
    expect(pageWindow(1, 100, {})).toEqual({ skip: 0, limit: 100 });
    expect(pageWindow(3, 100, {})).toEqual({ skip: 200, limit: 100 });
  });

  it('keeps inside the skip and limit typed in the query bar', () => {
    expect(pageWindow(1, 100, { skip: 10, limit: 250 })).toEqual({ skip: 10, limit: 100 });
    expect(pageWindow(3, 100, { skip: 10, limit: 250 })).toEqual({ skip: 210, limit: 50 });
    expect(pageWindow(4, 100, { skip: 10, limit: 250 })).toBeUndefined();
    // Limit 0 is none; a negative limit takes its size.
    expect(pageWindow(9, 100, { limit: 0 })).toEqual({ skip: 800, limit: 100 });
    expect(pageWindow(1, 100, { limit: -20 })).toEqual({ skip: 0, limit: 20 });
  });
});

describe('queryTotal and lastPage', () => {
  it('counts what the query returns from what its filter matches', () => {
    expect(queryTotal(150, {})).toBe(150);
    expect(queryTotal(150, { skip: 20 })).toBe(130);
    expect(queryTotal(150, { skip: 20, limit: 50 })).toBe(50);
    expect(queryTotal(10, { skip: 20 })).toBe(0);
  });

  it('finds the last page, and page 1 of nothing', () => {
    expect(lastPage(150, 100)).toBe(2);
    expect(lastPage(200, 100)).toBe(2);
    expect(lastPage(0, 100)).toBe(1);
  });
});
