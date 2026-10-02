import type { PrivateKeyInfo } from '@joinery/ipc';
import { useWatch } from 'react-hook-form';

import { mainApi } from '../../lib/main-client';
import { MAX_SSH_HOPS } from '../../state/connection-form';
import { Button, Field, Icon, Input, Select } from '../ui';
import { SecretModeSelect, type ConnectionForm } from './fields';

/** The connection dialog's network sections (spec §4): an SSH tunnel with jump hosts, a proxy. */

export type KeyState =
  | { readonly status: 'checking' }
  | { readonly status: 'ok'; readonly info: PrivateKeyInfo }
  | { readonly status: 'error'; readonly message: string };

const KEY_FORMATS: Readonly<Record<PrivateKeyInfo['format'], string>> = {
  openssh: 'OpenSSH',
  pem: 'PEM',
  pkcs8: 'PKCS#8',
  ppk: 'PuTTY',
};

/** The SSH tunnel: jump hosts in connection order, then the server that reaches the database. */
export function SshSection(props: {
  readonly form: ConnectionForm;
  readonly hops: readonly { readonly id: string }[];
  readonly keyStates: Readonly<Record<string, KeyState>>;
  readonly canSave: boolean;
  /** An existing profile: empty secret fields keep the stored values. */
  readonly editing: boolean;
  readonly onInspect: (index: number, withPassphrase: boolean) => void;
  readonly onAddJumpHost: () => void;
  readonly onRemove: (index: number) => void;
  /** What the engine's endpoint forms allow through a tunnel, shown while one is on. */
  readonly note?: string | undefined;
}) {
  const { form, hops } = props;
  const { register, control, formState } = form;
  const enabled = useWatch({ control, name: 'sshEnabled' });
  const errors = formState.errors;
  return (
    <fieldset className="col-span-2 flex flex-col gap-3" aria-label="SSH tunnel">
      <label className="flex items-center gap-2 text-[13px] font-medium">
        <input type="checkbox" {...register('sshEnabled')} />
        Connect through an SSH tunnel
      </label>
      {enabled && (
        <>
          {props.note !== undefined && <p className="text-xs text-muted">{props.note}</p>}
          {hops.length > 1 && (
            <p className="text-xs text-muted">
              Joinery connects to the jump hosts in order, then to the SSH server, which forwards to
              the database. The database host and port are as the SSH server sees them.
            </p>
          )}
          {hops.map((hop, index) => (
            <SshHopFields
              key={hop.id}
              form={form}
              index={index}
              title={
                index === hops.length - 1
                  ? 'SSH server'
                  : `Jump host ${hops.length > 2 ? index + 1 : ''}`.trim()
              }
              removable={hops.length > 1}
              keyState={props.keyStates[hop.id]}
              canSave={props.canSave}
              editing={props.editing}
              onInspect={(withPassphrase) => props.onInspect(index, withPassphrase)}
              onRemove={() => props.onRemove(index)}
            />
          ))}
          <div className="flex items-end gap-3">
            <Button size="sm" onClick={props.onAddJumpHost} disabled={hops.length >= MAX_SSH_HOPS}>
              <Icon name="plus" className="h-3.5 w-3.5" />
              Add jump host
            </Button>
            <span className="flex-1" />
            <Field
              label="Keep-alive (seconds)"
              htmlFor="cx-ssh-keepalive"
              error={errors.sshKeepAlive?.message}
              className="w-40"
            >
              <Input
                id="cx-ssh-keepalive"
                inputMode="numeric"
                {...register('sshKeepAlive')}
                aria-invalid={!!errors.sshKeepAlive}
              />
            </Field>
          </div>
        </>
      )}
    </fieldset>
  );
}

