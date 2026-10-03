import {
  COMPARISON_OPERATORS,
  JOIN_TYPES,
  referenceName,
  type ComparisonOperator,
  type JoinType,
  type QueryJoin,
  type QueryModel,
} from '@querybara/sql-tools';
import { Tabs } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { SidePanel } from '../../state/query-builder/builder';
import { entryOf } from '../../state/query-builder/catalog';
import { aliasOptions, columnOptions, type ColumnOption } from '../../state/query-builder/options';
import { Button, cx, TAB } from '../ui';
import { CriteriaEditor } from './CriteriaEditor';
import { ExprEditor, type ExprKind } from './ExprEditor';
import {
  EmptyHint,
  IconButton,
  RowActions,
  SectionTitle,
  SmallInput,
  SmallSelect,
  useBuilder,
  useBuilderSelector,
  useReadOnly,
} from './parts';

/**
 * The builder's side panels (spec §8): columns (with the tables and their aliases), joins,
 * criteria, grouping with HAVING, and sort with LIMIT and OFFSET. Every control is a labelled
 * form control, so the whole query can be built from the keyboard.
 */

const PANELS: readonly { readonly id: SidePanel; readonly label: string }[] = [
  { id: 'columns', label: 'Columns' },
  { id: 'joins', label: 'Joins' },
  { id: 'criteria', label: 'Criteria' },
  { id: 'group', label: 'Grouping' },
  { id: 'sort', label: 'Sort & limit' },
];

const SELECT_KINDS: readonly ExprKind[] = ['column', 'aggregate', 'raw'];
const GROUP_KINDS: readonly ExprKind[] = ['column', 'raw'];
const ORDER_KINDS: readonly ExprKind[] = ['column', 'aggregate', 'raw'];

function useColumnOptions(): ColumnOption[] {
  const model = useBuilderSelector((state) => state.model);
  const catalog = useBuilderSelector((state) =>
    state.catalog.status === 'ready' ? state.catalog.catalog : undefined,
  );
  return useMemo(() => columnOptions(model, catalog), [model, catalog]);
}

