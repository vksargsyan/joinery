import { BASE_CAPABILITIES, JoineryError, cancelledError, toColumnChunk } from '@joinery/core';
import type {
  BrowseNode,
  Capabilities,
  CellValue,
  ColumnMeta,
  ExecOptions,
  ResultChunk,
  SchemaSnapshot,
  Session,
} from '@joinery/core';

/**
 * An in-memory Session for the import and export unit tests. Writes: every INSERT's
 * parameters are split into rows of `width` values; a row `failWhen` rejects fails the whole
 * statement (nothing applied, like a real multi-row INSERT), and on PostgreSQL aborts the
 * transaction until ROLLBACK or ROLLBACK TO SAVEPOINT. Transactions and savepoints are
 * modelled, so tests can check what was committed. Reads: any SELECT returns `result`, paged.
 */
export class FakeSession implements Session {
  readonly serverVersion: string;
  inTransaction = false;
  readonly log: { text: string; params: readonly CellValue[] }[] = [];
  committed: CellValue[][] = [];
  private pending: CellValue[][] = [];
  private aborted = false;
  private readonly savepoints = new Map<string, number>();
  /** Values per written row. */
  width = 1;
  /** Returns an error message for a row the "server" rejects. */
  failWhen: ((row: readonly CellValue[]) => string | undefined) | undefined;
  /** What SELECTs return. */
  result: { columns: ColumnMeta[]; rows: CellValue[][] } = { columns: [], rows: [] };
  /** Pages handed out by SELECTs so far. */
  pagesServed = 0;
  /** Delay before each write, to let tests cancel mid-run. */
  writeDelayMs = 0;
  /** Called before each write statement runs. */
  beforeWrite: (() => void) | undefined;

  constructor(
    readonly engine: 'postgres' | 'mysql' | 'mariadb' = 'postgres',
    version?: string,
  ) {
    this.serverVersion =
      version ?? (engine === 'postgres' ? '16.4' : engine === 'mysql' ? '8.4.2' : '11.4.3-MariaDB');
  }

  capabilities(): Capabilities {
    return BASE_CAPABILITIES[this.engine];
  }

  get statements(): string[] {
    return this.log.map((entry) => entry.text);
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    return this.run(text, opts);
  }

  private fail(message: string): never {
    throw new JoineryError({ code: 'SQL_ERROR', message });
  }

  private async *run(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    const params = Array.isArray(opts.params) ? (opts.params as CellValue[]) : [];
    const aborted = (): boolean => opts.signal?.aborted === true;
    if (aborted()) throw cancelledError();
    this.log.push({ text, params });
    const upper = text.trim().toUpperCase();
    const status = (command: string, rowsAffected: number | null): ResultChunk => ({
      type: 'status',
      command,
      rowsAffected,
    });

    if (upper.startsWith('SELECT @@MAX_ALLOWED_PACKET')) {
      yield {
        type: 'columns',
        resultIndex: 0,
        columns: [{ name: 'p', nativeType: 'bigint', kind: 'integer' }],
      };
      yield toColumnChunk(0, 1, [[64 * 1024 * 1024]]);
      yield { type: 'end', durationMs: 0, rowCount: 1 };
      return;
    }
    if (upper === 'BEGIN' || upper === 'START TRANSACTION') {
      this.inTransaction = true;
      this.pending = [];
      this.aborted = false;
    } else if (upper === 'COMMIT') {
      if (!this.aborted) this.committed.push(...this.pending);
      this.pending = [];
      this.inTransaction = false;
      this.aborted = false;
    } else if (upper === 'ROLLBACK') {
      this.pending = [];
      this.inTransaction = false;
      this.aborted = false;
    } else if (upper.startsWith('SAVEPOINT ')) {
      if (this.aborted) this.fail('current transaction is aborted');
      this.savepoints.set(upper.slice(10), this.pending.length);
    } else if (upper.startsWith('ROLLBACK TO SAVEPOINT ')) {
      const at = this.savepoints.get(upper.slice(22));
      if (at === undefined) this.fail('no such savepoint');
      this.pending.length = at;
      this.aborted = false;
    } else if (upper.startsWith('RELEASE SAVEPOINT ')) {
      if (this.aborted) this.fail('current transaction is aborted');
      this.savepoints.delete(upper.slice(18));
    } else if (upper.startsWith('SELECT')) {
      const pageSize = opts.pageSize ?? 1000;
      const { columns, rows } = this.result;
      yield { type: 'columns', resultIndex: 0, columns };
      for (let at = 0; at < rows.length; at += pageSize) {
        if (aborted()) throw cancelledError('Query cancelled');
        this.pagesServed++;
        yield toColumnChunk(0, columns.length, rows.slice(at, at + pageSize));
      }
      yield { type: 'end', durationMs: 0, rowCount: rows.length };
      return;
    } else if (/^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(upper)) {
      if (this.aborted) this.fail('current transaction is aborted, commands ignored');
      this.beforeWrite?.();
      if (this.writeDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
      if (aborted()) {
        if (this.engine === 'postgres' && this.inTransaction) this.aborted = true;
        throw cancelledError('Query cancelled');
      }
      const rows: CellValue[][] = [];
      for (let at = 0; at < params.length; at += this.width)
        rows.push(params.slice(at, at + this.width));
      for (const row of rows) {
        const message = this.failWhen?.(row);
        if (message !== undefined) {
          if (this.engine === 'postgres' && this.inTransaction) this.aborted = true;
          this.fail(message);
        }
      }
      if (upper.startsWith('INSERT')) {
        if (this.inTransaction) this.pending.push(...rows);
        else this.committed.push(...rows);
      }
      yield status(upper.split(' ')[0]!, rows.length);
      yield { type: 'end', durationMs: 0, rowCount: 0 };
      return;
    }
    yield status(upper.split(' ')[0] ?? '', null);
    yield { type: 'end', durationMs: 0, rowCount: 0 };
  }

  async cancel(): Promise<void> {}

  async introspect(): Promise<SchemaSnapshot> {
    throw new Error('not in the fake');
  }

  async browse(): Promise<BrowseNode[]> {
    return [];
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
