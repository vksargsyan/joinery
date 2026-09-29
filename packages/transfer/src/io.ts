import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, type ZlibOptions } from 'node:zlib';

/**
 * Byte sources and sinks (spec §12). Every reader takes an `AsyncIterable<Uint8Array>` and
 * every writer a `Sink`, so files, sockets, gzip streams and in-memory buffers plug in alike
 * and the job runner, the CLI and the tests share one pipeline. Backpressure is end to end:
 * readers pull chunks only as fast as rows are written, and writers await `Sink.write` before
 * fetching the next page from the database.
 */

/**
 * Bytes flowing into a reader. Node.js Readable streams qualify as they are. Sources that can
 * also be read at any position (files, in-memory bytes) say so with `randomAccess`, which
 * formats that must seek (xlsx: a ZIP read from its central directory) use instead of
 * iterating; every other source is spooled to a temporary file for them.
 */
export interface ByteSource extends AsyncIterable<Uint8Array> {
  readonly randomAccess?: () => Promise<RandomAccessReader>;
}

/** Positioned reads of a source's bytes. */
export interface RandomAccessReader {
  readonly size: number;
  /** Reads `length` bytes at `position`; fewer only where the source ends. */
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Positioned reads of a file through one file handle. */
export async function openFileReader(path: string): Promise<RandomAccessReader> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    return {
      size,
      async read(position, length) {
        const count = Math.max(0, Math.min(length, size - position));
        const buffer = Buffer.allocUnsafe(count);
        let at = 0;
        while (at < count) {
          const { bytesRead } = await handle.read(buffer, at, count - at, position + at);
          if (bytesRead === 0) break;
          at += bytesRead;
        }
        return at === count ? buffer : buffer.subarray(0, at);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Positioned reads of bytes already in memory. */
export function memoryReader(bytes: Uint8Array): RandomAccessReader {
  return {
    size: bytes.length,
    read: async (position, length) =>
      bytes.subarray(Math.min(position, bytes.length), Math.min(position + length, bytes.length)),
    close: async () => undefined,
  };
}

/** A source copied to a temporary file; `close` removes the file. */
export interface SpooledSource {
  /** The copy: read it as often as needed, at any position. */
  readonly source: ByteSource;
  readonly size: number;
  close(): Promise<void>;
}

/**
 * Copies a source that can be read only once (stdin, a socket) into a temporary file, so it
 * can be previewed, then read again, or read at any position; memory stays flat.
 */
export async function spoolToFile(source: ByteSource): Promise<SpooledSource> {
  const dir = await mkdtemp(join(tmpdir(), 'joinery-spool-'));
  const path = join(dir, 'source');
  const remove = (): Promise<void> => rm(dir, { recursive: true, force: true });
  let size = 0;
  try {
    const sink = writableSink(createWriteStream(path));
    try {
      for await (const chunk of source) {
        size += chunk.length;
        await sink.write(chunk);
      }
      await sink.close();
    } catch (error) {
      await sink.abort(error);
      throw error;
    }
  } catch (error) {
    await remove();
    throw error;
  }
  return { source: fileSource(path), size, close: remove };
}

/**
 * Positioned reads of any source: its own `randomAccess` when it has one, else a copy spooled
 * to a temporary file (removed on close), so memory stays flat either way.
 */
export async function randomAccess(source: ByteSource): Promise<RandomAccessReader> {
  if (source.randomAccess !== undefined) return source.randomAccess();
  const spooled = await spoolToFile(source);
  try {
    const reader = await spooled.source.randomAccess!();
    return {
      size: reader.size,
      read: (position, length) => reader.read(position, length),
      async close() {
        await reader.close();
        await spooled.close();
      },
    };
  } catch (error) {
    await spooled.close();
    throw error;
  }
}

/** Where export bytes go. */
export interface Sink {
  /** Writes a chunk; resolves once the sink can take more (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  /** Flushes and closes; resolves once every byte has been handed off. */
  close(): Promise<void>;
  /** Closes without finishing, after a failure or cancellation (a file sink removes its file). */
  abort(reason?: unknown): Promise<void>;
}

export interface FileSourceOptions {
  /** Read size; defaults to 64 KiB. */
  readonly highWaterMark?: number;
  /** Byte offset to start at. */
  readonly start?: number;
}

/**
 * A file's bytes, read lazily in chunks. Iterating it again reopens the file; `randomAccess`
 * opens it for positioned reads (from the start of the file, whatever `start` says).
 */
export function fileSource(path: string, options: FileSourceOptions = {}): ByteSource {
  return {
    [Symbol.asyncIterator]: () =>
      createReadStream(path, {
        highWaterMark: options.highWaterMark ?? 64 * 1024,
        ...(options.start !== undefined ? { start: options.start } : {}),
      })[Symbol.asyncIterator](),
    randomAccess: () => openFileReader(path),
  };
}

/** A Node.js Readable (stdin, a socket, an HTTP body) as a ByteSource; strings are UTF-8. */
export async function* readableSource(stream: Readable): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') yield Buffer.from(chunk, 'utf8');
    else if (chunk instanceof Uint8Array) yield chunk;
    else throw new TypeError('The stream produced a chunk that is not bytes');
  }
}

/** In-memory bytes or text (UTF-8) as a source, optionally split into chunks. */
export function bytesSource(data: Uint8Array | string, chunkSize = 64 * 1024): ByteSource {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const size = Math.max(1, Math.floor(chunkSize));
  return {
    async *[Symbol.asyncIterator]() {
      for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
    },
    randomAccess: async () => memoryReader(bytes),
  };
}

/** True when the bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Decompresses a gzip stream (concatenated members included). Stopping early closes the
 * underlying source.
 */
export async function* gunzip(source: ByteSource): AsyncGenerator<Uint8Array> {
  const unzip = createGunzip();
  const done = pipeline(Readable.from(source, { objectMode: false }), unzip).catch(() => undefined);
  try {
    for await (const chunk of unzip as AsyncIterable<Uint8Array>) yield chunk;
  } finally {
    unzip.destroy();
    await done;
  }
}

/**
 * Reads at least `bytes` bytes of a source (fewer when it ends first) without losing them:
 * returns them, a source that replays them before the rest, and whether the source ended.
 */
export async function peekSource(
  source: ByteSource,
  bytes: number,
): Promise<{ head: Uint8Array; source: ByteSource; ended: boolean }> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let ended = false;
  while (length < bytes) {
    const next = await iterator.next();
    if (next.done === true) {
      ended = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  const head = concatBytes(chunks, length);
  const replay: ByteSource = {
    async *[Symbol.asyncIterator]() {
      try {
        if (head.length > 0) yield head;
        if (ended) return;
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) return;
          yield next.value;
        }
      } finally {
        if (!ended) await iterator.return?.();
      }
    },
  };
  return { head, source: replay, ended };
}

