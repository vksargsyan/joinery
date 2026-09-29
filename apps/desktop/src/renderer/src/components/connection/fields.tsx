import type { ReactNode } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';

import { mainApi } from '../../lib/main-client';
import type { ConnectionFormValues } from '../../state/connection-form';
import { Button, Field, Input, Select, cx } from '../ui';

/** Inputs the connection dialog's sections share. */

export type ConnectionForm = UseFormReturn<ConnectionFormValues>;

/** A short explanation under a group of fields. */
export function Note(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <p className={cx('col-span-2 -mt-1 text-xs text-muted', props.className)}>{props.children}</p>
  );
}

/** Save / remember for this session / ask every time (and "none" for an optional secret). */
export function SecretModeSelect({
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

/**
 * The database password (or another sign-in secret: an API key, a token) and where it is kept;
 * the value typed here goes to main only.
 */
export function PasswordFields(props: {
  readonly form: ConnectionForm;
  readonly canSave: boolean;
  /** An existing profile: an empty field keeps the stored password. */
  readonly editing: boolean;
  /** What the secret is called; "Password" by default. */
  readonly secretLabel?: string;
  /** The sign-in cannot do without it, so "none" is not offered. */
  readonly required?: boolean;
}) {
  const { register, control, formState } = props.form;
  const mode = useWatch({ control, name: 'passwordMode' });
  const label = props.secretLabel ?? 'Password';
  return (
    <>
      <Field
        label={label}
        htmlFor="cx-password"
        hint={
          props.editing && mode !== 'none' && mode !== 'ask'
            ? `Leave empty to keep the stored ${label.toLowerCase()}`
            : undefined
        }
      >
        <Input
          id="cx-password"
          type="password"
          autoComplete="new-password"
          disabled={mode === 'none'}
          {...register('password')}
        />
      </Field>
      <Field
        label={`${label} storage`}
        htmlFor="cx-password-mode"
        error={formState.errors.passwordMode?.message}
        hint={
          props.canSave ? undefined : 'No keychain or secret service is available on this system'
        }
      >
        <SecretModeSelect
          id="cx-password-mode"
          canSave={props.canSave}
          optional={props.required !== true}
          {...register('passwordMode')}
        />
      </Field>
    </>
  );
}

/** A certificate or key file path, typed or chosen in the system file dialog. */
export function PathField(props: {
  readonly id: string;
  readonly label: string;
  readonly field: 'caPath' | 'certPath' | 'keyPath';
  readonly form: ConnectionForm;
  readonly placeholder?: string;
}) {
  const { register, setValue, formState } = props.form;
  const error = formState.errors[props.field]?.message;
  const browse = async (): Promise<void> => {
    const { path } = await mainApi().dialogs.openFile({
      title: props.label,
      filters: [
        { name: 'Certificates and keys', extensions: ['pem', 'crt', 'cer', 'key', 'der'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (path !== null) {
      setValue(props.field, path, { shouldDirty: true, shouldValidate: error !== undefined });
    }
  };
  return (
    <Field label={props.label} htmlFor={props.id} error={error}>
      <div className="flex gap-1">
        <Input
          id={props.id}
          placeholder={props.placeholder ?? 'Optional'}
          {...register(props.field)}
          aria-invalid={error !== undefined}
        />
        <Button onClick={() => void browse()} aria-label={`Browse for ${props.label}`}>
          Browse…
        </Button>
      </div>
    </Field>
  );
}
