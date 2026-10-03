import {
  DEFAULT_PRIVILEGE_TYPES,
  GRANT_OBJECT_KINDS,
  MAINTENANCE_OPERATIONS,
  POLICY_COMMANDS,
  SETTING_SCOPES,
  TOP_QUERY_ORDERS,
  engineIdSchema,
  type AccessDetails,
  type AccessFeature,
  type AccessOverview,
  type AccountOptions,
  type AccountRef,
  type ActionPreview,
  type ActionResult,
  type DefaultPrivilege,
  type GrantMatrix,
  type GrantObjectRef,
  type GrantRow,
  type GrantState,
  type MaintenanceOperationInfo,
  type MaintenanceTarget,
  type MaintenanceTargetRef,
  type MaintenanceTargets,
  type MonitorSection,
  type MonitorSnapshot,
  type MonitorTile,
  type ProfilerStatus,
  type RlsPolicy,
  type RlsTable,
  type RoleMembership,
  type ServerAccount,
  type ServerAction,
  type ServerNotice,
  type ServerSession,
  type ServerSetting,
  type ServerToolsInfo,
  type SessionList,
  type SessionListOptions,
  type SettingList,
  type ToolColumn,
  type ToolTable,
  type TopQueries,
  type TopQuery,
  type TopQueryOptions,
  type ValueUnit,
} from '@querybara/core';
import { z } from 'zod';

/**
 * Zod schemas for the server tools (spec §15), typed from @querybara/core's engine-neutral
 * shapes so a drift between the drivers' results and what crosses the port fails to compile.
 */

type Schema<T> = z.ZodType<T, T>;

const text = z.string().max(1_000_000);
const name = z.string().min(1).max(512);
const count = z.number().int().nonnegative();

export const valueUnitSchema: Schema<ValueUnit> = z.enum([
  'count',
  'bytes',
  'ms',
  'seconds',
  'ratio',
  'percent',
  'text',
  'time',
  'bool',
]);

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const cellRecordSchema = z.record(z.string(), cellSchema);

export const toolColumnSchema: Schema<ToolColumn> = z.object({
  key: z.string(),
  label: z.string(),
  unit: valueUnitSchema.optional(),
});

export const toolTableSchema: Schema<ToolTable> = z.object({
  columns: z.array(toolColumnSchema),
  rows: z.array(cellRecordSchema),
});

export const serverNoticeSchema: Schema<ServerNotice> = z.object({
  level: z.enum(['info', 'warning', 'error']),
  message: text,
  hint: text.optional(),
});
const notices = z.array(serverNoticeSchema);

// ------------------------------------------------------------------------------------ info

const maintenanceOperationSchema = z.enum(MAINTENANCE_OPERATIONS);
const settingScopeSchema = z.enum(SETTING_SCOPES);
const topQueryOrderSchema = z.enum(TOP_QUERY_ORDERS);

export const maintenanceOperationInfoSchema: Schema<MaintenanceOperationInfo> = z.object({
  id: maintenanceOperationSchema,
  label: z.string(),
  description: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  multiple: z.boolean(),
  usesIndex: z.boolean().optional(),
});

const accessFeatureSchema: Schema<AccessFeature> = z.enum([
  'hosts',
  'roles',
  'membership',
  'grants',
  'defaultPrivileges',
  'policies',
  'lock',
]);

export const serverToolsInfoSchema: Schema<ServerToolsInfo> = z.object({
  engine: engineIdSchema,
  product: z.string(),
  version: z.string(),
  user: z.string(),
  database: z.string().nullable(),
  databases: z.array(z.string()),
  perDatabaseSessions: z.boolean(),
  sessionActions: z.array(
    z.object({
      operation: z.enum(['cancel', 'terminate']),
      label: z.string(),
      description: z.string(),
    }),
  ),
  maintenance: z.array(maintenanceOperationInfoSchema),
  settingScopes: z.array(
    z.object({ scope: settingScopeSchema, label: z.string(), description: z.string() }),
  ),
  topQueryOrders: z.array(topQueryOrderSchema),
  access: z.array(accessFeatureSchema),
  notices,
});

