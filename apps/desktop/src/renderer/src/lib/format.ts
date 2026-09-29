const integer = new Intl.NumberFormat('en-US');

/** "1,000 rows" / "1 row". */
export function formatRows(count: number): string {
  return `${integer.format(count)} ${count === 1 ? 'row' : 'rows'}`;
}

export function formatCount(count: number): string {
  return integer.format(count);
}

/** "12 ms", "1.24 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}
