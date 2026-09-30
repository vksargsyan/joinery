import type { PeerCertificate } from 'node:tls';

import { describe, expect, it } from 'vitest';

import { buildTlsSettings, resolveEndpoint, type FileReader } from '../src';
import { resolved } from './fixtures';

const files: Record<string, string> = {
  '/ca.pem': 'CA',
  '/client.pem': 'CERT',
  '/client.key': 'KEY',
};
const readFile: FileReader = (path) => {
  const content = files[path];
  if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return Buffer.from(content);
};

function settings(
  tls: Record<string, unknown>,
  override?: { host: string; port: number },
  secrets?: Record<string, string>,
) {
  const profile = resolved({ tls: tls as never }, secrets ?? { pw: 'x' }, override);
  return buildTlsSettings(profile, resolveEndpoint(profile).target, readFile);
}

/** A certificate that names only `name`, enough for tls.checkServerIdentity. */
function certFor(name: string): PeerCertificate {
  return { subject: { CN: name }, subjectaltname: `DNS:${name}` } as unknown as PeerCertificate;
}

describe('buildTlsSettings', () => {
  it('turns TLS off for disable and for Unix sockets', () => {
    expect(settings({ mode: 'disable' })).toEqual({
      mode: 'disable',
      verifyChain: false,
      verifyHostname: false,
    });
    const socket = resolved({
      endpoint: { kind: 'socket', path: '/run/pg' },
      tls: { mode: 'verify-full' },
    });
    expect(
      buildTlsSettings(socket, resolveEndpoint(socket).target, readFile).options,
    ).toBeUndefined();
  });

  it('require encrypts without verifying anything', () => {
    const tls = settings({ mode: 'require' });
    expect(tls).toMatchObject({ mode: 'require', verifyChain: false, verifyHostname: false });
    expect(tls.options?.rejectUnauthorized).toBe(false);
    expect(
      tls.options?.checkServerIdentity?.('db.example.com', certFor('evil.example.com')),
    ).toBeUndefined();
  });

  it('verify-ca checks the chain against the CA file but not the host name', () => {
    const tls = settings({ mode: 'verify-ca', caPath: '/ca.pem' });
    expect(tls).toMatchObject({ verifyChain: true, verifyHostname: false });
    expect(tls.options?.rejectUnauthorized).toBe(true);
    expect(tls.options?.ca?.toString()).toBe('CA');
    expect(
      tls.options?.checkServerIdentity?.('db.example.com', certFor('other.example.com')),
    ).toBeUndefined();
  });

  it('is off for a profile that states no mode', () => {
    expect(settings({})).toMatchObject({ mode: 'disable' });
  });

  it('verify-full checks chain and host name', () => {
    const tls = settings({ mode: 'verify-full' });
    expect(tls).toMatchObject({ mode: 'verify-full', verifyChain: true, verifyHostname: true });
    expect(tls.expectedHostname).toBe('db.example.com');
    expect(tls.options?.servername).toBe('db.example.com');
    expect(
      tls.options?.checkServerIdentity?.('ignored', certFor('db.example.com')),
    ).toBeUndefined();
    expect(
      tls.options?.checkServerIdentity?.('db.example.com', certFor('evil.example.com')),
    ).toBeInstanceOf(Error);
  });

  it('checks the server name override, and the profile host through a tunnel', () => {
    const overridden = settings({ mode: 'verify-full', servername: 'cert.example.com' });
    expect(overridden.expectedHostname).toBe('cert.example.com');
    expect(
      overridden.options?.checkServerIdentity?.('db.example.com', certFor('cert.example.com')),
    ).toBeUndefined();

    const tunnelled = settings({ mode: 'verify-full' }, { host: '127.0.0.1', port: 40000 });
    expect(tunnelled.expectedHostname).toBe('db.example.com');
    expect(tunnelled.options?.servername).toBe('db.example.com');
    expect(
      tunnelled.options?.checkServerIdentity?.('127.0.0.1', certFor('db.example.com')),
    ).toBeUndefined();
  });

  it('never sends an IP address as SNI', () => {
    const profile = resolved({
      endpoint: { kind: 'host', host: '10.0.0.5', port: 5432 },
      tls: { mode: 'verify-full' },
    });
    const tls = buildTlsSettings(profile, resolveEndpoint(profile).target, readFile);
    expect(tls.options?.servername).toBeUndefined();
    expect(tls.expectedHostname).toBe('10.0.0.5');
  });

  it('adds the client certificate, key and passphrase', () => {
    const tls = settings(
      {
        mode: 'require',
        certPath: '/client.pem',
        keyPath: '/client.key',
        keyPassphrase: { id: 'kp' },
      },
      undefined,
      { kp: 'open sesame' },
    );
    expect(tls.options?.cert?.toString()).toBe('CERT');
    expect(tls.options?.key?.toString()).toBe('KEY');
    expect(tls.options?.passphrase).toBe('open sesame');
  });

  it('fails with TLS_FAILED for unreadable files and a missing passphrase', () => {
    expect(() => settings({ mode: 'verify-ca', caPath: '/missing.pem' })).toThrow(
      expect.objectContaining({
        code: 'TLS_FAILED',
        message: expect.stringContaining('/missing.pem'),
      }),
    );
    expect(() =>
      settings(
        { mode: 'require', keyPath: '/client.key', keyPassphrase: { id: 'kp' } },
        undefined,
        {},
      ),
    ).toThrow(expect.objectContaining({ code: 'TLS_FAILED' }));
  });
});
