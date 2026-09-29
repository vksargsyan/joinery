import { JoineryError } from '@joinery/core';
import { describe, expect, it } from 'vitest';

import { isFatal, mapMysqlError } from '../src/errors';

/** The shape of a mysql2 server error. */
function serverError(errno: number, code: string, sqlState: string, sqlMessage: string): Error {
  return Object.assign(new Error(sqlMessage), { errno, code, sqlState, sqlMessage, fatal: false });
}

const where = 'db.example.com:3306';

describe('mapMysqlError', () => {
  it('maps syntax errors with SQLSTATE, errno and position', () => {
    const statement = 'SELECT *\nFORM t';
    const mapped = mapMysqlError(
      serverError(
        1064,
        'ER_PARSE_ERROR',
        '42000',
        "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM t' at line 2",
      ),
      { where, statement },
    );
    expect(mapped.toJSON()).toMatchObject({
      code: 'SQL_ERROR',
      sqlState: '42000',
      engineCode: 1064,
      position: 9,
    });
  });

  it.each([
    [1045, 'ER_ACCESS_DENIED_ERROR', '28000', 'AUTH_FAILED', true],
    [1698, 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR', '28000', 'AUTH_FAILED', true],
    [1130, 'ER_HOST_NOT_PRIVILEGED', 'HY000', 'AUTH_FAILED', true],
    [1044, 'ER_DBACCESS_DENIED_ERROR', '42000', 'AUTH_FAILED', true],
    [1044, 'ER_DBACCESS_DENIED_ERROR', '42000', 'SQL_ERROR', false],
    [1049, 'ER_BAD_DB_ERROR', '42000', 'NOT_FOUND', true],
    [1317, 'ER_QUERY_INTERRUPTED', '70100', 'CANCELLED', false],
    [3024, 'ER_QUERY_TIMEOUT', 'HY000', 'TIMEOUT', false],
    [1969, 'ER_STATEMENT_TIMEOUT', '70100', 'TIMEOUT', false],
    [1040, 'ER_CON_COUNT_ERROR', '08004', 'CONNECTION_FAILED', true],
    [1146, 'ER_NO_SUCH_TABLE', '42S02', 'SQL_ERROR', false],
  ])(
    'maps %i %s to the right code (connecting: %s)',
    (errno, code, sqlState, expected, connecting) => {
      expect(
        mapMysqlError(serverError(errno, code, sqlState, 'message'), { where, connecting }).code,
      ).toBe(expected);
    },
  );

  it('maps mysql2 protocol, TLS and network errors', () => {
    const client = (code: string, message = code, fatal = true) =>
      Object.assign(new Error(message), { code, fatal });
    expect(
      mapMysqlError(client('HANDSHAKE_NO_SSL_SUPPORT'), { where, connecting: true }).code,
    ).toBe('TLS_FAILED');
    expect(
      mapMysqlError(client('HANDSHAKE_SSL_ERROR', 'self-signed certificate in certificate chain'), {
        where,
        connecting: true,
      }),
    ).toMatchObject({ code: 'TLS_FAILED', hint: expect.stringContaining('CA certificate') });
    expect(mapMysqlError(client('PROTOCOL_CONNECTION_LOST'), { where }).code).toBe(
      'CONNECTION_FAILED',
    );
    expect(
      mapMysqlError(client('ETIMEDOUT', 'connect ETIMEDOUT'), { where, connecting: true }).code,
    ).toBe('TIMEOUT');
    expect(mapMysqlError(client('ECONNREFUSED'), { where, connecting: true })).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: expect.stringContaining(where),
    });
    expect(mapMysqlError(new Error('odd'), { where }).code).toBe('INTERNAL');
  });

  it('passes JoineryErrors through and reports fatality', () => {
    const original = new JoineryError({ code: 'NOT_SUPPORTED', message: 'no' });
    expect(mapMysqlError(original, { where })).toBe(original);
    expect(isFatal(Object.assign(new Error('x'), { fatal: true }))).toBe(true);
    expect(isFatal(new Error('x'))).toBe(false);
  });
});
