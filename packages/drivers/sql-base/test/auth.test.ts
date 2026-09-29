import { describe, expect, it } from 'vitest';

import { resolveCredentials, resolveEndpoint } from '../src';
import { resolved } from './fixtures';

function credentials(input: Parameters<typeof resolved>[0], secrets?: Record<string, string>) {
  const profile = resolved(input, secrets);
  return resolveCredentials(profile, resolveEndpoint(profile));
}

describe('resolveCredentials', () => {
  it('takes the password from the unsealed secrets', () => {
    expect(credentials({})).toEqual({ user: 'app', password: 's3cret', clientCertificate: false });
  });

  it('asks for the password when its secret was not unsealed', () => {
    expect(() => credentials({}, {})).toThrow(expect.objectContaining({ code: 'AUTH_FAILED' }));
  });

  it('falls back to the URI user and password', () => {
    expect(
      credentials({
        endpoint: { kind: 'uri', uri: 'postgres://reporter:fromuri@db/sales' },
        auth: { method: 'password' },
      }),
    ).toEqual({ user: 'reporter', password: 'fromuri', clientCertificate: false });
    expect(
      credentials({
        endpoint: { kind: 'uri', uri: 'postgres://reporter@db/sales' },
        auth: { method: 'none' },
      }),
    ).toEqual({
      user: 'reporter',
      clientCertificate: false,
    });
  });

  it('prefers the auth user over the URI user', () => {
    expect(
      credentials(
        {
          endpoint: { kind: 'uri', uri: 'postgres://reporter@db/sales' },
          auth: { method: 'password', user: 'admin' },
        },
        {},
      ).user,
    ).toBe('admin');
  });

  it('requires TLS with a certificate and key for client certificate auth', () => {
    expect(() =>
      credentials({ auth: { method: 'clientCertificate', user: 'cn' }, tls: { mode: 'require' } }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(
      credentials({
        auth: { method: 'clientCertificate', user: 'cn' },
        tls: { mode: 'verify-full', certPath: '/c.pem', keyPath: '/c.key' },
      }),
    ).toEqual({ user: 'cn', clientCertificate: true });
  });

  it('refuses auth methods the SQL drivers do not implement', () => {
    expect(() => credentials({ auth: { method: 'awsIam', region: 'eu-west-1' } })).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
    expect(() => credentials({ auth: { method: 'apiKey', apiKey: { id: 'k' } } })).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
  });
});
