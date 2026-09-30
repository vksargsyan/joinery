/** A parsed server version. `raw` keeps the full banner, e.g. "10.11.6-MariaDB-0ubuntu0.24.04.1". */
export interface ServerVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

const VERSION_RE = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

/**
 * Parses the leading dotted number of a server version banner. Handles MySQL ("8.4.2"),
 * MariaDB ("10.11.6-MariaDB-log"), PostgreSQL ("16.4 (Debian 16.4-1.pgdg120+2)") and similar.
 * Returns undefined when the banner holds no number.
 */
export function parseServerVersion(raw: string): ServerVersion | undefined {
  const match = VERSION_RE.exec(raw);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    raw,
  };
}

/** Compares two versions; negative when `a` is older than `b`, zero when equal. */
export function compareVersions(a: ServerVersion | string, b: ServerVersion | string): number {
  const va = typeof a === 'string' ? parseServerVersion(a) : a;
  const vb = typeof b === 'string' ? parseServerVersion(b) : b;
  if (!va || !vb) throw new TypeError(`Cannot compare versions "${String(a)}" and "${String(b)}"`);
  return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
}

/** True when `version` is at least `minimum` (e.g. `atLeast(v, '8.0.18')`). */
export function atLeast(version: ServerVersion | string | undefined, minimum: string): boolean {
  if (version === undefined) return false;
  const parsed = typeof version === 'string' ? parseServerVersion(version) : version;
  return parsed !== undefined && compareVersions(parsed, minimum) >= 0;
}
