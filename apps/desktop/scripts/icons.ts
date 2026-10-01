import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Resvg } from '@resvg/resvg-js';

/**
 * Generates every app icon from the one source, `build/icon.svg` (spec §20: installers for every
 * target): the Windows `.ico`, the Linux PNG set under `build/icons/` (which also gives the window
 * and dock icon at run time) and a 1024 px `build/icon.png`, all the artwork free-standing; and
 * for macOS the artwork on a Tenmoku tile, twice: `build/icon.icns` for macOS 15 and earlier, and
 * the Icon Composer package `build/icon.icon/` compiled into `build/Assets.car` for macOS 26 and
 * later, which shrink an icon from an `.icns` alone into a grey tile of their own. The outputs
 * are committed, so packaging needs no renderer and no Xcode; run this again after changing the
 * SVG, on a Mac with Xcode 26 or later so that Assets.car is compiled too:
 *
 *   pnpm --filter @joinery/desktop icons
 *
 * Rendering uses resvg (MPL-2.0, build time only); the ICO and ICNS containers are written here,
 * the asset catalog by Xcode's actool.
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
 * The share of the canvas the macOS tile fills: Apple's icon grid keeps a margin around the tile
 * (824 of 1024 px), so the icon sits in the Dock like the system's own. Windows and Linux icons
 * use the whole canvas.
 */
export const MAC_ARTWORK_SCALE = 824 / 1024;

/** The share of the macOS tile the artwork's longer side fills, centred. */
export const MAC_ARTWORK_SHARE = 0.7;

/**
 * The macOS tile, top to bottom: Kiln's Tenmoku grounds (raised, deep), in both appearances; the
 * ivory top of the artwork would fade into Bisque.
 */
export const MAC_TILE = ['#24201c', '#110f0e'] as const;

/** The radius of the tile on Apple's grid: macOS 15 and earlier draw the tile as it is. */
const MAC_TILE_RADIUS = 185;

/** The Icon Composer package (macOS 26 and later) and the layer image it holds. */
export const ICON_COMPOSER = 'icon.icon';
const ICON_LAYER = 'artwork.png';

/** The asset catalog actool compiles the package into, and the icon's name in it. */
export const ASSET_CATALOG = 'Assets.car';
export const ASSET_ICON_NAME = 'Icon';

export interface GeneratedIcon {
  /** Relative to the output directory, with forward slashes. */
  readonly file: string;
  readonly format: 'png' | 'ico' | 'icns' | 'json';
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
    { file: `${ICON_COMPOSER}/icon.json`, format: 'json', sizes: [] },
    { file: `${ICON_COMPOSER}/Assets/${ICON_LAYER}`, format: 'png', sizes: [1024] },
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

const dataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** Where the artwork sits: a square around what it draws, in the SVG's pixels. */
interface Frame {
  readonly x: number;
  readonly y: number;
  readonly side: number;
  /** The SVG's own size. */
  readonly width: number;
  readonly height: number;
}

/**
 * The square centred on what the artwork draws (not on its own canvas), with the artwork's
 * longer side `share` of it.
 */
function frameOf(svg: string, share: number): Frame {
  const { width, height, pixels } = new Resvg(svg).render();
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  if (right < 0) throw new Error('The icon draws nothing');
  const side = Math.max(right - left, bottom - top) / share;
  return { x: (left + right - side) / 2, y: (top + bottom - side) / 2, side, width, height };
}

/**
 * The artwork as an <image> filling the square at (`at`, `at`) of side `size` with its frame.
 * One level of embedding: resvg draws no images inside an embedded SVG.
 */
function placed(svg: string, frame: Frame, at: number, size: number): string {
  const scale = size / frame.side;
  return (
    `<image x="${at - frame.x * scale}" y="${at - frame.y * scale}" ` +
    `width="${frame.width * scale}" height="${frame.height * scale}" href="${dataUri(svg)}"/>`
  );
}

const canvas = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">` +
  `${body}</svg>`;

/** The framed artwork alone: the Icon Composer layer. */
function layerSvg(svg: string, frame: Frame): string {
  return canvas(placed(svg, frame, 0, 1024));
}

/** The framed artwork on the Tenmoku tile, on Apple's icon grid: the macOS 15 icon. */
function macTileSvg(svg: string, frame: Frame): string {
  const inner = Math.round(1024 * MAC_ARTWORK_SCALE);
  const offset = (1024 - inner) / 2;
  return canvas(
    `<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="0.7">` +
      `<stop stop-color="${MAC_TILE[0]}"/><stop offset="1" stop-color="${MAC_TILE[1]}"/>` +
      `</linearGradient></defs>` +
      `<rect x="${offset}" y="${offset}" width="${inner}" height="${inner}" ` +
      `rx="${MAC_TILE_RADIUS}" fill="url(#tile)"/>` +
      placed(svg, frame, offset, inner),
  );
}

/** An sRGB colour as Icon Composer writes it: "srgb:0.14118,0.12549,0.10980,1.00000". */
function iconComposerColour(hex: string): string {
  const channels = [1, 3, 5].map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(5));
  return `srgb:${channels.join(',')},1.00000`;
}

