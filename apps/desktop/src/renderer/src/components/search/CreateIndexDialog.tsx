import { formatJson } from '@joinery/search-tools';
import { useMemo, useState } from 'react';

import {
  EMPTY_CREATE_INDEX,
  createIndexBody,
  createIndexIssues,
  createSearchIndex,
  type CreateIndexForm,
} from '../../state/search/create-index';
import { useTheme } from '../theme';
import { Button, Field, Input, Modal } from '../ui';
import { JsonEditor } from './JsonEditor';

/**
 * Create an index (spec §11): its name (checked against the server's rules as it is typed),
 * primary shards and replicas, the mapping and further settings as JSON, and aliases. The
 * request it sends is shown below the form.
 */
export function CreateIndexDialog(props: {
  readonly profileId: string;
  readonly onClose: () => void;
  readonly onCreated?: (name: string) => void;
}) {
  const theme = useTheme();
  const [form, setForm] = useState<CreateIndexForm>(EMPTY_CREATE_INDEX);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const issues = useMemo(() => createIndexIssues(form), [form]);
  const valid = Object.keys(issues).length === 0;
  const preview = useMemo(() => {
    if (!valid) return undefined;
    try {
      return `PUT /${form.name.trim()}\n${formatJson(createIndexBody(form))}`;
    } catch {
      return undefined;
    }
  }, [form, valid]);
  const patch = (next: Partial<CreateIndexForm>): void => {
    setTouched(true);
    setError(undefined);
    setForm((f) => ({ ...f, ...next }));
  };
  const submit = async (): Promise<void> => {
    setSaving(true);
    const result = await createSearchIndex(props.profileId, form);
    setSaving(false);
    if (result === null) return;
    if (result !== undefined) {
      setError(result);
      return;
    }
    props.onCreated?.(form.name.trim());
    props.onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && props.onClose()}
      title="Create index"
      width="w-[720px]"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || saving}
            onClick={() => void submit()}
            data-testid="create-index-submit"
          >
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="create-index">
        <Field label="Name" htmlFor="create-index-name" error={touched ? issues.name : undefined}>
          <Input
            id="create-index-name"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="font-mono"
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Primary shards" htmlFor="create-index-shards" error={issues.shards}>
            <Input
              id="create-index-shards"
              value={form.shards}
              onChange={(e) => patch({ shards: e.target.value })}
              inputMode="numeric"
            />
          </Field>
          <Field label="Replicas" htmlFor="create-index-replicas" error={issues.replicas}>
            <Input
              id="create-index-replicas"
              value={form.replicas}
              onChange={(e) => patch({ replicas: e.target.value })}
              inputMode="numeric"
            />
          </Field>
          <Field
            label="Aliases (comma-separated)"
            htmlFor="create-index-aliases"
            error={issues.aliases}
          >
            <Input
              id="create-index-aliases"
              value={form.aliases}
              onChange={(e) => patch({ aliases: e.target.value })}
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Mappings" htmlFor="create-index-mappings" error={issues.mappings}>
          <div id="create-index-mappings">
            <JsonEditor
              value={form.mappings}
              onChange={(text) => patch({ mappings: text })}
              theme={theme}
              ariaLabel="Mappings"
              testId="create-index-mappings"
              className="h-40 min-h-0 rounded border border-border"
            />
          </div>
        </Field>
        <Field label="Other settings" htmlFor="create-index-settings" error={issues.settings}>
          <div id="create-index-settings">
            <JsonEditor
              value={form.settings}
              onChange={(text) => patch({ settings: text })}
              theme={theme}
              ariaLabel="Other settings"
              className="h-20 min-h-0 rounded border border-border"
            />
          </div>
        </Field>
        {preview && (
          <pre
            className="max-h-32 overflow-auto rounded bg-panel-2 p-2 font-mono text-[11px]"
            data-testid="create-index-preview"
          >
            {preview}
          </pre>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
