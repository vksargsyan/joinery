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
import { useFieldArray, useForm, useWatch } from 'react-hook-form';

import { errorInfo, errorMessage } from '../lib/errors';
import { formatDuration } from '../lib/format';
import { mainApi } from '../lib/main-client';
import {
  COMING_SOON_ENGINES,
  DIALOG_ENGINES,
  connectionFormSchema,
  defaultFormValues,
  defaultSshHop,
  endpointKindsFor,
  formFromUri,
  formToProfile,
  isSearchDialogEngine,
  profileToForm,
  switchEndpointKind,
  switchEngine,
  tunnelLimitation,
  typedSecrets,
  type ConnectionFormValues,
} from '../state/connection-form';
import { keys, useCanSaveSecrets, useFolders } from '../state/data';
import { ENDPOINT_LABELS, EndpointFields, URI_EXAMPLES } from './connection/EndpointFields';
import { MongoFields, RedisFields, SearchFields, SqlFields } from './connection/EngineFields';
import { PathField, type ConnectionForm } from './connection/fields';
import { ProxySection, SshSection, type KeyState } from './connection/NetworkSections';
import { Button, Field, Icon, Input, Modal, Select, cx } from './ui';

/**
 * Create, edit or duplicate a connection (spec §4): endpoint, credentials with their storage
 * policy, TLS, an SSH tunnel (with jump hosts) and a proxy, and presentation (environment,
 * read-only, confirm writes, colour, folder). PostgreSQL, MySQL and MariaDB take a database, user
 * and password; MongoDB adds host lists, SRV records and its sign-in methods and options, Redis
 * Sentinel, Cluster, a logical database and the key browser's delimiter. Test Connection runs the
 * stepwise check in a short-lived connection host and shows each step. Every secret typed here
 * goes to main with its policy and never comes back; private key files are read and checked by
 * main.
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
  const engine = values.engine ?? 'postgres';
  const endpointKind = values.endpointKind ?? 'host';

  useEffect(() => () => checkAbort.current?.abort(), []);

  // Bring the step list into view as the test runs (the form is taller than the dialog).
  useEffect(() => {
    if (checkState !== 'idle') checkSection.current?.scrollIntoView({ block: 'nearest' });
  }, [checkState, checks.length]);

  /** Sets the fields that differ, leaving the others (and the SSH hops' key checks) alone. */
  const applyValues = (next: ConnectionFormValues): void => {
    const current = getValues();
    for (const key of Object.keys(next) as (keyof ConnectionFormValues)[]) {
      if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
        setField(form, key, next[key]);
      }
    }
  };

  const changeEngine = (next: string): void => {
    const chosen = DIALOG_ENGINES.find((id) => id === next);
    if (chosen === undefined) return;
    applyValues(switchEngine(getValues(), chosen));
    form.clearErrors();
  };

  const changeEndpointKind = (next: string): void => {
    const kind = endpointKindsFor(getValues('engine')).find((known) => known === next);
    if (kind === undefined) return;
    applyValues(switchEndpointKind(getValues(), kind));
    form.clearErrors([
      'endpointKind',
      'host',
      'port',
      'socketPath',
      'uri',
      'hostList',
      'sentinels',
      'urls',
      'cloudId',
    ]);
  };

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
      const { values: next, ignoredParams } = await formFromUri(text, {
        engine: getValues('engine'),
        parse: (input) => mainApi().profiles.parseUri(input),
        // Read when the parsed profile is back: the user may have typed a name meanwhile.
        current: () => getValues(),
        canSave,
      });
      form.reset(next);
      setUriNote({
        kind: 'ok',
        text:
          ignoredParams.length > 0
            ? `Filled from the URI. Ignored: ${ignoredParams.join(', ')}`
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
  const localWithStrictTls = !weakTls && endpointKind === 'host' && isLocalHost(values.host ?? '');
  const tunnelNote = tunnelLimitation(engine);
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
          <Select
            id="cx-engine"
            {...register('engine')}
            value={engine}
            onChange={(event) => changeEngine(event.target.value)}
          >
            {DIALOG_ENGINES.map((id) => (
              <option key={id} value={id}>
                {ENGINES[id].displayName}
              </option>
            ))}
            {COMING_SOON_ENGINES.map((id) => (
              <option key={id} value={id} disabled>
                {ENGINES[id].displayName} (coming soon)
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Connect with" htmlFor="cx-endpoint" error={errors.endpointKind?.message}>
          <Select
            id="cx-endpoint"
            {...register('endpointKind')}
            // Controlled: the options change with the engine, so the value follows the form.
            value={endpointKind}
            onChange={(event) => changeEndpointKind(event.target.value)}
            aria-invalid={!!errors.endpointKind}
          >
            {endpointKindsFor(engine).map((kind) => (
              <option key={kind} value={kind}>
                {ENDPOINT_LABELS[kind]}
              </option>
            ))}
          </Select>
        </Field>

        <div className="col-span-2 flex items-end gap-2 rounded border border-dashed border-border p-2">
          <Field label="Paste a URI to fill the form" htmlFor="cx-paste-uri" className="flex-1">
            <Input
              id="cx-paste-uri"
              value={uri}
              placeholder={URI_EXAMPLES[engine]}
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

        {/* Keyed: each endpoint form mounts its own inputs instead of reusing another's. */}
        <EndpointFields key={endpointKind} form={form} engine={engine} kind={endpointKind} />

        {engine === 'mongodb' ? (
          <MongoFields form={form} canSave={canSave} editing={editing !== undefined} />
        ) : engine === 'redis' ? (
          <RedisFields form={form} canSave={canSave} editing={editing !== undefined} />
        ) : isSearchDialogEngine(engine) ? (
          <SearchFields
            form={form}
            engine={engine}
            canSave={canSave}
            editing={editing !== undefined}
          />
        ) : (
          <SqlFields form={form} canSave={canSave} editing={editing !== undefined} />
        )}

        <Field label="TLS" htmlFor="cx-tls" error={errors.tlsMode?.message}>
          <Select id="cx-tls" {...register('tlsMode')} aria-invalid={!!errors.tlsMode}>
            <option value="verify-full">Verify certificate and host name (recommended)</option>
            <option value="verify-ca">Verify certificate only</option>
            <option value="require">Require TLS, no verification</option>
            <option value="disable">Disable TLS</option>
          </Select>
        </Field>
        <div />
        {isSearchDialogEngine(engine) && endpointKind === 'urls' && (
          <p className="col-span-2 -mt-1 text-xs text-muted">
            The URL scheme decides: https:// connects with TLS in the mode chosen here, http://
            needs “Disable TLS”.
          </p>
        )}
        {endpointKind === 'srv' && (
          <p className="col-span-2 -mt-1 text-xs text-muted">
            An SRV record (mongodb+srv) implies TLS, as in MongoDB drivers; choose “Disable TLS”
            only for a server that has none.
          </p>
        )}
        {values.tlsMode !== 'disable' && (
          <>
            <PathField id="cx-ca" label="CA certificate" field="caPath" form={form} />
            <PathField
              id="cx-cert"
              label="Client certificate"
              field="certPath"
              form={form}
              placeholder={values.authMethod === 'clientCertificate' ? 'Required' : 'Optional'}
            />
            <PathField
              id="cx-key"
              label="Client key"
              field="keyPath"
              form={form}
              placeholder={values.authMethod === 'clientCertificate' ? 'Required' : 'Optional'}
            />
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
          note={tunnelNote}
          hops={hops}
          keyStates={keyStates}
          canSave={canSave}
          editing={editing !== undefined}
          onInspect={(index, withPassphrase) => void inspectKey(index, withPassphrase)}
          onAddJumpHost={() => insertHop(Math.max(hops.length - 1, 0), defaultSshHop())}
          onRemove={(index) => removeHop(index)}
        />
        <ProxySection
          form={form}
          note={tunnelNote}
          canSave={canSave}
          editing={editing !== undefined}
        />

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

/** Sets one top-level field from a whole-form update (engine or endpoint switch). */
function setField<K extends keyof ConnectionFormValues>(
  form: ConnectionForm,
  key: K,
  value: ConnectionFormValues[K],
): void {
  // react-hook-form types values by path; a top-level key's value is exactly its path's value.
  form.setValue(key, value as never, { shouldDirty: true });
}
