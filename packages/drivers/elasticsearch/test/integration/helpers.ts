import { randomBytes } from 'node:crypto';

import type { ConnectionProfileInput, ResolvedProfile } from '@joinery/core';

import {
  createSearchAdapter,
  isSearchSession,
  searchProfileFromUrl,
  type SearchSession,
} from '../../src';

/**
 * The real servers the integration tests use: Elasticsearch with security on
 * (JOINERY_TEST_ELASTICSEARCH_URL, credentials in the URL) and OpenSearch without it
 * (JOINERY_TEST_OPENSEARCH_URL). Every test names its indices with a prefix unique to the run
 * and deletes them by name afterwards (wildcard deletes are refused by default).
 */

export const ES_URL = process.env['JOINERY_TEST_ELASTICSEARCH_URL'];
export const OS_URL = process.env['JOINERY_TEST_OPENSEARCH_URL'];

export interface TestServer {
  readonly engine: 'elasticsearch' | 'opensearch';
  readonly url: string;
}

/** The configured servers, for describe.each. */
export const SERVERS: readonly TestServer[] = [
  ...(ES_URL ? [{ engine: 'elasticsearch' as const, url: ES_URL }] : []),
  ...(OS_URL ? [{ engine: 'opensearch' as const, url: OS_URL }] : []),
];

/** `joinery-it-<random>-`, unique per run. */
export function testPrefix(): string {
  return `joinery-it-${randomBytes(4).toString('hex')}-`;
}

export function profileFor(
  server: TestServer,
  overrides: Partial<ConnectionProfileInput> = {},
): ResolvedProfile {
  return searchProfileFromUrl(server.url, server.engine, overrides);
}

export async function connect(
  server: TestServer,
  overrides: Partial<ConnectionProfileInput> = {},
): Promise<SearchSession> {
  const session = await createSearchAdapter({ engine: server.engine }).connect(
    profileFor(server, overrides),
  );
  if (!isSearchSession(session)) throw new Error('expected a SearchSession');
  return session;
}

/** Deletes the named indices, data streams and templates, ignoring what is already gone. */
export async function cleanUp(
  session: SearchSession,
  names: { indices?: string[]; dataStreams?: string[]; templates?: string[] },
): Promise<void> {
  for (const stream of names.dataStreams ?? []) {
    await session
      .request({ method: 'DELETE', path: `/_data_stream/${stream}` })
      .catch(() => undefined);
  }
  for (const template of names.templates ?? []) {
    await session
      .request({ method: 'DELETE', path: `/_index_template/${template}` })
      .catch(() => undefined);
  }
  for (const index of names.indices ?? []) {
    await session.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined);
  }
}

/** Collects every hit id of a paged search. */
export async function allIds(
  pages: AsyncIterable<{ readonly hits: readonly { readonly id: string }[] }>,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const page of pages) ids.push(...page.hits.map((h) => h.id));
  return ids;
}
