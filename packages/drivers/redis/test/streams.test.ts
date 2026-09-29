import { describe, expect, it } from 'vitest';

import { DropQueue } from '../src/streams';

interface Item {
  readonly n: number;
  readonly dropped: number;
}

describe('DropQueue', () => {
  it('hands items to a waiting consumer and buffers the rest', async () => {
    let closed = 0;
    const queue = new DropQueue<Item>(10, async () => {
      closed += 1;
    });
    const waiting = queue.next();
    queue.push({ n: 1 });
    queue.push({ n: 2 });
    expect(await waiting).toEqual({ value: { n: 1, dropped: 0 }, done: false });
    expect(await queue.next()).toEqual({ value: { n: 2, dropped: 0 }, done: false });
    await queue.return();
    expect(closed).toBe(1);
  });

  it('drops the oldest items when the consumer falls behind, and says how many', async () => {
    const queue = new DropQueue<Item>(3, async () => undefined);
    for (let n = 1; n <= 5; n++) queue.push({ n });
    expect(await queue.next()).toEqual({ value: { n: 3, dropped: 2 }, done: false });
    expect(await queue.next()).toEqual({ value: { n: 4, dropped: 0 }, done: false });
  });

  it('ends pending and later reads, with an error when given one', async () => {
    const queue = new DropQueue<Item>(3, async () => undefined);
    const waiting = queue.next();
    queue.end();
    expect(await waiting).toEqual({ value: undefined, done: true });
    queue.push({ n: 1 });
    expect(await queue.next()).toEqual({ value: undefined, done: true });
    const failing = new DropQueue<Item>(3, async () => undefined);
    const pending = failing.next();
    failing.end(new Error('lost'));
    await expect(pending).rejects.toThrow('lost');
  });
});
