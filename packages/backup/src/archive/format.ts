import { crc32 } from 'node:zlib';

import { QuerybaraError } from '@querybara/core';

import {
  KEY_CHECK_LENGTH,
  SALT_LENGTH,
  damaged,
  isValidScryptCost,
  type ScryptCost,
} from './crypto';

/**
 * The byte layout of a Querybara archive, version 1 (docs/backup-archive-format.md):
 *
 *   header   magic "QBAK\r\n\x1a\n" | u16 version | u16 flags | u32 n | n bytes JSON
 *            | 32-byte HMAC of all of that (encrypted archives only)
 *   entries  back to back; each is a 16-byte entry header ("JENT" | u32 index | 8-byte nonce
 *            prefix) and frames: u32 word (bit 31 = last frame, bits 0-30 = payload length),
 *            the payload, then a CRC-32 (plain) or the payload is ciphertext plus a 16-byte
 *            GCM tag (encrypted)
 *   manifest the last entry, index 0xFFFFFFFF, JSON
 *   trailer  "QBAKEND\0" | u64 manifest offset | u64 manifest length | u32 0 | u32 CRC-32
 *
 * Integers are big-endian. The magic's CR LF and Ctrl-Z catch text-mode copies, as PNG's do.
 */

export const MAGIC = Uint8Array.from([0x4a, 0x42, 0x41, 0x4b, 0x0d, 0x0a, 0x1a, 0x0a]);
export const FORMAT_VERSION = 1;
export const HEADER_FIXED_LENGTH = 16;
export const ENTRY_MAGIC = Uint8Array.from([0x4a, 0x45, 0x4e, 0x54]);
export const ENTRY_HEADER_LENGTH = 16;
export const TRAILER_MAGIC = Uint8Array.from([0x4a, 0x42, 0x41, 0x4b, 0x45, 0x4e, 0x44, 0x00]);
export const TRAILER_LENGTH = 32;
export const MANIFEST_INDEX = 0xffffffff;
export const FLAG_ENCRYPTED = 0x1;
export const FLAG_COMPRESSED = 0x2;
export const LAST_FRAME = 0x80000000;
/** Frames the writer produces: 64 KiB of (compressed) content. */
export const DEFAULT_FRAME_SIZE = 64 * 1024;
/** Frames a reader accepts; anything larger is damage, not data. */
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
/** Header JSON a reader accepts. */
const MAX_HEADER_JSON = 64 * 1024;

export interface KdfParams extends ScryptCost {
  readonly name: 'scrypt';
  readonly salt: Uint8Array;
}

/** What the header says about the archive. */
export interface ArchiveHeader {
  readonly version: number;
  readonly compressed: boolean;
  /** Present when the archive is encrypted. */
  readonly kdf?: KdfParams;
  /** The header bytes the MAC covers (everything before it). */
  readonly bytes: Uint8Array;
  /** The stored MAC (encrypted archives). */
  readonly mac?: Uint8Array;
  /** Where the first entry starts. */
  readonly dataStart: number;
}

interface HeaderJson {
  compression?: unknown;
  cipher?: unknown;
  kdf?: { name?: unknown; log2N?: unknown; r?: unknown; p?: unknown; salt?: unknown };
}

/** The header without its MAC. */
export function encodeHeader(compressed: boolean, kdf: KdfParams | undefined): Uint8Array {
  const json: Record<string, unknown> = { compression: compressed ? 'gzip' : 'none' };
  if (kdf) {
    json['cipher'] = 'aes-256-gcm';
    json['kdf'] = {
      name: 'scrypt',
      log2N: kdf.log2N,
      r: kdf.r,
      p: kdf.p,
      salt: Buffer.from(kdf.salt).toString('base64'),
    };
  }
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const out = Buffer.alloc(HEADER_FIXED_LENGTH + body.length);
  Buffer.from(MAGIC).copy(out, 0);
  out.writeUInt16BE(FORMAT_VERSION, 8);
  out.writeUInt16BE((kdf ? FLAG_ENCRYPTED : 0) | (compressed ? FLAG_COMPRESSED : 0), 10);
  out.writeUInt32BE(body.length, 12);
  body.copy(out, HEADER_FIXED_LENGTH);
  return out;
}

/** True when the bytes start with the archive magic (sniffing a file's first bytes). */
export function isArchive(head: Uint8Array): boolean {
  return head.length >= MAGIC.length && MAGIC.every((byte, i) => head[i] === byte);
}

