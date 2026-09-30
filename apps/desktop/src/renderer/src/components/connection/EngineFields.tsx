import { useWatch } from 'react-hook-form';

import {
  ENGINE_AUTH_METHODS,
  EXTERNAL_AUTH_SOURCE,
  MONGO_MECHANISMS,
  READ_PREFERENCES,
  showsAuthSource,
  showsDatabase,
  type FormAuthMethod,
  type ReadPreference,
} from '../../state/connection-form';
import { Field, Input, Select } from '../ui';
import { Note, PasswordFields, type ConnectionForm } from './fields';

/**
 * The engine's own part of the connection dialog (spec §4): database and sign-in for SQL
 * engines, and for MongoDB, Redis and Elasticsearch their sign-in methods (§9, §10, §11) on the
 * General tab; MongoDB's and Redis's options (default database, read preference, database
 * number, key delimiter) on the Advanced tab.
 */

interface SectionProps {
  readonly form: ConnectionForm;
  readonly canSave: boolean;
  /** An existing profile: empty secret fields keep the stored values. */
  readonly editing: boolean;
}

/** PostgreSQL, MySQL, MariaDB: database, user and password. */
export function SqlFields(props: SectionProps) {
  const { register, control } = props.form;
  const kind = useWatch({ control, name: 'endpointKind' });
  return (
    <>
      {kind !== 'uri' && (
        <Field label="Database" htmlFor="cx-database" hint="Optional">
          <Input id="cx-database" {...register('database')} />
        </Field>
      )}
      <Field label="User" htmlFor="cx-user">
        <Input id="cx-user" autoComplete="off" {...register('user')} />
      </Field>
      <PasswordFields {...props} />
    </>
  );
}

const MONGO_AUTH_LABELS: Readonly<Record<FormAuthMethod, string>> = {
  none: 'None',
  password: 'User and password',
  clientCertificate: 'X.509 client certificate',
  apiKey: 'API key',
  bearer: 'Bearer token',
};

const MECHANISM_LABELS: Readonly<Record<(typeof MONGO_MECHANISMS)[number], string>> = {
  'SCRAM-SHA-256': 'SCRAM-SHA-256',
  'SCRAM-SHA-1': 'SCRAM-SHA-1',
  PLAIN: 'LDAP (PLAIN)',
  '': 'Negotiate with the server',
};

const READ_PREFERENCE_LABELS: Readonly<Record<ReadPreference, string>> = {
  primary: 'Primary',
  primaryPreferred: 'Primary preferred',
  secondary: 'Secondary',
  secondaryPreferred: 'Secondary preferred',
  nearest: 'Nearest',
};

