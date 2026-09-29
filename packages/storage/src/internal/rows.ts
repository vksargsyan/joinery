import { JoineryError } from '@joinery/core';

import type { SqlRow, SqlValue } from '../sqlite';

/** Typed column readers: SQLite rows are untyped, so every read checks what it got. */

function wrongType(column: string): JoineryError {
  return new JoineryError({ code: 'INTERNAL', message: `Unexpected value in column "${column}"` });
}

function column(row: SqlRow, name: string): SqlValue {
  const value = row[name];
  if (value === undefined) throw wrongType(name);
  return value;
}

export function readText(row: SqlRow, name: string): string {
  const value = column(row, name);
  if (typeof value !== 'string') throw wrongType(name);
  return value;
}

export function readNullableText(row: SqlRow, name: string): string | null {
  const value = column(row, name);
  if (value === null) return null;
  if (typeof value !== 'string') throw wrongType(name);
  return value;
}

export function readNumber(row: SqlRow, name: string): number {
  const value = column(row, name);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw wrongType(name);
  return value;
}

export function readNullableNumber(row: SqlRow, name: string): number | null {
  const value = column(row, name);
  return value === null ? null : readNumber(row, name);
}

export function readBlob(row: SqlRow, name: string): Uint8Array {
  const value = column(row, name);
  if (!(value instanceof Uint8Array)) throw wrongType(name);
  return value;
}

/** Parses a JSON column; the caller validates the shape. */
export function readJson(row: SqlRow, name: string): unknown {
  const text = readText(row, name);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw wrongType(name);
  }
}

/** `?, ?, ?` for an IN list of `count` values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
