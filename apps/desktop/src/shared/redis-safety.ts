import { requiresWriteConfirmation, type ConnectionProfile } from '@joinery/core';
import {
  configParameter,
  lookupCommand,
  quoteRepr,
  toBytes,
  tryUtf8,
  type CommandCatalog,
  type RedisBytes,
} from '@joinery/redis-tools';

/**
 * The write rules for Redis (spec §4, §10, §15), shared by the connection host (which enforces
 * them whatever the page sends) and the page (which asks before it sends): a read-only profile
 * refuses every write; destructive operations ask on every profile; every write asks on
 * production profiles and profiles that confirm writes.
 */

export interface RedisWritePolicy {
  /** Locked read-only: every write is refused. */
  readonly readOnly: boolean;
  /** Production, or "confirm every write": each write asks first. */
  readonly confirmWrites: boolean;
}

export function redisWritePolicy(profile: ConnectionProfile): RedisWritePolicy {
  return {
    readOnly: profile.presentation.readOnly,
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

/** What an operation does, for the rules: a write, possibly destructive (and why). */
export interface RedisOperation {
  readonly write: boolean;
  /** Why the operation is destructive ("deletes keys"); undefined when it is not. */
  readonly destructive?: string;
  /** Set when a read-only profile must refuse it for another reason (an unknown command). */
  readonly unknown?: boolean;
}

export type RedisSafetyDecision =
  | { readonly action: 'run' }
  | {
      readonly action: 'confirm';
      readonly destructive: boolean;
      /** What the confirmation says the operation does. */
      readonly reason: string;
    }
  | { readonly action: 'refuse'; readonly reason: string };

export const READ: RedisOperation = { write: false };
export const WRITE: RedisOperation = { write: true };

export function destructive(reason: string): RedisOperation {
  return { write: true, destructive: reason };
}

/** What to do before running an operation under a profile's policy. */
export function decideRedisSafety(
  operation: RedisOperation,
  policy: RedisWritePolicy,
): RedisSafetyDecision {
  if (policy.readOnly && (operation.write || operation.unknown)) {
    return {
      action: 'refuse',
      reason: operation.write
        ? 'This connection is read-only, so writes are refused'
        : 'This connection is read-only, and Joinery cannot tell whether this command writes',
    };
  }
  if (operation.destructive !== undefined) {
    return { action: 'confirm', destructive: true, reason: operation.destructive };
  }
  if (operation.write && policy.confirmWrites) {
    return {
      action: 'confirm',
      destructive: false,
      reason: 'This connection confirms every write',
    };
  }
  return { action: 'run' };
}

/**
 * CONFIG SET of these parameters: a write (so production and confirm-writes profiles ask, and
 * read-only profiles refuse), and destructive when one of them can lock clients out or move the
 * data files (requirepass, bind, port, dir…), so every profile asks first.
 */
export function configSetOperation(names: readonly string[]): RedisOperation {
  const reasons = [
    ...new Set(
      names
        .map((name) => configParameter(name)?.disruptive)
        .filter((reason): reason is string => reason !== undefined),
    ),
  ];
  return reasons.length === 0 ? WRITE : destructive(reasons.join(' and '));
}

const REWRITES_CONFIG = 'rewrites the configuration file on disk';
const RESETS_STATS = 'resets the server statistics (INFO counters, command and latency stats)';

/** CONFIG REWRITE: destructive on every profile. */
export const CONFIG_REWRITE: RedisOperation = destructive(REWRITES_CONFIG);

/** CONFIG RESETSTAT: destructive on every profile. */
export const CONFIG_RESETSTAT: RedisOperation = destructive(RESETS_STATS);

/**
 * Commands that are destructive whatever the catalog says, by upper-case name (a container's
 * subcommand as "CONTAINER SUB"), with what the confirmation says about them.
 */
const DESTRUCTIVE: Readonly<Record<string, string>> = {
  FLUSHALL: 'deletes every key of every database',
  FLUSHDB: 'deletes every key of the database',
  DEL: 'deletes keys',
  UNLINK: 'deletes keys',
  GETDEL: 'deletes the key',
  RENAME: 'replaces the destination key if it exists',
  SWAPDB: 'swaps two databases',
  MIGRATE: 'moves keys to another server',
  SHUTDOWN: 'stops the server',
  DEBUG: 'runs a debugging command that can crash or stall the server',
  REPLICAOF: 'changes replication',
  SLAVEOF: 'changes replication',
  FAILOVER: 'changes replication',
  'CLIENT KILL': 'disconnects clients',
  'CLIENT PAUSE': 'pauses every client',
  'ACL SETUSER': 'changes access control',
  'ACL DELUSER': 'changes access control',
  'ACL LOAD': 'changes access control',
  'CONFIG REWRITE': REWRITES_CONFIG,
  'CONFIG RESETSTAT': RESETS_STATS,
  'SCRIPT FLUSH': 'removes every cached script',
  'FUNCTION FLUSH': 'removes every function library',
  'FUNCTION DELETE': 'removes a function library',
  'FUNCTION RESTORE': 'replaces function libraries',
  'SLOWLOG RESET': 'clears the slow log',
  'LATENCY RESET': 'clears the latency history',
  'XGROUP DESTROY': 'removes a consumer group',
  'MODULE UNLOAD': 'unloads a module',
  'CLUSTER RESET': 'changes the cluster topology',
  'CLUSTER FAILOVER': 'changes the cluster topology',
  'CLUSTER FORGET': 'changes the cluster topology',
  'CLUSTER DELSLOTS': 'changes the cluster topology',
  'CLUSTER DELSLOTSRANGE': 'changes the cluster topology',
  'CLUSTER SETSLOT': 'changes the cluster topology',
  'CLUSTER FLUSHSLOTS': 'changes the cluster topology',
  'CLUSTER REPLICATE': 'changes the cluster topology',
};

/** Writes that the catalog flags do not show (admin commands that change server state). */
const WRITES = new Set([
  'PUBLISH',
  'SPUBLISH',
  'SCRIPT LOAD',
  'FUNCTION LOAD',
  'SAVE',
  'BGSAVE',
  'BGREWRITEAOF',
  'ACL SAVE',
  'ACL LOG',
  'CLIENT SETNAME',
  'CLUSTER MEET',
  'CLUSTER ADDSLOTS',
  'CLUSTER ADDSLOTSRANGE',
  'MODULE LOAD',
  'MODULE LOADEX',
  'LATENCY RESET',
]);

/** Commands with REPLACE that overwrite an existing key when given it. */
const REPLACING = new Set(['COPY', 'RESTORE']);

/**
 * Classifies one CLI command (its words) for the write rules. The catalog's flags decide what
 * writes ("write", or "may_replicate" for scripts and PUBLISH); a few admin commands and every
 * destructive command are listed here. Without a catalog, anything not known to be a read is a
 * write; with one, an unknown command is `unknown` (refused on read-only profiles).
 */
export function classifyRedisCommand(
  words: readonly string[],
  catalog: CommandCatalog | undefined,
): RedisOperation {
  const name = (words[0] ?? '').toUpperCase();
  const sub = (words[1] ?? '').toUpperCase();
  const full = sub === '' ? name : `${name} ${sub}`;
  if (full === 'CONFIG SET')
    return configSetOperation(words.slice(2).filter((_, i) => i % 2 === 0));
  const reason = DESTRUCTIVE[full] ?? DESTRUCTIVE[name];
  if (reason !== undefined) return destructive(reason);
  if (REPLACING.has(name) && words.some((w, i) => i > 2 && w.toUpperCase() === 'REPLACE')) {
    return destructive('replaces the destination key if it exists');
  }
  if (WRITES.has(full) || WRITES.has(name)) return WRITE;
  const found = catalog ? lookupCommand(catalog, words) : undefined;
  if (!found) {
    return catalog ? { write: false, unknown: true } : { write: !KNOWN_READS.has(name) };
  }
  const flags = found.doc.flags;
  if (found.doc.write || flags.includes('may_replicate')) return WRITE;
  return READ;
}

/** Reads that need no catalog to be recognised (for servers that refuse COMMAND DOCS / INFO). */
const KNOWN_READS = new Set([
  'GET',
  'MGET',
  'GETRANGE',
  'STRLEN',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'EXPIRETIME',
  'SCAN',
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HSCAN',
  'HEXISTS',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'SMEMBERS',
  'SISMEMBER',
  'SCARD',
  'SSCAN',
  'ZRANGE',
  'ZSCORE',
  'ZCARD',
  'ZSCAN',
  'ZRANK',
  'XRANGE',
  'XREVRANGE',
  'XLEN',
  'XINFO',
  'PING',
  'ECHO',
  'INFO',
  'DBSIZE',
  'TIME',
  'SELECT',
  'MEMORY',
  'OBJECT',
  'COMMAND',
  'CLIENT',
  'SLOWLOG',
  'LATENCY',
  'PUBSUB',
  'ROLE',
  'LASTSAVE',
  'MULTI',
  'EXEC',
  'DISCARD',
  'WATCH',
  'UNWATCH',
  'HELLO',
  'AUTH',
]);

/** A word redis-cli needs no quotes for: no spaces, quotes, backslashes or control characters. */
function isPlainWord(text: string): boolean {
  if (text === '') return false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || ch === '"' || ch === "'" || ch === '\\') return false;
    if (/\s/.test(ch)) return false;
  }
  return true;
}

/**
 * A command as redis-cli would echo it, for confirmations and the CLI log: plain words stay as
 * they are; anything with spaces, quotes, backslashes or bytes that are not UTF-8 text is quoted
 * with redis-cli escapes, so the line can be pasted back. Arguments longer than `maxArgBytes`
 * are cut and marked with "…".
 */
export function formatCommandLine(args: readonly RedisBytes[], maxArgBytes = 200): string {
  return args
    .map((arg) => {
      const bytes = toBytes(arg);
      const cut = bytes.length > maxArgBytes ? bytes.subarray(0, maxArgBytes) : bytes;
      const text = tryUtf8(cut);
      const plain = text !== undefined && isPlainWord(text);
      return `${plain ? text : quoteRepr(cut, true)}${cut === bytes ? '' : '…'}`;
    })
    .join(' ');
}
