import { describe, expect, it } from 'vitest';

import { codePointOffsetToIndex, lineStartOffset, mapNetworkError, tlsHint } from '../src';

const systemError = (code: string, message = code): Error =>
  Object.assign(new Error(message), { code });

describe('mapNetworkError', () => {
  it.each([
    ['ENOTFOUND', 'CONNECTION_FAILED', /resolve/],
    ['EAI_AGAIN', 'CONNECTION_FAILED', /resolve/],
    ['ECONNREFUSED', 'CONNECTION_FAILED', /refused/],
    ['EHOSTUNREACH', 'CONNECTION_FAILED', /unreachable/],
    ['ENOENT', 'CONNECTION_FAILED', /socket/],
    ['ETIMEDOUT', 'TIMEOUT', /Timed out/],
    ['ECONNRESET', 'CONNECTION_FAILED', /closed unexpectedly/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_FAILED', /TLS/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_FAILED', /TLS/],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'TLS_FAILED', /TLS/],
  ])('maps %s to %s with a hint', (code, expected, message) => {
    const mapped = mapNetworkError(systemError(code), 'db.example.com:5432');
    expect(mapped).toMatchObject({
      code: expected,
      message: expect.stringMatching(message),
      engineCode: code,
    });
    expect(mapped?.hint).toEqual(expect.any(String));
  });

  it('names the endpoint and leaves other errors alone', () => {
    expect(mapNetworkError(systemError('ECONNREFUSED'), 'db:5432')?.message).toContain('db:5432');
    expect(mapNetworkError(new Error('syntax error'), 'db:5432')).toBeUndefined();
    expect(mapNetworkError(systemError('ER_PARSE_ERROR'), 'db:5432')).toBeUndefined();
  });

  it('recognises TLS failures reported without a code', () => {
    expect(
      mapNetworkError(new Error('The server does not support SSL connections'), 'db:5432')?.code,
    ).toBe('TLS_FAILED');
  });
});

describe('tlsHint', () => {
  it('suggests the fix for the failure', () => {
    expect(tlsHint('SELF_SIGNED_CERT_IN_CHAIN')).toMatch(/CA certificate/);
    expect(tlsHint('self-signed certificate in certificate chain')).toMatch(/CA certificate/);
    expect(tlsHint("Hostname/IP does not match certificate's altnames")).toMatch(/server name/);
    expect(tlsHint('CERT_HAS_EXPIRED')).toMatch(/validity/);
    expect(tlsHint('')).toMatch(/TLS mode/);
  });
});

describe('positions', () => {
  it('converts code point offsets to UTF-16 indexes', () => {
    const text = "SELECT '😀', nope";
    // PostgreSQL counts the emoji as one character: "nope" starts at character 13.
    expect(text.slice(codePointOffsetToIndex(text, 12))).toBe('nope');
    expect(codePointOffsetToIndex('abc', 10)).toBe(3);
    expect(codePointOffsetToIndex('abc', 0)).toBe(0);
  });

  it('finds the start of a 1-based line', () => {
    expect(lineStartOffset('a\nbc\nd', 1)).toBe(0);
    expect(lineStartOffset('a\nbc\nd', 3)).toBe(5);
    expect(lineStartOffset('a', 4)).toBe(1);
  });
});