/**
 * The Icon Composer document: the tile as the fill, the framed artwork as one layer with the
 * system's shadow under it and no glass over it (the artwork has its own light).
 */
export function iconComposerJson(): string {
  const document = {
    fill: {
      'linear-gradient': MAC_TILE.map(iconComposerColour),
      orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 0.7 } },
    },
    groups: [
      {
        layers: [{ 'image-name': ICON_LAYER, name: 'artwork', glass: false }],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: false, value: 0 },
        specular: false,
      },
    ],
    'supported-platforms': { squares: ['macOS'] },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Renders every icon from `svgPath` into `outDir` and returns what it wrote. */
export async function generateIcons(options: {
  readonly svgPath: string;
  readonly outDir: string;
}): Promise<GeneratedIcon[]> {
  const svg = await readFile(options.svgPath, 'utf8');
  const frame = frameOf(svg, MAC_ARTWORK_SHARE);
  const sources = { full: svg, mac: macTileSvg(svg, frame), layer: layerSvg(svg, frame) };
  const cache = new Map<string, Rendered>();
  const at = (source: keyof typeof sources, size: number): Rendered => {
    const key = `${source}:${size}`;
    let rendered = cache.get(key);
    if (!rendered) {
      rendered = render(sources[source], size);
      cache.set(key, rendered);
    }
    return rendered;
  };

  await mkdir(join(options.outDir, 'icons'), { recursive: true });
  await mkdir(join(options.outDir, ICON_COMPOSER, 'Assets'), { recursive: true });
  const written: GeneratedIcon[] = [];
  for (const icon of expectedIcons()) {
    let data: Buffer;
    if (icon.format === 'json') data = Buffer.from(iconComposerJson());
    else if (icon.format === 'png') {
      data = at(icon.file.startsWith(ICON_COMPOSER) ? 'layer' : 'full', icon.sizes[0]!).png;
    } else if (icon.format === 'ico') {
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

const run = promisify(execFile);

/** actool's version when Xcode 26 or later is installed (it compiles Icon Composer packages). */
async function actoolVersion(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await run('xcrun', ['actool', '--version']);
    const version = /short-bundle-version<\/key>\s*<string>([\d.]+)</.exec(stdout)?.[1];
    return version !== undefined && parseInt(version, 10) >= 26 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compiles the Icon Composer package into `Assets.car` (what electron-builder does for a `.icon`
 * at packaging time, done here so that packaging needs no Xcode 26). Undefined when actool is
 * not available.
 */
export async function compileAssetCatalog(options: {
  readonly iconPath: string;
  readonly outFile: string;
}): Promise<string | undefined> {
  const version = await actoolVersion();
  if (version === undefined) return undefined;
  const work = await mkdtemp(join(tmpdir(), 'joinery-actool-'));
  try {
    // actool names the icon after the package.
    const icon = join(work, `${ASSET_ICON_NAME}.icon`);
    await run('cp', ['-R', options.iconPath, icon]);
    await run('xcrun', [
      'actool',
      icon,
      '--compile',
      work,
      '--output-format',
      'human-readable-text',
      '--errors',
      '--output-partial-info-plist',
      join(work, 'partial.plist'),
      '--app-icon',
      ASSET_ICON_NAME,
      '--include-all-app-icons',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '26.0',
      '--platform',
      'macosx',
    ]);
    await writeFile(options.outFile, await readFile(join(work, ASSET_CATALOG)));
    return version;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The app's build resources directory, `apps/desktop/build`. */
export const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = await generateIcons({ svgPath: join(BUILD_DIR, 'icon.svg'), outDir: BUILD_DIR });
  for (const icon of written) console.log(`build/${icon.file}  ${icon.sizes.join(', ')}`);
  const actool = await compileAssetCatalog({
    iconPath: join(BUILD_DIR, ICON_COMPOSER),
    outFile: join(BUILD_DIR, ASSET_CATALOG),
  });
  if (actool) console.log(`build/${ASSET_CATALOG}  actool ${actool}`);
  else {
    console.warn(
      `build/${ASSET_CATALOG} was not compiled: it needs macOS with Xcode 26 or later. ` +
        'Run this again on a Mac before committing, or the macOS 26 icon stays the old one.',
    );
  }
}