export function SidePanels() {
  const builder = useBuilder();
  const panel = useBuilderSelector((state) => state.panel);
  return (
    <Tabs.Root
      value={panel}
      onValueChange={(value) => builder.showPanel(value as SidePanel)}
      className="flex h-full min-h-0 flex-col"
    >
      <Tabs.List
        aria-label="Query parts"
        className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-panel px-1"
      >
        {PANELS.map((entry) => (
          <Tabs.Trigger key={entry.id} value={entry.id} className={TAB}>
            {entry.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="columns" className="min-h-0 flex-1 overflow-auto p-2">
        <ColumnsPanel />
      </Tabs.Content>
      <Tabs.Content value="joins" className="min-h-0 flex-1 overflow-auto p-2">
        <JoinsPanel />
      </Tabs.Content>
      <Tabs.Content value="criteria" className="min-h-0 flex-1 overflow-auto p-2">
        <CriteriaPanel />
      </Tabs.Content>
      <Tabs.Content value="group" className="min-h-0 flex-1 overflow-auto p-2">
        <GroupPanel />
      </Tabs.Content>
      <Tabs.Content value="sort" className="min-h-0 flex-1 overflow-auto p-2">
        <SortPanel />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function ColumnsPanel() {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const model = useBuilderSelector((state) => state.model);
  const columns = useColumnOptions();
  return (
    <div className="flex flex-col gap-1" data-testid="builder-columns-panel">
      <SectionTitle>Tables</SectionTitle>
      {model.tables.length === 0 && (
        <EmptyHint>Add tables from the list or drag them onto the canvas.</EmptyHint>
      )}
      {model.tables.map((table) => (
        <div key={table.id} className="flex items-center gap-1 text-xs">
          <span
            className="min-w-0 flex-1 truncate"
            title={[table.schema, table.name].filter(Boolean).join('.')}
          >
            {table.name}
          </span>
          <SmallInput
            aria-label={`Alias of ${referenceName(table)}`}
            placeholder="alias"
            defaultValue={table.alias ?? ''}
            key={`${table.id}:${table.alias ?? ''}`}
            disabled={readOnly}
            onBlur={(event) => {
              if (event.target.value.trim() !== (table.alias ?? ''))
                builder.setAlias(table.id, event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            className="w-24"
          />
          <IconButton
            label={`Remove table ${referenceName(table)}`}
            disabled={readOnly}
            onClick={() => builder.removeTable(table.id)}
          >
            ×
          </IconButton>
        </div>
      ))}
      <SectionTitle>Select list</SectionTitle>
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={model.distinct}
          disabled={readOnly}
          onChange={(event) => builder.setDistinct(event.target.checked)}
        />
        Distinct rows (SELECT DISTINCT)
      </label>
      {model.columns.length === 0 && (
        <EmptyHint>Every column (*). Tick columns on the canvas, or add them here.</EmptyHint>
      )}
      {model.columns.map((item, index) => {
        const name = `column ${index + 1}`;
        return (
          <div
            key={item.id}
            className="flex items-start gap-1 rounded bg-panel-2/60 p-1"
            data-testid="builder-select-item"
          >
            {item.kind === 'star' ? (
              <span className="flex-1 px-1 py-1 font-mono text-xs">
                {item.table === undefined
                  ? '*'
                  : `${referenceName(model.tables.find((t) => t.id === item.table) ?? { id: '', name: '?' })}.*`}
              </span>
            ) : (
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <ExprEditor
                  value={item.expr}
                  onChange={(expr) =>
                    builder.updateSelectItem(
                      item.id,
                      (current) => ({ ...current, expr }) as typeof current,
                    )
                  }
                  kinds={SELECT_KINDS}
                  label={`Column ${index + 1}`}
                  columns={columns}
                  disabled={readOnly}
                />
                <SmallInput
                  aria-label={`Column ${index + 1} alias`}
                  placeholder="alias (AS)"
                  value={item.alias ?? ''}
                  disabled={readOnly}
                  onChange={(event) =>
                    builder.updateSelectItem(item.id, (current) => {
                      if (current.kind !== 'expr') return current;
                      const { alias: _old, ...rest } = current;
                      return event.target.value === ''
                        ? rest
                        : { ...rest, alias: event.target.value };
                    })
                  }
                />
              </span>
            )}
            <RowActions
              name={name}
              first={index === 0}
              last={index === model.columns.length - 1}
              disabled={readOnly}
              onMove={(delta) => builder.moveSelectItem(item.id, delta)}
              onRemove={() => builder.removeSelectItem(item.id)}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          disabled={readOnly || columns.length === 0}
          onClick={() => builder.addSelectItem({ kind: 'expr', expr: columns[0]!.expr })}
        >
          Add column
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly}
          onClick={() =>
            builder.addSelectItem({ kind: 'expr', expr: { kind: 'aggregate', fn: 'count' } })
          }
        >
          Add aggregate
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly}
          onClick={() => builder.addSelectItem({ kind: 'expr', expr: { kind: 'raw', sql: '' } })}
        >
          Add expression
        </Button>
      </div>
    </div>
  );
}

const JOIN_LABELS: Readonly<Record<JoinType, string>> = {
  inner: 'Inner join',
  left: 'Left join',
  right: 'Right join',
  full: 'Full join',
};

function JoinsPanel() {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const model = useBuilderSelector((state) => state.model);
  const selected = useBuilderSelector((state) => state.selectedJoin);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const tables = model.tables;
  const leftId = tables.some((t) => t.id === left) ? left : (tables[0]?.id ?? '');
  const rightId = tables.some((t) => t.id === right && t.id !== leftId)
    ? right
    : (tables.find((t) => t.id !== leftId)?.id ?? '');
  return (
    <div className="flex flex-col gap-2" data-testid="builder-joins-panel">
      {model.joins.length === 0 && (
        <EmptyHint>
          No joins: the tables are combined row by row (CROSS JOIN). Joins come from foreign keys
          when a table is added, or draw one by dragging from a column to a column of another table.
        </EmptyHint>
      )}
      {model.joins.map((join) => (
        <JoinEditor key={join.id} join={join} model={model} selected={join.id === selected} />
      ))}
      {tables.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
          <SmallSelect
            aria-label="New join: left table"
            value={leftId}
            disabled={readOnly}
            onChange={(e) => setLeft(e.target.value)}
          >
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {referenceName(t)}
              </option>
            ))}
          </SmallSelect>
          <SmallSelect
            aria-label="New join: right table"
            value={rightId}
            disabled={readOnly}
            onChange={(e) => setRight(e.target.value)}
          >
            {tables
              .filter((t) => t.id !== leftId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {referenceName(t)}
                </option>
              ))}
          </SmallSelect>
          <Button
            size="sm"
            disabled={readOnly || rightId === ''}
            onClick={() => builder.addJoin(leftId, rightId)}
          >
            Add join
          </Button>
        </div>
      )}
    </div>
  );
}

function JoinEditor(props: {
  readonly join: QueryJoin;
  readonly model: QueryModel;
  readonly selected: boolean;
}) {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const catalog = useBuilderSelector((state) =>
    state.catalog.status === 'ready' ? state.catalog.catalog : undefined,
  );
  const { join, model } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [props.selected]);
  const left = model.tables.find((t) => t.id === join.left);
  const right = model.tables.find((t) => t.id === join.right);
  if (!left || !right) return null;
  const leftName = referenceName(left);
  const rightName = referenceName(right);
  const columnsOf = (table: typeof left, current: string): string[] => {
    const names = (catalog && entryOf(catalog, table)?.columns.map((c) => c.name)) ?? [];
    return current !== '' && !names.includes(current) ? [current, ...names] : names;
  };
  const postgres = builder.target.dialect === 'postgres';
  const name = `${leftName} to ${rightName}`;
  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Join ${name}`}
      data-testid="builder-join"
      className={cx(
        'flex flex-col gap-1 rounded border p-1.5 text-xs',
        props.selected ? 'border-accent bg-accent/10' : 'border-border',
      )}
    >
      <div className="flex items-center gap-1">
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={`${leftName} ${join.type.toUpperCase()} JOIN ${rightName}`}
        >
          {leftName} → {rightName}
        </span>
        <SmallSelect
          aria-label={`Join ${name}: type`}
          value={join.type}
          disabled={readOnly}
          onChange={(event) => builder.setJoinType(join.id, event.target.value as JoinType)}
        >
          {JOIN_TYPES.map((type) => (
            <option
              key={type}
              value={type}
              disabled={type === 'full' && !postgres && join.type !== 'full'}
            >
              {JOIN_LABELS[type]}
              {type === 'full' && !postgres ? ' (not on MySQL / MariaDB)' : ''}
            </option>
          ))}
        </SmallSelect>
        <IconButton
          label={`Swap the sides of join ${name}`}
          disabled={readOnly}
          onClick={() => builder.swapJoin(join.id)}
        >
          ⇄
        </IconButton>
        <IconButton
          label={`Remove join ${name}`}
          disabled={readOnly}
          onClick={() => builder.removeJoin(join.id)}
        >
          ×
        </IconButton>
      </div>
      {join.conditions.map((condition, index) => (
        <div key={index} className="flex items-center gap-1" data-testid="builder-join-condition">
          <SmallSelect
            aria-label={`Join ${name}: condition ${index + 1} ${leftName} column`}
            value={condition.left}
            disabled={readOnly}
            onChange={(event) =>
              builder.setJoinCondition(join.id, index, { left: event.target.value })
            }
            className="min-w-0 flex-1"
          >
            {condition.left === '' && <option value="">({leftName} column)</option>}
            {columnsOf(left, condition.left).map((column) => (
              <option key={column} value={column}>
                {leftName}.{column}
              </option>
            ))}
          </SmallSelect>
          <SmallSelect
            aria-label={`Join ${name}: condition ${index + 1} operator`}
            value={condition.operator}
            disabled={readOnly}
            onChange={(event) =>
              builder.setJoinCondition(join.id, index, {
                operator: event.target.value as ComparisonOperator,
              })
            }
            className="w-14"
          >
            {COMPARISON_OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </SmallSelect>
          <SmallSelect
            aria-label={`Join ${name}: condition ${index + 1} ${rightName} column`}
            value={condition.right}
            disabled={readOnly}
            onChange={(event) =>
              builder.setJoinCondition(join.id, index, { right: event.target.value })
            }
            className="min-w-0 flex-1"
          >
            {condition.right === '' && <option value="">({rightName} column)</option>}
            {columnsOf(right, condition.right).map((column) => (
              <option key={column} value={column}>
                {rightName}.{column}
              </option>
            ))}
          </SmallSelect>
          <IconButton
            label={`Remove condition ${index + 1} of join ${name}`}
            disabled={readOnly}
            onClick={() => builder.removeJoinCondition(join.id, index)}
          >
            ×
          </IconButton>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly}
          onClick={() => builder.addJoinCondition(join.id)}
        >
          Add condition
        </Button>
      </div>
    </div>
  );
}

function CriteriaPanel() {
  const where = useBuilderSelector((state) => state.model.where);
  const columns = useColumnOptions();
  return (
    <div data-testid="builder-criteria-panel">
      <CriteriaEditor which="where" group={where} columns={columns} label="Criteria" />
    </div>
  );
}

function GroupPanel() {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const groupBy = useBuilderSelector((state) => state.model.groupBy);
  const having = useBuilderSelector((state) => state.model.having);
  const columns = useColumnOptions();
  return (
    <div className="flex flex-col gap-1" data-testid="builder-group-panel">
      <SectionTitle>Group by</SectionTitle>
      {groupBy.length === 0 && <EmptyHint>No grouping.</EmptyHint>}
      {groupBy.map((item, index) => (
        <div key={item.id} className="flex items-center gap-1">
          <ExprEditor
            value={item.expr}
            onChange={(expr) =>
              builder.updateGroupItem(item.id, (current) => ({ ...current, expr }))
            }
            kinds={GROUP_KINDS}
            label={`Group ${index + 1}`}
            columns={columns}
            disabled={readOnly}
          />
          <RowActions
            name={`group ${index + 1}`}
            first={index === 0}
            last={index === groupBy.length - 1}
            disabled={readOnly}
            onMove={(delta) => builder.moveGroupItem(item.id, delta)}
            onRemove={() => builder.removeGroupItem(item.id)}
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          disabled={readOnly || columns.length === 0}
          onClick={() => builder.addGroupItem({ expr: columns[0]!.expr })}
        >
          Add grouping
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly}
          onClick={() => builder.groupBySelected()}
        >
          Group by the selected columns
        </Button>
      </div>
      <SectionTitle>Having</SectionTitle>
      <CriteriaEditor which="having" group={having} columns={columns} label="Having" />
    </div>
  );
}

function SortPanel() {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const model = useBuilderSelector((state) => state.model);
  const columns = useColumnOptions();
  const options = useMemo(() => [...aliasOptions(model), ...columns], [model, columns]);
  const postgres = builder.target.dialect === 'postgres';
  const paging = (which: 'limit' | 'offset', text: string): void => {
    const trimmed = text.trim();
    builder.setPaging(which, trimmed === '' ? undefined : Number(trimmed));
  };
  return (
    <div className="flex flex-col gap-1" data-testid="builder-sort-panel">
      <SectionTitle>Sort</SectionTitle>
      {model.orderBy.length === 0 && <EmptyHint>The server's order.</EmptyHint>}
      {model.orderBy.map((item, index) => (
        <div key={item.id} className="flex flex-col gap-1 rounded bg-panel-2/60 p-1">
          <div className="flex items-center gap-1">
            <ExprEditor
              value={item.expr}
              onChange={(expr) =>
                builder.updateOrderItem(item.id, (current) => ({ ...current, expr }))
              }
              kinds={ORDER_KINDS}
              label={`Sort ${index + 1}`}
              columns={options}
              disabled={readOnly}
            />
            <RowActions
              name={`sort ${index + 1}`}
              first={index === 0}
              last={index === model.orderBy.length - 1}
              disabled={readOnly}
              onMove={(delta) => builder.moveOrderItem(item.id, delta)}
              onRemove={() => builder.removeOrderItem(item.id)}
            />
          </div>
          <div className="flex items-center gap-1">
            <SmallSelect
              aria-label={`Sort ${index + 1} direction`}
              value={item.direction}
              disabled={readOnly}
              onChange={(event) =>
                builder.updateOrderItem(item.id, (current) => ({
                  ...current,
                  direction: event.target.value === 'desc' ? 'desc' : 'asc',
                }))
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </SmallSelect>
            {(postgres || item.nulls !== undefined) && (
              <SmallSelect
                aria-label={`Sort ${index + 1} nulls`}
                value={item.nulls ?? ''}
                disabled={readOnly}
                onChange={(event) =>
                  builder.updateOrderItem(item.id, (current) => {
                    const { nulls: _old, ...rest } = current;
                    const value = event.target.value;
                    return value === 'first' || value === 'last' ? { ...rest, nulls: value } : rest;
                  })
                }
              >
                <option value="">Nulls: default</option>
                <option value="first">Nulls first</option>
                <option value="last">Nulls last</option>
              </SmallSelect>
            )}
          </div>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          disabled={readOnly || options.length === 0}
          onClick={() => builder.addOrderItem({ expr: options[0]!.expr, direction: 'asc' })}
        >
          Add sort
        </Button>
      </div>
      <SectionTitle>Limit</SectionTitle>
      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          Limit
          <SmallInput
            type="number"
            min={0}
            step={1}
            className="w-24"
            placeholder="all rows"
            value={model.limit ?? ''}
            disabled={readOnly}
            onChange={(event) => paging('limit', event.target.value)}
          />
        </label>
        <label className="flex items-center gap-1">
          Offset
          <SmallInput
            type="number"
            min={0}
            step={1}
            className="w-24"
            placeholder="0"
            value={model.offset ?? ''}
            disabled={readOnly}
            onChange={(event) => paging('offset', event.target.value)}
          />
        </label>
      </div>
      {!postgres && (
        <p className="text-[11px] text-muted">
          An offset without a limit reads every following row.
        </p>
      )}
    </div>
  );
}
