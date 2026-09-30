import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';

/**
 * Builds a resolved Redis profile from a URL such as `redis://user:pass@127.0.0.1:6379/0`, with
 * the password moved into the secrets map the way the connection host does it. For tests and
 * tooling (JOINERY_TEST_REDIS_*). `rediss://` turns TLS on (`?tls=<mode>` picks the mode,
 * verify-full by default); `redis://` has TLS off.
 */
export function redisProfileFromUrl(
  url: string,
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'redis' && scheme !== 'rediss') throw new Error(`Unsupported scheme "${scheme}"`);
  const password = decodeURIComponent(parsed.password);
  const user = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const tlsMode =
    parsed.searchParams.get('tls') ?? (scheme === 'rediss' ? 'verify-full' : 'disable');
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: 'test-redis',
    name: 'Test Redis',
    engine: 'redis',
    endpoint: {
      kind: 'host',
      host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: parsed.port ? Number(parsed.port) : 6379,
    },
    auth: password
      ? { method: 'password', ...(user ? { user } : {}), password: { id: 'password' } }
      : { method: 'none' },
    tls: { mode: tlsMode },
    createdAt: now,
    updatedAt: now,
    ...overrides,
    options: { ...(database ? { defaultDatabase: database } : {}), ...overrides.options },
  });
  return { profile, secrets: password ? { password } : {} };
}
