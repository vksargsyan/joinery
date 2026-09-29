import { JoineryError, errorCodeSchema } from '@joinery/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createClient,
  defineContract,
  fromDomPort,
  fromElectronPort,
  serve,
  type HandlersOf,
  type RpcStream,
} from '../src';
import { deferred, fakeElectronPort, nodeChannel, portPair, sleep } from './helpers';

const contract = defineContract({
  add: {
    input: z.object({ a: z.number(), b: z.number().default(0) }),
    output: z.number(),
  },
  echo: {
    input: z.object({
      big: z.bigint(),
      bytes: z.instanceof(Uint8Array),
      nested: z.array(z.bigint()),
    }),
    output: z.object({
      big: z.bigint(),
      bytes: z.instanceof(Uint8Array),
      nested: z.array(z.bigint()),
    }),
  },
  wait: {
    input: z.object({ steps: z.number().int() }),
    output: z.string(),
    progress: z.object({ done: z.number() }),
  },
  fail: {
    input: z.object({ code: errorCodeSchema, plain: z.boolean().default(false) }),
    output: z.void(),
  },
  count: {
    input: z.object({ n: z.number().int(), failAt: z.number().int().optional() }),
    item: z.number(),
    progress: z.string(),
  },
  nested: {
    deeper: { hello: { input: z.void(), output: z.literal('hi') } },
  },
});

type Handlers = HandlersOf<typeof contract>;

const baseHandlers: Handlers = {
  add: ({ a, b }) => a + b,
  echo: (value) => value,
  wait: async ({ steps }, { progress }) => {
    for (let done = 1; done <= steps; done++) {
      await sleep(1);
      progress({ done });
    }
    return `waited ${steps}`;
  },
  fail: ({ code, plain }) => {
    if (plain) throw new Error('boom');
    throw new JoineryError({
      code,
      message: 'it failed',
      detail: 'details',
      hint: 'try again',
      sqlState: '42601',
      engineCode: 1064,
      position: 7,
    });
  },
  count: async function* ({ n, failAt }, { progress }) {
    progress('starting');
    for (let i = 0; i < n; i++) {
      if (i === failAt) throw new JoineryError({ code: 'SQL_ERROR', message: `failed at ${i}` });
      yield i;
    }
  },
  nested: { deeper: { hello: () => 'hi' as const } },
};

function setup(handlers: Partial<Handlers> = {}, streamWindow?: number) {
  const ports = portPair();
  const server = serve(ports.server, contract, { ...baseHandlers, ...handlers });
  const client = createClient(ports.client, contract, streamWindow ? { streamWindow } : {});
  return { client, server, ports };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function rejection(promise: Promise<unknown>): Promise<JoineryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JoineryError);
    return error as JoineryError;
  }
  throw new Error('Expected a rejection');
}

describe('types', () => {
  it('infers client and handler types from the contract', () => {
    const { client } = setup();
    // Callers pass z.input (defaults optional) and get z.output.
    expectTypeOf(client.add).parameter(0).toEqualTypeOf<{ a: number; b?: number | undefined }>();
    expectTypeOf(client.add).returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf(client.count).returns.toEqualTypeOf<RpcStream<number>>();
    expectTypeOf(client.nested.deeper.hello).returns.toEqualTypeOf<Promise<'hi'>>();
    // Handlers receive z.output (defaults applied).
    expectTypeOf<Parameters<Handlers['add']>[0]>().toEqualTypeOf<{ a: number; b: number }>();
    // onProgress exists only where a progress schema does.
    expectTypeOf<Parameters<typeof client.wait>[1]>().toEqualTypeOf<
      | {
          readonly signal?: AbortSignal;
          readonly onProgress?: (progress: { done: number }) => void;
        }
      | undefined
    >();
    expectTypeOf<Parameters<typeof client.add>[1]>().toEqualTypeOf<
      { readonly signal?: AbortSignal } | undefined
    >();
    // A void input may be omitted.
    expectTypeOf(client.nested.deeper.hello).toBeCallableWith();
  });
});

