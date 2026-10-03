import type { DbTableModeInfo, PlannedColumnInfo, PlannedTableInfo } from '@querybara/ipc';

import { MONGO_FIELD_TYPES, type TransferDbWizard } from '../../state/transfer-db/wizard';
import { SelectField, TextField } from '../designer/fields';
import { cx } from '../ui';
import type { StepProps } from './EndpointSteps';
import { MODES } from './OptionsStep';

/**
 * Column and type mapping (spec §12): every target table (collection, child table) with its
 * columns, the type the engine pair's mapping table picked and why, and the user's changes:
 * names, types, columns left out, and for MongoDB fields whether they flatten, stay JSON or
 * become a child table. Each change is planned again by the job runner.
 */

const SHAPE_LABELS = { columns: 'Columns', json: 'JSON column', child: 'Child table' } as const;

function actionLabel(table: PlannedTableInfo): string {
  if (!table.exists) return 'created';
  switch (table.action) {
    case 'drop-create':
      return 'exists: dropped and created again';
    case 'truncate':
      return 'exists: emptied first';
    case 'append':
      return 'exists: rows added';
    default:
      return 'exists';
  }
}

export function MappingStep({ wizard, state }: StepProps) {
  const plan = state.plan;
  if (plan === undefined) {
    return <p className="text-xs text-muted">{state.planError ?? 'Planning the transfer…'}</p>;
  }
  // Child tables follow their collection: their changes belong to it.
  const owners: string[] = [];
  for (const table of plan.tables) {
    owners.push(table.kind === 'child-table' ? (owners.at(-1) ?? table.source) : table.source);
  }
  return (
    <div className="flex flex-col gap-4 text-xs" data-testid="transfer-mapping">
      {plan.tables.map((table, i) => (
        <TableMapping
          key={`${table.source}→${table.target}`}
          wizard={wizard}
          table={table}
          owner={owners[i]!}
          toMongo={plan.targetEngine === 'mongodb'}
          mode={state.edits[owners[i]!]?.mode}
        />
      ))}
    </div>
  );
}

