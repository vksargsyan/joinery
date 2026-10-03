import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The renderer is served from a privileged custom scheme, `app://querybara/`, rather than file://
 * (Electron security checklist): the page gets a real origin for its CSP `'self'`, module workers
 * and the MessagePort origin check, and file:// keeps no extra privileges (fuse off).
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'querybara';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Maps a request URL to a file under `root`, or undefined when it is not ours: another scheme
 * or host, an encoded or dot-dot path escaping the root, or an unknown file type.
 */
export function resolveAppFile(root: string, requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return undefined;
  const wanted = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = resolve(root, wanted);
  const inside = relative(root, file);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.startsWith(sep)) {
    return undefined;
  }
  return MIME_TYPES[extname(file).toLowerCase()] === undefined ? undefined : file;
}

/** Content type for a resolved file. */
export function mimeTypeOf(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The protocol handler: serves files from `root` with the CSP header on every response. Missing
 * or refused paths get a 404 with no detail.
 */
export function createAppProtocolHandler(
  root: string,
  csp: string,
): (request: Request) => Promise<Response> {
  const notFound = (): Response => new Response('Not found', { status: 404 });
  return async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const file = resolveAppFile(root, request.url);
    if (file === undefined) return notFound();
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return notFound();
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': mimeTypeOf(file),
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-cache',
      },
    });
  };
}
