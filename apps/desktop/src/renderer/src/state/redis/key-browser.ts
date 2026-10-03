import type { KeyInfo } from '@querybara/driver-redis';
import type { RedisScanPage } from '@querybara/ipc';
import {
  NamespaceTree,
  bytesKey,
  displayBytes,
  escapeGlob,
  parseDisplayBytes,
  splitKey,
  utf8Bytes,
} from '@querybara/redis-tools';

/**
 * The key browser (spec §10): a SCAN-based listing (never KEYS) paged by the connection host's
 * scan stream, with pattern and type filters, a namespace tree on the profile's delimiter and a
 * flat list. Memory (MEMORY USAGE) is fetched only for the rows on screen. A new filter closes
 * the running scan and starts another; pages from the old one are dropped.
 */

/** The TYPE filter's choices ('' = any type). */
export const KEY_TYPES = ['', 'string', 'hash', 'list', 'set', 'zset', 'stream', 'ReJSON-RL'];

export const DEFAULT_KEY_PAGE = 200;

export interface KeyFilter {
  /** A glob in display form (see `displayBytes`); '' lists every key. */
  readonly pattern: string;
  /** A TYPE name, or '' for any type. */
  readonly type: string;
  /** Cluster: one node's keys; every primary when absent. */
  readonly node?: string;
}

export interface KeyRow extends KeyInfo {
  /** `bytesKey(key)`: a binary-safe id for maps and React keys. */
  readonly id: string;
  /** `displayBytes(key)`. */
  readonly name: string;
}

export type MemoryState = number | null | 'loading';

export interface KeyBrowserState {
  readonly filter: KeyFilter;
  readonly view: 'tree' | 'list';
  readonly rows: readonly KeyRow[];
  /** More keys may exist: the scan has not reached cursor 0. */
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  /** SCAN round trips so far, and whether the last page ran out of budget before filling. */
  readonly scanCalls: number;
  readonly budgetExhausted: boolean;
  /** MEMORY USAGE by row id. */
  readonly memory: Readonly<Record<string, MemoryState>>;
  /** Expanded namespaces of the tree view, by prefix id (`bytesKey` of the prefix). */
  readonly expanded: ReadonlySet<string>;
  readonly version: number;
}

/** One SCAN query: what the host's scan stream is opened with. */
export interface ScanQuery {
  readonly match?: Uint8Array;
  readonly type?: string;
  readonly node?: string;
  readonly pageSize: number;
}

/** An open scan: pages as the caller pulls, `return()` closes it. */
export interface PageStream {
  next(): Promise<IteratorResult<RedisScanPage, undefined>>;
  return(): Promise<IteratorResult<RedisScanPage, undefined>>;
}

export type ScanOpener = (query: ScanQuery) => PageStream | Promise<PageStream>;
export type MemoryFetcher = (keys: readonly Uint8Array[]) => Promise<readonly (number | null)[]>;

export function toRow(info: KeyInfo): KeyRow {
  return { ...info, id: bytesKey(info.key), name: displayBytes(info.key) };
}

