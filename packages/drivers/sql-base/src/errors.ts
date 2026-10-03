import { QuerybaraError } from '@querybara/core';

/** Reads a string or number property from an unknown thrown value. */
export function errorProp(error: unknown, key: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
  const value: unknown = (error as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN']);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'EPROTO',
]);

/**
 * A fix hint for a TLS failure, from the OpenSSL / Node error code or, when a driver wrapped
 * the error, from its message.
 */
export function tlsHint(codeOrMessage: string): string {
  if (
    /SELF_SIGNED|UNABLE_TO_(VERIFY|GET)_ISSUER|UNABLE_TO_VERIFY_LEAF|CERT_UNTRUSTED|self[- ]signed|unable to (get|verify)/i.test(
      codeOrMessage,
    )
  ) {
    return "Set the server's CA certificate in the TLS settings, or use TLS mode 'require' to encrypt without verifying";
  }
  if (/ALTNAME|HOSTNAME_MISMATCH|altnames|does not match certificate/i.test(codeOrMessage)) {
    return "The certificate does not name this host: set the TLS server name, or use TLS mode 'verify-ca'";
  }
  if (/EXPIRED|NOT_YET_VALID|expired|not yet valid/i.test(codeOrMessage)) {
    return "The server certificate is outside its validity period; renew it or check this computer's clock";
  }
  return 'Check that the server has TLS enabled and that the TLS mode and certificates in the profile match it';
}

/**
 * Maps Node network and TLS errors (DNS, refused, unreachable, reset, timeout, certificate) to
 * QuerybaraErrors with a fix hint. Returns undefined for anything else, so drivers can fall back
 * to their own mapping. `where` names the endpoint ("db.example.com:5432"); never pass secrets.
 */
export function mapNetworkError(error: unknown, where: string): QuerybaraError | undefined {
  const code = errorProp(error, 'code');
  if (code === undefined) {
    const message = errorMessage(error);
    if (/certificate|ssl|tls/i.test(message) && !/password/i.test(message)) {
      return new QuerybaraError(
        {
          code: 'TLS_FAILED',
          message: `TLS negotiation with ${where} failed: ${message}`,
          hint: tlsHint(message),
        },
        { cause: error },
      );
    }
    return undefined;
  }
  const cause = { cause: error };
  if (DNS_CODES.has(code)) {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `Could not resolve the host name of ${where}`,
        hint: 'Check the host name for typos and that this computer can reach your DNS (VPN, network)',
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'ECONNREFUSED') {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `Connection to ${where} was refused`,
        hint: 'Check that the server is running and listening on this host and port, and that no firewall blocks it',
        engineCode: code,
      },
      cause,
    );
  }
  if (UNREACHABLE_CODES.has(code)) {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `${where} is unreachable from this computer`,
        hint: 'Check your network or VPN connection, or connect through an SSH tunnel',
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTSOCK') {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `Cannot open the socket ${where} (${code})`,
        hint: 'Check the socket path and that the server is running on this computer',
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new QuerybaraError(
      {
        code: 'TIMEOUT',
        message: `Timed out connecting to ${where}`,
        hint: 'Check the host, port and firewall rules, or raise the connect timeout',
        engineCode: code,
      },
      cause,
    );
  }
  if (RESET_CODES.has(code)) {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: `The connection to ${where} was closed unexpectedly`,
        hint: 'The server or something in between closed the connection; check the TLS mode and the server log',
        engineCode: code,
      },
      cause,
    );
  }
  if (TLS_CODES.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
    return new QuerybaraError(
      {
        code: 'TLS_FAILED',
        message: `TLS negotiation with ${where} failed: ${errorMessage(error)}`,
        hint: tlsHint(`${code} ${errorMessage(error)}`),
        engineCode: code,
      },
      cause,
    );
  }
  return undefined;
}

/**
 * Converts a character offset counted in Unicode code points (as PostgreSQL reports positions)
 * into a UTF-16 index into `text`, clamped to the text length.
 */
export function codePointOffsetToIndex(text: string, codePoints: number): number {
  let index = 0;
  for (let n = 0; n < codePoints && index < text.length; n++) {
    const code = text.codePointAt(index)!;
    index += code > 0xffff ? 2 : 1;
  }
  return Math.min(index, text.length);
}

/** The 0-based offset where 1-based `line` starts; the text length when it has fewer lines. */
export function lineStartOffset(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}
