import { connectionProfileSchema, newId, type ConnectionProfile } from '@joinery/core';
import { parsedConnectionUriSchema } from '@joinery/ipc';
import { parseConnectionUri } from '@joinery/storage';
import { describe, expect, it } from 'vitest';

import {
  connectionFormSchema,
  defaultFormValues,
  defaultSshHop,
  formFromUri,
  formToProfile,
  isCloudId,
  profileToForm,
  switchEngine,
  type ConnectionFormValues,
  type ParseUri,
} from '../src/renderer/src/state/connection-form';

/** The connection dialog for Elasticsearch and OpenSearch (spec §4, §11). */

function elastic(overrides: Partial<ConnectionFormValues> = {}): ConnectionFormValues {
  return {
    ...defaultFormValues('elasticsearch'),
    name: 'Logs',
    user: 'elastic',
    password: 'changeme',
    ...overrides,
  };
}

function issues(values: ConnectionFormValues): Record<string, string> {
  const result = connectionFormSchema.safeParse(values);
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]),
  );
}

const cloudId = `prod:${btoa('us-east-1.aws.found.io:443$abc123$def456')}`;

const parse: ParseUri = ({ uri, engine }) => {
  const parsed = parseConnectionUri(uri, engine === undefined ? {} : { engine });
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: newId(),
    createdAt: now,
    updatedAt: now,
  });
  return Promise.resolve(
    parsedConnectionUriSchema.parse({
      profile,
      passwordFound: parsed.password !== undefined,
      ignoredParams: [...parsed.ignoredParams],
    }),
  );
};

describe('Elasticsearch and OpenSearch defaults', () => {
  it('start on an https node URL with verified TLS; Elasticsearch signs in, OpenSearch not', () => {
    expect(defaultFormValues('elasticsearch')).toMatchObject({
      endpointKind: 'urls',
      urls: [{ url: 'https://localhost:9200' }],
      authMethod: 'password',
      tlsMode: 'verify-full',
      sniff: false,
    });
    expect(defaultFormValues('opensearch')).toMatchObject({
      endpointKind: 'urls',
      authMethod: 'none',
    });
    expect(issues(elastic())).toEqual({});
  });

  it('keeps the URLs between the two, and resets the endpoint for other engines', () => {
    const urls = [{ url: 'https://es1:9200' }, { url: 'https://es2:9200' }];
    const opensearch = switchEngine(elastic({ urls, authMethod: 'apiKey' }), 'opensearch');
    expect(opensearch).toMatchObject({ endpointKind: 'urls', urls, authMethod: 'none' });
    const fromCloud = switchEngine(elastic({ endpointKind: 'cloudId', cloudId }), 'opensearch');
    expect(fromCloud).toMatchObject({ endpointKind: 'urls', cloudId: '' });
    expect(switchEngine(elastic(), 'redis')).toMatchObject({ endpointKind: 'host', port: '6379' });
    expect(switchEngine(defaultFormValues('postgres'), 'elasticsearch').endpointKind).toBe('urls');
  });
});

describe('Elasticsearch and OpenSearch validation', () => {
  it('checks every node URL', () => {
    expect(issues(elastic({ urls: [{ url: '' }] }))).toEqual({
      'urls.0.url': 'Enter a URL such as https://localhost:9200',
    });
    expect(issues(elastic({ urls: [{ url: 'ftp://es' }] }))['urls.0.url']).toContain('http://');
    expect(issues(elastic({ urls: [{ url: 'https://u:pw@es:9200' }] }))['urls.0.url']).toContain(
      'password field',
    );
    expect(issues(elastic({ urls: [] })).urls).toBe('Add at least one node URL');
    expect(
      issues(elastic({ urls: [{ url: 'https://a:9200' }, { url: 'http://b:9200' }] })).urls,
    ).toContain('same scheme');
  });

  it('keeps the TLS mode in line with the URL scheme', () => {
    expect(issues(elastic({ tlsMode: 'disable' })).tlsMode).toContain(
      'https:// URL connects with TLS',
    );
    expect(issues(elastic({ urls: [{ url: 'http://es:9200' }] })).tlsMode).toContain('Disable TLS');
    expect(issues(elastic({ urls: [{ url: 'http://es:9200' }], tlsMode: 'disable' }))).toEqual({});
    // Without a scheme the URL follows the TLS mode.
    expect(issues(elastic({ urls: [{ url: 'es:9200' }], tlsMode: 'disable' }))).toEqual({});
  });

  it('takes one URL through a tunnel, and a valid Cloud ID', () => {
    const tunnel = {
      sshEnabled: true,
      sshHops: [{ ...defaultSshHop(), host: 'b', user: 'ops', password: 'x' }],
    };
    expect(
      issues(elastic({ ...tunnel, urls: [{ url: 'https://a:9200' }, { url: 'https://b:9200' }] }))
        .urls,
    ).toContain('Only one node URL');
    expect(issues(elastic({ ...tunnel }))).toEqual({});
    expect(issues(elastic({ endpointKind: 'cloudId', cloudId: 'nope' })).cloudId).toContain(
      'not a Cloud ID',
    );
    expect(issues(elastic({ endpointKind: 'cloudId', cloudId }))).toEqual({});
    expect(isCloudId(cloudId)).toBe(true);
    // OpenSearch has no Cloud ID.
    expect(
      issues({ ...elastic({ endpointKind: 'cloudId', cloudId }), engine: 'opensearch' })
        .endpointKind,
    ).toBeDefined();
  });

  it('needs a user for basic authentication and a storage policy for keys and tokens', () => {
    expect(issues(elastic({ user: '' })).user).toContain('user name');
    expect(issues(elastic({ authMethod: 'apiKey', passwordMode: 'none' })).passwordMode).toContain(
      'API key',
    );
    expect(issues(elastic({ authMethod: 'bearer', passwordMode: 'none' })).passwordMode).toContain(
      'token',
    );
    expect(
      issues({ ...elastic({ authMethod: 'apiKey' }), engine: 'opensearch' }).authMethod,
    ).toBeDefined();
  });
});

