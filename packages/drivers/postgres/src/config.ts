import { quoteString } from '@querybara/sql-tools';
import type { ResolvedProfile } from '@querybara/core';
import {
  buildTlsSettings,
  describeTarget,
  resolveCredentials,
  resolveEndpoint,
  type FileReader,
  type TlsSettings,
} from '@querybara/driver-sql-base';
import type { ClientConfig } from 'pg';

import { pgTypeParsers } from './types';

/** Everything needed to open a pg client for a profile. */
export interface PgConnectionPlan {
  readonly config: ClientConfig;
  /** Statements run right after login, in order: time zone, then the profile's init SQL. */
  readonly setup: readonly string[];
  readonly tls: TlsSettings;
  /** "host:port" or socket path, for messages. */
  readonly where: string;
}

/** Splits "/run/postgresql/.s.PGSQL.5433" into the directory pg wants plus the port. */
export function socketHostPort(path: string, fallbackPort: number): { host: string; port: number } {
  const match = /^(.*)\/\.s\.PGSQL\.(\d+)$/.exec(path);
  if (match) return { host: match[1] || '/', port: Number(match[2]) };
  return { host: path, port: fallbackPort };
}

/**
 * Builds the pg client configuration from a resolved profile: endpoint (host, socket, URI or
 * tunnel override), credentials, TLS mode, timeouts and session options.
 *
 * - The query timeout becomes the server-side `statement_timeout`.
 * - `charset` becomes `client_encoding`; the time zone is set with SET TIME ZONE after login.
 * - Values are parsed by per-client type parsers (see types.ts), never the global pg-types.
 * - `options.initSql` runs after login, in order.
 *
 * With `control: true` the config is for a short-lived control connection (cancel): no init
 * SQL and a distinct application name.
 */
export function buildPgConnectionPlan(
  resolved: ResolvedProfile,
  opts: { readFile?: FileReader; control?: boolean } = {},
): PgConnectionPlan {
  const endpoint = resolveEndpoint(resolved);
  const credentials = resolveCredentials(resolved, endpoint);
  const tls = buildTlsSettings(resolved, endpoint.target, opts.readFile);
  const options = resolved.profile.options;

  const config: ClientConfig = {
    types: pgTypeParsers,
    keepAlive: options.keepAlive,
    connectionTimeoutMillis: options.connectTimeoutMs,
    application_name: opts.control
      ? `${options.applicationName} (control)`
      : options.applicationName,
    ssl: tls.options ?? false,
  };
  if (endpoint.target.kind === 'socket') {
    const fallbackPort = Number(endpoint.params['port'] ?? 5432);
    Object.assign(config, socketHostPort(endpoint.target.path, fallbackPort));
  } else {
    config.host = endpoint.target.host;
    config.port = endpoint.target.port;
  }
  if (credentials.user !== undefined) config.user = credentials.user;
  if (credentials.password !== undefined) config.password = credentials.password;
  const database = options.defaultDatabase ?? endpoint.database;
  if (database !== undefined) config.database = database;
  if (options.queryTimeoutMs !== undefined && !opts.control) {
    config.statement_timeout = options.queryTimeoutMs;
  }
  if (options.charset !== undefined) config.client_encoding = options.charset;

  const setup: string[] = [];
  if (!opts.control) {
    if (options.timeZone !== undefined) {
      setup.push(`SET TIME ZONE ${quoteString(options.timeZone, 'postgres')}`);
    }
    setup.push(...options.initSql);
  }
  return { config, setup, tls, where: describeTarget(endpoint.target) };
}
