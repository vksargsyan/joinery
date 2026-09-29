import {
  JoineryError,
  fromErrorData,
  newId,
  type ConnectionProfile,
  type ErrorData,
  type ResolvedProfile,
} from '@joinery/core';
import type { ConnectionEvent, ConnectionState, ServerInfo } from '@joinery/ipc';

import { hostToMainSchema, type HostRequest, type HostToMain } from '../shared/host-protocol';
import type { HostProcess, HostProcessFactory } from './host-process';
import { answerHostKeyRequest, isPermanentFailure, type HostKeyVerification } from './host-keys';

/**
 * Spawns and supervises one connection host per open connection (spec §3, §18). A host that
 * crashes after it was ready is restarted with exponential backoff, reconnecting with the same
 * resolved profile; other connections and the UI are unaffected. Every state change is published
 * so the renderer can show it: its MessagePort to the dead host closes, and once the host is ready
 * again `open` hands out a fresh one.
 *
 * A host whose SSH tunnel drops reports `failed` and is restarted the same way, which reopens the
 * tunnel. A failure that retrying cannot fix (a changed or refused host key, rejected
 * credentials) ends the restarts at once. Host key questions from a host go to `hostKeys`; the
 * ready timeout waits while the user answers one.
 */

export interface SupervisorOptions<P> {
  readonly spawn: HostProcessFactory<P>;
  /** Delay before each restart attempt, in ms; the last value repeats. */
  readonly backoffMs?: readonly number[];
  /** Consecutive restarts before the connection is given up as failed. */
  readonly maxRestarts?: number;
  /** A host that stayed up this long starts again from the first backoff step. */
  readonly stableAfterMs?: number;
  /** How long a host may take to connect before it counts as failed. */
  readonly readyTimeoutMs?: number;
  /** Grace period for `shutdown` before the process is killed. */
  readonly shutdownGraceMs?: number;
  /** Answers the hosts' SSH host key questions; without it every host key is refused. */
  readonly hostKeys?: HostKeyVerification;
  readonly now?: () => number;
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 5_000, 10_000];

export interface OpenedConnection {
  readonly connectionId: string;
  readonly info: ServerInfo;
}

interface Waiter {
  resolve(value: OpenedConnection): void;
  reject(error: JoineryError): void;
}

/** A HostRequest waiting for the host's `response`. */
interface PendingRequest {
  readonly connectionId: string;
  readonly process: unknown;
  resolve(value: unknown): void;
  reject(error: JoineryError): void;
  progress?(progress: { readonly bytes: number; readonly total?: number | undefined }): void;
}

interface Connection<P> {
  readonly connectionId: string;
  readonly profileId: string;
  readonly label: string;
  readonly resolved: ResolvedProfile;
  state: ConnectionState;
  process: HostProcess<P> | undefined;
  info: ServerInfo | undefined;
  /** Consecutive restart attempts since the host was last stable. */
  attempts: number;
  readySince: number | undefined;
  waiters: Waiter[];
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  readyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Host key questions the current process is waiting on. */
  pendingHostKeys: number;
}

export class ConnectionSupervisor<P> {
  readonly #spawn: HostProcessFactory<P>;
  readonly #backoff: readonly number[];
  readonly #maxRestarts: number;
  readonly #stableAfterMs: number;
  readonly #readyTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #hostKeys: HostKeyVerification | undefined;
  readonly #now: () => number;
  readonly #connections = new Map<string, Connection<P>>();
  readonly #listeners = new Set<(event: ConnectionEvent) => void>();
  readonly #starting = new Map<string, Promise<OpenedConnection>>();
  readonly #requests = new Map<string, PendingRequest>();