function TableMapping(props: {
  readonly wizard: TransferDbWizard;
  readonly table: PlannedTableInfo;
  readonly owner: string;
  readonly toMongo: boolean;
  readonly mode: DbTableModeInfo | undefined;
}) {
  const { wizard, table, owner, toMongo } = props;
  const child = table.kind === 'child-table';
  return (
    <section
      className="rounded border border-border"
      aria-label={`${table.source} to ${table.target}`}
      data-testid="transfer-table"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-panel-2 px-2 py-1.5">
        <span className="font-mono">{table.source}</span>
        <span className="text-muted">→</span>
        <TextField
          className="w-56"
          mono
          aria-label={`Target name of ${table.source}`}
          defaultValue={table.target}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name === table.target) return;
            // A child table is named through its array field.
            if (child)
              wizard.setColumn(owner, table.source.slice(owner.length + 1), { target: name });
            else wizard.setTargetName(owner, name);
          }}
        />
        <span
          className={cx('text-muted', table.exists && table.action !== 'append' && 'text-warning')}
        >
          {child ? `child table of ${table.parent ?? ''}, ` : ''}
          {actionLabel(table)}
          {table.rows !== undefined ? ` · about ${table.rows.toLocaleString('en-US')} rows` : ''}
        </span>
        {!child && (
          <SelectField
            className="ml-auto w-44"
            aria-label={`Mode for ${table.source}`}
            value={props.mode ?? ''}
            onChange={(event) =>
              wizard.setObjectMode(
                owner,
                (event.target.value || undefined) as DbTableModeInfo | undefined,
              )
            }
          >
            <option value="">The transfer&apos;s mode</option>
            {MODES.map(({ mode, label }) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </SelectField>
        )}
      </header>
      {table.embeds !== undefined && table.embeds.length > 0 && (
        <p className="px-2 pt-1 text-muted">
          Embeds {table.embeds.map((e) => `${e.table} as ${e.field}`).join(', ')}
        </p>
      )}
      {[...table.problems, ...table.warnings].length > 0 && (
        <ul className="px-2 pt-1">
          {table.problems.map((p) => (
            <li key={p} className="text-danger" role="alert">
              {p}
            </li>
          ))}
          {table.warnings.map((w) => (
            <li key={w} className="text-warning">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              <th className="px-2 py-1 font-medium">Source</th>
              <th className="px-2 py-1 font-medium">Source type</th>
              <th className="px-2 py-1 font-medium">{toMongo ? 'Field' : 'Column'}</th>
              <th className="px-2 py-1 font-medium">{toMongo ? 'BSON type' : 'Type'}</th>
              <th className="px-2 py-1 font-medium">Copy</th>
              <th className="px-2 py-1 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column) => (
              <ColumnRow
                key={column.source}
                wizard={wizard}
                owner={owner}
                column={column}
                toMongo={toMongo}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ColumnRow(props: {
  readonly wizard: TransferDbWizard;
  readonly owner: string;
  readonly column: PlannedColumnInfo;
  readonly toMongo: boolean;
}) {
  const { wizard, owner, column, toMongo } = props;
  const set = (patch: Parameters<TransferDbWizard['setColumn']>[2]): void =>
    wizard.setColumn(owner, column.source, patch);
  // A sub-document flattened into columns, or an array that became a child table.
  const group = column.target === '' && column.shape !== undefined;
  const internal = column.source.endsWith('._parent') || column.source.endsWith('._index');
  return (
    <tr className={cx('border-t border-border/60', column.skipped && 'text-muted')}>
      <td className="px-2 py-1 font-mono">{column.source}</td>
      <td className="px-2 py-1 font-mono text-muted">{column.sourceType}</td>
      <td className="px-2 py-1">
        {!group && (
          <TextField
            mono
            aria-label={`Target name of ${column.source}`}
            disabled={!column.editable || column.skipped || internal || (column.key && toMongo)}
            defaultValue={column.target}
            onBlur={(event) => {
              if (event.target.value.trim() !== column.target)
                set({ target: event.target.value.trim() });
            }}
          />
        )}
      </td>
      <td className="px-2 py-1">
        {group ? null : toMongo ? (
          <SelectField
            aria-label={`Target type of ${column.source}`}
            value={column.targetType}
            disabled={column.skipped}
            onChange={(event) => set({ dataType: event.target.value })}
          >
            {MONGO_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
                {type === column.defaultType ? ' (default)' : ''}
              </option>
            ))}
          </SelectField>
        ) : (
          <TextField
            mono
            aria-label={`Target type of ${column.source}`}
            disabled={!column.editable || column.skipped || internal}
            defaultValue={column.targetType}
            placeholder={column.defaultType}
            onBlur={(event) => {
              if (event.target.value.trim() !== column.targetType)
                set({ dataType: event.target.value.trim() });
            }}
          />
        )}
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-2">
          {!internal && !(column.key && toMongo) && (
            <input
              type="checkbox"
              aria-label={`Copy ${column.source}`}
              checked={!column.skipped}
              disabled={column.key && !toMongo && column.editable === false}
              onChange={(event) => set({ skip: !event.target.checked })}
            />
          )}
          {column.shape !== undefined && (
            <SelectField
              className="w-28"
              aria-label={`How ${column.source} lands`}
              value={column.shape}
              onChange={(event) => set({ shape: event.target.value as PlannedColumnInfo['shape'] })}
            >
              <option value="json">{SHAPE_LABELS.json}</option>
              {column.sourceType.includes('object') && (
                <option value="columns">{SHAPE_LABELS.columns}</option>
              )}
              {column.sourceType.includes('array') && (
                <option value="child">{SHAPE_LABELS.child}</option>
              )}
            </SelectField>
          )}
        </div>
      </td>
      <td className="px-2 py-1 text-muted">{column.note ?? (column.key ? 'Key' : '')}</td>
    </tr>
  );
}
