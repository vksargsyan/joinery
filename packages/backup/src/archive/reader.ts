import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

import { QuerybaraError } from '@querybara/core';
import { gunzip } from '@querybara/transfer';

import {
  TAG_LENGTH,
  damaged,
  deriveKeys,
  headerMacMatches,
  openFrame,
  type ArchiveKeys,
} from './crypto';
import {
  ENTRY_HEADER_LENGTH,
  HEADER_FIXED_LENGTH,
  LAST_FRAME,
  MANIFEST_INDEX,
  MAX_FRAME_SIZE,
  TRAILER_LENGTH,
  headerJsonLength,
  isArchive,
  parseEntryHeader,
  parseHeader,
  parseTrailer,
  type ArchiveHeader,
} from './format';
import { manifestSchema, type EntryRecord, type Manifest } from './manifest';

/**
 * Reads a Querybara archive with random access: the header and the trailer locate the manifest,
 * and the manifest locates every entry, so a selective restore reads only the entries it needs.
 * Every frame is checked before its bytes are used (GCM tag or CRC-32), a cut-off entry is
 * caught by the missing last-frame flag, and each entry's size and SHA-256 are compared with the
 * manifest when it has been read to the end.
 */

/** Random-access bytes: a file, or memory in tests. */
export interface ArchiveSource {
  readonly size: number;
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** An archive file opened for reading. */
export async function fileArchiveSource(path: string): Promise<ArchiveSource> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new QuerybaraError({
      code: code === 'ENOENT' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
      message: code === 'ENOENT' ? `${path} does not exist` : `${path} cannot be read (${code})`,
    });
  }
  const { size } = await handle.stat();
  return {
    size,
    async read(position, length) {
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      if (done < length) throw damaged('the file ends too early');
      return buffer;
    },
    close: () => handle.close(),
  };
}

/** Archive bytes in memory. */
export function memoryArchiveSource(bytes: Uint8Array): ArchiveSource {
  return {
    size: bytes.length,
    async read(position, length) {
      if (position + length > bytes.length) throw damaged('the file ends too early');
      return bytes.subarray(position, position + length);
    },
    close: async () => undefined,
  };
}

export interface ArchiveOpenOptions {
  /** Needed for encrypted archives; used to derive the keys and then dropped. */
  readonly passphrase?: string;
}

/** What can be learned from an archive without its passphrase. */
export interface ArchiveProbe {
  readonly encrypted: boolean;
  readonly compressed: boolean;
}

async function readHeader(source: ArchiveSource): Promise<ArchiveHeader> {
  if (source.size < HEADER_FIXED_LENGTH + TRAILER_LENGTH) {
    const head = await source.read(0, Math.min(source.size, 8));
    if (!isArchive(head)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'This file is not a Querybara backup archive',
      });
    }
    throw damaged('the file is too short');
  }
  const fixed = await source.read(0, HEADER_FIXED_LENGTH);
  const jsonLength = headerJsonLength(fixed);
  const available = Math.min(source.size, HEADER_FIXED_LENGTH + jsonLength + 32);
  return parseHeader(await source.read(0, available));
}

export class ArchiveReader {
  readonly manifest: Manifest;
  readonly #source: ArchiveSource;
  readonly #header: ArchiveHeader;
  readonly #keys: ArchiveKeys | undefined;
  readonly #byName: Map<string, EntryRecord>;

  private constructor(
    source: ArchiveSource,
    header: ArchiveHeader,
    keys: ArchiveKeys | undefined,
    manifest: Manifest,
  ) {
    this.#source = source;
    this.#header = header;
    this.#keys = keys;
    this.manifest = manifest;
    this.#byName = new Map(manifest.entries.map((entry) => [entry.name, entry]));
  }

  /** Reads the header only: whether a passphrase is needed. */
  static async probe(source: ArchiveSource): Promise<ArchiveProbe> {
    const header = await readHeader(source);
    return { encrypted: header.kdf !== undefined, compressed: header.compressed };
  }

  /**
   * Opens an archive: checks the header (and, for an encrypted one, the passphrase), then reads
   * and validates the manifest. Takes ownership of the source; `close` releases it.
   */
  static async open(
    source: ArchiveSource | string,
    options: ArchiveOpenOptions = {},
  ): Promise<ArchiveReader> {
    const src = typeof source === 'string' ? await fileArchiveSource(source) : source;
    try {
      const header = await readHeader(src);
      let keys: ArchiveKeys | undefined;
      if (header.kdf) {
        if (options.passphrase === undefined || options.passphrase === '') {
          throw new QuerybaraError({
            code: 'AUTH_FAILED',
            message: 'This backup is encrypted: enter its passphrase to open it',
          });
        }
        keys = await deriveKeys(options.passphrase, header.kdf.salt, header.kdf);
        if (!headerMacMatches(keys, header.bytes, header.mac!)) {
          throw new QuerybaraError({
            code: 'AUTH_FAILED',
            message: 'The passphrase is wrong, or the backup header was modified',
          });
        }
      }
      const trailer = parseTrailer(
        await src.read(src.size - TRAILER_LENGTH, TRAILER_LENGTH),
        src.size,
      );
      if (trailer.offset < header.dataStart) throw damaged('the manifest is misplaced');
      const manifestRecord: EntryRecord = {
        name: 'manifest.json',
        index: MANIFEST_INDEX,
        offset: trailer.offset,
        storedLength: trailer.length,
        size: 0,
        sha256: '0'.repeat(64),
        contentType: 'application/json',
      };
      const partial = { header, keys, source: src };
      const text = await collectText(readFrames(partial, manifestRecord, 'the manifest'));
      let manifest: Manifest;
      try {
        manifest = manifestSchema.parse(JSON.parse(text));
      } catch {
        throw damaged('the manifest is not readable');
      }
      checkLayout(manifest, header.dataStart, trailer.offset);
      return new ArchiveReader(src, header, keys, manifest);
    } catch (error) {
      await src.close().catch(() => undefined);
      throw error;
    }
  }

