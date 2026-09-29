import { randomBytes } from 'node:crypto';

import { JoineryError } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { ZipReader, ZipWriter, isCompoundFile, isZip, memoryReader, memorySink } from '../src';

async function archive(entries: readonly [string, Uint8Array | string][]): Promise<Uint8Array> {
  const sink = memorySink();
  const zip = new ZipWriter(sink);
  for (const [name, data] of entries) {
    const entry = zip.entry(name);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    // Written in uneven pieces, as a writer streams them.
    for (let at = 0; at < bytes.length; at += 7777)
      await entry.write(bytes.subarray(at, at + 7777));
    await entry.close();
  }
  await zip.close();
  expect(sink.closed).toBe(true);
  return sink.bytes();
}

async function contents(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await ZipReader.open(memoryReader(bytes));
  const out = new Map<string, Uint8Array>();
  for (const entry of zip.entries) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of zip.read(entry)) chunks.push(chunk);
    out.set(entry.name, Buffer.concat(chunks));
  }
  await zip.close();
  return out;
}

/** A ZIP written by Python's zipfile: stored and deflated entries, no data descriptors. */
const PYTHON_ZIP =
  'UEsDBBQAAAAAAIMYIli1Aa8PCwAAAAsAAAAKAAAAc3RvcmVkLnR4dHN0b3JlZCB0ZXh0UEsDBBQAAAAIAIMYIlgH1m+QDgAAALQAAAAQAAAAZGlyL2RlZmxhdGVkLnR4dEtJTctJLElNUUgZOgwAUEsDBBQAAAgIAIMYIlgAAAAAAgAAAAAAAAAJAAAAw7xuw68udHh0AwBQSwECFAMUAAAAAACDGCJYtQGvDwsAAAALAAAACgAAAAAAAAAAAAAAgAEAAAAAc3RvcmVkLnR4dFBLAQIUAxQAAAAIAIMYIlgH1m+QDgAAALQAAAAQAAAAAAAAAAAAAACAATMAAABkaXIvZGVmbGF0ZWQudHh0UEsBAhQDFAAACAgAgxgiWAAAAAACAAAAAAAAAAkAAAAAAAAAAAAAAIABbwAAAMO8bsOvLnR4dFBLBQYAAAAAAwADAK0AAACYAAAAAAA=';

describe('ZIP', () => {
  it('writes entries that read back byte for byte', async () => {
    const random = randomBytes(300_000);
    const bytes = await archive([
      ['a.txt', 'hello'],
      ['empty.txt', ''],
      ['dir/ünï.csv', 'x,y\n'.repeat(10_000)],
      ['random.bin', random],
    ]);
    expect(isZip(bytes)).toBe(true);
    const read = await contents(bytes);
    expect([...read.keys()]).toEqual(['a.txt', 'empty.txt', 'dir/ünï.csv', 'random.bin']);
    expect(new TextDecoder().decode(read.get('a.txt'))).toBe('hello');
    expect(read.get('empty.txt')).toHaveLength(0);
    expect(new TextDecoder().decode(read.get('dir/ünï.csv'))).toBe('x,y\n'.repeat(10_000));
    expect(Buffer.from(read.get('random.bin')!).equals(random)).toBe(true);
  });

  it('reads archives other tools write: stored and deflated entries, UTF-8 names', async () => {
    const read = await contents(Buffer.from(PYTHON_ZIP, 'base64'));
    expect([...read.keys()]).toEqual(['stored.txt', 'dir/deflated.txt', 'ünï.txt']);
    expect(new TextDecoder().decode(read.get('stored.txt'))).toBe('stored text');
    expect(new TextDecoder().decode(read.get('dir/deflated.txt'))).toBe('deflated '.repeat(20));
  });

  it('finds entries by name regardless of case, as OOXML parts are named', async () => {
    const zip = await ZipReader.open(memoryReader(await archive([['Xl/Workbook.XML', 'w']])));
    expect(zip.entry('xl/workbook.xml')?.name).toBe('Xl/Workbook.XML');
    expect(zip.entry('/xl/workbook.xml')?.name).toBe('Xl/Workbook.XML');
    await zip.close();
  });

  it('reads the ZIP64 end records', async () => {
    const bytes = await archive([['a.txt', 'zip64']]);
    // Rewrite the end record as ZIP64: a ZIP64 end record, its locator, then a plain end
    // record whose fields all say "see ZIP64".
    const end = bytes.length - 22;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const count = view.getUint16(end + 10, true);
    const size = view.getUint32(end + 12, true);
    const offset = view.getUint32(end + 16, true);
    const tail = new DataView(new ArrayBuffer(56 + 20 + 22));
    tail.setUint32(0, 0x06064b50, true);
    tail.setBigUint64(4, 44n, true);
    tail.setBigUint64(24, BigInt(count), true);
    tail.setBigUint64(32, BigInt(count), true);
    tail.setBigUint64(40, BigInt(size), true);
    tail.setBigUint64(48, BigInt(offset), true);
    tail.setUint32(56, 0x07064b50, true);
    tail.setBigUint64(64, BigInt(end), true);
    tail.setUint32(72, 1, true);
    tail.setUint32(76, 0x06054b50, true);
    tail.setUint16(76 + 8, 0xffff, true);
    tail.setUint16(76 + 10, 0xffff, true);
    tail.setUint32(76 + 12, 0xffffffff, true);
    tail.setUint32(76 + 16, 0xffffffff, true);
    const zip64 = Buffer.concat([bytes.subarray(0, end), new Uint8Array(tail.buffer)]);
    expect(new TextDecoder().decode((await contents(zip64)).get('a.txt'))).toBe('zip64');
  });

  it('writes ZIP64 end records past 65,535 entries', async () => {
    const sink = memorySink();
    const zip = new ZipWriter(sink, { level: 0 });
    for (let i = 0; i < 65_536; i++) await zip.entry(`${i}`).close();
    await zip.close();
    const reader = await ZipReader.open(memoryReader(sink.bytes()));
    expect(reader.entries).toHaveLength(65_536);
    expect(reader.entries[65_535]?.name).toBe('65535');
    await reader.close();
  }, 60_000);

  it('detects damage: a flipped byte, a cut-off file, a file that is not a ZIP', async () => {
    const bytes = await archive([['a.txt', 'some text that compresses '.repeat(50)]]);
    const damaged = Uint8Array.from(bytes);
    damaged[40] = damaged[40]! ^ 0xff;
    await expect(contents(damaged)).rejects.toThrow(/Not a valid ZIP file/);
    await expect(contents(bytes.subarray(0, bytes.length - 10))).rejects.toThrow(
      /end of the central directory is missing/,
    );
    await expect(contents(new TextEncoder().encode('not a zip at all, clearly'))).rejects.toThrow(
      JoineryError,
    );
    expect(isCompoundFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(
      true,
    );
  });

  it('refuses duplicate names and overlapping entries; aborting aborts the sink', async () => {
    const sink = memorySink();
    const zip = new ZipWriter(sink);
    const first = zip.entry('a');
    expect(() => zip.entry('b')).toThrow(/still open/);
    await first.close();
    expect(() => zip.entry('a')).toThrow(/already has "a"/);
    const second = zip.entry('b');
    await second.write(new Uint8Array([1]));
    await second.abort(new Error('stop'));
    expect(sink.closed).toBe(true);
  });
});
