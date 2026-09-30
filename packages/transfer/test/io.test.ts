import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bytesSource,
  fileSink,
  fileSource,
  gunzip,
  gzipSink,
  memorySink,
  readableSource,
  writableSink,
  type ByteSource,
} from '../src';
import { concatBytes, openInput, peekSource } from '../src/io';

async function collect(source: ByteSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return concatBytes(chunks);
}

/** Splits bytes at the given sizes (cycled). */
function chunked(bytes: Uint8Array, sizes: readonly number[]): ByteSource {
  return {
    async *[Symbol.asyncIterator]() {
      let at = 0;
      let i = 0;
      while (at < bytes.length) {
        const size = Math.max(1, sizes[i++ % sizes.length] ?? 1);
        yield bytes.subarray(at, at + size);
        at += size;
      }
    },
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'joinery-transfer-io-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gzip', () => {
  it('round-trips through gzipSink and gunzip for any data and chunking (fast-check)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 5000 }),
        fc.array(fc.integer({ min: 1, max: 700 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 5 }),
        async (data, writeSizes, readSizes) => {
          const sink = memorySink();
          const zipped = gzipSink(sink);
          for await (const chunk of chunked(data, writeSizes)) await zipped.write(chunk);
          await zipped.close();
          expect(sink.closed).toBe(true);
          const back = await collect(gunzip(chunked(sink.bytes(), readSizes)));
          expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reads concatenated gzip members as one stream', async () => {
    const both = concatBytes([gzipSync('hello '), gzipSync('world')]);
    expect(Buffer.from(await collect(gunzip(chunked(both, [3])))).toString()).toBe('hello world');
  });

  it('fails on corrupt data', async () => {
    const bad = concatBytes([gzipSync('hello').subarray(0, 12), new Uint8Array([1, 2, 3, 4])]);
    await expect(collect(gunzip(bytesSource(bad)))).rejects.toThrow();
  });

  it('openInput detects gzip by its magic number and counts compressed bytes', async () => {
    const text = 'a,b\n1,2\n'.repeat(1000);
    const zipped = gzipSync(text);
    const input = await openInput(chunked(zipped, [1, 7, 100]));
    expect(input.compression).toBe('gzip');
    expect(Buffer.from(await collect(input.source)).toString()).toBe(text);
    expect(input.count()).toBe(zipped.length);
    const plainInput = await openInput(bytesSource(text));
    expect(plainInput.compression).toBe('none');
    expect(Buffer.from(await collect(plainInput.source)).toString()).toBe(text);
  });
});

describe('sources and sinks', () => {
  it('peekSource returns the head and replays it before the rest', async () => {
    const data = randomBytes(1000);
    const peeked = await peekSource(chunked(data, [10]), 25);
    expect(peeked.head.length).toBeGreaterThanOrEqual(25);
    expect(peeked.ended).toBe(false);
    expect(Buffer.from(await collect(peeked.source)).equals(data)).toBe(true);
    const small = await peekSource(bytesSource('abc'), 100);
    expect(small.ended).toBe(true);
  });

  it('writes files with backpressure, optionally gzipped, and reads them back', async () => {
    const data = randomBytes(300_000);
    const path = join(dir, 'data.bin.gz');
    const sink = fileSink(path, { gzip: true });
    for await (const chunk of chunked(data, [4096, 70_000])) await sink.write(chunk);
    await sink.close();
    const back = await collect(gunzip(fileSource(path, { highWaterMark: 1000 })));
    expect(Buffer.from(back).equals(data)).toBe(true);
  });

  it('removes a partial file on abort', async () => {
    const path = join(dir, 'partial.csv');
    const sink = fileSink(path);
    await sink.write(new TextEncoder().encode('a,b\n'));
    await sink.abort(new Error('stop'));
    await expect(stat(path)).rejects.toThrow();
  });

  it('writableSink waits for drain and closes the stream', async () => {
    const stream = new PassThrough({ highWaterMark: 16 });
    const sink = writableSink(stream);
    const received: Buffer[] = [];
    const reading = (async () => {
      for await (const chunk of stream) received.push(chunk as Buffer);
    })();
    for (let i = 0; i < 50; i++) await sink.write(new TextEncoder().encode(`line ${i}\n`));
    await sink.close();
    await reading;
    expect(Buffer.concat(received).toString().split('\n')).toHaveLength(51);
  });

  it('readableSource turns string chunks into UTF-8 bytes', async () => {
    const stream = new PassThrough({ objectMode: true });
    stream.end('é');
    const bytes = await collect(readableSource(stream));
    expect(Buffer.from(bytes).toString('utf8')).toBe('é');
  });

  it('fileSource streams a file lazily', async () => {
    const path = join(dir, 'lazy.txt');
    const sink = fileSink(path);
    await sink.write(new TextEncoder().encode('x'.repeat(10_000)));
    await sink.close();
    let chunks = 0;
    for await (const chunk of fileSource(path, { highWaterMark: 1024 })) {
      chunks++;
      expect(chunk.length).toBeLessThanOrEqual(1024);
    }
    expect(chunks).toBe(10);
    expect((await readFile(path)).length).toBe(10_000);
  });
});