function SshHopFields(props: {
  readonly form: ConnectionForm;
  readonly index: number;
  readonly title: string;
  readonly removable: boolean;
  readonly keyState: KeyState | undefined;
  readonly canSave: boolean;
  readonly editing: boolean;
  readonly onInspect: (withPassphrase: boolean) => void;
  readonly onRemove: () => void;
}) {
  const { form, index, keyState } = props;
  const { register, control, setValue, formState } = form;
  const hop = useWatch({ control, name: `sshHops.${index}` });
  const errors = formState.errors.sshHops?.[index];
  const id = (field: string): string => `cx-ssh-${index}-${field}`;
  const keyPath = register(`sshHops.${index}.keyPath`);

  const browse = async (): Promise<void> => {
    const { path } = await mainApi().dialogs.openFile({
      title: 'SSH private key',
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'PuTTY keys', extensions: ['ppk'] },
        { name: 'PEM keys', extensions: ['pem', 'key'] },
      ],
    });
    if (path === null) return;
    setValue(`sshHops.${index}.keyPath`, path, { shouldDirty: true, shouldValidate: true });
    props.onInspect(false);
  };

  const info = keyState?.status === 'ok' ? keyState.info : undefined;
  const encrypted = info?.encrypted ?? hop.passphraseMode !== 'none';

  return (
    <div
      role="group"
      aria-label={props.title}
      className="grid grid-cols-6 gap-x-3 gap-y-2 rounded border border-border bg-panel-2/40 p-2"
    >
      <div className="col-span-6 flex items-center gap-2">
        <span className="text-xs font-semibold text-muted uppercase">{props.title}</span>
        <span className="flex-1" />
        {props.removable && (
          <Button size="sm" variant="ghost" onClick={props.onRemove}>
            Remove
          </Button>
        )}
      </div>
      <Field
        label="SSH host"
        htmlFor={id('host')}
        error={errors?.host?.message}
        className="col-span-3"
      >
        <Input
          id={id('host')}
          placeholder="bastion.example.com"
          {...register(`sshHops.${index}.host`)}
          aria-invalid={!!errors?.host}
        />
      </Field>
      <Field label="SSH port" htmlFor={id('port')} error={errors?.port?.message}>
        <Input
          id={id('port')}
          inputMode="numeric"
          {...register(`sshHops.${index}.port`)}
          aria-invalid={!!errors?.port}
        />
      </Field>
      <Field
        label="SSH user"
        htmlFor={id('user')}
        error={errors?.user?.message}
        className="col-span-2"
      >
        <Input
          id={id('user')}
          autoComplete="off"
          {...register(`sshHops.${index}.user`)}
          aria-invalid={!!errors?.user}
        />
      </Field>
      <Field label="SSH authentication" htmlFor={id('auth')} className="col-span-2">
        <Select id={id('auth')} {...register(`sshHops.${index}.authMethod`)}>
          <option value="password">Password</option>
          <option value="privateKey">Private key</option>
          <option value="agent">SSH agent</option>
        </Select>
      </Field>
      {hop.authMethod === 'password' && (
        <>
          <Field
            label="SSH password"
            htmlFor={id('password')}
            className="col-span-2"
            hint={
              props.editing && hop.passwordMode !== 'ask'
                ? 'Leave empty to keep the stored password'
                : undefined
            }
          >
            <Input
              id={id('password')}
              type="password"
              autoComplete="new-password"
              {...register(`sshHops.${index}.password`)}
            />
          </Field>
          <Field label="SSH password storage" htmlFor={id('password-mode')} className="col-span-2">
            <SecretModeSelect
              id={id('password-mode')}
              canSave={props.canSave}
              optional={false}
              {...register(`sshHops.${index}.passwordMode`)}
            />
          </Field>
        </>
      )}
      {hop.authMethod === 'agent' && (
        <p className="col-span-4 self-end pb-2 text-xs text-muted">
          Uses the keys of the running ssh-agent (SSH_AUTH_SOCK), or Pageant on Windows.
        </p>
      )}
      {hop.authMethod === 'privateKey' && (
        <>
          <Field
            label="Private key"
            htmlFor={id('key')}
            error={errors?.keyPath?.message}
            className="col-span-4"
          >
            <div className="flex gap-1">
              <Input
                id={id('key')}
                placeholder="~/.ssh/id_ed25519"
                {...keyPath}
                onBlur={(event) => {
                  void keyPath.onBlur(event);
                  props.onInspect(false);
                }}
                aria-invalid={!!errors?.keyPath}
              />
              <Button onClick={() => void browse()} aria-label="Browse for the private key">
                Browse…
              </Button>
            </div>
          </Field>
          <div className="col-span-6 -mt-1 text-xs" data-testid={`ssh-key-${index}`}>
            {keyState?.status === 'checking' && (
              <span className="text-muted">Checking the key…</span>
            )}
            {keyState?.status === 'error' && (
              <span role="alert" className="text-danger">
                {keyState.message}
              </span>
            )}
            {info && (
              <span className="text-muted">
                {KEY_FORMATS[info.format]} key
                {info.keyType ? ` · ${info.keyType}` : ''}
                {info.fingerprintSha256 ? (
                  <>
                    {' · '}
                    <code className="font-mono">{info.fingerprintSha256}</code>
                  </>
                ) : null}
                {info.encrypted ? ' · protected by a passphrase' : ''}
                {info.converted
                  ? ` · converted from PuTTY format and saved as ${info.keyPath}`
                  : ''}
              </span>
            )}
          </div>
          {encrypted && (
            <>
              <Field
                label="Key passphrase"
                htmlFor={id('passphrase')}
                className="col-span-3"
                hint={
                  props.editing && hop.passphraseMode !== 'ask' && hop.passphrase === ''
                    ? 'Leave empty to keep the stored passphrase'
                    : info?.locked
                      ? 'Enter the passphrase and check it'
                      : undefined
                }
              >
                <div className="flex gap-1">
                  <Input
                    id={id('passphrase')}
                    type="password"
                    autoComplete="new-password"
                    {...register(`sshHops.${index}.passphrase`)}
                  />
                  <Button onClick={() => props.onInspect(true)} disabled={hop.passphrase === ''}>
                    Check
                  </Button>
                </div>
              </Field>
              <Field
                label="Passphrase storage"
                htmlFor={id('passphrase-mode')}
                className="col-span-3"
              >
                <SecretModeSelect
                  id={id('passphrase-mode')}
                  canSave={props.canSave}
                  optional={false}
                  {...register(`sshHops.${index}.passphraseMode`)}
                />
              </Field>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** HTTP CONNECT or SOCKS5 proxy in front of the database (or of the first SSH hop). */
export function ProxySection(props: {
  readonly form: ConnectionForm;
  readonly canSave: boolean;
  readonly editing: boolean;
  /** What the engine's endpoint forms allow through a proxy, shown while one is chosen. */
  readonly note?: string | undefined;
}) {
  const { register, control, formState } = props.form;
  const kind = useWatch({ control, name: 'proxyKind' });
  const mode = useWatch({ control, name: 'proxyPasswordMode' });
  const errors = formState.errors;
  return (
    <fieldset
      className="col-span-2 grid grid-cols-[1fr_90px_1fr] gap-x-3 gap-y-2"
      aria-label="Proxy settings"
    >
      <Field label="Proxy type" htmlFor="cx-proxy-kind" className="col-span-3">
        <Select id="cx-proxy-kind" {...register('proxyKind')}>
          <option value="none">No proxy</option>
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP (CONNECT)</option>
        </Select>
      </Field>
      {kind !== undefined && kind !== 'none' && (
        <>
          {props.note !== undefined && (
            <p className="col-span-3 text-xs text-muted">{props.note}</p>
          )}
          <Field label="Proxy host" htmlFor="cx-proxy-host" error={errors.proxyHost?.message}>
            <Input
              id="cx-proxy-host"
              {...register('proxyHost')}
              aria-invalid={!!errors.proxyHost}
            />
          </Field>
          <Field label="Proxy port" htmlFor="cx-proxy-port" error={errors.proxyPort?.message}>
            <Input
              id="cx-proxy-port"
              inputMode="numeric"
              {...register('proxyPort')}
              aria-invalid={!!errors.proxyPort}
            />
          </Field>
          <Field label="Proxy user" htmlFor="cx-proxy-user" hint="Optional">
            <Input id="cx-proxy-user" autoComplete="off" {...register('proxyUser')} />
          </Field>
          <Field
            label="Proxy password"
            htmlFor="cx-proxy-password"
            hint={
              props.editing && mode !== 'none' && mode !== 'ask'
                ? 'Leave empty to keep the stored password'
                : undefined
            }
          >
            <Input
              id="cx-proxy-password"
              type="password"
              autoComplete="new-password"
              disabled={mode === 'none'}
              {...register('proxyPassword')}
            />
          </Field>
          <div />
          <Field label="Proxy password storage" htmlFor="cx-proxy-password-mode">
            <SecretModeSelect
              id="cx-proxy-password-mode"
              canSave={props.canSave}
              optional
              {...register('proxyPasswordMode')}
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}
