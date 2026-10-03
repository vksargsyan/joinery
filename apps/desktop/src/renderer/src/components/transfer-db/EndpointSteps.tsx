import { ENGINES, isSqlEngine } from '@querybara/core';
import type { ReactNode } from 'react';

import { openExportTables } from '../../state/transfer-dialogs';
import {
  targetsFor,
  type TransferDbState,
  type TransferDbWizard,
} from '../../state/transfer-db/wizard';
import { closeTransferDb } from '../../state/transfer-db/api';
import { SelectField, TextArea, TextField } from '../designer/fields';
import { Button, EnvironmentBadge, cx } from '../ui';

/** The wizard's first two steps: what to transfer, and where to. */

export interface StepProps {
  readonly wizard: TransferDbWizard;
  readonly state: TransferDbState;
}

export function Labelled(props: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-1', props.className)}>
      <label htmlFor={props.id} className="text-[11px] font-medium text-muted">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

function formatCount(count: number | undefined): string {
  return count === undefined ? '' : count.toLocaleString('en-US');
}

export function SourceStep({ wizard, state }: StepProps) {
  const { source, sourceInfo } = state;
  if (source === undefined || sourceInfo === undefined) {
    return <p className="text-xs text-muted">Reading the connection…</p>;
  }
  const noun = source.engine === 'mongodb' ? 'collection' : 'table';
  const objects = sourceInfo.objects;
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="grid grid-cols-3 gap-3">
        {source.engine !== 'redis' ? (
          <Labelled id="transfer-source-database" label="Database">
            <SelectField
              id="transfer-source-database"
              value={state.sourceDatabase ?? ''}
              onChange={(event) => void wizard.setSourceDatabase(event.target.value)}
            >
              {sourceInfo.databases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </SelectField>
          </Labelled>
        ) : (
          <p className="self-end text-muted">
            {sourceInfo.cluster ? 'Cluster' : `Database ${state.sourceDatabase ?? '0'}`} ·{' '}
            {formatCount(sourceInfo.keys)} keys
          </p>
        )}
        {source.engine === 'postgres' && (
          <Labelled id="transfer-source-schema" label="Schema">
            <SelectField
              id="transfer-source-schema"
              value={state.sourceSchema ?? 'public'}
              onChange={(event) => void wizard.setSourceSchema(event.target.value)}
            >
              {sourceInfo.schemas.map((schema) => (
                <option key={schema} value={schema}>
                  {schema}
                </option>
              ))}
            </SelectField>
          </Labelled>
        )}
      </div>
      {source.engine === 'redis' ? (
        <Labelled id="transfer-patterns" label="Key patterns, one per line (* matches any text)">
          <TextArea
            id="transfer-patterns"
            rows={4}
            value={state.keyPatterns}
            onChange={(event) => wizard.setKeyPatterns(event.target.value)}
          />
        </Labelled>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-muted">
              {state.selected.length} of {objects.length} {noun}s chosen
            </span>
            <Button size="sm" variant="ghost" onClick={() => wizard.selectAll(true)}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => wizard.selectAll(false)}>
              Select none
            </Button>
          </div>
          <div className="max-h-80 overflow-auto rounded border border-border">
            <table className="w-full text-xs" data-testid="transfer-objects">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr>
                  <th className="w-8 px-2 py-1 font-medium">
                    <span className="sr-only">Transfer</span>
                  </th>
                  <th className="px-2 py-1 font-medium">
                    {noun === 'table' ? 'Table' : 'Collection'}
                  </th>
                  <th className="px-2 py-1 text-right font-medium">Rows (estimate)</th>
                </tr>
              </thead>
              <tbody>
                {objects.map((object) => (
                  <tr key={object.name} className="border-t border-border/60">
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Transfer ${object.name}`}
                        checked={state.selected.includes(object.name)}
                        onChange={() => wizard.toggleObject(object.name)}
                      />
                    </td>
                    <td className="px-2 py-1 font-mono">{object.name}</td>
                    <td className="px-2 py-1 text-right text-muted tabular-nums">
                      {formatCount(object.rows)}
                    </td>
                  </tr>
                ))}
                {objects.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-2 py-3 text-center text-muted">
                      No {noun}s here
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function TargetStep({ wizard, state }: StepProps) {
  const { target, targetInfo, source } = state;
  const candidates = targetsFor(state);
  const sourceProfile = state.profiles.find((p) => p.id === source?.profileId);
  const exportInstead =
    source !== undefined && isSqlEngine(source.engine) && sourceProfile !== undefined;
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="grid grid-cols-3 gap-3">
        <Labelled id="transfer-target" label="Connection" className="col-span-1">
          <SelectField
            id="transfer-target"
            value={target?.profileId ?? ''}
            onChange={(event) => void wizard.chooseTarget(event.target.value)}
          >
            <option value="" disabled>
              Choose a connection…
            </option>
            {candidates.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {ENGINES[profile.engine].displayName}
                {profile.presentation.readOnly ? ' (read-only)' : ''}
              </option>
            ))}
          </SelectField>
        </Labelled>
        {target !== undefined && targetInfo !== undefined && target.engine === 'mongodb' && (
          <Labelled id="transfer-target-database" label="Database">
            <TextField
              id="transfer-target-database"
              list="transfer-target-databases"
              value={state.targetDatabase ?? ''}
              onChange={(event) => void wizard.setTargetDatabase(event.target.value)}
            />
            <datalist id="transfer-target-databases">
              {targetInfo.databases.map((db) => (
                <option key={db} value={db} />
              ))}
            </datalist>
          </Labelled>
        )}
        {target !== undefined &&
          targetInfo !== undefined &&
          target.engine !== 'mongodb' &&
          !targetInfo.cluster && (
            <Labelled id="transfer-target-database" label="Database">
              <SelectField
                id="transfer-target-database"
                value={state.targetDatabase ?? ''}
                onChange={(event) => void wizard.setTargetDatabase(event.target.value)}
              >
                <option value="" disabled>
                  Choose a database…
                </option>
                {targetInfo.databases.map((db) => (
                  <option key={db} value={db}>
                    {db}
                  </option>
                ))}
              </SelectField>
            </Labelled>
          )}
        {target?.engine === 'postgres' && targetInfo !== undefined && (
          <Labelled id="transfer-target-schema" label="Schema (created when missing)">
            <TextField
              id="transfer-target-schema"
              list="transfer-target-schemas"
              value={state.targetSchema ?? ''}
              onChange={(event) => wizard.setTargetSchema(event.target.value)}
            />
            <datalist id="transfer-target-schemas">
              {targetInfo.schemas.map((schema) => (
                <option key={schema} value={schema} />
              ))}
            </datalist>
          </Labelled>
        )}
      </div>
      {candidates.length === 0 && (
        <p className="text-muted">
          No saved connection can take data from{' '}
          {source ? ENGINES[source.engine].displayName : 'this connection'}. Add one with New
          connection.
        </p>
      )}
      {target !== undefined && (
        <p className="flex items-center gap-2 text-muted">
          Into {target.profileName}
          {state.profiles.find((p) => p.id === target.profileId) && (
            <EnvironmentBadge
              environment={
                state.profiles.find((p) => p.id === target.profileId)!.presentation.environment
              }
            />
          )}
          {targetInfo !== undefined &&
            `· ${ENGINES[targetInfo.engine].displayName} ${targetInfo.serverVersion}`}
        </p>
      )}
      {target?.production && (
        <p className="font-medium text-danger">
          This is a production connection: the transfer asks for confirmation before it writes.
        </p>
      )}
      {exportInstead && (
        <p className="text-muted">
          To write the tables to a file instead,{' '}
          <button
            type="button"
            className="text-accent underline"
            onClick={() => {
              closeTransferDb();
              openExportTables(
                sourceProfile,
                {
                  database: state.sourceDatabase,
                  schema: state.sourceSchema ?? state.sourceDatabase ?? '',
                },
                state.selected,
              );
            }}
          >
            export them
          </button>
          .
        </p>
      )}
    </div>
  );
}
