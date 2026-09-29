import {
  BASE_CAPABILITIES,
  JoineryError,
  cancelledError,
  schemaSnapshotSchema,
  tableDefSchema,
  toColumnChunk,
  type BrowseNode,
  type Capabilities,
  type CellValue,
  type ColumnMeta,
  type ExecOptions,
  type ResultChunk,
  type SchemaSnapshot,
  type Session,
  type TableDef,
} from '@joinery/core';

/**
 * A driver session for the job runner tests: it knows one table (for imports), answers every
 * SELECT with `result` (for exports), records every statement, and fails statements that
 * `failWhen` picks. Transactions are tracked so tests can check what was committed.
 */
export class FakeJobSession implements Session {
  readonly engine = 'postgres' as const;
  readonly serverVersion = '16.4';
  inTransaction = false;
  readonly statements: { text: string; params: readonly CellValue[] }[] = [];
  committed: CellValue[][] = [];
  #pending: CellValue[][] = [];
  closed = false;
  table: TableDef = tableDefSchema.parse({
    name: 'people',
    columns: [
      { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
      { name: 'name', ordinal: 2, dataType: 'text', nullable: true },
    ],
    primaryKey: { name: 'people_pkey', columns: ['id'] },
  });
  result: { columns: ColumnMeta[]; rows: CellValue[][] } = { columns: [], rows: [] };
  failWhen: ((text: string, params: readonly CellValue[]) => string | undefined) | undefined;
  /** Delay before each write, so a test can cancel mid-run. */
  writeDelayMs = 0;

  capabilities(): Capabilities {
    return BASE_CAPABILITIES.postgres;
  }

  execute(text: string, options: ExecOptions): AsyncIterable<ResultChunk> {
    return this.#run(text, options);
  }

  async *#run(text: string, options: ExecOptions): AsyncGenerator<ResultChunk> {
    const params = Array.isArray(options.params) ? (options.params as CellValue[]) : [];
    if (options.signal?.aborted) throw cancelledError();
    this.statements.push({ text, params });
    const failure = this.failWhen?.(text, params);
    if (failure !== undefined) throw new JoineryError({ code: 'SQL_ERROR', message: failure });
    const upper = text.trim().toUpperCase();
    if (upper === 'BEGIN' || upper === 'START TRANSACTION') {
      this.inTransaction = true;
      this.#pending = [];
    } else if (upper === 'COMMIT') {
      this.committed.push(...this.#pending);
      this.#pending = [];
      this.inTransaction = false;
    } else if (upper === 'ROLLBACK') {
      this.#pending = [];
      this.inTransaction = false;
    } else if (upper.startsWith('INSERT')) {
      if (this.writeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
        if (options.signal?.aborted) throw cancelledError('Query cancelled');
      }
      const width = /\(([^)]*)\) VALUES/.exec(text)?.[1]?.split(',').length ?? 1;
      const rows: CellValue[][] = [];
      for (let at = 0; at < params.length; at += width) rows.push(params.slice(at, at + width));
      if (this.inTransaction) this.#pending.push(...rows);
      else this.committed.push(...rows);
      yield { type: 'status', command: 'INSERT', rowsAffected: rows.length };
    } else if (upper.startsWith('SELECT') && !upper.startsWith('SELECT @@')) {
      const { columns, rows } = this.result;
      yield { type: 'columns', resultIndex: 0, columns };
      for (let at = 0; at < rows.length; at += options.pageSize ?? 1000) {
        yield toColumnChunk(0, columns.length, rows.slice(at, at + (options.pageSize ?? 1000)));
      }
    } else {
      yield { type: 'status', command: upper.split(' ')[0] ?? '', rowsAffected: null };
    }
    yield { type: 'end', durationMs: 0, rowCount: 0 };
  }

  async cancel(): Promise<void> {}

  async introspect(): Promise<SchemaSnapshot> {
    return schemaSnapshotSchema.parse({
      engine: 'postgres',
      database: 'app',
      schemas: [{ name: 'public', tables: [this.table] }],
      capturedAt: new Date().toISOString(),
    });
  }

  async browse(): Promise<BrowseNode[]> {
    return [];
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}
