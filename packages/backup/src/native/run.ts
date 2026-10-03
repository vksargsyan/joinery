import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuerybaraError, type ResolvedProfile } from '@querybara/core';

import type { NativeTool } from './tools';

/**
 * Running the native tools safely. Credentials never go on the command line (other users can
 * read it): PostgreSQL tools get a password file named by PGPASSFILE, MySQL and MariaDB tools an
 * option file as their first argument, both created with owner-only permissions in a private
 * temporary folder that is removed when the tool ends. The tool's environment starts from this
 * process's without any PG* or MYSQL* variables, so nothing of the user's shell leaks in.
 */

/** Where the tool connects: the profile's endpoint, or the tunnel's local end. */
export interface NativeEndpoint {
  readonly host?: string;
  /** The address to dial when it differs from `host` (a tunnel's 127.0.0.1). */
  readonly hostAddress?: string;
  readonly port?: number;
  readonly socket?: string;
  readonly user?: string;
  readonly password?: string;
  readonly database: string;
  readonly tls: {
    readonly mode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
    readonly ca?: string;
    readonly cert?: string;
    readonly key?: string;
  };
}

/** The endpoint of a resolved profile (secrets included), as the native tools need it. */
export function nativeEndpoint(resolved: ResolvedProfile, database: string): NativeEndpoint {
  const { profile } = resolved;
  if (profile.tls.keyPassphrase !== undefined) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'The native tools cannot use a client key protected by a passphrase',
      hint: 'Use the Querybara backup format for this connection',
    });
  }
  const auth = profile.auth;
  const user =
    auth.method === 'password' || auth.method === 'clientCertificate' ? auth.user : undefined;
  const password =
    auth.method === 'password' && auth.password ? resolved.secrets[auth.password.id] : undefined;
  const tls = {
    mode: profile.tls.mode,
    ...(profile.tls.caPath !== undefined ? { ca: profile.tls.caPath } : {}),
    ...(profile.tls.certPath !== undefined ? { cert: profile.tls.certPath } : {}),
    ...(profile.tls.keyPath !== undefined ? { key: profile.tls.keyPath } : {}),
  };
  const base = {
    database,
    tls,
    ...(user !== undefined && user !== '' ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
  };
  const endpoint = profile.endpoint;
  const override = resolved.endpointOverride;
  if (endpoint.kind === 'socket') return { ...base, socket: endpoint.path };
  let host: string | undefined;
  let port: number | undefined;
  if (endpoint.kind === 'host') {
    host = endpoint.host;
    port = endpoint.port;
  } else if (endpoint.kind === 'uri') {
    try {
      const url = new URL(endpoint.uri);
      host = decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1'));
      port = url.port ? Number(url.port) : undefined;
    } catch {
      host = undefined;
    }
  }
  if (override) {
    return {
      ...base,
      ...(host !== undefined ? { host } : { host: override.host }),
      hostAddress: override.host,
      port: override.port,
    };
  }
  if (host === undefined) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'The native tools need a host and port or a socket for this connection',
    });
  }
  return { ...base, host, ...(port !== undefined ? { port } : {}) };
}

/** A private folder for credential files, removed by `dispose`. */
export async function privateFolder(): Promise<{ path: string; dispose(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'querybara-native-'));
  return { path, dispose: () => rm(path, { recursive: true, force: true }) };
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
}

/** A libpq password file line: `*:*:*:*:password`, with `\` and `:` escaped. */
export function pgPassLine(password: string): string {
  return `*:*:*:*:${password.replace(/[\\:]/g, (ch) => `\\${ch}`)}\n`;
}

/** A value in a MySQL option file: double-quoted, with backslash escapes. */
export function optionValue(value: string): string {
  const escaped = value.replace(/[\\"\n\r\t\b]/g, (ch) => {
    switch (ch) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\b':
        return '\\b';
      default:
        return `\\${ch}`;
    }
  });
  return `"${escaped}"`;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PG|MYSQL|MARIADB)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** The environment of a PostgreSQL tool; the password goes to a file PGPASSFILE names. */
export async function pgEnvironment(
  endpoint: NativeEndpoint,
  folder: string,
): Promise<NodeJS.ProcessEnv> {
  const env = cleanEnv();
  if (endpoint.password !== undefined) {
    const file = join(folder, 'pgpass');
    await writePrivate(file, pgPassLine(endpoint.password));
    env['PGPASSFILE'] = file;
  }
  if (endpoint.socket !== undefined) env['PGHOST'] = endpoint.socket;
  if (endpoint.host !== undefined) env['PGHOST'] = endpoint.host;
  if (endpoint.hostAddress !== undefined) env['PGHOSTADDR'] = endpoint.hostAddress;
  if (endpoint.port !== undefined) env['PGPORT'] = String(endpoint.port);
  if (endpoint.user !== undefined) env['PGUSER'] = endpoint.user;
  env['PGDATABASE'] = endpoint.database;
  env['PGSSLMODE'] = endpoint.tls.mode;
  if (endpoint.tls.ca !== undefined) env['PGSSLROOTCERT'] = endpoint.tls.ca;
  if (endpoint.tls.cert !== undefined) env['PGSSLCERT'] = endpoint.tls.cert;
  if (endpoint.tls.key !== undefined) env['PGSSLKEY'] = endpoint.tls.key;
  env['PGAPPNAME'] = 'Querybara';
  env['PGCONNECT_TIMEOUT'] = '30';
  return env;
}

