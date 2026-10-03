import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';

/**
 * Builds a resolved Elasticsearch profile from a node URL such as
 * `http://elastic:secret@127.0.0.1:9200`, with the password moved into the secrets map the way
 * the connection host does it. For tests and tooling (QUERYBARA_TEST_ELASTICSEARCH_URL...).
 * `https://` turns TLS on (`?tls=<mode>` picks the mode, verify-full by default).
 */
export function searchProfileFromUrl(
  url: string,
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https') throw new Error(`Unsupported scheme "${scheme}"`);
  const password = decodeURIComponent(parsed.password);
  const user = decodeURIComponent(parsed.username);
  const tlsMode =
    parsed.searchParams.get('tls') ?? (scheme === 'https' ? 'verify-full' : 'disable');
  const node = `${scheme}://${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: 'test-elasticsearch',
    name: 'Test Elasticsearch',
    engine: 'elasticsearch',
    endpoint: { kind: 'urls', urls: [node] },
    auth: user
      ? { method: 'password', user, ...(password ? { password: { id: 'password' } } : {}) }
      : { method: 'none' },
    tls: { mode: tlsMode },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return { profile, secrets: password ? { password } : {} };
}
