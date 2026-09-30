import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

/**
 * Generates every app icon from the one source, `build/icon.svg` (spec §20: installers for every
 * target): the macOS `.icns`, the Windows `.ico`, the Linux PNG set under `build/icons/` (which
 * also gives the window and dock icon at run time) and a 1024 px `build/icon.png`. The outputs
 * are committed, so packaging needs no renderer; run this again after changing the SVG:
 *
 *   pnpm --filter @joinery/desktop icons
 *
 * Rendering uses resvg (MPL-2.0, build time only); the ICO and ICNS containers are written here.
 */

/** Linux icon sizes (hicolor theme sizes plus 1024 for high-density docks). */
export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;

/**
 * Windows icon sizes: 100 % to 400 % scaling of the 16, 32 and 48 px slots Explorer, the taskbar
 * and the installers use. Up to 64 px they are stored as 32-bit bitmaps, which every consumer
 * (NSIS, rcedit, old shells) reads; 256 is PNG-compressed, as Windows expects.
 */
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256] as const;

/** ICNS entry types (PNG payloads, macOS 10.7 and later) and their pixel sizes. */
export const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
] as const;

/**
 * The share of the canvas the macOS artwork fills: Apple's icon grid keeps a margin around the
 * tile (824 of 1024 px), so the icon sits in the Dock like the system's own. Windows and Linux
 * icons use the whole canvas.
 */
export const MAC_ARTWORK_SCALE = 824 / 1024;

export interface GeneratedIcon {
  /** Relative to the output directory, with forward slashes. */
  readonly file: string;
  readonly format: 'png' | 'ico' | 'icns';
  /** Pixel sizes it holds. */
  readonly sizes: readonly number[];
}

/** Every file `generateIcons` writes. */
export function expectedIcons(): GeneratedIcon[] {
  return [
    { file: 'icon.png', format: 'png', sizes: [1024] },
    ...PNG_SIZES.map((size) => ({
      file: `icons/${size}x${size}.png`,
      format: 'png' as const,
      sizes: [size],
    })),
    { file: 'icon.ico', format: 'ico', sizes: [...ICO_SIZES] },
    { file: 'icon.icns', format: 'icns', sizes: ICNS_ENTRIES.map(([, size]) => size) },
  ];
}

interface Rendered {
  readonly png: Buffer;
  /** Premultiplied RGBA, as resvg renders it. */
  readonly pixels: Buffer;
}

function render(svg: string, size: number): Rendered {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
  if (image.width !== size || image.height !== size) {
    throw new Error(`The icon must be square: rendered ${image.width}x${image.height} for ${size}`);
  }
  return { png: image.asPng(), pixels: image.pixels };
}

/** The SVG placed on a larger transparent canvas, for the macOS icon grid. */
function withMargin(svg: string, scale: number): string {
  const inner = Math.round(1024 * scale);
  const offset = (1024 - inner) / 2;
  const href = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">` +
    `<image x="${offset}" y="${offset}" width="${inner}" height="${inner}" href="${href}"/></svg>`
  );
}

/** Renders every icon from `svgPath` into `outDir` and returns what it wrote. */
export async function generateIcons(options: {
  readonly svgPath: string;
  readonly outDir: string;
}): Promise<GeneratedIcon[]> {
  const svg = await readFile(options.svgPath, 'utf8');
  const mac = withMargin(svg, MAC_ARTWORK_SCALE);
  const cache = new Map<string, Rendered>();
  const at = (source: 'full' | 'mac', size: number): Rendered => {
    const key = `${source}:${size}`;
    let rendered = cache.get(key);
    if (!rendered) {
      rendered = render(source === 'mac' ? mac : svg, size);
      cache.set(key, rendered);
    }
    return rendered;
  };

  await mkdir(join(options.outDir, 'icons'), { recursive: true });
  const written: GeneratedIcon[] = [];
  for (const icon of expectedIcons()) {
    let data: Buffer;
    if (icon.format === 'png') data = at('full', icon.sizes[0]!).png;
    else if (icon.format === 'ico') {
      data = encodeIco(ICO_SIZES.map((size) => ({ size, ...at('full', size) })));
    } else {
      data = encodeIcns(ICNS_ENTRIES.map(([type, size]) => ({ type, png: at('mac', size).png })));
    }
    await writeFile(join(options.outDir, icon.file), data);
    written.push(icon);
  }
  return written;
}

