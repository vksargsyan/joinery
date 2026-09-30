import type { ExecOptions, ResolvedProfile, ResultChunk, Session } from '@joinery/core';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';

import { createMysqlAdapter } from '../../src';

type Overrides = Parameters<typeof resolvedProfileFromUrl>[1];

/** Servers to test against: each runs only when its URL is set. */
export const TARGETS = (
  [
    ['mysql', process.env['JOINERY_TEST_MYSQL_URL']],
    ['mariadb', process.env['JOINERY_TEST_MARIADB_URL']],
  ] as const
).filter(
  (entry): entry is readonly ['mysql' | 'mariadb', string] =>
    typeof entry[1] === 'string' && entry[1] !== '',
);

/** Suites to declare: the targets, or one skipped placeholder so an unconfigured run passes. */
export const SUITES: readonly (readonly ['mysql' | 'mariadb', string])[] =
  TARGETS.length > 0 ? TARGETS : [['mysql', 'mysql://unset']];

export interface Target {
  readonly engine: 'mysql' | 'mariadb';
  readonly url: string;
  profile(overrides?: Overrides): ResolvedProfile;
  connect(overrides?: Overrides): Promise<Session>;
}

export function target(engine: 'mysql' | 'mariadb', url: string): Target {
  const profile = (overrides: Overrides = {}): ResolvedProfile =>
    resolvedProfileFromUrl(url, { engine, ...overrides });
  return {
    engine,
    url,
    profile,
    connect: (overrides = {}) => createMysqlAdapter({ engine }).connect(profile(overrides)),
  };
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

/** A session on a fresh database named `name`, dropped by `drop()`. */
export async function withDatabase(
  t: Target,
  name: string,
): Promise<{ session: Session; drop(): Promise<void> }> {
  const admin = await t.connect();
  await collect(admin, `DROP DATABASE IF EXISTS \`${name}\``);
  await collect(
    admin,
    `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  await admin.close();
  const session = await t.connect({ options: { defaultDatabase: name } });
  return {
    session,
    async drop() {
      await collect(session, `DROP DATABASE IF EXISTS \`${name}\``).catch(() => undefined);
      await session.close();
    },
  };
}
