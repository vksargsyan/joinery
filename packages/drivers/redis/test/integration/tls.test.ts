import type { ConnectionCheckResult } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { redisProfileFromUrl } from '../../src';
import { REDIS_TLS_CA, REDIS_TLS_URL, adapter, connect, replies } from './helpers';

async function steps(
  resolved: ReturnType<typeof redisProfileFromUrl>,
): Promise<ConnectionCheckResult[]> {
  const out: ConnectionCheckResult[] = [];
  for await (const step of adapter.checkConnection(resolved)) out.push(step);
  return out;
}

/** TLS (local only): verify-full with the test CA, and a wrong CA failing with a hint. */
describe.skipIf(!REDIS_TLS_URL || !REDIS_TLS_CA)('TLS', () => {
  it('connects with verify-full and the server CA', async () => {
    const session = await connect(
      redisProfileFromUrl(REDIS_TLS_URL!, { tls: { mode: 'verify-full', caPath: REDIS_TLS_CA! } }),
    );
    try {
      expect(await replies(session, 'ping')).toEqual(['PONG']);
    } finally {
      await session.close();
    }
    const ok = await steps(
      redisProfileFromUrl(REDIS_TLS_URL!, { tls: { mode: 'verify-full', caPath: REDIS_TLS_CA! } }),
    );
    expect(ok.find((s) => s.step === 'tls')).toMatchObject({
      status: 'ok',
      message: 'Encrypted; certificate and host name verified',
    });
  });

  it('checks the host name only in verify-full', async () => {
    const url = REDIS_TLS_URL!.replace('127.0.0.1', 'localhost');
    const tls = { caPath: REDIS_TLS_CA!, servername: 'not-the-server.example' };
    const full = await connect(
      redisProfileFromUrl(url, { tls: { mode: 'verify-full', ...tls } }),
    ).catch((e: unknown) => e);
    expect(full).toMatchObject({ code: 'TLS_FAILED' });
    expect((full as { hint: string }).hint).toMatch(/does not name this host/);
    const ca = await connect(redisProfileFromUrl(url, { tls: { mode: 'verify-ca', ...tls } }));
    await ca.close();
  });

  it('fails with a hint when the certificate is not trusted', async () => {
    // The system store does not know the test CA.
    const untrusted = await steps(
      redisProfileFromUrl(REDIS_TLS_URL!, { tls: { mode: 'verify-full' } }),
    );
    const failed = untrusted.find((s) => s.status === 'failed')!;
    expect(failed.step).toBe('tls');
    expect(failed.hint).toMatch(/CA certificate/);
    const required = await connect(
      redisProfileFromUrl(REDIS_TLS_URL!, { tls: { mode: 'require' } }),
    );
    await required.close();
  });

  it('fails the TLS step when the server does not speak TLS on the port', async () => {
    const plain = process.env['JOINERY_TEST_REDIS_URL']!;
    // The server waits for a line that never comes, so this ends with the connect timeout.
    const result = await steps(
      redisProfileFromUrl(plain, { tls: { mode: 'require' }, options: { connectTimeoutMs: 1000 } }),
    );
    const failed = result.find((s) => s.status === 'failed')!;
    expect(failed.step).toBe('tls');
    expect(failed.message).toMatch(/Timed out/);
  });
});
