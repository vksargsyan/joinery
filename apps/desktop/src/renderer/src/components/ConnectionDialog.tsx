import { zodResolver } from '@hookform/resolvers/zod';
import {
  ENGINES,
  hasWeakTls,
  isLocalEndpoint,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type ConnectionProfile,
} from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFieldArray, useForm, useWatch, type FieldErrors } from 'react-hook-form';

import { errorInfo, errorMessage } from '../lib/errors';
import { formatDuration } from '../lib/format';
import { mainApi } from '../lib/main-client';
import {
  connectionFormSchema,
  defaultFormValues,
  defaultSshHop,
  endpointKindsFor,
  formFromUri,
  formToProfile,
  profileToForm,
  switchEndpointKind,
  switchEngine,
  tunnelLimitation,
  typedSecrets,
  type ConnectionFormValues,
  type DialogEngine,
} from '../state/connection-form';
import { keys, useCanSaveSecrets, useFolders, useProfiles } from '../state/data';
import { EngineIcon } from './EngineIcon';
import { ENDPOINT_LABELS, EndpointFields, URI_EXAMPLES } from './connection/EndpointFields';
import { EnginePicker, lastUsedEngine } from './connection/EnginePicker';
import {
  MongoFields,
  MongoOptions,
  RedisFields,
  RedisOptions,
  SearchFields,
  SqlFields,
} from './connection/EngineFields';
import { PathField, type ConnectionForm } from './connection/fields';
import { ProxySection, SshSection, type KeyState } from './connection/NetworkSections';
import { Button, Field, Icon, Input, Modal, Select, TAB, cx } from './ui';

/**
 * Create, edit or duplicate a connection (spec §4), in Navicat's two steps. A new connection
 * starts with its database engine (or a pasted URI, which names it); then the form, in tabs:
 *
 * - General: name, endpoint, sign-in with its storage policy, environment and folder.
 * - Advanced: the engine's options (MongoDB's default database and read preference, Redis's
 *   database number and key delimiter), read-only, confirm writes, colour.
 * - TLS, SSH (a tunnel with jump hosts) and Proxy.
 *
 * A tab holding an invalid field shows a red dot, and saving or testing opens the first such tab;
 * TLS, SSH and Proxy show a dot while on. Test Connection runs the stepwise check in a
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

type TabId = 'general' | 'advanced' | 'tls' | 'ssh' | 'proxy';

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'tls', label: 'TLS' },
  { id: 'ssh', label: 'SSH' },
  { id: 'proxy', label: 'Proxy' },
];

/** Where each field is, when not on General. */
const FIELD_TABS: Readonly<Partial<Record<keyof ConnectionFormValues, TabId>>> = {
  readPreference: 'advanced',
  directConnection: 'advanced',
  keyDelimiter: 'advanced',
  color: 'advanced',
  readOnly: 'advanced',
  confirmWrites: 'advanced',
  tlsMode: 'tls',
  caPath: 'tls',
  certPath: 'tls',
  keyPath: 'tls',
  sshEnabled: 'ssh',
  sshHops: 'ssh',
  sshKeepAlive: 'ssh',
  proxyKind: 'proxy',
  proxyHost: 'proxy',
  proxyPort: 'proxy',
  proxyUser: 'proxy',
  proxyPassword: 'proxy',
  proxyPasswordMode: 'proxy',
};

function tabOf(field: string, engine: DialogEngine): TabId {
  // MongoDB's default database and Redis's database number are options; SQL's is on General.
  if (field === 'database' && (engine === 'mongodb' || engine === 'redis')) return 'advanced';
  return FIELD_TABS[field as keyof ConnectionFormValues] ?? 'general';
}

/** The tabs holding invalid fields, in tab order. */
function tabsWithErrors(
  errors: FieldErrors<ConnectionFormValues>,
  engine: DialogEngine,
): readonly TabId[] {
  const tabs = new Set(Object.keys(errors).map((field) => tabOf(field, engine)));
  return TABS.map((tab) => tab.id).filter((id) => tabs.has(id));
}

