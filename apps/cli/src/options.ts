import { tlsModeSchema, type TlsMode } from '@querybara/core';
import type { CompareOptions, RenameObjectKind, RenameRule, RowAction } from '@querybara/sync';
import { InvalidArgumentError } from 'commander';

import type { ProxyFlag, SshHopFlag } from './tunnels';

/**
 * Parsers for option values. Each throws commander's InvalidArgumentError, which prints as
 * `error: option '--x <v>' argument 'y' is invalid. <reason>` and exits 2.
 */

/** Collects a repeatable option into an array. */
export function collect<T>(parse: (value: string) => T) {
  return (value: string, previous: readonly T[] | undefined): T[] => [
    ...(previous ?? []),
    parse(value),
  ];
}

export function nonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new InvalidArgumentError('Expected a whole number.');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new InvalidArgumentError('The number is too large.');
  return n;
}

export function positiveInteger(value: string): number {
  const n = nonNegativeInteger(value);
  if (n === 0) throw new InvalidArgumentError('Expected a number greater than 0.');
  return n;
}

export function nonNegativeNumber(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError('Expected a non-negative number.');
  }
  return n;
}

export function tlsMode(value: string): TlsMode {
  const parsed = tlsModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(`Use one of: ${tlsModeSchema.options.join(', ')}.`);
  }
  return parsed.data;
}

/** A comma-separated list, trimmed, without empty items; repeated options accumulate. */
export function list(value: string, previous?: readonly string[]): string[] {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) throw new InvalidArgumentError('Expected a comma-separated list.');
  return [...(previous ?? []), ...items];
}

/** `--param name=value`: the value is passed as text; the server casts it. */
export function param(value: string): readonly [string, string] {
  const equals = value.indexOf('=');
  if (equals <= 0) throw new InvalidArgumentError('Use name=value (e.g. id=42 or 1=42).');
  let name = value.slice(0, equals).trim();
  if (name.startsWith(':') || name.startsWith('$')) name = name.slice(1);
  if (name === '') throw new InvalidArgumentError('The parameter name is empty.');
  return [name, value.slice(equals + 1)];
}

/** Structure compare ignore options (spec §13) by their command-line names. */
export const IGNORE_OPTIONS = {
  comments: 'ignoreComments',
  collation: 'ignoreCollation',
  'auto-increment': 'ignoreAutoIncrement',
  definer: 'ignoreDefiner',
  ownership: 'ignoreOwnership',
  privileges: 'ignorePrivileges',
  partitions: 'ignorePartitions',
  'column-order': 'ignoreColumnOrder',
  'name-case': 'ignoreNameCase',
  names: 'ignoreNames',
  'extension-versions': 'ignoreExtensionVersions',
} as const satisfies Readonly<Record<string, keyof CompareOptions>>;
export type IgnoreName = keyof typeof IGNORE_OPTIONS;

/** Ignored by the sync engine unless turned off (DEFAULT_COMPARE_OPTIONS). */
export const DEFAULT_IGNORES: readonly IgnoreName[] = [
  'auto-increment',
  'definer',
  'ownership',
  'privileges',
];

export function ignoreList(value: string, previous?: readonly IgnoreName[]): IgnoreName[] {
  const names = list(value);
  const unknown = names.filter((name) => !Object.hasOwn(IGNORE_OPTIONS, name));
  if (unknown.length > 0) {
    throw new InvalidArgumentError(
      `Unknown: ${unknown.join(', ')}. Use: ${Object.keys(IGNORE_OPTIONS).join(', ')}.`,
    );
  }
  return [...(previous ?? []), ...(names as IgnoreName[])];
}

/**
 * The CompareOptions flags for a set of ignores. With `defaults`, the sync engine's default
 * ignores stay on; without, only the listed ones apply.
 */
export function compareFlags(
  ignores: readonly IgnoreName[],
  defaults: boolean,
): Pick<CompareOptions, (typeof IGNORE_OPTIONS)[IgnoreName]> {
  const on = new Set<IgnoreName>([...(defaults ? DEFAULT_IGNORES : []), ...ignores]);
  const flags: Record<string, boolean> = {};
  for (const [name, key] of Object.entries(IGNORE_OPTIONS)) flags[key] = on.has(name as IgnoreName);
  return flags;
}

const RENAME_KINDS: readonly RenameObjectKind[] = [
  'table',
  'column',
  'index',
  'constraint',
  'view',
];

/**
 * `--rename <kind>:<from>=<to>`: the target's object `from` is the source's `to`, so it is
 * renamed instead of dropped and recreated. Tables and views: `table:[schema.]old=new`;
 * columns, indexes and constraints name their table: `column:[schema.]table.old=new`.
 */
