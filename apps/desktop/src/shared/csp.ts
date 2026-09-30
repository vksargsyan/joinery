/**
 * The renderer's Content Security Policy (spec §18). One definition feeds both places it is
 * applied: the `<meta>` tag the build writes into index.html, and the response header main adds
 * to everything the app protocol and the dev server serve.
 *
 * Nothing remote is ever allowed. The two relaxations are the ones the UI libraries need:
 * `style-src 'unsafe-inline'` (Monaco and Glide Data Grid inject style elements at runtime) and
 * `worker-src blob:` (Monaco can start workers from blob URLs). There is no `unsafe-eval`.
 */

export interface CspOptions {
  /**
   * Development only: the Vite dev server origin, e.g. "http://localhost:5173". Adds its
   * WebSocket for hot reload to connect-src.
   */
  readonly devServerOrigin?: string;
  /**
   * Development only: SHA-256 hashes ("sha256-...") of inline scripts the dev server injects
   * (the React Refresh preamble), so no `unsafe-inline` is needed for scripts even in dev.
   */
  readonly scriptHashes?: readonly string[];
  /** Header form: adds directives that browsers ignore in a `<meta>` tag (frame-ancestors). */
  readonly header?: boolean;
}

/** Builds the policy string. Directive order is stable so tests and the built HTML can compare. */
export function buildContentSecurityPolicy(options: CspOptions = {}): string {
  const connect = ["'self'"];
  if (options.devServerOrigin !== undefined) {
    const origin = new URL(options.devServerOrigin);
    if (origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
      throw new RangeError('The dev server must run on localhost');
    }
    connect.push(`ws://${origin.host}`);
  }
  const directives: [string, readonly string[]][] = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", ...(options.scriptHashes ?? []).map((hash) => `'${hash}'`)]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['worker-src', ["'self'", 'blob:']],
    ['connect-src', connect],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];
  if (options.header === true) directives.push(['frame-ancestors', ["'none'"]]);
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}
