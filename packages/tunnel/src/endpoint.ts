import { ENGINES, JoineryError, type ConnectionProfile, type HostPort } from '@joinery/core';

/** True when the profile needs a transport: an SSH tunnel, a proxy, or both. */
export function needsTransport(profile: ConnectionProfile): boolean {
  return profile.ssh !== undefined || profile.proxy !== undefined;
}

function notTunnellable(message: string, hint: string): JoineryError {
  return new JoineryError({ code: 'NOT_SUPPORTED', message, hint });
}

/**
 * The host and port of an Elasticsearch / OpenSearch node URL: the URL's port, else 443 for
 * https and 80 for http. A URL without a scheme is https unless TLS is off. Never echoes the URL.
 */
export function searchUrlTarget(url: string, tlsByDefault: boolean): HostPort {
  const text = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `${tlsByDefault ? 'https' : 'http'}://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'A node URL is not valid',
      hint: 'Use the form https://host:9200',
    });
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  return { host, port };
}

/**
 * The https URL of an Elastic Cloud deployment's Elasticsearch endpoint from its Cloud ID
 * ("name:base64(host[:port]$es-id$kibana-id)").
 */
export function cloudIdUrl(cloudId: string): string {
  const encoded = cloudId.slice(cloudId.indexOf(':') + 1).trim();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    decoded = '';
  }
  const [domain, esId] = decoded.split('$');
  if (!domain || !esId) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The Cloud ID is not valid',
      hint: "Copy the Cloud ID from the deployment's page in Elastic Cloud (name:base64 text)",
    });
  }
  const colon = domain.lastIndexOf(':');
  const port = colon === -1 ? '' : domain.slice(colon + 1);
  const host = colon === -1 ? domain : domain.slice(0, colon);
  return `https://${esId}.${host}${port && port !== '443' ? `:${port}` : ''}`;
}

/**
 * What a profile's SSH tunnel or proxy has to reach (see `tunnelReach`): one server, or a
 * topology of several whose members the driver discovers and reaches by the addresses they
 * announce (a MongoDB replica set, Redis Sentinel or Cluster).
 */
export type TunnelReach =
  | { readonly kind: 'host'; readonly target: HostPort }
  | {
      readonly kind: 'nodes';
      /** The servers the profile names: host list members, Sentinels or cluster seeds. */
      readonly seeds: readonly HostPort[];
      /**
       * The DNS SRV record that lists the servers instead (mongodb+srv), looked up on this
       * computer: the drivers resolve SRV and TXT records locally, not through the tunnel.
       */
      readonly srvRecord?: string;
    };

const UNIX_SOCKET = (hint: string): JoineryError =>
  notTunnellable('A Unix socket endpoint cannot be reached through an SSH tunnel or a proxy', hint);

/**
 * The servers a profile's tunnel or proxy reaches (spec §4):
 *
 * - `host`: a host endpoint or a single-host URI (the engine's default port when the URI names
 *   none; an empty host is `localhost`, as seen from the SSH server). MongoDB then talks to that
 *   one server (directConnection).
 * - `nodes`: a MongoDB host list, SRV name, or a URI with several hosts, `+srv` or a
 *   `replicaSet` option; Redis Sentinel and Cluster. Every server is reached through the tunnel
 *   by the name it announces, resolved on the far side.
 *
 * A Unix socket, and a host list in a SQL URI, cannot be tunnelled and throw NOT_SUPPORTED. The
 * URI is never echoed: it may hold a password.
 */
export function tunnelReach(profile: ConnectionProfile): TunnelReach {
  const endpoint = profile.endpoint;
  switch (endpoint.kind) {
    case 'host':
      return { kind: 'host', target: { host: endpoint.host, port: endpoint.port } };
    case 'socket':
      throw UNIX_SOCKET(
        'Use the host and TCP port of the database as seen from the SSH server (often 127.0.0.1), or remove the tunnel',
      );
    case 'hosts':
      return { kind: 'nodes', seeds: endpoint.hosts.map(({ host, port }) => ({ host, port })) };
    case 'srv':
      return { kind: 'nodes', seeds: [], srvRecord: `_mongodb._tcp.${endpoint.host}` };
    case 'sentinel':
      return { kind: 'nodes', seeds: endpoint.sentinels.map(({ host, port }) => ({ host, port })) };
    case 'cluster':
      return { kind: 'nodes', seeds: endpoint.seeds.map(({ host, port }) => ({ host, port })) };
    case 'urls': {
      // Elasticsearch / OpenSearch: one node URL (the others would bypass the tunnel).
      if (endpoint.urls.length !== 1) {
        throw notTunnellable(
          'Only a single node URL can be reached through an SSH tunnel or a proxy',
          'Keep one URL in the list (Joinery does not discover other nodes through a tunnel)',
        );
      }
      return {
        kind: 'host',
        target: searchUrlTarget(endpoint.urls[0]!, profile.tls.mode !== 'disable'),
      };
    }
    case 'cloudId':
      return { kind: 'host', target: searchUrlTarget(cloudIdUrl(endpoint.cloudId), true) };
    case 'uri':
      return profile.engine === 'mongodb'
        ? mongoUriReach(endpoint.uri)
        : {
            kind: 'host',
            target: singleHostUri(endpoint.uri, ENGINES[profile.engine].defaultPort),
          };
  }
}