describe('Elasticsearch and OpenSearch profiles', () => {
  it('builds node URLs, basic credentials, sniffing and TLS', () => {
    const { profile, secrets } = formToProfile(
      elastic({ urls: [{ url: 'https://es1:9200' }, { url: 'https://es2:9200' }], sniff: true }),
      undefined,
      () => '2026-09-29T10:00:00.000Z',
    );
    expect(profile).toMatchObject({
      engine: 'elasticsearch',
      endpoint: { kind: 'urls', urls: ['https://es1:9200', 'https://es2:9200'] },
      auth: { method: 'password', user: 'elastic' },
      tls: { mode: 'verify-full' },
      options: { sniff: true },
    });
    expect(secrets.map((s) => s.value)).toEqual(['changeme']);
    const parsed = connectionProfileSchema.parse(profile);
    expect(profileToForm(parsed)).toMatchObject({
      endpointKind: 'urls',
      urls: [{ url: 'https://es1:9200' }, { url: 'https://es2:9200' }],
      sniff: true,
      authMethod: 'password',
      user: 'elastic',
      password: '',
    });
  });

  it('stores an API key or a token as a secret, keeping the reference when edited', () => {
    const { profile, secrets, passwordRef } = formToProfile(
      elastic({ authMethod: 'apiKey', password: 'id:key', passwordMode: 'session' }),
    );
    expect(profile.auth).toEqual({ method: 'apiKey', apiKey: passwordRef });
    expect(secrets).toEqual([{ ref: passwordRef, value: 'id:key', previousPolicy: undefined }]);
    const saved = connectionProfileSchema.parse(profile) as ConnectionProfile;
    expect(profileToForm(saved)).toMatchObject({ authMethod: 'apiKey', passwordMode: 'session' });
    const again = formToProfile({ ...profileToForm(saved), authMethod: 'bearer' }, saved);
    expect(again.profile.auth).toEqual({
      method: 'bearer',
      token: { id: passwordRef!.id, policy: 'session' },
    });
    const cloud = formToProfile(elastic({ endpointKind: 'cloudId', cloudId, sniff: true }));
    expect(cloud.profile.endpoint).toEqual({ kind: 'cloudId', cloudId });
    expect(cloud.profile.options?.sniff).toBeUndefined();
  });

  it('fills the form from a pasted URL for the chosen engine', async () => {
    const current = { ...defaultFormValues('opensearch'), name: '' };
    const { values } = await formFromUri('http://admin:secret@127.0.0.1:9201', {
      engine: 'opensearch',
      parse,
      current: () => current,
      canSave: true,
    });
    expect(values).toMatchObject({
      engine: 'opensearch',
      endpointKind: 'urls',
      urls: [{ url: 'http://127.0.0.1:9201' }],
      authMethod: 'password',
      user: 'admin',
      password: 'secret',
      passwordMode: 'save',
      tlsMode: 'disable',
    });
    expect(issues({ ...values, name: 'Local' })).toEqual({});
    const fromSql = await formFromUri('https://es.example.com:9243', {
      engine: 'postgres',
      parse,
      current: () => defaultFormValues(),
      canSave: true,
    });
    expect(fromSql.values).toMatchObject({ engine: 'elasticsearch', tlsMode: 'verify-full' });
  });
});
