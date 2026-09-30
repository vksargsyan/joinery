import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import {
  BUILD_DIR,
  ICNS_ENTRIES,
  ICO_SIZES,
  PNG_SIZES,
  expectedIcons,
  generateIcons,
  pngSize,
  readIcns,
  readIco,
  type GeneratedIcon,
} from '../scripts/icons';

/**
 * The icon generator (spec §20): every file the installers and the window need, at the right
 * sizes, from build/icon.svg; and the committed icons in build/ are what it produces.
 */

const out = mkdtempSync(join(tmpdir(), 'joinery-icons-'));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/** Decodes an 8-bit RGBA, non-interlaced PNG (what resvg writes) into its pixels. */
function decodePng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const { width, height } = pngSize(png);
  expect(png.subarray(24, 29)).toEqual(Buffer.from([8, 6, 0, 0, 0]));
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT')
      idat.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0;
      const paeth = (): number => {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return a <= b && a <= c ? left : b <= c ? up : upLeft;
      };
      const predictor = [0, left, up, (left + up) >> 1, paeth()][filter]!;
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

const alphaAt = (image: { width: number; pixels: Buffer }, x: number, y: number): number =>
  image.pixels[(y * image.width + x) * 4 + 3]!;

/** The PNG payload of one ICNS entry. */
function icnsPng(data: Buffer, type: string): Buffer {
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at + 4);
    if (data.toString('ascii', at, at + 4) === type) return data.subarray(at + 8, at + length);
    at += length;
  }
  throw new Error(`No ${type} entry`);
}

/** The pixel sizes a generated file holds, read back from its bytes. */
function sizesIn(dir: string, icon: GeneratedIcon): number[] {
  const data = readFileSync(join(dir, icon.file));
  if (icon.format === 'png') {
    const { width, height } = pngSize(data);
    expect(height).toBe(width);
    return [width];
  }
  if (icon.format === 'ico') return readIco(data).map((image) => image.size);
  return readIcns(data).map((entry) => entry.size);
}

describe('generateIcons', () => {
  it('writes every icon the targets need, at the declared sizes', { timeout: 60_000 }, async () => {
    const written = await generateIcons({ svgPath: join(BUILD_DIR, 'icon.svg'), outDir: out });
    expect(written).toEqual(expectedIcons());
    expect(written.map((icon) => icon.file)).toEqual([
      'icon.png',
      ...PNG_SIZES.map((size) => `icons/${size}x${size}.png`),
      'icon.ico',
      'icon.icns',
    ]);
    for (const icon of written) expect(sizesIn(out, icon)).toEqual(icon.sizes);
  });

  it('stores small Windows sizes as 32-bit bitmaps and 256 px as PNG', () => {
    const images = readIco(readFileSync(join(out, 'icon.ico')));
    expect(images.map((image) => image.size)).toEqual([...ICO_SIZES]);
    for (const image of images) {
      expect(image.bitCount).toBe(32);
      expect(image.png).toBe(image.size >= 256);
    }
  });

  it('writes the macOS entry types with the sizes Apple assigns them', () => {
    const entries = readIcns(readFileSync(join(out, 'icon.icns')));
    expect(entries).toEqual(ICNS_ENTRIES.map(([type, size]) => ({ type, size })));
  });

  it('leaves a margin around the macOS artwork and fills the canvas elsewhere', () => {
    // Halfway down the left edge: inside the tile on the full-bleed icon, in Apple's margin
    // (100 of 1024 px) on the macOS one.
    const full = decodePng(readFileSync(join(out, 'icon.png')));
    const mac = decodePng(icnsPng(readFileSync(join(out, 'icon.icns')), 'ic10'));
    expect(alphaAt(full, 50, 512)).toBe(255);
    expect(alphaAt(mac, 50, 512)).toBe(0);
    expect(alphaAt(mac, 150, 512)).toBe(255);
    // The rounded corners are transparent everywhere.
    expect(alphaAt(full, 0, 0)).toBe(0);
  });
});

describe('the committed icons', () => {
  it('are all in build/ with the sizes the generator writes', () => {
    for (const icon of expectedIcons()) expect(sizesIn(BUILD_DIR, icon)).toEqual(icon.sizes);
  });

  it('are what the generator makes from build/icon.svg', () => {
    // Pixels, not bytes: resvg may round differently on another CPU.
    const pngs = expectedIcons().filter((icon) => icon.format === 'png');
    for (const icon of pngs) {
      const committed = decodePng(readFileSync(join(BUILD_DIR, icon.file))).pixels;
      const fresh = decodePng(readFileSync(join(out, icon.file))).pixels;
      let worst = 0;
      for (let i = 0; i < fresh.length; i++)
        worst = Math.max(worst, Math.abs(fresh[i]! - committed[i]!));
      expect(
        worst,
        `build/${icon.file} is stale: run pnpm --filter @joinery/desktop icons`,
      ).toBeLessThanOrEqual(2);
    }
  });
});
