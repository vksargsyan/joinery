import {
  array,
  buildCommandCatalog,
  bulk,
  integer,
  splitCommands,
  utf8Bytes,
  type RedisReply,
} from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import { commandLine, redisCommandSafety } from '../src/redis';

/** joinery query on Redis targets: command classification and the command lines it runs. */

function info(name: string, flags: string[], categories: string[]): RedisReply {
  const words = (values: string[]): RedisReply => array(values.map((v) => bulk(v)));
  return array([
    bulk(name),
    integer(-2),
    words(flags),
    integer(1),
    integer(1),
    integer(1),
    words(categories.map((c) => `@${c}`)),
    array([]),
    array([]),
    array([]),
  ]);
}

const catalog = buildCommandCatalog({
  info: array([
    info('set', ['write', 'denyoom'], ['write', 'string']),
    info('get', ['readonly', 'fast'], ['read', 'string']),
    info('eval', ['noscript', 'may_replicate'], ['scripting']),
    info('del', ['write'], ['keyspace', 'write']),
  ]),
});

const words = (line: string): string[] => line.split(' ');

describe('Redis commands in joinery query', () => {
  it('classifies reads, writes and destructive commands', () => {
    expect(redisCommandSafety(words('GET k'), catalog)).toEqual({
      name: 'GET',
      writes: false,
      unknown: false,
    });
    expect(redisCommandSafety(words('set k v'), catalog)).toMatchObject({
      name: 'SET',
      writes: true,
    });
    expect(redisCommandSafety(words('EVAL x 0'), catalog)).toMatchObject({ writes: true });
    expect(redisCommandSafety(words('DEL a b'), catalog)).toMatchObject({
      name: 'DEL',
      destructive: 'deletes keys',
    });
    expect(redisCommandSafety(words('client kill id 3'), catalog)).toMatchObject({
      name: 'CLIENT KILL',
      destructive: 'disconnects clients',
    });
    expect(redisCommandSafety(words('COPY a b REPLACE'), catalog).destructive).toBeDefined();
    expect(redisCommandSafety(words('PUBLISH news hi'), catalog).writes).toBe(true);
  });

  it('treats commands outside the catalog as unknown, and as writes without one', () => {
    expect(redisCommandSafety(words('NOPE x'), catalog)).toMatchObject({
      unknown: true,
      writes: false,
    });
    expect(redisCommandSafety(words('GET k'), undefined)).toMatchObject({
      unknown: false,
      writes: true,
    });
  });

  it('builds command lines that split back into the same arguments', () => {
    const args = [utf8Bytes('SET'), utf8Bytes('a b'), new Uint8Array([0, 0xff, 0x22, 0x0a])];
    const line = commandLine(args);
    expect(line).toBe('"SET" "a b" "\\x00\\xff\\"\\n"');
    expect(splitCommands(line)).toEqual([args]);
  });
});