/** The length of the fixed part plus JSON, read from the first 16 bytes. */
export function headerJsonLength(fixed: Uint8Array): number {
  if (fixed.length < HEADER_FIXED_LENGTH || !isArchive(fixed)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'This file is not a Querybara backup archive',
    });
  }
  const view = Buffer.from(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  const version = view.readUInt16BE(8);
  if (version !== FORMAT_VERSION) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `This backup uses archive format version ${version}, which this version of Querybara cannot read`,
      hint: 'Update Querybara and try again.',
    });
  }
  const length = view.readUInt32BE(12);
  if (length > MAX_HEADER_JSON) throw damaged('the header is too long');
  return length;
}

/** Parses the header; `bytes` holds at least the fixed part, the JSON and the MAC. */
export function parseHeader(bytes: Uint8Array): ArchiveHeader {
  const jsonLength = headerJsonLength(bytes);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.readUInt16BE(10);
  const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
  const compressed = (flags & FLAG_COMPRESSED) !== 0;
  const end = HEADER_FIXED_LENGTH + jsonLength;
  if (view.length < end + (encrypted ? KEY_CHECK_LENGTH : 0))
    throw damaged('the header is cut off');
  let json: HeaderJson;
  try {
    json = JSON.parse(view.subarray(HEADER_FIXED_LENGTH, end).toString('utf8')) as HeaderJson;
  } catch {
    throw damaged('the header is not readable');
  }
  if ((json.compression === 'gzip') !== compressed)
    throw damaged('the header disagrees with itself');
  let kdf: KdfParams | undefined;
  if (encrypted) {
    const k = json.kdf;
    const salt = typeof k?.salt === 'string' ? Buffer.from(k.salt, 'base64') : undefined;
    const cost = { log2N: Number(k?.log2N), r: Number(k?.r), p: Number(k?.p) };
    if (
      json.cipher !== 'aes-256-gcm' ||
      k?.name !== 'scrypt' ||
      salt?.length !== SALT_LENGTH ||
      !isValidScryptCost(cost)
    ) {
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: 'This backup is encrypted with settings this version of Querybara cannot read',
      });
    }
    kdf = { name: 'scrypt', ...cost, salt };
  }
  return {
    version: FORMAT_VERSION,
    compressed,
    ...(kdf ? { kdf } : {}),
    bytes: view.subarray(0, end),
    ...(encrypted ? { mac: view.subarray(end, end + KEY_CHECK_LENGTH) } : {}),
    dataStart: end + (encrypted ? KEY_CHECK_LENGTH : 0),
  };
}

/** The 16-byte header in front of every entry's frames. */
export function encodeEntryHeader(index: number, noncePrefix: Uint8Array): Uint8Array {
  const out = Buffer.alloc(ENTRY_HEADER_LENGTH);
  Buffer.from(ENTRY_MAGIC).copy(out, 0);
  out.writeUInt32BE(index >>> 0, 4);
  Buffer.from(noncePrefix.buffer, noncePrefix.byteOffset, noncePrefix.byteLength).copy(out, 8);
  return out;
}

/** Checks an entry header against the index the manifest gives it; returns its nonce prefix. */
export function parseEntryHeader(bytes: Uint8Array, index: number, what: string): Uint8Array {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.length !== ENTRY_HEADER_LENGTH ||
    !ENTRY_MAGIC.every((byte, i) => view[i] === byte) ||
    view.readUInt32BE(4) !== index >>> 0
  ) {
    throw damaged(what, 'entry header');
  }
  return view.subarray(8, 16);
}

export function encodeTrailer(manifestOffset: number, manifestLength: number): Uint8Array {
  const out = Buffer.alloc(TRAILER_LENGTH);
  Buffer.from(TRAILER_MAGIC).copy(out, 0);
  out.writeBigUInt64BE(BigInt(manifestOffset), 8);
  out.writeBigUInt64BE(BigInt(manifestLength), 16);
  out.writeUInt32BE(0, 24);
  out.writeUInt32BE(crc32(out.subarray(0, 28)), 28);
  return out;
}

export function parseTrailer(
  bytes: Uint8Array,
  fileSize: number,
): { offset: number; length: number } {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.length !== TRAILER_LENGTH ||
    !TRAILER_MAGIC.every((byte, i) => view[i] === byte) ||
    view.readUInt32BE(28) !== crc32(view.subarray(0, 28))
  ) {
    throw damaged('the end of the file is missing', 'was the copy cut short?');
  }
  const offset = Number(view.readBigUInt64BE(8));
  const length = Number(view.readBigUInt64BE(16));
  if (offset + length + TRAILER_LENGTH !== fileSize) throw damaged('the manifest is misplaced');
  return { offset, length };
}
