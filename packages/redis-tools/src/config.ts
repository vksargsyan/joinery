import {
  CONFIG_GROUPS,
  configGroupOf,
  configParameter,
  isSecretConfig,
  type ConfigGroupId,
  type ConfigParameterMeta,
} from './config-params';

/**
 * The configuration editor's model (spec §15, "CONFIG GET and SET"): CONFIG GET * of each node
 * merged into one row per parameter (aliases folded, differences between nodes kept, secrets
 * masked), values checked against the parameter metadata before they are sent, and the exact
 * CONFIG SET commands a set of changes sends.
 */

/** CONFIG GET * of one node, as the driver returns it: secret values never leave the driver. */
export interface ConfigNodeValues {
  /** "host:port". */
  readonly node: string;
  readonly role: 'primary' | 'replica';
  /** Every parameter the server listed, secret ones excepted. */
  readonly values: Readonly<Record<string, string>>;
  /** Secret parameters (requirepass, masterauth…) and whether each has a value. */
  readonly secrets: Readonly<Record<string, boolean>>;
}

/** One CONFIG SET pair. */
export interface ConfigChange {
  readonly name: string;
  readonly value: string;
}

/** Shown instead of a secret value, in rows and command previews. */
export const CONFIG_SECRET_MASK = '••••••••';

// ---------------------------------------------------------------------------------------------
// Memory values

const MEMORY_UNITS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1000,
  kb: 1024,
  m: 1000 ** 2,
  mb: 1024 ** 2,
  g: 1000 ** 3,
  gb: 1024 ** 3,
};

/**
 * Parses a memory value the way the server does: a number with an optional unit, where
 * k / m / g are powers of 1000 and kb / mb / gb powers of 1024, any case ("100mb", "1GB",
 * "4096"). Returns undefined for anything else.
 */
export function parseConfigBytes(text: string): number | undefined {
  const match = /^(-?\d+)\s*([a-z]*)$/i.exec(text.trim());
  if (!match) return undefined;
  const factor = MEMORY_UNITS[match[2]!.toLowerCase()];
  if (factor === undefined) return undefined;
  const value = Number(match[1]) * factor;
  return Number.isSafeInteger(value) ? value : undefined;
}

/** A byte count in the largest binary unit that divides it exactly: 104857600 → "100mb". */
export function formatConfigBytes(bytes: number): string {
  if (bytes === 0 || !Number.isInteger(bytes)) return String(bytes);
  for (const unit of ['gb', 'mb', 'kb'] as const) {
    const factor = MEMORY_UNITS[unit]!;
    if (bytes % factor === 0) return `${bytes / factor}${unit}`;
  }
  return String(bytes);
}

/** A byte count for people: 104857600 → "100 MB", 1536 → "1.5 KB". */
export function humanConfigBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
  return `${bytes < 0 ? '-' : ''}${text} ${units[unit]}`;
}

