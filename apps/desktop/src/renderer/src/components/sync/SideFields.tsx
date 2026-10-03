import { ENGINES, isSqlEngine } from '@querybara/core';
import { useId } from 'react';

import { useProfiles } from '../../state/data';
import { loadChildren, pathKey, useExplorer } from '../../state/explorer';
import type { SideDraft, SideRole } from '../../state/sync/sides';
import { SelectField, TextField } from '../designer/fields';
import { Button, EnvironmentBadge } from '../ui';

/**
 * One side of a comparison: the connection, its database (listed from the explorer once the
 * connection's databases are loaded) and, for PostgreSQL, the schemas to compare.
 */
export function SideFields(props: {
  readonly role: SideRole;
  readonly draft: SideDraft;
  readonly onChange: (patch: Partial<SideDraft>) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  const profiles = useProfiles();
  const { draft } = props;
  const sql = (profiles.data ?? []).filter((p) => isSqlEngine(p.engine));
  const profile = sql.find((p) => p.id === draft.profileId);
  const databases = useExplorer((state) =>
    draft.profileId !== undefined ? state.children[draft.profileId]?.[pathKey([])] : undefined,
  );
  const listed = (databases?.nodes ?? []).filter((node) => node.kind === 'database');
  const label = props.role === 'source' ? 'Source' : 'Target';
  return (
    <fieldset
      className="flex min-w-0 flex-1 flex-col gap-1.5 rounded border border-border p-2"
      disabled={props.disabled}
    >
      <legend className="px-1 text-xs font-semibold">
        {label}
        {props.role === 'target' && (
          <span className="ml-1 font-normal text-muted">(the database to change)</span>
        )}
      </legend>
      <label htmlFor={`${id}-profile`} className="text-[11px] text-muted">
        {label} connection
      </label>
      <div className="flex items-center gap-1.5">
        <SelectField
          id={`${id}-profile`}
          value={draft.profileId ?? ''}
          onChange={(event) =>
            props.onChange({
              profileId: event.target.value === '' ? undefined : event.target.value,
            })
          }
        >
          <option value="">Choose a connection…</option>
          {sql.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {ENGINES[p.engine].displayName}
            </option>
          ))}
        </SelectField>
        {profile && <EnvironmentBadge environment={profile.presentation.environment} />}
      </div>
      {profile?.presentation.readOnly && props.role === 'target' && (
        <p className="text-[11px] text-warning">Read-only: it can be compared, not changed.</p>
      )}
      <div className="flex items-end gap-1.5">
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-muted">
          {label} database
          <TextField
            list={`${id}-databases`}
            value={draft.database}
            placeholder={profile?.options.defaultDatabase ?? 'Database'}
            onChange={(event) => props.onChange({ database: event.target.value })}
          />
        </label>
        <datalist id={`${id}-databases`}>
          {listed.map((node) => (
            <option key={node.name} value={node.name} />
          ))}
        </datalist>
        {profile && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void loadChildren(profile.id, [])}
            disabled={databases?.loading === true}
            title="Connect and list the databases"
          >
            {databases?.loading ? 'Listing…' : 'List databases'}
          </Button>
        )}
      </div>
      {databases?.error && <p className="text-[11px] text-danger">{databases.error}</p>}
      {profile?.engine === 'postgres' && (
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">
          {label} schemas
          <TextField
            value={draft.schemas}
            placeholder="Every schema (or: public, sales)"
            onChange={(event) => props.onChange({ schemas: event.target.value })}
          />
        </label>
      )}
    </fieldset>
  );
}
