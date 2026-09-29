import { ENGINES, JoineryError, type ConnectionProfile, type HostPort } from '@joinery/core';

/** True when the profile needs a transport: an SSH tunnel, a proxy, or both. */
export function needsTransport(profile: ConnectionProfile): boolean {
  return profile.ssh !== undefined || profile.proxy !== undefined;
}

function notTunnellable(message: string, hint: string): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message, hint });
}

/**
 * The host and port the last SSH hop (or the proxy) connects to: the profile's host endpoint, or
 * the single host of a URI endpoint (the engine's default port when the URI names none; an empty
 * host is `localhost`, as seen from the SSH server). A Unix socket, a host list or an SRV name
 * cannot be tunnelled and throws NOT_SUPPORTED. The URI is never echoed: it may hold a password.
 */
export function tunnelTarget(profile: ConnectionProfile): HostPort {
  const endpoint = profile.endpoint;
  switch (endpoint.kind) {
    case 'host':
      return { host: endpoint.host, port: endpoint.port };
    case 'socket':
      throw notTunnellable(
        'A Unix socket endpoint cannot be reached through an SSH tunnel or a proxy',
        'Use the host and TCP port of the database as seen from the SSH server (often 127.0.0.1), or remove the tunnel',
      );
    case 'uri': {
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(endpoint.uri.trim())?.[1]?.toLowerCase();
      if (scheme?.endsWith('+srv')) {
        throw notTunnellable(
          'An SRV connection string cannot be reached through an SSH tunnel or a proxy',
          'Use the host and port of one server instead of the +srv form',
        );
      }
      let url: URL;
      try {
        url = new URL(endpoint.uri.trim());
      } catch {
        throw notTunnellable(
          'Only a single-host connection URI can be reached through an SSH tunnel or a proxy',
          'Use one host and port in the URI, or a host endpoint',
        );
      }
      const hostParam = url.searchParams.get('host') ?? undefined;
      const host = decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1')) || hostParam;
      if (url.searchParams.has('socket') || host?.startsWith('/')) {
        throw notTunnellable(
          'A Unix socket endpoint cannot be reached through an SSH tunnel or a proxy',
          'Use the host and TCP port of the database as seen from the SSH server, or remove the tunnel',
        );
      }
      const portParam = Number(url.searchParams.get('port'));
      const port = url.port
        ? Number(url.port)
        : Number.isInteger(portParam) && portParam > 0
          ? portParam
          : ENGINES[profile.engine].defaultPort;
      return { host: host || 'localhost', port };
    }
    default:
      throw notTunnellable(
        `A "${endpoint.kind}" endpoint cannot be reached through an SSH tunnel or a proxy yet`,
        'Use a single host and port endpoint, or connect without the tunnel',
      );
  }
}
