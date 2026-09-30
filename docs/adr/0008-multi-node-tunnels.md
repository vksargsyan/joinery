# 0008. Tunnels to topologies of several servers

- Status: Accepted (supersedes the "Tunnels reach one host" part of [ADR 0007](0007-nosql-engine-services.md))
- Date: 2026-09-29

## Context

An SSH tunnel or proxy used to give a driver one local endpoint forwarding to one host
(`endpointOverride`). That works for SQL servers and for a single MongoDB or Redis server, but
not for the topologies the spec lists (§2, §4): a MongoDB replica set (a host list, a
`mongodb+srv` name, a URI naming `replicaSet`), Redis Sentinel and Redis Cluster. Their drivers
discover the other servers from the first one and connect to them by the names or addresses
those servers announce, which usually resolve and route only behind the bastion. ADR 0007 therefore
refused these topologies behind a tunnel or proxy, in the tunnel layer, both drivers, the
connection dialog and joinery-cli.

The two drivers reach servers differently. The official `mongodb` driver can send every
connection it opens through a SOCKS5 proxy (`proxyHost`, `proxyPort`, `proxyUsername`,
`proxyPassword`), passing the host name unresolved. ioredis has no proxy support, but maps
every address it is about to use through its `natMap` option, which may be a synchronous
function (ioredis 6): for Cluster nodes from CLUSTER SLOTS, MOVED and ASK redirections, and for
the master, replicas and other Sentinels a Sentinel reports.

## Decision

**The tunnel layer decides what a profile reaches.** `tunnelReach(profile)` returns one `host`
(a host endpoint or a single-host URI) or `nodes` (the seeds, or an SRV record) for MongoDB host
lists, SRV names and URIs with several hosts, `+srv` or a `replicaSet` option, and for Redis
Sentinel and Cluster. A Unix socket and a SQL URI with several hosts are still refused.

**A transport to several servers keeps one route and adds a node route.** `TransportManager.open`
builds one route, an SSH chain (one shared session per hop path, jump hosts included) or the
configured SOCKS5 or HTTP proxy, and for a `nodes` reach returns a transport with `nodes`
(`NodeRoute`) beside the usual `endpointOverride` (a forward to the first server). The node
route offers:

- a **loopback SOCKS5 endpoint** (CONNECT only) that opens each request as a direct-tcpip
  channel (or a proxy connection) to the destination as named, so the SSH server or proxy
  resolves it. It requires a user name and password (RFC 1929), random per route and compared in
  constant time, so another local process cannot use the tunnel through it; at most
  `MAX_SOCKS_CHANNELS` (512) channels at once.
- **loopback forwards per server** (`forward`), opened on first use and reused, at most
  `MAX_NODE_FORWARDS` (64) per transport, and a **reserve** of pre-bound listeners
  (`reserve`, `forwardNow`) so a synchronous caller gets a forward for a server it has not
  seen before without waiting.

Everything a transport opened (SOCKS endpoint, forwards, reserve, their channels) closes with
it, and its SSH sessions are released as before; a crashed connection host takes its listeners
with it. `tunnelledProfile` passes the route to the driver as `nodeRoute` on the resolved
profile (`RoutedProfile`, read with `nodeRouteOf`); nothing in core changed, and a route never
crosses a process boundary: connection hosts, the job runner and joinery-cli open their own.

**MongoDB uses the SOCKS endpoint.** With a node route, `buildMongoClientPlan` keeps the
profile's own seeds or SRV name and discovery, sets the driver's proxy options to the route's
endpoint, and checks each member's certificate against its own name. A single host behind a
tunnel is unchanged: the forward, with `directConnection: true`.

**Redis uses forwards through ioredis's NAT map.** `NodeRouting` (Redis driver) forwards the
seeds or Sentinels, asks the first that answers for the rest (CLUSTER SLOTS, or the Sentinel's
master, replicas and peers), forwards those, keeps four reserved forwards, and gives ioredis a
`natMap` that maps every announced address to its forward, synchronously. A node that appears
later (a failover, a new replica, a MOVED or ASK to a node not seen yet) takes a reserved
forward; when none is left the map returns an address that fails at once (port 0) and opens a
forward for the next attempt, rather than letting ioredis use the announced address, which
would bypass the tunnel. With verify-full TLS each node's certificate is checked against the
name it announced (per node for Cluster, any configured Sentinel for the Sentinels).
`addressOf` shows the announced address, not the local forward, so node names, MOVED handling
and the topology view are the same as without a tunnel.

**SRV and TXT records are looked up on this computer.** The drivers resolve them locally, so
the tunnel layer looks the SRV record up when it opens the transport and fails with
`SRV_NOT_RESOLVED` and a hint (make the name resolvable here, or use a host list) when it does
not resolve. Atlas-style public SRV names work; a name only the bastion's DNS knows does not.

**Test Connection reports the SSH step, then the topology's own steps.** The transport's probe
passes when the first of the servers it names accepts a channel; the MongoDB check then runs
its TLS step against the first member through a forward and logs in through the SOCKS
endpoint, and the Redis check connects through the NAT map, so the version step reports the
replica set or the cluster as it does without a tunnel.

**Proxies without SSH use the same node route.** A SOCKS5 or HTTP proxy is bridged by the local
SOCKS endpoint and the forwards, one proxy connection per server connection, so HTTP CONNECT
proxies carry replica sets and clusters too.

## Consequences

- The connection dialog and joinery-cli accept these topologies with SSH (including jump hosts)
  and proxies; the dialog explains how nodes are reached and that SRV lookups stay local.
- Every server connection costs a direct-tcpip channel on the one SSH session (the MongoDB
  driver keeps a pool and monitoring connections per member); sshd's MaxSessions does not limit
  these, but a restrictive `PermitOpen` must allow every member.
- A Redis node that appears when the reserve is empty fails its first attempt; ioredis's
  retries and slot refreshes then find its forward. ioredis records the unmapped address of a
  MOVED target in its slot table until the next refresh; the driver's own MOVED handling
  compares announced addresses and is not affected.
- The Redis Sentinel topology view connects to the plan's seeds, which behind a tunnel are the
  forwarded Sentinels; with TLS verify-full it checks their certificates against 127.0.0.1
  unless the profile sets a TLS server name.
