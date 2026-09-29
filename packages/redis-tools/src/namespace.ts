import {
  bytesKey,
  concatBytes,
  displayBytes,
  indexOfBytes,
  startsWithBytes,
  toBytes,
  type RedisBytes,
} from './bytes';

/**
 * The key browser's namespace tree: key names split on a configurable delimiter (":" by
 * default), so `user:42:profile` sits under `user` → `42`. Keys and segments are bytes.
 */

export const DEFAULT_KEY_DELIMITER = ':';

/** Splits a key into its segments on `delimiter`. An empty delimiter leaves the key whole. */
export function splitKey(key: Uint8Array, delimiter: RedisBytes): Uint8Array[] {
  const delim = toBytes(delimiter);
  if (delim.length === 0) return [key];
  const parts: Uint8Array[] = [];
  let start = 0;
  for (;;) {
    const at = indexOfBytes(key, delim, start);
    if (at < 0) break;
    parts.push(key.subarray(start, at));
    start = at + delim.length;
  }
  parts.push(key.subarray(start));
  return parts;
}

/** The prefix for a namespace path: its segments joined by the delimiter, plus the delimiter. */
export function namespacePrefix(
  segments: readonly Uint8Array[],
  delimiter: RedisBytes,
): Uint8Array {
  if (segments.length === 0) return new Uint8Array(0);
  const delim = toBytes(delimiter);
  const parts: Uint8Array[] = [];
  for (const segment of segments) parts.push(segment, delim);
  return concatBytes(...parts);
}

export interface LevelGroups {
  /** Child namespaces: the next segment and how many of the keys fall under it. */
  readonly namespaces: readonly { readonly segment: Uint8Array; readonly count: number }[];
  /** Keys that end at this level (no delimiter after the prefix). */
  readonly keys: readonly Uint8Array[];
}

/**
 * Groups keys one level below `prefix` (which ends with the delimiter, or is empty for the
 * root): each key is either a leaf at this level or counted under its next segment. Keys that
 * do not start with the prefix are ignored; duplicates (SCAN may return a key twice) count once.
 * Namespaces and leaves come back sorted by display name.
 */
export function groupLevel(
  keys: Iterable<Uint8Array>,
  prefix: Uint8Array,
  delimiter: RedisBytes,
): LevelGroups {
  const delim = toBytes(delimiter);
  const seen = new Set<string>();
  const namespaces = new Map<string, { segment: Uint8Array; count: number }>();
  const leaves: Uint8Array[] = [];
  for (const key of keys) {
    if (!startsWithBytes(key, prefix)) continue;
    const id = bytesKey(key);
    if (seen.has(id)) continue;
    seen.add(id);
    const at = delim.length === 0 ? -1 : indexOfBytes(key, delim, prefix.length);
    if (at < 0) {
      leaves.push(key);
      continue;
    }
    const segment = key.subarray(prefix.length, at);
    const segmentId = bytesKey(segment);
    const entry = namespaces.get(segmentId);
    if (entry) entry.count += 1;
    else namespaces.set(segmentId, { segment: segment.slice(), count: 1 });
  }
  return {
    namespaces: [...namespaces.values()].sort((a, b) =>
      naturalCompare(displayBytes(a.segment), displayBytes(b.segment)),
    ),
    keys: leaves.sort((a, b) => naturalCompare(displayBytes(a), displayBytes(b))),
  };
}

/** Compares display names with numbers in natural order ("key2" before "key10"). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'variant' });
}

export interface NamespaceEntry {
  readonly kind: 'namespace' | 'key';
  /** This level's segment (for a key, the part after the last delimiter). */
  readonly segment: Uint8Array;
  /** `displayBytes(segment)`. */
  readonly name: string;
  /** The full key for a key; the prefix including the trailing delimiter for a namespace. */
  readonly bytes: Uint8Array;
  /** Keys at or below this entry (1 for a key). */
  readonly keyCount: number;
}

interface TreeNode {
  readonly segment: Uint8Array;
  readonly prefix: Uint8Array;
  readonly children: Map<string, TreeNode>;
  readonly leaves: Map<string, Uint8Array>;
  total: number;
}

/**
 * A namespace tree built incrementally from successive SCAN pages. Keys are deduplicated (SCAN
 * may repeat one). Bounded: past `maxEntries` namespaces and keys, new entries are counted in
 * `dropped` but not stored, and counts become lower bounds (`truncated`).
 */
export class NamespaceTree {
  private readonly delim: Uint8Array;
  private readonly root: TreeNode;
  private entries = 0;
  private droppedKeys = 0;

  constructor(
    delimiter: RedisBytes = DEFAULT_KEY_DELIMITER,
    private readonly maxEntries = 100_000,
  ) {
    this.delim = toBytes(delimiter);
    this.root = {
      segment: new Uint8Array(0),
      prefix: new Uint8Array(0),
      children: new Map(),
      leaves: new Map(),
      total: 0,
    };
  }

  /** Distinct keys stored in the tree. */
  get keyCount(): number {
    return this.root.total;
  }

  /** Keys that did not fit under `maxEntries`. */
  get dropped(): number {
    return this.droppedKeys;
  }

  get truncated(): boolean {
    return this.droppedKeys > 0;
  }

  /** Adds a page of keys; returns how many were new. */
  add(keys: Iterable<Uint8Array>): number {
    let added = 0;
    for (const key of keys) if (this.addKey(key)) added += 1;
    return added;
  }

  private addKey(key: Uint8Array): boolean {
    const segments = splitKey(key, this.delim);
    const path: TreeNode[] = [this.root];
    let node = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      const id = bytesKey(segment);
      let child = node.children.get(id);
      if (!child) {
        if (this.entries >= this.maxEntries) {
          this.droppedKeys += 1;
          return false;
        }
        child = {
          segment: segment.slice(),
          prefix: concatBytes(node.prefix, segment, this.delim),
          children: new Map(),
          leaves: new Map(),
          total: 0,
        };
        node.children.set(id, child);
        this.entries += 1;
      }
      node = child;
      path.push(node);
    }
    const leafId = bytesKey(segments[segments.length - 1]!);
    if (node.leaves.has(leafId)) return false;
    if (this.entries >= this.maxEntries) {
      this.droppedKeys += 1;
      return false;
    }
    node.leaves.set(leafId, key.slice());
    this.entries += 1;
    for (const n of path) n.total += 1;
    return true;
  }

  /**
   * The entries directly under a namespace path (segments from the root; `[]` for the root):
   * namespaces first, then keys, each sorted by display name. Empty for an unknown path.
   */
  children(path: readonly Uint8Array[] = []): NamespaceEntry[] {
    let node: TreeNode | undefined = this.root;
    for (const segment of path) {
      node = node.children.get(bytesKey(segment));
      if (!node) return [];
    }
    const namespaces = [...node.children.values()]
      .map((child): NamespaceEntry => ({
        kind: 'namespace',
        segment: child.segment,
        name: displayBytes(child.segment),
        bytes: child.prefix,
        keyCount: child.total,
      }))
      .sort((a, b) => naturalCompare(a.name, b.name));
    const keys = [...node.leaves.values()]
      .map((key): NamespaceEntry => {
        const segment = key.subarray(node.prefix.length);
        return { kind: 'key', segment, name: displayBytes(segment), bytes: key, keyCount: 1 };
      })
      .sort((a, b) => naturalCompare(a.name, b.name));
    return [...namespaces, ...keys];
  }
}
