import type { RedisReply } from '@querybara/redis-tools';

/**
 * Converts what ioredis returns into the structured-clone-safe RedisReply tree, and back out
 * into plain values for the typed services.
 *
 * ioredis decodes simple strings and bulk strings alike into Buffers, so which string replies
 * are status replies (printed unquoted by redis-cli, e.g. `OK`) is inferred from the command:
 * the commands below answer with a simple string on success. Nested status replies (inside
 * EXEC results or COMMAND INFO flags) are shown as bulk strings.
 */

const STATUS_COMMANDS = new Set([
  'asking',
  'auth',
  'bgrewriteaof',
  'bgsave',
  'debug',
  'discard',
  'failover',
  'flushall',
  'flushdb',
  'hmset',
  'json.merge',
  'json.mset',
  'json.set',
  'lset',
  'ltrim',
  'migrate',
  'mset',
  'multi',
  'pfmerge',
  'psetex',
  'quit',
  'readonly',
  'readwrite',
  'rename',
  'replicaof',
  'reset',
  'restore',
  'restore-asking',
  'save',
  'select',
  'set',
  'setex',
  'shutdown',
  'slaveof',
  'swapdb',
  'type',
  'unwatch',
  'watch',
  'xsetid',
]);

const STATUS_SUBCOMMANDS = new Set([
  'acl load',
  'acl log',
  'acl save',
  'acl setuser',
  'client caching',
  'client kill',
  'client no-evict',
  'client no-touch',
  'client pause',
  'client reply',
  'client setinfo',
  'client setname',
  'client tracking',
  'client unpause',
  'cluster addslots',
  'cluster addslotsrange',
  'cluster bumpepoch',
  'cluster delslots',
  'cluster delslotsrange',
  'cluster failover',
  'cluster flushslots',
  'cluster forget',
  'cluster meet',
  'cluster replicate',
  'cluster reset',
  'cluster saveconfig',
  'cluster set-config-epoch',
  'cluster setslot',
  'config resetstat',
  'config rewrite',
  'config set',
  'function delete',
  'function flush',
  'function kill',
  'function restore',
  'memory purge',
  'module load',
  'module loadex',
  'module unload',
  'script debug',
  'script flush',
  'script kill',
  'sentinel config',
  'sentinel failover',
  'sentinel flushconfig',
  'sentinel monitor',
  'sentinel remove',
  'sentinel set',
  'slowlog reset',
  'xgroup create',
  'xgroup setid',
]);

const OK = [0x4f, 0x4b];

function isOk(bytes: Uint8Array): boolean {
  return bytes.length === 2 && bytes[0] === OK[0] && bytes[1] === OK[1];
}

/** Whether a top-level string reply to `args` is a status reply. */
export function isStatusReply(
  args: readonly string[],
  value: Uint8Array,
  inMulti: boolean,
): boolean {
  const name = (args[0] ?? '').toLowerCase();
  const sub = (args[1] ?? '').toLowerCase();
  if (inMulti && value.length === 6 && new TextDecoder().decode(value) === 'QUEUED') return true;
  if (name === 'ping') return args.length === 1;
  if (name === 'set') return !args.slice(3).some((a) => a.toLowerCase() === 'get');
  if (STATUS_COMMANDS.has(name)) return true;
  if (STATUS_SUBCOMMANDS.has(`${name} ${sub}`)) return true;
  // Module commands (JSON.SET, FT.CREATE...) answer plain OK as a status.
  return name.includes('.') && isOk(value);
}

/** A copy of the bytes in an exactly-sized plain Uint8Array (never a view on a Buffer pool). */
export function ownBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function integerFrom(value: number | string | bigint): RedisReply {
  if (typeof value === 'number') return { type: 'integer', value };
  const big = BigInt(value);
  const safe = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER);
  return { type: 'integer', value: safe ? Number(big) : big };
}

/**
 * Converts an ioredis reply. `statusHint` marks the top-level string as a status reply (see
 * `isStatusReply`). Integers arrive as numbers, or as strings when the connection uses
 * string numbers (exact beyond 2^53).
 */
export function toRedisReply(raw: unknown, statusHint = false): RedisReply {
  if (raw === null || raw === undefined) return { type: 'nil' };
  if (raw instanceof Uint8Array) {
    return statusHint
      ? { type: 'status', value: new TextDecoder().decode(raw) }
      : { type: 'bulk', value: ownBytes(raw) };
  }
  if (typeof raw === 'number' || typeof raw === 'bigint') return integerFrom(raw);
  if (typeof raw === 'string') {
    return /^-?\d+$/.test(raw) ? integerFrom(raw) : { type: 'status', value: raw };
  }
  if (raw instanceof Error) return { type: 'error', value: raw.message };
  if (Array.isArray(raw)) return { type: 'array', items: raw.map((item) => toRedisReply(item)) };
  return { type: 'status', value: String(raw) };
}

// Plain readers for the typed services.

export function asBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return ownBytes(raw);
  if (raw === null || raw === undefined) return null;
  return new TextEncoder().encode(String(raw));
}

export function asText(raw: unknown): string | null {
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

export function asNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
  if (text === 'inf' || text === '+inf') return Infinity;
  if (text === '-inf') return -Infinity;
  const n = Number(text);
  return Number.isNaN(n) ? null : n;
}

export function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/** Flat [k, v, k, v] arrays into a record keyed by the key text. */
export function asRecord(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const items = asArray(raw);
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = asText(items[i]);
    if (key !== null) out[key] = items[i + 1];
  }
  return out;
}
