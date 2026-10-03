import { connectionProfileSchema } from '@querybara/core';
import { safeProfileSchema } from '@querybara/ipc';
import { describe, expect, it } from 'vitest';

import {
  connectionFormSchema,
  defaultFormValues,
  defaultSshHop,
  formToProfile,
  profileToForm,
  typedSecrets,
  type ConnectionFormValues,
  type SshHopFormValues,
} from '../src/renderer/src/state/connection-form';
import { profileInput } from './helpers';

/** The connection dialog's SSH tunnel and proxy sections (spec §4). */

function hop(overrides: Partial<SshHopFormValues> = {}): SshHopFormValues {
  return { ...defaultSshHop(), host: 'bastion.example.com', user: 'ops', ...overrides };
}

function form(overrides: Partial<ConnectionFormValues> = {}): ConnectionFormValues {
  return { ...defaultFormValues('postgres'), name: 'Orders', user: 'app', ...overrides };
}

function issues(values: ConnectionFormValues): Record<string, string> {
  const result = connectionFormSchema.safeParse(values);
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]),
  );
}

describe('SSH and proxy form schema', () => {
  it('starts with both off and validates nothing of them until turned on', () => {
    const values = form({ sshHops: [defaultSshHop()], proxyHost: '' });
    expect(values).toMatchObject({ sshEnabled: false, proxyKind: 'none', sshKeepAlive: '15' });
    expect(issues(values)).toEqual({});
  });

  it('requires host, port and user of every hop, and a key file for key logins', () => {
    const values = form({
      sshEnabled: true,
      sshHops: [
        hop({ host: '', user: '' }),
        hop({ port: '70000', authMethod: 'privateKey', keyPath: '' }),
        hop({ authMethod: 'agent' }),
      ],
    });
    expect(issues(values)).toEqual({
      'sshHops.0.host': 'Enter the SSH host',
      'sshHops.0.user': 'Enter the SSH user',
      'sshHops.1.port': 'Port must be 1 to 65535',
      'sshHops.1.keyPath': 'Choose the private key file',
    });
    expect(issues(form({ sshEnabled: true, sshHops: [] }))).toHaveProperty('sshHops');
  });

  it('bounds the keep-alive interval', () => {
    const on = (sshKeepAlive: string) => form({ sshEnabled: true, sshHops: [hop()], sshKeepAlive });
    for (const ok of ['0', '15', '2.5', '3600']) expect(issues(on(ok)), ok).toEqual({});
    for (const bad of ['', '-1', 'soon', '3601']) {
      expect(issues(on(bad)), bad).toHaveProperty('sshKeepAlive');
    }
  });

  it('requires the proxy host and port once a proxy is chosen', () => {
    expect(issues(form({ proxyKind: 'socks5', proxyHost: '', proxyPort: 'x' }))).toEqual({
      proxyHost: 'Enter the proxy host',
      proxyPort: 'Port must be 1 to 65535',
    });
    expect(issues(form({ proxyKind: 'http', proxyHost: 'proxy', proxyPort: '3128' }))).toEqual({});
  });

  it('refuses a Unix socket endpoint behind a tunnel or proxy', () => {
    const socket = { endpointKind: 'socket' as const, socketPath: '/run/pg' };
    expect(issues(form({ ...socket, sshEnabled: true, sshHops: [hop()] }))).toHaveProperty(
      'socketPath',
    );
    expect(
      issues(form({ ...socket, proxyKind: 'socks5', proxyHost: 'p', proxyPort: '1080' })),
    ).toHaveProperty('socketPath');
    expect(issues(form(socket))).toEqual({});
  });
});

