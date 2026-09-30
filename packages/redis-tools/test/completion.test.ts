import { describe, expect, it } from 'vitest';

import { buildCommandCatalog, completeLine, suggestNext, type CompletionResult } from '../src';
import { recorded } from './fixtures';

const catalog = buildCommandCatalog({
  docs: recorded('command-docs-7.0.resp'),
  info: recorded('command-info-7.0.resp'),
});

const texts = (result: CompletionResult): string[] => result.suggestions.map((s) => s.text);
const words = (line: string): string[] => line.split(' ').filter(Boolean);

describe('suggestNext', () => {
  it('suggests command names by prefix', () => {
    const result = suggestNext(catalog, [], 's');
    expect(texts(result)).toEqual(expect.arrayContaining(['SET', 'SCAN', 'SORT']));
    expect(texts(result)).not.toContain('GET');
    expect(result.suggestions.find((s) => s.text === 'SET')!.detail).toBe(
      'Set the string value of a key',
    );
  });

  it('suggests subcommands of a container command', () => {
    const result = suggestNext(catalog, ['config']);
    expect(texts(result)).toEqual(expect.arrayContaining(['GET', 'SET', 'RESETSTAT', 'REWRITE']));
    expect(result.suggestions.every((s) => s.kind === 'subcommand')).toBe(true);
    expect(texts(suggestNext(catalog, ['config'], 're'))).toEqual(['RESETSTAT', 'REWRITE']);
  });

  it('walks the argument tree', () => {
    expect(suggestNext(catalog, ['set']).suggestions).toEqual([
      { kind: 'argument', text: 'key', detail: 'key', optional: false },
    ]);
    const afterValue = suggestNext(catalog, words('set k v'));
    expect(texts(afterValue)).toEqual(['NX', 'XX', 'GET', 'EX', 'PX', 'EXAT', 'PXAT', 'KEEPTTL']);
    expect(afterValue.complete).toBe(true);
    expect(afterValue.suggestions.every((s) => s.optional)).toBe(true);

    const afterEx = suggestNext(catalog, words('SET k v nx EX'));
    expect(afterEx.suggestions).toEqual([
      { kind: 'argument', text: 'seconds', detail: 'integer', optional: true },
    ]);
    expect(afterEx.complete).toBe(false);
    // Options follow the documented order: after NX come GET and the expiration.
    expect(texts(suggestNext(catalog, words('set k v nx')))).toEqual([
      'GET',
      'EX',
      'PX',
      'EXAT',
      'PXAT',
      'KEEPTTL',
    ]);
    const done = suggestNext(catalog, words('set k v nx ex 10'));
    expect(done.suggestions).toEqual([]);
    expect(done.complete).toBe(true);
  });

  it('handles repeated blocks and tokens', () => {
    expect(texts(suggestNext(catalog, words('zadd k')))).toEqual(
      expect.arrayContaining(['NX', 'XX', 'GT', 'LT', 'CH', 'INCR', 'score']),
    );
    const afterPair = suggestNext(catalog, words('zadd k 1 a'));
    expect(afterPair.complete).toBe(true);
    expect(texts(afterPair)).toEqual(['score']);
    expect(suggestNext(catalog, words('zadd k 1')).complete).toBe(false);
    expect(texts(suggestNext(catalog, words('xread')))).toEqual(['COUNT', 'BLOCK', 'STREAMS']);
    expect(texts(suggestNext(catalog, words('xread count 5 streams s1')))).toEqual(['key', 'id']);
    const sortGet = texts(suggestNext(catalog, words('sort k get p')));
    expect(sortGet).toEqual(expect.arrayContaining(['GET', 'ASC', 'DESC', 'ALPHA', 'STORE']));
  });

  it('narrows keywords to the partial word', () => {
    expect(texts(suggestNext(catalog, words('set k v'), 'e'))).toEqual(['EX', 'EXAT']);
    expect(texts(suggestNext(catalog, words('set k v'), 'px'))).toEqual(['PX', 'PXAT']);
  });

  it('reports unknown commands and completeness', () => {
    expect(suggestNext(catalog, ['frobnicate']).unknownCommand).toBe(true);
    expect(suggestNext(catalog, ['get', 'k']).complete).toBe(true);
    expect(suggestNext(catalog, ['get']).complete).toBe(false);
  });

  it('uses the arity when there is no argument tree (Redis 6.2)', () => {
    const info62 = buildCommandCatalog({ info: recorded('command-info-7.0.resp') });
    expect(suggestNext(info62, ['get']).complete).toBe(false);
    expect(suggestNext(info62, ['get', 'k']).complete).toBe(true);
    expect(suggestNext(info62, ['del', 'a', 'b', 'c']).complete).toBe(true);
    expect(texts(suggestNext(info62, [], 'hs'))).toEqual(['HSET']);
  });
});

describe('completeLine', () => {
  it('uses the word under the cursor as the partial word', () => {
    const result = completeLine(catalog, 'set k v e');
    expect(texts(result)).toEqual(['EX', 'EXAT']);
    expect([result.replaceStart, result.replaceEnd]).toEqual([8, 9]);
  });

  it('completes the next word after a space', () => {
    const result = completeLine(catalog, 'config ');
    expect(texts(result)).toContain('GET');
    expect([result.replaceStart, result.replaceEnd]).toEqual([7, 7]);
  });

  it('ignores text after the cursor and earlier lines', () => {
    expect(texts(completeLine(catalog, 'get a\nse', 8))).toEqual(['SET']);
    expect(texts(completeLine(catalog, 'get a\n', 6)).length).toBeGreaterThan(10);
    expect(texts(completeLine(catalog, 'con whatever', 3))).toEqual(['CONFIG']);
  });

  it('completes inside an open quote', () => {
    const result = completeLine(catalog, 'set "my key" "val');
    expect(result.replaceStart).toBe(13);
    expect(result.suggestions).toEqual([]);
  });
});
