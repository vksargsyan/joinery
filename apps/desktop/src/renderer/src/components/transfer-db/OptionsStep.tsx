import type { DbTableModeInfo } from '@querybara/ipc';

import { childrenOf } from '../../state/transfer-db/wizard';
import { SelectField, TextField } from '../designer/fields';
import { Labelled, type StepProps } from './EndpointSteps';

/** The wizard's options: what happens to existing tables, batches, errors, constraints. */

export const MODES: readonly {
  readonly mode: DbTableModeInfo;
  readonly label: string;
  readonly hint: string;
}[] = [
  { mode: 'create', label: 'Create', hint: 'Create each {noun}; stop if one exists' },
  {
    mode: 'drop-create',
    label: 'Drop and create',
    hint: 'Drop {noun}s that exist, then create them',
  },
  { mode: 'truncate', label: 'Empty', hint: 'Empty {noun}s that exist (create missing ones)' },
  { mode: 'append', label: 'Append', hint: 'Add to {noun}s that exist, matching names' },
];

function Check(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: string;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
      {props.hint && <span className="text-muted">({props.hint})</span>}
    </label>
  );
}

function clamp(value: string, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number(value)) || min));
}

export function OptionsStep({ wizard, state }: StepProps) {
  const { options, source, target } = state;
  const redis = source?.engine === 'redis';
  const toMongo = target?.engine === 'mongodb';
  const toSql = !redis && !toMongo;
  const noun = toMongo ? 'collection' : 'table';
  return (
    <div className="flex flex-col gap-4 text-xs">
      {!redis && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted">
            When the target {noun} exists
          </legend>
          {MODES.map(({ mode, label, hint }) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="transfer-mode"
                checked={options.mode === mode}
                onChange={() => wizard.setOptions({ mode })}
              />
              <span className="w-32">{label}</span>
              <span className="text-muted">{hint.replaceAll('{noun}', noun)}</span>
            </label>
          ))}
          {(options.mode === 'drop-create' || options.mode === 'truncate') && (
            <p className="mt-1 text-warning">
              {options.mode === 'drop-create' ? 'Drop and create' : 'Empty'} deletes every row of
              the target {noun}s that exist now; the review lists them and asks before running.
            </p>
          )}
        </fieldset>
      )}
      {redis && (
        <div className="flex flex-col gap-1">
          <Check
            label="Replace keys that exist on the target"
            checked={options.replace}
            onChange={(replace) => wizard.setOptions({ replace })}
            hint="RESTORE … REPLACE"
          />
          <Check
            label="Keep each key's time to live"
            checked={options.keepTtl}
            onChange={(keepTtl) => wizard.setOptions({ keepTtl })}
          />
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Labelled id="transfer-batch" label={redis ? 'Keys per batch' : 'Rows per batch'}>
          <TextField
            id="transfer-batch"
            type="number"
            min={1}
            max={100000}
            value={options.batchSize}
            onChange={(e) => wizard.setOptions({ batchSize: clamp(e.target.value, 1, 100_000) })}
          />
        </Labelled>
        <Labelled
          id="transfer-parallel"
          label={redis ? 'Patterns at once' : `${noun[0]!.toUpperCase()}${noun.slice(1)}s at once`}
        >
          <TextField
            id="transfer-parallel"
            type="number"
            min={1}
            max={8}
            value={options.parallel}
            onChange={(e) => wizard.setOptions({ parallel: clamp(e.target.value, 1, 8) })}
          />
        </Labelled>
        <Labelled id="transfer-errors" label="When a row fails">
          <SelectField
            id="transfer-errors"
            value={options.onError}
            onChange={(e) => wizard.setOptions({ onError: e.target.value as 'stop' | 'skip' })}
          >
            <option value="stop">Stop the transfer</option>
            <option value="skip">Log it and go on</option>
          </SelectField>
        </Labelled>
      </div>
      {toSql && (
        <div className="flex flex-col gap-1">
          <Check
            label="A transaction per batch"
            checked={options.transactionPerBatch}
            onChange={(transactionPerBatch) => wizard.setOptions({ transactionPerBatch })}
          />
          <Check
            label="Keys, indexes and foreign keys after the data (faster)"
            checked={options.deferConstraints}
            onChange={(deferConstraints) => wizard.setOptions({ deferConstraints })}
          />
          <Check
            label="Turn off foreign key checks and triggers during the load"
            checked={options.disableConstraints}
            onChange={(disableConstraints) => wizard.setOptions({ disableConstraints })}
            hint={
              target?.engine === 'postgres'
                ? 'needs a superuser'
                : 'MySQL cannot turn triggers off; foreign key checks only'
            }
          />
          <Check
            label="Move sequences and AUTO_INCREMENT counters past the copied values"
            checked={options.resetSequences}
            onChange={(resetSequences) => wizard.setOptions({ resetSequences })}
          />
        </div>
      )}
      {source?.engine === 'mongodb' && (
        <Labelled
          id="transfer-sample"
          label="Documents sampled for the columns and types"
          className="w-64"
        >
          <TextField
            id="transfer-sample"
            type="number"
            min={1}
            max={100000}
            value={options.sampleSize}
            onChange={(e) => wizard.setOptions({ sampleSize: clamp(e.target.value, 1, 100_000) })}
          />
        </Labelled>
      )}
      {toMongo && (
        <div className="flex flex-col gap-2">
          <Check
            label="A single-column primary key becomes _id"
            checked={options.idFromPrimaryKey}
            onChange={(idFromPrimaryKey) => wizard.setOptions({ idFromPrimaryKey })}
          />
          <fieldset className="flex flex-col gap-1" data-testid="transfer-embeds">
            <legend className="mb-1 text-[11px] font-medium text-muted">
              Embed child rows (an array of sub-documents per parent, through a foreign key)
            </legend>
            {state.selected.map((table) => {
              const children = childrenOf(state, table);
              if (children.length === 0) return null;
              const embeds = state.edits[table]?.embed ?? [];
              return (
                <div key={table} className="flex flex-col gap-1">
                  <span className="font-mono">{table}</span>
                  {children.map((child) => {
                    const on = embeds.find(
                      (e) => e.foreignKey === child.foreignKey && e.table === child.table,
                    );
                    return (
                      <div
                        key={`${child.table}.${child.foreignKey}`}
                        className="ml-4 flex items-center gap-2"
                      >
                        <Check
                          label={`${child.table} (${child.foreignKey})`}
                          checked={on !== undefined}
                          onChange={() => wizard.toggleEmbed(table, child)}
                        />
                        {on && (
                          <TextField
                            className="w-40"
                            aria-label={`Field for ${child.table} in ${table}`}
                            value={on.field}
                            onChange={(e) =>
                              wizard.setEmbedField(table, child.foreignKey, e.target.value)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {state.selected.every((table) => childrenOf(state, table).length === 0) && (
              <p className="text-muted">No other table has a foreign key to the chosen tables.</p>
            )}
          </fieldset>
        </div>
      )}
    </div>
  );
}
