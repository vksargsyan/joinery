import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';

import { JoineryError } from '@joinery/core';

import type { ByteSource, RandomAccessReader, Sink } from './io';

/**
 * ZIP archives (spec §12: an xlsx workbook is a ZIP of XML parts, and "zip" output bundles one
 * file per table), on node:zlib alone.
 *
 * - `ZipReader` reads the central directory of a random-access source and streams one entry
 *   at a time through raw inflate, checking its size and CRC-32 as it goes: memory holds a
 *   chunk, never an entry.
 * - `ZipWriter` streams entries into a Sink one after another, deflated, with data
 *   descriptors, so no entry is ever buffered. ZIP64 records are written only when the archive
 *   needs them (an entry or offset past 4 GiB, more than 65,535 entries), and then in the
 *   central directory, which is what readers go by.
 *
 * Stored (0) and deflated (8) entries are read; encrypted entries are refused.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR = 0x08074b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const CHUNK = 64 * 1024;
const EMPTY_DEFLATE = new Uint8Array([0x03, 0x00]);
/** Longest central directory read into memory. */
const MAX_DIRECTORY = 256 * 1024 * 1024;

/** True when the bytes start like a ZIP archive (a local file header or an empty archive). */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/** True for an OLE compound file: a legacy .xls, or an encrypted (password-protected) .xlsx. */
export function isCompoundFile(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.length >= 8 && magic.every((byte, i) => bytes[i] === byte);
}

function corrupt(message: string): JoineryError {
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: `Not a valid ZIP file: ${message}`,
  });
}

export interface ZipEntry {
  readonly name: string;
  /** 0 stored, 8 deflated. */
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  /** Offset of the entry's local header. */
  readonly offset: number;
  readonly encrypted: boolean;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(data: DataView, at: number): number {
  const value = data.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt('a size is out of range');
  return Number(value);
}

/** Reads entries of a ZIP archive; see the module comment. */
export class ZipReader {
  readonly entries: readonly ZipEntry[];
  readonly #byName: Map<string, ZipEntry>;

