import { QuerybaraError } from '@querybara/core';

import type { ByteSource } from './io';

/**
 * Character encodings. Reading goes through TextDecoder, so every WHATWG encoding Node.js
 * ships with full ICU works (utf-8, utf-16le/be, windows-1252, iso-8859-x, shift_jis, gbk...);
 * `latin1` is an alias of windows-1252 there. Writing supports UTF-8 and UTF-16LE.
 */

export interface DetectedEncoding {
  /** The WHATWG encoding name. */
  readonly encoding: string;
  /** The bytes start with this encoding's byte order mark. */
  readonly bom: boolean;
}

/**
 * Picks the encoding of a text file from its first bytes: a byte order mark wins; otherwise
 * UTF-16 is recognised by its pattern of zero bytes, UTF-8 by validity, and anything else is
 * taken as windows-1252 (the usual source of non-UTF-8 CSV files). `complete` says the bytes
 * are the whole file, so a truncated multi-byte sequence at the end counts as invalid.
 */
export function detectEncoding(head: Uint8Array, complete = false): DetectedEncoding {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: 'utf-8', bom: true };
  }
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bom: true };

  const sample = head.subarray(0, 4096);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 0) evenZeros++;
    else oddZeros++;
  }
  const pairs = Math.floor(sample.length / 2);
  if (pairs >= 2) {
    if (oddZeros >= pairs * 0.3 && evenZeros * 4 < oddZeros) {
      return { encoding: 'utf-16le', bom: false };
    }
    if (evenZeros >= pairs * 0.3 && oddZeros * 4 < evenZeros) {
      return { encoding: 'utf-16be', bom: false };
    }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: !complete });
    return { encoding: 'utf-8', bom: false };
  } catch {
    return { encoding: 'windows-1252', bom: false };
  }
}

/** A TextDecoder for `encoding`, failing with a clear error for unknown names. */
export function decoderFor(encoding: string): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder(encoding);
  } catch {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `Unknown text encoding "${encoding}"`,
      hint: 'Use a WHATWG encoding name such as utf-8, utf-16le, windows-1252 or iso-8859-2',
    });
  }
}

/** Decodes a byte stream into text chunks; a byte order mark matching the encoding is dropped. */
export async function* decodeSource(source: ByteSource, encoding: string): AsyncGenerator<string> {
  const decoder = decoderFor(encoding);
  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const rest = decoder.decode();
  if (rest.length > 0) yield rest;
}

export const OUTPUT_ENCODINGS = ['utf-8', 'utf-16le'] as const;
export type OutputEncoding = (typeof OUTPUT_ENCODINGS)[number];

/** Turns text into bytes for a sink, with an optional byte order mark before the first chunk. */
export class TextOutput {
  private readonly encoder = new TextEncoder();
  private started = false;

  constructor(
    private readonly encoding: OutputEncoding = 'utf-8',
    private readonly bom = false,
  ) {}

  encode(text: string): Uint8Array {
    const prefix = !this.started && this.bom ? '\ufeff' : '';
    this.started = true;
    if (this.encoding === 'utf-16le') return Buffer.from(prefix + text, 'utf16le');
    return this.encoder.encode(prefix + text);
  }
}
