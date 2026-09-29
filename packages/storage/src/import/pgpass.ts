import { defineHiddenSecret } from '../internal/redact';

/**
 * One line of a PostgreSQL password file (~/.pgpass, %APPDATA%\postgresql\pgpass.conf):
 * `hostname:port:database:username:password`. A field of `*` matches anything and is
 * represented as null; `\:` and `\\` escape a colon and a backslash.
 */
export interface PgpassEntry {
  readonly host: string | null;
  readonly port: string | null;
  readonly database: string | null;
  readonly user: string | null;
  /** Non-enumerable, so JSON and inspect never show it. */
  readonly password: string;
  /** 1-based line number in the file. */
  readonly line: number;
}

export interface PgpassTarget {
  /** Host name or socket directory; defaults to localhost. */
  readonly host?: string;
  /** Defaults to 5432. */
  readonly port?: number | string;
  readonly database: string;
  readonly user: string;
}

/**
 * Parses a pgpass file the way libpq does: comments (#) and blank lines are skipped, and so are
 * lines with fewer than five fields. The password runs to the next unescaped colon.
 */
export function parsePgpass(text: string): PgpassEntry[] {
  const entries: PgpassEntry[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line === '' || line.startsWith('#')) return;
    const fields = splitFields(line);
    if (fields.length < 5) return;
    const [host, port, database, user, password] = fields;
    if (!host || !port || !database || !user || password === undefined) return;
    const entry = {
      host: wildcard(host),
      port: wildcard(port),
      database: wildcard(database),
      user: wildcard(user),
      line: index + 1,
    };
    defineHiddenSecret(entry, 'password', password.value);
    entries.push(entry as PgpassEntry);
  });
  return entries;
}

/** Default Unix socket directories, which libpq matches against "localhost" lines. */
const DEFAULT_SOCKET_DIRS = new Set(['/tmp', '/var/run/postgresql', '/run/postgresql']);

/**
 * The first entry that matches, as libpq picks it (so order in the file matters), or undefined.
 * A connection through a default socket directory also matches `localhost` lines.
 */
export function matchPgpass(
  entries: readonly PgpassEntry[],
  target: PgpassTarget,
): PgpassEntry | undefined {
  const host = target.host === undefined || target.host === '' ? 'localhost' : target.host;
  const hosts = DEFAULT_SOCKET_DIRS.has(host) ? [host, 'localhost'] : [host];
  const port = String(target.port ?? 5432);
  return entries.find(
    (entry) =>
      (entry.host === null || hosts.includes(entry.host)) &&
      (entry.port === null || entry.port === port) &&
      (entry.database === null || entry.database === target.database) &&
      (entry.user === null || entry.user === target.user),
  );
}

interface Field {
  readonly value: string;
  /** The field was exactly an unescaped `*`. */
  readonly wildcard: boolean;
}

function wildcard(field: Field): string | null {
  return field.wildcard ? null : field.value;
}

/** Splits on unescaped colons; the fifth field (the password) ends at the next one. */
function splitFields(line: string): Field[] {
  const fields: Field[] = [];
  let value = '';
  let escaped = false;
  let raw = '';
  for (const ch of line) {
    if (escaped) {
      value += ch;
      raw += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
      raw += '\\';
    } else if (ch === ':') {
      fields.push({ value, wildcard: raw === '*' });
      if (fields.length === 5) return fields;
      value = '';
      raw = '';
    } else {
      value += ch;
      raw += ch;
    }
  }
  // A trailing lone backslash is kept literally, as libpq does.
  if (escaped) value += '\\';
  fields.push({ value, wildcard: raw === '*' });
  return fields;
}