describe('SSH and proxy form ↔ profile', () => {
  it('builds hops, keep-alive and proxy with secret references, never the secrets', () => {
    const { profile, secrets } = formToProfile(
      form({
        password: 'db-pw',
        sshEnabled: true,
        sshHops: [
          hop({ host: 'jump.example.com', authMethod: 'agent' }),
          hop({ port: '2222', password: 'ssh-pw', passwordMode: 'session' }),
          hop({
            host: 'inner',
            authMethod: 'privateKey',
            keyPath: '~/.ssh/id_ed25519',
            passphrase: 'key-pw',
            passphraseMode: 'ask',
          }),
        ],
        sshKeepAlive: '30',
        proxyKind: 'socks5',
        proxyHost: 'proxy.internal',
        proxyPort: '1080',
        proxyUser: 'me',
        proxyPassword: 'proxy-pw',
        proxyPasswordMode: 'save',
      }),
    );
    const parsed = safeProfileSchema.parse(profile);
    const text = JSON.stringify(parsed);
    for (const secret of ['db-pw', 'ssh-pw', 'key-pw', 'proxy-pw']) {
      expect(text).not.toContain(secret);
    }
    const [jump, middle, inner] = parsed.ssh?.hops ?? [];
    expect(jump).toEqual({
      host: 'jump.example.com',
      port: 22,
      user: 'ops',
      auth: { method: 'agent' },
    });
    expect(middle).toMatchObject({ port: 2222, auth: { method: 'password' } });
    expect(inner?.auth).toMatchObject({ method: 'privateKey', keyPath: '~/.ssh/id_ed25519' });
    expect(parsed.ssh?.keepAliveIntervalMs).toBe(30_000);
    expect(parsed.proxy).toMatchObject({
      kind: 'socks5',
      host: 'proxy.internal',
      port: 1080,
      user: 'me',
    });
    // Every secret leaves the form as a reference plus the typed value, for main only.
    const byValue = Object.fromEntries(secrets.map((s) => [s.value, s.ref]));
    expect(byValue['ssh-pw']).toEqual(
      middle?.auth.method === 'password' ? middle.auth.password : undefined,
    );
    expect(byValue['key-pw']?.policy).toBe('ask');
    expect(byValue['proxy-pw']).toEqual(parsed.proxy?.password);
    expect(typedSecrets(secrets)).toEqual(
      Object.fromEntries(secrets.map((s) => [s.ref.id, s.value])),
    );
    expect(typedSecrets([])).toBeUndefined();
  });

  it('round-trips a saved tunnel and keeps its secret references while editing', () => {
    const existing = connectionProfileSchema.parse(
      profileInput({
        ssh: {
          hops: [
            {
              host: 'jump',
              user: 'ops',
              auth: { method: 'password', password: { id: 'ssh-ref', policy: 'session' } },
            },
            {
              host: 'db-ssh',
              port: 2200,
              user: 'tunnel',
              auth: {
                method: 'privateKey',
                keyPath: '/keys/id',
                passphrase: { id: 'key-ref', policy: 'save' },
              },
            },
          ],
          keepAliveIntervalMs: 0,
        },
        proxy: {
          kind: 'http',
          host: 'proxy',
          port: 3128,
          password: { id: 'proxy-ref', policy: 'ask' },
        },
      }),
    );
    const values = profileToForm(existing);
    expect(values).toMatchObject({
      sshEnabled: true,
      sshKeepAlive: '0',
      proxyKind: 'http',
      proxyPort: '3128',
      proxyPasswordMode: 'ask',
    });
    expect(values.sshHops[0]).toMatchObject({ passwordMode: 'session', password: '' });
    expect(values.sshHops[1]).toMatchObject({
      authMethod: 'privateKey',
      keyPath: '/keys/id',
      passphraseMode: 'save',
      passphrase: '',
    });
    const { profile, secrets } = formToProfile(values, existing);
    const parsed = connectionProfileSchema.parse(profile);
    expect(parsed.ssh).toEqual(existing.ssh);
    expect(parsed.proxy).toEqual(existing.proxy);
    // Nothing typed: the stored values stay, and the policies are unchanged.
    expect(
      secrets
        .filter((s) => s.ref.id !== passwordId(existing))
        .map((s) => [s.ref.id, s.value, s.previousPolicy]),
    ).toEqual([
      ['ssh-ref', '', 'session'],
      ['key-ref', '', 'save'],
      ['proxy-ref', '', 'ask'],
    ]);
  });

  it('drops the tunnel and proxy when they are turned off', () => {
    const existing = connectionProfileSchema.parse(
      profileInput({
        ssh: { hops: [{ host: 'jump', user: 'ops', auth: { method: 'agent' } }] },
        proxy: { kind: 'socks5', host: 'proxy', port: 1080 },
      }),
    );
    const values = { ...profileToForm(existing), sshEnabled: false, proxyKind: 'none' as const };
    const parsed = connectionProfileSchema.parse(formToProfile(values, existing).profile);
    expect(parsed.ssh).toBeUndefined();
    expect(parsed.proxy).toBeUndefined();
  });

  it('mints a new reference when a hop switches to another login method', () => {
    const existing = connectionProfileSchema.parse(
      profileInput({
        ssh: {
          hops: [
            {
              host: 'jump',
              user: 'ops',
              auth: { method: 'password', password: { id: 'ssh-ref', policy: 'save' } },
            },
          ],
        },
      }),
    );
    const values = profileToForm(existing);
    const switched = {
      ...values,
      sshHops: [{ ...values.sshHops[0]!, authMethod: 'privateKey' as const, keyPath: '/k' }],
    };
    const { profile, secrets } = formToProfile(switched, existing);
    expect(connectionProfileSchema.parse(profile).ssh?.hops[0]?.auth).toEqual({
      method: 'privateKey',
      keyPath: '/k',
    });
    expect(secrets.map((s) => s.ref.id)).not.toContain('ssh-ref');
  });
});

function passwordId(profile: ReturnType<typeof connectionProfileSchema.parse>): string {
  return profile.auth.method === 'password' ? (profile.auth.password?.id ?? '') : '';
}
