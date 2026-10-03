import type { ExecOptions, ResolvedProfile, ResultChunk, Session } from '@querybara/core';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';

import { createPostgresAdapter } from '../../src';

export const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];

export function testProfile(
  overrides: Parameters<typeof resolvedProfileFromUrl>[1] = {},
): ResolvedProfile {
  if (!PG_URL) throw new Error('QUERYBARA_TEST_POSTGRES_URL is not set');
  return resolvedProfileFromUrl(PG_URL, overrides);
}

export async function connect(
  overrides: Parameters<typeof resolvedProfileFromUrl>[1] = {},
): Promise<Session> {
  return createPostgresAdapter().connect(testProfile(overrides));
}

let counter = 0;
export function execId(): string {
  counter += 1;
  return `exec-${counter}`;
}

/** Starts a statement and returns its cursor, for tests that pull pages by hand. */
export function iterate(
  session: Session,
  text: string,
  opts: Partial<ExecOptions> = {},
): AsyncIterator<ResultChunk> {
  const iterable = session.execute(text, { executionId: execId(), ...opts });
  return iterable[Symbol.asyncIterator]();
}

/** Runs a statement to completion and collects its chunks. */
export async function collect(
  session: Session,
  text: string,
  params?: unknown[],
): Promise<ResultChunk[]> {
  const chunks: ResultChunk[] = [];
  for await (const chunk of session.execute(text, {
    executionId: execId(),
    ...(params ? { params: params as never } : {}),
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Runs a statement and returns its rows (row-oriented). */
export async function rows(
  session: Session,
  text: string,
  params?: unknown[],
): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for (const chunk of await collect(session, text, params)) {
    if (chunk.type !== 'rows') continue;
    for (let r = 0; r < chunk.rowCount; r++) out.push(chunk.data.map((column) => column[r]));
  }
  return out;
}
