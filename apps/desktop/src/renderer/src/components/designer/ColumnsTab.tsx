import type { ColumnDef, SqlEngineId } from '@joinery/core';
import {
  findType,
  formatType,
  parseType,
  typeCatalog,
  type ParsedType,
  type TypeCatalogEntry,
  type TypeCategory,
  type ValidationIssue,
} from '@joinery/sync';
import { useMemo } from 'react';

import {
  addColumn,
  issuesAt,
  moveColumn,
  removeColumn,
  renameColumn,
  togglePrimaryKey,
  updateColumn,
  type DesignerForm,
} from '../../state/designer/form';
import { useDesignerState, type TableDesigner } from '../../state/designer';
import { Button, Icon, cx } from '../ui';
import { Issues, Labeled, SelectField, TextArea, TextField } from './fields';

/**
 * The Columns tab (spec §8): one row per column — name, type, NOT NULL, key, default,
 * comment — added, removed and reordered in place; renaming a row keeps it the same column, so
 * saving renames it. The selected row's details below edit the type's parameters, identity or
 * AUTO_INCREMENT, generated expressions, character set and collation.
 */

const CATEGORY_LABELS: Readonly<Record<TypeCategory, string>> = {
  numeric: 'Numeric',
  text: 'Text',
  binary: 'Binary',
  'date-time': 'Date and time',
  json: 'JSON',
  spatial: 'Spatial',
  other: 'Other',
};

export function useTypeCatalog(designer: TableDesigner): TypeCatalogEntry[] {
  const engine = useDesignerState(designer, (s) => s.engine);
  const version = useDesignerState(designer, (s) => s.serverVersion);
  const snapshot = useDesignerState(designer, (s) => s.snapshot);
  return useMemo(
    () => (engine ? typeCatalog(engine, version, snapshot) : []),
    [engine, version, snapshot],
  );
}