describe('unary calls', () => {
  it('round-trips input and output, applying defaults', async () => {
    const { client } = setup();
    await expect(client.add({ a: 2, b: 3 })).resolves.toBe(5);
    await expect(client.add({ a: 2 })).resolves.toBe(2);
    await expect(client.nested.deeper.hello()).resolves.toBe('hi');
  });

  it('keeps bigint and Uint8Array intact through structured clone', async () => {
    const { client } = setup();
    const input = {
      big: 2n ** 70n,
      bytes: new Uint8Array([0, 1, 254, 255]),
      nested: [-(2n ** 63n), 0n],
    };
    const output = await client.echo(input);
    expect(output.big).toBe(2n ** 70n);
    expect(output.bytes).toBeInstanceOf(Uint8Array);
    expect([...output.bytes]).toEqual([0, 1, 254, 255]);
    expect(output.nested).toEqual([-(2n ** 63n), 0n]);
  });

  it('delivers progress events in order before the result', async () => {
    const { client } = setup();
    const events: number[] = [];
    const result = await client.wait({ steps: 4 }, { onProgress: (p) => events.push(p.done) });
    expect(result).toBe('waited 4');
    expect(events).toEqual([1, 2, 3, 4]);
  });

  it('carries error codes and fields across the port', async () => {
    const { client } = setup();
    const error = await rejection(client.fail({ code: 'SQL_ERROR' }));
    expect(error.toJSON()).toEqual({
      code: 'SQL_ERROR',
      message: 'it failed',
      detail: 'details',
      hint: 'try again',
      sqlState: '42601',
      engineCode: 1064,
      position: 7,
    });
    expect((await rejection(client.fail({ code: 'AUTH_FAILED' }))).code).toBe('AUTH_FAILED');
    const plain = await rejection(client.fail({ code: 'SQL_ERROR', plain: true }));
    expect(plain.code).toBe('INTERNAL');
    expect(plain.message).toBe('boom');
  });

  it('cancels a running call when the signal aborts', async () => {
    const started = deferred();
    let handlerSignal: AbortSignal | undefined;
    const { client } = setup({
      wait: (_input, { signal }) => {
        handlerSignal = signal;
        started.resolve();
        return new Promise<string>(() => {});
      },
    });
    const controller = new AbortController();
    const call = client.wait({ steps: 1 }, { signal: controller.signal });
    await started.promise;
    controller.abort();
    expect((await rejection(call)).code).toBe('CANCELLED');
    await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
    expect(handlerSignal?.reason).toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects at once for an already aborted signal without calling the handler', async () => {
    const add = vi.fn(() => 1);
    const { client } = setup({ add });
    const error = await rejection(client.add({ a: 1 }, { signal: AbortSignal.abort() }));
    expect(error.code).toBe('CANCELLED');
    await sleep(5);
    expect(add).not.toHaveBeenCalled();
  });

  it('multiplexes many concurrent calls', async () => {
    const { client } = setup({
      add: async ({ a, b }) => {
        await sleep(a % 7);
        return a + b;
      },
    });
    const unary = Array.from({ length: 500 }, (_, i) => client.add({ a: i, b: 1 }));
    const streams = Array.from({ length: 20 }, (_, i) => collect(client.count({ n: i })));
    const [sums, lists] = await Promise.all([Promise.all(unary), Promise.all(streams)]);
    expect(sums).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    lists.forEach((list, i) => expect(list).toEqual(Array.from({ length: i }, (_, j) => j)));
  });
});

