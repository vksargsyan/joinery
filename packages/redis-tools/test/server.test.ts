import { describe, expect, it } from 'vitest';

import {
  array,
  bulk,
  displayBytes,
  integer,
  parseAclLog,
  parseAclUser,
  parseClientList,
  parseLatencyHistory,
  parseLatencyLatest,
  parseMonitorLine,
  parseSlowlog,
  status,
  unescapeRepr,
} from '../src';
import { enc, recorded, recordedText } from './fixtures';

describe('parseClientList', () => {
  it('parses a real CLIENT LIST', () => {
    const clients = parseClientList(recordedText('client-list-7.0.resp'));
    expect(clients.length).toBeGreaterThanOrEqual(2);
    const replica = clients.find((c) => c.flags === 'S')!;
    expect(replica).toMatchObject({ cmd: 'replconf', user: 'default', db: 0, name: '' });
    expect(replica.id).toBeGreaterThan(0);
    expect(replica.addr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(replica.fields['resp']).toBe('2');
    const sentinel = clients.find((c) => c.name.startsWith('sentinel-'));
    expect(sentinel?.flags).toBe('N');
  });
});

describe('parseSlowlog', () => {
  it('parses entries with arguments as bytes', () => {
    const reply = array([
      array([
        integer(14),
        integer(1790677000),
        integer(15023),
        array([bulk('EVAL'), bulk('while true do end'), bulk(Uint8Array.of(0xff))]),
        bulk('127.0.0.1:50000'),
        bulk('joinery'),
      ]),
      array([integer(13), integer(1790676000), integer(20000), array([bulk('KEYS'), bulk('*')])]),
    ]);
    const entries = parseSlowlog(reply);
    expect(entries[0]).toMatchObject({
      id: 14,
      timestamp: 1790677000,
      durationMicros: 15023,
      client: '127.0.0.1:50000',
      clientName: 'joinery',
    });
    expect(entries[0]!.args.map(displayBytes)).toEqual(['EVAL', 'while true do end', '\\xff']);
    expect(entries[1]!.client).toBeUndefined();
  });
});

describe('latency', () => {
  it('parses LATENCY LATEST and HISTORY', () => {
    expect(
      parseLatencyLatest(
        array([array([bulk('command'), integer(1790677000), integer(25), integer(120)])]),
      ),
    ).toEqual([{ event: 'command', timestamp: 1790677000, latestMs: 25, maxMs: 120 }]);
    expect(
      parseLatencyHistory(
        array([array([integer(1), integer(5)]), array([integer(2), integer(7)])]),
      ),
    ).toEqual([
      { timestamp: 1, latencyMs: 5 },
      { timestamp: 2, latencyMs: 7 },
    ]);
  });
});

describe('ACL', () => {
  it('parses a real Redis 7.0 ACL GETUSER', () => {
    expect(parseAclUser(recorded('acl-getuser-7.0.resp'))).toEqual({
      flags: ['on'],
      passwordHashes: ['6c904c5190e8b45c2f0af062eefdb2f5b41ce3809b0e6b5bc50aafdd60b290d8'],
      commands: '+@all -@dangerous',
      keys: '~app:*',
      channels: '&*',
      selectors: [],
    });
  });

  it('parses the Redis 6.2 shape (pattern arrays)', () => {
    const reply = array([
      bulk('flags'),
      array([status('on'), status('allchannels')]),
      bulk('passwords'),
      array([]),
      bulk('commands'),
      bulk('+@read'),
      bulk('keys'),
      array([bulk('app:*'), bulk('cache:*')]),
      bulk('channels'),
      array([bulk('*')]),
    ]);
    expect(parseAclUser(reply)).toMatchObject({
      flags: ['on', 'allchannels'],
      keys: '~app:* ~cache:*',
      channels: '&*',
    });
  });

  it('parses ACL LOG', () => {
    const entry = array([
      bulk('count'),
      integer(2),
      bulk('reason'),
      bulk('command'),
      bulk('context'),
      bulk('toplevel'),
      bulk('object'),
      bulk('flushall'),
      bulk('username'),
      bulk('app'),
      bulk('age-seconds'),
      bulk('4.2'),
      bulk('client-info'),
      bulk('id=7 addr=127.0.0.1:1'),
      bulk('entry-id'),
      integer(0),
      bulk('timestamp-created'),
      integer(1790677000000),
      bulk('timestamp-last-updated'),
      integer(1790677001000),
    ]);
    expect(parseAclLog(array([entry]))).toEqual([
      {
        count: 2,
        reason: 'command',
        context: 'toplevel',
        object: 'flushall',
        username: 'app',
        ageSeconds: 4.2,
        clientInfo: 'id=7 addr=127.0.0.1:1',
        entryId: 0,
        createdAtMs: 1790677000000,
        updatedAtMs: 1790677001000,
      },
    ]);
  });
});

describe('MONITOR lines', () => {
  it('parses lines back to byte arguments', () => {
    const entry = parseMonitorLine(
      '1790677000.123456 [0 127.0.0.1:52142] "set" "a \\"quoted\\" \\\\ key" "\\xff\\x00\\n" ""',
    )!;
    expect(entry.timestamp).toBeCloseTo(1790677000.123456);
    expect(entry.db).toBe(0);
    expect(entry.source).toBe('127.0.0.1:52142');
    expect(entry.args).toEqual([
      enc('set'),
      enc('a "quoted" \\ key'),
      Uint8Array.of(0xff, 0, 10),
      enc(''),
    ]);
    expect(parseMonitorLine('1.5 [3 lua] "get" "k"')).toMatchObject({ db: 3, source: 'lua' });
    expect(parseMonitorLine('OK')).toBeUndefined();
    expect(unescapeRepr('\\x41\\t')).toEqual(enc('A\t'));
  });
});
