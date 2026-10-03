import { QuerybaraError, type ErrorCode, type ErrorData } from '@querybara/core';
import { errorMessage, errorProp, mapNetworkError, tlsHint } from '@querybara/driver-sql-base';

import { redactSecrets } from './config';

/** What was happening when a driver error occurred, for picking the code and hint. */
export interface MongoErrorContext {
  /** The seed hosts ("host:port, host:port"), for connection messages. Never credentials. */
  readonly where: string;
  /** Secret values to redact from every message. */
  readonly secrets: readonly string[];
  /** This session cancelled the operation (killSessions), so interruptions mean CANCELLED. */
  readonly cancelRequested?: boolean;
  /** The replica set name the profile asked for. */
  readonly replicaSet?: string;
  /** The server-selection timeout, for messages. */
  readonly timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function short(value: unknown, max = 80): string {
  let text: string;
  try {
    text =
      typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The body of a `specifiedAs` rule, e.g. {"minimum": 0} → "0", {"bsonType": "int"} → "int". */
function specified(rule: Record<string, unknown>): string {
  const spec = record(rule['specifiedAs']);
  if (!spec) return '';
  const values = Object.values(spec);
  return values.length === 1
    ? typeof values[0] === 'string'
      ? values[0]
      : short(values[0])
    : short(spec);
}

/**
 * Turns the server's DocumentValidationFailure details (errInfo) into one line per failed rule
 * naming the field and the rule: "age: bsonType int expected, got string ("old")",
 * "missing required field: name", "unexpected field: extra". Handles $jsonSchema rules and
 * query-operator validators.
 */
export function describeValidationFailure(errInfo: unknown): string[] {
  const lines: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (lines.length >= 20) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path);
      return;
    }
    const rule = record(node);
    if (!rule) return;
    const operator = typeof rule['operatorName'] === 'string' ? rule['operatorName'] : undefined;
    const at = path === '' ? '' : `${path}: `;
    if (Array.isArray(rule['propertiesNotSatisfied'])) {
      for (const property of rule['propertiesNotSatisfied']) {
        const p = record(property);
        const name = typeof p?.['propertyName'] === 'string' ? p['propertyName'] : '?';
        visit(p?.['details'], path === '' ? name : `${path}.${name}`);
      }
      return;
    }
    if (Array.isArray(rule['missingProperties'])) {
      const missing = rule['missingProperties'].map(String);
      lines.push(
        `${at}missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      );
      return;
    }
    if (operator === 'additionalProperties' && Array.isArray(rule['additionalProperties'])) {
      const extra = rule['additionalProperties'].map(String);
      lines.push(`${at}unexpected field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`);
      return;
    }
    if (operator === 'items' && typeof rule['itemIndex'] === 'number') {
      visit(rule['details'], `${path}[${rule['itemIndex']}]`);
      return;
    }
    for (const nested of ['schemaRulesNotSatisfied', 'clausesNotSatisfied']) {
      if (Array.isArray(rule[nested])) {
        visit(rule[nested], path);
        return;
      }
    }
    if (rule['details'] !== undefined && operator !== undefined && rule['reason'] === undefined) {
      visit(rule['details'], path);
      return;
    }
    if (operator === undefined) {
      if (rule['details'] !== undefined) visit(rule['details'], path);
      return;
    }
    const reason = typeof rule['reason'] === 'string' ? rule['reason'] : 'rule not satisfied';
    const spec = record(rule['specifiedAs']);
    const field = spec ? Object.keys(spec) : [];
    let line: string;
    if (operator.startsWith('$') && field.length === 1 && !field[0]!.startsWith('$')) {
      // A query-operator validator: { field: { $op: value } }.
      line = `${path === '' ? '' : `${path}.`}${field[0]}: ${short(spec![field[0]!])}`;
    } else {
      line = `${at}${operator} ${specified(rule)}`.trim();
    }
    if (operator === 'bsonType' || operator === 'type') {
      line += ` expected${rule['consideredType'] !== undefined ? `, got ${String(rule['consideredType'])}` : ''}`;
    } else {
      line += ` (${reason})`;
    }
    if ('consideredValue' in rule) line += ` value ${short(rule['consideredValue'], 60)}`;
    lines.push(line);
    if (rule['details'] !== undefined) visit(rule['details'], path);
  };
  visit(record(errInfo)?.['details'], '');
  return lines;
}

const AUTH_CODES = new Set([18, 334]);
const CANCEL_CODES = new Set([11601, 11600, 11602, 237, 175]);
const CONFLICT_CODES = new Set([112, 251, 225, 256, 244, 263]);
const NOT_SUPPORTED_CODES = new Set([59, 115, 40573, 20, 303]);

/** The server's error code; a raw-deserialised reply holds it as an Int32 wrapper. */
function serverCode(error: unknown): number | undefined {
  const code = record(error)?.['code'];
  if (typeof code === 'number') return code;
  const wrapped = record(code)?.['value'];
  return typeof wrapped === 'number' ? wrapped : undefined;
}

function hasLabel(error: unknown, label: string): boolean {
  const labels = record(error)?.['errorLabelSet'];
  if (labels instanceof Set) return labels.has(label);
  const list = record(error)?.['errorLabels'];
  return Array.isArray(list) && list.includes(label);
}

/** A write error inside a bulk write, when there is exactly one to report. */
function firstWriteError(error: unknown): Record<string, unknown> | undefined {
  const errors = record(error)?.['writeErrors'];
  if (Array.isArray(errors) && errors.length > 0) return record(errors[0]);
  const single = record(record(error)?.['writeErrors']);
  return single;
}

/** The topology behind a server selection failure, described without credentials. */
function describeSelection(
  error: unknown,
  context: MongoErrorContext,
  redact: (text: string) => string,
): QuerybaraError {
  const reason = record(record(error)?.['reason']);
  const type = typeof reason?.['type'] === 'string' ? reason['type'] : 'Unknown';
  const servers = reason?.['servers'] instanceof Map ? [...reason['servers'].values()] : [];
  const cause = { cause: error };
  for (const server of servers) {
    const description = record(server);
    const serverError = description?.['error'];
    if (serverError === undefined || serverError === null) continue;
    const address =
      typeof description?.['address'] === 'string' ? description['address'] : context.where;
    const inner = record(serverError)?.['cause'] ?? serverError;
    const network = mapNetworkError(inner, address) ?? mapNetworkError(serverError, address);
    if (network) {
      return new QuerybaraError({ ...network.toJSON(), message: redact(network.message) }, cause);
    }
    if (serverCode(serverError) !== undefined && AUTH_CODES.has(serverCode(serverError)!)) {
      return mapMongoError(serverError, context);
    }
  }
  const members = servers
    .map((server) => {
      const d = record(server);
      return `${String(d?.['address'] ?? '?')} ${String(d?.['type'] ?? 'Unknown')}`;
    })
    .join(', ');
  const within = context.timeoutMs !== undefined ? ` within ${context.timeoutMs} ms` : '';
  const topology = `topology ${type}${members ? `; servers: ${members}` : '; no servers'}`;
  if (type === 'ReplicaSetNoPrimary' && servers.length === 0 && context.replicaSet) {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `No member of replica set "${context.replicaSet}" answered at ${context.where} (${topology})`,
        hint: `The server may belong to a replica set with another name: check the replica set name, or turn on Direct connection to reach this one host`,
      },
      cause,
    );
  }
  if (type === 'ReplicaSetNoPrimary' && servers.length > 0) {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `The replica set has no reachable primary${within} (${topology})`,
        hint: 'The replica set advertises member addresses this computer may not reach: turn on Direct connection, use a read preference such as secondaryPreferred, or connect through the advertised host names',
      },
      cause,
    );
  }
  return new QuerybaraError(
    {
      code: 'TIMEOUT',
      message: `No server was selectable${within} at ${context.where} (${topology})`,
      hint: 'Check the host and port, the replica set name and TLS settings, or raise the connect timeout',
    },
    cause,
  );
}

/**
 * Maps anything the mongodb driver throws to a QuerybaraError with a fix hint, never leaking a
 * secret: server errors by code (auth, permissions, validation with the failed rules, duplicate
 * keys, timeouts, cancellation, conflicts, unsupported features), server selection failures by
 * the topology behind them, network and TLS failures, and the driver's own client errors.
 */
export function mapMongoError(error: unknown, context: MongoErrorContext): QuerybaraError {
  const redact = (text: string): string => redactSecrets(text, context.secrets);
  if (error instanceof QuerybaraError) {
    const data = error.toJSON();
    return new QuerybaraError(
      {
        ...data,
        message: redact(data.message),
        ...(data.detail !== undefined ? { detail: redact(data.detail) } : {}),
      },
      { cause: error },
    );
  }
  const cause = { cause: error };
  const name = errorProp(error, 'name') ?? '';
  const message = redact(errorMessage(error));
  const make = (code: ErrorCode, extra: Partial<ErrorData> = {}): QuerybaraError =>
    new QuerybaraError({ code, message, ...extra }, cause);

  if (context.cancelRequested || name === 'AbortError') {
    return new QuerybaraError({ code: 'CANCELLED', message: 'Query cancelled' }, cause);
  }

  const writeError = firstWriteError(error);
  const code = serverCode(writeError) ?? serverCode(error);
  const codeName = errorProp(writeError, 'codeName') ?? errorProp(error, 'codeName');
  const engineCode = codeName ?? code;
  if (code !== undefined && /Mongo(Server|BulkWrite|WriteConcern)Error/.test(name)) {
    const base = engineCode !== undefined ? { engineCode } : {};
    if (AUTH_CODES.has(code)) {
      return make('AUTH_FAILED', {
        ...base,
        message: `Authentication failed at ${context.where}`,
        hint: 'Check the user name and password, the authentication database (authSource, usually admin) and the mechanism',
      });
    }
    if (code === 13) {
      return make('SQL_ERROR', {
        ...base,
        hint: 'The user lacks a privilege this needs; ask an administrator to grant a role that has it',
      });
    }
    if (code === 121) {
      const errInfo = writeError?.['errInfo'] ?? record(error)?.['errInfo'];
      const lines = describeValidationFailure(errInfo);
      const index = writeError?.['index'];
      const which = typeof index === 'number' ? ` (document ${index + 1})` : '';
      return make('VALIDATION_FAILED', {
        ...base,
        message:
          lines.length > 0
            ? `Document failed validation${which}: ${lines[0]}`
            : `Document failed validation${which}`,
        ...(lines.length > 0 ? { detail: redact(lines.join('\n')) } : {}),
        hint: "Fix the document to satisfy the collection's validator, or relax the validation rules",
      });
    }
    if (code === 11000 || code === 11001) {
      const key = record(error)?.['keyValue'] ?? writeError?.['keyValue'];
      return make('SQL_ERROR', {
        ...base,
        ...(key !== undefined ? { detail: redact(`Duplicate key: ${short(key, 200)}`) } : {}),
        hint: 'A unique index already has a document with this key; change the value or update that document',
      });
    }
    if (code === 26) return make('NOT_FOUND', base);
    if (code === 50) {
      return make('TIMEOUT', {
        ...base,
        hint: 'The operation exceeded its time limit (maxTimeMS); narrow it or raise the limit',
      });
    }
    if (CANCEL_CODES.has(code)) {
      return make('CANCELLED', { ...base, message: `The operation was interrupted: ${message}` });
    }
    if (CONFLICT_CODES.has(code) || hasLabel(error, 'TransientTransactionError')) {
      return make('CONFLICT', {
        ...base,
        hint: 'Another operation changed the same documents; retry the transaction',
      });
    }
    if (NOT_SUPPORTED_CODES.has(code)) {
      return make('NOT_SUPPORTED', {
        ...base,
        ...(code === 40573
          ? { hint: 'Change streams need a replica set or a sharded cluster' }
          : {}),
      });
    }
    return make('SQL_ERROR', base);
  }

  switch (name) {
    case 'MongoServerSelectionError':
      return describeSelection(error, context, redact);
    case 'MongoNetworkError':
    case 'MongoNetworkTimeoutError': {
      const inner = record(error)?.['cause'];
      const network =
        mapNetworkError(inner ?? error, context.where) ?? mapNetworkError(error, context.where);
      if (network)
        return new QuerybaraError({ ...network.toJSON(), message: redact(network.message) }, cause);
      if (/certificate|ssl|tls/i.test(message)) {
        return make('TLS_FAILED', { hint: tlsHint(message) });
      }
      return make(name === 'MongoNetworkTimeoutError' ? 'TIMEOUT' : 'CONNECTION_FAILED', {
        hint: 'The connection to the server was lost; check the network and the server log',
      });
    }
    case 'MongoParseError':
    case 'MongoInvalidArgumentError':
    case 'MongoAPIError':
    case 'MongoCompatibilityError':
    case 'BSONError':
    case 'BSONVersionError':
      return make('VALIDATION_FAILED');
    case 'MongoMissingDependencyError':
      return make('NOT_SUPPORTED', {
        hint: `This needs the optional package ${errorProp(error, 'dependencyName') ?? 'named above'}, which Querybara does not ship`,
      });
    case 'MongoMissingCredentialsError':
    case 'MongoOIDCError':
      return make('AUTH_FAILED', {
        hint: 'Check the credentials this authentication method needs',
      });
    case 'MongoOperationTimeoutError':
      return make('TIMEOUT');
    case 'MongoTopologyClosedError':
    case 'MongoNotConnectedError':
    case 'MongoClientClosedError':
      return make('CONNECTION_FAILED', { message: 'The session is closed' });
    case 'MongoTransactionError':
    case 'MongoExpiredSessionError':
      return make('CONFLICT', { hint: 'The transaction is no longer active; start a new one' });
    case 'MongoGridFSStreamError':
    case 'MongoGridFSChunkError':
      return make(/FileNotFound|not found/i.test(message) ? 'NOT_FOUND' : 'INTERNAL');
    default:
      break;
  }
  const network = mapNetworkError(error, context.where);
  if (network)
    return new QuerybaraError({ ...network.toJSON(), message: redact(network.message) }, cause);
  return make('INTERNAL');
}
