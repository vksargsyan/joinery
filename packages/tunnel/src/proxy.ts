import { connect as netConnect, type Socket } from 'node:net';

import type { HostPort, JoineryError, ProxyOptions } from '@joinery/core';
import { SocksClient } from 'socks';

import { errorMessage, hostLabel, mapSocketError, timeoutError, tunnelError } from './errors';

/**
 * HTTP CONNECT and SOCKS5 proxies (spec §4). A proxy connection is a plain socket to `target`;
 * the transport pipes a driver connection through it, or runs the first SSH hop over it. The
 * target host is resolved by the proxy (SOCKS5 with a domain name, like socks5h).
 */

function proxyName(proxy: ProxyOptions): string {
  return proxy.kind === 'http' ? 'HTTP proxy' : 'SOCKS5 proxy';
}

/** Describes a proxy for messages: "SOCKS5 proxy proxy.example.com:1080". */
export function describeProxy(proxy: ProxyOptions): string {
  return `${proxyName(proxy)} ${hostLabel(proxy.host, proxy.port)}`;
}

function proxyPassword(
  proxy: ProxyOptions,
  secrets: Readonly<Record<string, string>>,
): string | undefined {
  if (!proxy.password) return undefined;
  const password = secrets[proxy.password.id];
  if (password === undefined) {
    throw tunnelError(
      'CONNECTION_FAILED',
      `The password for the ${describeProxy(proxy)} was not provided`,
      'Enter the proxy password, or save it in the profile',
      undefined,
      'PASSWORD_REQUIRED',
    );
  }
  return password;
}

/**
 * Opens a connection to `target` through the proxy, within `timeoutMs`. Failures are
 * CONNECTION_FAILED with a hint: proxy unreachable, credentials rejected or missing, or the
 * proxy refusing or failing to reach the target.
 */
export function connectThroughProxy(
  proxy: ProxyOptions,
  secrets: Readonly<Record<string, string>>,
  target: HostPort,
  timeoutMs: number,
): Promise<Socket> {
  let password: string | undefined;
  try {
    password = proxyPassword(proxy, secrets);
  } catch (error) {
    return Promise.reject(error);
  }
  return proxy.kind === 'socks5'
    ? socks5Connect(proxy, password, target, timeoutMs)
    : httpConnect(proxy, password, target, timeoutMs);
}

async function socks5Connect(
  proxy: ProxyOptions,
  password: string | undefined,
  target: HostPort,
  timeoutMs: number,
): Promise<Socket> {
  const where = hostLabel(proxy.host, proxy.port);
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        ...(proxy.user !== undefined ? { userId: proxy.user, password: password ?? '' } : {}),
      },
      command: 'connect',
      destination: { host: target.host, port: target.port },
      timeout: timeoutMs,
    });
    return socket;
  } catch (error) {
    throw mapSocksError(error, proxy, where, target, timeoutMs);
  }
}

const SOCKS_REFUSALS: Readonly<Record<string, string>> = {
  NotAllowed: 'the proxy rules do not allow it',
  NetworkUnreachable: 'the network is unreachable from the proxy',
  HostUnreachable: 'the host is unreachable from the proxy',
  ConnectionRefused: 'the connection was refused',
  TTLExpired: 'the connection timed out at the proxy',
};

