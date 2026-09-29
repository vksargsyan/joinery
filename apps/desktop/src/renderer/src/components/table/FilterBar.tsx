import { newId } from '@joinery/core';
import { operatorsFor, type FilterOperator } from '@joinery/table-data';
import type { KeyboardEvent } from 'react';

import {
  OPERATOR_LABELS,
  addChild,
  hasConditions,
  isTextOperator,
  newCondition,
  operandShape,
  removeNode,
  setConditionColumn,
  updateNode,
  type ConditionDraft,
  type FilterDraft,
  type GroupDraft,
} from '../../state/table/filter-draft';
import { useTableState, type TableView } from '../../state/table-view';
import { Button, Icon, cx } from '../ui';

/**
 * The filter bar (spec §7): a visual builder — column, operator from what the column's type
 * allows, value, nested AND/OR groups — or a raw WHERE condition, checked before it runs.
 * Problems show next to the condition they belong to; nothing runs until they are fixed.
 */
export function FilterBar(props: { readonly view: TableView }) {
  const { view } = props;
  const mode = useTableState(view, (s) => s.filterMode);
  const draft = useTableState(view, (s) => s.draft);
  const rawText = useTableState(view, (s) => s.rawText);
  const rawIssue = useTableState(view, (s) => s.rawIssue);
  const active = useTableState(view, (s) => s.active);
  const columns = useTableState(view, (s) => s.columns);
  const dialect = useTableState(view, (s) => s.dialect);
  const filtered = active.filter !== undefined || active.rawWhere !== undefined;

  const addCondition = (groupId: string): void => {
    const first = columns[0];
    if (!first || !dialect) return;
    view.setDraft(addChild(view.state.draft, groupId, newCondition(first, dialect)));
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void view.applyFilter();
    }
  };

  return (
    <div
      className="flex flex-col gap-1 border-b border-border bg-panel px-2 py-1.5 text-xs"
      role="search"
      aria-label="Filter rows"
      data-testid="filter-bar"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-muted">Filter</span>
        <div
          className="flex rounded border border-border"
          role="radiogroup"
          aria-label="Filter mode"
        >
          {(['visual', 'raw'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={cx(
                'px-2 py-0.5',
                mode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => view.setFilterMode(m)}
            >
              {m === 'visual' ? 'Builder' : 'WHERE'}
            </button>
          ))}
        </div>
        {mode === 'visual' ? (
          <>
            {!hasConditions(draft) && draft.children.length === 0 && (
              <span className="text-muted">No conditions</span>
            )}
            <Button size="sm" variant="ghost" onClick={() => addCondition(draft.id)}>
              <Icon name="plus" className="h-3 w-3" />
              Add condition
            </Button>
          </>
        ) : (
          <div className="flex min-w-64 flex-1 items-center gap-1.5">
            <span className="font-mono text-muted">WHERE</span>
            <input
              aria-label="WHERE condition"
              spellCheck={false}
              placeholder="status = 'active' AND total > 100"
              className={cx(
                'h-7 min-w-0 flex-1 rounded border bg-panel-2 px-2 font-mono text-xs',
                rawIssue ? 'border-danger' : 'border-border',
              )}
              value={rawText}
              onChange={(event) => view.setRawText(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        )}
        <span className="flex-1" />
        {filtered && (
          <span
            className="rounded bg-accent/15 px-1.5 py-0.5 text-accent"
            data-testid="filter-active"
          >
            Filtered
          </span>
        )}
        <Button size="sm" variant="primary" onClick={() => void view.applyFilter()}>
          Apply filter
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.clearFilter()}
          disabled={!filtered && !hasConditions(draft) && rawText === ''}
        >
          Clear
        </Button>
      </div>
      {mode === 'raw' && rawIssue && (
        <p role="alert" className="text-danger">
          {rawIssue.message}
          {rawText !== '' && (
            <span className="ml-2 font-mono text-muted">
              {rawText.slice(Math.max(0, rawIssue.position - 12), rawIssue.position)}
              <span className="text-danger underline">
                {rawText.slice(rawIssue.position, rawIssue.position + 8) || '⏎'}
              </span>
            </span>
          )}
        </p>
      )}
      {mode === 'visual' && draft.children.length > 0 && (
        <GroupEditor view={view} group={draft} root onKeyDown={onKeyDown} onAdd={addCondition} />
      )}
    </div>
  );
}

function GroupEditor(props: {
  readonly view: TableView;
  readonly group: GroupDraft;
  readonly root?: boolean;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly onAdd: (groupId: string) => void;
}) {
  const { view, group } = props;
  const update = (patch: Partial<GroupDraft>): void =>
    view.setDraft(updateNode(view.state.draft, group.id, patch));
  return (
    <div
      className={cx('flex flex-col gap-1', !props.root && 'rounded border border-border/70 p-1.5')}
      role="group"
      aria-label={props.root ? 'Conditions' : 'Condition group'}
    >
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Match"
          className="h-6 rounded border border-border bg-panel-2 px-1 text-xs"
          value={group.combinator}
          onChange={(event) => update({ combinator: event.target.value as 'and' | 'or' })}
        >
          <option value="and">All of (AND)</option>
          <option value="or">Any of (OR)</option>
        </select>
        {!props.root && (
          <Button size="sm" variant="ghost" onClick={() => props.onAdd(group.id)}>
            <Icon name="plus" className="h-3 w-3" />
            Condition
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            view.setDraft(
              addChild(view.state.draft, group.id, {
                id: newId(),
                type: 'group',
                combinator: group.combinator === 'and' ? 'or' : 'and',
                children: [],
                disabled: false,
              }),
            )
          }
        >
          <Icon name="plus" className="h-3 w-3" />
          Group
        </Button>
        {!props.root && (
          <button
            type="button"
            aria-label="Remove group"
            className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
            onClick={() => view.setDraft(removeNode(view.state.draft, group.id))}
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 pl-3">
        {group.children.map((child) => (
          <NodeEditor
            key={child.id}
            view={view}
            node={child}
            onKeyDown={props.onKeyDown}
            onAdd={props.onAdd}
          />
        ))}
      </div>
    </div>
  );
}

function NodeEditor(props: {
  readonly view: TableView;
  readonly node: FilterDraft;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly onAdd: (groupId: string) => void;
}) {
  if (props.node.type === 'group') {
    return (
      <GroupEditor
        view={props.view}
        group={props.node}
        onKeyDown={props.onKeyDown}
        onAdd={props.onAdd}
      />
    );
  }
  return <ConditionEditor view={props.view} condition={props.node} onKeyDown={props.onKeyDown} />;
}

function ConditionEditor(props: {
  readonly view: TableView;
  readonly condition: ConditionDraft;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}) {
  const { view, condition } = props;
  const columns = useTableState(view, (s) => s.columns);
  const dialect = useTableState(view, (s) => s.dialect);
  const issue = useTableState(view, (s) => s.filterIssues[condition.id]);
  const column = columns.find((c) => c.name === condition.column);
  const operators: FilterOperator[] = column && dialect ? operatorsFor(column, dialect) : [];
  const shape = operandShape(condition.operator);
  const update = (patch: Partial<ConditionDraft>): void =>
    view.setDraft(updateNode(view.state.draft, condition.id, patch));
  const input = (
    value: string,
    onChange: (text: string) => void,
    label: string,
    placeholder?: string,
  ) => (
    <input
      aria-label={label}
      spellCheck={false}
      placeholder={placeholder}
      className={cx(
        'h-6 w-40 rounded border bg-panel-2 px-1.5 font-mono text-xs',
        issue ? 'border-danger' : 'border-border',
      )}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={props.onKeyDown}
    />
  );
  return (
    <div className="flex flex-col gap-0.5" data-testid="filter-condition">
      <div
        className={cx('flex flex-wrap items-center gap-1.5', condition.disabled && 'opacity-50')}
      >
        <input
          type="checkbox"
          aria-label="Use this condition"
          checked={!condition.disabled}
          onChange={(event) => update({ disabled: !event.target.checked })}
        />
        <select
          aria-label="Column"
          className="h-6 max-w-44 rounded border border-border bg-panel-2 px-1 text-xs"
          value={condition.column}
          onChange={(event) => {
            const next = columns.find((c) => c.name === event.target.value);
            if (next && dialect) {
              view.setDraft(
                updateNode(
                  view.state.draft,
                  condition.id,
                  setConditionColumn(condition, next, dialect),
                ),
              );
            }
          }}
        >
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Operator"
          className="h-6 rounded border border-border bg-panel-2 px-1 text-xs"
          value={condition.operator}
          onChange={(event) => update({ operator: event.target.value as FilterOperator })}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </option>
          ))}
        </select>
        {shape === 'one' && input(condition.text, (text) => update({ text }), 'Value')}
        {shape === 'list' &&
          input(condition.text, (text) => update({ text }), 'Values', 'a, b, "c,d", NULL')}
        {shape === 'range' && (
          <>
            {input(condition.text, (text) => update({ text }), 'From')}
            <span className="text-muted">and</span>
            {input(condition.text2, (text2) => update({ text2 }), 'To')}
          </>
        )}
        {isTextOperator(condition.operator) && (
          <label
            className="flex items-center gap-1 text-muted"
            title="Match upper and lower case exactly"
          >
            <input
              type="checkbox"
              checked={condition.caseSensitive}
              onChange={(event) => update({ caseSensitive: event.target.checked })}
            />
            Aa
          </label>
        )}
        <button
          type="button"
          aria-label="Remove condition"
          className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
          onClick={() => view.setDraft(removeNode(view.state.draft, condition.id))}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      </div>
      {issue && (
        <p role="alert" className="pl-5 text-danger">
          {issue}
        </p>
      )}
    </div>
  );
}
