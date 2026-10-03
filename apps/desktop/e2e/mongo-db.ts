import { randomBytes } from 'node:crypto';

import { connectionProfileSchema } from '@querybara/core';
import { isMongoSession, mongodbAdapter, type MongoSession } from '@querybara/driver-mongodb';
import { parseConnectionUri } from '@querybara/storage';

/**
 * Direct MongoDB access for the end-to-end tests: a scratch database per suite (always dropped)
 * and a session that bypasses the app, to seed documents, change them concurrently and check
 * what the app wrote.
 */

/** A session on the test server (TLS off: the test server speaks plain TCP). */
export async function connectMongo(url: string): Promise<MongoSession> {
  const parsed = parseConnectionUri(withoutTls(url));
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: 'e2e',
    createdAt: now,
    updatedAt: now,
  });
  const ref = profile.auth.method === 'password' ? profile.auth.password : undefined;
  const session = await mongodbAdapter.connect({
    profile,
    secrets: ref && parsed.password !== undefined ? { [ref.id]: parsed.password } : {},
  });
  if (!isMongoSession(session)) throw new Error('expected a MongoDB session');
  return session;
}

/** The URL with TLS turned off, as the app's profile will be. */
export function withoutTls(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('tls', 'false');
  return parsed.toString();
}

/** A unique database name for one suite; `drop` removes it. */
export function scratchMongoDatabase(session: MongoSession): {
  readonly name: string;
  drop(): Promise<void>;
} {
  const name = `querybara_e2e_${randomBytes(4).toString('hex')}`;
  return { name, drop: () => session.dropDatabase(name) };
}
