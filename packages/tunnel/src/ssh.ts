import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Duplex } from 'node:stream';

import { QuerybaraError, type HostPort, type SshHop } from '@querybara/core';
import ssh2 from 'ssh2';
import type { AuthenticationType, Client, ClientChannel, ConnectConfig } from 'ssh2';

import {
  errorMessage,
  errorProp,
  hostLabel,
  mapSocketError,
  timeoutError,
  tunnelError,
} from './errors';
import type { HostKeyVerifier } from './host-keys';
import { fingerprintOf, keyTypeOf, ssh2KeyFrom } from './keys';

/** Reads a private key file. Injectable for tests. */
export type KeyFileReader = (path: string) => Promise<Buffer>;

/** Expands a leading `~` so profiles can say `~/.ssh/id_ed25519`. */
export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\')
    ? `${homedir()}${path.slice(1)}`
    : path;
}

export const defaultKeyFileReader: KeyFileReader = (path) => fsReadFile(expandHome(path));

/** The ssh-agent to use: the option, else SSH_AUTH_SOCK, else Pageant on Windows. */
export function agentSocket(option: string | undefined): string | undefined {
  if (option) return option;
  const fromEnv = process.env['SSH_AUTH_SOCK'];
  if (fromEnv) return fromEnv;
  return process.platform === 'win32' ? 'pageant' : undefined;
}

export interface HopConnectOptions {
  readonly hop: SshHop;
  readonly secrets: Readonly<Record<string, string>>;
  /** A proxy socket or the previous hop's forwarded channel; direct TCP when absent. */
  readonly sock?: Duplex;
  readonly verifier: HostKeyVerifier;
  readonly timeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly agent: string | undefined;
  readonly readFile: KeyFileReader;
}

/** "me@bastion.example.com:22" — user and host names are not secrets. */
export function hopLabel(hop: SshHop): string {
  return hostLabel(hop.host, hop.port, hop.user);
}

interface AuthConfig {
  readonly config: Partial<ConnectConfig>;
  readonly methods: AuthenticationType[];
  readonly password?: string;
}

async function authConfig(options: HopConnectOptions): Promise<AuthConfig> {
  const { hop, secrets } = options;
  const auth = hop.auth;
  switch (auth.method) {
    case 'password': {
      const password = secrets[auth.password.id];
      if (password === undefined) {
        throw tunnelError(
          'SSH_FAILED',
          `The SSH password for ${hopLabel(hop)} was not provided`,
          'Enter the SSH password, or save it in the profile',
          undefined,
          'PASSWORD_REQUIRED',
        );
      }
      return {
        config: { password, tryKeyboard: true },
        methods: ['password', 'keyboard-interactive'],
        password,
      };
    }
    case 'privateKey': {
      let contents: Buffer;
      try {
        contents = await options.readFile(auth.keyPath);
      } catch (error) {
        const code = errorProp(error, 'code') ?? 'unreadable';
        throw tunnelError(
          'SSH_FAILED',
          `Cannot read the SSH private key file "${auth.keyPath}" (${code})`,
          "Check the key file path in the profile's SSH settings and that Querybara can read it",
          error,
          code,
        );
      }
      const passphrase = auth.passphrase ? secrets[auth.passphrase.id] : undefined;
      const key = ssh2KeyFrom(contents, passphrase, `"${auth.keyPath}"`);
      return {
        config: {
          privateKey: key.text,
          ...(key.passphrase !== undefined ? { passphrase: key.passphrase } : {}),
        },
        methods: ['publickey'],
      };
    }
    case 'agent': {
      const agent = agentSocket(options.agent);
      if (!agent) {
        throw tunnelError(
          'SSH_FAILED',
          'No SSH agent is available (SSH_AUTH_SOCK is not set)',
          'Start ssh-agent and add your key with ssh-add, or choose password or private key authentication',
          undefined,
          'AGENT_UNAVAILABLE',
        );
      }
      return { config: { agent }, methods: ['agent'] };
    }
  }
}