/**
 * The option file of a MySQL or MariaDB tool: connection, credentials and TLS, in the dialect of
 * the tool's family. Returns the `--defaults-extra-file=` argument, which must come first.
 */
export async function mysqlOptionFile(
  tool: NativeTool,
  endpoint: NativeEndpoint,
  folder: string,
): Promise<string> {
  const lines = ['[client]'];
  if (endpoint.socket !== undefined) lines.push(`socket=${optionValue(endpoint.socket)}`);
  const host = endpoint.hostAddress ?? endpoint.host;
  if (host !== undefined) lines.push(`host=${optionValue(host)}`);
  if (endpoint.port !== undefined) lines.push(`port=${endpoint.port}`);
  if (endpoint.user !== undefined) lines.push(`user=${optionValue(endpoint.user)}`);
  if (endpoint.password !== undefined) lines.push(`password=${optionValue(endpoint.password)}`);
  lines.push('default-character-set=utf8mb4');
  const { mode } = endpoint.tls;
  // A tunnel dials 127.0.0.1, so the certificate's host name cannot be checked there.
  const verifyHost = mode === 'verify-full' && endpoint.hostAddress === undefined;
  if (tool.family === 'mysql') {
    lines.push(
      `ssl-mode=${mode === 'disable' ? 'DISABLED' : mode === 'require' ? 'REQUIRED' : verifyHost ? 'VERIFY_IDENTITY' : 'VERIFY_CA'}`,
    );
  } else if (mode === 'disable') {
    lines.push('skip-ssl');
  } else {
    lines.push('ssl');
    // MariaDB's check includes the host name, which a tunnel's 127.0.0.1 cannot match; the
    // CA given with ssl-ca still verifies the chain. Newer clients verify by default, so the
    // choice is always written out.
    lines.push(
      mode !== 'require' && endpoint.hostAddress === undefined
        ? 'ssl-verify-server-cert'
        : 'skip-ssl-verify-server-cert',
    );
  }
  if (mode !== 'disable') {
    if (endpoint.tls.ca !== undefined) lines.push(`ssl-ca=${optionValue(endpoint.tls.ca)}`);
    if (endpoint.tls.cert !== undefined) lines.push(`ssl-cert=${optionValue(endpoint.tls.cert)}`);
    if (endpoint.tls.key !== undefined) lines.push(`ssl-key=${optionValue(endpoint.tls.key)}`);
  }
  const file = join(folder, 'client.cnf');
  await writePrivate(file, `${lines.join('\n')}\n`);
  return `--defaults-extra-file=${file}`;
}

export function mysqlEnvironment(): NodeJS.ProcessEnv {
  return cleanEnv();
}

export interface RunOptions {
  readonly tool: NativeTool;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Bytes fed to the tool's stdin. */
  readonly input?: AsyncIterable<Uint8Array>;
  /** Where the tool's stdout goes (a dump); ignored when absent. */
  readonly output?: (chunk: Uint8Array) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Each line the tool writes to stderr. */
  readonly onLine?: (line: string) => void;
}

export interface RunResult {
  readonly code: number | null;
  /** The last lines of stderr, for the error message. */
  readonly tail: readonly string[];
}

/**
 * Runs a tool to its end: stdin fed from `input` with backpressure, stdout into `output`,
 * stderr line by line. Aborting the signal terminates the tool (SIGKILL after 5 s).
 */
export function runTool(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.tool.path, [...options.args], {
      env: options.env,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tail: string[] = [];
    let partial = '';
    let failure: unknown;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      partial += text;
      let at: number;
      while ((at = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, at).trimEnd();
        partial = partial.slice(at + 1);
        if (line === '') continue;
        tail.push(line);
        if (tail.length > 50) tail.shift();
        options.onLine?.(line);
      }
    });
    // stdout goes through `output` one chunk at a time; the pipe pauses while it writes.
    const stdout = (async () => {
      for await (const chunk of child.stdout! as AsyncIterable<Uint8Array>) {
        if (options.output) await options.output(chunk);
      }
    })().catch((error: unknown) => {
      failure ??= error;
      child.kill('SIGTERM');
    });
    const stdin = (async () => {
      if (!options.input || !child.stdin) return;
      try {
        for await (const chunk of options.input) {
          if (!child.stdin.write(chunk)) {
            await new Promise<void>((done) => {
              const finish = (): void => {
                child.stdin!.off('drain', finish);
                child.stdin!.off('close', finish);
                done();
              };
              child.stdin!.on('drain', finish);
              child.stdin!.on('close', finish);
            });
          }
          if (child.stdin.destroyed) break;
        }
      } finally {
        child.stdin.end();
      }
    })().catch((error: unknown) => {
      // The tool stopped reading (it failed); its exit code says why.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure ??= error;
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        new QuerybaraError({
          code: 'NOT_FOUND',
          message: `${options.tool.name} could not start: ${error.message}`,
        }),
      );
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (partial.trim() !== '') {
        tail.push(partial.trim());
        options.onLine?.(partial.trim());
      }
      void Promise.all([stdout, stdin]).then(() => {
        if (options.signal?.aborted) {
          reject(new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' }));
        } else if (failure !== undefined) {
          reject(failure);
        } else {
          resolve({ code, tail });
        }
      });
    });
  });
}
