import { zodResolver } from '@hookform/resolvers/zod';
import {
  ENGINES,
  hasWeakTls,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type ConnectionProfile,
} from '@joinery/core';
import type { PrivateKeyInfo, StoredProfile } from '@joinery/ipc';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useFieldArray, useForm, useWatch, type UseFormReturn } from 'react-hook-form';

import { errorInfo, errorMessage } from '../lib/errors';
import { formatDuration } from '../lib/format';
import { mainApi } from '../lib/main-client';
import {
  COMING_SOON_ENGINES,
  DIALOG_ENGINES,
  MAX_SSH_HOPS,
  connectionFormSchema,
  defaultFormValues,
  defaultSshHop,
  formToProfile,
  passwordFromUri,
  profileToForm,
  typedSecrets,
  type ConnectionFormValues,
} from '../state/connection-form';
import { keys, useCanSaveSecrets, useFolders } from '../state/data';
import { Button, Field, Icon, Input, Modal, Select, cx } from './ui';

/**
 * Create, edit or duplicate a connection (spec §4): endpoint, credentials with their storage
 * policy, TLS, an SSH tunnel (with jump hosts) and a proxy, and presentation (environment,
 * read-only, confirm writes, colour, folder). Test Connection runs the stepwise check in a
 * short-lived connection host and shows each step. Every secret typed here goes to main with its
 * policy and never comes back; private key files are read and checked by main.
 */

export type ConnectionDialogMode =
  | { readonly kind: 'create'; readonly folderId?: string }
  | { readonly kind: 'edit'; readonly profile: StoredProfile }
  | { readonly kind: 'duplicate'; readonly profile: StoredProfile };

const STEP_LABELS: Readonly<Record<ConnectionCheckStep, string>> = {
  dns: 'DNS lookup',
  tcp: 'TCP connect',
  ssh: 'SSH tunnel',
  tls: 'TLS handshake',
  auth: 'Authentication',
  ping: 'Ping',
  version: 'Server version',
};