describe('streams', () => {
  it('streams items in order and ends', async () => {
    const { client } = setup();
    const progress: string[] = [];
    const items = await collect(client.count({ n: 25 }, { onProgress: (p) => progress.push(p) }));
    expect(items).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(progress).toEqual(['starting']);
  });

  it('never lets the producer run more than the window ahead of a slow consumer', async () => {
    const window = 3;
    let produced = 0;
    let consumed = 0;
    let maxAhead = 0;
    const { client } = setup(
      {
        count: async function* ({ n }) {
          for (let i = 0; i < n; i++) {
            produced++;
            maxAhead = Math.max(maxAhead, produced - consumed);
            yield i;
          }
        },
      },
      window,
    );
    for await (const _item of client.count({ n: 30 })) {
      consumed++;
      await sleep(2);
    }
    expect(consumed).toBe(30);
    // The server prefetches a full window, and never more.
    expect(maxAhead).toBe(window);
  });

  it('holds the producer while nobody reads', async () => {
    let produced = 0;
    const { client } = setup({
      count: async function* ({ n }) {
        for (let i = 0; i < n; i++) {
          produced++;
          yield i;
        }
      },
    });
    const stream = client.count({ n: 1000 });
    await sleep(30);
    expect(produced).toBe(4);
    await stream.return();
  });

  it('closes the server iterator when the consumer breaks early', async () => {
    let produced = 0;
    let closed = false;
    let abortedInFinally: boolean | undefined;
    const { client } = setup({
      count: async function* ({ n }, { signal }) {
        try {
          for (let i = 0; i < n; i++) {
            produced++;
            yield i;
          }
        } finally {
          closed = true;
          abortedInFinally = signal.aborted;
        }
      },
    });
    for await (const item of client.count({ n: 10_000 })) {
      if (item === 2) break;
    }
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(abortedInFinally).toBe(true);
    expect(produced).toBeLessThan(10);
  });

  it('closes the server iterator on return()', async () => {
    const closed = deferred();
    const { client } = setup({
      count: async function* () {
        try {
          for (let i = 0; ; i++) yield i;
        } finally {
          closed.resolve();
        }
      },
    });
    const stream = client.count({ n: 0 });
    expect(await stream.next()).toEqual({ done: false, value: 0 });
    expect(await stream.return()).toEqual({ done: true, value: undefined });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    await closed.promise;
  });

  it('cancels mid-stream when the signal aborts, even while the handler is busy', async () => {
    const closed = deferred();
    let handlerSignal: AbortSignal | undefined;
    const { client } = setup({
      count: async function* (_input, { signal }) {
        handlerSignal = signal;
        try {
          yield 0;
          yield 1;
          // A slow driver fetch that only ends when the call is cancelled.
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          yield 2;
        } finally {
          closed.resolve();
        }
      },
    });
    const controller = new AbortController();
    const seen: number[] = [];
    const error = await rejection(
      (async () => {
        for await (const item of client.count({ n: 0 }, { signal: controller.signal })) {
          seen.push(item);
          if (item === 1) setTimeout(() => controller.abort(), 5);
        }
      })(),
    );
    expect(error.code).toBe('CANCELLED');
    expect(seen).toEqual([0, 1]);
    await closed.promise;
    expect(handlerSignal?.aborted).toBe(true);
  });

  it('delivers items received before an error, then throws it with its code', async () => {
    const { client } = setup();
    const seen: number[] = [];
    const error = await rejection(
      (async () => {
        for await (const item of client.count({ n: 10, failAt: 3 })) seen.push(item);
      })(),
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(error.code).toBe('SQL_ERROR');
    expect(error.message).toBe('failed at 3');
  });

  it('reports a handler that returns no iterable', async () => {
    const { client } = setup({
      count: (() => 42) as unknown as Handlers['count'],
    });
    const error = await rejection(collect(client.count({ n: 1 })));
    expect(error.code).toBe('INTERNAL');
  });
});

describe('validation', () => {
  const loose = defineContract({
    add: { input: z.unknown(), output: z.unknown() },
    count: { input: z.unknown(), item: z.unknown() },
    wait: { input: z.unknown(), output: z.unknown(), progress: z.unknown() },
  });

  it('rejects bad input on the client without sending it', async () => {
    const add = vi.fn(() => 0);
    const { client } = setup({ add });
    const error = await rejection(client.add({ a: 'x' as unknown as number }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('input for add');
    const streamError = await rejection(collect(client.count({ n: 1.5 })));
    expect(streamError.code).toBe('VALIDATION_FAILED');
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects bad input on the server, which keeps serving', async () => {
    const add = vi.fn(({ a, b }: { a: number; b: number }) => a + b);
    const count = vi.fn(baseHandlers.count);
    const ports = portPair();
    serve(ports.server, contract, { ...baseHandlers, add, count });
    const client = createClient(ports.client, loose);
    expect((await rejection(client.add({ a: 'x' }))).code).toBe('VALIDATION_FAILED');
    expect((await rejection(collect(client.count({ n: 'x' })))).code).toBe('VALIDATION_FAILED');
    expect(add).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    await expect(client.add({ a: 1, b: 2 })).resolves.toBe(3);
  });

  it('rejects bad output, items and progress on the server before sending', async () => {
    const closed = deferred();
    const { client } = setup({
      add: () => 'three' as unknown as number,
      count: async function* () {
        try {
          yield 1;
          yield 'two' as unknown as number;
          yield 3;
        } finally {
          closed.resolve();
        }
      },
      wait: (_input, { progress }) => {
        progress({ done: 'x' as unknown as number });
        return 'unreachable';
      },
    });
    const output = await rejection(client.add({ a: 1 }));
    expect(output.code).toBe('VALIDATION_FAILED');
    expect(output.message).toContain('output of add');

    const seen: number[] = [];
    const item = await rejection(
      (async () => {
        for await (const value of client.count({ n: 3 })) seen.push(value);
      })(),
    );
    expect(item.code).toBe('VALIDATION_FAILED');
    expect(seen).toEqual([1]);
    await closed.promise;

    expect((await rejection(client.wait({ steps: 1 }))).code).toBe('VALIDATION_FAILED');
  });

  it('rejects bad output, items and progress on the client', async () => {
    const ports = portPair();
    const closed = deferred();
    serve(ports.server, loose, {
      add: () => 'three',
      count: async function* () {
        try {
          yield 1;
          yield 'two';
          yield 3;
        } finally {
          closed.resolve();
        }
      },
      wait: async (_input, { progress }) => {
        progress({ done: 'x' });
        await sleep(20);
        return 'done';
      },
    });
    const client = createClient(ports.client, contract);
    expect((await rejection(client.add({ a: 1 }))).code).toBe('VALIDATION_FAILED');

    const seen: number[] = [];
    const item = await rejection(
      (async () => {
        for await (const value of client.count({ n: 3 })) seen.push(value);
      })(),
    );
    expect(item.code).toBe('VALIDATION_FAILED');
    expect(seen).toEqual([1]);
    // The client cancels the server side after a bad item.
    await closed.promise;

    const progress = await rejection(client.wait({ steps: 1 }, { onProgress: () => {} }));
    expect(progress.code).toBe('VALIDATION_FAILED');
    expect(progress.message).toContain('progress of wait');
  });

  it('answers an unknown method with NOT_FOUND', async () => {
    const bigger = defineContract({
      ...contract.shape,
      missing: { input: z.void(), output: z.void() },
    });
    const ports = portPair();
    serve(ports.server, contract, baseHandlers);
    const client = createClient(ports.client, bigger);
    const error = await rejection(client.missing());
    expect(error.code).toBe('NOT_FOUND');
    await expect(client.add({ a: 1 })).resolves.toBe(1);
  });

  it('refuses a call whose kind differs from the server contract', async () => {
    const mismatched = defineContract({ add: { input: z.unknown(), item: z.unknown() } });
    const ports = portPair();
    serve(ports.server, contract, baseHandlers);
    const client = createClient(ports.client, mismatched);
    expect((await rejection(collect(client.add({ a: 1 })))).code).toBe('VALIDATION_FAILED');
  });

  it('ignores foreign traffic and answers malformed calls without crashing', async () => {
    const { port1, port2 } = nodeChannel();
    const add = vi.fn(({ a, b }: { a: number; b: number }) => a + b);
    serve(fromDomPort(port2), contract, { ...baseHandlers, add });
    const replies: unknown[] = [];
    port1.on('message', (data: unknown) => replies.push(data));
    port1.postMessage('hello');
    port1.postMessage({ unrelated: true });
    port1.postMessage({ $rpc: 1, t: 'call' });
    port1.postMessage({ $rpc: 1, t: 'call', id: 7, m: 42 });
    port1.postMessage({ $rpc: 1, t: 'nonsense', id: 8 });
    port1.postMessage({ $rpc: 1, t: 'call', id: 9, m: 'add', k: 'unary', i: { a: 1, b: 1 } });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies).toContainEqual(
      expect.objectContaining({
        t: 'error',
        id: 7,
        e: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      }),
    );
    expect(replies).toContainEqual(
      expect.objectContaining({
        t: 'error',
        id: 8,
        e: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      }),
    );
    expect(replies).toContainEqual({ $rpc: 1, t: 'result', id: 9, v: 2 });
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle', () => {
  it('fails pending calls with CONNECTION_FAILED when the port closes', async () => {
    const started = deferred();
    const signals: AbortSignal[] = [];
    const { client, ports } = setup({
      wait: (_input, { signal }) => {
        signals.push(signal);
        started.resolve();
        return new Promise<string>(() => {});
      },
      count: async function* (_input, { signal }) {
        signals.push(signal);
        yield 1;
        await new Promise(() => {});
      },
    });
    const unary = client.wait({ steps: 1 });
    const stream = client.count({ n: 1 });
    await started.promise;
    expect(await stream.next()).toEqual({ done: false, value: 1 });
    const pendingNext = stream.next();
    ports.raw.server.close();
    expect((await rejection(unary)).code).toBe('CONNECTION_FAILED');
    expect((await rejection(pendingNext)).code).toBe('CONNECTION_FAILED');
    expect((await rejection(client.add({ a: 1 }))).code).toBe('CONNECTION_FAILED');
    await vi.waitFor(() => expect(signals.every((s) => s.aborted)).toBe(true));
    expect(signals).toHaveLength(2);
  });

  it('client.dispose() cancels running calls and refuses new ones', async () => {
    const started = deferred();
    let handlerSignal: AbortSignal | undefined;
    const { client } = setup({
      wait: (_input, { signal }) => {
        handlerSignal = signal;
        started.resolve();
        return new Promise<string>(() => {});
      },
    });
    const call = client.wait({ steps: 1 });
    const stream = client.count({ n: 1_000_000 });
    await started.promise;
    client.dispose();
    expect((await rejection(call)).code).toBe('CANCELLED');
    expect((await rejection(stream.next())).code).toBe('CANCELLED');
    expect((await rejection(client.add({ a: 1 }))).code).toBe('CONNECTION_FAILED');
    await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
  });

  it('server.dispose() aborts handlers and fails their callers', async () => {
    const started = deferred();
    let handlerSignal: AbortSignal | undefined;
    const { client, server } = setup({
      wait: (_input, { signal }) => {
        handlerSignal = signal;
        started.resolve();
        return new Promise<string>(() => {});
      },
    });
    const call = client.wait({ steps: 1 });
    await started.promise;
    server.dispose();
    expect(handlerSignal?.aborted).toBe(true);
    expect((await rejection(call)).code).toBe('CONNECTION_FAILED');
  });
});

describe('shared ports', () => {
  it('runs a client and a server on each end of one port', async () => {
    const reverse = defineContract({
      shout: { input: z.string(), output: z.string() },
      letters: { input: z.string(), item: z.string() },
    });
    const { client: a, server: b } = portPair();
    serve(b, contract, baseHandlers);
    serve(a, reverse, {
      // Slow, so replies to the other direction arrive while these calls are pending.
      shout: async (text) => {
        await sleep(20);
        return text.toUpperCase();
      },
      letters: async function* (text) {
        yield* text;
      },
    });
    const forward = createClient(a, contract);
    const backward = createClient(b, reverse);
    const [sums, shouts, letters, counts] = await Promise.all([
      Promise.all([1, 2, 3].map((n) => forward.add({ a: n, b: n }))),
      Promise.all(['a', 'b'].map((text) => backward.shout(text))),
      collect(backward.letters('xyz')),
      collect(forward.count({ n: 3 })),
    ]);
    expect(sums).toEqual([2, 4, 6]);
    expect(shouts).toEqual(['A', 'B']);
    expect(letters).toEqual(['x', 'y', 'z']);
    expect(counts).toEqual([0, 1, 2]);
  });
});

describe('port adapters', () => {
  it('works over DOM-style ports', async () => {
    const { port1, port2 } = nodeChannel();
    serve(fromDomPort(port2), contract, baseHandlers);
    const client = createClient(fromDomPort(port1), contract);
    await expect(client.add({ a: 20, b: 22 })).resolves.toBe(42);
    expect(await collect(client.count({ n: 3 }))).toEqual([0, 1, 2]);
    const pending = client.wait({ steps: 1_000 });
    port2.close();
    expect((await rejection(pending)).code).toBe('CONNECTION_FAILED');
  });

  it('works over Electron-style MessagePortMain', async () => {
    const { port1, port2 } = nodeChannel();
    serve(fromElectronPort(fakeElectronPort(port2)), contract, baseHandlers);
    const client = createClient(fromElectronPort(fakeElectronPort(port1)), contract);
    await expect(client.add({ a: 1, b: 2 })).resolves.toBe(3);
    expect(await collect(client.count({ n: 5 }))).toEqual([0, 1, 2, 3, 4]);
    const pending = client.wait({ steps: 1_000 });
    port1.close();
    expect((await rejection(pending)).code).toBe('CONNECTION_FAILED');
  });
});

describe('defineContract', () => {
  it('rejects malformed and reserved entries', () => {
    expect(() => defineContract({ then: { input: z.void(), output: z.void() } })).toThrow(
      TypeError,
    );
    expect(() => defineContract({ dispose: { input: z.void(), output: z.void() } })).toThrow(
      TypeError,
    );
    expect(() => defineContract({ 'a.b': { input: z.void(), output: z.void() } })).toThrow(
      TypeError,
    );
    const both = { input: z.void(), output: z.void(), item: z.void() } as unknown as {
      input: z.ZodVoid;
      output: z.ZodVoid;
    };
    expect(() => defineContract({ both })).toThrow(/both an output and an item/);
    const notZod = { input: z.void(), output: 'string' } as unknown as {
      input: z.ZodVoid;
      output: z.ZodVoid;
    };
    expect(() => defineContract({ notZod })).toThrow(/zod schemas/);
  });

  it('flattens nested namespaces into dotted paths', () => {
    expect([...contract.methods.keys()]).toEqual([
      'add',
      'echo',
      'wait',
      'fail',
      'count',
      'nested.deeper.hello',
    ]);
    expect(contract.methods.get('count')?.kind).toBe('stream');
  });

  it('refuses to serve a contract with a missing handler', () => {
    const ports = portPair();
    const { add: _add, ...partial } = baseHandlers;
    expect(() => serve(ports.server, contract, partial as Handlers)).toThrow(
      /Missing handler for "add"/,
    );
  });
});