  get encrypted(): boolean {
    return this.#keys !== undefined;
  }

  get compressed(): boolean {
    return this.#header.compressed;
  }

  get size(): number {
    return this.#source.size;
  }

  entry(name: string): EntryRecord | undefined {
    return this.#byName.get(name);
  }

  /**
   * An entry's content as it streams: every frame is authenticated before its bytes come out,
   * and the size and SHA-256 are checked once the last byte has been read. Stopping early is
   * fine; the checks then simply do not run.
   */
  async *read(name: string | EntryRecord): AsyncGenerator<Uint8Array> {
    const record = typeof name === 'string' ? this.#byName.get(name) : name;
    if (!record) {
      throw new QuerybaraError({
        code: 'NOT_FOUND',
        message: `The backup has no file ${String(name)}`,
      });
    }
    const what = record.name;
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of readFrames(
      { header: this.#header, keys: this.#keys, source: this.#source },
      record,
      what,
    )) {
      hash.update(chunk);
      size += chunk.length;
      yield chunk;
    }
    if (size !== record.size || hash.digest('hex') !== record.sha256) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `The backup is damaged: ${what} does not match its checksum`,
      });
    }
  }

  /** A small entry (JSON, DDL) as text. */
  async text(name: string): Promise<string> {
    return collectText(this.read(name));
  }

  /** A small JSON entry, parsed. */
  async json(name: string): Promise<unknown> {
    const text = await this.text(name);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw damaged(name, 'not JSON');
    }
  }

  /** Reads every entry to the end: every frame and checksum is verified. */
  async verify(onEntry?: (entry: EntryRecord, index: number) => void): Promise<void> {
    for (const [index, entry] of this.manifest.entries.entries()) {
      onEntry?.(entry, index);
      for await (const _chunk of this.read(entry)) {
        // Reading is verifying.
      }
    }
  }

  async close(): Promise<void> {
    await this.#source.close();
  }
}

/** The manifest's entries must tile the space between the header and the manifest. */
function checkLayout(manifest: Manifest, dataStart: number, manifestOffset: number): void {
  const names = new Set<string>();
  let at = dataStart;
  for (const [i, entry] of manifest.entries.entries()) {
    if (entry.index !== i || entry.offset !== at || names.has(entry.name)) {
      throw damaged('the manifest does not match the archive layout');
    }
    names.add(entry.name);
    at += entry.storedLength;
  }
  if (at !== manifestOffset) throw damaged('the manifest does not match the archive layout');
}

interface FrameContext {
  readonly header: ArchiveHeader;
  readonly keys: ArchiveKeys | undefined;
  readonly source: ArchiveSource;
}

/** An entry's frames, checked and decrypted, then decompressed. */
function readFrames(
  ctx: FrameContext,
  record: EntryRecord,
  what: string,
): AsyncIterable<Uint8Array> {
  const raw = rawFrames(ctx, record, what);
  return ctx.header.compressed ? gunzipChecked(raw, what) : raw;
}

async function* gunzipChecked(
  source: AsyncIterable<Uint8Array>,
  what: string,
): AsyncGenerator<Uint8Array> {
  // A frame that fails its check ends the gunzip stream; report that failure, not the
  // decompressor's complaint about the missing rest.
  let sourceError: unknown;
  const guarded: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        yield* source;
      } catch (error) {
        sourceError = error;
        throw error;
      }
    },
  };
  try {
    yield* gunzip(guarded);
  } catch {
    throw sourceError ?? damaged(what, 'decompression failed');
  }
  if (sourceError !== undefined) throw sourceError;
}

async function* rawFrames(
  ctx: FrameContext,
  record: EntryRecord,
  what: string,
): AsyncGenerator<Uint8Array> {
  const { source, keys } = ctx;
  const end = record.offset + record.storedLength;
  if (record.storedLength < ENTRY_HEADER_LENGTH + 4 || end > source.size) {
    throw damaged(what, 'out of bounds');
  }
  const entryHeader = await source.read(record.offset, ENTRY_HEADER_LENGTH);
  const noncePrefix = parseEntryHeader(entryHeader, record.index, what);
  const trailerLength = keys ? TAG_LENGTH : 4;
  let at = record.offset + ENTRY_HEADER_LENGTH;
  let frame = 0;
  for (;;) {
    if (at + 4 > end) throw damaged(what, 'cut off');
    const wordBytes = await source.read(at, 4);
    const word = Buffer.from(wordBytes.buffer, wordBytes.byteOffset, 4).readUInt32BE(0);
    const last = (word & LAST_FRAME) !== 0;
    const length = word & ~LAST_FRAME;
    if (length > MAX_FRAME_SIZE || at + 4 + length + trailerLength > end) {
      throw damaged(what, 'bad frame');
    }
    const body = await source.read(at + 4, length + trailerLength);
    let data: Uint8Array;
    if (keys) {
      data = openFrame(keys.encryption, entryHeader, noncePrefix, frame, last, body, what);
    } else {
      data = body.subarray(0, length);
      const stored = Buffer.from(body.buffer, body.byteOffset + length, 4).readUInt32BE(0);
      if (stored !== crc32(data, crc32(wordBytes))) throw damaged(what, 'checksum mismatch');
    }
    at += 4 + length + trailerLength;
    frame++;
    if (data.length > 0) yield data;
    if (last) break;
  }
  if (at !== end) throw damaged(what, 'trailing bytes');
}

async function collectText(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
