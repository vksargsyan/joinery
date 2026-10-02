import { connectionProfileSchema, type BrowseNode } from '@joinery/core';
import { safeProfileSchema } from '@joinery/ipc';
import { describe, expect, it } from 'vitest';

import {
  connectionFormSchema,
  defaultFormValues,
  formToProfile,
  passwordFromUri,
  profileToForm,
  type ConnectionFormValues,
} from '../src/renderer/src/state/connection-form';
import { selectStatementFor } from '../src/renderer/src/state/explorer';
import { profileInput } from './helpers';

function form(overrides: Partial<ConnectionFormValues> = {}): ConnectionFormValues {
  return { ...defaultFormValues('postgres'), name: 'Orders', user: 'app', ...overrides };
}

function issues(values: ConnectionFormValues): Record<string, string> {
  const result = connectionFormSchema.safeParse(values);
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]),
  );
}

describe('connection form schema', () => {
  it('accepts a complete host form and starts with TLS off', () => {
    expect(connectionFormSchema.safeParse(form()).success).toBe(true);
    expect(defaultFormValues('mysql')).toMatchObject({ port: '3306', tlsMode: 'disable' });
    expect(defaultFormValues().port).toBe('5432');
  });

  it('requires what the chosen endpoint needs', () => {
    expect(issues(form({ name: '  ' }))).toHaveProperty('name');
    expect(issues(form({ host: '' }))).toHaveProperty('host');
    for (const port of ['', '0', '65536', 'abc', '54.3']) {
      expect(issues(form({ port })), port).toHaveProperty('port');
    }
    expect(issues(form({ endpointKind: 'socket', socketPath: '' }))).toHaveProperty('socketPath');
    expect(
      issues(form({ endpointKind: 'socket', socketPath: '/run/pg', host: '', port: '' })),
    ).toEqual({});
    expect(issues(form({ endpointKind: 'uri', uri: '' }))).toHaveProperty('uri');
    expect(issues(form({ color: 'red' }))).toHaveProperty('color');
  });

  it('refuses a URI that still carries its password', () => {
    const message = issues(form({ endpointKind: 'uri', uri: 'postgresql://app:hunter2@db/app' }))[
      'uri'
    ];
    expect(message).toMatch(/password field/);
    expect(message).not.toContain('hunter2');
    expect(issues(form({ endpointKind: 'uri', uri: 'postgresql://app@db/app' }))).toEqual({});
  });
});

describe('form ↔ profile', () => {
  it('builds a safe profile with a password reference, never the password', () => {
    const { profile, passwordRef } = formToProfile(
      form({
        password: 'hunter2',
        passwordMode: 'session',
        database: 'sales',
        environment: 'production',
      }),
    );
    const parsed = safeProfileSchema.parse(profile);
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(parsed.auth).toEqual({
      method: 'password',
      user: 'app',
      password: { id: passwordRef?.id, policy: 'session' },
    });
    expect(parsed.options.defaultDatabase).toBe('sales');
    expect(parsed.presentation.environment).toBe('production');
    expect(parsed.endpoint).toEqual({ kind: 'host', host: 'localhost', port: 5432 });

    const none = formToProfile(form({ passwordMode: 'none' }));
    expect(none.passwordRef).toBeUndefined();
    expect(safeProfileSchema.parse(none.profile).auth).toEqual({ method: 'password', user: 'app' });
  });

  it('keeps ids, secret references and hidden fields of the edited profile', () => {
    const existing = connectionProfileSchema.parse(
      profileInput({
        ssh: { hops: [{ host: 'bastion', user: 'ops', auth: { method: 'agent' } }] },
        options: { connectTimeoutMs: 5000, initSql: ['set search_path = app'] },
        presentation: { tags: ['billing'], environment: 'staging' },
      }),
    );
    const values = profileToForm(existing);
    expect(values).toMatchObject({
      name: 'Local Postgres',
      user: 'app',
      passwordMode: 'save',
      environment: 'staging',
    });
    expect(values.password).toBe('');
    const { profile, passwordRef } = formToProfile({ ...values, name: 'Renamed' }, existing);
    const parsed = connectionProfileSchema.parse(profile);
    expect(parsed.id).toBe(existing.id);
    expect(parsed.createdAt).toBe(existing.createdAt);
    expect(passwordRef?.id).toBe(
      existing.auth.method === 'password' ? existing.auth.password?.id : '',
    );
    expect(parsed.ssh).toEqual(existing.ssh);
    expect(parsed.options.initSql).toEqual(['set search_path = app']);
    expect(parsed.presentation.tags).toEqual(['billing']);
    expect(parsed.name).toBe('Renamed');
  });

  it('round-trips TLS files and socket endpoints', () => {
    const values = form({
      endpointKind: 'socket',
      socketPath: '/var/run/postgresql',
      tlsMode: 'verify-ca',
      caPath: '/etc/ssl/ca.pem',
    });
    const profile = connectionProfileSchema.parse(formToProfile(values).profile);
    expect(profile.tls).toMatchObject({ mode: 'verify-ca', caPath: '/etc/ssl/ca.pem' });
    expect(profileToForm(profile)).toMatchObject({
      endpointKind: 'socket',
      socketPath: '/var/run/postgresql',
      tlsMode: 'verify-ca',
      caPath: '/etc/ssl/ca.pem',
    });
  });

  it('takes the password of a pasted URI on the page side', () => {
    expect(passwordFromUri('postgresql://app:s3cr%40t@db:5432/app')).toBe('s3cr@t');
    expect(passwordFromUri('mysql://root:@db/app')).toBe('');
    expect(passwordFromUri('postgresql://app@db/app')).toBeUndefined();
    expect(passwordFromUri('postgresql://db/app?user=app&password=p%20w')).toBe('p w');
    expect(passwordFromUri('not a uri')).toBeUndefined();
  });
});

describe('explorer', () => {
  const node = (path: string[], kind: BrowseNode['kind'] = 'table'): BrowseNode => ({
    kind,
    name: path.at(-1)!,
    path,
    hasChildren: true,
  });

  it('opens a table with a quoted, qualified SELECT', () => {
    expect(selectStatementFor(node(['app', 'public', 'tables', 'orders']), 'postgres')).toBe(
      'SELECT * FROM "public"."orders" LIMIT 1000;',
    );
    expect(
      selectStatementFor(node(['app', 'Sales "EU"', 'tables', 'Order Lines']), 'postgres'),
    ).toBe('SELECT * FROM "Sales ""EU"""."Order Lines" LIMIT 1000;');
    expect(selectStatementFor(node(['shop', 'tables', 'or`ders']), 'mysql')).toBe(
      'SELECT * FROM `shop`.`or``ders` LIMIT 1000;',
    );
  });
});
