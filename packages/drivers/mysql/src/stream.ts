import type { CellValue } from '@joinery/core';
import type { FieldPacket, ResultSetHeader } from 'mysql2';

/** The mysql2 command events a result stream listens to (Query and Execute both emit them). */
export interface CommandEvents {
  on(event: 'fields', listener: (fields: FieldPacket[] | undefined) => void): unknown;
  on(event: 'result', listener: (row: CellValue[] | ResultSetHeader) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** Flow control on the connection's socket. */
export interface Pausable {
  pause(): void;
  resume(): void;
}

/** What `ResultStream.next` hands out, one page or event at a time. */
export type StreamChunk =
  | { readonly kind: 'fields'; readonly fields: FieldPacket[] }
  | { readonly kind: 'rows'; readonly rows: CellValue[][] }
  | { readonly kind: 'header'; readonly header: ResultSetHeader };

type Item =
  | { kind: 'fields'; fields: FieldPacket[] }
  | { kind: 'row'; set: number; row: CellValue[] }
  | { kind: 'header'; header: ResultSetHeader };

/**
 * Turns mysql2's push-style command events into pages the consumer pulls. The text protocol
 * has no server-side cursor, so flow control is the socket: once a page worth of rows is
 * queued the connection is paused, and the server blocks on its send buffer until the consumer
 * asks for more. Memory stays bounded by one page plus one socket read.
 */
export class ResultStream {
  private readonly items: Item[] = [];
  private rowsQueued = 0;
  private resultSet = -1;
  private paused = false;
  private discarding = false;
  private failure: { error: unknown } | undefined;
  private wake: (() => void) | undefined;
  private finished = false;
  /** Resolves when the command has fully ended (end or error). */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    private readonly connection: Pausable,
    command: CommandEvents,
    private readonly pageSize: number,
  ) {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    command.on('fields', (fields) => {
      if (fields === undefined) return;
      this.resultSet += 1;
      this.push({ kind: 'fields', fields });
    });
    command.on('result', (row) => {
      if (Array.isArray(row)) {
        if (this.discarding) return;
        this.push({ kind: 'row', set: this.resultSet, row });
        this.rowsQueued += 1;
        if (this.rowsQueued >= this.pageSize && !this.paused) {
          this.paused = true;
          this.connection.pause();
        }
      } else {
        this.push({ kind: 'header', header: row });
      }
    });
    command.on('end', () => this.finish());
    command.on('error', (error) => {
      this.failure = { error };
      this.finish();
    });
  }

  /** True once the server has sent everything (or failed). */
  get ended(): boolean {
    return this.finished;
  }

  private finish(): void {
    this.finished = true;
    this.resolveDone();
    this.notify();
  }

  private push(item: Item): void {
    if (this.discarding && item.kind !== 'header') return;
    this.items.push(item);
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private resume(): void {
    if (this.paused && this.rowsQueued < this.pageSize) {
      this.paused = false;
      this.connection.resume();
    }
  }

  private waitForItems(): Promise<void> {
    if (this.items.length > 0 || this.finished) return Promise.resolve();
    return new Promise((resolve) => (this.wake = resolve));
  }

  /**
   * The next page of rows (up to pageSize, one result set at a time), column definitions or
   * OK header; null when the command is complete. Throws the command's error, after the
   * rows that preceded it.
   */
  async next(): Promise<StreamChunk | null> {
    this.resume();
    await this.waitForItems();
    const first = this.items[0];
    if (first === undefined) {
      if (this.failure) throw this.failure.error;
      return null;
    }
    if (first.kind !== 'row') {
      this.items.shift();
      return first.kind === 'fields'
        ? { kind: 'fields', fields: first.fields }
        : { kind: 'header', header: first.header };
    }
    const rows: CellValue[][] = [];
    const set = first.set;
    while (rows.length < this.pageSize) {
      const item = this.items[0];
      if (item === undefined) {
        if (this.finished) break;
        this.resume();
        await this.waitForItems();
        continue;
      }
      if (item.kind !== 'row' || item.set !== set) break;
      this.items.shift();
      this.rowsQueued -= 1;
      rows.push(item.row);
    }
    this.resume();
    return { kind: 'rows', rows };
  }

  /** Drops whatever is left and lets the command run to its end. Resolves when it has. */
  discardRest(): Promise<void> {
    this.discarding = true;
    this.items.length = 0;
    this.rowsQueued = 0;
    if (this.paused) {
      this.paused = false;
      this.connection.resume();
    }
    return this.done;
  }
}
