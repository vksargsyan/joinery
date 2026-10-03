import {
  connectionProfileSchema,
  ENGINES,
  type ConnectionProfileInput,
  type ResolvedProfile,
  type SqlEngineId,
} from '@querybara/core';

const SCHEMES: Readonly<Record<string, SqlEngineId>> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
};

/**
 * Builds a resolved profile from a URL such as `postgres://user:pass@127.0.0.1:5432/db`, with
 * the password moved into the secrets map the way the connection host does it. For tests and
 * tooling (QUERYBARA_TEST_*_URL); TLS defaults to `disable` unless `?tls=<mode>` is given.
 */
export function resolvedProfileFromUrl(
  url: string,
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, '');
  const engine = SCHEMES[scheme];
  if (engine === undefined) throw new Error(`Unsupported scheme "${scheme}"`);
  const password = decodeURIComponent(parsed.password);
  const user = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const tlsMode = parsed.searchParams.get('tls') ?? 'disable';
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: `test-${engine}`,
    name: `Test ${ENGINES[engine].displayName}`,
    engine,
    endpoint: {
      kind: 'host',
      host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: parsed.port ? Number(parsed.port) : ENGINES[engine].defaultPort,
    },
    auth: {
      method: 'password',
      ...(user ? { user } : {}),
      ...(password ? { password: { id: 'password' } } : {}),
    },
    tls: { mode: tlsMode },
    createdAt: now,
    updatedAt: now,
    ...overrides,
    // Profile options merge, so a test can set a timeout and keep the URL's database.
    options: { ...(database ? { defaultDatabase: database } : {}), ...overrides.options },
  });
  return { profile, secrets: password ? { password } : {} };
}
