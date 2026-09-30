import {
  checkFragment,
  operatorInfo,
  operatorsFor,
  type Condition,
  type CriteriaGroup,
  type CriteriaOperator,
  type Criterion,
  type QueryExpr,
} from '@joinery/sql-tools';
import type { ReactNode } from 'react';

import {
  dataTypeOf,
  defaultValue,
  withOperator,
  type ColumnOption,
} from '../../state/query-builder/options';
import { Button } from '../ui';
import { VALUE_KINDS, ExprEditor, type ExprKind } from './ExprEditor';
import { EmptyHint, IconButton, SmallInput, SmallSelect, useBuilder, useReadOnly } from './parts';

/**
 * The WHERE or HAVING tree (spec §8: criteria and HAVING in side panels): a group matches all
 * (AND) or any (OR) of its conditions and nested groups, optionally negated; a condition is an
 * expression, a typed operator and as many values as the operator takes; a condition can also
 * be written as SQL.
 */

const LEFT_KINDS: Readonly<Record<'where' | 'having', readonly ExprKind[]>> = {
  where: ['column', 'raw'],
  having: ['aggregate', 'column', 'raw'],
};

export function CriteriaEditor(props: {
  readonly which: 'where' | 'having';
  readonly group: CriteriaGroup;
  readonly columns: readonly ColumnOption[];
  readonly depth?: number;
  readonly label: string;
}) {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const { which, group, columns } = props;
  const depth = props.depth ?? 0;
  const firstLeft = (): QueryExpr =>
    which === 'having'
      ? { kind: 'aggregate', fn: 'count' }
      : (columns[0]?.expr ?? { kind: 'raw', sql: '' });
  const newCondition = (): Omit<Condition, 'id'> => {
    const left = firstLeft();
    return {
      kind: 'condition',
      left,
      operator: '=',
      values: [defaultValue(which === 'having' ? 'integer' : dataTypeOf(left, columns))],
    };
  };
  return (
    <div
      role="group"
      aria-label={props.label}
      className={depth > 0 ? 'rounded border border-border bg-panel-2/40 p-1.5' : undefined}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
        <SmallSelect
          aria-label={`${props.label}: match`}
          value={group.op}
          disabled={readOnly}
          onChange={(event) =>
            builder.patchCriterion(which, group.id, (current) => ({
              ...(current as CriteriaGroup),
              op: event.target.value === 'or' ? 'or' : 'and',
            }))
          }
        >
          <option value="and">All of (AND)</option>
          <option value="or">Any of (OR)</option>
        </SmallSelect>
        <label className="flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            checked={group.negated === true}
            disabled={readOnly}
            onChange={(event) =>
              builder.patchCriterion(which, group.id, (current) => {
                const { negated: _old, ...rest } = current as CriteriaGroup;
                return event.target.checked ? { ...rest, negated: true } : rest;
              })
            }
          />
          NOT
        </label>
        <span className="flex-1" />
        {depth > 0 && (
          <IconButton
            label={`Remove ${props.label}`}
            disabled={readOnly}
            onClick={() => builder.removeCriterion(which, group.id)}
          >
            ×
          </IconButton>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {group.items.length === 0 && (
          <EmptyHint>
            {depth === 0 ? 'Every row matches.' : 'An empty group matches every row.'}
          </EmptyHint>
        )}
        {group.items.map((item, index) => (
          <CriterionRow
            key={item.id}
            which={which}
            item={item}
            columns={columns}
            depth={depth}
            label={`${props.label} ${depth === 0 ? 'condition' : 'item'} ${index + 1}`}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button
          size="sm"
          disabled={readOnly}
          onClick={() => builder.addCriterion(which, group.id, newCondition())}
        >
          Add condition
        </Button>
        {depth < 3 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            onClick={() =>
              builder.addCriterion(which, group.id, {
                kind: 'group',
                op: group.op === 'and' ? 'or' : 'and',
                items: [],
              })
            }
          >
            Add group
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly}
          onClick={() => builder.addCriterion(which, group.id, { kind: 'custom', sql: '' })}
        >
          Add SQL condition
        </Button>
      </div>
    </div>
  );
}

function CriterionRow(props: {
  readonly which: 'where' | 'having';
  readonly item: Criterion;
  readonly columns: readonly ColumnOption[];
  readonly depth: number;
  readonly label: string;
}) {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const { which, item, columns, label } = props;
  if (item.kind === 'group') {
    return (
      <CriteriaEditor
        which={which}
        group={item}
        columns={columns}
        depth={props.depth + 1}
        label={label}
      />
    );
  }
  const remove = (
    <IconButton
      label={`Remove ${label}`}
      disabled={readOnly}
      onClick={() => builder.removeCriterion(which, item.id)}
    >
      ×
    </IconButton>
  );
  if (item.kind === 'custom') {
    const problem =
      item.sql.trim() === '' ? undefined : checkFragment(item.sql, builder.target.dialect);
    return (
      <div className="flex items-center gap-1" data-testid="builder-condition">
        <SmallInput
          aria-label={`${label} SQL`}
          value={item.sql}
          disabled={readOnly}
          placeholder="is_active"
          aria-invalid={problem !== undefined}
          title={problem}
          onChange={(event) =>
            builder.patchCriterion(which, item.id, () => ({ ...item, sql: event.target.value }))
          }
          className="flex-1 font-mono"
        />
        {remove}
      </div>
    );
  }
  return (
    <ConditionRow which={which} condition={item} columns={columns} label={label} remove={remove} />
  );
}

function ConditionRow(props: {
  readonly which: 'where' | 'having';
  readonly condition: Condition;
  readonly columns: readonly ColumnOption[];
  readonly label: string;
  readonly remove: ReactNode;
}) {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const { which, condition, columns, label } = props;
  const dialect = builder.target.dialect;
  const info = operatorInfo(condition.operator);
  const fallback = defaultValue(dataTypeOf(condition.left, columns));
  const patch = (next: Condition): void => builder.patchCriterion(which, condition.id, () => next);
  const setValue = (index: number, value: QueryExpr): void =>
    patch({ ...condition, values: condition.values.map((v, i) => (i === index ? value : v)) });
  const valueLabel = (index: number): string =>
    info.arity === 2
      ? `${label} ${index === 0 ? 'from' : 'to'}`
      : info.arity === 'list'
        ? `${label} value ${index + 1}`
        : `${label} value`;
  return (
    <div className="flex flex-col gap-1 rounded bg-panel-2/60 p-1" data-testid="builder-condition">
      <div className="flex items-center gap-1">
        <ExprEditor
          value={condition.left}
          onChange={(left) => patch({ ...condition, left })}
          kinds={LEFT_KINDS[which]}
          label={label}
          columns={columns}
          disabled={readOnly}
        />
        {props.remove}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <SmallSelect
          aria-label={`${label} operator`}
          value={condition.operator}
          disabled={readOnly}
          onChange={(event) =>
            patch(withOperator(condition, event.target.value as CriteriaOperator, fallback))
          }
          className="w-28"
        >
          {operatorsFor(dialect).map((operator) => (
            <option key={operator.operator} value={operator.operator}>
              {operator.label}
            </option>
          ))}
          {!operatorsFor(dialect).some((operator) => operator.operator === condition.operator) && (
            <option value={condition.operator}>{info.label}</option>
          )}
        </SmallSelect>
        {condition.values.map((value, index) => (
          <span key={index} className="flex min-w-0 flex-1 items-center gap-0.5">
            {info.arity === 2 && index === 1 && (
              <span className="px-0.5 text-xs text-muted">and</span>
            )}
            <ExprEditor
              value={value}
              onChange={(next) => setValue(index, next)}
              kinds={VALUE_KINDS}
              label={valueLabel(index)}
              columns={columns}
              disabled={readOnly}
            />
            {info.arity === 'list' && condition.values.length > 1 && (
              <IconButton
                label={`Remove ${valueLabel(index)}`}
                disabled={readOnly}
                onClick={() =>
                  patch({ ...condition, values: condition.values.filter((_v, i) => i !== index) })
                }
              >
                ×
              </IconButton>
            )}
          </span>
        ))}
        {info.arity === 'list' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            onClick={() => patch({ ...condition, values: [...condition.values, fallback] })}
          >
            Add value
          </Button>
        )}
      </div>
    </div>
  );
}
