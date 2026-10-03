import type { CellValue } from '@querybara/core';

/** A row of an internal catalog query, keyed by column name. */
export type Row = Readonly<Record<string, CellValue>>;

/** Text column; empty string for NULL. */
export function str(row: Row, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Text column; undefined for NULL or ''. */
export function opt(row: Row, key: string): string | undefined {
  const value = str(row, key);
  return value === '' ? undefined : value;
}

export function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'string') return Number(value);
  return 0;
}

export function bool(row: Row, key: string): boolean {
  const value = row[key];
  return value === true || value === 't' || value === 1;
}

/** A json column (catalog queries aggregate arrays as JSON text). */
export function json<T>(row: Row, key: string, fallback: T): T {
  const value = row[key];
  if (typeof value !== 'string' || value === '') return fallback;
  return JSON.parse(value) as T;
}

/** Plain code-unit ordering, independent of the machine locale. */
export function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
