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

/** Inputs and selects of the bar: one height, the Kiln input ground, the focus border. */
const CONTROL =
  'h-[24px] rounded-sm border bg-deep px-1.5 text-xs text-fg outline-none! focus:border-focus';

/**
 * The filter bar (spec §7): a visual builder — column, operator from what the column's type
 * allows, value, nested AND/OR groups — or a raw WHERE condition, checked before it runs.
 * Problems show next to the condition they belong to; nothing runs until they are fixed. The
 * bar's glyph turns rust while a filter is applied; Enter applies from any field.
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
      className="border-b border-border bg-panel text-xs"
      role="search"
      aria-label="Filter rows"
      data-testid="filter-bar"
    >
      <div className="flex min-h-[35px] flex-wrap items-center gap-2 px-2 py-1">
        <span
          className={cx(
            'flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase',
            filtered ? 'text-rust' : 'text-muted',
          )}
        >
          <Icon name="filter" className="h-3.5 w-3.5" />
          Filter
        </span>
        <div
          className="flex h-[24px] items-center gap-0.5 rounded-sm border border-border bg-deep p-[2px]"
          role="radiogroup"
          aria-label="Filter mode"
        >
          {(
            [
              ['visual', 'Builder', 'builder'],
              ['raw', 'WHERE', 'query'],
            ] as const
          ).map(([value, label, icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              title={value === 'visual' ? 'Build conditions from columns' : 'Type a SQL condition'}
              className={cx(
                'flex h-full items-center gap-1.5 rounded-[1px] px-2 text-[11px]',
                mode === value ? 'bg-badge text-rust' : 'text-muted hover:bg-hover hover:text-fg',
              )}
              onClick={() => view.setFilterMode(value)}
            >
              <Icon name={icon} className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        {mode === 'visual' ? (
          <button
            type="button"
            onClick={() => addCondition(draft.id)}
            className="flex h-[24px] items-center gap-1.5 rounded-sm border border-dashed border-border px-2 text-muted hover:border-strong hover:bg-hover hover:text-fg"
          >
            <Icon name="plus" className="h-3 w-3" />
            Add condition
          </button>
        ) : (
          <label
            className={cx(
              'flex h-[26px] min-w-64 flex-1 items-center rounded-sm border bg-deep focus-within:border-focus',
              rawIssue ? 'border-danger' : 'border-border',
            )}
          >
            <span className="pr-1.5 pl-2 font-mono text-[12px] font-semibold text-rust select-none">
              WHERE
            </span>
            <input
              aria-label="WHERE condition"
              spellCheck={false}
              placeholder="status = 'active' AND total > 100"
              className="h-full min-w-0 flex-1 bg-transparent pr-2 font-mono text-[12px] text-fg outline-none! placeholder:text-faint"
              value={rawText}
              onChange={(event) => view.setRawText(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {rawText !== '' && (
              <kbd className="pr-2 font-sans text-[10px] whitespace-nowrap text-faint">
                ⏎ to apply
              </kbd>
            )}
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {filtered && (
            <span
              className="flex h-[20px] items-center gap-1.5 rounded-sm bg-badge px-1.5 text-[11px] text-rust"
              data-testid="filter-active"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-rust" />
              Filtered
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void view.clearFilter()}
            disabled={!filtered && !hasConditions(draft) && rawText === ''}
            title="Remove every condition and show all rows"
          >
            <Icon name="close" className="h-3 w-3" />
            Clear
          </Button>
          <Button
            size="sm"
            variant="primary"
            aria-label="Apply filter"
            title="Apply the filter (Enter)"
            onClick={() => void view.applyFilter()}
          >
            <Icon name="check" className="h-3.5 w-3.5" />
            Apply
          </Button>
        </div>
      </div>
      {mode === 'raw' && rawIssue && (
        <p role="alert" className="flex items-center gap-2 px-2 pb-1.5 text-danger">
          <Icon name="warning" className="h-3.5 w-3.5 shrink-0" />
          {rawIssue.message}
          {rawText !== '' && (
            <span className="font-mono text-muted">
              {rawText.slice(Math.max(0, rawIssue.position - 12), rawIssue.position)}
              <span className="text-danger underline">
                {rawText.slice(rawIssue.position, rawIssue.position + 8) || '⏎'}
              </span>
            </span>
          )}
        </p>
      )}
      {mode === 'visual' && draft.children.length > 0 && (
        <div className="px-2 pb-2">
          <GroupEditor view={view} group={draft} root onKeyDown={onKeyDown} onAdd={addCondition} />
        </div>
      )}
    </div>
  );
}

/** A dashed chip that adds to the filter: a condition, a group. */
function AddChip(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex h-[22px] items-center gap-1 rounded-sm border border-dashed border-border px-1.5 text-[11px] text-muted hover:border-strong hover:bg-hover hover:text-fg"
    >
      <Icon name="plus" className="h-3 w-3" />
      {props.label}
    </button>
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
      className={cx(
        'flex flex-col gap-1.5',
        !props.root && 'rounded-sm border border-border bg-deep/40 p-2',
      )}
      role="group"
      aria-label={props.root ? 'Conditions' : 'Condition group'}
    >
      <div className="flex items-center gap-2">
        <span className="text-muted">Match</span>
        <div
          role="radiogroup"
          aria-label="Match"
          className="flex h-[22px] items-center gap-0.5 rounded-sm border border-border bg-deep p-[2px]"
        >
          {(['and', 'or'] as const).map((combinator) => (
            <button
              key={combinator}
              type="button"
              role="radio"
              aria-checked={group.combinator === combinator}
              title={combinator === 'and' ? 'Every condition (AND)' : 'Any condition (OR)'}
              className={cx(
                'h-full rounded-[1px] px-2 text-[11px]',
                group.combinator === combinator
                  ? 'bg-badge text-rust'
                  : 'text-muted hover:bg-hover hover:text-fg',
              )}
              onClick={() => update({ combinator })}
            >
              {combinator === 'and' ? 'All' : 'Any'}
            </button>
          ))}
        </div>
        <span className="text-muted">of these</span>
        {!props.root && <AddChip label="Condition" onClick={() => props.onAdd(group.id)} />}
        <AddChip
          label="Group"
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
        />
        {!props.root && (
          <button
            type="button"
            aria-label="Remove group"
            title="Remove group"
            className="ml-auto rounded-sm p-1 text-muted hover:bg-hover hover:text-danger"
            onClick={() => view.setDraft(removeNode(view.state.draft, group.id))}
          >
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="ml-1.5 flex flex-col gap-1 border-l border-border pl-3">
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
      className={cx('w-44 font-mono', CONTROL, issue ? 'border-danger' : 'border-border')}
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
          className={cx('max-w-48 font-mono', CONTROL, 'border-border')}
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
          className={cx(CONTROL, 'border-border')}
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
          <button
            type="button"
            aria-pressed={condition.caseSensitive}
            aria-label="Match case"
            title="Match upper and lower case exactly"
            onClick={() => update({ caseSensitive: !condition.caseSensitive })}
            className={cx(
              'h-[24px] rounded-sm border px-1.5 font-mono text-[11px]',
              condition.caseSensitive
                ? 'border-rust/60 bg-badge text-rust'
                : 'border-border text-muted hover:bg-hover hover:text-fg',
            )}
          >
            Aa
          </button>
        )}
        <button
          type="button"
          aria-label="Remove condition"
          title="Remove condition"
          className="rounded-sm p-1 text-muted hover:bg-hover hover:text-danger"
          onClick={() => view.setDraft(removeNode(view.state.draft, condition.id))}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      </div>
      {issue && (
        <p role="alert" className="flex items-center gap-1.5 pl-5 text-danger">
          <Icon name="warning" className="h-3 w-3 shrink-0" />
          {issue}
        </p>
      )}
    </div>
  );
}
