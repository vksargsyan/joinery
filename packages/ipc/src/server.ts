import { QuerybaraError, cancelledError, toErrorData } from '@querybara/core';

import {
  check,
  type Contract,
  type ContractShape,
  type HandlerContext,
  type HandlersOf,
  type MethodEntry,
} from './contract';
import type { PortLike } from './port';
import {
  MAX_STREAM_WINDOW,
  PROTOCOL_VERSION,
  callIdOf,
  clientMessageSchema,
  isRpcMessage,
  isServerMessageType,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

export interface Server {
  /**
   * Aborts every running handler (their signals fire and stream iterators are closed), answers
   * their callers with CONNECTION_FAILED and stops listening. The port is left open: the caller
   * owns it, and should close it next — calls sent after dispose() are not answered.
   */
  dispose(): void;
}

type AnyHandler = (input: unknown, context: HandlerContext<unknown>) => unknown;

interface ActiveCall {
  readonly controller: AbortController;
  /** Stream items the client can still take. */
  credit: number;
  /** Resumes a stream waiting for credit. */
  wake: (() => void) | undefined;
}

const ABORTED = Symbol('aborted');

/** Settles with `promise`, or with ABORTED as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    iterator.return?.().then(undefined, () => undefined);
  } catch {
    // A broken return() must not take the server down.
  }
}

function isFunction(value: unknown): value is AnyHandler {
  return typeof value === 'function';
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function resolveHandlers(contract: Contract, handlers: unknown): Map<string, AnyHandler> {
  const resolved = new Map<string, AnyHandler>();
  for (const path of contract.methods.keys()) {
    let node: unknown = handlers;
    for (const segment of path.split('.')) {
      node =
        typeof node === 'object' && node !== null && Object.hasOwn(node, segment)
          ? (node as Readonly<Record<string, unknown>>)[segment]
          : undefined;
    }
    if (!isFunction(node)) throw new TypeError(`Missing handler for "${path}"`);
    resolved.set(path, node);
  }
  return resolved;
}

class ServerCore {
  private readonly active = new Map<number, ActiveCall>();
  private readonly unsubscribe: readonly (() => void)[];
  private stopped = false;

  constructor(
    private readonly port: PortLike,
    private readonly contract: Contract,
    private readonly handlers: ReadonlyMap<string, AnyHandler>,
  ) {
    this.unsubscribe = [
      port.onMessage((data) => this.receive(data)),
      port.onClose(() => this.stop(undefined)),
    ];
  }

  /** Posts a message; false when it cannot be sent (a value structured clone rejects). */
  private send(message: ServerMessage): boolean {
    try {
      this.port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  private sendError(id: number, error: unknown): void {
    this.send({ $rpc: PROTOCOL_VERSION, t: 'error', id, e: toErrorData(error) });
  }

  /** Sends a result or item, or an INTERNAL error when the value cannot be cloned. */
  private sendValue(message: ServerMessage & { readonly v: unknown }, path: string): boolean {
    if (this.send(message)) return true;
    this.sendError(
      message.id,
      new QuerybaraError({ code: 'INTERNAL', message: `The result of ${path} cannot be sent` }),
    );
    return false;
  }

  private isLive(id: number, call: ActiveCall): boolean {
    return this.active.get(id) === call && !call.controller.signal.aborted;
  }

  private abort(id: number): void {
    const call = this.active.get(id);
    if (call === undefined) return;
    this.active.delete(id);
    call.controller.abort(cancelledError());
    call.wake?.();
  }

  private receive(data: unknown): void {
    if (this.stopped || !isRpcMessage(data) || isServerMessageType(data)) return;
    const parsed = clientMessageSchema.safeParse(data);
    if (!parsed.success) {
      // Answer what can be answered, so a malformed call fails instead of hanging.
      const id = callIdOf(data);
      if (id !== undefined) {
        this.abort(id);
        this.sendError(
          id,
          new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'Malformed RPC message' }),
        );
      }
      return;
    }
    const message = parsed.data;
    switch (message.t) {
      case 'call':
        return this.call(message);
      case 'cancel':
        return this.abort(message.id);
      case 'credit': {
        const call = this.active.get(message.id);
        if (call === undefined) return;
        call.credit = Math.min(call.credit + message.n, MAX_STREAM_WINDOW);
        call.wake?.();
        return;
      }
    }
  }

  private call(message: Extract<ClientMessage, { t: 'call' }>): void {
    const { id } = message;
    if (this.active.has(id)) return;
    const entry = this.contract.methods.get(message.m);
    const handler = this.handlers.get(message.m);
    if (entry === undefined || handler === undefined) {
      return this.sendError(
        id,
        new QuerybaraError({ code: 'NOT_FOUND', message: `Unknown method "${message.m}"` }),
      );
    }
    if (entry.kind !== message.k) {
      return this.sendError(
        id,
        new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `${entry.path} is a ${entry.kind} method`,
        }),
      );
    }
    const input = check(entry.input, message.i, `input for ${entry.path}`);
    if (!input.ok) return this.sendError(id, input.error);

    const call: ActiveCall = {
      controller: new AbortController(),
      credit: message.w ?? 1,
      wake: undefined,
    };
    this.active.set(id, call);
    const context: HandlerContext<unknown> = {
      signal: call.controller.signal,
      progress: (value) => {
        if (!this.isLive(id, call)) return;
        if (entry.progress === undefined) {
          throw new QuerybaraError({
            code: 'INTERNAL',
            message: `${entry.path} declares no progress events`,
          });
        }
        const checked = check(entry.progress, value, `progress of ${entry.path}`);
        if (!checked.ok) throw checked.error;
        this.send({ $rpc: PROTOCOL_VERSION, t: 'progress', id, v: checked.value });
      },
    };
    if (entry.kind === 'unary') void this.runUnary(id, call, entry, handler, input.value, context);
    else void this.runStream(id, call, entry, handler, input.value, context);
  }

  private async runUnary(
    id: number,
    call: ActiveCall,
    entry: MethodEntry,
    handler: AnyHandler,
    input: unknown,
    context: HandlerContext<unknown>,
  ): Promise<void> {
    try {
      const output = await handler(input, context);
      if (!this.isLive(id, call)) return;
      const checked = check(entry.result, output, `output of ${entry.path}`);
      if (checked.ok) {
        this.sendValue({ $rpc: PROTOCOL_VERSION, t: 'result', id, v: checked.value }, entry.path);
      } else {
        this.sendError(id, checked.error);
      }
    } catch (error) {
      if (this.isLive(id, call)) this.sendError(id, error);
    } finally {
      if (this.active.get(id) === call) this.active.delete(id);
    }
  }

  /**
   * Pulls items from the handler's iterator only while the client has credit, so a slow consumer
   * holds the producer (and its database cursor) back. Stopping early — cancel, dispose, port
   * closed, an invalid item — closes the iterator so the handler's `finally` runs.
   */
  private async runStream(
    id: number,
    call: ActiveCall,
    entry: MethodEntry,
    handler: AnyHandler,
    input: unknown,
    context: HandlerContext<unknown>,
  ): Promise<void> {
    const { signal } = call.controller;
    let iterator: AsyncIterator<unknown> | undefined;
    let exhausted = false;
    try {
      const iterable = handler(input, context);
      if (!isAsyncIterable(iterable)) {
        throw new QuerybaraError({
          code: 'INTERNAL',
          message: `The handler for ${entry.path} did not return an async iterable`,
        });
      }
      iterator = iterable[Symbol.asyncIterator]();
      for (;;) {
        while (call.credit <= 0 && !signal.aborted) {
          await new Promise<void>((resolve) => {
            call.wake = resolve;
          });
          call.wake = undefined;
        }
        if (signal.aborted) break;
        const step = await raceAbort(iterator.next(), signal);
        if (step === ABORTED) break;
        if (step.done) {
          exhausted = true;
          if (this.isLive(id, call)) this.send({ $rpc: PROTOCOL_VERSION, t: 'end', id });
          break;
        }
        call.credit--;
        const checked = check(entry.result, step.value, `item of ${entry.path}`);
        if (!checked.ok) {
          this.sendError(id, checked.error);
          break;
        }
        if (
          !this.sendValue({ $rpc: PROTOCOL_VERSION, t: 'item', id, v: checked.value }, entry.path)
        ) {
          break;
        }
      }
    } catch (error) {
      // The iterator threw, so it is already closed.
      exhausted = true;
      if (this.isLive(id, call)) this.sendError(id, error);
    } finally {
      if (this.active.get(id) === call) this.active.delete(id);
      if (iterator !== undefined && !exhausted) closeIterator(iterator);
    }
  }

  /** Aborts every call; with an error, also tells their callers. */
  stop(error: QuerybaraError | undefined): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...this.active.keys()]) {
      if (error) this.sendError(id, error);
      this.abort(id);
    }
  }

  dispose(): void {
    this.stop(
      new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'The RPC server was disposed' }),
    );
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}

/**
 * Serves `contract` on `port` with `handlers`: plain objects nested like the contract, one
 * function per method (own properties; they are called without `this`). A missing handler
 * throws here rather than at call time.
 *
 * Every incoming message is validated with zod: the envelope, then the input against the method's
 * schema. A bad message is answered with VALIDATION_FAILED and an unknown method with NOT_FOUND;
 * neither reaches a handler or disturbs other calls. Handler results, items and progress events
 * are validated before they are sent, and thrown errors cross as ErrorData, so the caller gets a
 * QuerybaraError with the original code.
 */
export function serve<C extends ContractShape>(
  port: PortLike,
  contract: Contract<C>,
  handlers: HandlersOf<C>,
): Server {
  const core = new ServerCore(port, contract, resolveHandlers(contract, handlers));
  return { dispose: () => core.dispose() };
}