/**
 * Counts the bytes a source yields (for progress against a file size) and, when `decompress`
 * allows, unwraps gzip detected by its magic number. `count()` reports raw (compressed) bytes.
 */
export async function openInput(
  source: ByteSource,
  decompress: 'auto' | 'gzip' | 'none' = 'auto',
): Promise<{ source: ByteSource; compression: 'gzip' | 'none'; count: () => number }> {
  let total = 0;
  const counted: ByteSource = {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        total += chunk.length;
        yield chunk;
      }
    },
  };
  if (decompress === 'none') return { source: counted, compression: 'none', count: () => total };
  const peeked = await peekSource(counted, 2);
  const gzip = decompress === 'gzip' || isGzip(peeked.head);
  return {
    source: gzip ? gunzip(peeked.source) : peeked.source,
    compression: gzip ? 'gzip' : 'none',
    count: () => total,
  };
}

export function concatBytes(chunks: readonly Uint8Array[], length?: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = length ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sinks

export interface WritableSinkOptions {
  /** End the stream on close (default true; false for process.stdout). */
  readonly end?: boolean;
}

/** A Node.js Writable as a Sink: `write` waits for 'drain' when the stream's buffer is full. */
export function writableSink(stream: Writable, options: WritableSinkOptions = {}): Sink {
  const fail = (): Error | undefined =>
    stream.errored ?? (stream.destroyed ? new Error('The output stream was closed') : undefined);
  return {
    async write(chunk) {
      const error = fail();
      if (error) throw error;
      if (!stream.write(chunk)) await once(stream, 'drain');
    },
    async close() {
      const error = fail();
      if (error) throw error;
      if (options.end === false) {
        if (stream.writableNeedDrain) await once(stream, 'drain');
        return;
      }
      stream.end();
      await finished(stream);
    },
    async abort(reason) {
      if (options.end === false) return;
      stream.destroy(reason instanceof Error ? reason : undefined);
      await finished(stream).catch(() => undefined);
    },
  };
}

export interface FileSinkOptions {
  /** Compress with gzip; `true` or zlib options (level...). */
  readonly gzip?: boolean | ZlibOptions;
  /** Remove the partial file when the export fails or is cancelled (default true). */
  readonly removeOnAbort?: boolean;
  /** Open flags; 'w' (default) truncates, 'wx' refuses to overwrite. */
  readonly flags?: string;
}

/** A file as a Sink, optionally gzip-compressed. The file is created on the first write. */
export function fileSink(path: string, options: FileSinkOptions = {}): Sink {
  let inner: Sink | undefined;
  const open = (): Sink => {
    inner ??= writableSink(createWriteStream(path, { flags: options.flags ?? 'w' }));
    return inner;
  };
  const plain: Sink = {
    write: (chunk) => open().write(chunk),
    close: () => open().close(),
    async abort(reason) {
      if (!inner) return;
      await inner.abort(reason);
      if (options.removeOnAbort !== false) await unlink(path).catch(() => undefined);
    },
  };
  if (options.gzip === undefined || options.gzip === false) return plain;
  return gzipSink(plain, options.gzip === true ? {} : options.gzip);
}

/** Compresses everything written into another sink, with backpressure from that sink. */
export function gzipSink(inner: Sink, options: ZlibOptions = {}): Sink {
  const gzip = createGzip(options);
  let failure: unknown;
  const pump = (async () => {
    for await (const chunk of gzip as AsyncIterable<Uint8Array>) await inner.write(chunk);
  })().catch((error: unknown) => {
    failure ??= error;
    gzip.destroy();
  });
  const check = (): void => {
    if (failure !== undefined) throw failure;
  };
  return {
    async write(chunk) {
      check();
      if (!gzip.write(chunk)) {
        await Promise.race([once(gzip, 'drain'), pump]);
        check();
      }
    },
    async close() {
      check();
      gzip.end();
      await pump;
      check();
      await inner.close();
    },
    async abort(reason) {
      failure ??= reason ?? new Error('Aborted');
      gzip.destroy();
      await pump;
      await inner.abort(reason);
    },
  };
}

/** Collects bytes in memory: for previews, clipboard copies and tests. */
export interface MemorySink extends Sink {
  bytes(): Uint8Array;
  text(encoding?: string): string;
  readonly closed: boolean;
}

export function memorySink(): MemorySink {
  const chunks: Uint8Array[] = [];
  let closed = false;
  return {
    async write(chunk) {
      if (closed) throw new Error('The sink is closed');
      chunks.push(chunk.slice());
    },
    async close() {
      closed = true;
    },
    async abort() {
      closed = true;
    },
    bytes: () => concatBytes(chunks),
    text: (encoding = 'utf-8') => new TextDecoder(encoding).decode(concatBytes(chunks)),
    get closed() {
      return closed;
    },
  };
}