  private constructor(
    private readonly reader: RandomAccessReader,
    entries: ZipEntry[],
  ) {
    this.entries = entries;
    // Part names in OOXML packages are case-insensitive.
    this.#byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  }

  /** Reads the central directory. The reader stays open until `close`. */
  static async open(reader: RandomAccessReader): Promise<ZipReader> {
    const size = reader.size;
    if (size < 22) throw corrupt('the file is too short');
    const tailLength = Math.min(size, 22 + MAX16);
    const tail = await reader.read(size - tailLength, tailLength);
    const tailView = view(tail);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tailView.getUint32(at, true) === END_OF_CENTRAL) {
        end = at;
        break;
      }
    }
    if (end < 0) throw corrupt('the end of the central directory is missing');
    let count = tailView.getUint16(end + 10, true);
    let directorySize = tailView.getUint32(end + 12, true);
    let directoryOffset = tailView.getUint32(end + 16, true);
    if (end >= 20 && tailView.getUint32(end - 20, true) === ZIP64_LOCATOR) {
      const record = view(await reader.read(u64(tailView, end - 12), 56));
      if (record.byteLength < 56 || record.getUint32(0, true) !== ZIP64_END) {
        throw corrupt('the ZIP64 record is missing');
      }
      count = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
    } else if (directorySize === MAX32 || directoryOffset === MAX32) {
      throw corrupt('the ZIP64 locator is missing');
    }
    if (directorySize > MAX_DIRECTORY || directoryOffset + directorySize > size) {
      throw corrupt('the central directory is out of range');
    }
    const directory = await reader.read(directoryOffset, directorySize);
    const data = view(directory);
    const decoder = new TextDecoder('utf-8');
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > directory.length || data.getUint32(at, true) !== CENTRAL_HEADER) {
        throw corrupt('a central directory entry is damaged');
      }
      const flags = data.getUint16(at + 8, true);
      const method = data.getUint16(at + 10, true);
      const crc = data.getUint32(at + 16, true);
      let compressedSize = data.getUint32(at + 20, true);
      let uncompressed = data.getUint32(at + 24, true);
      const nameLength = data.getUint16(at + 28, true);
      const extraLength = data.getUint16(at + 30, true);
      const commentLength = data.getUint16(at + 32, true);
      let offset = data.getUint32(at + 42, true);
      const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
      // The ZIP64 extra field holds the fields that did not fit, in this order.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = data.getUint16(extra, true);
        const length = data.getUint16(extra + 2, true);
        if (id === 0x0001) {
          let field = extra + 4;
          if (uncompressed === MAX32) {
            uncompressed = u64(data, field);
            field += 8;
          }
          if (compressedSize === MAX32) {
            compressedSize = u64(data, field);
            field += 8;
          }
          if (offset === MAX32) offset = u64(data, field);
        }
        extra += 4 + length;
      }
      entries.push({
        name,
        method,
        crc32: crc,
        compressedSize,
        size: uncompressed,
        offset,
        encrypted: (flags & 1) !== 0,
      });
      at = extraEnd + commentLength;
    }
    return new ZipReader(reader, entries);
  }

  /** The entry with this name (case-insensitive), if any. */
  entry(name: string): ZipEntry | undefined {
    return this.#byName.get(name.replace(/^\//, '').toLowerCase());
  }

  /**
   * An entry's uncompressed bytes, streamed. `onRead` reports how far into the archive the
   * compressed data has been read, for progress against the file size.
   */
  async *read(entry: ZipEntry, onRead?: (position: number) => void): AsyncGenerator<Uint8Array> {
    if (entry.encrypted) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `"${entry.name}" is encrypted; save the file without a password`,
      });
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `"${entry.name}" uses ZIP compression method ${entry.method}; only stored and deflated entries are read`,
      });
    }
    const header = view(await this.reader.read(entry.offset, 30));
    if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_HEADER) {
      throw corrupt(`the local header of "${entry.name}" is missing`);
    }
    const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + entry.compressedSize > this.reader.size) {
      throw corrupt(`"${entry.name}" runs past the end of the file`);
    }
    const reader = this.reader;
    const compressed: ByteSource = {
      async *[Symbol.asyncIterator]() {
        for (let at = 0; at < entry.compressedSize; at += CHUNK) {
          const length = Math.min(CHUNK, entry.compressedSize - at);
          const chunk = await reader.read(start + at, length);
          if (chunk.length < length) throw corrupt(`"${entry.name}" is truncated`);
          onRead?.(start + at + length);
          yield chunk;
        }
      },
    };
    let crc = 0;
    let total = 0;
    const check = (chunk: Uint8Array): void => {
      total += chunk.length;
      if (total > entry.size) throw corrupt(`"${entry.name}" is larger than its directory says`);
      crc = crc32(chunk, crc);
    };
    if (entry.method === 0) {
      for await (const chunk of compressed) {
        check(chunk);
        yield chunk;
      }
    } else {
      const inflate = createInflateRaw({ chunkSize: CHUNK });
      const done = pipeline(Readable.from(compressed, { objectMode: false }), inflate).catch(
        () => undefined,
      );
      try {
        for await (const chunk of inflate as AsyncIterable<Uint8Array>) {
          check(chunk);
          yield chunk;
        }
      } catch (error) {
        if (error instanceof JoineryError) throw error;
        throw corrupt(`"${entry.name}" does not decompress (${(error as Error).message})`);
      } finally {
        inflate.destroy();
        await done;
      }
    }
    if (total !== entry.size) throw corrupt(`"${entry.name}" is shorter than its directory says`);
    if (crc >>> 0 !== entry.crc32) throw corrupt(`"${entry.name}" fails its CRC-32 check`);
  }

  /** A whole (small) entry as text; throws when it is longer than `limit` bytes. */
  async text(entry: ZipEntry, limit = 64 * 1024 * 1024): Promise<string> {
    if (entry.size > limit) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: `"${entry.name}" is too large (${entry.size} bytes)`,
      });
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.read(entry)) chunks.push(chunk);
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  }

  close(): Promise<void> {
    return this.reader.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

interface WrittenEntry {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
  readonly time: number;
  readonly date: number;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipWriterOptions {
  /** Deflate level, 0-9 (default 6). */
  readonly level?: number;
  /** Modification time stamped on the entries (default now). */
  readonly modified?: Date;
}

/** Streams a ZIP archive into a sink, one entry at a time; see the module comment. */
export class ZipWriter {
  #offset = 0;
  #open = false;
  #closed = false;
  readonly #entries: WrittenEntry[] = [];
  readonly #names = new Set<string>();
  readonly #stamp: { time: number; date: number };

  constructor(
    private readonly sink: Sink,
    private readonly options: ZipWriterOptions = {},
  ) {
    this.#stamp = dosTime(options.modified ?? new Date());
  }

  /** Bytes written to the sink so far. */
  get bytes(): number {
    return this.#offset;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    this.#offset += bytes.length;
    await this.sink.write(bytes);
  }

  /**
   * Starts an entry: write its bytes into the returned sink and close it before starting the
   * next. Aborting the entry aborts the whole archive.
   */
  entry(name: string): Sink {
    if (this.#closed) throw new Error('The ZIP archive is closed');
    if (this.#open) throw new Error('The previous ZIP entry is still open');
    if (this.#names.has(name)) throw new Error(`The ZIP archive already has "${name}"`);
    this.#names.add(name);
    this.#open = true;
    const encodedName = new TextEncoder().encode(name);
    const offset = this.#offset;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, LOCAL_HEADER, true);
    header.setUint16(4, 20, true);
    // Bit 3: sizes and CRC follow the data; bit 11: the name is UTF-8.
    header.setUint16(6, 0x0808, true);
    header.setUint16(8, 8, true);
    header.setUint16(10, this.#stamp.time, true);
    header.setUint16(12, this.#stamp.date, true);
    header.setUint16(26, encodedName.length, true);
    let started: Promise<void> | undefined;
    const start = (): Promise<void> =>
      (started ??= (async () => {
        await this.#write(new Uint8Array(header.buffer));
        await this.#write(encodedName);
      })());

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    let failure: unknown;
    // The deflate stream starts with the first byte, so empty entries cost nothing.
    let deflate: ReturnType<typeof createDeflateRaw> | undefined;
    let pump: Promise<void> = Promise.resolve();
    const deflater = (): ReturnType<typeof createDeflateRaw> => {
      if (deflate !== undefined) return deflate;
      const stream = createDeflateRaw({ level: this.options.level ?? 6, chunkSize: CHUNK });
      deflate = stream;
      pump = (async () => {
        await start();
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
          compressedSize += chunk.length;
          await this.#write(chunk);
        }
      })().catch((error: unknown) => {
        failure ??= error;
        stream.destroy();
      });
      return stream;
    };
    const check = (): void => {
      if (failure !== undefined) throw failure;
    };
    return {
      write: async (chunk) => {
        check();
        if (chunk.length === 0) return;
        crc = crc32(chunk, crc);
        size += chunk.length;
        const stream = deflater();
        if (!stream.write(chunk)) {
          await Promise.race([once(stream, 'drain'), pump]);
          check();
        }
      },
      close: async () => {
        check();
        if (deflate === undefined) {
          // An empty deflate stream: one final, empty fixed-Huffman block.
          await start();
          await this.#write(EMPTY_DEFLATE);
          compressedSize = EMPTY_DEFLATE.length;
        } else {
          deflate.end();
          await pump;
          check();
        }
        const zip64 = size >= MAX32 || compressedSize >= MAX32;
        const descriptor = new DataView(new ArrayBuffer(zip64 ? 24 : 16));
        descriptor.setUint32(0, DATA_DESCRIPTOR, true);
        descriptor.setUint32(4, crc >>> 0, true);
        if (zip64) {
          descriptor.setBigUint64(8, BigInt(compressedSize), true);
          descriptor.setBigUint64(16, BigInt(size), true);
        } else {
          descriptor.setUint32(8, compressedSize, true);
          descriptor.setUint32(12, size, true);
        }
        await this.#write(new Uint8Array(descriptor.buffer));
        this.#entries.push({
          name: encodedName,
          crc: crc >>> 0,
          compressedSize,
          size,
          offset,
          ...this.#stamp,
        });
        this.#open = false;
      },
      abort: async (reason) => {
        failure ??= reason ?? new Error('Aborted');
        deflate?.destroy();
        await pump;
        await this.abort(reason);
      },
    };
  }

  /** Writes the central directory and closes the sink. */
  async close(): Promise<void> {
    if (this.#open) throw new Error('A ZIP entry is still open');
    if (this.#closed) return;
    this.#closed = true;
    const directoryOffset = this.#offset;
    for (const entry of this.#entries) {
      const sizes = entry.size >= MAX32 || entry.compressedSize >= MAX32;
      const far = entry.offset >= MAX32;
      const extraLength = sizes || far ? 4 + (sizes ? 16 : 0) + (far ? 8 : 0) : 0;
      const record = new DataView(new ArrayBuffer(46 + entry.name.length + extraLength));
      record.setUint32(0, CENTRAL_HEADER, true);
      record.setUint16(4, (3 << 8) | 45, true);
      record.setUint16(6, extraLength > 0 ? 45 : 20, true);
      record.setUint16(8, 0x0808, true);
      record.setUint16(10, 8, true);
      record.setUint16(12, entry.time, true);
      record.setUint16(14, entry.date, true);
      record.setUint32(16, entry.crc, true);
      record.setUint32(20, sizes ? MAX32 : entry.compressedSize, true);
      record.setUint32(24, sizes ? MAX32 : entry.size, true);
      record.setUint16(28, entry.name.length, true);
      record.setUint16(30, extraLength, true);
      // Regular file, rw-r--r--.
      record.setUint32(38, 0o100644 << 16, true);
      record.setUint32(42, far ? MAX32 : entry.offset, true);
      const bytes = new Uint8Array(record.buffer);
      bytes.set(entry.name, 46);
      if (extraLength > 0) {
        let at = 46 + entry.name.length;
        record.setUint16(at, 0x0001, true);
        record.setUint16(at + 2, extraLength - 4, true);
        at += 4;
        if (sizes) {
          record.setBigUint64(at, BigInt(entry.size), true);
          record.setBigUint64(at + 8, BigInt(entry.compressedSize), true);
          at += 16;
        }
        if (far) record.setBigUint64(at, BigInt(entry.offset), true);
      }
      await this.#write(bytes);
    }
    const directorySize = this.#offset - directoryOffset;
    const count = this.#entries.length;
    const zip64 = count >= MAX16 || directoryOffset >= MAX32 || directorySize >= MAX32;
    if (zip64) {
      const recordOffset = this.#offset;
      const record = new DataView(new ArrayBuffer(56 + 20));
      record.setUint32(0, ZIP64_END, true);
      record.setBigUint64(4, 44n, true);
      record.setUint16(12, (3 << 8) | 45, true);
      record.setUint16(14, 45, true);
      record.setBigUint64(24, BigInt(count), true);
      record.setBigUint64(32, BigInt(count), true);
      record.setBigUint64(40, BigInt(directorySize), true);
      record.setBigUint64(48, BigInt(directoryOffset), true);
      record.setUint32(56, ZIP64_LOCATOR, true);
      record.setBigUint64(64, BigInt(recordOffset), true);
      record.setUint32(72, 1, true);
      await this.#write(new Uint8Array(record.buffer));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END_OF_CENTRAL, true);
    end.setUint16(8, zip64 ? MAX16 : count, true);
    end.setUint16(10, zip64 ? MAX16 : count, true);
    end.setUint32(12, zip64 ? MAX32 : directorySize, true);
    end.setUint32(16, zip64 ? MAX32 : directoryOffset, true);
    await this.#write(new Uint8Array(end.buffer));
    await this.sink.close();
  }

  /** Abandons the archive: the sink is aborted (a file sink removes its file). */
  async abort(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.sink.abort(reason);
  }
}