/** The SCAN query for a filter: the pattern's bytes as MATCH (none when empty). */
export function scanQuery(filter: KeyFilter, pageSize = DEFAULT_KEY_PAGE): ScanQuery {
  const pattern = filter.pattern.trim();
  return {
    pageSize,
    ...(pattern !== '' && pattern !== '*' ? { match: parseDisplayBytes(pattern) } : {}),
    ...(filter.type !== '' ? { type: filter.type } : {}),
    ...(filter.node !== undefined ? { node: filter.node } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tree row: a namespace (with its key count) or a key, at a depth. */
export type KeyTreeRow =
  | {
      readonly kind: 'namespace';
      readonly id: string;
      readonly name: string;
      readonly depth: number;
      readonly count: number;
      readonly expanded: boolean;
      /** The prefix including the trailing delimiter. */
      readonly prefix: Uint8Array;
    }
  | {
      readonly kind: 'key';
      readonly id: string;
      readonly name: string;
      readonly depth: number;
      readonly row: KeyRow;
    };

/**
 * The tree view's visible rows: namespaces from the loaded keys split on `delimiter`, children
 * of expanded namespaces only, namespaces before keys at each level (natural order).
 */
export function keyTreeRows(
  rows: readonly KeyRow[],
  delimiter: string,
  expanded: ReadonlySet<string>,
): KeyTreeRow[] {
  const tree = new NamespaceTree(delimiter);
  tree.add(rows.map((r) => r.key));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: KeyTreeRow[] = [];
  const walk = (path: Uint8Array[], depth: number): void => {
    for (const entry of tree.children(path)) {
      if (entry.kind === 'namespace') {
        const id = bytesKey(entry.bytes);
        const open = expanded.has(id);
        out.push({
          kind: 'namespace',
          id,
          name: entry.name,
          depth,
          count: entry.keyCount,
          expanded: open,
          prefix: entry.bytes,
        });
        if (open) walk([...path, entry.segment], depth + 1);
      } else {
        const row = byId.get(bytesKey(entry.bytes));
        if (row) out.push({ kind: 'key', id: row.id, name: entry.name, depth, row });
      }
    }
  };
  walk([], 0);
  return out;
}

/** The namespace prefixes (as ids) on the way to a key, to reveal it in the tree. */
export function namespaceIdsOf(key: Uint8Array, delimiter: string): string[] {
  const segments = splitKey(key, delimiter);
  const delim = utf8Bytes(delimiter);
  const ids: string[] = [];
  let prefix = new Uint8Array(0);
  for (const segment of segments.slice(0, -1)) {
    const next = new Uint8Array(prefix.length + segment.length + delim.length);
    next.set(prefix);
    next.set(segment, prefix.length);
    next.set(delim, prefix.length + segment.length);
    prefix = next;
    ids.push(bytesKey(prefix));
  }
  return ids;
}

/**
 * Drives the key browser: one scan stream per filter, pages on demand ("Load more"), row
 * bookkeeping after edits, and MEMORY USAGE for visible rows. Rows are deduplicated (SCAN may
 * return a key twice).
 */
export class KeyBrowserController {
  readonly #open: ScanOpener;
  readonly #memory: MemoryFetcher;
  readonly #onChange: () => void;
  readonly #pageSize: number;
  #state: KeyBrowserState;
  #stream: PageStream | undefined;
  #generation = 0;
  #inFlight: Promise<void> | undefined;

  constructor(
    open: ScanOpener,
    memory: MemoryFetcher,
    onChange: () => void,
    options: { readonly pageSize?: number; readonly view?: 'tree' | 'list' } = {},
  ) {
    this.#open = open;
    this.#memory = memory;
    this.#onChange = onChange;
    this.#pageSize = options.pageSize ?? DEFAULT_KEY_PAGE;
    this.#state = {
      filter: { pattern: '', type: '' },
      view: options.view ?? 'tree',
      rows: [],
      hasMore: false,
      loading: false,
      error: undefined,
      scanCalls: 0,
      budgetExhausted: false,
      memory: {},
      expanded: new Set(),
      version: 0,
    };
  }

  get state(): KeyBrowserState {
    return this.#state;
  }

  #patch(patch: Partial<KeyBrowserState>): void {
    this.#state = { ...this.#state, ...patch, version: this.#state.version + 1 };
    this.#onChange();
  }

  /** Starts a new scan for `filter` (closing the running one) and loads its first page. */
  async reset(filter: KeyFilter = this.#state.filter): Promise<void> {
    const generation = ++this.#generation;
    const previous = this.#stream;
    this.#stream = undefined;
    this.#inFlight = undefined;
    void previous?.return().catch(() => undefined);
    this.#patch({
      filter,
      rows: [],
      hasMore: true,
      loading: true,
      error: undefined,
      scanCalls: 0,
      budgetExhausted: false,
      memory: {},
    });
    try {
      const stream = await this.#open(scanQuery(filter, this.#pageSize));
      if (generation !== this.#generation) {
        void stream.return().catch(() => undefined);
        return;
      }
      this.#stream = stream;
    } catch (error) {
      if (generation === this.#generation) {
        this.#patch({ loading: false, hasMore: false, error: message(error) });
      }
      return;
    }
    await this.#pull(generation);
  }

  /** Loads the next page of the running scan. */
  loadMore(): Promise<void> {
    if (!this.#state.hasMore || !this.#stream) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    this.#patch({ loading: true, error: undefined });
    return this.#pull(this.#generation);
  }

  #pull(generation: number): Promise<void> {
    const stream = this.#stream;
    if (!stream) return Promise.resolve();
    const run = (async () => {
      try {
        const next = await stream.next();
        if (generation !== this.#generation) return;
        if (next.done) {
          this.#stream = undefined;
          this.#patch({ loading: false, hasMore: false });
          return;
        }
        this.#applyPage(next.value);
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#stream = undefined;
        this.#patch({ loading: false, hasMore: false, error: message(error) });
      } finally {
        if (generation === this.#generation) this.#inFlight = undefined;
      }
    })();
    this.#inFlight = run;
    return run;
  }

  #applyPage(page: RedisScanPage): void {
    const seen = new Set(this.#state.rows.map((r) => r.id));
    const added: KeyRow[] = [];
    for (const info of page.keys) {
      const row = toRow(info);
      if (seen.has(row.id) || row.kind === 'none') continue;
      seen.add(row.id);
      added.push(row);
    }
    if (page.done) {
      this.#stream = undefined;
    }
    this.#patch({
      rows: [...this.#state.rows, ...added],
      hasMore: !page.done,
      loading: false,
      scanCalls: this.#state.scanCalls + page.calls,
      budgetExhausted: page.budgetExhausted,
    });
  }

  setView(view: 'tree' | 'list'): void {
    if (view !== this.#state.view) this.#patch({ view });
  }

  /** Expands namespaces (to show where a filter points), keeping the others as they are. */
  expand(ids: readonly string[]): void {
    const expanded = new Set(this.#state.expanded);
    for (const id of ids) expanded.add(id);
    this.#patch({ expanded });
  }

  toggleNamespace(id: string): void {
    const expanded = new Set(this.#state.expanded);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    this.#patch({ expanded });
  }

  /**
   * Fetches MEMORY USAGE for the given rows (those on screen) that have none yet. Rows already
   * loading or loaded are skipped, so scrolling asks only for what is new.
   */
  async fetchMemory(ids: readonly string[]): Promise<void> {
    const byId = new Map(this.#state.rows.map((r) => [r.id, r]));
    const wanted = ids.filter((id) => byId.has(id) && this.#state.memory[id] === undefined);
    if (wanted.length === 0) return;
    const generation = this.#generation;
    this.#patch({
      memory: { ...this.#state.memory, ...Object.fromEntries(wanted.map((id) => [id, 'loading'])) },
    });
    let sizes: readonly (number | null)[];
    try {
      sizes = await this.#memory(wanted.map((id) => byId.get(id)!.key));
    } catch {
      sizes = wanted.map(() => null);
    }
    if (generation !== this.#generation) return;
    this.#patch({
      memory: {
        ...this.#state.memory,
        ...Object.fromEntries(wanted.map((id, i) => [id, sizes[i] ?? null])),
      },
    });
  }

  /** Drops rows after their keys were deleted. */
  removeKeys(keys: readonly Uint8Array[]): void {
    const gone = new Set(keys.map(bytesKey));
    this.#patch({ rows: this.#state.rows.filter((r) => !gone.has(r.id)) });
  }

  /** Adds or replaces a row (a created, renamed or edited key). */
  upsert(info: KeyInfo): void {
    const row = toRow(info);
    const index = this.#state.rows.findIndex((r) => r.id === row.id);
    const rows = [...this.#state.rows];
    if (index >= 0) rows[index] = row;
    else rows.unshift(row);
    const { [row.id]: _stale, ...memory } = this.#state.memory;
    this.#patch({ rows, memory });
  }

  /** Stops the scan (the panel closed). */
  dispose(): void {
    this.#generation++;
    void this.#stream?.return().catch(() => undefined);
    this.#stream = undefined;
  }
}

/** The pattern that lists a namespace: its prefix with glob characters escaped, then `*`. */
export function namespacePattern(prefix: Uint8Array): string {
  return `${displayBytes(escapeGlob(prefix))}*`;
}

/**
 * The namespaces a pattern is inside, as ids to expand: the literal part of the pattern (up to
 * its first glob character) split on the delimiter. `user:42:*` opens `user` and `user:42`.
 */
export function patternNamespaceIds(pattern: string, delimiter: string): string[] {
  const bytes = parseDisplayBytes(pattern);
  const literal: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x5c && i + 1 < bytes.length) {
      literal.push(bytes[++i]!);
      continue;
    }
    if (b === 0x2a || b === 0x3f || b === 0x5b) break;
    literal.push(b);
  }
  // The last segment is not a namespace unless the literal ends on the delimiter.
  return namespaceIdsOf(Uint8Array.from([...literal, 0x78]), delimiter);
}