/**
 * An ICO file: a directory of images, each a PNG (256 px) or a 32-bit BGRA bitmap with its AND
 * mask (smaller sizes). `pixels` are premultiplied RGBA, as resvg renders them.
 */
export function encodeIco(
  images: readonly { readonly size: number; readonly png: Buffer; readonly pixels: Buffer }[],
): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const payloads = images.map((image) => (image.size >= 256 ? image.png : icoBitmap(image)));
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    const payload = payloads[index]!;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(payload.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += payload.length;
  });
  return Buffer.concat([header, directory, ...payloads]);
}

/** A BITMAPINFOHEADER image: bottom-up BGRA rows (straight alpha), then the 1-bit AND mask. */
function icoBitmap(image: { readonly size: number; readonly pixels: Buffer }): Buffer {
  const { size, pixels } = image;
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  // The height covers the colour bitmap and the mask.
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const colour = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = (row * size + x) * 4;
      const alpha = pixels[from + 3]!;
      const straight = (channel: number): number =>
        alpha === 0 ? 0 : Math.min(255, Math.round((channel * 255) / alpha));
      colour[to] = straight(pixels[from + 2]!);
      colour[to + 1] = straight(pixels[from + 1]!);
      colour[to + 2] = straight(pixels[from]!);
      colour[to + 3] = alpha;
      if (alpha === 0) {
        const bit = row * maskRow + (x >> 3);
        mask[bit] = (mask[bit] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return Buffer.concat([header, colour, mask]);
}

/** An ICNS file: the 'icns' header, then one typed entry per PNG. */
export function encodeIcns(
  entries: readonly { readonly type: string; readonly png: Buffer }[],
): Buffer {
  const parts = entries.map(({ type, png }) => {
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new RangeError(`Bad ICNS type ${type}`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The images in an ICO file: size, bit depth and whether each is PNG-compressed. */
export function readIco(data: Buffer): { size: number; bitCount: number; png: boolean }[] {
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) throw new Error('Not an ICO file');
  const count = data.readUInt16LE(4);
  const images: { size: number; bitCount: number; png: boolean }[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const length = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    const payload = data.subarray(offset, offset + length);
    const png = payload.subarray(0, 8).equals(PNG_SIGNATURE);
    const size = png ? pngSize(payload).width : payload.readInt32LE(4);
    const listed = data.readUInt8(entry) || 256;
    if (listed !== size) throw new Error(`ICO entry ${index} lists ${listed} px but holds ${size}`);
    images.push({ size, bitCount: data.readUInt16LE(entry + 6), png });
  }
  return images;
}

/** The entries of an ICNS file with the pixel size of each PNG payload. */
export function readIcns(data: Buffer): { type: string; size: number }[] {
  if (data.toString('ascii', 0, 4) !== 'icns' || data.readUInt32BE(4) !== data.length) {
    throw new Error('Not an ICNS file');
  }
  const entries: { type: string; size: number }[] = [];
  let offset = 8;
  while (offset < data.length) {
    const type = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    entries.push({ type, size: pngSize(data.subarray(offset + 8, offset + length)).width });
    offset += length;
  }
  return entries;
}

/** The app's build resources directory, `apps/desktop/build`. */
export const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = await generateIcons({ svgPath: join(BUILD_DIR, 'icon.svg'), outDir: BUILD_DIR });
  for (const icon of written) console.log(`build/${icon.file}  ${icon.sizes.join(', ')}`);
}
