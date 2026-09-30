import type { KeyInfo } from '@joinery/driver-redis';
import type { RedisScanPage } from '@joinery/ipc';
import { bytesKey, displayBytes, parseDisplayBytes, utf8Bytes } from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import {
  KeyBrowserController,
  keyTreeRows,
  namespaceIdsOf,
  namespacePattern,
  patternNamespaceIds,
  scanQuery,
  toRow,
  type PageStream,
  type ScanQuery,
} from '../src/renderer/src/state/redis/key-browser';

const enc = utf8Bytes;

function info(key: string | Uint8Array, type = 'string'): KeyInfo {
  return {
    key: typeof key === 'string' ? enc(key) : key,
    type,
    kind: type === 'hash' ? 'hash' : 'string',
    ttlMs: -1,
    encoding: null,
    length: null,
  };
}

function page(keys: readonly (string | Uint8Array)[], done: boolean, calls = 1): RedisScanPage {
  return {
    keys: keys.map((k) => info(k)),
    cursor: done ? '0' : '17',
    done,
    calls,
    budgetExhausted: !done && keys.length === 0,
  };
}

/** A scan stream over fixed pages that records how it was opened and closed. */
function scanner(pages: readonly RedisScanPage[]) {
  const opened: ScanQuery[] = [];
  let closed = 0;
  let pulls = 0;
  const open = (query: ScanQuery): PageStream => {
    opened.push(query);
    let index = 0;
    return {
      next: async () => {
        pulls += 1;
        const value = pages[index++];
        return value ? { done: false, value } : { done: true, value: undefined };
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    };
  };
  return {
    open,
    opened,
    get closed() {
      return closed;
    },
    get pulls() {
      return pulls;
    },
  };
}

describe('key browser paging', () => {
  it('loads one page per request and stops at the end of the scan', async () => {
    const scan = scanner([page(['a', 'b'], false), page(['c'], true)]);
    let changes = 0;
    const browser = new KeyBrowserController(
      scan.open,
      async () => [],
      () => changes++,
    );
    await browser.reset({ pattern: '', type: '' });
    expect(browser.state.rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(browser.state).toMatchObject({ hasMore: true, loading: false, scanCalls: 1 });
    expect(scan.pulls).toBe(1);
    await browser.loadMore();
    expect(browser.state.rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(browser.state).toMatchObject({ hasMore: false, scanCalls: 2 });
    await browser.loadMore();
    expect(scan.pulls).toBe(2);
    expect(changes).toBeGreaterThan(0);
  });

  it('drops keys SCAN returns twice and keys that vanished', async () => {
    const gone: KeyInfo = { ...info('gone'), type: 'none', kind: 'none', ttlMs: -2 };
    const scan = scanner([
      { ...page(['a', 'b'], false) },
      { ...page(['b', 'c'], true), keys: [info('b'), info('c'), gone] },
    ]);
    const browser = new KeyBrowserController(
      scan.open,
      async () => [],
      () => undefined,
    );
    await browser.reset({ pattern: '', type: '' });
    await browser.loadMore();
    expect(browser.state.rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('opens the scan with the filter as MATCH bytes, TYPE and node', async () => {
    const scan = scanner([page([], true)]);
    const browser = new KeyBrowserController(
      scan.open,
      async () => [],
      () => undefined,
      {
        pageSize: 50,
      },
    );
    await browser.reset({ pattern: 'user:\\xff*', type: 'hash', node: '127.0.0.1:7100' });
    expect(scan.opened).toHaveLength(1);
    const query = scan.opened[0]!;
    expect(query.pageSize).toBe(50);
    expect([...query.match!]).toEqual([...enc('user:'), 0xff, ...enc('*')]);
    expect(query.type).toBe('hash');
    expect(query.node).toBe('127.0.0.1:7100');
    expect(scanQuery({ pattern: '*', type: '' })).toEqual({ pageSize: 200 });
    expect(scanQuery({ pattern: '  ', type: '' })).toEqual({ pageSize: 200 });
  });

  it('closes the running scan on a new filter and ignores its late pages', async () => {
    let release: (() => void) | undefined;
    const slow: PageStream = {
      next: () =>
        new Promise((resolve) => {
          release = () => resolve({ done: false, value: page(['old'], false) });
        }),
      return: async () => ({ done: true, value: undefined }),
    };
    const fresh = scanner([page(['new'], true)]);
    let first = true;
    const browser = new KeyBrowserController(
      (query) => {
        if (first) {
          first = false;
          return slow;
        }
        return fresh.open(query);
      },
      async () => [],
      () => undefined,
    );
    const stale = browser.reset({ pattern: 'old*', type: '' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await browser.reset({ pattern: 'new*', type: '' });
    release?.();
    await stale;
    expect(browser.state.rows.map((r) => r.name)).toEqual(['new']);
    expect(browser.state.filter.pattern).toBe('new*');
  });

  it('reports a failed scan and stops paging', async () => {
    const browser = new KeyBrowserController(
      () => ({
        next: async () => {
          throw new Error('NOPERM this user has no permissions to run the scan command');
        },
        return: async () => ({ done: true, value: undefined }),
      }),
      async () => [],
      () => undefined,
    );
    await browser.reset({ pattern: '', type: '' });
    expect(browser.state).toMatchObject({ hasMore: false, loading: false });
    expect(browser.state.error).toContain('NOPERM');
  });

  it('fetches memory only for visible rows it has not asked about', async () => {
    const asked: string[][] = [];
    const scan = scanner([page(['a', 'b', 'c'], true)]);
    const browser = new KeyBrowserController(
      scan.open,
      async (keys) => {
        asked.push(keys.map((k) => displayBytes(k)));
        return keys.map((k) => (displayBytes(k) === 'b' ? null : 100));
      },
      () => undefined,
    );
    await browser.reset({ pattern: '', type: '' });
    const [a, b, c] = browser.state.rows;
    await browser.fetchMemory([a!.id, b!.id]);
    await browser.fetchMemory([a!.id, b!.id, c!.id, 'unknown']);
    expect(asked).toEqual([['a', 'b'], ['c']]);
    expect(browser.state.memory).toEqual({ [a!.id]: 100, [b!.id]: null, [c!.id]: 100 });
  });

  it('follows deletes, renames and new keys', async () => {
    const scan = scanner([page(['a', 'b'], true)]);
    const browser = new KeyBrowserController(
      scan.open,
      async () => [],
      () => undefined,
    );
    await browser.reset({ pattern: '', type: '' });
    browser.removeKeys([enc('a')]);
    browser.upsert(info('z', 'hash'));
    browser.upsert({ ...info('b'), ttlMs: 5000 });
    expect(browser.state.rows.map((r) => [r.name, r.type, r.ttlMs])).toEqual([
      ['z', 'hash', -1],
      ['b', 'string', 5000],
    ]);
    browser.dispose();
    expect(scan.closed).toBe(0);
  });
});

describe('namespace tree', () => {
  const rows = ['user:1', 'user:2', 'user:10:profile', 'session:x', 'plain', 'user:10:cart'].map(
    (k) => toRow(info(k)),
  );

  it('lists namespaces before keys, collapsed until expanded', () => {
    const top = keyTreeRows(rows, ':', new Set());
    expect(top.map((r) => [r.kind, r.name, r.depth])).toEqual([
      ['namespace', 'session', 0],
      ['namespace', 'user', 0],
      ['key', 'plain', 0],
    ]);
    const user = top.find((r) => r.name === 'user');
    expect(user).toMatchObject({ kind: 'namespace', count: 4, expanded: false });
  });

  it('shows the children of expanded namespaces in natural order', () => {
    const expanded = new Set([bytesKey(enc('user:')), bytesKey(enc('user:10:'))]);
    const tree = keyTreeRows(rows, ':', expanded);
    expect(tree.map((r) => `${' '.repeat(r.depth)}${r.name}`)).toEqual([
      'session',
      'user',
      ' 10',
      '  cart',
      '  profile',
      ' 1',
      ' 2',
      'plain',
    ]);
  });

  it('splits on a multi-byte delimiter and keeps binary segments', () => {
    const binary = toRow(info(new Uint8Array([0xff, 0x2f, 0x2f, 0x61])));
    const tree = keyTreeRows(
      [binary],
      '//',
      new Set([bytesKey(new Uint8Array([0xff, 0x2f, 0x2f]))]),
    );
    expect(tree.map((r) => r.name)).toEqual(['\\xff', 'a']);
  });

  it('gives the namespace ids on the way to a key', () => {
    expect(namespaceIdsOf(enc('a:b:c'), ':')).toEqual([bytesKey(enc('a:')), bytesKey(enc('a:b:'))]);
    expect(namespaceIdsOf(enc('plain'), ':')).toEqual([]);
  });

  it('opens the namespaces a filter points into', () => {
    expect(patternNamespaceIds('user:42:*', ':')).toEqual([
      bytesKey(enc('user:')),
      bytesKey(enc('user:42:')),
    ]);
    expect(patternNamespaceIds('user*', ':')).toEqual([]);
    // Display form: a doubled backslash is one backslash byte, which escapes the glob `*`.
    expect(patternNamespaceIds('a\\\\*b:c?:*', ':')).toEqual([bytesKey(enc('a*b:'))]);
    expect(patternNamespaceIds('', ':')).toEqual([]);
  });

  it('builds a pattern that matches a namespace literally', () => {
    expect(namespacePattern(enc('user:'))).toBe('user:*');
    const pattern = namespacePattern(enc('a*b[1]:'));
    expect(pattern).toBe('a\\\\*b\\\\[1\\\\]:*');
    expect(displayBytes(parseDisplayBytes(pattern))).toBe('a\\\\*b\\\\[1\\\\]:*');
    expect([...parseDisplayBytes(pattern)]).toEqual([...enc('a\\*b\\[1\\]:*')]);
  });
});
