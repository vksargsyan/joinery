import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls';

import { QuerybaraError, type ResolvedProfile, type TlsMode } from '@querybara/core';

import type { NetworkTarget } from './endpoint';

/** Reads a certificate or key file. Injected in tests. */
export type FileReader = (path: string) => Buffer;

/** How a connection uses TLS, derived from the profile's TLS mode (spec §4). */
export interface TlsSettings {
  readonly mode: TlsMode;
  /** Options for `tls.connect`; undefined when TLS is off. */
  readonly options?: ConnectionOptions;
  /** The certificate chain must lead to a trusted CA (verify-ca, verify-full). */
  readonly verifyChain: boolean;
  /** The certificate must name the server (verify-full). */
  readonly verifyHostname: boolean;
  /** The name the certificate is checked against (verify-full) and sent as SNI. */
  readonly expectedHostname?: string;
}

const DISABLED: TlsSettings = { mode: 'disable', verifyChain: false, verifyHostname: false };

function readTlsFile(readFile: FileReader, path: string, what: string): Buffer {
  try {
    return readFile(path);
  } catch (error) {
    const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    throw new QuerybaraError(
      {
        code: 'TLS_FAILED',
        message: `Cannot read the ${what} file "${path}" (${reason})`,
        hint: 'Check the file path in the profile TLS settings and that Querybara can read it',
      },
      { cause: error },
    );
  }
}

/**
 * Maps the profile's TLS mode onto Node TLS options:
 *
 * - `disable`: no TLS (also for Unix sockets, where TLS does not apply);
 * - `require`: encrypt, but accept any certificate;
 * - `verify-ca`: the chain must lead to a trusted CA (the profile CA file, else the system
 *   store), but the host name is not checked;
 * - `verify-full`: chain and host name are both checked. The host name is the TLS server name
 *   override, else the profile host — also when an SSH tunnel makes the socket connect to
 *   127.0.0.1.
 *
 * Client certificate, key and passphrase are added in every enabled mode.
 */
export function buildTlsSettings(
  resolved: ResolvedProfile,
  target: NetworkTarget,
  readFile: FileReader = readFileSync,
): TlsSettings {
  const tls = resolved.profile.tls;
  if (target.kind === 'socket' || tls.mode === 'disable') return DISABLED;

  const options: ConnectionOptions = {};
  if (tls.caPath) options.ca = readTlsFile(readFile, tls.caPath, 'CA certificate');
  if (tls.certPath) options.cert = readTlsFile(readFile, tls.certPath, 'client certificate');
  if (tls.keyPath) options.key = readTlsFile(readFile, tls.keyPath, 'client key');
  if (tls.keyPassphrase) {
    const passphrase = resolved.secrets[tls.keyPassphrase.id];
    if (passphrase === undefined) {
      throw new QuerybaraError({
        code: 'TLS_FAILED',
        message: 'The passphrase for the TLS client key was not provided',
        hint: 'Enter the key passphrase, or save it in the profile',
      });
    }
    options.passphrase = passphrase;
  }

  const expectedHostname = tls.servername ?? target.tlsHost;
  // RFC 6066 forbids IP addresses as SNI; Node rejects them.
  if (isIP(expectedHostname) === 0) options.servername = expectedHostname;

  switch (tls.mode) {
    case 'require':
      options.rejectUnauthorized = false;
      options.checkServerIdentity = () => undefined;
      return { mode: 'require', options, verifyChain: false, verifyHostname: false };
    case 'verify-ca':
      options.rejectUnauthorized = true;
      options.checkServerIdentity = () => undefined;
      return { mode: 'verify-ca', options, verifyChain: true, verifyHostname: false };
    case 'verify-full':
      options.rejectUnauthorized = true;
      // Pinned to the expected name: some drivers overwrite `servername` with the socket host.
      options.checkServerIdentity = (_host: string, cert: PeerCertificate) =>
        checkServerIdentity(expectedHostname, cert);
      return {
        mode: 'verify-full',
        options,
        verifyChain: true,
        verifyHostname: true,
        expectedHostname,
      };
  }
}
