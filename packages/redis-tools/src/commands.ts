import {
  replyItems,
  replyNumber,
  replyPairs,
  replyRecord,
  replyText,
  type RedisReply,
} from './reply';

/**
 * Command metadata for the CLI's autocomplete and inline docs, from `COMMAND DOCS` (Redis 7+:
 * summaries, argument trees, history) merged with `COMMAND INFO` (arity, flags, ACL categories,
 * key positions; on Redis 6.2 the only source, so commands have no argument tree there).
 */

export const ARGUMENT_TYPES = [
  'string',
  'integer',
  'double',
  'key',
  'pattern',
  'unix-time',
  'pure-token',
  'oneof',
  'block',
] as const;
export type ArgumentType = (typeof ARGUMENT_TYPES)[number];

export interface CommandArgument {
  readonly name: string;
  /** One of ARGUMENT_TYPES, or whatever a newer server reports. */
  readonly type: string;
  /** The keyword that introduces the argument (or is the whole argument for `pure-token`). */
  readonly token?: string;
  /** How to show the value placeholder (Redis 7.2+); the name otherwise. */
  readonly displayText?: string;
  readonly summary?: string;
  readonly since?: string;
  readonly deprecatedSince?: string;
  readonly keySpecIndex?: number;
  readonly optional: boolean;
  /** The argument repeats (one or more times; zero or more when also optional). */
  readonly multiple: boolean;
  /** Each repetition repeats the token too (`GET pattern [GET pattern ...]`). */
  readonly multipleToken: boolean;
  /** Alternatives of a `oneof`, members of a `block`. */
  readonly arguments: readonly CommandArgument[];
}

export interface CommandKeySpec {
  readonly flags: readonly string[];
  /** The raw begin_search / find_keys specs, as name → value text. */
  readonly beginSearch: Readonly<Record<string, string>>;
  readonly findKeys: Readonly<Record<string, string>>;
}

export interface CommandDoc {
  /** Upper case; subcommands are "CONTAINER SUB", e.g. "CONFIG GET". */
  readonly name: string;
  /** The container command's name for a subcommand. */
  readonly container?: string;
  readonly summary?: string;
  readonly since?: string;
  readonly group?: string;
  readonly complexity?: string;
  readonly deprecatedSince?: string;
  readonly replacedBy?: string;
  /** COMMAND DOCS doc_flags, e.g. "deprecated", "syscmd". */
  readonly docFlags: readonly string[];
  readonly history: readonly { readonly version: string; readonly description: string }[];
  readonly arguments: readonly CommandArgument[];
  readonly subcommands: readonly CommandDoc[];
  /** COMMAND INFO arity: N means exactly N words, -N at least N (the name counts). */
  readonly arity?: number;
  /** COMMAND INFO flags, lower case: write, readonly, denyoom, admin, blocking, fast... */
  readonly flags: readonly string[];
  /** ACL categories without the "@", e.g. "keyspace", "dangerous". */
  readonly aclCategories: readonly string[];
  /** Command tips (Redis 7+), e.g. "request_policy:all_shards". */
  readonly tips: readonly string[];
  /** Legacy key positions: first, last (negative counts from the end) and step; 0 = no keys. */
  readonly keys?: { readonly first: number; readonly last: number; readonly step: number };
  readonly keySpecs: readonly CommandKeySpec[];
  readonly write: boolean;
  readonly readOnly: boolean;
  /** Can block the connection (flag "blocking" on 7+, category "@blocking" on 6.2). */
  readonly blocking: boolean;
  /** In the "@dangerous" ACL category. */
  readonly dangerous: boolean;
  readonly admin: boolean;
}