  constructor(options: SupervisorOptions<P>) {
    this.#spawn = options.spawn;
    this.#backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#maxRestarts = options.maxRestarts ?? 5;
    this.#stableAfterMs = options.stableAfterMs ?? 60_000;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.#hostKeys = options.hostKeys;
    this.#now = options.now ?? (() => Date.now());
    if (this.#backoff.length === 0) throw new RangeError('backoffMs needs at least one delay');
  }

  /** The live connection for a profile (connecting, ready or restarting), if any. */
  findByProfile(profileId: string): { connectionId: string; state: ConnectionState } | undefined {
    for (const connection of this.#connections.values()) {
      if (connection.profileId === profileId && connection.state !== 'failed') {
        return { connectionId: connection.connectionId, state: connection.state };
      }
    }
    return undefined;
  }

  /** Every connection's current state, for a subscriber that joins late. */
  snapshot(): ConnectionEvent[] {
    return [...this.#connections.values()].map((c) => this.#event(c));
  }

  /**
   * Opens a connection for the profile, or joins the one already open (waiting while it
   * connects or restarts). `resolve` supplies the profile with its secrets and is only called
   * when a new host has to start. Rejects with the host's error, e.g. AUTH_FAILED.
   */
  open(
    profileId: string,
    resolve: () => ResolvedProfile | Promise<ResolvedProfile>,
  ): Promise<OpenedConnection> {
    const existing = this.#liveFor(profileId);
    if (existing) return this.#whenReady(existing);
    // Concurrent opens of the same profile share one start (and one secret resolution).
    const starting = this.#starting.get(profileId);
    if (starting) return starting;
    const started = this.#start(profileId, resolve).finally(() => {
      this.#starting.delete(profileId);
    });
    this.#starting.set(profileId, started);
    return started;
  }

