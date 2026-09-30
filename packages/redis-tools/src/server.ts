import { utf8Bytes } from './bytes';
import {
  replyBytes,
  replyItems,
  replyNumber,
  replyPairs,
  replyText,
  type RedisReply,
} from './reply';

/** Parsers for the session list, slow log, latency monitor and ACL tools (spec §10, §15). */

export interface ClientInfo {
  readonly id: number;
  readonly addr: string;
  readonly laddr?: string;
  /** CLIENT SETNAME; empty when unset. */
  readonly name: string;
  readonly ageSeconds: number;
  readonly idleSeconds: number;
  /** Client flags, e.g. "N" (normal), "S" (replica), "M" (master), "P" (pub/sub), "x" (MULTI). */
  readonly flags: string;
  readonly db: number;
  /** The last command, lower case, e.g. "client|list". */
  readonly cmd: string;
  readonly user?: string;
  readonly subscriptions: number;
  readonly patternSubscriptions: number;
  /** Output buffer memory and total memory, in bytes. */
  readonly outputMemory: number;
  readonly totalMemory: number;
  /** Every field as reported. */
  readonly fields: Readonly<Record<string, string>>;
}

function int(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses CLIENT LIST text: one client per line, space-separated `name=value` fields (values
 * never contain spaces: client names cannot; unset ones are empty).
 */
export function parseClientList(text: string): ClientInfo[] {
  const out: ClientInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const fields: Record<string, string> = {};
    for (const part of line.trim().split(' ')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    if (fields['id'] === undefined) continue;
    out.push({
      id: int(fields['id']),
      addr: fields['addr'] ?? '',
      ...(fields['laddr'] !== undefined ? { laddr: fields['laddr'] } : {}),
      name: fields['name'] ?? '',
      ageSeconds: int(fields['age']),
      idleSeconds: int(fields['idle']),
      flags: fields['flags'] ?? '',
      db: int(fields['db']),
      cmd: fields['cmd'] ?? '',
      ...(fields['user'] !== undefined ? { user: fields['user'] } : {}),
      subscriptions: int(fields['sub']),
      patternSubscriptions: int(fields['psub']),
      outputMemory: int(fields['omem']),
      totalMemory: int(fields['tot-mem']),
      fields,
    });
  }
  return out;
}

export interface SlowlogEntry {
  readonly id: number;
  /** Unix time in seconds. */
  readonly timestamp: number;
  readonly durationMicros: number;
  /** The command and its arguments as logged (Redis truncates long ones). */
  readonly args: readonly Uint8Array[];
  /** Client address and name (Redis 4+). */
  readonly client?: string;
  readonly clientName?: string;
}

/** Parses a SLOWLOG GET reply, newest first as Redis returns it. */
export function parseSlowlog(reply: RedisReply): SlowlogEntry[] {
  return (replyItems(reply) ?? []).flatMap((entry): SlowlogEntry[] => {
    const f = replyItems(entry);
    if (!f || f.length < 4) return [];
    const client = replyText(f[4]);
    const clientName = replyText(f[5]);
    return [
      {
        id: replyNumber(f[0]) ?? 0,
        timestamp: replyNumber(f[1]) ?? 0,
        durationMicros: replyNumber(f[2]) ?? 0,
        args: (replyItems(f[3]) ?? []).map((a) => replyBytes(a) ?? new Uint8Array(0)),
        ...(client !== undefined ? { client } : {}),
        ...(clientName !== undefined ? { clientName } : {}),
      },
    ];
  });
}

export interface LatencyEvent {
  readonly event: string;
  /** Unix time in seconds of the latest spike. */
  readonly timestamp: number;
  readonly latestMs: number;
  readonly maxMs: number;
}

/** Parses LATENCY LATEST: one row per event with its latest and all-time maximum latency. */
export function parseLatencyLatest(reply: RedisReply): LatencyEvent[] {
  return (replyItems(reply) ?? []).flatMap((row): LatencyEvent[] => {
    const f = replyItems(row);
    const event = replyText(f?.[0]);
    if (!f || event === undefined) return [];
    return [
      {
        event,
        timestamp: replyNumber(f[1]) ?? 0,
        latestMs: replyNumber(f[2]) ?? 0,
        maxMs: replyNumber(f[3]) ?? 0,
      },
    ];
  });
}

export interface LatencySample {
  readonly timestamp: number;
  readonly latencyMs: number;
}

/** Parses LATENCY HISTORY <event>: (timestamp, latency) samples, oldest first. */
export function parseLatencyHistory(reply: RedisReply): LatencySample[] {
  return (replyItems(reply) ?? []).flatMap((row): LatencySample[] => {
    const f = replyItems(row);
    if (!f || f.length < 2) return [];
    return [{ timestamp: replyNumber(f[0]) ?? 0, latencyMs: replyNumber(f[1]) ?? 0 }];
  });
}

export interface AclSelector {
  readonly commands: string;
  readonly keys: string;
  readonly channels: string;
}

export interface AclUser {
  /** on / off, nopass, allkeys, allchannels... */
  readonly flags: readonly string[];
  /** SHA-256 hashes of the user's passwords (never the passwords themselves). */
  readonly passwordHashes: readonly string[];
  /** The command rules, e.g. "+@all -@dangerous". */
  readonly commands: string;
  /** Key patterns, e.g. "~app:*" ("%R~..." / "%W~..." for read/write-only on 7+). */
  readonly keys: string;
  /** Pub/Sub channel patterns, e.g. "&*". */
  readonly channels: string;
  /** Additional selectors (Redis 7+). */
  readonly selectors: readonly AclSelector[];
}

function patternsText(reply: RedisReply | undefined, prefix: string): string {
  // Redis 6.2 returns arrays of bare patterns; 7+ returns one string with the prefixes.
  const items = reply && reply.type === 'array' ? replyItems(reply) : undefined;
  if (items) {
    return items
      .map((r) => replyText(r) ?? '')
      .map((p) => (p.startsWith(prefix) ? p : `${prefix}${p}`))
      .join(' ');
  }
  return replyText(reply) ?? '';
}

function recordOf(reply: RedisReply | undefined): Map<string, RedisReply> {
  const out = new Map<string, RedisReply>();
  for (const [k, v] of replyPairs(reply) ?? []) {
    const key = replyText(k);
    if (key !== undefined) out.set(key, v);
  }
  return out;
}

/** Parses ACL GETUSER (6.2 and 7+ shapes). */
export function parseAclUser(reply: RedisReply): AclUser {
  const f = recordOf(reply);
  const list = (name: string): string[] =>
    (replyItems(f.get(name)) ?? []).map((r) => replyText(r) ?? '');
  return {
    flags: list('flags'),
    passwordHashes: list('passwords'),
    commands: replyText(f.get('commands')) ?? '',
    keys: patternsText(f.get('keys'), '~'),
    channels: patternsText(f.get('channels'), '&'),
    selectors: (replyItems(f.get('selectors')) ?? []).map((s) => {
      const sel = recordOf(s);
      return {
        commands: replyText(sel.get('commands')) ?? '',
        keys: patternsText(sel.get('keys'), '~'),
        channels: patternsText(sel.get('channels'), '&'),
      };
    }),
  };
}

export interface AclLogEntry {
  readonly count: number;
  /** auth, command, key or channel. */
  readonly reason: string;
  /** toplevel, multi, lua or module. */
  readonly context: string;
  /** The command, key or channel that was denied. */
  readonly object: string;
  readonly username: string;
  readonly ageSeconds: number;
  readonly clientInfo: string;
  /** Redis 7.2+. */
  readonly entryId?: number;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

/** Parses ACL LOG entries, newest first. */
export function parseAclLog(reply: RedisReply): AclLogEntry[] {
  return (replyItems(reply) ?? []).map((entry) => {
    const f = recordOf(entry);
    const text = (name: string): string => replyText(f.get(name)) ?? '';
    const entryId = replyNumber(f.get('entry-id'));
    const created = replyNumber(f.get('timestamp-created'));
    const updated = replyNumber(f.get('timestamp-last-updated'));
    return {
      count: replyNumber(f.get('count')) ?? 0,
      reason: text('reason'),
      context: text('context'),
      object: text('object'),
      username: text('username'),
      ageSeconds: replyNumber(f.get('age-seconds')) ?? 0,
      clientInfo: text('client-info'),
      ...(entryId !== undefined ? { entryId } : {}),
      ...(created !== undefined ? { createdAtMs: created } : {}),
      ...(updated !== undefined ? { updatedAtMs: updated } : {}),
    };
  });
}

/** One command seen by MONITOR. */
export interface MonitorEntry {
  readonly timestamp: number;
  readonly db: number;
  /** Client address, or "lua" / "unix:..." as Redis prints it. */
  readonly source: string;
  readonly args: readonly Uint8Array[];
}

/** Unescapes one sdscatrepr-quoted argument body (without the surrounding quotes). */
export function unescapeRepr(body: string): Uint8Array {
  const out: number[] = [];
  let run = '';
  const flush = (): void => {
    if (run) for (const b of utf8Bytes(run)) out.push(b);
    run = '';
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\' || i + 1 >= body.length) {
      run += ch;
      continue;
    }
    const next = body[i + 1]!;
    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
      flush();
      out.push(parseInt(body.slice(i + 2, i + 4), 16));
      i += 3;
      continue;
    }
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, a: 7, b: 8 };
    if (simple[next] !== undefined) {
      flush();
      out.push(simple[next]!);
    } else {
      run += next;
    }
    i += 1;
  }
  flush();
  return Uint8Array.from(out);
}

/**
 * Parses one MONITOR line (`1339518083.107412 [0 127.0.0.1:60866] "keys" "*"`), unescaping the
 * quoted arguments back to bytes. Undefined for anything else (e.g. the initial "OK").
 */
export function parseMonitorLine(line: string): MonitorEntry | undefined {
  const match = /^(\d+(?:\.\d+)?) \[(\d+) ([^\]]*)\] (.*)$/.exec(line);
  if (!match) return undefined;
  const args: Uint8Array[] = [];
  const rest = match[4]!;
  let i = 0;
  while (i < rest.length) {
    if (rest[i] !== '"') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < rest.length && rest[j] !== '"') j += rest[j] === '\\' ? 2 : 1;
    args.push(unescapeRepr(rest.slice(i + 1, j)));
    i = j + 1;
  }
  return { timestamp: Number(match[1]), db: Number(match[2]), source: match[3]!, args };
}