export interface CommandCatalog {
  /** Top-level commands by upper-case name; subcommands hang off their container. */
  readonly commands: Readonly<Record<string, CommandDoc>>;
  /** What the catalog was built from: docs + info (Redis 7+) or info only (6.2). */
  readonly source: 'docs' | 'info';
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function textList(reply: RedisReply | undefined): string[] {
  return (replyItems(reply) ?? [])
    .map((r) => replyText(r))
    .filter((s): s is string => s !== undefined);
}

function parseArgument(reply: RedisReply): CommandArgument {
  const f = replyRecord(reply);
  const flags = textList(f['flags']).map((s) => s.toLowerCase());
  const arg: Mutable<CommandArgument> = {
    name: replyText(f['name']) ?? '',
    type: (replyText(f['type']) ?? 'string').toLowerCase(),
    optional: flags.includes('optional'),
    multiple: flags.includes('multiple'),
    multipleToken: flags.includes('multiple_token'),
    arguments: (replyItems(f['arguments']) ?? []).map(parseArgument),
  };
  const token = replyText(f['token']);
  if (token !== undefined) arg.token = token;
  const display = replyText(f['display_text']) ?? replyText(f['value']);
  if (display !== undefined) arg.displayText = display;
  const summary = replyText(f['summary']);
  if (summary !== undefined) arg.summary = summary;
  const since = replyText(f['since']);
  if (since !== undefined) arg.since = since;
  const deprecated = replyText(f['deprecated_since']);
  if (deprecated !== undefined) arg.deprecatedSince = deprecated;
  const keySpec = replyNumber(f['key_spec_index']);
  if (keySpec !== undefined) arg.keySpecIndex = keySpec;
  return arg;
}

function emptyDoc(name: string, container?: string): Mutable<CommandDoc> {
  return {
    name,
    ...(container !== undefined ? { container } : {}),
    docFlags: [],
    history: [],
    arguments: [],
    subcommands: [],
    flags: [],
    aclCategories: [],
    tips: [],
    keySpecs: [],
    write: false,
    readOnly: false,
    blocking: false,
    dangerous: false,
    admin: false,
  };
}

/** "config|get" → "CONFIG GET". */
function commandName(raw: string): string {
  return raw.replace(/\|/g, ' ').toUpperCase();
}

function parseDocEntry(rawName: string, reply: RedisReply, container?: string): CommandDoc {
  const f = replyRecord(reply);
  const doc = emptyDoc(commandName(rawName), container);
  const summary = replyText(f['summary']);
  if (summary !== undefined) doc.summary = summary;
  const since = replyText(f['since']);
  if (since !== undefined) doc.since = since;
  const group = replyText(f['group']);
  if (group !== undefined) doc.group = group;
  const complexity = replyText(f['complexity']);
  if (complexity !== undefined) doc.complexity = complexity;
  const deprecated = replyText(f['deprecated_since']);
  if (deprecated !== undefined) doc.deprecatedSince = deprecated;
  const replacedBy = replyText(f['replaced_by']);
  if (replacedBy !== undefined) doc.replacedBy = replacedBy;
  doc.docFlags = textList(f['doc_flags']).map((s) => s.toLowerCase());
  doc.history = (replyItems(f['history']) ?? []).map((entry) => {
    const [version, description] = textList(entry);
    return { version: version ?? '', description: description ?? '' };
  });
  doc.arguments = (replyItems(f['arguments']) ?? []).map(parseArgument);
  doc.subcommands = (replyPairs(f['subcommands']) ?? [])
    .map(([k, v]) => {
      const sub = replyText(k);
      return sub === undefined ? undefined : parseDocEntry(sub, v, doc.name);
    })
    .filter((d): d is CommandDoc => d !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  return doc;
}

/** Parses a `COMMAND DOCS` reply (RESP2 flat map or RESP3 map) into command docs. */
export function parseCommandDocs(reply: RedisReply): CommandDoc[] {
  return (replyPairs(reply) ?? [])
    .map(([k, v]) => {
      const name = replyText(k);
      return name === undefined ? undefined : parseDocEntry(name, v);
    })
    .filter((d): d is CommandDoc => d !== undefined);
}

function withDerivedFlags(doc: Mutable<CommandDoc>): CommandDoc {
  doc.write = doc.flags.includes('write');
  doc.readOnly = doc.flags.includes('readonly');
  doc.blocking = doc.flags.includes('blocking') || doc.aclCategories.includes('blocking');
  doc.dangerous = doc.aclCategories.includes('dangerous');
  doc.admin = doc.flags.includes('admin') || doc.aclCategories.includes('admin');
  return doc;
}

function parseKeySpec(reply: RedisReply): CommandKeySpec {
  const f = replyRecord(reply);
  // { type: "index", spec: { index: 1 } } → { type: "index", index: "1" }
  const spec = (r: RedisReply | undefined): Record<string, string> => {
    const inner = replyRecord(r);
    const out: Record<string, string> = {};
    const type = replyText(inner['type']);
    if (type !== undefined) out['type'] = type;
    for (const [k, v] of Object.entries(replyRecord(inner['spec']))) {
      const text = replyText(v);
      if (text !== undefined) out[k] = text;
    }
    return out;
  };
  return {
    flags: textList(f['flags']).map((s) => s.toLowerCase()),
    beginSearch: spec(f['begin_search']),
    findKeys: spec(f['find_keys']),
  };
}

function parseInfoEntry(reply: RedisReply, container?: string): CommandDoc | undefined {
  const items = replyItems(reply);
  if (!items || items.length < 6) return undefined;
  const rawName = replyText(items[0]);
  if (rawName === undefined) return undefined;
  const doc = emptyDoc(commandName(rawName), container);
  const arity = replyNumber(items[1]);
  if (arity !== undefined) doc.arity = arity;
  doc.flags = textList(items[2]).map((s) => s.toLowerCase());
  const first = replyNumber(items[3]) ?? 0;
  const last = replyNumber(items[4]) ?? 0;
  const step = replyNumber(items[5]) ?? 0;
  doc.keys = { first, last, step };
  doc.aclCategories = textList(items[6]).map((s) => s.replace(/^@/, '').toLowerCase());
  doc.tips = textList(items[7]);
  doc.keySpecs = (replyItems(items[8]) ?? []).map(parseKeySpec);
  doc.subcommands = (replyItems(items[9]) ?? [])
    .map((sub) => parseInfoEntry(sub, doc.name))
    .filter((d): d is CommandDoc => d !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  return withDerivedFlags(doc);
}

/**
 * Parses a `COMMAND INFO` / `COMMAND` reply: 7 fields per command on Redis 6.2, 10 on 7+
 * (tips, key specs, subcommands). Unknown commands (nil entries) are skipped.
 */
export function parseCommandInfo(reply: RedisReply): CommandDoc[] {
  return (replyItems(reply) ?? [])
    .map((entry) => parseInfoEntry(entry))
    .filter((d): d is CommandDoc => d !== undefined);
}

function merge(docs: CommandDoc | undefined, info: CommandDoc | undefined): CommandDoc {
  const base = docs ?? info!;
  const merged: Mutable<CommandDoc> = { ...base };
  if (info) {
    if (info.arity !== undefined) merged.arity = info.arity;
    merged.flags = info.flags;
    merged.aclCategories = info.aclCategories;
    merged.tips = info.tips;
    if (info.keys) merged.keys = info.keys;
    merged.keySpecs = info.keySpecs;
  }
  const subs = new Map<string, [CommandDoc | undefined, CommandDoc | undefined]>();
  for (const sub of docs?.subcommands ?? []) subs.set(sub.name, [sub, undefined]);
  for (const sub of info?.subcommands ?? []) subs.set(sub.name, [subs.get(sub.name)?.[0], sub]);
  merged.subcommands = [...subs.values()]
    .map(([d, i]) => merge(d, i))
    .sort((a, b) => a.name.localeCompare(b.name));
  return withDerivedFlags(merged);
}

/**
 * Builds the catalog from a `COMMAND DOCS` reply and/or a `COMMAND INFO` reply. Either may be
 * missing (6.2 has no COMMAND DOCS; an ACL user may be denied one of them).
 */
export function buildCommandCatalog(input: {
  readonly docs?: RedisReply;
  readonly info?: RedisReply;
}): CommandCatalog {
  const docs = new Map(parseCommandDocs(input.docs ?? { type: 'nil' }).map((d) => [d.name, d]));
  const info = new Map(parseCommandInfo(input.info ?? { type: 'nil' }).map((d) => [d.name, d]));
  const commands: Record<string, CommandDoc> = {};
  for (const name of [...new Set([...docs.keys(), ...info.keys()])].sort()) {
    commands[name] = merge(docs.get(name), info.get(name));
  }
  return { commands, source: docs.size > 0 ? 'docs' : 'info' };
}

/**
 * The command (or subcommand) the words start with, and how many words name it: `["config",
 * "get", "maxmemory"]` → CONFIG GET, 2. Undefined for an unknown command.
 */
export function lookupCommand(
  catalog: CommandCatalog,
  words: readonly string[],
): { readonly doc: CommandDoc; readonly consumed: number } | undefined {
  const first = words[0];
  if (first === undefined) return undefined;
  const doc = catalog.commands[first.toUpperCase()];
  if (!doc) return undefined;
  const second = words[1];
  if (second !== undefined && doc.subcommands.length > 0) {
    const sub = doc.subcommands.find((s) => s.name === `${doc.name} ${second.toUpperCase()}`);
    if (sub) return { doc: sub, consumed: 2 };
  }
  return { doc, consumed: 1 };
}

function argumentSyntax(arg: CommandArgument): string {
  let body: string;
  const placeholder = arg.displayText ?? arg.name;
  switch (arg.type) {
    case 'pure-token':
      body = arg.token ?? arg.name;
      break;
    case 'oneof':
      body = arg.arguments.map(argumentSyntax).join(' | ');
      if (arg.token) body = `${arg.token} ${arg.optional ? body : `<${body}>`}`;
      break;
    case 'block':
      body = arg.arguments.map(argumentSyntax).join(' ');
      if (arg.token) body = `${arg.token} ${body}`;
      break;
    default:
      body = arg.token ? `${arg.token} ${placeholder}` : placeholder;
  }
  if (arg.multiple) {
    const repeat = arg.multipleToken || !arg.token ? body : body.slice(arg.token.length + 1);
    body = `${body} [${repeat} ...]`;
  }
  if (arg.optional) return `[${body}]`;
  if (arg.type === 'oneof' && !arg.token) return `<${body}>`;
  return body;
}

/**
 * The syntax line shown as inline docs, in the style of the Redis documentation:
 * `SET key value [NX | XX] [GET] [EX seconds | PX milliseconds | ...]`.
 */
export function commandSyntax(doc: CommandDoc): string {
  return [doc.name, ...doc.arguments.map(argumentSyntax)].join(' ');
}
