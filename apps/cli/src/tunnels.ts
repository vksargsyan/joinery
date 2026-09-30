import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  JoineryError,
  type ConnectionProfile,
  type ProxyOptions,
  type SecretRef,
  type SshAuth,
  type SshHop,
} from '@joinery/core';
import {
  FileKnownHosts,
  TransportManager,
  expandHome,
  importPrivateKey,
  knownHostsVerifier,
  type HostKeyVerifier,
  type KnownHostsStore,
} from '@joinery/tunnel';

import type { Prompter } from './context';
import { CliError } from './errors';
import type { Reporter } from './reporter';

/**
 * SSH tunnels and proxies on the command line (spec §4). Saved profiles bring their own SSH and
 * proxy settings; URI targets get them from `--ssh` (repeatable, jump hosts first), `--ssh-key`,
 * `--ssh-password-env`, `--ssh-agent` and `--proxy`. Host keys are checked against a known-hosts
 * file, by default the desktop app's, so both trust the same servers: a new key is refused
 * unless `--ssh-accept-new` is given or the user confirms it in a terminal, and a changed key is
 * always refused.
 */

/** `--ssh user@host[:port]`: one SSH hop. */
export interface SshHopFlag {
  readonly user: string;
  readonly host: string;
  readonly port: number;
}

/** `--proxy socks5://host:port` or `http://host:port`, optionally with `user[:password]@`. */
export interface ProxyFlag {
  readonly kind: ProxyOptions['kind'];
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly password?: string;
}

/** The SSH and proxy options of one run. */
export interface TunnelFlags {
  readonly ssh?: readonly SshHopFlag[];
  readonly sshKey?: string;
  readonly sshPasswordEnv?: string;
  readonly sshAgent?: boolean;
  readonly proxy?: ProxyFlag;
  readonly sshAcceptNew?: boolean;
  readonly knownHosts?: string;
}

/** The SSH password for URI hops (and saved profiles) when no flag names another variable. */
export const SSH_PASSWORD_ENV = 'JOINERY_SSH_PASSWORD';
export const SSH_KEY_PASSPHRASE_ENV = 'JOINERY_SSH_KEY_PASSPHRASE';
export const PROXY_PASSWORD_ENV = 'JOINERY_PROXY_PASSWORD';
/** Next to the store, as in the desktop app's user data folder. */
export const KNOWN_HOSTS_FILE_NAME = 'known_hosts';

const SSH_PASSWORD_REF = 'joinery-cli-ssh-password';
const SSH_PASSPHRASE_REF = 'joinery-cli-ssh-passphrase';
const PROXY_PASSWORD_REF = 'joinery-cli-proxy-password';

export interface TunnelDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompter: Prompter;
  readonly reporter: Reporter;
}

/** True when the flags describe a route (hops or a proxy), not only how to check host keys. */
export function hasRouteFlags(flags: TunnelFlags | undefined): boolean {
  if (!flags) return false;
  return (
    (flags.ssh?.length ?? 0) > 0 ||
    flags.proxy !== undefined ||
    flags.sshKey !== undefined ||
    flags.sshPasswordEnv !== undefined ||
    flags.sshAgent === true
  );
}

/** "user@host:port", with an IPv6 host bracketed. */
export function hopLabel(hop: { user?: string; host: string; port: number }): string {
  const host = hop.host.includes(':') ? `[${hop.host}]` : hop.host;
  return `${hop.user === undefined ? '' : `${hop.user}@`}${host}:${hop.port}`;
}

/** "SSH ops@bastion:22 → db:5432" style summary of a profile's route, without secrets. */
export function describeRoute(profile: ConnectionProfile): string | undefined {
  const parts: string[] = [];
  if (profile.proxy) {
    parts.push(
      `${profile.proxy.kind === 'http' ? 'HTTP' : 'SOCKS5'} proxy ${hopLabel(profile.proxy)}`,
    );
  }
  if (profile.ssh) parts.push(`SSH ${profile.ssh.hops.map(hopLabel).join(' → ')}`);
  return parts.length > 0 ? parts.join(' → ') : undefined;
}