export function ColumnsTab(props: {
  readonly designer: TableDesigner;
  readonly form: DesignerForm;
  readonly issues: readonly ValidationIssue[];
}) {
  const { designer, form, issues } = props;
  const selected = useDesignerState(designer, (s) => s.selectedColumn);
  const catalog = useTypeCatalog(designer);
  const primary = new Set(form.primaryKey?.def.columns ?? []);
  const set = (next: DesignerForm): void => designer.setForm(next);
  const selectedIndex = form.columns.findIndex((c) => c.id === selected);
  const selectedRow = form.columns[selectedIndex];
  const listId = `types-${designer.id}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const { form: next, id } = addColumn(form);
            set(next);
            designer.selectColumn(id);
          }}
        >
          <Icon name="plus" className="h-3 w-3" />
          Add column
        </Button>
        <span className="text-[11px] text-muted">
          {form.columns.length} {form.columns.length === 1 ? 'column' : 'columns'}
        </span>
      </div>
      <datalist id={listId}>
        {catalog.map((entry) => (
          <option key={entry.name} value={entry.name} />
        ))}
      </datalist>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs" aria-label="Columns">
          <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] text-muted">
            <tr>
              <th className="w-8 px-1 py-1 font-medium">#</th>
              <th className="px-1 py-1 font-medium">Name</th>
              <th className="px-1 py-1 font-medium">Type</th>
              <th className="w-16 px-1 py-1 text-center font-medium">Not null</th>
              <th className="w-12 px-1 py-1 text-center font-medium">Key</th>
              <th className="px-1 py-1 font-medium">Default</th>
              <th className="px-1 py-1 font-medium">Comment</th>
              <th className="w-20 px-1 py-1" />
            </tr>
          </thead>
          <tbody>
            {form.columns.map((row, i) => {
              const path = `columns[${i}]`;
              const rowIssues = issuesAt(issues, path);
              const at = (field: string): boolean =>
                issuesAt(issues, `${path}.${field}`).length > 0;
              const renamed = row.liveName !== null && row.liveName !== row.def.name;
              return (
                <tr
                  key={row.id}
                  data-testid="design-column"
                  className={cx(
                    'border-b border-border/60 align-top',
                    row.id === selected && 'bg-accent/10',
                    rowIssues.some((x) => x.severity === 'error') && 'bg-danger/5',
                  )}
                  onFocusCapture={() => designer.selectColumn(row.id)}
                  onClick={() => designer.selectColumn(row.id)}
                >
                  <td className="px-1 py-1 text-muted">{i + 1}</td>
                  <td className="px-1 py-1">
                    <TextField
                      mono
                      aria-label={`Column ${i + 1} name`}
                      value={row.def.name}
                      invalid={at('name')}
                      onChange={(event) => set(renameColumn(form, row.id, event.target.value))}
                    />
                    {renamed && (
                      <span className="text-[10px] text-muted">renamed from {row.liveName}</span>
                    )}
                    {row.liveName === null && form.liveName !== null && (
                      <span className="text-[10px] text-success">new</span>
                    )}
                    <Issues issues={rowIssues} className="mt-0.5" />
                  </td>
                  <td className="px-1 py-1">
                    <TextField
                      mono
                      list={listId}
                      aria-label={`Column ${i + 1} type`}
                      value={row.def.dataType}
                      invalid={at('dataType')}
                      onChange={(event) =>
                        set(updateColumn(form, row.id, { dataType: event.target.value }))
                      }
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`Column ${i + 1} not null`}
                      checked={!row.def.nullable}
                      onChange={(event) =>
                        set(updateColumn(form, row.id, { nullable: !event.target.checked }))
                      }
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`Column ${i + 1} in primary key`}
                      checked={primary.has(row.def.name)}
                      onChange={() => set(togglePrimaryKey(form, row.def.name))}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <TextField
                      mono
                      aria-label={`Column ${i + 1} default`}
                      placeholder={row.def.identity || row.def.autoIncrement ? 'auto' : 'none'}
                      value={row.def.default ?? ''}
                      invalid={at('default')}
                      onChange={(event) =>
                        set(
                          updateColumn(form, row.id, {
                            default: event.target.value === '' ? null : event.target.value,
                          }),
                        )
                      }
                    />
                  </td>
                  <td className="px-1 py-1">
                    <TextField
                      aria-label={`Column ${i + 1} comment`}
                      value={row.def.comment ?? ''}
                      onChange={(event) =>
                        set(
                          updateColumn(form, row.id, {
                            comment: event.target.value === '' ? undefined : event.target.value,
                          }),
                        )
                      }
                    />
                  </td>
                  <td className="px-1 py-1 whitespace-nowrap">
                    <button
                      type="button"
                      aria-label={`Move column ${i + 1} up`}
                      disabled={i === 0}
                      className="rounded px-1 text-muted hover:bg-hover disabled:opacity-30"
                      onClick={() => set(moveColumn(form, row.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move column ${i + 1} down`}
                      disabled={i === form.columns.length - 1}
                      className="rounded px-1 text-muted hover:bg-hover disabled:opacity-30"
                      onClick={() => set(moveColumn(form, row.id, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove column ${i + 1}`}
                      className="rounded px-1 text-danger hover:bg-hover"
                      onClick={(event) => {
                        // The row goes away: show the details of its neighbour instead.
                        event.stopPropagation();
                        const neighbour = form.columns[i + 1] ?? form.columns[i - 1];
                        set(removeColumn(form, row.id));
                        designer.selectColumn(neighbour?.id);
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {form.columns.length === 0 && (
          <p className="p-3 text-xs text-muted">No columns yet. Add one to start.</p>
        )}
      </div>
      {selectedRow && form.engine && (
        <ColumnDetails
          key={selectedRow.id}
          engine={form.engine}
          catalog={catalog}
          column={selectedRow.def}
          index={selectedIndex}
          issues={issues}
          onChange={(patch) => set(updateColumn(form, selectedRow.id, patch))}
        />
      )}
    </div>
  );
}

const PG_INTERVAL_FIELDS = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'year to month',
  'day to hour',
  'day to minute',
  'day to second',
  'hour to minute',
  'hour to second',
  'minute to second',
];

/** Defaults for a type's required parameters when the type is picked from the list. */
function seedParameters(entry: TypeCatalogEntry): ParsedType {
  let type: ParsedType = { name: entry.name };
  for (const p of entry.parameters) {
    if (!p.required) continue;
    if (p.name === 'values') type = { ...type, values: ['value1'] };
    else if (p.name === 'length')
      type = { ...type, length: p.default ?? (p.max && p.max >= 255 ? 255 : (p.max ?? 1)) };
    else type = { ...type, [p.name]: p.default ?? p.min ?? 1 };
  }
  return type;
}

/** The type as a base type from the catalogue plus its parameters (spec §8: engine-specific types). */
function TypePicker(props: {
  readonly engine: SqlEngineId;
  readonly catalog: readonly TypeCatalogEntry[];
  readonly dataType: string;
  readonly invalid: boolean;
  readonly onChange: (dataType: string) => void;
}) {
  const { engine, catalog } = props;
  const parsed = parseType(props.dataType, engine);
  const entry = parsed ? findType(catalog, parsed) : undefined;
  const update = (patch: Partial<ParsedType>): void => {
    if (!parsed) return;
    const next: Record<string, unknown> = { ...parsed, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    props.onChange(formatType(next as unknown as ParsedType, engine));
  };
  const byCategory = new Map<TypeCategory, TypeCatalogEntry[]>();
  for (const e of catalog) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
  const numberParam = (
    name: 'length' | 'precision' | 'scale' | 'fsp' | 'displayWidth',
    label: string,
  ) => {
    const spec = entry?.parameters.find((p) => p.name === name);
    if (!spec) return null;
    const value = parsed?.[name];
    return (
      <Labeled label={`${label}${spec.required ? '' : ' (optional)'}`} className="w-24">
        <TextField
          type="number"
          aria-label={label}
          min={spec.min}
          max={spec.max}
          placeholder={spec.default !== undefined ? String(spec.default) : ''}
          value={value ?? ''}
          onChange={(event) =>
            update({ [name]: event.target.value === '' ? undefined : Number(event.target.value) })
          }
        />
      </Labeled>
    );
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Labeled label="Type" className="w-56">
        <SelectField
          aria-label="Base type"
          invalid={props.invalid}
          value={entry?.name ?? ''}
          onChange={(event) => {
            const picked = catalog.find((e) => e.name === event.target.value);
            if (picked) props.onChange(formatType(seedParameters(picked), engine));
          }}
        >
          {!entry && <option value="">{props.dataType || 'Choose a type'}</option>}
          {[...byCategory].map(([category, entries]) => (
            <optgroup key={category} label={CATEGORY_LABELS[category]}>
              {entries.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                </option>
              ))}
            </optgroup>
          ))}
        </SelectField>
      </Labeled>
      {numberParam('length', engine === 'postgres' ? 'Length' : 'Length')}
      {numberParam('precision', 'Precision')}
      {numberParam('scale', 'Scale')}
      {numberParam('fsp', 'Fractional seconds')}
      {numberParam('displayWidth', 'Display width')}
      {entry?.parameters.some((p) => p.name === 'values') && (
        <Labeled label="Values (comma separated)" className="min-w-56 flex-1">
          <TextField
            mono
            aria-label="Values"
            value={(parsed?.values ?? []).join(', ')}
            onChange={(event) =>
              update({
                values: event.target.value
                  .split(',')
                  .map((v) => v.trim())
                  .filter((v) => v !== ''),
              })
            }
          />
        </Labeled>
      )}
      {entry?.parameters.some((p) => p.name === 'fields') && (
        <Labeled label="Fields" className="w-36">
          <SelectField
            aria-label="Interval fields"
            value={parsed?.fields ?? ''}
            onChange={(event) =>
              update({ fields: event.target.value === '' ? undefined : event.target.value })
            }
          >
            <option value="">(all)</option>
            {PG_INTERVAL_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </SelectField>
        </Labeled>
      )}
      {entry?.unsigned && (
        <label className="flex h-7 items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={parsed?.unsigned === true}
            onChange={(event) => update({ unsigned: event.target.checked ? true : undefined })}
          />
          Unsigned
        </label>
      )}
      {entry?.zerofill && (
        <label className="flex h-7 items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={parsed?.zerofill === true}
            onChange={(event) => update({ zerofill: event.target.checked ? true : undefined })}
          />
          Zerofill
        </label>
      )}
      {entry?.array && (
        <label className="flex h-7 items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={(parsed?.arrayDimensions ?? 0) > 0}
            onChange={(event) => update({ arrayDimensions: event.target.checked ? 1 : undefined })}
          />
          Array
        </label>
      )}
      {entry?.deprecated && <p className="w-full text-[11px] text-warning">{entry.deprecated}</p>}
      {entry && !entry.deprecated && (
        <p className="w-full text-[11px] text-muted">{entry.description}</p>
      )}
    </div>
  );
}

function ColumnDetails(props: {
  readonly engine: SqlEngineId;
  readonly catalog: readonly TypeCatalogEntry[];
  readonly column: ColumnDef;
  readonly index: number;
  readonly issues: readonly ValidationIssue[];
  readonly onChange: (patch: Partial<Omit<ColumnDef, 'name' | 'ordinal'>>) => void;
}) {
  const { engine, column, index } = props;
  const pg = engine === 'postgres';
  const path = `columns[${index}]`;
  const at = (field: string): readonly ValidationIssue[] =>
    issuesAt(props.issues, `${path}.${field}`);
  const entry = (() => {
    const parsed = parseType(column.dataType, engine);
    return parsed ? findType(props.catalog, parsed) : undefined;
  })();
  const numbering = pg
    ? column.identity
      ? column.identity.generation
      : 'none'
    : column.autoIncrement
      ? 'auto'
      : 'none';
  return (
    <section
      aria-label={`Details of ${column.name}`}
      className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-auto border-t border-border bg-panel p-2"
    >
      <h3 className="text-xs font-semibold">
        {column.name} <span className="font-normal text-muted">{column.dataType}</span>
      </h3>
      <TypePicker
        engine={engine}
        catalog={props.catalog}
        dataType={column.dataType}
        invalid={at('dataType').length > 0}
        onChange={(dataType) => props.onChange({ dataType })}
      />
      <Issues issues={at('dataType')} />
      <div className="flex flex-wrap items-end gap-3">
        <Labeled label={pg ? 'Identity' : 'Auto increment'} className="w-44">
          <SelectField
            aria-label={pg ? 'Identity' : 'Auto increment'}
            value={numbering}
            disabled={!entry?.autoIncrement && numbering === 'none'}
            onChange={(event) => {
              const v = event.target.value;
              if (pg) {
                props.onChange({
                  identity:
                    v === 'none'
                      ? undefined
                      : { ...column.identity, generation: v as 'always' | 'by-default' },
                  ...(v === 'none' ? {} : { default: null }),
                });
              } else
                props.onChange({
                  autoIncrement: v === 'auto',
                  ...(v === 'auto' ? { default: null } : {}),
                });
            }}
          >
            <option value="none">None</option>
            {pg ? (
              <>
                <option value="by-default">GENERATED BY DEFAULT</option>
                <option value="always">GENERATED ALWAYS</option>
              </>
            ) : (
              <option value="auto">AUTO_INCREMENT</option>
            )}
          </SelectField>
        </Labeled>
        {pg && column.identity && (
          <>
            <Labeled label="Start" className="w-24">
              <TextField
                aria-label="Identity start"
                value={column.identity.start ?? ''}
                onChange={(event) =>
                  props.onChange({
                    identity: {
                      ...column.identity!,
                      ...(event.target.value === ''
                        ? { start: undefined }
                        : { start: event.target.value }),
                    },
                  })
                }
              />
            </Labeled>
            <Labeled label="Increment" className="w-24">
              <TextField
                aria-label="Identity increment"
                value={column.identity.increment ?? ''}
                onChange={(event) =>
                  props.onChange({
                    identity: {
                      ...column.identity!,
                      ...(event.target.value === ''
                        ? { increment: undefined }
                        : { increment: event.target.value }),
                    },
                  })
                }
              />
            </Labeled>
          </>
        )}
        <label className="flex h-7 items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={column.generated !== undefined}
            onChange={(event) =>
              props.onChange({
                generated: event.target.checked ? { expression: '', stored: pg } : undefined,
              })
            }
          />
          Generated
        </label>
        {!pg && (
          <Labeled label="On update" className="w-48">
            <TextField
              mono
              aria-label="On update"
              placeholder="CURRENT_TIMESTAMP"
              value={column.onUpdate ?? ''}
              onChange={(event) =>
                props.onChange({
                  onUpdate: event.target.value === '' ? undefined : event.target.value,
                })
              }
            />
          </Labeled>
        )}
      </div>
      <Issues
        issues={[...at('identity'), ...at('autoIncrement'), ...at('onUpdate'), ...at('default')]}
      />
      {column.generated && (
        <div className="flex items-end gap-2">
          <Labeled label="Generated as (expression)" className="flex-1">
            <TextArea
              rows={2}
              aria-label="Generated expression"
              invalid={at('generated').length > 0}
              value={column.generated.expression}
              onChange={(event) =>
                props.onChange({
                  generated: { ...column.generated!, expression: event.target.value },
                })
              }
            />
          </Labeled>
          <label className="flex h-7 items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={column.generated.stored}
              disabled={pg}
              onChange={(event) =>
                props.onChange({
                  generated: { ...column.generated!, stored: event.target.checked },
                })
              }
            />
            Stored
          </label>
        </div>
      )}
      <Issues issues={at('generated')} />
      {(entry?.charset || entry?.collation || column.charset || column.collation) && (
        <div className="flex flex-wrap items-end gap-3">
          {!pg && (
            <Labeled label="Character set" className="w-40">
              <TextField
                aria-label="Character set"
                placeholder="table default"
                value={column.charset ?? ''}
                onChange={(event) =>
                  props.onChange({
                    charset: event.target.value === '' ? undefined : event.target.value,
                  })
                }
              />
            </Labeled>
          )}
          <Labeled label="Collation" className="w-56">
            <TextField
              aria-label="Collation"
              placeholder={pg ? 'database default' : 'table default'}
              value={column.collation ?? ''}
              onChange={(event) =>
                props.onChange({
                  collation: event.target.value === '' ? undefined : event.target.value,
                })
              }
            />
          </Labeled>
        </div>
      )}
      <Issues issues={[...at('charset'), ...at('collation')]} />
    </section>
  );
}