function initialValues(mode: ConnectionDialogMode): ConnectionFormValues {
  if (mode.kind === 'create') {
    return { ...defaultFormValues(), folderId: mode.folderId ?? '' };
  }
  const values = profileToForm(mode.profile);
  return mode.kind === 'duplicate' ? { ...values, name: `${values.name} (copy)` } : values;
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function ConnectionDialog(props: {
  readonly mode: ConnectionDialogMode;
  readonly onClose: () => void;
}) {
  const { mode, onClose } = props;
  const queryClient = useQueryClient();
  const folders = useFolders();
  const canSave = useCanSaveSecrets().data ?? true;
  const editing = mode.kind === 'edit' ? mode.profile : undefined;
  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: initialValues(mode),
    mode: 'onTouched',
  });
  const { register, handleSubmit, setValue, getValues, control, formState } = form;
  const errors = formState.errors;
  const values = useWatch({ control });
  const [uri, setUri] = useState('');
  const [uriNote, setUriNote] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [checks, setChecks] = useState<ConnectionCheckResult[]>([]);
  const [checkState, setCheckState] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle');
  const [checkError, setCheckError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const checkAbort = useRef<AbortController | undefined>(undefined);
  const checkSection = useRef<HTMLElement>(null);
  const previousEngine = useRef(values.engine ?? 'postgres');

  useEffect(() => () => checkAbort.current?.abort(), []);

  // Bring the step list into view as the test runs (the form is taller than the dialog).
  useEffect(() => {
    if (checkState !== 'idle') checkSection.current?.scrollIntoView({ block: 'nearest' });
  }, [checkState, checks.length]);

  // Switching engines moves the port along when it still holds the old engine's default.
  useEffect(() => {
    const engine = values.engine;
    if (engine === undefined || engine === previousEngine.current) return;
    const oldDefault = String(ENGINES[previousEngine.current].defaultPort);
    if (getValues('port') === oldDefault) setValue('port', String(ENGINES[engine].defaultPort));
    previousEngine.current = engine;
  }, [values.engine, getValues, setValue]);

  const {
    fields: hops,
    insert: insertHop,
    remove: removeHop,
  } = useFieldArray({
    control,
    name: 'sshHops',
  });
  const [keyStates, setKeyStates] = useState<Readonly<Record<string, KeyState>>>({});

  /** Reads the hop's key file in main: type, fingerprint, passphrase needed, PPK conversion. */
  const inspectKey = async (index: number, withPassphrase: boolean): Promise<void> => {
    const fieldId = hops[index]?.id;
    const hop = getValues(`sshHops.${index}`);
    if (fieldId === undefined || !hop || hop.authMethod !== 'privateKey' || hop.keyPath === '') {
      return;
    }
    setKeyStates((current) => ({ ...current, [fieldId]: { status: 'checking' } }));
    try {
      const info = await mainApi().ssh.inspectKey({
        path: hop.keyPath,
        ...(withPassphrase && hop.passphrase !== '' ? { passphrase: hop.passphrase } : {}),
      });
      if (info.keyPath !== hop.keyPath) {
        setValue(`sshHops.${index}.keyPath`, info.keyPath, { shouldDirty: true });
      }
      if (info.encrypted && hop.passphraseMode === 'none') {
        setValue(`sshHops.${index}.passphraseMode`, canSave ? 'save' : 'session');
      } else if (!info.encrypted && hop.passphraseMode !== 'none') {
        setValue(`sshHops.${index}.passphraseMode`, 'none');
      }
      setKeyStates((current) => ({ ...current, [fieldId]: { status: 'ok', info } }));
    } catch (error) {
      setKeyStates((current) => ({
        ...current,
        [fieldId]: { status: 'error', message: errorMessage(error) },
      }));
    }
  };

  // Show the type and fingerprint of the keys an edited profile already uses.
  const inspectedOnOpen = useRef(false);
  useEffect(() => {
    if (inspectedOnOpen.current) return;
    inspectedOnOpen.current = true;
    getValues('sshHops').forEach((hop, index) => {
      if (getValues('sshEnabled') && hop.authMethod === 'privateKey' && hop.keyPath !== '') {
        void inspectKey(index, false);
      }
    });
  });

  const draftProfile = (): ConnectionProfile | undefined => {
    const parsed = connectionFormSchema.safeParse(getValues());
    if (!parsed.success) return undefined;
    const { profile } = formToProfile(parsed.data, editing);
    return profile as ConnectionProfile;
  };

  const fillFromUri = async (): Promise<void> => {
    setUriNote(undefined);
    const text = uri.trim();
    if (text === '') return;
    try {
      const engine =
        getValues().engine === 'mariadb' && /^mysql:/i.test(text)
          ? ('mariadb' as const)
          : undefined;
      const parsed = await mainApi().profiles.parseUri({
        uri: text,
        ...(engine ? { engine } : {}),
      });
      // Read the fields to keep only now: the user may have typed a name while main parsed.
      const current = getValues();
      const next = profileToForm(parsed.profile);
      const password = parsed.passwordFound ? passwordFromUri(text) : undefined;
      form.reset({
        ...next,
        name: current.name === '' ? next.name : current.name,
        environment: current.environment,
        readOnly: current.readOnly,
        confirmWrites: current.confirmWrites,
        color: current.color,
        folderId: current.folderId,
        password: password ?? '',
        passwordMode: password === undefined ? current.passwordMode : canSave ? 'save' : 'session',
      });
      previousEngine.current = next.engine;
      setUriNote({
        kind: 'ok',
        text:
          parsed.ignoredParams.length > 0
            ? `Filled from the URI. Ignored: ${parsed.ignoredParams.join(', ')}`
            : 'Filled from the URI',
      });
    } catch (error) {
      setUriNote({ kind: 'error', text: errorMessage(error) });
    }
  };

  const testConnection = async (): Promise<void> => {
    const valid = await form.trigger();
    if (!valid) return;
    const current = getValues();
    const { profile, secrets: secretFields } = formToProfile(current, editing);
    checkAbort.current?.abort();
    const controller = new AbortController();
    checkAbort.current = controller;
    setChecks([]);
    setCheckError(undefined);
    setCheckState('running');
    let failed = false;
    try {
      const secrets = typedSecrets(secretFields);
      for await (const step of mainApi().testConnection(
        { profile, ...(secrets ? { secrets } : {}) },
        { signal: controller.signal },
      )) {
        if (step.status === 'failed') failed = true;
        setChecks((previous) => [...previous, step]);
      }
      setCheckState(failed ? 'failed' : 'ok');
    } catch (error) {
      if (errorInfo(error).code === 'CANCELLED') return;
      setCheckError(errorMessage(error));
      setCheckState('failed');
    }
  };

  const save = handleSubmit(async (form) => {
    setSaveError(undefined);
    const { profile, secrets } = formToProfile(form, editing);
    if (!canSave && secrets.some((field) => field.ref.policy === 'save' && field.value !== '')) {
      setSaveError(
        'This system has no secure storage for passwords. Choose "Remember for this session" or "Ask every time".',
      );
      return;
    }
    setSaving(true);
    try {
      const saved = await mainApi().profiles.save({
        profile,
        ...(editing ? { expectedVersion: editing.version } : {}),
      });
      for (const { ref, value, previousPolicy } of secrets) {
        if (value !== '' && ref.policy !== 'ask') {
          await mainApi().secrets.set({ profileId: saved.id, refId: ref.id, value });
        } else if (ref.policy === 'ask' || previousPolicy !== ref.policy) {
          await mainApi().secrets.clear({ profileId: saved.id, refId: ref.id });
        }
      }
      await queryClient.invalidateQueries({ queryKey: keys.profiles });
      onClose();
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  });

  const weakTls = values.tlsMode !== undefined && values.tlsMode !== 'verify-full';
  const localWithStrictTls =
    !weakTls && values.endpointKind === 'host' && isLocalHost(values.host ?? '');
  const tlsStepFailed = checks.some((step) => step.step === 'tls' && step.status === 'failed');
  const proxyOnly =
    !values.sshEnabled && values.proxyKind !== undefined && values.proxyKind !== 'none';
  const production = values.environment === 'production';
  const title =
    mode.kind === 'edit'
      ? `Edit ${mode.profile.name}`
      : mode.kind === 'duplicate'
        ? 'Duplicate connection'
        : 'New connection';

  const draft = weakTls ? draftProfile() : undefined;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      width="w-[720px]"
      footer={
        <>
          <Button
            onClick={() => void testConnection()}
            disabled={checkState === 'running'}
            className="mr-auto"
          >
            {checkState === 'running' ? 'Testing…' : 'Test Connection'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-x-4 gap-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        aria-label="Connection settings"
      >
        <Field label="Name" htmlFor="cx-name" error={errors.name?.message} className="col-span-2">
          <Input id="cx-name" autoFocus {...register('name')} aria-invalid={!!errors.name} />
        </Field>

        <Field label="Database engine" htmlFor="cx-engine">
          <Select id="cx-engine" {...register('engine')}>
            {DIALOG_ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINES[engine].displayName}
              </option>
            ))}
            {COMING_SOON_ENGINES.map((engine) => (
              <option key={engine} value={engine} disabled>
                {ENGINES[engine].displayName} (coming soon)
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Connect with" htmlFor="cx-endpoint">
          <Select id="cx-endpoint" {...register('endpointKind')}>
            <option value="host">Host and port</option>
            <option value="socket">Unix socket</option>
            <option value="uri">Connection URI</option>
          </Select>
        </Field>

        <div className="col-span-2 flex items-end gap-2 rounded border border-dashed border-border p-2">
          <Field label="Paste a URI to fill the form" htmlFor="cx-paste-uri" className="flex-1">
            <Input
              id="cx-paste-uri"
              value={uri}
              placeholder="postgresql://user:password@host:5432/database?sslmode=require"
              onChange={(event) => setUri(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void fillFromUri();
                }
              }}
            />
          </Field>
          <Button onClick={() => void fillFromUri()} disabled={uri.trim() === ''}>
            Fill from URI
          </Button>
        </div>
        {uriNote && (
          <p
            role="status"
            className={cx(
              'col-span-2 -mt-2 text-xs',
              uriNote.kind === 'error' ? 'text-danger' : 'text-success',
            )}
          >
            {uriNote.text}
          </p>
        )}

        {values.endpointKind === 'host' && (
          <>
            <Field label="Host" htmlFor="cx-host" error={errors.host?.message}>
              <Input id="cx-host" {...register('host')} aria-invalid={!!errors.host} />
            </Field>
            <Field label="Port" htmlFor="cx-port" error={errors.port?.message}>
              <Input
                id="cx-port"
                inputMode="numeric"
                {...register('port')}
                aria-invalid={!!errors.port}
              />
            </Field>
          </>
        )}
        {values.endpointKind === 'socket' && (
          <Field
            label="Socket path"
            htmlFor="cx-socket"
            error={errors.socketPath?.message}
            className="col-span-2"
          >
            <Input id="cx-socket" placeholder="/var/run/postgresql" {...register('socketPath')} />
          </Field>
        )}
        {values.endpointKind === 'uri' && (
          <Field
            label="URI (without the password)"
            htmlFor="cx-uri"
            error={errors.uri?.message}
            className="col-span-2"
          >
            <Input id="cx-uri" {...register('uri')} aria-invalid={!!errors.uri} />
          </Field>
        )}

        {values.endpointKind !== 'uri' && (
          <Field label="Database" htmlFor="cx-database" hint="Optional">
            <Input id="cx-database" {...register('database')} />
          </Field>
        )}
        <Field label="User" htmlFor="cx-user">
          <Input id="cx-user" autoComplete="off" {...register('user')} />
        </Field>

        <Field
          label="Password"
          htmlFor="cx-password"
          hint={
            editing && values.passwordMode !== 'none' && values.passwordMode !== 'ask'
              ? 'Leave empty to keep the stored password'
              : undefined
          }
        >
          <Input
            id="cx-password"
            type="password"
            autoComplete="new-password"
            disabled={values.passwordMode === 'none'}
            {...register('password')}
          />
        </Field>
        <Field
          label="Password storage"
          htmlFor="cx-password-mode"
          hint={canSave ? undefined : 'No keychain or secret service is available on this system'}
        >
          <Select id="cx-password-mode" {...register('passwordMode')}>
            <option value="save" disabled={!canSave}>
              Save in the OS keychain
            </option>
            <option value="session">Remember for this session</option>
            <option value="ask">Ask every time</option>
            <option value="none">No password</option>
          </Select>
        </Field>

        <Field label="TLS" htmlFor="cx-tls">
          <Select id="cx-tls" {...register('tlsMode')}>
            <option value="verify-full">Verify certificate and host name (recommended)</option>
            <option value="verify-ca">Verify certificate only</option>
            <option value="require">Require TLS, no verification</option>
            <option value="disable">Disable TLS</option>
          </Select>
        </Field>
        <div />
        {values.tlsMode !== 'disable' && (
          <>
            <PathField id="cx-ca" label="CA certificate" field="caPath" form={form} />
            <PathField id="cx-cert" label="Client certificate" field="certPath" form={form} />
            <PathField id="cx-key" label="Client key" field="keyPath" form={form} />
          </>
        )}
        {weakTls && (
          <div
            role="alert"
            className="col-span-2 flex items-start gap-2 rounded border border-warning/50 bg-warning/10 p-2 text-xs text-warning"
          >
            <Icon name="warning" />
            <span>
              {values.tlsMode === 'disable'
                ? 'TLS is disabled: the password and all data travel unencrypted.'
                : 'The server certificate is not fully verified, so the connection can be intercepted.'}
              {draft && hasWeakTls(draft) ? ' This warning stays on the connection.' : ''}
            </span>
          </div>
        )}
        {localWithStrictTls && (
          <p className="col-span-2 -mt-1 text-xs text-muted">
            Local development servers often run without TLS. If Test Connection fails at the TLS
            step, choose “Disable TLS”.
          </p>
        )}

        <SshSection
          form={form}
          hops={hops}
          keyStates={keyStates}
          canSave={canSave}
          editing={editing !== undefined}
          onInspect={(index, withPassphrase) => void inspectKey(index, withPassphrase)}
          onAddJumpHost={() => insertHop(Math.max(hops.length - 1, 0), defaultSshHop())}
          onRemove={(index) => removeHop(index)}
        />
        <ProxySection form={form} canSave={canSave} editing={editing !== undefined} />

        <Field label="Environment" htmlFor="cx-env">
          <Select id="cx-env" {...register('environment')}>
            <option value="dev">Development</option>
            <option value="test">Test</option>
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </Select>
        </Field>
        <Field label="Folder" htmlFor="cx-folder">
          <Select id="cx-folder" {...register('folderId')}>
            <option value="">(none)</option>
            {(folders.data ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Colour" htmlFor="cx-color" error={errors.color?.message}>
          <div className="flex items-center gap-2">
            <input
              id="cx-color"
              type="color"
              className="h-8 w-12 cursor-pointer rounded border border-border bg-panel-2"
              value={values.color === '' || values.color === undefined ? '#4f8cff' : values.color}
              onChange={(event) => setValue('color', event.target.value, { shouldDirty: true })}
            />
            {values.color !== '' && (
              <Button size="sm" variant="ghost" onClick={() => setValue('color', '')}>
                Clear
              </Button>
            )}
          </div>
        </Field>
        <div className="flex flex-col justify-end gap-1.5 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" {...register('readOnly')} />
            Read-only (refuse every write)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              {...register('confirmWrites')}
              disabled={production}
              checked={production ? true : values.confirmWrites === true}
            />
            Confirm every write{production ? ' (always on for production)' : ''}
          </label>
        </div>
      </form>

      {(checkState !== 'idle' || checks.length > 0) && (
        <section
          ref={checkSection}
          aria-label="Connection test"
          className="mt-4 rounded border border-border bg-panel-2 p-3"
        >
          <h3 className="mb-2 text-xs font-semibold text-muted uppercase">Test Connection</h3>
          <ol className="flex flex-col gap-1.5" aria-live="polite">
            {checks.map((step) => (
              <li key={step.step} className="text-[13px]" data-testid={`check-${step.step}`}>
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cx(
                      'w-4 text-center font-bold',
                      step.status === 'ok' && 'text-success',
                      step.status === 'failed' && 'text-danger',
                      step.status === 'skipped' && 'text-muted',
                    )}
                  >
                    {step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '–'}
                  </span>
                  <span className="font-medium">
                    {step.step === 'ssh' && proxyOnly ? 'Proxy' : STEP_LABELS[step.step]}
                  </span>
                  <span className="text-xs text-muted">
                    {step.status === 'skipped' ? 'skipped' : formatDuration(step.durationMs)}
                  </span>
                  {step.message && (
                    <span className="truncate text-xs text-muted">{step.message}</span>
                  )}
                </div>
                {step.hint && step.status === 'failed' && (
                  <p className="mt-0.5 ml-6 text-xs text-warning">{step.hint}</p>
                )}
              </li>
            ))}
          </ol>
          {checkState === 'running' && <p className="mt-2 text-xs text-muted">Testing…</p>}
          {checkState === 'ok' && (
            <p role="status" className="mt-2 text-[13px] font-medium text-success">
              Connection succeeded
            </p>
          )}
          {checkState === 'failed' && (
            <p role="alert" className="mt-2 text-[13px] font-medium text-danger">
              {checkError ?? 'Connection failed'}
            </p>
          )}
          {tlsStepFailed && values.tlsMode !== 'disable' && (
            <p className="mt-1 text-xs text-warning">
              The TLS handshake failed. If the server has no TLS (common for local servers), set TLS
              to “Disable TLS”.
            </p>
          )}
        </section>
      )}
      {saveError && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {saveError}
        </p>
      )}
    </Modal>
  );
}

type KeyState =
  | { readonly status: 'checking' }
  | { readonly status: 'ok'; readonly info: PrivateKeyInfo }
  | { readonly status: 'error'; readonly message: string };

type ConnectionForm = UseFormReturn<ConnectionFormValues>;

const KEY_FORMATS: Readonly<Record<PrivateKeyInfo['format'], string>> = {
  openssh: 'OpenSSH',
  pem: 'PEM',
  pkcs8: 'PKCS#8',
  ppk: 'PuTTY',
};

/** The SSH tunnel: jump hosts in connection order, then the server that reaches the database. */
function SshSection(props: {
  readonly form: ConnectionForm;
  readonly hops: readonly { readonly id: string }[];
  readonly keyStates: Readonly<Record<string, KeyState>>;
  readonly canSave: boolean;
  /** An existing profile: empty secret fields keep the stored values. */
  readonly editing: boolean;
  readonly onInspect: (index: number, withPassphrase: boolean) => void;
  readonly onAddJumpHost: () => void;
  readonly onRemove: (index: number) => void;
}) {
  const { form, hops } = props;
  const { register, control, formState } = form;
  const enabled = useWatch({ control, name: 'sshEnabled' });
  const errors = formState.errors;
  return (
    <fieldset
      className="col-span-2 flex flex-col gap-3 rounded border border-border p-3"
      aria-label="SSH tunnel"
    >
      <label className="flex items-center gap-2 text-[13px] font-medium">
        <input type="checkbox" {...register('sshEnabled')} />
        Connect through an SSH tunnel
      </label>
      {enabled && (
        <>
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
function ProxySection(props: {
  readonly form: ConnectionForm;
  readonly canSave: boolean;
  readonly editing: boolean;
}) {
  const { register, control, formState } = props.form;
  const kind = useWatch({ control, name: 'proxyKind' });
  const mode = useWatch({ control, name: 'proxyPasswordMode' });
  const errors = formState.errors;
  return (
    <fieldset
      className="col-span-2 grid grid-cols-[1fr_90px_1fr] gap-x-3 gap-y-2 rounded border border-border p-3"
      aria-label="Proxy settings"
    >
      <Field label="Proxy" htmlFor="cx-proxy-kind" className="col-span-3">
        <Select id="cx-proxy-kind" {...register('proxyKind')}>
          <option value="none">No proxy</option>
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP (CONNECT)</option>
        </Select>
      </Field>
      {kind !== undefined && kind !== 'none' && (
        <>
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

/** Save / remember for this session / ask every time (and "none" for an optional secret). */
function SecretModeSelect({
  canSave,
  optional,
  ...props
}: Parameters<typeof Select>[0] & { readonly canSave: boolean; readonly optional: boolean }) {
  return (
    <Select {...props}>
      <option value="save" disabled={!canSave}>
        Save in the OS keychain
      </option>
      <option value="session">Remember for this session</option>
      <option value="ask">Ask every time</option>
      {optional && <option value="none">No password</option>}
    </Select>
  );
}

function PathField(props: {
  readonly id: string;
  readonly label: string;
  readonly field: 'caPath' | 'certPath' | 'keyPath';
  readonly form: ReturnType<typeof useForm<ConnectionFormValues>>;
}) {
  const { register, setValue } = props.form;
  const browse = async (): Promise<void> => {
    const { path } = await mainApi().dialogs.openFile({
      title: props.label,
      filters: [
        { name: 'Certificates and keys', extensions: ['pem', 'crt', 'cer', 'key', 'der'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (path !== null) setValue(props.field, path, { shouldDirty: true });
  };
  return (
    <Field label={props.label} htmlFor={props.id}>
      <div className="flex gap-1">
        <Input id={props.id} placeholder="Optional" {...register(props.field)} />
        <Button onClick={() => void browse()} aria-label={`Browse for ${props.label}`}>
          Browse…
        </Button>
      </div>
    </Field>
  );
}
