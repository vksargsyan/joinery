import { QuerybaraError } from '@querybara/core';

import { isPortMessage } from '../../../shared/bridge';

/**
 * Receives the MessagePorts main hands to the page (ADR 0004). The preload re-posts each one to
 * this window; only messages from this window, on this origin, in the exact PortMessage shape and
 * carrying exactly one port are accepted. Ports can arrive before or after the RPC that asked for
 * them, so they are kept until claimed.
 */

type Waiter = { resolve(port: MessagePort): void; reject(error: Error): void };

const arrived = new Map<string, MessagePort>();
const waiting = new Map<string, Waiter>();
let listening = false;

function keyOf(message: { kind: 'main' } | { kind: 'connection'; connectionId: string }): string {
  return message.kind === 'main' ? 'main' : `connection:${message.connectionId}`;
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!isPortMessage(event.data) || event.ports.length !== 1) return;
    const port = event.ports[0]!;
    const key = keyOf(event.data);
    const waiter = waiting.get(key);
    if (waiter) {
      waiting.delete(key);
      waiter.resolve(port);
      return;
    }
    arrived.get(key)?.close();
    arrived.set(key, port);
  });
}

function claim(key: string, timeoutMs: number): Promise<MessagePort> {
  listen();
  const ready = arrived.get(key);
  if (ready) {
    arrived.delete(key);
    return Promise.resolve(ready);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(key);
      reject(new QuerybaraError({ code: 'TIMEOUT', message: 'The app did not answer in time' }));
    }, timeoutMs);
    waiting.set(key, {
      resolve: (port) => {
        clearTimeout(timer);
        resolve(port);
      },
      reject,
    });
  });
}

/** Asks main for the main-contract port and waits for it. */
export function requestMainPort(timeoutMs = 10_000): Promise<MessagePort> {
  listen();
  const port = claim('main', timeoutMs);
  window.querybara.requestMainPort();
  return port;
}

/** The port main transferred for `openConnection`'s connection. */
export function connectionPort(connectionId: string, timeoutMs = 10_000): Promise<MessagePort> {
  return claim(`connection:${connectionId}`, timeoutMs);
}