// --------------------------------------------------------------------------------- monitor

const nullableNumber = z.number().nullable();

export const monitorTileSchema: Schema<MonitorTile> = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    label: z.string(),
    kind: z.literal('gauge'),
    unit: valueUnitSchema,
    value: nullableNumber,
    detail: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    label: z.string(),
    kind: z.literal('rate'),
    unit: valueUnitSchema,
    counter: nullableNumber,
    detail: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    label: z.string(),
    kind: z.literal('ratio'),
    hits: nullableNumber,
    total: nullableNumber,
    unit: valueUnitSchema.optional(),
    detail: z.string().optional(),
  }),
]);

export const monitorSectionSchema: Schema<MonitorSection> = z.object({
  id: z.string(),
  title: z.string(),
  table: toolTableSchema,
  empty: z.string().optional(),
  notice: serverNoticeSchema.optional(),
});

export const monitorSnapshotSchema: Schema<MonitorSnapshot> = z.object({
  at: z.number(),
  uptimeSeconds: nullableNumber,
  tiles: z.array(monitorTileSchema),
  sections: z.array(monitorSectionSchema),
  notices,
});

// -------------------------------------------------------------------------------- sessions

export const serverSessionSchema: Schema<ServerSession> = z.object({
  id: z.string(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  client: z.string().nullable(),
  application: z.string().nullable(),
  state: z.string().nullable(),
  durationMs: nullableNumber,
  wait: z.string().nullable(),
  query: z.string().nullable(),
  blockedBy: z.array(z.string()),
  own: z.boolean(),
  background: z.boolean(),
  idle: z.boolean(),
  detail: cellRecordSchema,
});

export const sessionListOptionsSchema: Schema<SessionListOptions> = z.object({
  includeIdle: z.boolean().optional(),
  includeBackground: z.boolean().optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

export const sessionListSchema: Schema<SessionList> = z.object({
  sessions: z.array(serverSessionSchema),
  detailColumns: z.array(toolColumnSchema),
  notices,
  truncated: z.boolean(),
});

// ----------------------------------------------------------------------------- top queries

export const topQuerySchema: Schema<TopQuery> = z.object({
  id: z.string(),
  text: z.string(),
  database: z.string().nullable(),
  user: z.string().nullable(),
  calls: z.number(),
  totalMs: z.number(),
  meanMs: z.number(),
  maxMs: nullableNumber,
  rows: nullableNumber,
  detail: cellRecordSchema,
});

export const topQueryOptionsSchema: Schema<TopQueryOptions> = z.object({
  orderBy: topQueryOrderSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  database: name.optional(),
});

export const profilerStatusSchema: Schema<ProfilerStatus> = z.object({
  database: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  slowMs: nullableNumber,
  sampleRate: nullableNumber,
});

// ----------------------------------------------------------------------------------- users

export const accountRefSchema: Schema<AccountRef> = z.object({
  // MySQL and MariaDB have anonymous accounts (''@'localhost').
  name: z.string().max(512),
  host: z.string().max(255).optional(),
});

export const roleMembershipSchema: Schema<RoleMembership> = z.object({
  role: accountRefSchema,
  admin: z.boolean(),
  inherit: z.boolean().optional(),
  set: z.boolean().optional(),
});

export const serverAccountSchema: Schema<ServerAccount> = z.object({
  name: z.string(),
  host: z.string().optional(),
  kind: z.enum(['user', 'role']),
  canLogin: z.boolean(),
  superuser: z.boolean(),
  locked: z.boolean().optional(),
  attributes: z.array(z.string()),
  memberOf: z.array(roleMembershipSchema),
  connectionLimit: nullableNumber.optional(),
  validUntil: z.string().nullable().optional(),
  builtin: z.boolean(),
});

export const accessOverviewSchema: Schema<AccessOverview> = z.object({
  accounts: z.array(serverAccountSchema),
  notices,
});

const grantObjectKindSchema = z.enum(GRANT_OBJECT_KINDS);

export const grantObjectRefSchema: Schema<GrantObjectRef> = z.object({
  kind: grantObjectKindSchema,
  database: name.optional(),
  schema: name.optional(),
  name: name.optional(),
  signature: z.string().max(4000).optional(),
});

const grantStateSchema: Schema<GrantState> = z.enum(['none', 'granted', 'grantable', 'implied']);

export const grantRowSchema: Schema<GrantRow> = z.object({
  object: grantObjectRefSchema,
  label: z.string(),
  type: z.string(),
  privileges: z.record(z.string(), grantStateSchema),
});

export const grantMatrixSchema: Schema<GrantMatrix> = z.object({
  grantee: accountRefSchema,
  scope: z.string().nullable(),
  scopes: z.array(z.string()),
  privileges: z.partialRecord(grantObjectKindSchema, z.array(z.string())),
  rows: z.array(grantRowSchema),
  notices,
});

const defaultPrivilegeTypeSchema = z.enum(DEFAULT_PRIVILEGE_TYPES);
const policyCommandSchema = z.enum(POLICY_COMMANDS);

export const defaultPrivilegeSchema: Schema<DefaultPrivilege> = z.object({
  owner: z.string(),
  schema: z.string().nullable(),
  objectType: defaultPrivilegeTypeSchema,
  grantee: z.string(),
  privileges: z.array(z.string()),
  grantable: z.array(z.string()),
});

export const rlsPolicySchema: Schema<RlsPolicy> = z.object({
  name: z.string(),
  permissive: z.boolean(),
  command: policyCommandSchema,
  roles: z.array(z.string()),
  using: z.string().nullable(),
  withCheck: z.string().nullable(),
});

export const rlsTableSchema: Schema<RlsTable> = z.object({
  schema: z.string(),
  table: z.string(),
  enabled: z.boolean(),
  forced: z.boolean(),
  policies: z.array(rlsPolicySchema),
});

export const accessDetailsSchema: Schema<AccessDetails> = z.object({
  schema: z.string(),
  schemas: z.array(z.string()),
  defaultPrivileges: z.array(defaultPrivilegeSchema),
  tables: z.array(rlsTableSchema),
  notices,
});

// ----------------------------------------------------------------------------- maintenance

export const maintenanceTargetRefSchema: Schema<MaintenanceTargetRef> = z.object({
  container: name,
  name: name,
});

export const maintenanceTargetSchema: Schema<MaintenanceTarget> = z.object({
  container: z.string(),
  name: z.string(),
  type: z.string(),
  indexes: z.array(z.string()),
  detail: cellRecordSchema,
});

export const maintenanceTargetsSchema: Schema<MaintenanceTargets> = z.object({
  containers: z.array(z.string()),
  container: z.string().nullable(),
  targets: z.array(maintenanceTargetSchema),
  detailColumns: z.array(toolColumnSchema),
  notices,
});

// -------------------------------------------------------------------------------- settings

export const serverSettingSchema: Schema<ServerSetting> = z.object({
  name: z.string(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  type: z.enum(['bool', 'integer', 'real', 'string', 'enum', 'document']).nullable(),
  enumValues: z.array(z.string()),
  min: z.string().nullable(),
  max: z.string().nullable(),
  defaultValue: z.string().nullable(),
  scopes: z.array(settingScopeSchema),
  restartRequired: z.boolean(),
  pendingRestart: z.boolean(),
});

export const settingListSchema: Schema<SettingList> = z.object({
  settings: z.array(serverSettingSchema),
  notices,
});

// --------------------------------------------------------------------------------- actions

export const accountOptionsSchema: Schema<AccountOptions> = z.object({
  password: z.string().max(1024).optional(),
  login: z.boolean().optional(),
  superuser: z.boolean().optional(),
  createDb: z.boolean().optional(),
  createRole: z.boolean().optional(),
  replication: z.boolean().optional(),
  bypassRls: z.boolean().optional(),
  inherit: z.boolean().optional(),
  connectionLimit: z.number().int().min(-1).optional(),
  validUntil: z.string().max(100).nullable().optional(),
  locked: z.boolean().optional(),
});

const privileges = z.array(z.string().min(1).max(100)).max(100);

const grantAction = <K extends 'grant' | 'revoke'>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    grantee: accountRefSchema,
    object: grantObjectRefSchema,
    privileges,
    grantOption: z.boolean().optional(),
  });

const membershipAction = <K extends 'grantRole' | 'revokeRole'>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    role: accountRefSchema,
    member: accountRefSchema,
    admin: z.boolean().optional(),
  });