/**
 * Adds the command line's `--ssh` hops and `--proxy` to a URI target's profile and collects the
 * secrets they need: the SSH password (`--ssh-password-env`, JOINERY_SSH_PASSWORD or a hidden
 * prompt per hop), the key passphrase (JOINERY_SSH_KEY_PASSPHRASE or a prompt, checked against
 * the key now) and the proxy password (in the URL or JOINERY_PROXY_PASSWORD).
 */
export async function applyTunnelFlags(
  profile: ConnectionProfile,
  flags: TunnelFlags,
  deps: TunnelDeps,
): Promise<{ profile: ConnectionProfile; secrets: [string, string][] }> {
  const secrets: [string, string][] = [];
  let next = profile;
  const hops = flags.ssh ?? [];
  if (hops.length === 0 && hasRouteFlags({ ...flags, proxy: undefined })) {
    throw new CliError('--ssh-key, --ssh-agent and --ssh-password-env need --ssh user@host', {
      hint: 'Name the SSH server with --ssh user@host[:port]',
    });
  }
  if (hops.length > 0) {
    const auths: SshAuth[] = [];
    if (flags.sshAgent) {
      for (const _hop of hops) auths.push({ method: 'agent' });
    } else if (flags.sshKey !== undefined) {
      const passphrase = await keyPassphrase(flags.sshKey, deps);
      const ref: SecretRef | undefined =
        passphrase === undefined ? undefined : { id: SSH_PASSPHRASE_REF, policy: 'ask' };
      if (passphrase !== undefined) secrets.push([SSH_PASSPHRASE_REF, passphrase]);
      for (const _hop of hops) {
        auths.push({
          method: 'privateKey',
          keyPath: flags.sshKey,
          ...(ref ? { passphrase: ref } : {}),
        });
      }
    } else {
      for (const [index, hop] of hops.entries()) {
        const id = `${SSH_PASSWORD_REF}-${index + 1}`;
        secrets.push([id, await sshPassword(hop, flags, deps)]);
        auths.push({ method: 'password', password: { id, policy: 'ask' } });
      }
    }
    const sshHops: SshHop[] = hops.map((hop, index) => ({
      host: hop.host,
      port: hop.port,
      user: hop.user,
      auth: auths[index]!,
    }));
    next = { ...next, ssh: { hops: sshHops, keepAliveIntervalMs: 15_000 } };
  }
  if (flags.proxy) {
    const { kind, host, port, user } = flags.proxy;
    const password = flags.proxy.password ?? (user ? deps.env[PROXY_PASSWORD_ENV] : undefined);
    if (password !== undefined) secrets.push([PROXY_PASSWORD_REF, password]);
    next = {
      ...next,
      proxy: {
        kind,
        host,
        port,
        ...(user !== undefined ? { user } : {}),
        ...(password !== undefined ? { password: { id: PROXY_PASSWORD_REF, policy: 'ask' } } : {}),
      },
    };
  }
  return { profile: next, secrets };
}

async function sshPassword(hop: SshHopFlag, flags: TunnelFlags, deps: TunnelDeps): Promise<string> {
  if (flags.sshPasswordEnv !== undefined) {
    const value = deps.env[flags.sshPasswordEnv];
    if (value === undefined) {
      throw new CliError(`--ssh-password-env: ${flags.sshPasswordEnv} is not set`, {
        code: 'AUTH_FAILED',
        hint: `Export ${flags.sshPasswordEnv} with the SSH password, or use --ssh-key or --ssh-agent`,
      });
    }
    return value;
  }
  const fromEnv = deps.env[SSH_PASSWORD_ENV];
  if (fromEnv !== undefined) return fromEnv;
  if (deps.prompter.interactive) {
    deps.reporter.clearProgress();
    return deps.prompter.secret(`SSH password for ${hopLabel(hop)}: `);
  }
  throw new CliError(`No SSH password for ${hopLabel(hop)}`, {
    code: 'AUTH_FAILED',
    hint: `Use --ssh-key <path>, --ssh-agent or --ssh-password-env <VAR> (default ${SSH_PASSWORD_ENV}), or run in a terminal to be asked`,
  });
}

