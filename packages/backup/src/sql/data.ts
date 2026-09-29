import {
  newId,
  type CellValue,
  type ColumnKind,
  type ResultChunk,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@joinery/core';
import { quoteIdent, quoteQualified } from '@joinery/sql-tools';
import { sqlLiteral } from '@joinery/sync';

import { cancelled } from '../util';

/**
 * Table data as batched multi-row INSERTs (spec §14: streaming SELECT to SQL). Rows stream from
 * the driver a page at a time and each page is written before the next is fetched, so the
 * database cursor holds the rest of the table. Literals come from the sync engine's
 * `sqlLiteral`, as the SQL export's do: exact digits for numbers and decimals, the server's own
 * text for dates, times, JSON and arrays, hex for binary.
 *
 * Generated columns are left out (the server computes them again); PostgreSQL identity columns
 * declared GENERATED ALWAYS need OVERRIDING SYSTEM VALUE to keep their values.
 */

export interface TableData {
  /** The SELECT that reads the rows. */
  readonly query: string;
  /** Columns named by the INSERTs, in order. */
  readonly columns: readonly string[];
  /** `INSERT INTO t (a, b) VALUES` with the trailing newline. */
  readonly head: string;
}

function isFloat(dataType: string): boolean {
  return /^float\b/i.test(dataType.trim());
}

/** The statements that read a table and name its columns. */
export function tableData(dialect: SqlDialect, table: TableDef, schema?: string): TableData {
  const pg = dialect === 'postgres';
  const columns = [...table.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .filter((column) => column.generated === undefined);
  const names = columns.map((column) => column.name);
  const select = columns.map((column) => {
    const ident = quoteIdent(column.name, dialect);
    // MySQL sends FLOAT over the text protocol rounded to six digits; as a DOUBLE it is exact,
    // and the INSERT rounds it back to the same single-precision value.
    return !pg && isFloat(column.dataType) ? `(${ident} + 0e0) AS ${ident}` : ident;
  });
  const name = pg ? quoteQualified([schema, table.name], dialect) : quoteIdent(table.name, dialect);
  // A partitioned table returns its partitions' rows; a plain parent must not repeat its
  // inheritance children's, which are backed up as tables of their own.
  const from = pg && table.kind !== 'partitioned' ? `ONLY ${name}` : name;
  const overriding =
    pg && columns.some((column) => column.identity?.generation === 'always')
      ? ' OVERRIDING SYSTEM VALUE'
      : '';
  const list = names.map((c) => quoteIdent(c, dialect)).join(', ');
  return {
    query: `SELECT ${select.length > 0 ? select.join(', ') : '*'} FROM ${from}`,
    columns: names,
    head: `INSERT INTO ${name} (${list})${overriding} VALUES\n`,
  };
}

export interface InsertWriterOptions {
  /** Rows per INSERT (default 500). */
  readonly rowsPerStatement?: number;
  /** Longest statement in characters (default 1 MiB, well under max_allowed_packet). */
  readonly maxStatementLength?: number;
}

/** Turns row pages into INSERT statement text. */
export class InsertWriter {
  #open = false;
  #count = 0;
  #length = 0;
  #kinds: readonly (ColumnKind | undefined)[] = [];
  readonly #rowsPerStatement: number;
  readonly #maxLength: number;

  constructor(
    private readonly dialect: SqlDialect,
    private readonly head: string,
    options: InsertWriterOptions = {},
  ) {
    this.#rowsPerStatement = Math.max(1, options.rowsPerStatement ?? 500);
    this.#maxLength = Math.max(1024, options.maxStatementLength ?? 1024 * 1024);
  }

  columns(kinds: readonly (ColumnKind | undefined)[]): void {
    this.#kinds = kinds;
  }

  page(chunk: Extract<ResultChunk, { type: 'rows' }>): string {
    const data = chunk.data;
    const width = data.length;
    let out = '';
    for (let r = 0; r < chunk.rowCount; r++) {
      let tuple = '(';
      for (let c = 0; c < width; c++) {
        if (c > 0) tuple += ', ';
        tuple += sqlLiteral(data[c]![r] ?? null, this.dialect, this.#kinds[c]);
      }
      tuple += ')';
      if (
        this.#open &&
        (this.#count >= this.#rowsPerStatement || this.#length + tuple.length > this.#maxLength)
      ) {
        out += ';\n';
        this.#open = false;
      }
      if (!this.#open) {
        out += this.head;
        this.#open = true;
        this.#count = 0;
        this.#length = this.head.length;
      } else {
        out += ',\n';
      }
      out += tuple;
      this.#count++;
      this.#length += tuple.length + 2;
    }
    return out;
  }

  end(): string {
    if (!this.#open) return '';
    this.#open = false;
    return ';\n';
  }
}

/**
 * Streams a table's rows as INSERT text into `write`, page by page. Returns the row count.
 * `onRows` reports progress after each page.
 */
export async function streamTableData(
  session: Session,
  dialect: SqlDialect,
  data: TableData,
  write: (text: string) => Promise<void>,
  options: InsertWriterOptions & {
    readonly signal?: AbortSignal;
    readonly pageSize?: number;
    readonly onRows?: (rows: number) => void;
  } = {},
): Promise<number> {
  if (data.columns.length === 0) return 0;
  const writer = new InsertWriter(dialect, data.head, options);
  let rows = 0;
  for await (const chunk of session.execute(data.query, {
    executionId: newId(),
    pageSize: options.pageSize ?? 1000,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    if (options.signal?.aborted === true) throw cancelled();
    if (chunk.type === 'columns' && chunk.resultIndex === 0) {
      writer.columns(chunk.columns.map((column) => column.kind));
    } else if (chunk.type === 'rows' && chunk.resultIndex === 0) {
      await write(writer.page(chunk));
      rows += chunk.rowCount;
      options.onRows?.(rows);
    }
  }
  if (options.signal?.aborted === true) throw cancelled();
  await write(writer.end());
  return rows;
}

/** A literal for a single value, for the statements the backup adds (sequence positions). */
export function literal(value: CellValue, dialect: SqlDialect): string {
  return sqlLiteral(value, dialect);
}