export const serverActionSchema: Schema<ServerAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    operation: z.enum(['cancel', 'terminate']),
    id: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal('maintenance'),
    operation: maintenanceOperationSchema,
    targets: z.array(maintenanceTargetRefSchema).max(1000),
    options: z.array(z.string().max(64)).max(20),
    index: name.optional(),
  }),
  z.object({
    kind: z.literal('setting'),
    name: z.string().min(1).max(200),
    value: z.string().max(100_000).nullable(),
    scope: settingScopeSchema,
  }),
  z.object({
    kind: z.literal('topQueries'),
    operation: z.enum(['reset', 'enable']),
    database: name.optional(),
  }),
  z.object({
    kind: z.literal('profiler'),
    database: name,
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    slowMs: count.optional(),
    sampleRate: z.number().gt(0).lte(1).optional(),
  }),
  z.object({
    kind: z.literal('createAccount'),
    account: accountRefSchema,
    role: z.boolean(),
    options: accountOptionsSchema,
  }),
  z.object({
    kind: z.literal('alterAccount'),
    account: accountRefSchema,
    options: accountOptionsSchema,
    rename: accountRefSchema.optional(),
  }),
  z.object({ kind: z.literal('dropAccount'), account: accountRefSchema, role: z.boolean() }),
  grantAction('grant'),
  grantAction('revoke'),
  membershipAction('grantRole'),
  membershipAction('revokeRole'),
  z.object({
    kind: z.literal('defaultPrivileges'),
    operation: z.enum(['grant', 'revoke']),
    owner: name.optional(),
    schema: name.optional(),
    objectType: defaultPrivilegeTypeSchema,
    grantee: name,
    privileges,
    grantOption: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('createPolicy'),
    schema: name,
    table: name,
    name: name,
    permissive: z.boolean(),
    command: policyCommandSchema,
    roles: z.array(name).max(100),
    using: z.string().max(100_000).optional(),
    withCheck: z.string().max(100_000).optional(),
  }),
  z.object({ kind: z.literal('dropPolicy'), schema: name, table: name, name: name }),
  z.object({
    kind: z.literal('rowSecurity'),
    schema: name,
    table: name,
    enabled: z.boolean(),
    forced: z.boolean().optional(),
  }),
]);

export const actionPreviewSchema: Schema<ActionPreview> = z.object({
  title: z.string(),
  summary: z.string(),
  statements: z.array(z.string()),
  notices,
});

export const actionResultSchema: Schema<ActionResult> = z.object({
  statements: z.array(z.string()),
  messages: notices,
  table: toolTableSchema.nullable(),
  durationMs: z.number().nonnegative(),
});

export const topQueriesSchema: Schema<TopQueries> = z.object({
  unavailable: z
    .object({
      reason: z.enum(['not-installed', 'not-loaded', 'disabled', 'no-privilege', 'not-supported']),
      message: z.string(),
      hint: z.string().optional(),
      fix: serverActionSchema.optional(),
    })
    .nullable(),
  queries: z.array(topQuerySchema),
  detailColumns: z.array(toolColumnSchema),
  notices,
  resettable: z.boolean(),
  profiler: profilerStatusSchema.nullable(),
});
