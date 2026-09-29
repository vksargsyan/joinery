import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JoineryError } from '@joinery/core';
import { fileSink, memorySink } from '@joinery/transfer';
import { describe, expect, it } from 'vitest';

import {
  ArchiveReader,
  ArchiveWriter,
  memoryArchiveSource,
  type ArchiveEncryption,
  type ManifestContent,
} from '../src';

/** A cheap scrypt cost so the tests stay fast; real archives use DEFAULT_SCRYPT_COST. */
const FAST = { log2N: 10, r: 8, p: 1 };

const MANIFEST: ManifestContent = {
  createdAt: '2026-09-29T12:00:00.000Z',
  producer: 'Joinery test',
  engine: 'postgres',
  serverVersion: '16.4',
  database: 'shop',
  objects: [],
};

async function build(
  entries: readonly (readonly [string, Uint8Array | string])[],
  options: { encryption?: ArchiveEncryption; compress?: boolean; frameSize?: number } = {},
): Promise<Uint8Array> {
  const sink = memorySink();
  const writer = await ArchiveWriter.create({ sink, ...options });
  for (const [name, content] of entries) {
    await writer.add(name, 'application/sql', content);
  }
  await writer.finish(MANIFEST);
  return sink.bytes();
}

async function readAll(reader: ArchiveReader, name: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader.read(name)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function expectError(
  promise: Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JoineryError);
  expect((error as JoineryError).code).toBe(code);
  expect((error as JoineryError).message).toMatch(message);
}

const big = randomBytes(300_000);
const text = 'INSERT INTO t VALUES (1);\n'.repeat(5000);

