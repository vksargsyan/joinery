import { JoineryError, cancelledError, errorDataSchema, fromErrorData } from '@joinery/core';

import {
  check,
  type ClientOf,
  type Contract,
  type ContractShape,
  type MethodEntry,
  type RpcStream,
} from './contract';
import type { PortLike } from './port';
import {
  MAX_STREAM_WINDOW,
  PROTOCOL_VERSION,
  isRpcMessage,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

export interface ClientOptions {
  /**
   * Stream items the server may produce ahead of the consumer (default 4, max 64). Each item is
   * one ResultChunk of up to 1,000 rows, so the window bounds memory held for a slow consumer.
   */
  readonly streamWindow?: number;
}

/** A client for a contract: its methods, nested like the contract, plus `dispose()`. */
export type Client<C extends ContractShape> = ClientOf<C> & {
  /**
   * Cancels every running call (pending calls reject with CANCELLED, the server is told to stop)
   * and stops listening. Later calls reject with CONNECTION_FAILED. The port is left open: the
   * caller owns it.
   */
  dispose(): void;
};

export const DEFAULT_STREAM_WINDOW = 4;

type Options = { readonly signal?: AbortSignal; readonly onProgress?: (progress: unknown) => void };

interface PendingCall {
  receive(message: ServerMessage): void;
  /** Ends the call locally; `immediate` drops buffered stream items rather than delivering them. */
  fail(error: JoineryError, immediate: boolean): void;
}

function remoteError(data: unknown): JoineryError {
  const parsed = errorDataSchema.safeParse(data);
  if (parsed.success) return fromErrorData(parsed.data);
  return new JoineryError({ code: 'INTERNAL', message: 'The server sent a malformed error' });
}

function protocolError(path: string, message: ServerMessage): JoineryError {
  return new JoineryError({
    code: 'INTERNAL',
    message: `Unexpected "${message.t}" message for ${path}`,
  });
}

function connectionClosed(): JoineryError {
  return new JoineryError({ code: 'CONNECTION_FAILED', message: 'The connection was closed' });
}

class ClientCore {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closed: JoineryError | undefined;
  private readonly unsubscribe: readonly (() => void)[];

  constructor(
    private readonly port: PortLike,
    readonly window: number,
  ) {
    this.unsubscribe = [
      port.onMessage((data) => this.receive(data)),
      port.onClose(() => this.shutDown(connectionClosed(), false)),
    ];
  }

  /** Posts a message; returns the error when it cannot be sent (a value clone rejects). */
  send(message: ClientMessage): JoineryError | undefined {
    try {
      this.port.postMessage(message);
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new JoineryError({ code: 'VALIDATION_FAILED', message: `Cannot send: ${reason}` });
    }
  }

  /** Registers a call and sends it; returns an error when the call cannot start. */
  start(
    entry: MethodEntry,
    input: unknown,
    signal: AbortSignal | undefined,
    call: PendingCall,
  ): { readonly id: number } | { readonly error: JoineryError } {
    if (this.closed) return { error: this.closed };
    if (signal?.aborted) return { error: cancelledError() };
    const checked = check(entry.input, input, `input for ${entry.path}`);
    if (!checked.ok) return { error: checked.error };
    const id = this.nextId++;
    this.pending.set(id, call);
    const error = this.send({
      $rpc: PROTOCOL_VERSION,
      t: 'call',
      id,
      m: entry.path,
      k: entry.kind,
      i: checked.value,
      ...(entry.kind === 'stream' ? { w: this.window } : {}),
    });
    if (error) {
      this.pending.delete(id);
      return { error };
    }
    return { id };
  }

  /** Forgets a call and, when `cancel` is set, tells the server to stop it. */
  finish(id: number, cancel: boolean): void {
    if (!this.pending.delete(id)) return;
    if (cancel && !this.closed) this.send({ $rpc: PROTOCOL_VERSION, t: 'cancel', id });
  }

  grant(id: number, n: number): void {
    if (this.pending.has(id)) this.send({ $rpc: PROTOCOL_VERSION, t: 'credit', id, n });
  }

  private receive(data: unknown): void {
    if (!isRpcMessage(data)) return;
    const parsed = serverMessageSchema.safeParse(data);
    // A malformed message cannot be routed safely; the call it was meant for is left to its
    // signal, the port closing or dispose().
    if (!parsed.success) return;
    this.pending.get(parsed.data.id)?.receive(parsed.data);
  }

  shutDown(error: JoineryError, cancel: boolean): void {
    if (this.closed) return;
    const calls = [...this.pending];
    if (cancel) for (const [id] of calls) this.send({ $rpc: PROTOCOL_VERSION, t: 'cancel', id });
    this.closed = error;
    this.pending.clear();
    for (const [, call] of calls) call.fail(error, cancel);
  }

  dispose(): void {
    if (this.closed === undefined) {
      this.shutDown(
        new JoineryError({ code: 'CANCELLED', message: 'The RPC client was disposed' }),
        true,
      );
      this.closed = new JoineryError({
        code: 'CONNECTION_FAILED',
        message: 'The RPC client was disposed',
      });
    }
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}

/** Validates a progress event and hands it to the caller; returns an error that ends the call. */
function deliverProgress(
  entry: MethodEntry,
  value: unknown,
  onProgress: ((progress: unknown) => void) | undefined,
): JoineryError | undefined {
  if (entry.progress === undefined) {
    return new JoineryError({
      code: 'INTERNAL',
      message: `${entry.path} sent an undeclared progress event`,
    });
  }
  const checked = check(entry.progress, value, `progress of ${entry.path}`);
  if (!checked.ok) return checked.error;
  try {
    onProgress?.(checked.value);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new JoineryError({ code: 'INTERNAL', message: `onProgress threw: ${message}` });
  }
}

function callUnary(
  core: ClientCore,
  entry: MethodEntry,
  input: unknown,
  options: Options | undefined,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    let id = -1;
    const onAbort = (): void => settle(cancelledError(), true);
    const settle = (error: JoineryError | undefined, cancel: boolean, value?: unknown): void => {
      signal?.removeEventListener('abort', onAbort);
      core.finish(id, cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const call: PendingCall = {
      receive(message) {
        switch (message.t) {
          case 'result': {
            const checked = check(entry.result, message.v, `output of ${entry.path}`);
            if (checked.ok) settle(undefined, false, checked.value);
            else settle(checked.error, false);
            return;
          }
          case 'error':
            return settle(remoteError(message.e), false);
          case 'progress': {
            const error = deliverProgress(entry, message.v, options?.onProgress);
            if (error) settle(error, true);
            return;
          }
          default:
            return settle(protocolError(entry.path, message), true);
        }
      },
      fail: (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    };
    const started = core.start(entry, input, signal, call);
    if ('error' in started) return reject(started.error);
    id = started.id;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

interface Waiter {
  resolve(result: IteratorResult<unknown, undefined>): void;
  reject(error: unknown): void;
}

/**
 * The caller's end of a stream call. Items are buffered as they arrive (at most `window` of them,
 * since the server only sends against credit); credit is returned as the consumer takes items.
 * A terminal event from the server (end, error, port closed) is delivered after buffered items;
 * a local stop (abort, return(), dispose) takes effect immediately.
 */
class ClientStream implements RpcStream<unknown>, PendingCall {
  private readonly buffer: unknown[] = [];
  private readonly waiters: Waiter[] = [];
  /** The server side is running (registered with the core). */
  private live = false;
  /** Set once the server side has ended; delivered after the buffer drains. */
  private terminal: { readonly error: JoineryError | undefined } | undefined;
  /** Nothing more will be delivered. */
  private closed = false;
  private id = -1;
  private consumed = 0;
  private readonly grantEvery: number;
  private readonly onAbort = (): void => this.stop(cancelledError());

  constructor(
    private readonly core: ClientCore,
    private readonly entry: MethodEntry,
    input: unknown,
    private readonly options: Options | undefined,
  ) {
    this.grantEvery = Math.max(1, Math.floor(core.window / 2));
    const started = core.start(entry, input, options?.signal, this);
    if ('error' in started) {
      this.terminal = { error: started.error };
      return;
    }
    this.id = started.id;
    this.live = true;
    options?.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  next(): Promise<IteratorResult<unknown, undefined>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift();
      this.consumedOne();
      return Promise.resolve({ done: false, value });
    }
    if (this.terminal) {
      const { error } = this.terminal;
      this.terminal = undefined;
      this.closed = true;
      return error ? Promise.reject(error) : Promise.resolve(DONE);
    }
    if (this.closed) return Promise.resolve(DONE);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<unknown, undefined>> {
    this.stop(undefined);
    return Promise.resolve(DONE);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  receive(message: ServerMessage): void {
    switch (message.t) {
      case 'item': {
        const checked = check(this.entry.result, message.v, `item of ${this.entry.path}`);
        if (!checked.ok) return this.end(checked.error, true);
        const waiter = this.waiters.shift();
        if (waiter) {
          this.consumedOne();
          waiter.resolve({ done: false, value: checked.value });
        } else {
          this.buffer.push(checked.value);
        }
        return;
      }
      case 'end':
        return this.end(undefined, false);
      case 'error':
        return this.end(remoteError(message.e), false);
      case 'progress': {
        const error = deliverProgress(this.entry, message.v, this.options?.onProgress);
        if (error) this.end(error, true);
        return;
      }
      default:
        return this.end(protocolError(this.entry.path, message), true);
    }
  }

  fail(error: JoineryError, immediate: boolean): void {
    this.live = false;
    if (immediate) this.stop(error);
    else this.end(error, false);
  }

  private consumedOne(): void {
    if (!this.live) return;
    this.consumed++;
    if (this.consumed >= this.grantEvery) {
      this.core.grant(this.id, this.consumed);
      this.consumed = 0;
    }
  }

  private detach(cancel: boolean): void {
    this.options?.signal?.removeEventListener('abort', this.onAbort);
    if (this.live) this.core.finish(this.id, cancel);
    this.live = false;
  }

  /** The server side is over (or must be stopped): deliver buffered items, then `error` or done. */
  private end(error: JoineryError | undefined, cancel: boolean): void {
    if (this.closed || this.terminal) return;
    this.detach(cancel);
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.terminal = { error };
      return;
    }
    // Waiters only queue up while the buffer is empty.
    this.closed = true;
    if (error) waiter.reject(error);
    else waiter.resolve(DONE);
    this.settleWaiters();
  }

  /** Stops now, dropping buffered items: with `error` for abort and dispose, done for return(). */
  private stop(error: JoineryError | undefined): void {
    if (this.closed) return;
    this.detach(true);
    this.buffer.length = 0;
    const waiter = this.waiters.shift();
    if (waiter === undefined && error) {
      this.terminal = { error };
      return;
    }
    this.terminal = undefined;
    this.closed = true;
    if (waiter && error) waiter.reject(error);
    else waiter?.resolve(DONE);
    this.settleWaiters();
  }

  private settleWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve(DONE);
  }
}

function isNamespace(value: unknown): value is ContractShape {
  return typeof value === 'object' && value !== null;
}

function buildTree(
  core: ClientCore,
  contract: Contract,
  shape: ContractShape,
  prefix: string,
): object {
  const tree = {};
  for (const [name, def] of Object.entries(shape)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    const entry = contract.methods.get(path);
    let value: unknown;
    if (entry?.kind === 'unary') {
      value = (input?: unknown, options?: Options) => callUnary(core, entry, input, options);
    } else if (entry?.kind === 'stream') {
      value = (input?: unknown, options?: Options) => new ClientStream(core, entry, input, options);
    } else if (isNamespace(def)) {
      value = buildTree(core, contract, def, path);
    }
    Object.defineProperty(tree, name, { value, enumerable: true });
  }
  return tree;
}

/**
 * Creates a typed client for `contract` on `port`. Calls are multiplexed by id, so any number can
 * run at once. Every call validates its input before sending and the server's answer on receipt;
 * failures reject with a JoineryError (VALIDATION_FAILED, or the server's own error code).
 *
 * - Unary methods return a promise. `signal` cancels the call (it rejects with CANCELLED and the
 *   handler's signal aborts); `onProgress` receives validated progress events.
 * - Stream methods return an RpcStream. Leaving a `for await` loop early, calling `return()` or
 *   aborting `signal` cancels the server side. If the port closes, calls reject with
 *   CONNECTION_FAILED; streams deliver what they already received, then throw it.
 */
export function createClient<C extends ContractShape>(
  port: PortLike,
  contract: Contract<C>,
  options: ClientOptions = {},
): Client<C> {
  const window = options.streamWindow ?? DEFAULT_STREAM_WINDOW;
  if (!Number.isInteger(window) || window < 1 || window > MAX_STREAM_WINDOW) {
    throw new RangeError(`streamWindow must be an integer from 1 to ${MAX_STREAM_WINDOW}`);
  }
  const core = new ClientCore(port, window);
  const tree = buildTree(core, contract, contract.shape, '');
  Object.defineProperty(tree, 'dispose', { value: () => core.dispose() });
  return tree as Client<C>;
}
