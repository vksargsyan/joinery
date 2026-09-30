import type {
  CheckDef,
  ForeignKeyDef,
  IndexColumn,
  IndexDef,
  KeyDef,
  ReferentialAction,
  TriggerDef,
} from '@joinery/core';
import type { ValidationIssue } from '@joinery/sync';
import type { ReactNode } from 'react';

import {
  addListRow,
  freshName,
  issuesAt,
  removeListRow,
  updateListRow,
  type DesignerForm,
  type FormRow,
  type ListName,
} from '../../state/designer/form';
import { useDesignerState, type TableDesigner } from '../../state/designer';
import { Button, Icon } from '../ui';
import {
  Issues,
  Labeled,
  SelectField,
  TextArea,
  TextField,
  namesOf,
  splitTopLevel,
} from './fields';

/**
 * The designer's key and constraint tabs (spec §8): indexes, foreign keys, unique and check
 * constraints, triggers and partitions. Rows keep their identity, so a renamed index or
 * constraint is renamed on save rather than dropped and re-created.
 */

interface TabProps {
  readonly designer: TableDesigner;
  readonly form: DesignerForm;
  readonly issues: readonly ValidationIssue[];
}

const ACTIONS: readonly ReferentialAction[] = [
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
];

function RowList<T extends { readonly name: string }>(props: {
  readonly title: string;
  readonly addLabel: string;
  readonly rows: readonly FormRow<T>[];
  readonly list: ListName;
  readonly designer: TableDesigner;
  readonly form: DesignerForm;
  readonly issues: readonly ValidationIssue[];
  /** The path prefix of the list in the edited table, e.g. `indexes`. */
  readonly path: string;
  readonly create: () => T;
  readonly render: (
    row: FormRow<T>,
    index: number,
    update: (def: T) => void,
    invalid: (field: string) => boolean,
  ) => ReactNode;
  readonly empty: string;
}) {
  const { designer, form } = props;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => designer.setForm(addListRow(form, props.list, props.create() as never))}
        >
          <Icon name="plus" className="h-3 w-3" />
          {props.addLabel}
        </Button>
        <span className="text-[11px] text-muted">{props.title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {props.rows.length === 0 && <p className="text-xs text-muted">{props.empty}</p>}
        <ul className="flex flex-col gap-2">
          {props.rows.map((row, i) => {
            const path = `${props.path}[${i}]`;
            const renamed = row.liveName !== null && row.liveName !== row.def.name;
            return (
              <li
                key={row.id}
                className="rounded border border-border p-2"
                data-testid={`design-${props.list}`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                    {props.render(
                      row,
                      i,
                      (def) =>
                        designer.setForm(updateListRow(form, props.list, row.id, def as never)),
                      (field) => issuesAt(props.issues, `${path}.${field}`).length > 0,
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${row.def.name}`}
                    className="rounded px-1 text-danger hover:bg-hover"
                    onClick={() => designer.setForm(removeListRow(form, props.list, row.id))}
                  >
                    ×
                  </button>
                </div>
                {renamed && (
                  <p className="mt-1 text-[10px] text-muted">renamed from {row.liveName}</p>
                )}
                <Issues issues={issuesAt(props.issues, path)} className="mt-1" />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** "a, b DESC, (lower(email))" ↔ index columns. */
function indexColumnsText(columns: readonly IndexColumn[]): string {
  return columns
    .map((c) => `${c.name ?? `(${c.expression ?? ''})`}${c.order === 'desc' ? ' DESC' : ''}`)
    .join(', ');
}

function parseIndexColumns(text: string): IndexColumn[] {
  return splitTopLevel(text).map((item) => {
    const desc = /\s+desc$/i.test(item);
    const body = item.replace(/\s+(asc|desc)$/i, '').trim();
    const expression = /^\((.*)\)$/s.exec(body)?.[1];
    return expression !== undefined
      ? { name: null, expression, order: desc ? 'desc' : 'asc' }
      : { name: body, order: desc ? 'desc' : 'asc' };
  });
}

export function IndexesTab(props: TabProps) {
  const { form } = props;
  const pg = form.engine === 'postgres';
  const methods = pg
    ? ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']
    : ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL'];
  return (
    <RowList<IndexDef>
      {...props}
      title="Indexes"
      addLabel="Add index"
      list="indexes"
      path="indexes"
      rows={form.indexes}
      empty="No indexes besides the primary key."
      create={() => ({
        name: freshName(form, 'indexes', 'idx'),
        columns: [{ name: form.columns[0]?.def.name ?? 'id', order: 'asc' }],
        unique: false,
        include: [],
        invisible: false,
      })}
      render={(row, i, update, invalid) => (
        <>
          <Labeled label="Name" className="w-48">
            <TextField
              mono
              aria-label={`Index ${i + 1} name`}
              invalid={invalid('name')}
              value={row.def.name}
              onChange={(e) => update({ ...row.def, name: e.target.value })}
            />
          </Labeled>
          <Labeled label="Columns or (expressions)" className="min-w-56 flex-1">
            <TextField
              key={indexColumnsText(row.def.columns)}
              mono
              aria-label={`Index ${i + 1} columns`}
              invalid={invalid('columns')}
              defaultValue={indexColumnsText(row.def.columns)}
              onBlur={(e) => update({ ...row.def, columns: parseIndexColumns(e.target.value) })}
            />
          </Labeled>
          <label className="flex h-7 items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={row.def.unique}
              onChange={(e) => update({ ...row.def, unique: e.target.checked })}
            />
            Unique
          </label>
          <Labeled label="Method" className="w-28">
            <SelectField
              aria-label={`Index ${i + 1} method`}
              value={row.def.method ?? ''}
              onChange={(e) => {
                const { method: _method, ...rest } = row.def;
                update(e.target.value === '' ? rest : { ...rest, method: e.target.value });
              }}
            >
              <option value="">default</option>
              {methods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </SelectField>
          </Labeled>
          {pg && (
            <>
              <Labeled label="Where (partial index)" className="w-56">
                <TextField
                  mono
                  aria-label={`Index ${i + 1} predicate`}
                  invalid={invalid('where')}
                  value={row.def.where ?? ''}
                  onChange={(e) => {
                    const { where: _where, ...rest } = row.def;
                    update(e.target.value === '' ? rest : { ...rest, where: e.target.value });
                  }}
                />
              </Labeled>
              <Labeled label="Include" className="w-40">
                <TextField
                  mono
                  aria-label={`Index ${i + 1} include`}
                  value={row.def.include.join(', ')}
                  onChange={(e) => update({ ...row.def, include: namesOf(e.target.value) })}
                />
              </Labeled>
            </>
          )}
          {!pg && (
            <label className="flex h-7 items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={row.def.invisible}
                onChange={(e) => update({ ...row.def, invisible: e.target.checked })}
              />
              Invisible
            </label>
          )}
        </>
      )}
    />
  );
}

export function ForeignKeysTab(props: TabProps) {
  const { form } = props;
  const snapshot = useDesignerState(props.designer, (s) => s.snapshot);
  const pg = form.engine === 'postgres';
  const tables =
    snapshot?.schemas.flatMap((s) => s.tables.map((t) => ({ schema: s.name, name: t.name }))) ?? [];
  return (
    <RowList<ForeignKeyDef>
      {...props}
      title="Foreign keys"
      addLabel="Add foreign key"
      list="foreignKeys"
      path="foreignKeys"
      rows={form.foreignKeys}
      empty="No foreign keys."
      create={() => ({
        name: freshName(form, 'foreignKeys', 'fk'),
        columns: [form.columns.at(-1)?.def.name ?? ''],
        refTable: tables[0]?.name ?? '',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      })}
      render={(row, i, update, invalid) => (
        <>
          <Labeled label="Name" className="w-44">
            <TextField
              mono
              aria-label={`Foreign key ${i + 1} name`}
              invalid={invalid('name')}
              value={row.def.name}
              onChange={(e) => update({ ...row.def, name: e.target.value })}
            />
          </Labeled>
          <Labeled label="Columns" className="w-40">
            <TextField
              key={row.def.columns.join(', ')}
              mono
              aria-label={`Foreign key ${i + 1} columns`}
              invalid={invalid('columns')}
              defaultValue={row.def.columns.join(', ')}
              onBlur={(e) => update({ ...row.def, columns: namesOf(e.target.value) })}
            />
          </Labeled>
          <Labeled label="References table" className="w-48">
            <SelectField
              aria-label={`Foreign key ${i + 1} referenced table`}
              invalid={invalid('refTable')}
              value={`${row.def.refSchema ?? ''}\u0000${row.def.refTable}`}
              onChange={(e) => {
                const [schema, name] = e.target.value.split('\u0000') as [string, string];
                const { refSchema: _refSchema, ...rest } = row.def;
                update(
                  schema === ''
                    ? { ...rest, refTable: name }
                    : { ...rest, refSchema: schema, refTable: name },
                );
              }}
            >
              {!tables.some((t) => t.name === row.def.refTable) && (
                <option value={`${row.def.refSchema ?? ''}\u0000${row.def.refTable}`}>
                  {row.def.refTable || 'Choose…'}
                </option>
              )}
              {row.def.refTable === form.name && (
                <option value={`\u0000${form.name}`}>{form.name} (this table)</option>
              )}
              {tables.map((t) => {
                const home = !pg || t.schema === props.designer.target.schema;
                return (
                  <option
                    key={`${t.schema}.${t.name}`}
                    value={`${home ? '' : t.schema}\u0000${t.name}`}
                  >
                    {home ? t.name : `${t.schema}.${t.name}`}
                  </option>
                );
              })}
            </SelectField>
          </Labeled>
          <Labeled label="Referenced columns" className="w-40">
            <TextField
              key={row.def.refColumns.join(', ')}
              mono
              aria-label={`Foreign key ${i + 1} referenced columns`}
              invalid={invalid('refColumns')}
              defaultValue={row.def.refColumns.join(', ')}
              onBlur={(e) => update({ ...row.def, refColumns: namesOf(e.target.value) })}
            />
          </Labeled>
          <Labeled label="On update" className="w-32">
            <SelectField
              aria-label={`Foreign key ${i + 1} on update`}
              value={row.def.onUpdate}
              onChange={(e) =>
                update({ ...row.def, onUpdate: e.target.value as ReferentialAction })
              }
            >
              {ACTIONS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </SelectField>
          </Labeled>
          <Labeled label="On delete" className="w-32">
            <SelectField
              aria-label={`Foreign key ${i + 1} on delete`}
              value={row.def.onDelete}
              onChange={(e) =>
                update({ ...row.def, onDelete: e.target.value as ReferentialAction })
              }
            >
              {ACTIONS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </SelectField>
          </Labeled>
          {pg && (
            <Labeled label="Deferrable" className="w-40">
              <SelectField
                aria-label={`Foreign key ${i + 1} deferrable`}
                value={row.def.deferrable ?? 'not-deferrable'}
                onChange={(e) => {
                  const { deferrable: _deferrable, ...rest } = row.def;
                  const value = e.target.value as NonNullable<ForeignKeyDef['deferrable']>;
                  update(value === 'not-deferrable' ? rest : { ...rest, deferrable: value });
                }}
              >
                <option value="not-deferrable">Not deferrable</option>
                <option value="initially-immediate">Initially immediate</option>
                <option value="initially-deferred">Initially deferred</option>
              </SelectField>
            </Labeled>
          )}
        </>
      )}
    />
  );
}

export function UniquesTab(props: TabProps) {
  const { form } = props;
  return (
    <RowList<KeyDef>
      {...props}
      title={
        form.engine === 'postgres'
          ? 'Unique constraints'
          : 'Unique keys (created as unique indexes)'
      }
      addLabel="Add unique constraint"
      list="uniques"
      path="uniques"
      rows={form.uniques}
      empty="No unique constraints."
      create={() => ({
        name: freshName(form, 'uniques', 'key'),
        columns: [form.columns.at(-1)?.def.name ?? ''],
      })}
      render={(row, i, update, invalid) => (
        <>
          <Labeled label="Name" className="w-56">
            <TextField
              mono
              aria-label={`Unique ${i + 1} name`}
              invalid={invalid('name')}
              value={row.def.name}
              onChange={(e) => update({ ...row.def, name: e.target.value })}
            />
          </Labeled>
          <Labeled label="Columns" className="min-w-56 flex-1">
            <TextField
              key={row.def.columns.join(', ')}
              mono
              aria-label={`Unique ${i + 1} columns`}
              invalid={invalid('columns')}
              defaultValue={row.def.columns.join(', ')}
              onBlur={(e) => update({ ...row.def, columns: namesOf(e.target.value) })}
            />
          </Labeled>
        </>
      )}
    />
  );
}

export function ChecksTab(props: TabProps) {
  const { form } = props;
  return (
    <RowList<CheckDef>
      {...props}
      title="Check constraints"
      addLabel="Add check"
      list="checks"
      path="checks"
      rows={form.checks}
      empty="No check constraints."
      create={() => ({ name: freshName(form, 'checks', 'check'), expression: '' })}
      render={(row, i, update, invalid) => (
        <>
          <Labeled label="Name" className="w-56">
            <TextField
              mono
              aria-label={`Check ${i + 1} name`}
              invalid={invalid('name')}
              value={row.def.name}
              onChange={(e) => update({ ...row.def, name: e.target.value })}
            />
          </Labeled>
          <Labeled label="Condition" className="min-w-64 flex-1">
            <TextField
              mono
              aria-label={`Check ${i + 1} condition`}
              invalid={invalid('expression')}
              placeholder="price >= 0"
              value={row.def.expression}
              onChange={(e) => update({ ...row.def, expression: e.target.value })}
            />
          </Labeled>
        </>
      )}
    />
  );
}

const EVENTS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

function triggerTemplate(form: DesignerForm, name: string, designer: TableDesigner): string {
  if (form.engine === 'postgres') {
    return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${designer.target.schema}.${form.name} FOR EACH ROW EXECUTE FUNCTION my_function()`;
  }
  return `CREATE TRIGGER ${name} BEFORE UPDATE ON ${form.name} FOR EACH ROW SET NEW.updated_at = NOW()`;
}

export function TriggersTab(props: TabProps) {
  const { form, designer } = props;
  return (
    <RowList<TriggerDef>
      {...props}
      title="Triggers (the definition is the full CREATE TRIGGER statement)"
      addLabel="Add trigger"
      list="triggers"
      path="triggers"
      rows={form.triggers}
      empty="No triggers."
      create={() => {
        const name = freshName(form, 'triggers', 'trg');
        return {
          name,
          timing: 'BEFORE',
          events: ['UPDATE'],
          definition: triggerTemplate(form, name, designer),
        };
      }}
      render={(row, i, update, invalid) => (
        <>
          <Labeled label="Name" className="w-48">
            <TextField
              mono
              aria-label={`Trigger ${i + 1} name`}
              invalid={invalid('name')}
              value={row.def.name}
              onChange={(e) => update({ ...row.def, name: e.target.value })}
            />
          </Labeled>
          <Labeled label="Timing" className="w-28">
            <SelectField
              aria-label={`Trigger ${i + 1} timing`}
              value={row.def.timing}
              onChange={(e) =>
                update({ ...row.def, timing: e.target.value as TriggerDef['timing'] })
              }
            >
              <option>BEFORE</option>
              <option>AFTER</option>
              {form.engine === 'postgres' && <option>INSTEAD OF</option>}
            </SelectField>
          </Labeled>
          <div
            className="flex h-7 items-center gap-2 text-xs"
            role="group"
            aria-label={`Trigger ${i + 1} events`}
          >
            {EVENTS.filter((e) => form.engine === 'postgres' || e !== 'TRUNCATE').map((event) => (
              <label key={event} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={row.def.events.includes(event)}
                  onChange={(e) =>
                    update({
                      ...row.def,
                      events: e.target.checked
                        ? EVENTS.filter((x) => x === event || row.def.events.includes(x))
                        : row.def.events.filter((x) => x !== event),
                    })
                  }
                />
                {event}
              </label>
            ))}
          </div>
          <Labeled label="Definition" className="w-full">
            <TextArea
              rows={3}
              aria-label={`Trigger ${i + 1} definition`}
              invalid={invalid('definition')}
              value={row.def.definition}
              onChange={(e) => update({ ...row.def, definition: e.target.value })}
            />
          </Labeled>
        </>
      )}
    />
  );
}

export function PartitionsTab(props: TabProps) {
  const { form, designer, issues } = props;
  const partitioning = form.partitioning;
  const pg = form.engine === 'postgres';
  const methods = pg ? ['RANGE', 'LIST', 'HASH'] : ['RANGE', 'LIST', 'HASH', 'KEY'];
  const set = (next: DesignerForm['partitioning']): void =>
    designer.setForm({
      ...form,
      partitioning: next,
      kind: pg ? (next ? 'partitioned' : 'table') : form.kind,
    });
  return (
    <div className="flex flex-col gap-2 p-2 text-xs">
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={partitioning !== null}
          onChange={(e) =>
            set(
              e.target.checked
                ? {
                    method: 'RANGE',
                    key: form.columns[0] ? `(${form.columns[0].def.name})` : '',
                    partitions: [],
                  }
                : null,
            )
          }
        />
        Partitioned table
      </label>
      {partitioning && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Labeled label="Method" className="w-28">
              <SelectField
                aria-label="Partition method"
                value={partitioning.method}
                onChange={(e) => set({ ...partitioning, method: e.target.value })}
              >
                {methods.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </SelectField>
            </Labeled>
            <Labeled label="Key" className="min-w-56 flex-1">
              <TextField
                mono
                aria-label="Partition key"
                invalid={issuesAt(issues, 'partitioning.key').length > 0}
                value={partitioning.key}
                onChange={(e) => set({ ...partitioning, key: e.target.value })}
              />
            </Labeled>
          </div>
          <Issues
            issues={issuesAt(issues, 'partitioning', { exact: true }).concat(
              issuesAt(issues, 'partitioning.key'),
            )}
          />
          <h4 className="font-semibold">Partitions</h4>
          {partitioning.partitions.map((p, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-end gap-2">
                <Labeled label="Name" className="w-44">
                  <TextField
                    mono
                    aria-label={`Partition ${i + 1} name`}
                    value={p.name}
                    onChange={(e) =>
                      set({
                        ...partitioning,
                        partitions: partitioning.partitions.map((x, k) =>
                          k === i ? { ...x, name: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Labeled>
                <Labeled
                  label={pg ? 'Bound (FOR VALUES …)' : 'Bound (VALUES …)'}
                  className="min-w-64 flex-1"
                >
                  <TextField
                    mono
                    aria-label={`Partition ${i + 1} bound`}
                    value={p.bound ?? ''}
                    onChange={(e) =>
                      set({
                        ...partitioning,
                        partitions: partitioning.partitions.map((x, k) =>
                          k === i
                            ? e.target.value === ''
                              ? { name: x.name }
                              : { ...x, bound: e.target.value }
                            : x,
                        ),
                      })
                    }
                  />
                </Labeled>
                <button
                  type="button"
                  aria-label={`Remove partition ${i + 1}`}
                  className="rounded px-1 text-danger hover:bg-hover"
                  onClick={() =>
                    set({
                      ...partitioning,
                      partitions: partitioning.partitions.filter((_x, k) => k !== i),
                    })
                  }
                >
                  ×
                </button>
              </div>
              <Issues issues={issuesAt(issues, `partitioning.partitions[${i}]`)} />
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() =>
              set({
                ...partitioning,
                partitions: [
                  ...partitioning.partitions,
                  { name: `${form.name}_p${partitioning.partitions.length + 1}` },
                ],
              })
            }
          >
            <Icon name="plus" className="h-3 w-3" />
            Add partition
          </Button>
        </>
      )}
    </div>
  );
}
