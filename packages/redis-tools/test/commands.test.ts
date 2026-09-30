import { describe, expect, it } from 'vitest';

import {
  array,
  buildCommandCatalog,
  commandSyntax,
  lookupCommand,
  parseCommandDocs,
  parseCommandInfo,
  replyItems,
  type RedisReply,
} from '../src';
import { recorded } from './fixtures';

const docs = recorded('command-docs-7.0.resp');
const info = recorded('command-info-7.0.resp');

/** COMMAND INFO as Redis 6.2 sends it: 7 fields per command, no subcommands. */
function asRedis62(reply: RedisReply): RedisReply {
  return array(
    (replyItems(reply) ?? []).map((entry) => array((replyItems(entry) ?? []).slice(0, 7))),
  );
}

describe('parseCommandDocs (Redis 7.0 COMMAND DOCS)', () => {
  const parsed = parseCommandDocs(docs);
  const byName = new Map(parsed.map((d) => [d.name, d]));

  it('reads summaries, groups, history and argument trees', () => {
    expect(parsed.length).toBe(17);
    const set = byName.get('SET')!;
    expect(set).toMatchObject({
      summary: 'Set the string value of a key',
      since: '1.0.0',
      group: 'string',
      complexity: 'O(1)',
    });
    expect(set.history[0]).toEqual({
      version: '2.6.12',
      description: 'Added the `EX`, `PX`, `NX` and `XX` options.',
    });
    expect(set.arguments.map((a) => [a.name, a.type, a.optional])).toEqual([
      ['key', 'key', false],
      ['value', 'string', false],
      ['condition', 'oneof', true],
      ['get', 'pure-token', true],
      ['expiration', 'oneof', true],
    ]);
    expect(set.arguments[0]!.keySpecIndex).toBe(0);
    expect(set.arguments[4]!.arguments.map((a) => a.token)).toEqual([
      'EX',
      'PX',
      'EXAT',
      'PXAT',
      'KEEPTTL',
    ]);
  });

  it('reads subcommands', () => {
    const config = byName.get('CONFIG')!;
    expect(config.subcommands.map((s) => s.name)).toContain('CONFIG GET');
    const get = config.subcommands.find((s) => s.name === 'CONFIG GET')!;
    expect(get.container).toBe('CONFIG');
    expect(get.arguments[0]).toMatchObject({ name: 'parameter', multiple: true });
  });
});

describe('parseCommandInfo', () => {
  it('reads Redis 7.0 COMMAND INFO with flags, categories, key specs and subcommands', () => {
    const parsed = new Map(parseCommandInfo(info).map((d) => [d.name, d]));
    const set = parsed.get('SET')!;
    expect(set.arity).toBe(-3);
    expect(set.flags).toEqual(expect.arrayContaining(['write', 'denyoom']));
    expect(set.aclCategories).toEqual(expect.arrayContaining(['write', 'string', 'slow']));
    expect(set.keys).toEqual({ first: 1, last: 1, step: 1 });
    expect(set.keySpecs[0]!.beginSearch).toMatchObject({ type: 'index', index: '1' });
    expect(set.write).toBe(true);
    expect(parsed.get('GET')!.readOnly).toBe(true);
    expect(parsed.get('BLPOP')!.blocking).toBe(true);
    expect(parsed.get('CONFIG')!.subcommands.find((s) => s.name === 'CONFIG SET')!.dangerous).toBe(
      true,
    );
    expect(parsed.get('ACL')!.subcommands.length).toBeGreaterThan(5);
  });

  it('reads the 6.2 shape (7 fields) and derives blocking from @blocking', () => {
    const parsed = new Map(parseCommandInfo(asRedis62(info)).map((d) => [d.name, d]));
    const blpop = parsed.get('BLPOP')!;
    expect(blpop.tips).toEqual([]);
    expect(blpop.subcommands).toEqual([]);
    expect(blpop.blocking).toBe(true);
    expect(parsed.get('RESTORE')!.dangerous).toBe(true);
    expect(parsed.get('XREAD')!.blocking).toBe(true);
  });

  it('skips unknown commands (nil entries)', () => {
    expect(parseCommandInfo(array([{ type: 'nil' }]))).toEqual([]);
  });
});

describe('buildCommandCatalog', () => {
  it('merges docs and info', () => {
    const catalog = buildCommandCatalog({ docs, info });
    expect(catalog.source).toBe('docs');
    const set = catalog.commands['SET']!;
    expect(set.summary).toBe('Set the string value of a key');
    expect(set.arity).toBe(-3);
    expect(set.write).toBe(true);
    const configGet = catalog.commands['CONFIG']!.subcommands.find((s) => s.name === 'CONFIG GET')!;
    expect(configGet.summary).toMatch(/configuration parameter/i);
    expect(configGet.arity).toBe(-3);
  });

  it('works from COMMAND INFO alone (6.2)', () => {
    const catalog = buildCommandCatalog({ info: asRedis62(info) });
    expect(catalog.source).toBe('info');
    expect(catalog.commands['SET']!.arguments).toEqual([]);
    expect(catalog.commands['SET']!.write).toBe(true);
  });

  it('looks up commands and subcommands case-insensitively', () => {
    const catalog = buildCommandCatalog({ docs, info });
    expect(lookupCommand(catalog, ['config', 'get', 'maxmemory'])).toMatchObject({
      doc: { name: 'CONFIG GET' },
      consumed: 2,
    });
    expect(lookupCommand(catalog, ['Set', 'k'])).toMatchObject({
      doc: { name: 'SET' },
      consumed: 1,
    });
    expect(lookupCommand(catalog, ['config', 'nope'])).toMatchObject({
      doc: { name: 'CONFIG' },
      consumed: 1,
    });
    expect(lookupCommand(catalog, ['nope'])).toBeUndefined();
  });
});

describe('commandSyntax', () => {
  const catalog = buildCommandCatalog({ docs, info });
  const syntax = (name: string): string => {
    const found = lookupCommand(catalog, name.split(' '))!;
    return commandSyntax(found.doc);
  };

  it.each([
    [
      'SET',
      'SET key value [NX | XX] [GET] [EX seconds | PX milliseconds | EXAT unix-time-seconds | PXAT unix-time-milliseconds | KEEPTTL]',
    ],
    ['GET', 'GET key'],
    ['ZADD', 'ZADD key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]'],
    ['BLPOP', 'BLPOP key [key ...] timeout'],
    ['CONFIG GET', 'CONFIG GET parameter [parameter ...]'],
    ['XREAD', 'XREAD [COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]'],
    ['SORT', expect.stringContaining('[GET pattern [GET pattern ...]]')],
    ['DEL', 'DEL key [key ...]'],
  ])('%s', (name, expected) => {
    expect(syntax(name)).toEqual(expected);
  });
});