export function renameRule(value: string): RenameRule {
  const colon = value.indexOf(':');
  const equals = value.lastIndexOf('=');
  const kind = value.slice(0, colon).trim() as RenameObjectKind;
  if (colon <= 0 || !RENAME_KINDS.includes(kind)) {
    throw new InvalidArgumentError(`Start with one of ${RENAME_KINDS.join(', ')} and a colon.`);
  }
  if (equals <= colon) throw new InvalidArgumentError('Use <kind>:<from>=<to>.');
  const path = value
    .slice(colon + 1, equals)
    .split('.')
    .map((part) => part.trim());
  const to = value.slice(equals + 1).trim();
  if (to === '' || path.some((part) => part === '')) {
    throw new InvalidArgumentError('Names must not be empty.');
  }
  const qualified = kind === 'table' || kind === 'view';
  const max = qualified ? 2 : 3;
  const min = qualified ? 1 : 2;
  if (path.length < min || path.length > max) {
    throw new InvalidArgumentError(
      qualified
        ? `Use ${kind}:[schema.]old=new.`
        : `Use ${kind}:[schema.]table.old=new (the table is required).`,
    );
  }
  const from = path[path.length - 1]!;
  const table = qualified ? undefined : path[path.length - 2];
  const schema = path.length === max ? path[0] : undefined;
  return {
    objectKind: kind,
    from,
    to,
    ...(schema !== undefined ? { schema } : {}),
    ...(table !== undefined ? { table } : {}),
  };
}

export const ROW_ACTIONS: readonly RowAction[] = ['insert', 'update', 'delete'];

export function actionList(value: string): RowAction[] {
  const names = list(value);
  const unknown = names.filter((name) => !(ROW_ACTIONS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new InvalidArgumentError(
      `Unknown: ${unknown.join(', ')}. Use: ${ROW_ACTIONS.join(', ')}.`,
    );
  }
  return [...new Set(names as RowAction[])];
}

function port(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** `--ssh user@host[:port]` (port 22 by default; an IPv6 host goes in brackets). */
export function sshHop(value: string): SshHopFlag {
  const match = /^([^@\s]+)@(\[[0-9A-Fa-f:.]+\]|[^:@\s[\]]+)(?::([^:]*))?$/.exec(value.trim());
  if (!match) throw new InvalidArgumentError('Use user@host or user@host:port.');
  const parsed = match[3] === undefined ? 22 : port(match[3]);
  if (parsed === undefined) throw new InvalidArgumentError('The port must be 1 to 65535.');
  return { user: match[1]!, host: match[2]!.replace(/^\[(.*)\]$/, '$1'), port: parsed };
}

const PROXY_KINDS: Readonly<Record<string, ProxyFlag['kind']>> = {
  'socks5:': 'socks5',
  'socks5h:': 'socks5',
  'socks:': 'socks5',
  'http:': 'http',
};

/**
 * `--proxy socks5://host:port` or `http://host:port` (an HTTP CONNECT proxy), optionally with
 * `user[:password]@`. The port defaults to 1080 for SOCKS5 and 80 for HTTP.
 */
export function proxyUrl(value: string): ProxyFlag {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidArgumentError('Use socks5://host:port or http://host:port.');
  }
  const kind = PROXY_KINDS[url.protocol];
  if (kind === undefined) throw new InvalidArgumentError('Use a socks5:// or http:// proxy URL.');
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new InvalidArgumentError('A proxy URL has no path.');
  }
  const host = decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1'));
  if (host === '') throw new InvalidArgumentError('The proxy URL needs a host.');
  const user = url.username === '' ? undefined : decodeURIComponent(url.username);
  const password = url.password === '' ? undefined : decodeURIComponent(url.password);
  return {
    kind,
    host,
    port: url.port === '' ? (kind === 'socks5' ? 1080 : 80) : Number(url.port),
    ...(user !== undefined ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** `--map file=column`: a file column and the table column it fills. */
export function columnMap(value: string): readonly [string, string] {
  const equals = value.indexOf('=');
  const source = value.slice(0, Math.max(equals, 0)).trim();
  const target = value.slice(equals + 1).trim();
  if (equals <= 0 || source === '' || target === '') {
    throw new InvalidArgumentError('Use file_column=table_column (e.g. "Full Name=name").');
  }
  return [source, target];
}

const DELIMITER_NAMES: Readonly<Record<string, string>> = {
  tab: '\t',
  '\\t': '\t',
  comma: ',',
  semicolon: ';',
  pipe: '|',
  space: ' ',
};

/** `--delimiter`: one character, or tab, comma, semicolon, pipe, space (`\\t` is a tab too). */
export function delimiter(value: string): string {
  const named = DELIMITER_NAMES[value.toLowerCase()];
  if (named !== undefined) return named;
  if (value.length !== 1) {
    throw new InvalidArgumentError('Use one character, or tab, comma, semicolon, pipe or space.');
  }
  return value;
}
