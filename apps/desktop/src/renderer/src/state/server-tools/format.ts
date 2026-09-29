import type { ToolCell, ValueUnit } from '@joinery/core';

import { formatCount } from '../../lib/format';
import { formatUptime } from '../redis/dashboard';
import { formatBytes } from '../redis/value-model';

/**
 * How the server tools show numbers and cells: the unit hint of a column or tile decides
 * between counts, sizes, durations, percentages, times and yes/no.
 */

const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "12 ms", "1.2 s", "4 min 3 s". */
export function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${decimal.format(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatUptime(Math.round(ms / 1000));
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) || Math.abs(value) >= 100
    ? formatCount(Math.round(value))
    : decimal.format(value);
}

export function formatValue(value: number | null | undefined, unit: ValueUnit | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'bytes':
      return formatBytes(Math.round(value));
    case 'ms':
      return formatMs(value);
    case 'seconds':
      return value < 60 ? `${decimal.format(value)} s` : formatUptime(Math.round(value));
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
    case 'percent':
      return `${decimal.format(value)}%`;
    case 'bool':
      return value ? 'Yes' : 'No';
    default:
      return formatNumber(value);
  }
}

/** A table cell as text. */
export function formatCell(value: ToolCell | undefined, unit: ValueUnit | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (unit === 'time') {
    // PostgreSQL prints "2026-09-29 21:47:57.1+00"; Date wants "T" and "+00:00".
    const iso =
      typeof value === 'number' ? value : value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  if (typeof value === 'number') return formatValue(value, unit);
  if (
    unit !== undefined &&
    unit !== 'text' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value))
  ) {
    return formatValue(Number(value), unit);
  }
  return value;
}

/** Right-aligned columns: numbers of every unit but text and time. */
export function isNumericUnit(unit: ValueUnit | undefined): boolean {
  return unit !== undefined && unit !== 'text' && unit !== 'time' && unit !== 'bool';
}
