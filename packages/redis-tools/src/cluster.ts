import { toBytes, type RedisBytes } from './bytes';
import { replyItems, replyNumber, replyPairs, replyText, type RedisReply } from './reply';

/** Redis Cluster helpers: key slots and the topology behind the slot map view (spec §10). */

export const CLUSTER_SLOTS = 16384;

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    table[i] = crc & 0xffff;
  }
  return table;
})();

/** CRC16-CCITT (XMODEM), the checksum Redis Cluster hashes keys with. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ b) & 0xff]!) & 0xffff;
  return crc;
}

/**
 * The hash slot of a key: CRC16 of the key mod 16384, or of its hash tag — the part between
 * the first `{` and the next `}`, when that part is not empty.
 */
export function keySlot(key: RedisBytes): number {
  const bytes = toBytes(key);
  const open = bytes.indexOf(0x7b);
  if (open >= 0) {
    const close = bytes.indexOf(0x7d, open + 1);
    if (close > open + 1) return crc16(bytes.subarray(open + 1, close)) % CLUSTER_SLOTS;
  }
  return crc16(bytes) % CLUSTER_SLOTS;
}

export type SlotRange = readonly [start: number, end: number];

export interface ClusterNodeInfo {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  /** Cluster bus port (CLUSTER NODES). */
  readonly busPort?: number;
  readonly hostname?: string;
  readonly role: 'primary' | 'replica';
  /** For a replica, the id of its primary. */
  readonly primaryId?: string;
  /** Raw flags, e.g. myself, master, slave, fail?, fail, handshake, noaddr, nofailover. */
  readonly flags: readonly string[];
  /** The node answering the topology query. */
  readonly myself: boolean;
  /** Flagged fail or fail? (possibly failing). */
  readonly failing: boolean;
  /** connected / disconnected (CLUSTER NODES) or online / failed / loading (CLUSTER SHARDS). */
  readonly state: string;
  readonly slots: readonly SlotRange[];
  readonly replicationOffset?: number;
  readonly configEpoch?: number;
}

/** "host:port" of a node, the id the driver uses for nodes. */
export function nodeAddress(node: { readonly host: string; readonly port: number }): string {
  return node.host.includes(':') ? `[${node.host}]:${node.port}` : `${node.host}:${node.port}`;
}

/** Parses CLUSTER NODES text. Migrating/importing markers (`[slot->-id]`) are skipped. */
export function parseClusterNodes(text: string): ClusterNodeInfo[] {
  const nodes: ClusterNodeInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(' ');
    if (parts.length < 8) continue;
    const [id, address, flagText, primary, , , epoch, link, ...slotParts] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    // ip:port@cport[,hostname]; IPv6 hosts contain colons.
    const [endpoint, hostname] = address.split(',', 2) as [string, string | undefined];
    const match = /^(.*):(\d+)(?:@(\d+))?$/.exec(endpoint);
    const flags = flagText.split(',').filter(Boolean);
    const slots: SlotRange[] = [];
    for (const part of slotParts) {
      if (part.startsWith('[')) continue;
      const [start, end] = part.split('-');
      const s = Number(start);
      const e = end === undefined ? s : Number(end);
      if (Number.isInteger(s) && Number.isInteger(e)) slots.push([s, e]);
    }
    const replica = flags.includes('slave') || flags.includes('replica');
    nodes.push({
      id,
      host: (match?.[1] ?? endpoint).replace(/^\[(.*)\]$/, '$1'),
      port: Number(match?.[2] ?? 0),
      ...(match?.[3] !== undefined ? { busPort: Number(match[3]) } : {}),
      ...(hostname ? { hostname } : {}),
      role: replica ? 'replica' : 'primary',
      ...(replica && primary !== '-' ? { primaryId: primary } : {}),
      flags,
      myself: flags.includes('myself'),
      failing: flags.includes('fail') || flags.includes('fail?'),
      state: link,
      slots,
      configEpoch: Number(epoch),
    });
  }
  return nodes;
}

/** Parses a CLUSTER SHARDS reply (Redis 7+) into nodes, primaries first per shard. */
export function parseClusterShards(reply: RedisReply): ClusterNodeInfo[] {
  const nodes: ClusterNodeInfo[] = [];
  for (const shard of replyItems(reply) ?? []) {
    const fields = new Map<string, RedisReply>();
    for (const [k, v] of replyPairs(shard) ?? []) fields.set(replyText(k) ?? '', v);
    const bounds = (replyItems(fields.get('slots')) ?? []).map((r) => replyNumber(r) ?? 0);
    const slots: SlotRange[] = [];
    for (let i = 0; i + 1 < bounds.length; i += 2) slots.push([bounds[i]!, bounds[i + 1]!]);
    const members = (replyItems(fields.get('nodes')) ?? []).map((n) => {
      const f = new Map<string, RedisReply>();
      for (const [k, v] of replyPairs(n) ?? []) f.set(replyText(k) ?? '', v);
      return f;
    });
    const primary = members.find((m) => replyText(m.get('role')) === 'master');
    const primaryId = replyText(primary?.get('id'));
    for (const m of members) {
      const role = replyText(m.get('role')) === 'master' ? 'primary' : 'replica';
      const health = replyText(m.get('health')) ?? '';
      const hostname = replyText(m.get('hostname'));
      const offset = replyNumber(m.get('replication-offset'));
      nodes.push({
        id: replyText(m.get('id')) ?? '',
        host: replyText(m.get('ip')) ?? replyText(m.get('endpoint')) ?? '',
        port: replyNumber(m.get('port')) ?? replyNumber(m.get('tls-port')) ?? 0,
        ...(hostname ? { hostname } : {}),
        role,
        ...(role === 'replica' && primaryId !== undefined ? { primaryId } : {}),
        flags: [role === 'primary' ? 'master' : 'slave'],
        myself: false,
        failing: health === 'fail',
        state: health,
        slots: role === 'primary' ? slots : [],
        ...(offset !== undefined ? { replicationOffset: offset } : {}),
      });
    }
  }
  return nodes;
}

/** Slot ranges not served by any primary; empty when the whole keyspace is covered. */
export function uncoveredSlots(nodes: readonly ClusterNodeInfo[]): SlotRange[] {
  const covered = new Uint8Array(CLUSTER_SLOTS);
  for (const node of nodes) {
    if (node.role !== 'primary') continue;
    for (const [s, e] of node.slots) covered.fill(1, s, e + 1);
  }
  const gaps: SlotRange[] = [];
  let start = -1;
  for (let slot = 0; slot <= CLUSTER_SLOTS; slot++) {
    const hole = slot < CLUSTER_SLOTS && covered[slot] === 0;
    if (hole && start < 0) start = slot;
    if (!hole && start >= 0) {
      gaps.push([start, slot - 1]);
      start = -1;
    }
  }
  return gaps;
}
