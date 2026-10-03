import { createHash, type Hash } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { QuerybaraError } from '@querybara/core';
import { gzipSink, type Sink } from '@querybara/transfer';

import {
  DEFAULT_SCRYPT_COST,
  deriveKeys,
  headerMac,
  randomNoncePrefix,
  randomSalt,
  sealFrame,
  type ArchiveKeys,
  type ScryptCost,
} from './crypto';
import {
  DEFAULT_FRAME_SIZE,
  LAST_FRAME,
  MANIFEST_INDEX,
  encodeEntryHeader,
  encodeHeader,
  encodeTrailer,
  type KdfParams,
} from './format';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  manifestSchema,
  type EntryContentType,
  type EntryRecord,
  type Manifest,
  type ManifestInput,
} from './manifest';

/**
 * Writes a Querybara archive in one pass: the header, then one entry at a time as its content
 * streams in (gzip-compressed and, with a passphrase, encrypted in 64 KiB frames), then the
 * manifest and the trailer. Memory stays flat whatever the size of an entry; offsets come from
 * counting what was written, so the sink only has to accept bytes in order.
 */

export interface ArchiveEncryption {
  /** Used to derive the keys and then dropped; it is never written anywhere. */
  readonly passphrase: string;
  /** scrypt cost; lower it only in tests. */
  readonly cost?: ScryptCost;
}

export interface ArchiveWriterOptions {
  readonly sink: Sink;
  /** gzip each entry (default true). */
  readonly compress?: boolean;
  readonly encryption?: ArchiveEncryption;
  /** Bytes of (compressed) content per frame; default 64 KiB. */
  readonly frameSize?: number;
}

/** One entry being written. Content goes in through `write`; `close` finishes it. */
export interface EntryWriter {
  readonly name: string;
  /** Uncompressed bytes written so far. */
  readonly size: number;
  write(chunk: Uint8Array | string): Promise<void>;
  close(): Promise<EntryRecord>;
}

/** The manifest fields the caller supplies; the writer adds the format and the entries. */
export type ManifestContent = Omit<ManifestInput, 'format' | 'formatVersion' | 'entries'>;

const encoder = new TextEncoder();

export class ArchiveWriter {
  readonly #sink: Sink;
  readonly #compress: boolean;
  readonly #keys: ArchiveKeys | undefined;
  readonly #frameSize: number;
  readonly #entries: EntryRecord[] = [];
  readonly #names = new Set<string>();
  #offset = 0;
  #open: EntryWriter | undefined;
  #finished = false;

  private constructor(
    sink: Sink,
    compress: boolean,
    keys: ArchiveKeys | undefined,
    frameSize: number,
  ) {
    this.#sink = sink;
    this.#compress = compress;
    this.#keys = keys;
    this.#frameSize = frameSize;
  }

  /** Derives the keys (when encrypting) and writes the header. */
  static async create(options: ArchiveWriterOptions): Promise<ArchiveWriter> {
    const compress = options.compress !== false;
    let keys: ArchiveKeys | undefined;
    let kdf: KdfParams | undefined;
    if (options.encryption) {
      const cost = options.encryption.cost ?? DEFAULT_SCRYPT_COST;
      const salt = randomSalt();
      keys = await deriveKeys(options.encryption.passphrase, salt, cost);
      kdf = { name: 'scrypt', ...cost, salt };
    }
    const frameSize = Math.max(1024, Math.min(options.frameSize ?? DEFAULT_FRAME_SIZE, 1 << 20));
    const writer = new ArchiveWriter(options.sink, compress, keys, frameSize);
    const header = encodeHeader(compress, kdf);
    await writer.#write(header);
    if (keys) await writer.#write(headerMac(keys, header));
    return writer;
  }

  get encrypted(): boolean {
    return this.#keys !== undefined;
  }

  get compressed(): boolean {
    return this.#compress;
  }

  /** Bytes written to the sink so far. */
  get bytesWritten(): number {
    return this.#offset;
  }

  /** Entries finished so far. */
  get entries(): readonly EntryRecord[] {
    return this.#entries;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    await this.#sink.write(bytes);
    this.#offset += bytes.length;
  }

