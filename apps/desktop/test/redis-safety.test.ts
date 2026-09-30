import { connectionProfileSchema } from '@joinery/core';
import { utf8Bytes } from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import {
  CONFIG_RESETSTAT,
  CONFIG_REWRITE,
  READ,
  WRITE,
  classifyRedisCommand,
  configSetOperation,
  decideRedisSafety,
  destructive,
  formatCommandLine,
  redisWritePolicy,
} from '../src/shared/redis-safety';
import { profileInput } from './helpers';
import { CATALOG } from './redis-fixtures';

const words = (line: string): string[] => line.split(' ');

describe('classifying CLI commands', () => {
  it('uses the catalog flags for writes and reads', () => {
    expect(classifyRedisCommand(words('SET k v'), CATALOG)).toEqual(WRITE);
    expect(classifyRedisCommand(words('get k'), CATALOG)).toEqual(READ);
    expect(classifyRedisCommand(words('CONFIG GET maxmemory'), CATALOG)).toEqual(READ);
    // Scripts and PUBLISH are not flagged "write" but may replicate writes.
    expect(classifyRedisCommand(words('EVAL return 1 0'), CATALOG)).toEqual(WRITE);
    expect(classifyRedisCommand(words('PUBLISH news hi'), CATALOG)).toEqual(WRITE);
  });

  it('marks destructive commands whatever the catalog says', () => {
    expect(classifyRedisCommand(words('FLUSHALL'), CATALOG).destructive).toMatch(/every key/);
    expect(classifyRedisCommand(words('flushdb async'), undefined).destructive).toBeDefined();
    expect(classifyRedisCommand(words('CLIENT KILL ID 7'), CATALOG).destructive).toBe(
      'disconnects clients',
    );
    expect(classifyRedisCommand(words('CONFIG RESETSTAT'), CATALOG)).toEqual(CONFIG_RESETSTAT);
    expect(classifyRedisCommand(words('config rewrite'), undefined)).toEqual(CONFIG_REWRITE);
    expect(classifyRedisCommand(words('ACL SETUSER bob on'), undefined).destructive).toBe(
      'changes access control',
    );
    expect(classifyRedisCommand(words('RENAME a b'), undefined).destructive).toBeDefined();
    expect(classifyRedisCommand(words('COPY a b REPLACE'), undefined).destructive).toBeDefined();
    expect(classifyRedisCommand(words('COPY a b'), undefined)).toEqual(WRITE);
    expect(classifyRedisCommand(words('DEL a b'), CATALOG).destructive).toBe('deletes keys');
  });

  it('treats CONFIG SET as a write, destructive for parameters that can lock clients out', () => {
    expect(classifyRedisCommand(words('config set maxmemory 1mb'), CATALOG)).toEqual(WRITE);
    expect(
      classifyRedisCommand(words('CONFIG SET maxmemory 1mb requirepass x'), undefined).destructive,
    ).toBe('can lock clients out of the server');
    // Values are not names: a value that happens to be "port" changes nothing.
    expect(classifyRedisCommand(words('CONFIG SET dbfilename port'), CATALOG).destructive).toBe(
      'changes where the server writes its data files',
    );
    expect(classifyRedisCommand(words('CONFIG SET notify-keyspace-events port'), CATALOG)).toEqual(
      WRITE,
    );
    expect(configSetOperation(['maxmemory-policy', 'slowlog-max-len'])).toEqual(WRITE);
    expect(configSetOperation(['bind', 'port', 'dir']).destructive).toBe(
      'can lock clients out of the server and changes where the server writes its data files',
    );
    expect(configSetOperation(['masterauth'])).toEqual(
      destructive('changes how this server authenticates to its primary'),
    );
  });

  it('treats unknown commands as writes without a catalog, as unknown with one', () => {
    expect(classifyRedisCommand(words('HGETALL h'), undefined)).toEqual(READ);
    expect(classifyRedisCommand(words('SOMETHING x'), undefined)).toEqual(WRITE);
    expect(classifyRedisCommand(words('SOMETHING x'), CATALOG)).toEqual({
      write: false,
      unknown: true,
    });
  });
});

describe('the write rules', () => {
  const policy = (presentation: Record<string, unknown>) =>
    redisWritePolicy(
      connectionProfileSchema.parse(
        profileInput({
          engine: 'redis',
          endpoint: { kind: 'host', host: 'h', port: 6379 },
          auth: { method: 'none' },
          presentation,
        }),
      ),
    );

  it('refuses writes and unknown commands on read-only profiles', () => {
    const readOnly = policy({ readOnly: true });
    expect(decideRedisSafety(WRITE, readOnly).action).toBe('refuse');
    expect(decideRedisSafety(destructive('deletes keys'), readOnly).action).toBe('refuse');
    expect(decideRedisSafety({ write: false, unknown: true }, readOnly).action).toBe('refuse');
    expect(decideRedisSafety(READ, readOnly).action).toBe('run');
  });

  it('asks for destructive operations everywhere and for writes where writes are confirmed', () => {
    const dev = policy({});
    expect(decideRedisSafety(WRITE, dev)).toEqual({ action: 'run' });
    expect(decideRedisSafety(destructive('deletes keys'), dev)).toEqual({
      action: 'confirm',
      destructive: true,
      reason: 'deletes keys',
    });
    for (const strict of [policy({ environment: 'production' }), policy({ confirmWrites: true })]) {
      expect(decideRedisSafety(WRITE, strict)).toMatchObject({
        action: 'confirm',
        destructive: false,
      });
      expect(decideRedisSafety(READ, strict)).toEqual({ action: 'run' });
    }
  });

  it('confirms CONFIG SET like any write, and REWRITE and RESETSTAT everywhere', () => {
    const dev = policy({});
    const harmless = configSetOperation(['slowlog-max-len']);
    expect(decideRedisSafety(harmless, dev)).toEqual({ action: 'run' });
    expect(decideRedisSafety(harmless, policy({ environment: 'production' }))).toMatchObject({
      action: 'confirm',
      destructive: false,
    });
    expect(decideRedisSafety(harmless, policy({ readOnly: true })).action).toBe('refuse');
    for (const operation of [CONFIG_REWRITE, CONFIG_RESETSTAT, configSetOperation(['port'])]) {
      expect(decideRedisSafety(operation, dev)).toMatchObject({
        action: 'confirm',
        destructive: true,
      });
      expect(decideRedisSafety(operation, policy({ readOnly: true })).action).toBe('refuse');
    }
  });
});

describe('command lines for confirmations', () => {
  it('quotes what redis-cli would need quoted and cuts long arguments', () => {
    expect(formatCommandLine(['SET', 'user:1', 'plain'])).toBe('SET user:1 plain');
    expect(formatCommandLine(['SET', 'a b', 'say "hi"'])).toBe('SET "a b" "say \\"hi\\""');
    expect(
      formatCommandLine([utf8Bytes('SET'), new Uint8Array([0xff, 0x0a]), utf8Bytes('café')]),
    ).toBe('SET "\\xff\\n" café');
    expect(formatCommandLine(['SET', ''])).toBe('SET ""');
    expect(formatCommandLine(['SET', 'k', 'x'.repeat(10)], 4)).toBe('SET k xxxx…');
  });
});
