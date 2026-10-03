import { QuerybaraError } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { mapRedisError, type RedisErrorContext } from '../src';
import { pickConnectError } from '../src/errors';

const connectCtx: RedisErrorContext = {
  where: 'cache:6379',
  phase: 'connect',
  masterName: 'mymaster',
};
const commandCtx: RedisErrorContext = {
  where: 'cache:6379',
  phase: 'command',
  command: 'FLUSHALL',
};

function reply(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

describe('mapRedisError', () => {
  it.each([
    ['WRONGPASS invalid username-password pair or user is disabled.', 'AUTH_FAILED', /enabled/],
    ['NOAUTH Authentication required.', 'AUTH_FAILED', /password authentication/],
    ["NOPERM User app has no permissions to run the 'info' command", 'AUTH_FAILED', /ACL SETUSER/],
    [
      'DENIED Redis is running in protected mode because protected mode is enabled',
      'CONNECTION_FAILED',
      /SSH tunnel/,
    ],
    ['CLUSTERDOWN The cluster is down', 'CONNECTION_FAILED', /CLUSTER INFO/],
    ['LOADING Redis is loading the dataset in memory', 'CONNECTION_FAILED', /moment/],
  ])('maps %s while connecting', (message, code, hint) => {
    const mapped = mapRedisError(reply(message), connectCtx);
    expect(mapped.code).toBe(code);
    expect(mapped.hint).toMatch(hint);
  });

  it('maps command errors to SQL_ERROR with the prefix and a hint', () => {
    expect(
      mapRedisError(
        reply("NOPERM this user has no permissions to run the 'flushall' command"),
        commandCtx,
      ),
    ).toMatchObject({
      code: 'SQL_ERROR',
      engineCode: 'NOPERM',
      hint: expect.stringMatching(/\+flushall/),
    });
    expect(
      mapRedisError(
        reply('WRONGTYPE Operation against a key holding the wrong kind of value'),
        commandCtx,
      ),
    ).toMatchObject({
      code: 'SQL_ERROR',
      engineCode: 'WRONGTYPE',
    });
    expect(
      mapRedisError(reply("CROSSSLOT Keys in request don't hash to the same slot"), commandCtx)
        .hint,
    ).toMatch(/hash tag/);
    expect(
      mapRedisError(reply("READONLY You can't write against a read only replica."), commandCtx)
        .hint,
    ).toMatch(/primary/);
    expect(
      mapRedisError(reply("ERR unknown command 'frob', with args beginning with: "), commandCtx)
        .hint,
    ).toMatch(/does not exist/);
    expect(mapRedisError(reply('BUSY Redis is busy running a script.'), commandCtx).hint).toMatch(
      /SCRIPT KILL/,
    );
  });

  it('maps Sentinel and Cluster discovery failures', () => {
    const noMaster = mapRedisError(
      new Error(
        'All sentinels are unreachable and retry is disabled. Last error: ERR No such master with that name',
      ),
      connectCtx,
    );
    expect(noMaster).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: expect.stringMatching(/"mymaster"/),
    });
    expect(noMaster.hint).toMatch(/SENTINEL MASTERS/);
    const unreachable = mapRedisError(
      new Error(
        'All sentinels are unreachable and retry is disabled. Last error: Connection is closed.',
      ),
      connectCtx,
    );
    expect(unreachable.hint).toMatch(/Sentinel hosts/);
    const sentinelAuth = mapRedisError(
      new Error(
        'All sentinels are unreachable and retry is disabled. Last error: WRONGPASS invalid username-password pair',
      ),
      connectCtx,
    );
    expect(sentinelAuth.code).toBe('AUTH_FAILED');
    expect(
      mapRedisError(
        new Error('Failed to refresh slots cache. WRONGPASS invalid username-password pair'),
        connectCtx,
      ).code,
    ).toBe('AUTH_FAILED');
    expect(mapRedisError(new Error('None of startup nodes is available'), connectCtx).hint).toMatch(
      /cluster-enabled/,
    );
  });

  it('maps timeouts, closed connections and network errors', () => {
    expect(mapRedisError(new Error('Command timed out'), commandCtx).code).toBe('TIMEOUT');
    const closed = new Error('Reached the max retries per request limit');
    closed.name = 'MaxRetriesPerRequestError';
    expect(mapRedisError(closed, commandCtx).message).toMatch(/was closed/);
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(mapRedisError(refused, connectCtx)).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: expect.stringMatching(/refused/),
    });
    const cert = Object.assign(new Error('self-signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    expect(mapRedisError(cert, connectCtx)).toMatchObject({
      code: 'TLS_FAILED',
      hint: expect.stringMatching(/CA certificate/),
    });
    expect(mapRedisError(new Error('write EPROTO wrong version number'), connectCtx).code).toBe(
      'TLS_FAILED',
    );
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(mapRedisError(abort, commandCtx).code).toBe('CANCELLED');
    const existing = new QuerybaraError({ code: 'NOT_FOUND', message: 'x' });
    expect(mapRedisError(existing, commandCtx)).toBe(existing);
  });

  it('picks the most telling of the errors seen while connecting', () => {
    const picked = pickConnectError(
      new Error('Connection is closed.'),
      [reply('WRONGPASS invalid username-password pair')],
      connectCtx,
    );
    expect(picked.code).toBe('AUTH_FAILED');
    const network = pickConnectError(
      new Error('Connection is closed.'),
      [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
      connectCtx,
    );
    expect(network.message).toMatch(/refused/);
    expect(pickConnectError(new Error('Connection is closed.'), [], connectCtx).message).toMatch(
      /was closed/,
    );
  });
});
