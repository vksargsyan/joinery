import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JoineryError } from '@joinery/core';
import {
  BASE_CAPABILITIES,
  cancelledError,
  toColumnChunk,
  type BrowseNode,
  type Capabilities,
  type CellValue,
  type ColumnMeta,
  type ConnectionCheckResult,
  type DriverAdapter,
  type EngineId,
  type ExecOptions,
  type ResolvedProfile,
  type ResultChunk,
  type SchemaSnapshot,
  type Session,
} from '@joinery/core';

import type {
  CliContext,
  ConfirmAnswer,
  InputStream,
  OutputStream,
  Prompter,
} from '../src/context';
import { runCli } from '../src/program';

/** A writable that records what was written. */
export class MemoryStream extends EventEmitter implements OutputStream {
  readonly chunks: string[] = [];
  isTTY: boolean;
  columns: number | undefined;

  constructor(options: { isTTY?: boolean; columns?: number } = {}) {
    super();
    this.isTTY = options.isTTY ?? false;
    this.columns = options.columns;
  }

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    callback?.();
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

export function memoryInput(chunks: readonly (string | Buffer)[], isTTY = false): InputStream {
  return {
    isTTY,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A prompter with scripted answers; records every question. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  constructor(
    readonly interactive: boolean,
    private readonly answers: {
      secret?: string[];
      text?: string[];
      confirm?: ConfirmAnswer[];
    } = {},
  ) {}

  async secret(label: string): Promise<string> {
    this.asked.push(label);
    const answer = this.answers.secret?.shift();
    if (answer === undefined) throw new Error(`unexpected secret prompt: ${label}`);
    return answer;
  }

  async text(label: string): Promise<string> {
    this.asked.push(label);
    const answer = this.answers.text?.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${label}`);
    return answer;
  }

  async confirm(question: string): Promise<ConfirmAnswer> {
    this.asked.push(question);
    const answer = this.answers.confirm?.shift();
    if (answer === undefined) throw new Error(`unexpected confirmation: ${question}`);
    return answer;
  }
}

/** SIGINT on demand. */
export class FakeSignals {
  readonly #emitter = new EventEmitter();
  onInterrupt(handler: () => void): () => void {
    this.#emitter.on('SIGINT', handler);
    return () => this.#emitter.off('SIGINT', handler);
  }
  interrupt(): void {
    this.#emitter.emit('SIGINT');
  }
  get listeners(): number {
    return this.#emitter.listenerCount('SIGINT');
  }
}

/** What a fake statement produces: rows (with columns), a status, or an error. */
export type FakeResult =
  | { readonly columns: readonly ColumnMeta[]; readonly rows: readonly (readonly CellValue[])[] }
  | { readonly command: string; readonly rowsAffected: number | null }
  | { readonly error: JoineryError }
  /** Runs until cancelled. */
  | { readonly hang: true };

export function column(name: string, kind: ColumnMeta['kind'] = 'string'): ColumnMeta {
  return { name, nativeType: kind, kind };
}

/**
 * An in-memory Session: `respond` maps statement text to a result. Records executed text,
 * params and cancels.
 */
export class FakeSession implements Session {
  readonly executed: { text: string; params: ExecOptions['params'] }[] = [];
  readonly cancelled: string[] = [];
  closed = false;
  inTransaction = false;
  readonly serverVersion: string;
  #running = new Map<string, () => void>();

  constructor(
    readonly engine: EngineId,
    private readonly respond: (text: string) => FakeResult,
    readonly pageSize = 2,
  ) {
    this.serverVersion =
      engine === 'postgres' ? '16.4' : engine === 'mariadb' ? '10.11.6-MariaDB' : '8.4.2';
  }

  capabilities(): Capabilities {
    return BASE_CAPABILITIES[this.engine];
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    this.executed.push({ text, params: opts.params });
    return this.#run(text, opts);
  }

  async *#run(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    const result = this.respond(text);
    if ('error' in result) throw result.error;
    if ('hang' in result) {
      await new Promise<void>((resolve) => {
        this.#running.set(opts.executionId, resolve);
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw cancelledError('Query cancelled');
    }
    if ('command' in result) {
      yield { type: 'status', command: result.command, rowsAffected: result.rowsAffected };
      yield { type: 'end', durationMs: 1, rowCount: 0 };
      return;
    }
    yield { type: 'columns', resultIndex: 0, columns: result.columns };
    for (let i = 0; i < result.rows.length; i += this.pageSize) {
      const page = result.rows.slice(i, i + this.pageSize);
      yield toColumnChunk(0, result.columns.length, page);
    }
    yield { type: 'status', command: 'SELECT', rowsAffected: result.rows.length };
    yield { type: 'end', durationMs: 1, rowCount: result.rows.length };
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.push(executionId);
    this.#running.get(executionId)?.();
  }

  /** What `introspect` returns; tests change it to simulate a deployed script. */
  snapshot: SchemaSnapshot | undefined;

  async introspect(): Promise<SchemaSnapshot> {
    if (!this.snapshot) throw new Error('no snapshot');
    return this.snapshot;
  }

  async browse(): Promise<BrowseNode[]> {
    return [];
  }

  async ping(): Promise<void> {}

  async rollback(): Promise<void> {
    this.inTransaction = false;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** An adapter that hands out one session and records the profiles it was asked to open. */
export class FakeAdapter implements DriverAdapter {
  readonly connects: ResolvedProfile[] = [];
  constructor(
    readonly engine: EngineId,
    private readonly session: FakeSession,
    private readonly failConnect?: (resolved: ResolvedProfile) => JoineryError | undefined,
  ) {}

  capabilities(): Capabilities {
    return BASE_CAPABILITIES[this.engine];
  }

  async connect(resolved: ResolvedProfile): Promise<Session> {
    this.connects.push(resolved);
    const error = this.failConnect?.(resolved);
    if (error) throw error;
    return this.session;
  }

  async *checkConnection(resolved: ResolvedProfile): AsyncIterable<ConnectionCheckResult> {
    this.connects.push(resolved);
    yield { step: 'dns', status: 'skipped', durationMs: 0, message: 'IP address' };
    yield { step: 'tcp', status: 'ok', durationMs: 1, message: 'Connected' };
    const error = this.failConnect?.(resolved);
    if (error) {
      yield {
        step: 'auth',
        status: 'failed',
        durationMs: 1,
        message: error.message,
        hint: error.hint ?? 'Check it',
      };
      return;
    }
    yield { step: 'auth', status: 'ok', durationMs: 1, message: 'Logged in' };
  }
}

/** Hands out a session per database name (the URI path), for commands with two targets. */
export class RoutingAdapter implements DriverAdapter {
  constructor(
    readonly engine: EngineId,
    private readonly sessions: Readonly<Record<string, FakeSession>>,
  ) {}

  capabilities(): Capabilities {
    return BASE_CAPABILITIES[this.engine];
  }

  async connect(resolved: ResolvedProfile): Promise<Session> {
    const database = resolved.profile.options.defaultDatabase ?? '';
    const session = this.sessions[database];
    if (!session) throw new Error(`no fake session for database "${database}"`);
    return session;
  }
}

export interface RunOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: InputStream;
  readonly prompter?: Prompter;
  readonly session?: FakeSession;
  readonly adapter?: DriverAdapter;
  readonly signals?: FakeSignals;
  readonly stdoutTTY?: boolean;
  readonly columns?: number;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the whole CLI in-process against fakes. */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const stdout = new MemoryStream({
    isTTY: options.stdoutTTY ?? false,
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
  });
  const stderr = new MemoryStream();
  const session =
    options.session ?? new FakeSession('postgres', () => ({ command: 'SELECT', rowsAffected: 0 }));
  const adapter: DriverAdapter = options.adapter ?? new FakeAdapter(session.engine, session);
  const ctx: CliContext = {
    stdout,
    stderr,
    stdin: options.stdin ?? memoryInput([], true),
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    homedir: '/home/test',
    cwd: options.cwd ?? process.cwd(),
    prompter: options.prompter ?? new ScriptedPrompter(false),
    signals: options.signals ?? new FakeSignals(),
    adapters: () => adapter,
    now: () => 0,
  };
  const code = await runCli(argv, ctx);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** A temporary directory, removed by the returned cleanup. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'joinery-cli-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
