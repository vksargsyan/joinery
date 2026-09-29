import { z } from 'zod';

import { ENGINES, engineIdSchema, type EngineId } from './engines';

/**
 * Connection profiles (spec §4). A profile holds everything needed to reach one server.
 * Secrets never live in the profile: it holds `SecretRef`s, and the sealed values are stored
 * separately by @joinery/storage and resolved only inside the connection host.
 */

export const environmentSchema = z.enum(['dev', 'test', 'staging', 'production']);
export type Environment = z.infer<typeof environmentSchema>;

/** Per secret, the user picks: save it, remember it for this app session, or ask every time. */
export const secretPolicySchema = z.enum(['save', 'session', 'ask']);
export type SecretPolicy = z.infer<typeof secretPolicySchema>;

export const secretRefSchema = z.object({
  /** Key of the sealed value in the secret store. */
  id: z.string().min(1),
  policy: secretPolicySchema.default('save'),
});
export type SecretRef = z.infer<typeof secretRefSchema>;
export type SecretRefInput = z.input<typeof secretRefSchema>;

const hostSchema = z.string().min(1);
const portSchema = z.number().int().min(1).max(65535);

export const hostPortSchema = z.object({ host: hostSchema, port: portSchema });
export type HostPort = z.infer<typeof hostPortSchema>;

export const endpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), host: hostSchema, port: portSchema }),
  z.object({ kind: z.literal('socket'), path: z.string().min(1) }),
  /** A connection URI with any password removed (it is stored as a secret instead). */
  z.object({ kind: z.literal('uri'), uri: z.string().min(1) }),
  /** MongoDB host list. */
  z.object({
    kind: z.literal('hosts'),
    hosts: z.array(hostPortSchema).min(1),
    replicaSet: z.string().optional(),
  }),
  /** mongodb+srv:// seed host. */
  z.object({ kind: z.literal('srv'), host: hostSchema }),
  z.object({
    kind: z.literal('sentinel'),
    sentinels: z.array(hostPortSchema).min(1),
    masterName: z.string().min(1),
  }),
  z.object({ kind: z.literal('cluster'), seeds: z.array(hostPortSchema).min(1) }),
  /** Elasticsearch / OpenSearch node URLs. */
  z.object({ kind: z.literal('urls'), urls: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('cloudId'), cloudId: z.string().min(1) }),
]);
export type Endpoint = z.infer<typeof endpointSchema>;
export type EndpointKind = Endpoint['kind'];

/** Endpoint forms each engine accepts (spec §4, "Endpoints and auth"). */
export const ENDPOINT_KINDS: Readonly<Record<EngineId, readonly EndpointKind[]>> = {
  mysql: ['host', 'socket', 'uri'],
  mariadb: ['host', 'socket', 'uri'],
  postgres: ['host', 'socket', 'uri'],
  mongodb: ['host', 'hosts', 'srv', 'uri'],
  redis: ['host', 'socket', 'sentinel', 'cluster', 'uri'],
  elasticsearch: ['urls', 'cloudId'],
  opensearch: ['urls'],
};

export const authSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('none') }),
  z.object({
    method: z.literal('password'),
    user: z.string().optional(),
    password: secretRefSchema.optional(),
    /** Engine auth plugin or SASL mechanism, e.g. caching_sha2_password, SCRAM-SHA-256. */
    mechanism: z.string().optional(),
  }),
  /** Authenticate with the TLS client certificate configured under `tls`. */
  z.object({ method: z.literal('clientCertificate'), user: z.string().optional() }),
  z.object({ method: z.literal('apiKey'), apiKey: secretRefSchema }),
  z.object({ method: z.literal('bearer'), token: secretRefSchema }),
]);
export type Auth = z.infer<typeof authSchema>;

export const tlsModeSchema = z.enum(['disable', 'require', 'verify-ca', 'verify-full']);
export type TlsMode = z.infer<typeof tlsModeSchema>;

export const tlsSchema = z.object({
  /** Default is verify-full; anything weaker shows a persistent warning in the UI. */
  mode: tlsModeSchema.default('verify-full'),
  caPath: z.string().optional(),
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
  keyPassphrase: secretRefSchema.optional(),
  /** SNI / hostname override for certificate verification. */
  servername: z.string().optional(),
});
export type TlsOptions = z.infer<typeof tlsSchema>;

export const sshAuthSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), password: secretRefSchema }),
  z.object({
    method: z.literal('privateKey'),
    keyPath: z.string().min(1),
    passphrase: secretRefSchema.optional(),
  }),
  z.object({ method: z.literal('agent') }),
]);
export type SshAuth = z.infer<typeof sshAuthSchema>;