  /** Starts an entry; only one can be open at a time. */
  entry(name: string, contentType: EntryContentType): EntryWriter {
    if (this.#finished) throw new Error('The archive is finished');
    if (this.#open) throw new Error(`Entry ${this.#open.name} is still open`);
    if (this.#names.has(name)) throw new Error(`Entry ${name} already exists`);
    this.#names.add(name);
    const writer = this.#entryWriter(name, contentType, this.#entries.length);
    this.#open = writer;
    return writer;
  }

  /** Writes a whole entry from a string or bytes. */
  async add(
    name: string,
    contentType: EntryContentType,
    content: Uint8Array | string,
  ): Promise<EntryRecord> {
    const writer = this.entry(name, contentType);
    await writer.write(content);
    return writer.close();
  }

  #entryWriter(name: string, contentType: EntryContentType, index: number): EntryWriter {
    const offset = this.#offset;
    const noncePrefix = this.#keys ? randomNoncePrefix() : new Uint8Array(8);
    const entryHeader = encodeEntryHeader(index, noncePrefix);
    const hash: Hash = createHash('sha256');
    let size = 0;
    let frame = 0;
    let pending: Uint8Array[] = [];
    let pendingLength = 0;
    let headerWritten = false;

    const emit = async (data: Uint8Array, last: boolean): Promise<void> => {
      if (!headerWritten) {
        await this.#write(entryHeader);
        headerWritten = true;
      }
      const word = Buffer.alloc(4);
      word.writeUInt32BE(((last ? LAST_FRAME : 0) | data.length) >>> 0, 0);
      if (this.#keys) {
        const sealed = sealFrame(
          this.#keys.encryption,
          entryHeader,
          noncePrefix,
          frame,
          last,
          data,
        );
        await this.#write(Buffer.concat([word, sealed]));
      } else {
        const check = Buffer.alloc(4);
        check.writeUInt32BE(crc32(data, crc32(word)), 0);
        await this.#write(Buffer.concat([word, data, check]));
      }
      frame++;
    };
    // Content waits here until a full frame is available; the last frame goes out on close.
    const frames: Sink = {
      write: async (chunk) => {
        pending.push(Buffer.from(chunk));
        pendingLength += chunk.length;
        if (pendingLength <= this.#frameSize) return;
        const all = Buffer.concat(pending, pendingLength);
        let at = 0;
        while (all.length - at > this.#frameSize) {
          await emit(all.subarray(at, at + this.#frameSize), false);
          at += this.#frameSize;
        }
        pending = [all.subarray(at)];
        pendingLength = all.length - at;
      },
      close: async () => {
        await emit(Buffer.concat(pending, pendingLength), true);
        pending = [];
        pendingLength = 0;
      },
      abort: async () => undefined,
    };
    const body = this.#compress ? gzipSink(frames) : frames;
    let closed = false;
    return {
      name,
      get size() {
        return size;
      },
      write: async (chunk) => {
        if (closed) throw new Error(`Entry ${name} is closed`);
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        if (bytes.length === 0) return;
        hash.update(bytes);
        size += bytes.length;
        await body.write(bytes);
      },
      close: async () => {
        if (closed) throw new Error(`Entry ${name} is closed`);
        closed = true;
        await body.close();
        const record: EntryRecord = {
          name,
          index,
          offset,
          storedLength: this.#offset - offset,
          size,
          sha256: hash.digest('hex'),
          contentType,
        };
        if (index !== MANIFEST_INDEX) this.#entries.push(record);
        this.#open = undefined;
        return record;
      },
    };
  }

  /**
   * Writes the manifest and the trailer and closes the sink. The manifest is validated first,
   * so an archive is never finished with a manifest a reader would refuse.
   */
  async finish(content: ManifestContent): Promise<Manifest> {
    if (this.#open) throw new Error(`Entry ${this.#open.name} is still open`);
    const manifest = manifestSchema.parse({
      ...content,
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      entries: this.#entries,
    });
    const writer = this.#entryWriter('manifest.json', 'application/json', MANIFEST_INDEX);
    this.#open = writer;
    await writer.write(JSON.stringify(manifest));
    const record = await writer.close();
    await this.#write(encodeTrailer(record.offset, record.storedLength));
    this.#finished = true;
    await this.#sink.close();
    return manifest;
  }

  /** Gives up: the sink is aborted (a file sink removes the partial file). */
  async abort(reason?: unknown): Promise<void> {
    this.#finished = true;
    await this.#sink.abort(reason).catch(() => undefined);
  }
}

/** A QuerybaraError for an archive write that cannot go on. */
export function archiveError(message: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}