/**
 * The one host and port the last SSH hop (or the proxy) connects to for a profile that reaches
 * a single server (see `tunnelReach`); for a topology of several servers, the first one it
 * names. An SRV name names none and throws NOT_SUPPORTED, as do the endpoints `tunnelReach`
 * refuses.
 */
export function tunnelTarget(profile: ConnectionProfile): HostPort {
  const reach = tunnelReach(profile);
  if (reach.kind === 'host') return reach.target;
  const first = reach.seeds[0];
  if (!first) {
    throw notTunnellable(
      'An SRV connection string names no single server',
      'Its servers are found by looking up the SRV record; connect with a host list to name them',
    );
  }
  return first;
}

function singleHostUri(uri: string, defaultPort: number): HostPort {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri.trim())?.[1]?.toLowerCase();
  if (scheme?.endsWith('+srv')) {
    throw notTunnellable(
      'An SRV connection string cannot be reached through an SSH tunnel or a proxy',
      'Use the host and port of one server instead of the +srv form',
    );
  }
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw notTunnellable(
      'Only a single-host connection URI can be reached through an SSH tunnel or a proxy',
      'Use one host and port in the URI, or a host endpoint',
    );
  }
  const hostParam = url.searchParams.get('host') ?? undefined;
  const host = decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1')) || hostParam;
  if (url.searchParams.has('socket') || host?.startsWith('/')) {
    throw UNIX_SOCKET(
      'Use the host and TCP port of the database as seen from the SSH server, or remove the tunnel',
    );
  }
  const portParam = Number(url.searchParams.get('port'));
  const port = url.port
    ? Number(url.port)
    : Number.isInteger(portParam) && portParam > 0
      ? portParam
      : defaultPort;
  return { host: host || 'localhost', port };
}

function invalidMongoUri(): JoineryError {
  return new JoineryError({
    code: 'VALIDATION_FAILED',
    message: 'The MongoDB connection string is not valid',
    hint: 'Use the form mongodb://host:port,host:port/database?options or mongodb+srv://cluster.example.net',
  });
}

/** A mongodb:// or mongodb+srv:// URI: one server, or the replica set its hosts or SRV name list. */
function mongoUriReach(uri: string): TunnelReach {
  const text = uri.trim();
  const scheme = /^(mongodb(?:\+srv)?):\/\//i.exec(text);
  if (!scheme) throw invalidMongoUri();
  const rest = text.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const hostList = authority.slice(authority.lastIndexOf('@') + 1);
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1) : '';
  if (hostList === '') throw invalidMongoUri();
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw invalidMongoUri();
    }
  };
  if (scheme[1]!.toLowerCase() === 'mongodb+srv') {
    return { kind: 'nodes', seeds: [], srvRecord: `_mongodb._tcp.${decode(hostList)}` };
  }
  const defaultPort = ENGINES.mongodb.defaultPort;
  const seeds = hostList.split(',').map((entry): HostPort => {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
    }
    const colon = entry.lastIndexOf(':');
    const host = decode(colon === -1 ? entry : entry.slice(0, colon));
    const port = colon === -1 ? defaultPort : Number(entry.slice(colon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidMongoUri();
    if (host.startsWith('/')) {
      throw UNIX_SOCKET(
        'Use the host and TCP port of MongoDB as seen from the SSH server, or remove the tunnel',
      );
    }
    return { host, port };
  });
  const replicaSet = new URLSearchParams(query).has('replicaSet');
  return seeds.length === 1 && !replicaSet
    ? { kind: 'host', target: seeds[0]! }
    : { kind: 'nodes', seeds };
}