export const sshHopSchema = z.object({
  host: hostSchema,
  port: portSchema.default(22),
  user: z.string().min(1),
  auth: sshAuthSchema,
});
export type SshHop = z.infer<typeof sshHopSchema>;

/** One or more SSH hops; the last hop forwards to the database endpoint. */
export const sshTunnelSchema = z.object({
  hops: z.array(sshHopSchema).min(1),
  keepAliveIntervalMs: z.number().int().nonnegative().default(15_000),
});
export type SshTunnel = z.infer<typeof sshTunnelSchema>;

export const proxySchema = z.object({
  kind: z.enum(['http', 'socks5']),
  host: hostSchema,
  port: portSchema,
  user: z.string().optional(),
  password: secretRefSchema.optional(),
});
export type ProxyOptions = z.infer<typeof proxySchema>;

export const connectionOptionsSchema = z.object({
  connectTimeoutMs: z.number().int().positive().default(10_000),
  queryTimeoutMs: z.number().int().positive().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  keepAlive: z.boolean().default(true),
  charset: z.string().optional(),
  timeZone: z.string().optional(),
  /** Statements run on every new session, in order. */
  initSql: z.array(z.string()).default([]),
  /** For Redis, the logical database number as text ("0" to "15" on a default server). */
  defaultDatabase: z.string().optional(),
  applicationName: z.string().default('Joinery'),
  /** MongoDB: the database that holds the user's credentials (the driver's default: admin). */
  authSource: z.string().min(1).optional(),
  /** MongoDB: talk to the one host given instead of discovering the replica set from it. */
  directConnection: z.boolean().optional(),
  /** MongoDB: which members reads may go to (the driver's default: primary). */
  readPreference: z
    .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
    .optional(),
  /** Redis: the delimiter that splits key names into the browser's namespace tree (default ":"). */
  keyDelimiter: z.string().min(1).max(16).optional(),
});
export type ConnectionOptions = z.infer<typeof connectionOptionsSchema>;

export const presentationSchema = z.object({
  folderId: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  /** Hex colour, e.g. #e5484d. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  environment: environmentSchema.default('dev'),
  /** Locked read-only: every write is refused. */
  readOnly: z.boolean().default(false),
  /** Ask before every write. Always on for production profiles. */
  confirmWrites: z.boolean().default(false),
});
export type Presentation = z.infer<typeof presentationSchema>;

export const connectionProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    engine: engineIdSchema,
    endpoint: endpointSchema,
    auth: authSchema.default({ method: 'none' }),
    tls: tlsSchema.default({ mode: 'verify-full' }),
    ssh: sshTunnelSchema.optional(),
    proxy: proxySchema.optional(),
    options: connectionOptionsSchema.default(connectionOptionsSchema.parse({})),
    presentation: presentationSchema.default(presentationSchema.parse({})),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((profile, ctx) => {
    const allowed = ENDPOINT_KINDS[profile.engine];
    if (!allowed.includes(profile.endpoint.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endpoint', 'kind'],
        message: `${ENGINES[profile.engine].displayName} does not accept a "${profile.endpoint.kind}" endpoint; use one of: ${allowed.join(', ')}`,
      });
    }
  });

/** A validated profile with defaults applied. */
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
/** What callers pass in to create or update a profile (defaults optional). */
export type ConnectionProfileInput = z.input<typeof connectionProfileSchema>;

/** Every secret reference a profile holds, so the host knows what to unseal before connecting. */
export function secretRefsOf(profile: ConnectionProfile): SecretRef[] {
  const refs: SecretRef[] = [];
  const auth = profile.auth;
  if (auth.method === 'password' && auth.password) refs.push(auth.password);
  if (auth.method === 'apiKey') refs.push(auth.apiKey);
  if (auth.method === 'bearer') refs.push(auth.token);
  if (profile.tls.keyPassphrase) refs.push(profile.tls.keyPassphrase);
  for (const hop of profile.ssh?.hops ?? []) {
    if (hop.auth.method === 'password') refs.push(hop.auth.password);
    if (hop.auth.method === 'privateKey' && hop.auth.passphrase) refs.push(hop.auth.passphrase);
  }
  if (profile.proxy?.password) refs.push(profile.proxy.password);
  return refs;
}

/** Production profiles confirm every write (spec §4); others only when the user asked for it. */
export function requiresWriteConfirmation(profile: ConnectionProfile): boolean {
  return profile.presentation.environment === 'production' || profile.presentation.confirmWrites;
}

/** TLS verification is off or partial, so the UI must show a persistent warning. */
export function hasWeakTls(profile: ConnectionProfile): boolean {
  return profile.tls.mode !== 'verify-full';
}