function duration(seconds: number): string {
  if (seconds >= 86_400 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 3600) return `${+(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 60) return `${+(seconds / 60).toFixed(1)} min`;
  return `${+seconds.toFixed(3)} s`;
}

/**
 * A value in friendlier units, when that helps: sizes in KB/MB/GB, long durations in seconds,
 * minutes or hours. Undefined when the value is already plain (small numbers, text).
 */
export function friendlyConfigValue(name: string, value: string): string | undefined {
  const meta = configParameter(name);
  if (!meta || meta.secret) return undefined;
  if (meta.type === 'bytes') {
    const bytes = parseConfigBytes(value);
    return bytes !== undefined && Math.abs(bytes) >= 1024 ? humanConfigBytes(bytes) : undefined;
  }
  if (meta.type !== 'number' || !/^-?\d+$/.test(value.trim())) return undefined;
  const n = Number(value);
  if (n <= 0) return undefined;
  switch (meta.unit) {
    case 'µs':
      return n >= 1000 ? `${+(n / 1000).toFixed(3)} ms` : undefined;
    case 'ms':
      return n >= 1000 ? duration(n / 1000) : undefined;
    case 's':
      return n >= 60 ? duration(n) : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation

export type ConfigValidation =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string };

const fail = (error: string): ConfigValidation => ({ ok: false, error });
const pass = (value: string): ConfigValidation => ({ ok: true, value });

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function checkRange(meta: ConfigParameterMeta, n: number, shown: string): ConfigValidation {
  if (meta.min !== undefined && n < meta.min) return fail(`Must be at least ${meta.min}`);
  if (meta.max !== undefined && n > meta.max) return fail(`Must be at most ${meta.max}`);
  return pass(shown);
}

/** Checks for a few parameters whose text has a structure of its own. */
const CUSTOM: Readonly<Record<string, (text: string) => ConfigValidation>> = {
  save: (text) => {
    const parts = words(text);
    if (parts.length === 0) return pass('');
    if (parts.length % 2 !== 0 || parts.some((p) => !/^\d+$/.test(p))) {
      return fail('Enter pairs of seconds and changes, e.g. "3600 1 300 100", or leave it empty');
    }
    return pass(parts.join(' '));
  },
  'client-output-buffer-limit': (text) => {
    const parts = words(text);
    if (parts.length === 0 || parts.length % 4 !== 0) {
      return fail('Enter groups of four: class hard-limit soft-limit soft-seconds');
    }
    for (let i = 0; i < parts.length; i += 4) {
      const [cls, hard, soft, seconds] = parts.slice(i, i + 4) as [string, string, string, string];
      if (!['normal', 'replica', 'slave', 'pubsub'].includes(cls.toLowerCase())) {
        return fail(`"${cls}" is not a client class (normal, replica or pubsub)`);
      }
      if (parseConfigBytes(hard) === undefined || parseConfigBytes(soft) === undefined) {
        return fail(`The limits of ${cls} must be sizes such as 256mb or 0`);
      }
      if (!/^\d+$/.test(seconds)) return fail(`The soft seconds of ${cls} must be a whole number`);
    }
    return pass(parts.join(' '));
  },
  'oom-score-adj-values': (text) => {
    const parts = words(text);
    if (parts.length !== 3 || parts.some((p) => !/^-?\d+$/.test(p) || Math.abs(Number(p)) > 2000)) {
      return fail('Enter three whole numbers from -2000 to 2000');
    }
    return pass(parts.join(' '));
  },
  'latency-tracking-info-percentiles': (text) => {
    const parts = words(text);
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isFinite(n) || n < 0 || n > 100) return fail('Enter percentiles from 0 to 100');
    }
    return pass(parts.join(' '));
  },
  'notify-keyspace-events': (text) => {
    const value = text.trim();
    if (!/^[KEg$lshzxetmdnA]*$/.test(value)) {
      return fail('Use the flag letters K, E, g, $, l, s, h, z, x, e, t, m, d, n and A');
    }
    return pass(value);
  },
};

/**
 * Checks a value typed for a parameter against its metadata and returns it normalised (booleans
 * and enums in lower case, lists single-spaced). Unknown parameters accept any text: the server
 * has the last word, and its error is shown per parameter.
 */
export function validateConfigValue(name: string, input: string): ConfigValidation {
  if (/[\r\n\0]/.test(input)) return fail('The value cannot contain line breaks');
  const meta = configParameter(name);
  const custom = CUSTOM[meta?.name ?? name];
  if (custom) return custom(input);
  if (!meta || meta.secret) return pass(input);
  const text = input.trim();
  switch (meta.type) {
    case 'boolean': {
      const lower = text.toLowerCase();
      return lower === 'yes' || lower === 'no' ? pass(lower) : fail('Must be yes or no');
    }
    case 'enum': {
      const lower = text.toLowerCase();
      const values = meta.values ?? [];
      return values.includes(lower) ? pass(lower) : fail(`Must be one of ${values.join(', ')}`);
    }
    case 'number': {
      if (!/^-?\d+$/.test(text)) return fail('Must be a whole number');
      return checkRange(meta, Number(text), text);
    }
    case 'bytes': {
      if (meta.percent && /^\d+%$/.test(text)) return pass(text);
      const bytes = parseConfigBytes(text);
      if (bytes === undefined) {
        return fail(
          `Must be a size such as 1048576, 512kb, 100mb or 2gb${meta.percent ? ', or a percentage' : ''}`,
        );
      }
      return checkRange(meta, bytes, text.toLowerCase().replace(/\s+/g, ''));
    }
    case 'list': {
      const parts = words(text);
      const allowed = meta.values;
      if (allowed) {
        const lowerAllowed = allowed.map((v) => v.toLowerCase());
        const bad = parts.find((p) => !lowerAllowed.includes(p.toLowerCase()));
        if (bad !== undefined) return fail(`"${bad}" is not one of ${allowed.join(', ')}`);
      }
      return pass(parts.join(' '));
    }
    case 'string':
      return pass(input);
  }
}

/**
 * Whether two values of a parameter mean the same: sizes by their byte count ("64mb" and
 * "67108864"), numbers by value, yes/no and enums in any case, lists by their words.
 */
export function sameConfigValue(name: string, a: string, b: string): boolean {
  if (a === b) return true;
  const meta = configParameter(name);
  if (!meta || meta.secret) return false;
  switch (meta.type) {
    case 'bytes': {
      const x = parseConfigBytes(a);
      return x !== undefined && x === parseConfigBytes(b);
    }
    case 'number':
      return a.trim() !== '' && b.trim() !== '' && Number(a) === Number(b);
    case 'boolean':
    case 'enum':
      return a.trim().toLowerCase() === b.trim().toLowerCase();
    case 'list':
      return words(a).join(' ').toLowerCase() === words(b).join(' ').toLowerCase();
    case 'string':
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Rows

/** One parameter across the nodes read, as the editor lists it. */
export interface ConfigRow {
  /** The name the server uses (the canonical one when it lists aliases too). */
  readonly name: string;
  readonly meta: ConfigParameterMeta | undefined;
  readonly group: ConfigGroupId;
  readonly secret: boolean;
  /** The value when every node has the same; undefined when they differ. */
  readonly value: string | undefined;
  /** Each node's value (secrets: the mask, or "" when unset), in node order. */
  readonly byNode: readonly { readonly node: string; readonly value: string }[];
  /** The nodes do not all have the same value. */
  readonly differs: boolean;
  /** Secret parameters: whether every node has one set. */
  readonly secretSet: boolean;
  /** Whether the value is the known default; undefined without a known default (or differing). */
  readonly isDefault: boolean | undefined;
  /** Other names the server listed for it (folded into this row). */
  readonly aliases: readonly string[];
}

const GROUP_ORDER: ReadonlyMap<ConfigGroupId, number> = new Map(
  CONFIG_GROUPS.map((g, i) => [g.id, i]),
);

/**
 * Merges the nodes' CONFIG GET * into rows, one per parameter: names a server lists twice
 * (an alias beside its canonical name) are folded into the canonical one, values that differ
 * between nodes are kept per node, and secrets show only whether they are set. Sorted by group,
 * then name.
 */
export function buildConfigRows(nodes: readonly ConfigNodeValues[]): ConfigRow[] {
  const names = new Set<string>();
  for (const node of nodes) {
    for (const name of Object.keys(node.values)) names.add(name);
    for (const name of Object.keys(node.secrets)) names.add(name);
  }
  // Fold aliases: keep the canonical name when the server lists it, else the first alias seen.
  const chosen = new Map<string, { name: string; aliases: string[] }>();
  for (const name of [...names].sort()) {
    const meta = configParameter(name);
    const key = meta?.name ?? name;
    const entry = chosen.get(key);
    if (!entry) chosen.set(key, { name, aliases: [] });
    else if (name === key) chosen.set(key, { name, aliases: [...entry.aliases, entry.name] });
    else entry.aliases.push(name);
  }
  const rows: ConfigRow[] = [];
  for (const { name, aliases } of chosen.values()) {
    const meta = configParameter(name);
    const secret = isSecretConfig(name);
    const known = [name, ...aliases];
    const byNode = nodes.flatMap((n) => {
      if (secret) {
        const set = known.map((k) => n.secrets[k]).find((s) => s !== undefined);
        return set === undefined ? [] : [{ node: n.node, value: set ? CONFIG_SECRET_MASK : '' }];
      }
      const value = known.map((k) => n.values[k]).find((v) => v !== undefined);
      return value === undefined ? [] : [{ node: n.node, value }];
    });
    const first = byNode[0]?.value ?? '';
    const differs =
      byNode.length !== nodes.length || byNode.some((n) => !sameConfigValue(name, n.value, first));
    const value = differs ? undefined : first;
    rows.push({
      name,
      meta,
      group: configGroupOf(name),
      secret,
      value,
      byNode,
      differs,
      secretSet: secret && byNode.length > 0 && byNode.every((n) => n.value !== ''),
      isDefault:
        value === undefined || meta?.default === undefined || secret
          ? undefined
          : sameConfigValue(name, value, meta.default),
      aliases,
    });
  }
  return rows.sort(
    (a, b) =>
      (GROUP_ORDER.get(a.group) ?? 99) - (GROUP_ORDER.get(b.group) ?? 99) ||
      a.name.localeCompare(b.name),
  );
}

/** Rows whose name, description or value contains every word of the search (any case). */
export function filterConfigRows(rows: readonly ConfigRow[], search: string): ConfigRow[] {
  const terms = words(search.toLowerCase());
  if (terms.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = [
      row.name,
      ...row.aliases,
      row.meta?.description ?? '',
      row.secret ? '' : (row.value ?? row.byNode.map((n) => n.value).join(' ')),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

// ---------------------------------------------------------------------------------------------
// Commands

/**
 * The CONFIG SET commands that apply `changes`: one command with every pair when the server
 * takes several at once (Redis 7+ and Valkey: all or nothing), else one per parameter. With
 * `mask`, secret values are replaced by the mask, for previews and confirmations.
 */
export function configSetCommands(
  changes: readonly ConfigChange[],
  options: { readonly multi: boolean; readonly mask?: boolean },
): string[][] {
  const pair = (c: ConfigChange): string[] => [
    c.name,
    options.mask && isSecretConfig(c.name) ? CONFIG_SECRET_MASK : c.value,
  ];
  if (changes.length === 0) return [];
  if (options.multi) return [['CONFIG', 'SET', ...changes.flatMap(pair)]];
  return changes.map((c) => ['CONFIG', 'SET', ...pair(c)]);
}

/**
 * The parameter a CONFIG SET error names: "(possibly related to argument 'x')" and
 * "CONFIG SET - 'x'" on Redis 7+ and Valkey, "for CONFIG SET 'x'" and "Unsupported CONFIG
 * parameter: x" before. Undefined when the message names none.
 */
export function configErrorParameter(message: string): string | undefined {
  const match =
    /possibly related to argument '([^']+)'/.exec(message) ??
    /CONFIG SET - '([^']+)'/.exec(message) ??
    /CONFIG SET '([^']+)'/.exec(message) ??
    /Unsupported CONFIG parameter: (\S+)/.exec(message);
  return match?.[1];
}