/** MongoDB's options: default database, read preference, direct connection. */
export function MongoOptions(props: { readonly form: ConnectionForm }) {
  const { register, control, formState } = props.form;
  const errors = formState.errors;
  const kind = useWatch({ control, name: 'endpointKind' });
  if (kind === 'uri') {
    return <Note>The connection URI holds the default database and read preference.</Note>;
  }
  return (
    <>
      <Field
        label="Default database"
        htmlFor="cx-database"
        hint="Optional"
        error={errors.database?.message}
      >
        <Input id="cx-database" {...register('database')} aria-invalid={!!errors.database} />
      </Field>
      <Field label="Read preference" htmlFor="cx-read-preference">
        <Select id="cx-read-preference" {...register('readPreference')}>
          <option value="">Driver default (primary)</option>
          {READ_PREFERENCES.map((mode) => (
            <option key={mode} value={mode}>
              {READ_PREFERENCE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'host' && (
        <div className="col-span-2 flex flex-col gap-0.5 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" {...register('directConnection')} />
            Direct connection
          </label>
          <p className="ml-5 text-xs text-muted">
            Talk to this host only instead of discovering the replica set from it: for a secondary,
            or a member known by an address the others do not use.
          </p>
        </div>
      )}
    </>
  );
}

/** MongoDB's sign-ins: none, user and password (SCRAM or LDAP), an X.509 certificate. */
export function MongoFields(props: SectionProps) {
  const { register, control, formState } = props.form;
  const errors = formState.errors;
  const [kind, authMethod, mechanism] = useWatch({
    control,
    name: ['endpointKind', 'authMethod', 'mechanism'],
  });
  const known = (MONGO_MECHANISMS as readonly string[]).includes(mechanism);
  return (
    <>
      <Field label="Authentication" htmlFor="cx-auth-method" error={errors.authMethod?.message}>
        <Select id="cx-auth-method" {...register('authMethod')}>
          {ENGINE_AUTH_METHODS.mongodb.map((method) => (
            <option key={method} value={method}>
              {MONGO_AUTH_LABELS[method]}
            </option>
          ))}
        </Select>
      </Field>
      {authMethod === 'password' ? (
        <Field label="Mechanism" htmlFor="cx-mechanism">
          <Select id="cx-mechanism" {...register('mechanism')} value={mechanism}>
            {MONGO_MECHANISMS.map((value) => (
              <option key={value} value={value}>
                {MECHANISM_LABELS[value]}
              </option>
            ))}
            {!known && <option value={mechanism}>{mechanism}</option>}
          </Select>
        </Field>
      ) : (
        <div />
      )}

      {authMethod === 'password' && (
        <>
          <Field label="User" htmlFor="cx-user" error={errors.user?.message}>
            <Input
              id="cx-user"
              autoComplete="off"
              {...register('user')}
              aria-invalid={!!errors.user}
            />
          </Field>
          {kind === 'uri' ? (
            <div />
          ) : showsAuthSource({ engine: 'mongodb', endpointKind: kind, authMethod, mechanism }) ? (
            <Field
              key="auth-source"
              label="Authentication database"
              htmlFor="cx-auth-source"
              hint="Where the user is defined; empty uses admin"
              error={errors.authSource?.message}
            >
              <Input
                id="cx-auth-source"
                placeholder="admin"
                {...register('authSource')}
                aria-invalid={!!errors.authSource}
              />
            </Field>
          ) : (
            <Field
              key="auth-source-external"
              label="Authentication database"
              htmlFor="cx-auth-source"
              hint="LDAP users are always in $external"
            >
              <Input id="cx-auth-source" value={EXTERNAL_AUTH_SOURCE} disabled readOnly />
            </Field>
          )}
          <PasswordFields {...props} />
        </>
      )}
      {authMethod === 'clientCertificate' && (
        <>
          <Field
            label="User"
            htmlFor="cx-user"
            hint="Optional: the certificate's subject, e.g. CN=app,OU=clients"
          >
            <Input id="cx-user" autoComplete="off" {...register('user')} />
          </Field>
          <div />
          <Note>
            Signs in (in $external) with the client certificate and key chosen on the TLS tab; TLS
            must be on. One PEM file holding both can be chosen for each.
          </Note>
        </>
      )}
    </>
  );
}

/** Redis's options: the logical database and the key browser's delimiter. */
export function RedisOptions(props: { readonly form: ConnectionForm }) {
  const { register, control, formState } = props.form;
  const errors = formState.errors;
  const kind = useWatch({ control, name: 'endpointKind' });
  return (
    <>
      {showsDatabase({ engine: 'redis', endpointKind: kind }) ? (
        <Field
          label="Database number"
          htmlFor="cx-database"
          hint="Optional: 0 to 15 on a default server"
          error={errors.database?.message}
        >
          <Input
            id="cx-database"
            inputMode="numeric"
            placeholder="0"
            {...register('database')}
            aria-invalid={!!errors.database}
          />
        </Field>
      ) : (
        <div />
      )}
      <Field
        label="Key delimiter"
        htmlFor="cx-key-delimiter"
        hint="Splits key names into the key browser's tree; empty uses :"
        error={errors.keyDelimiter?.message}
      >
        <Input
          id="cx-key-delimiter"
          placeholder=":"
          {...register('keyDelimiter')}
          aria-invalid={!!errors.keyDelimiter}
        />
      </Field>
    </>
  );
}

/** Redis: no sign-in, or a password with an optional ACL user. */
export function RedisFields(props: SectionProps) {
  const { register, control, formState } = props.form;
  const errors = formState.errors;
  const authMethod = useWatch({ control, name: 'authMethod' });
  return (
    <>
      <Field label="Authentication" htmlFor="cx-auth-method" error={errors.authMethod?.message}>
        <Select id="cx-auth-method" {...register('authMethod')}>
          <option value="none">None</option>
          <option value="password">Password (optional ACL user)</option>
        </Select>
      </Field>
      {authMethod === 'password' ? (
        <>
          <Field label="User" htmlFor="cx-user" hint="Optional ACL user; empty signs in as default">
            <Input id="cx-user" autoComplete="off" {...register('user')} />
          </Field>
          <PasswordFields {...props} />
        </>
      ) : (
        <div />
      )}
    </>
  );
}

const SEARCH_AUTH_LABELS: Readonly<Partial<Record<FormAuthMethod, string>>> = {
  none: 'None',
  password: 'User and password (basic)',
  apiKey: 'API key',
  bearer: 'Bearer token',
};

/**
 * Elasticsearch (spec §4, §11): no sign-in, basic authentication, an API key or a bearer token,
 * each secret kept like a password.
 */
export function SearchFields(props: SectionProps) {
  const { register, control, formState } = props.form;
  const errors = formState.errors;
  const authMethod = useWatch({ control, name: 'authMethod' });
  return (
    <>
      <Field label="Authentication" htmlFor="cx-auth-method" error={errors.authMethod?.message}>
        <Select id="cx-auth-method" {...register('authMethod')}>
          {ENGINE_AUTH_METHODS.elasticsearch.map((method) => (
            <option key={method} value={method}>
              {SEARCH_AUTH_LABELS[method]}
            </option>
          ))}
        </Select>
      </Field>
      {authMethod === 'password' ? (
        <>
          <Field label="User" htmlFor="cx-user" error={errors.user?.message}>
            <Input
              id="cx-user"
              autoComplete="off"
              placeholder="elastic"
              {...register('user')}
              aria-invalid={!!errors.user}
            />
          </Field>
          <PasswordFields {...props} />
        </>
      ) : authMethod === 'apiKey' ? (
        <>
          <div />
          <PasswordFields {...props} secretLabel="API key" required />
          <Note>
            The encoded key Elasticsearch shows when it creates one, or its id and key as
            id:api_key.
          </Note>
        </>
      ) : authMethod === 'bearer' ? (
        <>
          <div />
          <PasswordFields {...props} secretLabel="Token" required />
          <Note>Sent as Authorization: Bearer, e.g. an OAuth2 or JWT access token.</Note>
        </>
      ) : (
        <div />
      )}
    </>
  );
}
