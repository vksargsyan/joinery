import { JoineryError, type ResolvedProfile } from '@joinery/core';

import type { ResolvedEndpoint } from './endpoint';

/** Who to log in as. The password never appears in errors or logs. */
export interface Credentials {
  readonly user?: string;
  readonly password?: string;
  /** The TLS client certificate authenticates the user (the driver must send it). */
  readonly clientCertificate: boolean;
}

/**
 * Resolves the login from the profile auth and its unsealed secrets. A URI endpoint's user is
 * the fallback when the auth block names none. Secret references that were not unsealed fail
 * with AUTH_FAILED, so the host can prompt for the password and retry.
 */
export function resolveCredentials(
  resolved: ResolvedProfile,
  endpoint: ResolvedEndpoint,
): Credentials {
  const { auth, tls } = resolved.profile;
  switch (auth.method) {
    case 'none':
      return {
        ...(endpoint.user !== undefined ? { user: endpoint.user } : {}),
        clientCertificate: false,
      };
    case 'password': {
      const user = auth.user ?? endpoint.user;
      let password: string | undefined;
      if (auth.password) {
        password = resolved.secrets[auth.password.id];
        if (password === undefined) {
          throw new JoineryError({
            code: 'AUTH_FAILED',
            message: 'The password for this connection was not provided',
            hint: 'Enter the password, or save it in the profile',
          });
        }
      } else {
        password = endpoint.password;
      }
      return {
        ...(user !== undefined ? { user } : {}),
        ...(password !== undefined ? { password } : {}),
        clientCertificate: false,
      };
    }
    case 'clientCertificate': {
      if (tls.mode === 'disable' || !tls.certPath || !tls.keyPath) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: 'Client certificate authentication needs TLS with a certificate and key file',
          hint: 'Turn TLS on and set the client certificate and key paths',
        });
      }
      if (endpoint.target.kind === 'socket') {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: 'Client certificate authentication needs a TCP endpoint, not a Unix socket',
        });
      }
      const user = auth.user ?? endpoint.user;
      return { ...(user !== undefined ? { user } : {}), clientCertificate: true };
    }
    case 'awsIam':
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: 'AWS IAM authentication is not supported yet',
        hint: 'Use password authentication for now',
      });
    case 'apiKey':
    case 'bearer':
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `"${auth.method}" authentication does not apply to SQL servers`,
        hint: 'Use password or client certificate authentication',
      });
  }
}
