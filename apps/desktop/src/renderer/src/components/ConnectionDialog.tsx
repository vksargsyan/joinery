import { zodResolver } from '@hookform/resolvers/zod';
import {
  ENGINES,
  hasWeakTls,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type ConnectionProfile,
} from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { errorInfo, errorMessage } from '../lib/errors';
import { formatDuration } from '../lib/format';
import { mainApi } from '../lib/main-client';
import {
  COMING_SOON_ENGINES,
  DIALOG_ENGINES,
  connectionFormSchema,
  defaultFormValues,
  formToProfile,
  passwordFromUri,
  profileToForm,
  type ConnectionFormValues,
} from '../state/connection-form';
import { keys, useCanSaveSecrets, useFolders } from '../state/data';
import { Button, Field, Icon, Input, Modal, Select, cx } from './ui';

/**
 * Create, edit or duplicate a connection (spec §4): endpoint, credentials with their storage
 * policy, TLS, and presentation (environment, read-only, confirm writes, colour, folder). Test
 * Connection runs the stepwise check in a short-lived connection host and shows each step.
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
      const current = getValues();
      const engine =
        current.engine === 'mariadb' && /^mysql:/i.test(text) ? ('mariadb' as const) : undefined;
      const parsed = await mainApi().profiles.parseUri({
        uri: text,
        ...(engine ? { engine } : {}),
      });
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
    const { profile, passwordRef } = formToProfile(current, editing);
    checkAbort.current?.abort();
    const controller = new AbortController();
    checkAbort.current = controller;
    setChecks([]);
    setCheckError(undefined);
    setCheckState('running');
    let failed = false;
    try {
      const secrets =
        passwordRef && current.password !== '' ? { [passwordRef.id]: current.password } : undefined;
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
    if (form.passwordMode === 'save' && !canSave && form.password !== '') {
      setSaveError(
        'This system has no secure storage for passwords. Choose "Remember for this session" or "Ask every time".',
      );
      return;
    }
    setSaving(true);
    try {
      const { profile, passwordRef } = formToProfile(form, editing);
      const saved = await mainApi().profiles.save({
        profile,
        ...(editing ? { expectedVersion: editing.version } : {}),
      });
      if (passwordRef) {
        const previousPolicy =
          editing?.auth.method === 'password' ? editing.auth.password?.policy : undefined;
        if (form.password !== '' && passwordRef.policy !== 'ask') {
          await mainApi().secrets.set({
            profileId: saved.id,
            refId: passwordRef.id,
            value: form.password,
          });
        } else if (passwordRef.policy === 'ask' || previousPolicy !== passwordRef.policy) {
          await mainApi().secrets.clear({ profileId: saved.id, refId: passwordRef.id });
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
                  <span className="font-medium">{STEP_LABELS[step.step]}</span>
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
