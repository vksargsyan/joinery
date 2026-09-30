import { randomBytes } from 'node:crypto';

import { newId, rowAt, type CellValue, type Session } from '@joinery/core';
import { createPostgresAdapter } from '@joinery/driver-postgres';
import { resolvedProfileFromUrl } from '@joinery/driver-sql-base';

/**
 * Direct server access for the end-to-end tests: a scratch database per suite (always dropped),
 * and plain queries that bypass the app, to set up data, make concurrent changes and check what
 * the app wrote.
 */

/** A session on `database`, or on the URL's database. */
export function connect(url: string, database?: string): Promise<Session> {
  return createPostgresAdapter().connect(
    resolvedProfileFromUrl(
      url,
      database === undefined ? {} : { options: { defaultDatabase: database } },
    ),
  );
}

/** Runs one statement and returns the rows of its first result. */
export async function query(session: Session, sql: string): Promise<CellValue[][]> {
  const rows: CellValue[][] = [];
  for await (const chunk of session.execute(sql, { executionId: newId() })) {
    if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      for (let r = 0; r < chunk.rowCount; r++) rows.push(rowAt(chunk, r));
    }
  }
  return rows;
}

/** A new, empty database with a unique name; `drop` removes it even with sessions still open. */
export async function scratchDatabase(
  url: string,
): Promise<{ readonly name: string; readonly url: string; drop(): Promise<void> }> {
  const name = `joinery_e2e_${randomBytes(4).toString('hex')}`;
  const admin = await connect(url);
  try {
    await query(admin, `CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return {
    name,
    url: parsed.toString(),
    async drop() {
      const session = await connect(url);
      try {
        await query(session, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await session.close();
      }
    },
  };
}
