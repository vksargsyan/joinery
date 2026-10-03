import {
  BASE_CAPABILITIES,
  QuerybaraError,
  toColumnChunk,
  type BrowseNode,
  type Capabilities,
  type CellValue,
  type ExecOptions,
  type ResultChunk,
  type SchemaSnapshot,
  type Session,
} from '@querybara/core';

export interface FakeResult {
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly CellValue[])[];
  readonly rowsAffected?: number | null;
}

export type FakeHandler = (sql: string, params: readonly CellValue[]) => FakeResult | Error;

/** A scripted Session: answers each statement with `handler` and records what ran. */
export class FakeSession implements Session {
  readonly serverVersion = '16.4';
  readonly log: string[] = [];
  readonly params: (readonly CellValue[])[] = [];
  inTransaction = false;

  constructor(
    readonly engine: 'postgres' | 'mysql' | 'mariadb',
    private readonly handler: FakeHandler = () => ({ rowsAffected: 1 }),
    private readonly transactions = true,
  ) {
    if (!transactions) {
      this.begin = undefined;
      this.commit = undefined;
      this.rollback = undefined;
    }
  }

  capabilities(): Capabilities {
    return BASE_CAPABILITIES[this.engine];
  }

  async *execute(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    const params = (opts.params ?? []) as readonly CellValue[];
    this.log.push(text);
    this.params.push(params);
    if (opts.signal?.aborted) throw new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' });
    const result = this.handler(text, params);
    if (result instanceof Error) throw result;
    if (result.columns) {
      yield {
        type: 'columns',
        resultIndex: 0,
        columns: result.columns.map((name) => ({ name, nativeType: 'text', kind: 'string' })),
      };
      if (result.rows && result.rows.length > 0)
        yield toColumnChunk(0, result.columns.length, result.rows);
    }
    yield {
      type: 'status',
      command: text.split(' ')[0] ?? null,
      rowsAffected: result.rowsAffected ?? null,
    };
    yield { type: 'end', durationMs: 0, rowCount: result.rows?.length ?? 0 };
  }

  async cancel(): Promise<void> {}

  async introspect(): Promise<SchemaSnapshot> {
    throw new Error('not scripted');
  }

  async browse(): Promise<BrowseNode[]> {
    return [];
  }

  begin: (() => Promise<void>) | undefined = async () => {
    this.log.push('<begin>');
    this.inTransaction = true;
  };

  commit: (() => Promise<void>) | undefined = async () => {
    this.log.push('<commit>');
    this.inTransaction = false;
  };

  rollback: (() => Promise<void>) | undefined = async () => {
    this.log.push('<rollback>');
    this.inTransaction = false;
  };

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
