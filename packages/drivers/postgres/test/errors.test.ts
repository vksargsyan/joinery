import { QuerybaraError } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { mapPgError } from '../src/errors';

/** The shape of pg's DatabaseError. */
function dbError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { severity: 'ERROR', code, ...extra });
}

const where = 'db.example.com:5432';

describe('mapPgError', () => {
  it('maps SQL errors with SQLSTATE, detail, hint and a 0-based position', () => {
    const statement = 'SELECT * FORM t';
    const mapped = mapPgError(
      dbError('42601', 'syntax error at or near "FORM"', {
        position: '10',
        detail: 'd',
        hint: 'h',
      }),
      { where, statement },
    );
    expect(mapped).toBeInstanceOf(QuerybaraError);
    expect(mapped.toJSON()).toEqual({
      code: 'SQL_ERROR',
      message: 'syntax error at or near "FORM"',
      detail: 'd',
      hint: 'h',
      sqlState: '42601',
      engineCode: '42601',
      position: 9,
    });
  });

  it('counts positions in characters, not UTF-16 units', () => {
    const statement = "SELECT '😀😀', nope";
    const mapped = mapPgError(
      dbError('42703', 'column "nope" does not exist', { position: '14' }),
      {
        where,
        statement,
      },
    );
    expect(statement.slice(mapped.position)).toBe('nope');
  });

  it('maps authentication and pg_hba failures to AUTH_FAILED', () => {
    expect(
      mapPgError(dbError('28P01', 'password authentication failed for user "app"'), {
        where,
        connecting: true,
      }),
    ).toMatchObject({ code: 'AUTH_FAILED', hint: 'Check the user name and password' });
    expect(
      mapPgError(dbError('28000', 'no pg_hba.conf entry for host "10.0.0.1"'), {
        where,
        connecting: true,
      }).hint,
    ).toMatch(/pg_hba.conf/);
  });

  it('maps a missing database at connect time to NOT_FOUND', () => {
    expect(
      mapPgError(dbError('3D000', 'database "x" does not exist'), { where, connecting: true }).code,
    ).toBe('NOT_FOUND');
    expect(mapPgError(dbError('3D000', 'database "x" does not exist'), { where }).code).toBe(
      'SQL_ERROR',
    );
  });

  it('tells cancellation from statement timeouts', () => {
    const canceled = dbError('57014', 'canceling statement due to user request');
    expect(mapPgError(canceled, { where, cancelRequested: true })).toMatchObject({
      code: 'CANCELLED',
      message: 'Query cancelled',
    });
    expect(
      mapPgError(dbError('57014', 'canceling statement due to statement timeout'), { where }).code,
    ).toBe('TIMEOUT');
  });

  it('maps server shutdowns to CONNECTION_FAILED', () => {
    expect(
      mapPgError(dbError('57P01', 'terminating connection due to administrator command'), { where })
        .code,
    ).toBe('CONNECTION_FAILED');
  });

  it('maps network, TLS and client errors', () => {
    expect(
      mapPgError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), {
        where,
        connecting: true,
      }),
    ).toMatchObject({ code: 'CONNECTION_FAILED', message: expect.stringContaining(where) });
    expect(
      mapPgError(new Error('The server does not support SSL connections'), {
        where,
        connecting: true,
      }).code,
    ).toBe('TLS_FAILED');
    expect(
      mapPgError(new Error('Connection terminated due to connection timeout'), {
        where,
        connecting: true,
      }).code,
    ).toBe('TIMEOUT');
    expect(
      mapPgError(new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string'), {
        where,
        connecting: true,
      }).code,
    ).toBe('AUTH_FAILED');
    expect(mapPgError(new Error('Connection terminated unexpectedly'), { where }).code).toBe(
      'CONNECTION_FAILED',
    );
    expect(mapPgError(new Error('something odd'), { where }).code).toBe('INTERNAL');
  });

  it('passes QuerybaraErrors through', () => {
    const original = new QuerybaraError({ code: 'NOT_SUPPORTED', message: 'no' });
    expect(mapPgError(original, { where })).toBe(original);
  });
});