/** Reads the key now (a missing or unusable file fails early) and gets its passphrase if needed. */
async function keyPassphrase(path: string, deps: TunnelDeps): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(expandHome(path), 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    throw new CliError(`Cannot read the SSH key "${path}" (${code})`, {
      hint: 'Check the --ssh-key path (the private key, not the .pub file)',
      cause: error,
    });
  }
  const key = importPrivateKey(text);
  if (!key.needsPassphrase) return undefined;
  let passphrase = deps.env[SSH_KEY_PASSPHRASE_ENV];
  if (passphrase === undefined) {
    if (!deps.prompter.interactive) {
      throw new CliError(`The SSH key "${path}" is protected by a passphrase`, {
        code: 'AUTH_FAILED',
        hint: `Set ${SSH_KEY_PASSPHRASE_ENV}, run in a terminal to be asked, or use --ssh-agent`,
      });
    }
    deps.reporter.clearProgress();
    passphrase = await deps.prompter.secret(`Passphrase for the SSH key ${path}: `);
  }
  importPrivateKey(text, passphrase);
  return passphrase;
}

/** The desktop app's known-hosts file: next to its store, so the app and the CLI share trust. */
export function defaultKnownHostsPath(storePath: string): string {
  return join(dirname(storePath), KNOWN_HOSTS_FILE_NAME);
}

/**
 * Host key checking for the CLI: a remembered key is trusted, a changed key is refused loudly,
 * and a new key is trusted and remembered with `acceptNew`, after a yes in a terminal, or else
 * refused with a hint naming `--ssh-accept-new`.
 */
export function cliHostKeyVerifier(
  store: KnownHostsStore,
  options: {
    readonly path: string;
    readonly acceptNew: boolean;
    readonly prompter: Prompter;
    readonly reporter: Reporter;
  },
): HostKeyVerifier {
  const { path, acceptNew, prompter, reporter } = options;
  return knownHostsVerifier(store, async (host, port, key) => {
    const where = hopLabel({ host, port });
    const fingerprint = `${key.algorithm} ${key.fingerprintSha256}`;
    if (acceptNew) {
      reporter.info(
        `Trusting the new SSH host key of ${where} (${fingerprint}); remembered in ${path}`,
      );
      return 'trust';
    }
    if (!prompter.interactive) {
      throw new JoineryError({
        code: 'SSH_FAILED',
        message: `The host key of the SSH server ${where} is not known yet (${fingerprint})`,
        hint: `Compare the fingerprint with the one the server's administrator gives you, then run again with --ssh-accept-new to trust it (it is remembered in ${path}), or connect once from the desktop app`,
        engineCode: 'HOST_KEY_UNKNOWN',
      });
    }
    reporter.clearProgress();
    const answer = await prompter.confirm(
      `The SSH server ${where} is not known yet. Its host key fingerprint is ${fingerprint}.\nTrust it and remember it in ${path}?`,
    );
    return answer === 'no' ? 'reject' : 'trust';
  });
}

/**
 * The run's tunnels: one TransportManager, created when the first target needs a tunnel or a
 * proxy (so SSH sessions to a shared bastion are reused between the two sides of a compare).
 * `closeAll` ends them before the process exits.
 */
export class Tunnels {
  #manager: TransportManager | undefined;

  constructor(
    private readonly deps: {
      readonly storePath: string;
      readonly cwd: string;
      readonly prompter: Prompter;
      readonly reporter: Reporter;
    },
  ) {}

  /** The manager, set up on first use from the known-hosts flags of this run. */
  manager(flags: TunnelFlags = {}): TransportManager {
    if (this.#manager) return this.#manager;
    const path =
      flags.knownHosts !== undefined
        ? resolve(this.deps.cwd, flags.knownHosts)
        : defaultKnownHostsPath(this.deps.storePath);
    this.deps.reporter.debug(`known hosts: ${path}`);
    this.#manager = new TransportManager({
      hostKeyVerifier: cliHostKeyVerifier(new FileKnownHosts(path), {
        path,
        acceptNew: flags.sshAcceptNew === true,
        prompter: this.deps.prompter,
        reporter: this.deps.reporter,
      }),
    });
    return this.#manager;
  }

  closeAll(): void {
    this.#manager?.closeAll();
    this.#manager = undefined;
  }
}