function mapSocksError(
  error: unknown,
  proxy: ProxyOptions,
  where: string,
  target: HostPort,
  timeoutMs: number,
): JoineryError {
  const message = errorMessage(error);
  const name = `SOCKS5 proxy ${where}`;
  if (/Authentication failed/i.test(message)) {
    return tunnelError(
      'CONNECTION_FAILED',
      `The ${name} rejected the user name or password`,
      'Check the proxy user and password in the profile',
      error,
      'PROXY_AUTH_FAILED',
    );
  }
  if (/no accepted authentication type/i.test(message)) {
    return tunnelError(
      'CONNECTION_FAILED',
      proxy.user === undefined
        ? `The ${name} requires a user name and password`
        : `The ${name} does not accept user name and password authentication`,
      'Set the proxy user and password in the profile, or check the proxy settings',
      error,
      'PROXY_AUTH_FAILED',
    );
  }
  const refused = /Socks5 proxy rejected connection - (\w+)/.exec(message);
  if (refused) {
    const reason = SOCKS_REFUSALS[refused[1]!] ?? `it answered ${refused[1]}`;
    return tunnelError(
      'CONNECTION_FAILED',
      `The ${name} could not connect to ${hostLabel(target.host, target.port)}: ${reason}`,
      'Check the host and port as the proxy sees them, and that the proxy allows this destination',
      error,
      'PROXY_REFUSED',
    );
  }
  if (/timed out/i.test(message)) {
    return timeoutError('CONNECTION_FAILED', 'SOCKS5 proxy', where, timeoutMs);
  }
  if (/Socket closed|invalid Socks5/i.test(message)) {
    return tunnelError(
      'CONNECTION_FAILED',
      `The ${name} ended the handshake unexpectedly`,
      `Check that ${where} is a SOCKS5 proxy`,
      error,
    );
  }
  return mapSocketError(error, 'SOCKS5 proxy', where);
}

const MAX_RESPONSE_HEAD = 16 * 1024;

/** Opens an HTTP CONNECT tunnel; bytes that arrive after the response head are kept for the caller. */
function httpConnect(
  proxy: ProxyOptions,
  password: string | undefined,
  target: HostPort,
  timeoutMs: number,
): Promise<Socket> {
  const where = hostLabel(proxy.host, proxy.port);
  const name = `HTTP proxy ${where}`;
  const authority = hostLabel(target.host, target.port);
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let head = Buffer.alloc(0);
    const fail = (error: JoineryError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(timeoutError('CONNECTION_FAILED', 'HTTP proxy', where, timeoutMs)),
      timeoutMs,
    );
    const onError = (error: Error): void => fail(mapSocketError(error, 'HTTP proxy', where));
    const onClose = (): void =>
      fail(
        tunnelError(
          'CONNECTION_FAILED',
          `The ${name} closed the connection before answering`,
          `Check that ${where} is an HTTP proxy that supports CONNECT`,
        ),
      );
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > MAX_RESPONSE_HEAD) {
          fail(
            tunnelError(
              'CONNECTION_FAILED',
              `The ${name} sent an oversized response`,
              `Check that ${where} is an HTTP proxy`,
            ),
          );
        }
        return;
      }
      socket.off('data', onData);
      socket.pause();
      const statusLine = head.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
      const status = /^HTTP\/\d(?:\.\d)? (\d{3})\s*(.*)$/.exec(statusLine);
      if (!status) {
        fail(
          tunnelError(
            'CONNECTION_FAILED',
            `The ${name} sent a response that is not HTTP`,
            `Check that ${where} is an HTTP proxy`,
          ),
        );
        return;
      }
      const code = Number(status[1]);
      const reason = status[2] ? ` ${status[2]}` : '';
      if (code === 407) {
        fail(
          tunnelError(
            'CONNECTION_FAILED',
            proxy.user === undefined
              ? `The ${name} requires a user name and password (407${reason})`
              : `The ${name} rejected the user name or password (407${reason})`,
            'Check the proxy user and password in the profile',
            undefined,
            'PROXY_AUTH_FAILED',
          ),
        );
        return;
      }
      if (code < 200 || code > 299) {
        fail(
          tunnelError(
            'CONNECTION_FAILED',
            `The ${name} refused to connect to ${authority} (${code}${reason})`,
            'Check that the proxy allows CONNECT to this host and port, and that the host is reachable from it',
            undefined,
            'PROXY_REFUSED',
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('close', onClose);
      const rest = head.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.once('connect', () => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (proxy.user !== undefined) {
        const credentials = Buffer.from(`${proxy.user}:${password ?? ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${credentials}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}
