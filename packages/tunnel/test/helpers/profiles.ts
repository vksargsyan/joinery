import { connect as netConnect, type Socket } from 'node:net';

import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@joinery/core';

/** A resolved postgres profile pointing at `target`, with the given tunnel settings. */
export function resolvedWith(
  input: Partial<ConnectionProfileInput>,
  secrets: Record<string, string> = {},
): ResolvedProfile {
  const profile = connectionProfileSchema.parse({
    id: 'p1',
    name: 'Tunnelled',
    engine: 'postgres',
    endpoint: { kind: 'host', host: '127.0.0.1', port: 5432 },
    tls: { mode: 'disable' },
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...input,
  });
  return { profile, secrets };
}

/** An SSH hop to an in-process server on 127.0.0.1. */
export function hop(
  port: number,
  auth: NonNullable<ConnectionProfileInput['ssh']>['hops'][number]['auth'],
  user = 'tunnel',
  host = '127.0.0.1',
) {
  return { host, port, user, auth };
}

export function connectLocal(endpoint: { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(endpoint);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Sends `message` through an echo endpoint and returns what came back. */
export async function echo(
  endpoint: { host: string; port: number },
  message = 'ping through the tunnel',
): Promise<string> {
  const socket = await connectLocal(endpoint);
  try {
    return await new Promise<string>((resolve, reject) => {
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString();
        if (received.length >= message.length) resolve(received);
      });
      socket.once('error', reject);
      socket.once('close', () => resolve(received));
      socket.write(message);
    });
  } finally {
    socket.destroy();
  }
}

/** Waits until `condition` holds, polling every 10 ms, or fails after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
