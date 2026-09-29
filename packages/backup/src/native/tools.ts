import { execFile } from 'node:child_process';
import { access, constants, readdir, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * The native dump and restore tools (spec §14: optional use of mysqldump or pg_dump when found
 * on the machine, for users who want native formats): where they are and which version and
 * family each one is, so the backup picks one that can read the server.
 */

export const NATIVE_TOOL_NAMES = [
  'pg_dump',
  'pg_restore',
  'psql',
  'mysqldump',
  'mariadb-dump',
  'mysql',
  'mariadb',
] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

/** Which client family built the tool: MySQL's and MariaDB's differ in options. */
export type ToolFamily = 'postgres' | 'mysql' | 'mariadb';

export interface NativeTool {
  readonly name: NativeToolName;
  readonly path: string;
  readonly family: ToolFamily;
  /** The server version the tool comes from, e.g. "16.13", "8.4.11", "10.11.14". */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
}

/** Folders where installers put the tools, besides PATH. */
function extraDirs(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\PostgreSQL\\*\\bin',
      'C:\\Program Files\\MySQL\\*\\bin',
      'C:\\Program Files\\MariaDB *\\bin',
    ];
  }
  return [
    '/usr/lib/postgresql/*/bin',
    '/usr/pgsql-*/bin',
    '/usr/local/pgsql/bin',
    '/usr/local/mysql/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/libpq/bin',
    '/opt/homebrew/opt/mysql-client/bin',
    '/usr/local/opt/libpq/bin',
    '/usr/local/opt/mysql-client/bin',
    '/Applications/Postgres.app/Contents/Versions/latest/bin',
  ];
}

/** Expands one `*` in a folder pattern. */
async function expand(pattern: string): Promise<string[]> {
  const star = pattern.indexOf('*');
  if (star < 0) return [pattern];
  const cut = Math.max(pattern.lastIndexOf('/', star), pattern.lastIndexOf('\\', star));
  const parent = pattern.slice(0, cut);
  const prefix = pattern.slice(cut + 1, star);
  const restAt = pattern.slice(star + 1).search(/[\\/]/);
  const suffix = restAt < 0 ? pattern.slice(star + 1) : pattern.slice(star + 1, star + 1 + restAt);
  const tail = restAt < 0 ? '' : pattern.slice(star + 1 + restAt);
  try {
    const entries = await readdir(parent);
    return entries
      .filter((e) => e.startsWith(prefix) && e.endsWith(suffix))
      .sort()
      .reverse()
      .map((e) => `${parent}${pattern[cut]}${e}${tail}`);
  } catch {
    return [];
  }
}

/** Parses `<tool> --version` output. */
export function parseToolVersion(
  name: NativeToolName,
  output: string,
): Omit<NativeTool, 'name' | 'path'> | undefined {
  const text = output.trim();
  if (name === 'pg_dump' || name === 'pg_restore' || name === 'psql') {
    const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(text);
    if (!m) return undefined;
    return {
      family: 'postgres',
      version: m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]!,
      major: Number(m[1]),
      minor: Number(m[2] ?? 0),
    };
  }
  const maria = /(\d+)\.(\d+)\.(\d+)-MariaDB/i.exec(text);
  if (maria) {
    return {
      family: 'mariadb',
      version: `${maria[1]}.${maria[2]}.${maria[3]}`,
      major: Number(maria[1]),
      minor: Number(maria[2]),
    };
  }
  const mysql = /Ver\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (mysql) {
    return {
      family: 'mysql',
      version: `${mysql[1]}.${mysql[2]}.${mysql[3]}`,
      major: Number(mysql[1]),
      minor: Number(mysql[2]),
    };
  }
  return undefined;
}

function versionOf(path: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 5000, env, windowsHide: true }, (error, stdout) =>
      resolve(error ? '' : String(stdout)),
    );
  });
}

