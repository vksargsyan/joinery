import { toColumnChunk, type ColumnMeta, type ResultChunk } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  ResultSetBuffer,
  StatementResult,
  cellText,
  suggestColumnWidths,
  summarise,
} from '../src/renderer/src/state/results';

const columns: ColumnMeta[] = [
  { name: 'id', nativeType: 'int4', kind: 'integer' },
  { name: 'name', nativeType: 'text', kind: 'string', nullable: true },
];

function rows(start: number, count: number): ResultChunk {
  return toColumnChunk(
    0,
    2,
    Array.from({ length: count }, (_, i) => [start + i, i % 3 === 0 ? null : `row ${start + i}`]),
  );
}

describe('StatementResult', () => {
  it('accumulates column-oriented chunks and reads cells back', () => {
    const result = new StatementResult();
    result.consume({ type: 'columns', resultIndex: 0, columns });
    result.consume(rows(0, 1000));
    result.consume(rows(1000, 1000));
    result.consume({ type: 'end', durationMs: 12, rowCount: 2000 });
    const set = result.set(0)!;
    expect(set.rowCount).toBe(2000);
    expect(result.loadedRows).toBe(2000);
    expect(set.cell(0, 1500)).toBe(1500);
    expect(set.cell(1, 1500)).toBe('row 1500');
    expect(set.cell(1, 1501)).toBeNull();
    expect(set.row(2)).toEqual([2, 'row 2']);
    expect(set.cell(5, 0)).toBeNull();
    expect(set.cell(0, 99_999)).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.end).toEqual({ durationMs: 12, rowCount: 2000 });
  });

  it('keeps several result sets of one statement apart', () => {
    const result = new StatementResult();
    result.consume({ type: 'columns', resultIndex: 0, columns });
    result.consume(rows(0, 2));
    result.consume({ type: 'columns', resultIndex: 1, columns: [columns[0]!] });
    result.consume(toColumnChunk(1, 1, [[7], [8], [9]]));
    expect(result.sets.map((s) => [s.resultIndex, s.rowCount])).toEqual([
      [0, 2],
      [1, 3],
    ]);
    expect(result.set(1)?.cell(0, 2)).toBe(9);
    expect(result.loadedRows).toBe(5);
  });

  it('records status, notices and bumps its version on every chunk', () => {
    const result = new StatementResult();
    result.consume({
      type: 'notice',
      severity: 'notice',
      message: 'table "t" does not exist, skipping',
      code: '00000',
    });
    result.consume({ type: 'status', command: 'DROP TABLE', rowsAffected: null });
    result.consume({ type: 'end', durationMs: 3, rowCount: 0 });
    expect(result.version).toBe(3);
    expect(result.notices).toEqual([
      { severity: 'notice', message: 'table "t" does not exist, skipping', code: '00000' },
    ]);
    expect(result.status).toEqual({ command: 'DROP TABLE', rowsAffected: null });
    expect(result.sets).toEqual([]);
  });

  it('rejects chunks that do not fit', () => {
    const result = new StatementResult();
    expect(() => result.consume(rows(0, 1))).toThrow(/before its columns/);
    result.consume({ type: 'columns', resultIndex: 0, columns });
    expect(() => result.consume({ type: 'columns', resultIndex: 0, columns })).toThrow(/twice/);
    expect(() => result.consume(toColumnChunk(0, 3, [[1, 2, 3]]))).toThrow(/columns/);
  });

  it('summarises a statement for the Messages tab', () => {
    const select = new StatementResult();
    select.consume({ type: 'columns', resultIndex: 0, columns });
    select.consume(rows(0, 1000));
    expect(summarise(select, 'paused', 40)).toBe('1,000 rows shown, more available · 40 ms');
    expect(summarise(select, 'truncated', 40)).toBe(
      '1,000 rows shown (stopped at the row limit) · 40 ms',
    );
    select.consume({ type: 'end', durationMs: 1500, rowCount: 1000 });
    expect(summarise(select, 'done', 9)).toBe('1,000 rows returned · 1.50 s');

    const update = new StatementResult();
    update.consume({ type: 'status', command: 'UPDATE', rowsAffected: 1 });
    update.consume({ type: 'end', durationMs: 2, rowCount: 0 });
    expect(summarise(update, 'done', 0)).toBe('UPDATE · 1 row affected · 2 ms');
  });
});

describe('cell display', () => {
  it('shows every cell kind distinctly', () => {
    expect(cellText(null)).toBe('NULL');
    expect(cellText('')).toBe('');
    expect(cellText(12.5)).toBe('12.5');
    expect(cellText(2n ** 63n)).toBe('9223372036854775808');
    expect(cellText(true)).toBe('true');
    expect(cellText(new Uint8Array([0, 255, 16]))).toBe('\\x00ff10');
    expect(cellText(new Uint8Array(100)).endsWith('…')).toBe(true);
    expect(
      cellText({ $handle: 'h1', preview: 'long text', byteLength: 10_000_000, kind: 'text' }),
    ).toBe('long text…');
  });

  it('suggests column widths from the header and the first rows', () => {
    const set = new ResultSetBuffer(0, [
      { name: 'id', nativeType: 'int4', kind: 'integer' },
      { name: 'description', nativeType: 'text', kind: 'string' },
    ]);
    set.append(
      toColumnChunk(0, 2, [
        [1, 'x'.repeat(30)],
        [2, 'x'.repeat(500)],
      ]) as Extract<ResultChunk, { type: 'rows' }>,
    );
    const [id, description] = suggestColumnWidths(set);
    expect(id).toBe(64);
    expect(description).toBeGreaterThan(300);
    expect(description).toBeLessThanOrEqual(480);
  });
});
