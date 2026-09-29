import { randomBytes } from 'node:crypto';

import {
  createSearchAdapter,
  isSearchSession,
  searchProfileFromUrl,
  type SearchSession,
} from '@joinery/driver-elasticsearch';

/**
 * Direct Elasticsearch / OpenSearch access for the end-to-end tests: a session that bypasses
 * the app, to check what the app wrote and to delete the run's indices afterwards (by name:
 * wildcard deletes are refused by default).
 */

export async function connectSearch(
  url: string,
  engine: 'elasticsearch' | 'opensearch' = 'elasticsearch',
): Promise<SearchSession> {
  const session = await createSearchAdapter({ engine }).connect(searchProfileFromUrl(url, engine));
  if (!isSearchSession(session)) throw new Error('expected a search session');
  return session;
}

/** `joinery-e2e-<random>`, unique per run (index names are lower case). */
export function e2eIndex(): string {
  return `joinery-e2e-${randomBytes(4).toString('hex')}`;
}

/** Whether an index exists. */
export async function indexExists(session: SearchSession, name: string): Promise<boolean> {
  return (await session.request({ method: 'HEAD', path: `/${name}` })).status === 200;
}