export interface DetectOptions {
  /** More folders to look in (first). */
  readonly dirs?: readonly string[];
  /** Look on PATH (default true). */
  readonly path?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** Every native tool found, newest first per name; the same binary is listed once. */
export async function detectNativeTools(options: DetectOptions = {}): Promise<NativeTool[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathDirs =
    options.path === false ? [] : (env['PATH'] ?? env['Path'] ?? '').split(delimiter);
  const patterns = [...(options.dirs ?? []), ...pathDirs, ...extraDirs(platform)].filter(
    (d) => d !== '',
  );
  const dirs: string[] = [];
  for (const pattern of patterns) {
    for (const dir of await expand(pattern)) if (!dirs.includes(dir)) dirs.push(dir);
  }
  const seen = new Set<string>();
  const found: NativeTool[] = [];
  for (const dir of dirs) {
    for (const name of NATIVE_TOOL_NAMES) {
      const path = join(dir, platform === 'win32' ? `${name}.exe` : name);
      try {
        await access(path, constants.X_OK);
      } catch {
        continue;
      }
      const real = await realpath(path).catch(() => path);
      if (seen.has(`${name}\u0000${real}`)) continue;
      seen.add(`${name}\u0000${real}`);
      const parsed = parseToolVersion(name, await versionOf(path, env));
      if (parsed) found.push({ name, path, ...parsed });
    }
  }
  return found.sort(
    (a, b) => a.name.localeCompare(b.name) || b.major - a.major || b.minor - a.minor,
  );
}

/** The server family and major version from a session's version banner. */
export function serverFamily(
  engine: string,
  serverVersion: string,
): { family: ToolFamily; major: number } {
  const major = Number(/(\d+)/.exec(serverVersion)?.[1] ?? 0);
  if (engine === 'postgres') return { family: 'postgres', major };
  return {
    family: /mariadb/i.test(serverVersion) || engine === 'mariadb' ? 'mariadb' : 'mysql',
    major,
  };
}

export type NativeTask = 'dump' | 'restore-archive' | 'restore-script';

/**
 * The tool for a task on a server: pg_dump no older than the server (it refuses newer ones);
 * for MySQL and MariaDB the server's own family first, the other family with a warning.
 */
export function chooseTool(
  tools: readonly NativeTool[],
  task: NativeTask,
  engine: string,
  serverVersion: string,
): { tool?: NativeTool; warnings: string[]; reason?: string } {
  const server = serverFamily(engine, serverVersion);
  if (server.family === 'postgres') {
    const name = task === 'dump' ? 'pg_dump' : task === 'restore-archive' ? 'pg_restore' : 'psql';
    const candidates = tools.filter((t) => t.name === name);
    if (candidates.length === 0)
      return { warnings: [], reason: `${name} was not found on this machine` };
    const usable = task === 'dump' ? candidates.filter((t) => t.major >= server.major) : candidates;
    if (usable.length === 0) {
      return {
        warnings: [],
        reason: `${name} ${candidates[0]!.version} is older than the server (PostgreSQL ${server.major}); install PostgreSQL ${server.major} client tools or newer`,
      };
    }
    return { tool: usable[0]!, warnings: [] };
  }
  if (task === 'restore-archive') {
    return { warnings: [], reason: 'MySQL and MariaDB native backups are SQL scripts' };
  }
  const names: readonly NativeToolName[] =
    task === 'dump' ? ['mariadb-dump', 'mysqldump'] : ['mariadb', 'mysql'];
  const candidates = tools.filter((t) => names.includes(t.name));
  if (candidates.length === 0) {
    return { warnings: [], reason: `${names.join(' or ')} was not found on this machine` };
  }
  const same = candidates.filter((t) => t.family === server.family);
  if (same.length > 0) return { tool: same[0]!, warnings: [] };
  const other = candidates[0]!;
  return {
    tool: other,
    warnings: [
      `Using ${other.name} from ${other.family === 'mariadb' ? 'MariaDB' : 'MySQL'} ${other.version} with a ${server.family === 'mariadb' ? 'MariaDB' : 'MySQL'} server; some objects may not dump or restore alike`,
    ],
  };
}
