import { createServer } from 'node:net';

import {
  connectionProfileSchema,
  type ConnectionProfileInput,
  type HostPort,
  type ResolvedProfile,
} from '@joinery/core';
import type { NodeRoute } from '@joinery/tunnel';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { buildRedisConnectionPlan } from '../src';
import { addressOf } from '../src/client';
import { NodeRouting } from '../src/routing';

/**
 * The NAT map behind a tunnel: known nodes map to their forwards, a node that appears later gets
 * a reserved forward at once, and none is ever mapped to its announced address directly.
 */

const now = '2026-09-29T10:00:00.000Z';

/** A port nothing listens on, so discovery fails fast and connecting is never attempted. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A node route that hands out made-up local ports; `spares` of them for `forwardNow`. */
function fakeRoute(spares: number, localPort: number) {
  const forwards = new Map<string, HostPort>();
  const asked: string[] = [];
  let reserved = 0;
  let next = 0;
  const local = (): HostPort => ({
    host: '127.0.0.1',
    port: next++ === 0 ? localPort : 50000 + next,
  });
  const route: NodeRoute = {
    socks5: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    async forward(target) {
      const key = `${target.host}:${target.port}`;
      asked.push(key);
      if (!forwards.has(key)) forwards.set(key, local());
      return forwards.get(key)!;
    },
    forwardNow(target) {
      const key = `${target.host}:${target.port}`;
      const known = forwards.get(key);
      if (known) return known;
      if (reserved === 0) return undefined;
      reserved -= 1;
      forwards.set(key, local());
      return forwards.get(key);
    },
    async reserve(count) {
      reserved = Math.min(count, spares);
    },
    get forwardCount() {
      return forwards.size;
    },
    channelCount: 0,
  };
  return { route, asked };
}

function plan(input: Partial<ConnectionProfileInput>, route: NodeRoute) {
  const resolved = {
    profile: connectionProfileSchema.parse({
      id: 'p',
      name: 'Redis',
      engine: 'redis',
      endpoint: { kind: 'cluster', seeds: [{ host: 'c1.internal', port: 7000 }] },
      ssh: { hops: [{ host: 'b', user: 'u', auth: { method: 'agent' } }] },
      tls: { mode: 'disable' },
      createdAt: now,
      updatedAt: now,
      ...input,
    }),
    secrets: {},
    endpointOverride: { host: '127.0.0.1', port: 1 },
    nodeRoute: route,
  } as ResolvedProfile;
  return buildRedisConnectionPlan(resolved);
}

describe('NodeRouting', () => {
  it('maps every announced address onto a forward, never onto itself', async () => {
    const { route, asked } = fakeRoute(1, await closedPort());
    const routing = await NodeRouting.open(plan({}, route), route);
    try {
      // The seed was forwarded first, keeping the name its certificate is checked against.
      expect(routing.seeds).toEqual([
        expect.objectContaining({ kind: 'tcp', host: '127.0.0.1', tlsHost: 'c1.internal' }),
      ]);
      expect(asked[0]).toBe('c1.internal:7000');
      const seed = routing.natMap('c1.internal:7000');
      expect(seed).toEqual({
        host: '127.0.0.1',
        port: routing.seeds[0]!.kind === 'tcp' ? routing.seeds[0]!.port : 0,
      });
      // A node announced later takes the reserved forward, synchronously.
      const later = routing.natMap('10.0.0.7:7001');
      expect(later).toMatchObject({ host: '127.0.0.1' });
      expect(later!.port).toBeGreaterThan(50000);
      expect(routing.natMap('10.0.0.7:7001')).toEqual(later);
      // With no forward to hand out, the address fails at once instead of bypassing the tunnel.
      expect(routing.natMap('10.0.0.8:7002')).toEqual({ host: '127.0.0.1', port: 0 });
      await Promise.resolve();
      expect(asked).toContain('10.0.0.8:7002');
      expect(routing.natMap('not an address')).toEqual({ host: '127.0.0.1', port: 0 });

      // A node on a forward shows the address it announced.
      const node = new Redis({ host: '127.0.0.1', port: later!.port, lazyConnect: true });
      expect(addressOf(node)).toBe('10.0.0.7:7001');
      node.disconnect();
    } finally {
      routing.release();
    }
    const node = new Redis({ host: '127.0.0.1', port: 50002, lazyConnect: true });
    expect(addressOf(node)).toBe('127.0.0.1:50002');
    node.disconnect();
  });

  it('checks each node’s certificate against the name it announced', async () => {
    const { route } = fakeRoute(0, await closedPort());
    const routing = await NodeRouting.open(plan({ tls: { mode: 'verify-full' } }, route), route);
    try {
      const mapped = routing.natMap('c1.internal:7000') as { tls?: { servername?: string } };
      expect(mapped.tls?.servername).toBe('c1.internal');
      const byIp = routing.nodeTls('10.0.0.9')!;
      expect(byIp.servername).toBeUndefined();
      const cert = { subject: { CN: 'x' }, subjectaltname: 'IP Address:10.0.0.9' };
      expect(byIp.checkServerIdentity!('127.0.0.1', cert as never)).toBeUndefined();
      expect(
        byIp.checkServerIdentity!('10.0.0.9', { subjectaltname: 'DNS:other' } as never),
      ).toBeInstanceOf(Error);
    } finally {
      routing.release();
    }
  });
});
