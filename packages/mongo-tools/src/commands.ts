import { isBsonDocument, type BsonDocument, type BsonValue } from './bson';

/**
 * What a MongoDB command document does, for the write rules (spec §4, §6) that the desktop
 * console and joinery-cli apply before running typed commands: a read-only profile refuses
 * commands that write, destructive ones (drops, multi-document deletes and updates, killOp,
 * shutdown...) ask on every profile, and production profiles ask before every write. Unknown
 * commands count as reads, as the server decides what they may do.
 */

export interface CommandSafety {
  /** The command's name (its first key); undefined for an empty document. */
  readonly name: string | undefined;
  readonly writes: boolean;
  readonly destructive: boolean;
}

const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'create',
  'createIndexes',
  'collMod',
  'renameCollection',
  'createUser',
  'updateUser',
  'grantRolesToUser',
  'revokeRolesFromUser',
  'createRole',
  'updateRole',
  'grantRolesToRole',
  'revokeRolesFromRole',
  'grantPrivilegesToRole',
  'revokePrivilegesFromRole',
  'killCursors',
  'setParameter',
  'applyOps',
  'cloneCollectionAsCapped',
]);

const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'drop',
  'dropDatabase',
  'dropIndexes',
  'deleteIndexes',
  'dropUser',
  'dropAllUsersFromDatabase',
  'dropRole',
  'dropAllRolesFromDatabase',
  'killOp',
  'killSessions',
  'killAllSessions',
  'killAllSessionsByPattern',
  'shutdown',
  'compact',
  'convertToCapped',
  'emptycapped',
  'replSetStepDown',
  'replSetReconfig',
  'setFeatureCompatibilityVersion',
  'fsync',
]);

function statements(command: BsonDocument, key: string): BsonDocument[] {
  const value = command[key];
  return Array.isArray(value) ? value.filter(isBsonDocument) : [];
}

function isZero(value: BsonValue | undefined): boolean {
  return value !== undefined && value !== null && Number(String(value.valueOf())) === 0;
}

/** Whether the command's statements touch every document a filter matches. */
function bulk(name: string, command: BsonDocument): boolean {
  if (name === 'delete') return statements(command, 'deletes').some((s) => isZero(s['limit']));
  if (name === 'update') return statements(command, 'updates').some((s) => s['multi'] === true);
  return false;
}

/** An aggregation that ends in $out or $merge writes its results. */
function pipelineWrites(command: BsonDocument): boolean {
  const pipeline = command['pipeline'];
  if (!Array.isArray(pipeline) || pipeline.length === 0) return false;
  const last = pipeline[pipeline.length - 1];
  if (!isBsonDocument(last)) return false;
  const stage = Object.keys(last)[0];
  return stage === '$out' || stage === '$merge';
}

function isInline(out: BsonValue | undefined): boolean {
  return isBsonDocument(out) && out['inline'] !== undefined;
}

/** Classifies one command document (see the module comment). */
export function commandSafety(command: BsonDocument): CommandSafety {
  const name = Object.keys(command)[0];
  if (name === undefined) return { name, writes: false, destructive: false };
  const destructive =
    DESTRUCTIVE_COMMANDS.has(name) ||
    bulk(name, command) ||
    (name === 'renameCollection' && command['dropTarget'] === true);
  const writes =
    destructive ||
    WRITE_COMMANDS.has(name) ||
    (name === 'aggregate' && pipelineWrites(command)) ||
    (name === 'mapReduce' && command['out'] !== undefined && !isInline(command['out']));
  return { name, writes, destructive };
}
