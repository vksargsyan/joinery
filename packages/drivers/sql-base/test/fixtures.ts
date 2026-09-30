import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';

const now = '2026-09-29T10:00:00.000Z';

/** A resolved profile with defaults applied; `secrets` default to a password. */
export function resolved(
  input: Partial<ConnectionProfileInput> = {},
  secrets: Record<string, string> = { pw: 's3cret' },
  endpointOverride?: { host: string; port: number },
): ResolvedProfile {
  const profile = connectionProfileSchema.parse({
    id: 'p1',
    name: 'Test',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'db.example.com', port: 5432 },
    auth: { method: 'password', user: 'app', password: { id: 'pw' } },
    // A remote server with verified TLS (a new profile's default is TLS off).
    tls: { mode: 'verify-full' },
    createdAt: now,
    updatedAt: now,
    ...input,
  });
  return { profile, secrets, ...(endpointOverride ? { endpointOverride } : {}) };
}
