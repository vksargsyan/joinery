import { tlsModeSchema, type TlsMode } from '@joinery/core';
import type { CompareOptions, RenameObjectKind, RenameRule, RowAction } from '@joinery/sync';
import { InvalidArgumentError } from 'commander';

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