function authRejected(hop: SshHop, error: unknown): QuerybaraError {
  const where = hostLabel(hop.host, hop.port);
  switch (hop.auth.method) {
    case 'password':
      return tunnelError(
        'SSH_FAILED',
        `The SSH server ${where} rejected the password for user "${hop.user}"`,
        'Check the SSH user name and password',
        error,
        'AUTH_REJECTED',
      );
    case 'privateKey':
      return tunnelError(
        'SSH_FAILED',
        `The SSH server ${where} did not accept the key "${hop.auth.keyPath}" for user "${hop.user}"`,
        "Add the key's public half to ~/.ssh/authorized_keys of this user on the server, or check the user name",
        error,
        'AUTH_REJECTED',
      );
    case 'agent':
      return tunnelError(
        'SSH_FAILED',
        `The SSH server ${where} accepted none of the SSH agent's keys for user "${hop.user}"`,
        'Add the right key to the agent (ssh-add), or check the user name',
        error,
        'AUTH_REJECTED',
      );
  }
}

/** Maps an ssh2 client error raised before the session was ready. */
function mapHandshakeError(error: unknown, hop: SshHop): QuerybaraError {
  if (error instanceof QuerybaraError) return error;
  const where = hostLabel(hop.host, hop.port);
  const level = errorProp(error, 'level');
  const message = errorMessage(error);
  switch (level) {
    case 'client-socket':
    case 'client-dns':
      return mapSocketError(error, 'SSH server', where);
    case 'client-authentication':
      return authRejected(hop, error);
    case 'agent':
      return tunnelError(
        'SSH_FAILED',
        `Cannot use the SSH agent: ${message}`,
        'Check that ssh-agent (or Pageant) is running and holds your key',
        error,
        'AGENT_UNAVAILABLE',
      );
  }
  if (/Connection lost before handshake/i.test(message)) {
    return tunnelError(
      'SSH_FAILED',
      `${where} closed the connection before the SSH handshake`,
      "Check that the host and port are an SSH server's (usually port 22) and that it accepts connections from here",
      error,
    );
  }
  if (level === 'handshake' || level === 'protocol') {
    return tunnelError(
      'SSH_FAILED',
      `The SSH handshake with ${where} failed: ${message}`,
      'Check that this is an SSH server; it may only offer algorithms Querybara does not support',
      error,
    );
  }
  if (errorProp(error, 'code') !== undefined && /^\d+$/.test(errorProp(error, 'code')!)) {
    return tunnelError(
      'SSH_FAILED',
      `The SSH server ${where} disconnected: ${message}`,
      'Check the SSH server log; it may limit connections or refuse this client',
      error,
    );
  }
  return tunnelError(
    'SSH_FAILED',
    `The SSH connection to ${where} failed: ${message}`,
    'Check the SSH host, port and credentials',
    error,
  );
}

/**
 * Opens and authenticates one SSH hop. The host key goes through `verifier` first (the connect
 * timeout is paused while it runs, since it may prompt the user); a rejected or changed key, bad
 * credentials, an unreachable server or a timeout reject with a QuerybaraError and a fix hint.
 */
export async function connectHop(options: HopConnectOptions): Promise<Client> {
  const { hop } = options;
  const auth = await authConfig(options);
  const where = hostLabel(hop.host, hop.port);
  const client = new ssh2.Client();

  return new Promise<Client>((resolve, reject) => {
    let settled = false;
    let hostKeyError: QuerybaraError | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: QuerybaraError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        client.destroy();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const startTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(timeoutError('SSH_FAILED', 'SSH server', where, options.timeoutMs)),
        options.timeoutMs,
      );
    };

    client.on('ready', () => finish());
    client.on('error', (error) => finish(hostKeyError ?? mapHandshakeError(error, hop)));
    client.on('close', () =>
      finish(
        hostKeyError ??
          tunnelError(
            'SSH_FAILED',
            `The SSH server ${where} closed the connection during login`,
            'Check the SSH server log; it may refuse this user or client',
          ),
      ),
    );
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
      answer(prompts.map(() => auth.password ?? ''));
    });

    const hostVerifier = (key: Buffer, verify: (valid: boolean) => void): void => {
      clearTimeout(timer);
      const info = { algorithm: keyTypeOf(key), fingerprintSha256: fingerprintOf(key) };
      Promise.resolve()
        .then(() => options.verifier(hop.host, hop.port, info))
        .then(
          (decision) => {
            if (decision !== 'trust') {
              hostKeyError = tunnelError(
                'SSH_FAILED',
                `The host key of the SSH server ${where} was not trusted (${info.algorithm} ${info.fingerprintSha256})`,
                "Compare the fingerprint with the one the server's administrator gives you, and trust it only if it matches",
                undefined,
                'HOST_KEY_REJECTED',
              );
            }
            return decision === 'trust';
          },
          (error: unknown) => {
            hostKeyError =
              error instanceof QuerybaraError
                ? error
                : tunnelError(
                    'SSH_FAILED',
                    `Could not verify the host key of the SSH server ${where}: ${errorMessage(error)}`,
                    'Check the known hosts settings',
                    error,
                    'HOST_KEY_REJECTED',
                  );
            return false;
          },
        )
        .then((trusted) => {
          if (settled) return;
          if (trusted) startTimer();
          verify(trusted);
        });
    };

    const config: ConnectConfig = {
      username: hop.user,
      ...auth.config,
      authHandler: auth.methods,
      hostVerifier,
      // Our own timer replaces readyTimeout so that a host key prompt does not count against it.
      readyTimeout: 0,
      keepaliveInterval: options.keepAliveIntervalMs,
      keepaliveCountMax: 3,
      ...(options.sock ? { sock: options.sock } : { host: hop.host, port: hop.port }),
    };
    startTimer();
    try {
      client.connect(config);
    } catch (error) {
      finish(mapHandshakeError(error, hop));
    }
  });
}