describe('archive round trip', () => {
  for (const [label, options] of [
    ['plain', { compress: false }],
    ['compressed', {}],
    ['encrypted', { encryption: { passphrase: 'correct horse', cost: FAST } }],
    [
      'encrypted, uncompressed, small frames',
      {
        compress: false,
        frameSize: 1024,
        encryption: { passphrase: 'pässwörd', cost: FAST },
      },
    ],
  ] as const) {
    it(`reads back every entry (${label})`, async () => {
      const bytes = await build(
        [
          ['ddl/one.sql', text],
          ['data/big.bin', big],
          ['empty.sql', ''],
        ],
        options,
      );
      const passphrase = 'encryption' in options ? options.encryption.passphrase : undefined;
      const reader = await ArchiveReader.open(memoryArchiveSource(bytes), {
        ...(passphrase !== undefined ? { passphrase } : {}),
      });
      expect(reader.encrypted).toBe('encryption' in options);
      expect(reader.manifest.entries.map((e) => e.name)).toEqual([
        'ddl/one.sql',
        'data/big.bin',
        'empty.sql',
      ]);
      expect((await readAll(reader, 'ddl/one.sql')).toString('utf8')).toBe(text);
      expect(Buffer.compare(await readAll(reader, 'data/big.bin'), big)).toBe(0);
      expect((await readAll(reader, 'empty.sql')).length).toBe(0);
      await reader.verify();
      await reader.close();
    });
  }

  it('compresses repetitive content and never stores the passphrase', async () => {
    const passphrase = 'a very memorable passphrase';
    const bytes = await build([['ddl/one.sql', text]], {
      encryption: { passphrase, cost: FAST },
    });
    expect(bytes.length).toBeLessThan(text.length / 10);
    expect(Buffer.from(bytes).includes(Buffer.from(passphrase))).toBe(false);
    expect(Buffer.from(bytes).includes(Buffer.from('INSERT INTO'))).toBe(false);
  });

  it('streams to a file and reads it back from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbak-'));
    try {
      const path = join(dir, 'x.jbak');
      const writer = await ArchiveWriter.create({ sink: fileSink(path) });
      const entry = writer.entry('data/rows.sql', 'application/sql');
      for (let i = 0; i < 1000; i++) await entry.write(`INSERT INTO t VALUES (${i});\n`);
      const record = await entry.close();
      expect(record.size).toBeGreaterThan(20_000);
      await writer.finish(MANIFEST);
      const reader = await ArchiveReader.open(path);
      expect((await readAll(reader, 'data/rows.sql')).toString()).toContain('VALUES (999)');
      await reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('integrity', () => {
  const passphrase = 'secret';
  const encryption = { passphrase, cost: FAST };

  it('needs the passphrase and rejects a wrong one', async () => {
    const bytes = await build([['a.sql', text]], { encryption });
    await expectError(ArchiveReader.open(memoryArchiveSource(bytes)), 'AUTH_FAILED', /encrypted/);
    await expectError(
      ArchiveReader.open(memoryArchiveSource(bytes), { passphrase: 'Secret' }),
      'AUTH_FAILED',
      /passphrase is wrong/,
    );
    expect(await ArchiveReader.probe(memoryArchiveSource(bytes))).toEqual({
      encrypted: true,
      compressed: true,
    });
  });

  it('detects a flipped bit in an encrypted frame', async () => {
    const bytes = await build([['a.bin', big]], { encryption, compress: false });
    const reader = await ArchiveReader.open(memoryArchiveSource(bytes), { passphrase });
    const entry = reader.entry('a.bin')!;
    const tampered = Uint8Array.from(bytes);
    tampered[entry.offset + 16 + 4 + 100]! ^= 0x01;
    const broken = await ArchiveReader.open(memoryArchiveSource(tampered), { passphrase });
    await expectError(readAll(broken, 'a.bin'), 'AUTH_FAILED', /modified or is damaged/);
  });

  it('detects frames moved between entries and a dropped last frame', async () => {
    const payload = randomBytes(5000);
    const bytes = await build(
      [
        ['a.bin', payload],
        ['b.bin', payload],
      ],
      { encryption, compress: false, frameSize: 1024 },
    );
    const reader = await ArchiveReader.open(memoryArchiveSource(bytes), { passphrase });
    const a = reader.entry('a.bin')!;
    const b = reader.entry('b.bin')!;
    // Same length, same content: only the bound entry header tells them apart.
    const swapped = Uint8Array.from(bytes);
    swapped.set(bytes.subarray(b.offset + 16, b.offset + b.storedLength), a.offset + 16);
    const moved = await ArchiveReader.open(memoryArchiveSource(swapped), { passphrase });
    await expectError(readAll(moved, 'a.bin'), 'AUTH_FAILED', /integrity check/);

    // Clearing the "last frame" bit of the final frame makes the entry look cut off.
    const lastWord = findLastFrameWord(bytes, a.offset, a.storedLength, 16);
    const truncated = Uint8Array.from(bytes);
    truncated[lastWord]! &= 0x7f;
    const cut = await ArchiveReader.open(memoryArchiveSource(truncated), { passphrase });
    await expect(readAll(cut, 'a.bin')).rejects.toThrow(JoineryError);
  });

  it('detects corruption of a plain archive through frame checksums', async () => {
    const bytes = await build([['a.sql', text]], { compress: false });
    const reader = await ArchiveReader.open(memoryArchiveSource(bytes));
    const entry = reader.entry('a.sql')!;
    const corrupt = Uint8Array.from(bytes);
    corrupt[entry.offset + 16 + 4 + 10]! ^= 0x20;
    const broken = await ArchiveReader.open(memoryArchiveSource(corrupt));
    await expectError(readAll(broken, 'a.sql'), 'VALIDATION_FAILED', /checksum mismatch/);
  });

  it('refuses a truncated file and a file that is not an archive', async () => {
    const bytes = await build([['a.sql', text]]);
    await expectError(
      ArchiveReader.open(memoryArchiveSource(bytes.subarray(0, bytes.length - 10))),
      'VALIDATION_FAILED',
      /damaged/,
    );
    await expectError(
      ArchiveReader.open(memoryArchiveSource(Buffer.from('-- just SQL\nSELECT 1;\n'.repeat(10)))),
      'VALIDATION_FAILED',
      /not a Joinery backup/,
    );
  });

  it('refuses a manifest whose entries do not tile the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbak-'));
    try {
      const path = join(dir, 'x.jbak');
      writeFileSync(path, await build([['a.sql', text]]));
      const reader = await ArchiveReader.open(path);
      expect(reader.manifest.engine).toBe('postgres');
      await reader.close();
      const raw = readFileSync(path);
      raw[raw.length - 1]! ^= 0xff;
      writeFileSync(path, raw);
      await expectError(ArchiveReader.open(path), 'VALIDATION_FAILED', /end of the file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Walks the frames of an uncompressed entry and returns the offset of the last frame's word. */
function findLastFrameWord(bytes: Uint8Array, offset: number, length: number, tag: number): number {
  const view = Buffer.from(bytes);
  let at = offset + 16;
  for (;;) {
    const word = view.readUInt32BE(at);
    const size = word & 0x7fffffff;
    if ((word & 0x80000000) !== 0) return at;
    at += 4 + size + tag;
    if (at >= offset + length) throw new Error('no last frame');
  }
}
