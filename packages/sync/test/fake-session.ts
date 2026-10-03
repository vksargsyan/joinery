import { createHash } from 'node:crypto';

import { BASE_CAPABILITIES, toColumnChunk } from '@querybara/core';
import type {
  BrowseNode,
  Capabilities,
  CellValue,
  ColumnKind,
  ColumnMeta,
  ExecOptions,
  ResultChunk,
  SchemaSnapshot,
  Session,
} from '@querybara/core';

import { compareKeys } from '../src';

/**
 * An in-memory Session holding one table. It answers exactly the queries the data compare
 * issues (column probe, key boundary, range checksum, key-ordered range rows) by reading the
 * query shape and its positional parameters, and records every query it ran.
 */
export class FakeSession implements Session {
  readonly serverVersion: string;
  readonly inTransaction = false;
  readonly executed: { text: string; params: readonly CellValue[] }[] = [];

  constructor(
    readonly engine: 'postgres' | 'mysql' | 'mariadb',
    private readonly columns: readonly ColumnMeta[],
    private readonly rows: readonly (readonly CellValue[])[],
    private readonly keyColumns: readonly string[],
  ) {
    this.serverVersion = engine === 'postgres' ? '16.4' : '8.4.2';
  }

  capabilities(): Capabilities {
    return BASE_CAPABILITIES[this.engine];
  }

  private index(name: string): number {
    const i = this.columns.findIndex((c) => c.name === name);
    if (i === -1) throw new Error(`unknown column ${name}`);
    return i;
  }

  private keyKinds(): ColumnKind[] {
    return this.keyColumns.map((k) => this.columns[this.index(k)]!.kind);
  }

  private key(row: readonly CellValue[]): CellValue[] {
    return this.keyColumns.map((k) => row[this.index(k)] ?? null);
  }

  /** Decodes (lower, upper] from the parameters, per the dialect's predicate shape. */
  private range(
    text: string,
    params: readonly CellValue[],
  ): { lower?: CellValue[]; upper?: CellValue[] } {
    const n = this.keyColumns.length;
    const where = text.includes(' WHERE ') ? text.slice(text.indexOf(' WHERE ')) : '';
    const hasLower = / > (\$|\?|\()/.test(where);
    const hasUpper = / <= (\$|\?|\()/.test(where);
    const perBound = this.engine === 'postgres' || n === 1 ? n : 2 * n - 1;
    const decode = (values: readonly CellValue[]): CellValue[] =>
      this.engine === 'postgres' || n === 1 ? [...values] : values.filter((_v, i) => i % 2 === 0);
    const out: { lower?: CellValue[]; upper?: CellValue[] } = {};
    let offset = 0;
    if (hasLower) {
      out.lower = decode(params.slice(0, perBound));
      offset = perBound;
    }
    if (hasUpper) out.upper = decode(params.slice(offset, offset + perBound));
    return out;
  }

  private inRange(
    row: readonly CellValue[],
    range: { lower?: CellValue[]; upper?: CellValue[] },
  ): boolean {
    const key = this.key(row);
    const kinds = this.keyKinds();
    if (range.lower !== undefined && compareKeys(key, range.lower, kinds) <= 0) return false;
    if (range.upper !== undefined && compareKeys(key, range.upper, kinds) > 0) return false;
    return true;
  }

  private sorted(rows: readonly (readonly CellValue[])[]): (readonly CellValue[])[] {
    const kinds = this.keyKinds();
    return [...rows].sort((a, b) => compareKeys(this.key(a), this.key(b), kinds));
  }

  private selectList(text: string): string[] {
    const list = /^SELECT (.*?) FROM /s.exec(text)?.[1] ?? '';
    return [...list.matchAll(/"((?:[^"]|"")+)"|`((?:[^`]|``)+)`/g)].map((m) =>
      (m[1] ?? m[2])!.replace(/""|``/g, (q) => q[0]!),
    );
  }

  async *execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    const params = Array.isArray(opts.params) ? (opts.params as CellValue[]) : [];
    this.executed.push({ text, params });
    const started = Date.now();
    let result: { columns: ColumnMeta[]; rows: CellValue[][] };
    if (text.includes('WHERE 1 = 0')) {
      result = { columns: [...this.columns], rows: [] };
    } else if (text.includes('AS row_count')) {
      const range = this.range(text, params);
      const names = [
        ...text.matchAll(
          /length\("((?:[^"]|"")+)"::text\)|LENGTH\(CAST\(`((?:[^`]|``)+)` AS BINARY\)\)/g,
        ),
      ].map((m) => (m[1] ?? m[2])!);
      const rows = this.sorted(this.rows.filter((r) => this.inRange(r, range)));
      const hash = createHash('md5');
      for (const row of rows) {
        hash.update(
          JSON.stringify(
            names.map((n) => row[this.index(n)] ?? null),
            (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v),
          ),
        );
      }
      result = {
        columns: [
          { name: 'row_count', nativeType: 'bigint', kind: 'bigint' },
          { name: 'checksum', nativeType: 'text', kind: 'string' },
        ],
        rows: [[rows.length, hash.digest('hex')]],
      };
    } else if (/LIMIT 1 OFFSET (\d+)$/.test(text)) {
      const offset = Number(/LIMIT 1 OFFSET (\d+)$/.exec(text)![1]);
      const range = this.range(text, params);
      const rows = this.sorted(this.rows.filter((r) => this.inRange(r, range)));
      const hit = rows[offset];
      result = {
        columns: this.keyColumns.map((k) => this.columns[this.index(k)]!),
        rows: hit === undefined ? [] : [this.key(hit)],
      };
    } else {
      const names = this.selectList(text);
      const range = this.range(text, params);
      const rows = this.sorted(this.rows.filter((r) => this.inRange(r, range)));
      result = {
        columns: names.map((n) => this.columns[this.index(n)]!),
        rows: rows.map((r) => names.map((n) => r[this.index(n)] ?? null)),
      };
    }
    yield { type: 'columns', resultIndex: 0, columns: result.columns };
    const page = opts.pageSize ?? 1000;
    for (let i = 0; i < result.rows.length; i += page) {
      if (opts.signal?.aborted) throw new Error('aborted');
      yield toColumnChunk(0, result.columns.length, result.rows.slice(i, i + page));
    }
    yield { type: 'end', durationMs: Date.now() - started, rowCount: result.rows.length };
  }

  async cancel(): Promise<void> {}
  async introspect(): Promise<SchemaSnapshot> {
    throw new Error('not used');
  }
  async browse(): Promise<BrowseNode[]> {
    return [];
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