/** The CHANNEL_OPEN_FAILURE reason codes of RFC 4254 §5.1. */
const OPEN_ADMINISTRATIVELY_PROHIBITED = 1;
const OPEN_CONNECT_FAILED = 2;
const OPEN_RESOURCE_SHORTAGE = 4;

/** Maps a failed direct-tcpip open on `via` (an SSH hop label) towards `target`. */
export function mapForwardError(error: unknown, via: string, target: string): QuerybaraError {
  if (error instanceof QuerybaraError) return error;
  const reason = Number(errorProp(error, 'reason'));
  const detail = errorMessage(error)
    .replace(/^\(SSH\) Channel open failure:\s*/, '')
    .trim();
  const suffix = detail ? ` (${detail})` : '';
  if (reason === OPEN_ADMINISTRATIVELY_PROHIBITED) {
    return tunnelError(
      'SSH_FAILED',
      `The SSH server ${via} refused to forward connections to ${target}${suffix}`,
      `Port forwarding is off on the SSH server: set "AllowTcpForwarding yes" in its sshd_config, and allow ${target} in any PermitOpen rule`,
      error,
      'FORWARD_PROHIBITED',
    );
  }
  if (reason === OPEN_CONNECT_FAILED) {
    return tunnelError(
      'CONNECTION_FAILED',
      `The SSH server ${via} could not connect to ${target}${suffix}`,
      'Check the host and port as the SSH server sees them: a database on the SSH server itself is usually 127.0.0.1, and a firewall may block the SSH server',
      error,
      'FORWARD_CONNECT_FAILED',
    );
  }
  if (reason === OPEN_RESOURCE_SHORTAGE) {
    return tunnelError(
      'SSH_FAILED',
      `The SSH server ${via} has no free channels to forward to ${target}`,
      'Close other sessions through this server, or raise MaxSessions in its sshd_config',
      error,
      'FORWARD_REFUSED',
    );
  }
  return tunnelError(
    'SSH_FAILED',
    `Forwarding through the SSH server ${via} to ${target} failed: ${errorMessage(error)}`,
    'The SSH connection may have dropped; try again',
    error,
    'FORWARD_REFUSED',
  );
}

/**
 * Opens a direct-tcpip channel from `client` to `target` within `timeoutMs`. `srcPort` is the
 * local port being forwarded, as sshd logs it; 0 when there is none.
 */
export function forwardOut(
  client: Client,
  srcPort: number,
  target: HostPort,
  timeoutMs: number,
  via: string,
): Promise<ClientChannel> {
  const targetLabel = hostLabel(target.host, target.port);
  return new Promise<ClientChannel>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(timeoutError('SSH_FAILED', 'SSH server', via, timeoutMs));
    }, timeoutMs);
    try {
      client.forwardOut('127.0.0.1', srcPort, target.host, target.port, (error, channel) => {
        clearTimeout(timer);
        if (done) {
          channel?.destroy();
          return;
        }
        done = true;
        if (error) reject(mapForwardError(error, via, targetLabel));
        else resolve(channel);
      });
    } catch (error) {
      clearTimeout(timer);
      done = true;
      reject(mapForwardError(error, via, targetLabel));
    }
  });
}