  async #start(
    profileId: string,
    resolve: () => ResolvedProfile | Promise<ResolvedProfile>,
  ): Promise<OpenedConnection> {
    const resolved = await resolve();
    const connection: Connection<P> = {
      connectionId: newId(),
      profileId,
      label: `Joinery connection: ${resolved.profile.name}`,
      resolved,
      state: 'connecting',
      process: undefined,
      info: undefined,
      attempts: 0,
      readySince: undefined,
      waiters: [],
      restartTimer: undefined,
      readyTimer: undefined,
      pendingHostKeys: 0,
    };
    this.#connections.set(connection.connectionId, connection);
    const ready = this.#whenReady(connection);
    this.#publish(connection);
    this.#launch(connection);
    return ready;
  }

  /** Transfers `port` to the connection's host, which serves the connection host contract on it. */
  attach(connectionId: string, port: P): void {
    const connection = this.#connections.get(connectionId);
    if (!connection || connection.state !== 'ready' || !connection.process) {
      throw new JoineryError({
        code: 'CONNECTION_FAILED',
        message: 'The connection is not ready',
        hint: 'Reconnect and try again.',
      });
    }
    connection.process.send({ type: 'attach' }, [port]);
  }

  /** The profile a connection's host runs with (its write rules), if the connection is live. */
  profileOf(connectionId: string): ConnectionProfile | undefined {
    return this.#connections.get(connectionId)?.resolved.profile;
  }

  /**
   * Hands a connection's host work that does not go through the renderer's port (GridFS files
   * moved by path) and resolves with its result. Aborting `signal` cancels it on the host; a host
   * that exits or restarts meanwhile fails it with CONNECTION_FAILED.
   */
  request(
    connectionId: string,
    request: HostRequest,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: PendingRequest['progress'];
    } = {},
  ): Promise<unknown> {
    const connection = this.#connections.get(connectionId);
    const process = connection?.process;
    if (!connection || connection.state !== 'ready' || !process) {
      return Promise.reject(
        new JoineryError({
          code: 'CONNECTION_FAILED',
          message: 'The connection is not ready',
          hint: 'Reconnect and try again.',
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const requestId = newId();
      const { signal } = options;
      const onAbort = (): void => {
        try {
          process.send({ type: 'cancel-request', requestId });
        } catch {
          // Gone already: the exit fails the request.
        }
      };
      const settle = (): void => {
        this.#requests.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
      };
      this.#requests.set(requestId, {
        connectionId,
        process,
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        ...(options.onProgress ? { progress: options.onProgress } : {}),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        process.send({ type: 'request', requestId, request });
      } catch (error) {
        this.#requests.get(requestId)?.reject(asError(error, 'The connection host is gone'));
        return;
      }
      if (signal?.aborted) onAbort();
    });
  }

  /** Fails the requests a host process was running (it exited or was replaced). */
  #failRequests(process: unknown, message: string): void {
    for (const pending of [...this.#requests.values()]) {
      if (pending.process !== process) continue;
      pending.reject(new JoineryError({ code: 'CONNECTION_FAILED', message }));
    }
  }

  /** Shuts the host down for good. Unknown ids are ignored. */
  close(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (!connection) return;
    this.#connections.delete(connectionId);
    this.#clearTimers(connection);
    const process = connection.process;
    connection.process = undefined;
    connection.state = 'closed';
    this.#rejectWaiters(
      connection,
      new JoineryError({ code: 'CANCELLED', message: 'The connection was closed' }),
    );
    this.#publish(connection);
    if (process) {
      try {
        process.send({ type: 'shutdown' });
      } catch {
        // Already gone.
      }
      setTimeout(() => process.kill(), this.#shutdownGraceMs).unref?.();
    }
  }

  /** Closes every connection of a profile (it was deleted or edited). */
  closeProfile(profileId: string): void {
    for (const connection of [...this.#connections.values()]) {
      if (connection.profileId === profileId) this.close(connection.connectionId);
    }
  }

  closeAll(): void {
    for (const id of [...this.#connections.keys()]) this.close(id);
  }

  subscribe(listener: (event: ConnectionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #liveFor(profileId: string): Connection<P> | undefined {
    for (const connection of this.#connections.values()) {
      if (connection.profileId !== profileId) continue;
      if (connection.state === 'failed') {
        this.#connections.delete(connection.connectionId);
        continue;
      }
      return connection;
    }
    return undefined;
  }

  #whenReady(connection: Connection<P>): Promise<OpenedConnection> {
    if (connection.state === 'ready' && connection.info) {
      return Promise.resolve({ connectionId: connection.connectionId, info: connection.info });
    }
    return new Promise((resolve, reject) => connection.waiters.push({ resolve, reject }));
  }

  #launch(connection: Connection<P>): void {
    let process: HostProcess<P>;
    try {
      process = this.#spawn(connection.label);
    } catch (error) {
      this.#startFailed(connection, asError(error, 'The connection host could not start'));
      return;
    }
    connection.process = process;
    connection.pendingHostKeys = 0;
    process.onMessage((raw) => this.#onMessage(connection, process, raw));
    process.onExit((code) => this.#onExit(connection, process, code));
    this.#armReadyTimer(connection, process);
    try {
      process.send({ type: 'connect', resolved: connection.resolved });
    } catch (error) {
      this.#startFailed(connection, asError(error, 'The connection host could not be reached'));
    }
  }

  #armReadyTimer(connection: Connection<P>, process: HostProcess<P>): void {
    if (connection.readyTimer) clearTimeout(connection.readyTimer);
    connection.readyTimer = setTimeout(() => {
      if (connection.process !== process) return;
      this.#startFailed(
        connection,
        new JoineryError({
          code: 'TIMEOUT',
          message: 'The connection host did not connect in time',
        }),
      );
    }, this.#readyTimeoutMs);
  }

  /** Asks about a host key; the ready timeout waits while the user compares the fingerprint. */
  async #answerHostKey(
    connection: Connection<P>,
    process: HostProcess<P>,
    request: Extract<HostToMain, { type: 'host-key' }>,
  ): Promise<void> {
    const current = (): boolean => connection.process === process;
    connection.pendingHostKeys += 1;
    if (connection.readyTimer) clearTimeout(connection.readyTimer);
    connection.readyTimer = undefined;
    try {
      await answerHostKeyRequest(
        process,
        request,
        this.#hostKeys,
        { profileName: connection.resolved.profile.name, purpose: 'connect' },
        current,
      );
    } finally {
      if (current()) {
        connection.pendingHostKeys -= 1;
        const waiting = connection.state === 'connecting' || connection.state === 'restarting';
        if (connection.pendingHostKeys === 0 && waiting) this.#armReadyTimer(connection, process);
      }
    }
  }

  #onMessage(connection: Connection<P>, process: HostProcess<P>, raw: unknown): void {
    if (connection.process !== process) return;
    const parsed = hostToMainSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'ready') {
      if (connection.readyTimer) clearTimeout(connection.readyTimer);
      connection.readyTimer = undefined;
      connection.state = 'ready';
      connection.info = message.info;
      connection.readySince = this.#now();
      this.#publish(connection);
      const opened = { connectionId: connection.connectionId, info: message.info };
      for (const waiter of connection.waiters.splice(0)) waiter.resolve(opened);
    } else if (message.type === 'failed') {
      this.#startFailed(connection, fromErrorData(message.error));
    } else if (message.type === 'host-key') {
      void this.#answerHostKey(connection, process, message);
    } else if (message.type === 'request-progress') {
      const pending = this.#requests.get(message.requestId);
      if (pending?.process === process) pending.progress?.(message.progress);
    } else if (message.type === 'response') {
      const pending = this.#requests.get(message.requestId);
      if (pending?.process !== process) return;
      if (message.error) pending.reject(fromErrorData(message.error));
      else pending.resolve(message.result);
    }
  }

  #onExit(connection: Connection<P>, process: HostProcess<P>, code: number | null): void {
    this.#failRequests(process, 'The connection host stopped before the transfer finished');
    if (connection.process !== process) return;
    connection.process = undefined;
    const reason = new JoineryError({
      code: 'CONNECTION_FAILED',
      message:
        code === null
          ? 'The connection host crashed'
          : `The connection host exited unexpectedly (code ${code})`,
    });
    if (connection.state === 'ready') {
      this.#scheduleRestart(connection, reason);
    } else {
      this.#startFailed(connection, reason);
    }
  }

  /** A start (first or restart) failed: the first start reports to its callers, restarts retry. */
  #startFailed(connection: Connection<P>, error: JoineryError): void {
    if (connection.readyTimer) clearTimeout(connection.readyTimer);
    connection.readyTimer = undefined;
    const process = connection.process;
    connection.process = undefined;
    process?.kill();
    if (!this.#connections.has(connection.connectionId)) return;
    if (connection.state === 'connecting') {
      this.#connections.delete(connection.connectionId);
      connection.state = 'failed';
      this.#publish(connection, error.message);
      this.#rejectWaiters(connection, error);
      return;
    }
    if (isPermanentFailure(error)) {
      connection.state = 'failed';
      this.#publish(connection, withHint(error));
      this.#rejectWaiters(connection, error);
      return;
    }
    this.#scheduleRestart(connection, error);
  }

  #scheduleRestart(connection: Connection<P>, reason: JoineryError): void {
    const stable =
      connection.readySince !== undefined &&
      this.#now() - connection.readySince >= this.#stableAfterMs;
    connection.readySince = undefined;
    if (stable) connection.attempts = 0;
    connection.attempts += 1;
    if (connection.attempts > this.#maxRestarts) {
      connection.state = 'failed';
      this.#publish(connection, `${reason.message}; gave up after ${this.#maxRestarts} restarts`);
      this.#rejectWaiters(connection, reason);
      return;
    }
    connection.state = 'restarting';
    this.#publish(connection, reason.message);
    const delay =
      this.#backoff[Math.min(connection.attempts - 1, this.#backoff.length - 1)] ??
      this.#backoff[0]!;
    connection.restartTimer = setTimeout(() => {
      connection.restartTimer = undefined;
      if (this.#connections.get(connection.connectionId) !== connection) return;
      this.#launch(connection);
    }, delay);
  }

  #rejectWaiters(connection: Connection<P>, error: JoineryError): void {
    for (const waiter of connection.waiters.splice(0)) waiter.reject(error);
  }

  #clearTimers(connection: Connection<P>): void {
    if (connection.restartTimer) clearTimeout(connection.restartTimer);
    if (connection.readyTimer) clearTimeout(connection.readyTimer);
    connection.restartTimer = undefined;
    connection.readyTimer = undefined;
  }

  #event(connection: Connection<P>, message?: string): ConnectionEvent {
    return {
      connectionId: connection.connectionId,
      profileId: connection.profileId,
      state: connection.state,
      ...(connection.state === 'restarting' ? { attempt: connection.attempts } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  #publish(connection: Connection<P>, message?: string): void {
    const event = this.#event(connection, message);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not stop supervision.
      }
    }
  }
}

/** The message and its fix hint, for an event the user reads without the error object. */
function withHint(error: JoineryError): string {
  return error.hint ? `${error.message.replace(/\.$/, '')}. ${error.hint}` : error.message;
}

function asError(error: unknown, message: string): JoineryError {
  if (error instanceof JoineryError) return error;
  const data: ErrorData = { code: 'INTERNAL', message };
  if (error instanceof Error) data.detail = error.message;
  return new JoineryError(data);
}
