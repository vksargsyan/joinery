/** SSH wire encoding (RFC 4251 §5): uint32, string and mpint, as keys and key files use them. */

export class WireError extends Error {}

/** Reads uint32s and length-prefixed strings from an SSH wire buffer, failing on truncation. */
export class WireReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  uint32(): number {
    if (this.remaining < 4) throw new WireError('truncated data');
    const value = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  /** A string or an mpint's raw two's-complement bytes. */
  string(): Buffer {
    const length = this.uint32();
    if (this.remaining < length) throw new WireError('truncated data');
    const value = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  text(): string {
    return this.string().toString('utf8');
  }
}

export function wireUint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

export function wireString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([wireUint32(bytes.length), bytes]);
}

/** The mpint of an unsigned big-endian integer: minimal, with a 0 byte if the top bit is set. */
export function mpint(unsigned: Buffer): Buffer {
  let start = 0;
  while (start < unsigned.length && unsigned[start] === 0) start += 1;
  const trimmed = unsigned.subarray(start);
  const content =
    trimmed.length > 0 && (trimmed[0]! & 0x80) !== 0
      ? Buffer.concat([Buffer.from([0]), trimmed])
      : trimmed;
  return wireString(content);
}