const TLS_HINTS: Readonly<Record<ConnectionFormValues['tlsMode'], string>> = {
  disable: 'Plain TCP: fine for a local server or a private network you trust.',
  require: 'Encrypted, but any certificate is accepted.',
  'verify-ca': 'Encrypted; the certificate must be signed by a trusted authority.',
  'verify-full': 'Encrypted; the certificate must be trusted and name this host.',
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
  const profiles = useProfiles();
  const creating = mode.kind === 'create';
  // A new connection starts by choosing its engine; an edit or a duplicate knows it.
  const [step, setStep] = useState<'engine' | 'form'>(creating ? 'engine' : 'form');
  const lastUsed = lastUsedEngine(profiles.data ?? []);
  const [picked, setPicked] = useState<DialogEngine | undefined>(lastUsed ?? 'postgres');
  const [tab, setTab] = useState<TabId>('general');
  const [showUri, setShowUri] = useState(false);
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

  /** On from the engine step: the form for that engine, keeping what was typed. */
  const chooseEngine = (chosen: DialogEngine): void => {
    setPicked(chosen);
    applyValues(switchEngine(getValues(), chosen));
    form.clearErrors();
    setTab('general');
    setStep('form');
  };

  /** Opens the first tab holding an invalid field, and puts the cursor in that field. */
  const showErrors = (errors: FieldErrors<ConnectionFormValues>): void => {
    const current = getValues('engine');
    const [first] = tabsWithErrors(errors, current);
    if (first === undefined) return;
    setTab(first);
    const field = Object.keys(errors).find((name) => tabOf(name, current) === first);
    // After the tab shows: a hidden input takes no focus.
    if (field !== undefined) {
      requestAnimationFrame(() => form.setFocus(field as keyof ConnectionFormValues));
    }
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
        engine: step === 'engine' ? (picked ?? getValues('engine')) : getValues('engine'),
        parse: (input) => mainApi().profiles.parseUri(input),
        // Read when the parsed profile is back: the user may have typed a name meanwhile.
        current: () => getValues(),
        canSave,
      });
      form.reset(next);
      setPicked(next.engine);
      setStep('form');
      setTab('general');
      setUri('');
      setShowUri(false);
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
    if (!valid) {
      showErrors(form.formState.errors);
      return;
    }
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
  }, showErrors);

  const weakTls = values.tlsMode !== undefined && values.tlsMode !== 'verify-full';
  const localWithStrictTls = !weakTls && endpointKind === 'host' && isLocalHost(values.host ?? '');
  const tunnelNote = tunnelLimitation(engine);
  const tlsStepFailed = checks.some((step) => step.step === 'tls' && step.status === 'failed');
  const proxyOn = values.proxyKind !== undefined && values.proxyKind !== 'none';
  const proxyOnly = !values.sshEnabled && proxyOn;
  const production = values.environment === 'production';
  const title =
    mode.kind === 'edit'
      ? `Edit ${mode.profile.name}`
      : mode.kind === 'duplicate'
        ? 'Duplicate connection'
        : 'New connection';

  const draft = weakTls ? draftProfile() : undefined;
  // Nothing to intercept on a local server (localhost, a socket): no warning, a note instead.
  const localServer = draft !== undefined && isLocalEndpoint(draft);
  const errorTabs = tabsWithErrors(errors, engine);
  const tabOn: Readonly<Partial<Record<TabId, boolean>>> = {
    tls: values.tlsMode !== undefined && values.tlsMode !== 'disable',
    ssh: values.sshEnabled === true,
    proxy: proxyOn,
  };

  const uriBox = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2 rounded-md border border-dashed border-border p-2.5">
        <Field label="Paste a URI to fill the form" htmlFor="cx-paste-uri" className="flex-1">
          <Input
            id="cx-paste-uri"
            value={uri}
            autoFocus={step === 'form'}
            spellCheck={false}
            placeholder={URI_EXAMPLES[step === 'engine' ? (picked ?? engine) : engine]}
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
      {uriNote?.kind === 'error' && (
        <p role="status" className="text-xs text-danger">
          {uriNote.text}
        </p>
      )}
    </div>
  );

  const content = (id: TabId, className: string, children: ReactNode) => (
    <Tabs.Content
      value={id}
      // Every tab stays mounted, so its fields keep their state and validate while hidden.
      forceMount
      className={cx('outline-none data-[state=inactive]:hidden', className)}
    >
      {children}
    </Tabs.Content>
  );

  return (
    <Tabs.Root value={tab} onValueChange={(next) => setTab(next as TabId)} className="contents">
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={title}
        width="w-[760px]"
        // A steady size: switching tabs or steps does not resize the dialog.
        bodyClassName="flex-[0_1_500px] px-5 py-4"
        titleAside={
          step === 'form' && (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-badge px-1.5 py-0.5 text-[11px] font-medium text-fg">
              <EngineIcon engine={engine} className="h-3.5 w-3.5" />
              <span data-testid="connection-engine">{ENGINES[engine].displayName}</span>
            </span>
          )
        }
        tabs={
          step === 'form' ? (
            <Tabs.List aria-label="Connection settings sections" className="flex gap-1">
              {TABS.map((item) => (
                <Tabs.Trigger key={item.id} value={item.id} className={TAB}>
                  {item.label}
                  {errorTabs.includes(item.id) ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-danger">
                      <span className="sr-only">(has errors)</span>
                    </span>
                  ) : (
                    tabOn[item.id] && (
                      <span className="h-1.5 w-1.5 rounded-full bg-success">
                        <span className="sr-only">(on)</span>
                      </span>
                    )
                  )}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          ) : undefined
        }
        footer={
          step === 'engine' ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={picked === undefined}
                onClick={() => picked && chooseEngine(picked)}
              >
                Next
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                aria-pressed={showUri}
                title="Fill the form from a connection URI"
                onClick={() => {
                  setShowUri(!showUri);
                  setTab('general');
                }}
              >
                <Icon name="link" className="h-3.5 w-3.5" />
                URI
              </Button>
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
              {creating && <Button onClick={() => setStep('engine')}>Back</Button>}
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          )
        }
      >
        {step === 'engine' ? (
          <EnginePicker
            selected={picked}
            lastUsed={lastUsed}
            onSelect={setPicked}
            onChoose={chooseEngine}
            uri={uriBox}
          />
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              aria-label="Connection settings"
            >
              {content(
                'general',
                'grid grid-cols-2 content-start gap-x-4 gap-y-3',
                <>
                  {showUri && <div className="col-span-2">{uriBox}</div>}
                  {uriNote?.kind === 'ok' && (
                    <p
                      role="status"
                      className="col-span-2 flex items-center gap-1.5 text-xs text-success"
                    >
                      <Icon name="check" className="h-3.5 w-3.5" />
                      {uriNote.text}
                    </p>
                  )}
                  <Field label="Name" htmlFor="cx-name" error={errors.name?.message}>
                    <Input
                      id="cx-name"
                      autoFocus={!showUri}
                      placeholder={`My ${ENGINES[engine].displayName}`}
                      {...register('name')}
                      aria-invalid={!!errors.name}
                    />
                  </Field>
                  <Field
                    label="Connect with"
                    htmlFor="cx-endpoint"
                    error={errors.endpointKind?.message}
                  >
                    <Select
                      id="cx-endpoint"
                      {...register('endpointKind')}
                      // Controlled: the options change with the engine, so the value follows.
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

                  {/* Keyed: each endpoint form mounts its own inputs instead of reusing another's. */}
                  <EndpointFields
                    key={endpointKind}
                    form={form}
                    engine={engine}
                    kind={endpointKind}
                  />

                  {engine === 'mongodb' ? (
                    <MongoFields form={form} canSave={canSave} editing={editing !== undefined} />
                  ) : engine === 'redis' ? (
                    <RedisFields form={form} canSave={canSave} editing={editing !== undefined} />
                  ) : engine === 'elasticsearch' ? (
                    <SearchFields form={form} canSave={canSave} editing={editing !== undefined} />
                  ) : (
                    <SqlFields form={form} canSave={canSave} editing={editing !== undefined} />
                  )}

                  <div aria-hidden="true" className="col-span-2 my-1 h-px bg-border" />
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
                  {production && (
                    <p className="col-span-2 -mt-1 text-xs text-muted">
                      Production connections confirm every write and frame their tabs in red.
                    </p>
                  )}
                </>,
              )}

              {content(
                'advanced',
                'flex flex-col gap-5',
                <>
                  {(engine === 'mongodb' || engine === 'redis') && (
                    <Section title={`${ENGINES[engine].displayName} options`}>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                        {engine === 'mongodb' ? (
                          <MongoOptions form={form} />
                        ) : (
                          <RedisOptions form={form} />
                        )}
                      </div>
                    </Section>
                  )}
                  <Section title="Safety">
                    <div className="flex flex-col gap-2 text-[13px]">
                      <label className="flex items-start gap-2">
                        <input type="checkbox" className="mt-0.5" {...register('readOnly')} />
                        <span>
                          Read-only
                          <span className="block text-xs text-muted">
                            Refuse every write, whatever the tab runs.
                          </span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          {...register('confirmWrites')}
                          disabled={production}
                          checked={production ? true : values.confirmWrites === true}
                        />
                        <span>
                          Confirm every write{production ? ' (always on for production)' : ''}
                          <span className="block text-xs text-muted">
                            Ask before running a statement that changes data or structure.
                          </span>
                        </span>
                      </label>
                    </div>
                  </Section>
                  <Section title="Appearance">
                    <Field label="Colour" htmlFor="cx-color" error={errors.color?.message}>
                      <div className="flex items-center gap-2">
                        <input
                          id="cx-color"
                          type="color"
                          className="h-8 w-12 cursor-pointer rounded border border-border bg-panel-2"
                          value={
                            values.color === '' || values.color === undefined
                              ? '#e8906a'
                              : values.color
                          }
                          onChange={(event) =>
                            setValue('color', event.target.value, { shouldDirty: true })
                          }
                        />
                        {values.color !== '' ? (
                          <Button size="sm" variant="ghost" onClick={() => setValue('color', '')}>
                            Clear
                          </Button>
                        ) : (
                          <span className="text-xs text-muted">
                            None: the connection shows no colour dot.
                          </span>
                        )}
                      </div>
                    </Field>
                  </Section>
                </>,
              )}

              {content(
                'tls',
                'grid grid-cols-2 content-start gap-x-4 gap-y-3',
                <>
                  <Field
                    label="TLS mode"
                    htmlFor="cx-tls"
                    error={errors.tlsMode?.message}
                    hint={TLS_HINTS[values.tlsMode ?? 'disable']}
                  >
                    <Select id="cx-tls" {...register('tlsMode')} aria-invalid={!!errors.tlsMode}>
                      <option value="disable">Disable TLS</option>
                      <option value="require">Require TLS, no verification</option>
                      <option value="verify-ca">Verify certificate only</option>
                      <option value="verify-full">Verify certificate and host name</option>
                    </Select>
                  </Field>
                  <div />
                  {engine === 'elasticsearch' && endpointKind === 'urls' && (
                    <p className="col-span-2 -mt-1 text-xs text-muted">
                      The URL scheme decides: https:// connects with TLS in the mode chosen here,
                      http:// needs “Disable TLS”.
                    </p>
                  )}
                  {endpointKind === 'srv' && (
                    <p className="col-span-2 -mt-1 text-xs text-muted">
                      An SRV record (mongodb+srv) implies TLS, as in MongoDB drivers; choose
                      “Disable TLS” only for a server that has none.
                    </p>
                  )}
                  {values.tlsMode !== 'disable' && (
                    <>
                      <PathField id="cx-ca" label="CA certificate" field="caPath" form={form} />
                      <div />
                      <PathField
                        id="cx-cert"
                        label="Client certificate"
                        field="certPath"
                        form={form}
                        placeholder={
                          values.authMethod === 'clientCertificate' ? 'Required' : 'Optional'
                        }
                      />
                      <PathField
                        id="cx-key"
                        label="Client key"
                        field="keyPath"
                        form={form}
                        placeholder={
                          values.authMethod === 'clientCertificate' ? 'Required' : 'Optional'
                        }
                      />
                    </>
                  )}
                  {weakTls && localServer && (
                    <p className="col-span-2 text-xs text-muted" data-testid="tls-local-note">
                      A local server: the traffic does not leave this computer, so the connection
                      shows no TLS warning.
                    </p>
                  )}
                  {weakTls && !localServer && (
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
                      Local development servers often run without TLS. If Test Connection fails at
                      the TLS step, choose “Disable TLS”.
                    </p>
                  )}
                </>,
              )}

              {content(
                'ssh',
                'grid grid-cols-2 content-start gap-x-4 gap-y-3',
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
                />,
              )}

              {content(
                'proxy',
                'grid grid-cols-2 content-start gap-x-4 gap-y-3',
                <ProxySection
                  form={form}
                  note={tunnelNote}
                  canSave={canSave}
                  editing={editing !== undefined}
                />,
              )}
            </form>

            {(checkState !== 'idle' || checks.length > 0) && (
              <section
                ref={checkSection}
                aria-label="Connection test"
                className="mt-5 rounded border border-border bg-panel-2 p-3"
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
                    The TLS handshake failed. If the server has no TLS (common for local servers),
                    set TLS to “Disable TLS” on the TLS tab.
                  </p>
                )}
              </section>
            )}
            {saveError && (
              <p role="alert" className="mt-3 text-[13px] text-danger">
                {saveError}
              </p>
            )}
          </>
        )}
      </Modal>
    </Tabs.Root>
  );
}

/** A titled group on the Advanced tab. */
function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={props.title} className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
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
