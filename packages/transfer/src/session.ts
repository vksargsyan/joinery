import {
  QuerybaraError,
  isSqlEngine,
  newId,
  type CellValue,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@querybara/core';
import { renderTableStatements } from '@querybara/sync';

/** Small helpers for driving a Session from the transfer pipeline. */

/** The SQL dialect to use: the given one, else the session's engine. */
export function dialectOf(session: Session, given?: SqlDialect): SqlDialect {
  if (given !== undefined) return given;
  if (isSqlEngine(session.engine)) return session.engine;
  throw new QuerybaraError({
    code: 'NOT_SUPPORTED',
    message: `Data transfer with ${session.engine} is not supported yet`,
  });
}

/** Runs one statement to the end and returns the rows it affected. */
export async function runStatement(
  session: Session,
  sql: string,
  params: readonly CellValue[] = [],
  signal?: AbortSignal,
): Promise<number> {
  let affected = 0;
  for await (const chunk of session.execute(sql, {
    executionId: newId(),
    ...(params.length > 0 ? { params } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (chunk.type === 'status' && chunk.rowsAffected !== null) affected += chunk.rowsAffected;
  }
  return affected;
}

/**
 * A table's definition from the server. PostgreSQL looks in `schema` (default `public`);
 * MySQL and MariaDB in the session's database.
 */
export async function loadTable(
  session: Session,
  name: string,
  schema?: string,
): Promise<TableDef> {
  const pg = session.engine === 'postgres';
  const snapshot = await session.introspect({
    ...(pg ? { schemas: [schema ?? 'public'] } : {}),
    include: ['table', 'sequence'],
  });
  const schemaDef = pg
    ? snapshot.schemas.find((s) => s.name === (schema ?? 'public'))
    : snapshot.schemas[0];
  const table = schemaDef?.tables.find((t) => t.name === name);
  if (table === undefined) {
    throw new QuerybaraError({
      code: 'NOT_FOUND',
      message: `Table "${pg ? `${schema ?? 'public'}.` : ''}${name}" was not found`,
    });
  }
  return table;
}

/**
 * Creates a table (CREATE TABLE, then PostgreSQL indexes and comments) from a definition, as
 * `tableFromColumns` builds for "create a new table from the file".
 */
export async function createTable(
  session: Session,
  table: TableDef,
  options: { readonly schema?: string; readonly dialect?: SqlDialect } = {},
): Promise<void> {
  const dialect = dialectOf(session, options.dialect);
  const statements = renderTableStatements(
    table,
    dialect,
    options.schema !== undefined ? { schema: options.schema } : {},
  );
  for (const statement of statements) await runStatement(session, statement);
}
