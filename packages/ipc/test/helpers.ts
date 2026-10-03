import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';

import { QuerybaraError } from '@querybara/core';
import { afterEach } from 'vitest';

import {
  fromNodePort,
  type ContractShape,
  type ElectronMessagePortLike,
  type HandlersOf,
  type PortLike,
} from '../src';

const open: MessagePort[] = [];

afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

/** A worker_threads channel, closed after the test. */
export function nodeChannel(): { readonly port1: MessagePort; readonly port2: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  return { port1, port2 };
}

/** Two connected PortLikes: `client` for createClient, `server` for serve. */
export function portPair(): {
  readonly client: PortLike;
  readonly server: PortLike;
  readonly raw: { readonly client: MessagePort; readonly server: MessagePort };
} {
  const { port1, port2 } = nodeChannel();
  return {
    client: fromNodePort(port1),
    server: fromNodePort(port2),
    raw: { client: port1, server: port2 },
  };
}

/**
 * An EventEmitter shaped like Electron's MessagePortMain over a worker_threads port: messages
 * arrive as `{ data, ports }` and are queued until start(), as Electron does.
 */
export function fakeElectronPort(port: MessagePort): ElectronMessagePortLike {
  const emitter = new EventEmitter();
  port.on('close', () => emitter.emit('close'));
  let started = false;
  return Object.assign(emitter, {
    postMessage(message: unknown) {
      port.postMessage(message);
    },
    start() {
      if (started) return;
      started = true;
      port.on('message', (data: unknown) => emitter.emit('message', { data, ports: [] }));
    },
    close() {
      port.close();
    },
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise with its resolver exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Handlers for every method of a contract namespace that fail with NOT_SUPPORTED, for tests that
 * serve a whole contract but exercise only part of it.
 */
export function unusedHandlers<S extends ContractShape>(shape: S): HandlersOf<S> {
  const refuse = (path: string): never => {
    throw new QuerybaraError({ code: 'NOT_SUPPORTED', message: `${path} is not used here` });
  };
  const build = (node: ContractShape, prefix: string): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(node).map(([name, def]) => {
        const path = prefix === '' ? name : `${prefix}.${name}`;
        if ('item' in def && def.item !== undefined) {
          return [
            name,
            // eslint-disable-next-line require-yield
            async function* () {
              refuse(path);
            },
          ];
        }
        if ('output' in def && def.output !== undefined) return [name, () => refuse(path)];
        return [name, build(def as ContractShape, path)];
      }),
    );
  return build(shape, '') as HandlersOf<S>;
}
