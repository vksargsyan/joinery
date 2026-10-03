import { useFieldArray, useWatch } from 'react-hook-form';

import { MAX_HOST_ROWS, defaultUrlRow } from '../../state/connection-form';
import { Button, Icon, Input } from '../ui';
import type { ConnectionForm } from './fields';

/**
 * The node URLs of an Elasticsearch connection (spec §4): one or more, each
 * labelled "Node URL <n>" for assistive technology, with the sniffing option below them.
 */
export function UrlListField(props: { readonly form: ConnectionForm }) {
  const { register, control, formState } = props.form;
  const { fields, append, remove } = useFieldArray({ control, name: 'urls' });
  const sniff = useWatch({ control, name: 'sniff' });
  const errors = formState.errors.urls;
  const listError = errors?.message ?? errors?.root?.message;
  return (
    <div role="group" aria-label="Node URLs" className="col-span-2 flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">Node URLs</span>
      {fields.map((field, index) => {
        const error = errors?.[index]?.url?.message;
        const n = index + 1;
        return (
          <div key={field.id} className="grid grid-cols-[1fr_auto] items-start gap-x-2">
            <div className="flex flex-col gap-0.5">
              <Input
                id={`cx-urls-${index}`}
                aria-label={`Node URL ${n}`}
                placeholder="https://localhost:9200"
                spellCheck={false}
                {...register(`urls.${index}.url`)}
                aria-invalid={error !== undefined}
              />
              {error && (
                <p role="alert" className="text-xs text-danger">
                  {error}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              className="w-16"
              onClick={() => remove(index)}
              disabled={fields.length <= 1}
              aria-label={`Remove node URL ${n}`}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={() => append(defaultUrlRow())}
          disabled={fields.length >= MAX_HOST_ROWS}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add node URL
        </Button>
        {listError ? (
          <p role="alert" className="text-xs text-danger">
            {listError}
          </p>
        ) : (
          <p className="text-xs text-muted">
            http:// or https:// with the HTTP port (usually 9200). Requests go to the nodes in turn.
          </p>
        )}
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" {...register('sniff')} />
        Discover the other nodes of the cluster (sniffing)
      </label>
      {sniff && (
        <p className="ml-5 -mt-1 text-xs text-muted">
          Querybara then also sends requests to the addresses the nodes publish, which must be
          reachable from this computer. Not used through an SSH tunnel or a proxy.
        </p>
      )}
    </div>
  );
}
