import { connect as netConnect, isIP, type Socket } from 'node:net';

import { JoineryError, type ResolvedProfile } from '@joinery/core';
import {
  buildTlsSettings,
  describeTarget,
  resolveCredentials,
  resolveEndpoint,
  type FileReader,
  type TlsSettings,
} from '@joinery/driver-sql-base';
import { quoteString } from '@joinery/sql-tools';
import type { ConnectionOptions, SslOptions } from 'mysql2';

import { mysqlTypeCast } from './types';

/** Everything needed to open a mysql2 connection for a profile. */
export interface MysqlConnectionPlan {
  readonly options: ConnectionOptions;
  /** Statements run right after login, in order: time zone, then the profile's init SQL. */
  readonly setup: readonly string[];
  readonly queryTimeoutMs?: number;
  readonly tls: TlsSettings;
  /** "host:port" or socket path, for messages. */
  readonly where: string;
}

/**
 * The mysql2 `ssl` options for a TLS mode: `require` encrypts without verification,
 * `verify-ca` checks the chain only, `verify-full` also checks the host name.
 */
export function mysqlSslOptions(tls: TlsSettings): SslOptions | undefined {
  if (!tls.options) return undefined;
  const ssl: SslOptions = {
    rejectUnauthorized: tls.verifyChain,
    verifyIdentity: tls.verifyHostname,
  };
  const { ca, cert, key, passphrase } = tls.options;
  if (ca !== undefined) ssl.ca = ca as SslOptions['ca'];
  if (cert !== undefined) ssl.cert = cert as SslOptions['cert'];
  if (key !== undefined) ssl.key = key as SslOptions['key'];
  if (passphrase !== undefined) ssl.passphrase = passphrase;
  return ssl;
}

/**
 * Builds mysql2 connection options from a resolved profile: endpoint (host, socket, URI or
 * tunnel override), credentials, TLS mode, timeouts and session options.
 *
 * Values come back as CellValues through `mysqlTypeCast` (dates, decimals and JSON as text,
 * BIGINT as number or bigint, binary as Uint8Array), rows as arrays, one statement per call,
 * and LOAD DATA LOCAL is refused.
 *
 * mysql2 checks the certificate against `host`. When the name to verify differs from the
 * address to dial (a TLS server name override, or an SSH tunnel on 127.0.0.1), `host` is set
 * to the name and the socket is opened by a stream factory instead.
 *
 * With `control: true` the options are for a short-lived control connection (KILL QUERY): no
 * database, no init SQL.
 */
export function buildMysqlConnectionPlan(
  resolved: ResolvedProfile,
  opts: { readFile?: FileReader; control?: boolean } = {},
): MysqlConnectionPlan {
  const endpoint = resolveEndpoint(resolved);
  const credentials = resolveCredentials(resolved, endpoint);
  const tls = buildTlsSettings(resolved, endpoint.target, opts.readFile);
  const profileOptions = resolved.profile.options;
  const control = opts.control === true;

  const options: ConnectionOptions = {
    connectTimeout: profileOptions.connectTimeoutMs,
    enableKeepAlive: profileOptions.keepAlive,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    jsonStrings: true,
    rowsAsArray: true,
    multipleStatements: false,
    typeCast: mysqlTypeCast,
    flags: ['-LOCAL_FILES'],
    connectAttributes: {
      program_name: control
        ? `${profileOptions.applicationName} (control)`
        : profileOptions.applicationName,
    },
  };
  if (profileOptions.charset !== undefined) options.charset = profileOptions.charset;
  if (credentials.user !== undefined) options.user = credentials.user;
  if (credentials.password !== undefined) options.password = credentials.password;
  const database = profileOptions.defaultDatabase ?? endpoint.database;
  if (database !== undefined && !control) options.database = database;
  const ssl = mysqlSslOptions(tls);
  if (ssl) options.ssl = ssl;

  const target = endpoint.target;
  if (target.kind === 'socket') {
    options.socketPath = target.path;
  } else if (tls.verifyHostname && tls.expectedHostname !== undefined) {
    // mysql2 checks the certificate against `host` (and, for an IP address, falls back to the
    // socket's host name, which Node leaves empty for IP connects). Name `host` after the
    // expected certificate name and dial the real address from a stream factory.
    const expected = tls.expectedHostname;
    options.host = expected;
    options.port = target.port;
    options.stream = (): Socket => {
      const socket = netConnect({ host: target.host, port: target.port });
      socket.setNoDelay(true);
      if (profileOptions.keepAlive) socket.setKeepAlive(true);
      if (isIP(expected) !== 0) Object.assign(socket, { _host: expected });
      return socket;
    };
  } else {
    options.host = target.host;
    options.port = target.port;
  }

  const setup: string[] = [];
  if (!control) {
    if (profileOptions.timeZone !== undefined) {
      setup.push(`SET time_zone = ${quoteString(profileOptions.timeZone, 'mysql')}`);
    }
    setup.push(...profileOptions.initSql);
  }
  return {
    options,
    setup,
    ...(profileOptions.queryTimeoutMs !== undefined && !control
      ? { queryTimeoutMs: profileOptions.queryTimeoutMs }
      : {}),
    tls,
    where: describeTarget(target),
  };
}

/** The statement that applies the query timeout on this server flavour. */
export function queryTimeoutStatement(mariadb: boolean, timeoutMs: number): string {
  // MySQL limits SELECT statements in milliseconds; MariaDB limits every statement, in seconds.
  return mariadb
    ? `SET SESSION max_statement_time = ${(timeoutMs / 1000).toFixed(3)}`
    : `SET SESSION max_execution_time = ${Math.round(timeoutMs)}`;
}

/** mysql2 rejects unknown charsets while building the connection; say which option is wrong. */
export function invalidCharset(charset: string, cause: unknown): JoineryError {
  return new JoineryError(
    {
      code: 'VALIDATION_FAILED',
      message: `Unknown character set "${charset}"`,
      hint: 'Use a MySQL character set or collation name such as utf8mb4 or latin1',
    },
    { cause },
  );
}
