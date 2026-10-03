import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ASSET_CATALOG,
  ASSET_ICON_NAME,
  BUILD_DIR,
  ICNS_ENTRIES,
  ICO_SIZES,
  ICON_COMPOSER,
  MAC_ARTWORK_SHARE,
  MAC_TILE,
  PNG_SIZES,
  expectedIcons,
  generateIcons,
  iconComposerJson,
  pngSize,
  readIcns,
  readIco,
  type GeneratedIcon,
} from '../scripts/icons';

/**
 * The icon generator (spec §20): every file the installers and the window need, at the right
 * sizes, from build/icon.svg; and the committed icons in build/ are what it produces.
 */

const out = mkdtempSync(join(tmpdir(), 'querybara-icons-'));

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

/** The box around an image's opaque pixels: [left, top, right, bottom), in pixels. */
function opaqueBox(image: { width: number; height: number; pixels: Buffer }): number[] {
  let [left, top, right, bottom] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (alphaAt(image, x, y) === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return [left, top, right, bottom];
}

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
  if (icon.format === 'json') return [];
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
      'icon.icon/icon.json',
      'icon.icon/Assets/artwork.png',
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

  it('shows the artwork free-standing outside macOS', () => {
    const full = decodePng(readFileSync(join(out, 'icon.png')));
    expect(alphaAt(full, 0, 0)).toBe(0);
    expect(alphaAt(full, 50, 512)).toBe(0);
    expect(alphaAt(full, 512, 512)).toBe(255);
  });

  it("sets the macOS artwork on a tile in Apple's margin", () => {
    // Halfway down the left edge: in Apple's margin (100 of 1024 px), then on the tile.
    const mac = decodePng(icnsPng(readFileSync(join(out, 'icon.icns')), 'ic10'));
    expect(alphaAt(mac, 50, 512)).toBe(0);
    expect(alphaAt(mac, 110, 512)).toBe(255);
    // The tile's corners are rounded.
    expect(alphaAt(mac, 105, 105)).toBe(0);
    // Tenmoku at the tile's foot, under the artwork.
    const foot = (900 * 1024 + 512) * 4;
    const hex = (at: number): string =>
      [0, 1, 2].map((c) => mac.pixels[at + c]!.toString(16).padStart(2, '0')).join('');
    expect(`#${hex(foot)}`).toBe(MAC_TILE[1]);
  });

  it('centres the Icon Composer layer on the artwork at the tile share', () => {
    const layer = decodePng(readFileSync(join(out, ICON_COMPOSER, 'Assets', 'artwork.png')));
    const [left, top, right, bottom] = opaqueBox(layer);
    // The artwork's longer side is the share.
    const longer = Math.max(right! - left!, bottom! - top!);
    expect(Math.abs(longer / 1024 - MAC_ARTWORK_SHARE)).toBeLessThan(0.01);
    expect(Math.abs((left! + right!) / 2 - 512)).toBeLessThanOrEqual(2);
    expect(Math.abs((top! + bottom!) / 2 - 512)).toBeLessThanOrEqual(2);
  });

  it('writes the Icon Composer document for the layer, on the tile', () => {
    const document = JSON.parse(readFileSync(join(out, ICON_COMPOSER, 'icon.json'), 'utf8'));
    expect(document.groups[0].layers[0]['image-name']).toBe('artwork.png');
    expect(document.fill['linear-gradient']).toEqual([
      'srgb:1.00000,0.99216,0.97255,1.00000',
      'srgb:0.94510,0.92157,0.87451,1.00000',
    ]);
  });
});

describe('the committed icons', () => {
  it('are all in build/ with the sizes the generator writes', () => {
    for (const icon of expectedIcons()) expect(sizesIn(BUILD_DIR, icon)).toEqual(icon.sizes);
  });

  it('include the asset catalog macOS 26 reads, and the packaging bundles it', () => {
    const catalog = readFileSync(join(BUILD_DIR, ASSET_CATALOG));
    expect(catalog.toString('ascii', 0, 8)).toBe('BOMStore');
    const config = readFileSync(join(BUILD_DIR, '..', 'electron-builder.yml'), 'utf8');
    expect(config).toContain(`from: build/${ASSET_CATALOG}`);
    expect(config).toContain(`CFBundleIconName: ${ASSET_ICON_NAME}`);
  });

  it('are what the generator makes from build/icon.svg', () => {
    expect(readFileSync(join(BUILD_DIR, ICON_COMPOSER, 'icon.json'), 'utf8')).toBe(
      iconComposerJson(),
    );
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
        `build/${icon.file} is stale: run pnpm --filter @querybara/desktop icons`,
      ).toBeLessThanOrEqual(2);
    }
  });
});
