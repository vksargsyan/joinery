import type { ReactNode } from 'react';
import { useFieldArray } from 'react-hook-form';

import { MAX_HOST_ROWS, type HostRowValues } from '../../state/connection-form';
import { Button, Icon, Input } from '../ui';
import type { ConnectionForm } from './fields';

/**
 * Rows of host and port: a MongoDB host list, Redis cluster seeds or Redis Sentinels. Each row
 * is labelled "<row label> <n>" (host) and "<row label> <n> port" for assistive technology.
 */
export function HostListField(props: {
  readonly form: ConnectionForm;
  readonly name: 'hostList' | 'sentinels';
  /** The group's label, e.g. "Hosts". */
  readonly label: string;
  /** One row's label, e.g. "Host". */
  readonly rowLabel: string;
  readonly newRow: () => HostRowValues;
  readonly hint?: ReactNode;
}) {
  const { form, name } = props;
  const { register, control, formState } = form;
  const { fields, append, remove } = useFieldArray({ control, name });
  const errors = formState.errors[name];
  const listError = errors?.message ?? errors?.root?.message;
  const id = (index: number, field: string): string => `cx-${name}-${index}-${field}`;
  return (
    <div role="group" aria-label={props.label} className="col-span-2 flex flex-col gap-1.5">
      <div className="grid grid-cols-[1fr_90px_auto] gap-x-2 text-xs font-medium text-muted">
        <span>{props.label}</span>
        <span>Port</span>
        <span className="w-16" />
      </div>
      {fields.map((field, index) => {
        const rowErrors = errors?.[index];
        const n = index + 1;
        return (
          <div key={field.id} className="grid grid-cols-[1fr_90px_auto] items-start gap-x-2">
            <div className="flex flex-col gap-0.5">
              <Input
                id={id(index, 'host')}
                aria-label={`${props.rowLabel} ${n}`}
                placeholder="host.example.com"
                {...register(`${name}.${index}.host`)}
                aria-invalid={!!rowErrors?.host}
              />
              {rowErrors?.host?.message && (
                <p role="alert" className="text-xs text-danger">
                  {rowErrors.host.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-0.5">
              <Input
                id={id(index, 'port')}
                aria-label={`${props.rowLabel} ${n} port`}
                inputMode="numeric"
                {...register(`${name}.${index}.port`)}
                aria-invalid={!!rowErrors?.port}
              />
              {rowErrors?.port?.message && (
                <p role="alert" className="text-xs text-danger">
                  {rowErrors.port.message}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              className="w-16"
              onClick={() => remove(index)}
              disabled={fields.length <= 1}
              aria-label={`Remove ${props.rowLabel.toLowerCase()} ${n}`}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={() => append(props.newRow())}
          disabled={fields.length >= MAX_HOST_ROWS}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add {props.rowLabel.toLowerCase()}
        </Button>
        {listError ? (
          <p role="alert" className="text-xs text-danger">
            {listError}
          </p>
        ) : props.hint ? (
          <p className="text-xs text-muted">{props.hint}</p>
        ) : null}
      </div>
    </div>
  );
}
