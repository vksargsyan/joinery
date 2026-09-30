import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NamespaceTree, displayBytes, groupLevel, namespacePrefix, splitKey } from '../src';
import { enc } from './fixtures';

const keys = (...names: string[]): Uint8Array[] => names.map(enc);
const show = (list: readonly Uint8Array[]): string[] => list.map(displayBytes);

describe('splitKey / namespacePrefix', () => {
  it('splits on single and multi-byte delimiters', () => {
    expect(show(splitKey(enc('user:42:profile'), ':'))).toEqual(['user', '42', 'profile']);
    expect(show(splitKey(enc('a::b'), ':'))).toEqual(['a', '', 'b']);
    expect(show(splitKey(enc('a::b::c'), '::'))).toEqual(['a', 'b', 'c']);
    expect(show(splitKey(enc(':x'), ':'))).toEqual(['', 'x']);
    expect(show(splitKey(enc('plain'), ':'))).toEqual(['plain']);
    expect(displayBytes(namespacePrefix(keys('user', '42'), ':'))).toBe('user:42:');
    expect(namespacePrefix([], ':')).toEqual(new Uint8Array(0));
  });
});

describe('groupLevel', () => {
  it('groups one level below a prefix, counting and deduplicating', () => {
    const scanned = keys(
      'user:1:name',
      'user:1:email',
      'user:2:name',
      'user',
      'session:x',
      'user:1:name',
      'other',
    );
    const root = groupLevel(scanned, new Uint8Array(0), ':');
    expect(root.namespaces.map((n) => [displayBytes(n.segment), n.count])).toEqual([
      ['session', 1],
      ['user', 3],
    ]);
    expect(show(root.keys)).toEqual(['other', 'user']);

    const user = groupLevel(scanned, enc('user:'), ':');
    expect(user.namespaces.map((n) => [displayBytes(n.segment), n.count])).toEqual([
      ['1', 2],
      ['2', 1],
    ]);
    expect(user.keys).toEqual([]);
    expect(show(groupLevel(scanned, enc('user:1:'), ':').keys)).toEqual([
      'user:1:email',
      'user:1:name',
    ]);
  });

  it('sorts numbers naturally and handles binary segments', () => {
    const level = groupLevel(
      [enc('k:10'), enc('k:9'), enc('k:100'), Uint8Array.of(0x6b, 0x3a, 0xff, 0x3a, 0x31)],
      enc('k:'),
      ':',
    );
    expect(show(level.keys)).toEqual(['k:9', 'k:10', 'k:100']);
    expect(level.namespaces.map((n) => displayBytes(n.segment))).toEqual(['\\xff']);
  });
});

describe('NamespaceTree', () => {
  it('merges SCAN pages and lists children', () => {
    const tree = new NamespaceTree(':');
    expect(tree.add(keys('user:1:name', 'user:1:email', 'cart:9'))).toBe(3);
    expect(tree.add(keys('user:1:name', 'user:2:name', 'user'))).toBe(2);
    expect(tree.keyCount).toBe(5);
    expect(tree.children().map((e) => [e.kind, e.name, e.keyCount, displayBytes(e.bytes)])).toEqual(
      [
        ['namespace', 'cart', 1, 'cart:'],
        ['namespace', 'user', 3, 'user:'],
        ['key', 'user', 1, 'user'],
      ],
    );
    expect(
      tree.children(keys('user', '1')).map((e) => [e.kind, e.name, displayBytes(e.bytes)]),
    ).toEqual([
      ['key', 'email', 'user:1:email'],
      ['key', 'name', 'user:1:name'],
    ]);
    expect(tree.children(keys('nope'))).toEqual([]);
  });

  it('stays bounded', () => {
    const tree = new NamespaceTree(':', 10);
    tree.add(Array.from({ length: 50 }, (_, i) => enc(`k:${i}`)));
    expect(tree.truncated).toBe(true);
    expect(tree.keyCount).toBe(9);
    expect(tree.dropped).toBe(41);
  });

  it('counts every distinct key exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom('a', 'b', 'c', ''), { minLength: 1, maxLength: 4 }), {
          maxLength: 60,
        }),
        (parts) => {
          const names = parts.map((p) => p.join(':'));
          const tree = new NamespaceTree(':');
          tree.add(names.map(enc));
          expect(tree.keyCount).toBe(new Set(names).size);
          const total = tree.children().reduce((sum, e) => sum + e.keyCount, 0);
          expect(total).toBe(new Set(names).size);
        },
      ),
    );
  });
});
