/**
 * The one thing RPC needs from a message port. Querybara moves messages over three port kinds —
 * DOM `MessagePort` in the renderer, Electron `MessagePortMain` in the main and utility processes,
 * and `node:worker_threads` `MessagePort` in tests — and each has its own event API. Adapters
 * below bring them all to this shape. Messages are posted as-is, so they go through structured
 * clone: bigint, Uint8Array and nested arrays arrive intact, and nothing is JSON-encoded.
 */
export interface PortLike {
  postMessage(message: unknown): void;
  /** Subscribes to incoming messages and starts delivery. Returns an unsubscribe function. */
  onMessage(listener: (data: unknown) => void): () => void;
  /**
   * Subscribes to the port closing, from either end where the port kind reports it.
   * Returns an unsubscribe function.
   */
  onClose(listener: () => void): () => void;
  close(): void;
}

/** The subset of the DOM `MessagePort` the adapter uses (renderer; also Node's MessagePort). */
export interface DomMessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'close', listener: (event: unknown) => void): void;
  removeEventListener(type: 'message' | 'close', listener: (event: unknown) => void): void;
  start(): void;
  close(): void;
}

/**
 * The subset of Electron's `MessagePortMain` the adapter uses, typed structurally so this package
 * never imports Electron. Its `message` event carries `{ data, ports }`.
 */
export interface ElectronMessagePortLike {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  removeListener(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

/** The subset of worker_threads' `MessagePort` the adapter uses; `message` carries the value. */
export interface NodeMessagePortLike {
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  removeListener(event: 'message', listener: (value: unknown) => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
  postMessage(value: unknown): void;
  start(): void;
  close(): void;
}

function dataOf(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'data' in event ? event.data : undefined;
}

/**
 * Adapts a DOM `MessagePort`. The `close` event is reported by Chromium 123+ (Electron 30+);
 * older runtimes never fire it, so pending calls then only fail on `dispose()`.
 */
export function fromDomPort(port: DomMessagePortLike): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      const handle = (event: unknown): void => listener(dataOf(event));
      port.addEventListener('message', handle);
      port.start();
      return () => port.removeEventListener('message', handle);
    },
    onClose(listener) {
      const handle = (): void => listener();
      port.addEventListener('close', handle);
      return () => port.removeEventListener('close', handle);
    },
    close: () => port.close(),
  };
}

/** Adapts an Electron `MessagePortMain` (main process and utility processes). */
export function fromElectronPort(port: ElectronMessagePortLike): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      const handle = (event: { readonly data: unknown }): void => listener(event.data);
      port.on('message', handle);
      port.start();
      return () => port.removeListener('message', handle);
    },
    onClose(listener) {
      const handle = (): void => listener();
      port.on('close', handle);
      return () => port.removeListener('close', handle);
    },
    close: () => port.close(),
  };
}

/** Adapts a `node:worker_threads` `MessagePort` (tests, worker threads). */
export function fromNodePort(port: NodeMessagePortLike): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      const handle = (value: unknown): void => listener(value);
      port.on('message', handle);
      port.start();
      return () => port.removeListener('message', handle);
    },
    onClose(listener) {
      const handle = (): void => listener();
      port.on('close', handle);
      return () => port.removeListener('close', handle);
    },
    close: () => port.close(),
  };
}
