import {
  AGGREGATE_FUNCTIONS,
  checkFragment,
  type AggregateFunction,
  type QueryExpr,
} from '@joinery/sql-tools';

import { exprKey, type ColumnOption } from '../../state/query-builder/options';
import { SmallInput, SmallSelect, useBuilder } from './parts';

/**
 * One expression of the side panels: a column, an aggregate of a column, a typed value, a
 * placeholder or SQL typed by hand, chosen with a kind menu. Values are kept as typed; the
 * builder quotes strings and checks numbers and placeholders when it writes the SQL.
 */

export type ExprKind = QueryExpr['kind'];

const KIND_LABELS: Readonly<Record<ExprKind, string>> = {
  column: 'Column',
  aggregate: 'Aggregate',
  string: 'Text',
  number: 'Number',
  boolean: 'True / false',
  parameter: 'Parameter',
  raw: 'SQL',
};

/** Kinds offered where a value is expected. */
export const VALUE_KINDS: readonly ExprKind[] = [
  'string',
  'number',
  'boolean',
  'column',
  'parameter',
  'raw',
];

function convert(expr: QueryExpr, kind: ExprKind, columns: readonly ColumnOption[]): QueryExpr {
  const firstColumn = columns[0]?.expr ?? { kind: 'column' as const, column: '' };
  switch (kind) {
    case 'column':
      return expr.kind === 'aggregate' && expr.arg?.kind === 'column' ? expr.arg : firstColumn;
    case 'aggregate':
      return expr.kind === 'column'
        ? { kind: 'aggregate', fn: 'count', arg: expr }
        : { kind: 'aggregate', fn: 'count' };
    case 'string':
      return { kind: 'string', value: expr.kind === 'number' ? expr.value : '' };
    case 'number':
      return {
        kind: 'number',
        value: expr.kind === 'string' && /^-?[\d.]+$/.test(expr.value) ? expr.value : '',
      };
    case 'boolean':
      return { kind: 'boolean', value: true };
    case 'parameter':
      return { kind: 'parameter', text: ':value' };
    case 'raw':
      return { kind: 'raw', sql: '' };
  }
}

const STAR = '*';
const SQL = 'sql';

export function ExprEditor(props: {
  readonly value: QueryExpr;
  readonly onChange: (expr: QueryExpr) => void;
  readonly kinds: readonly ExprKind[];
  /** Accessible name of the expression, e.g. "Column 2" or "Value". */
  readonly label: string;
  readonly columns: readonly ColumnOption[];
  readonly disabled: boolean;
}) {
  const { value, onChange, label, columns, disabled } = props;
  const kinds = props.kinds.includes(value.kind) ? props.kinds : [...props.kinds, value.kind];
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {kinds.length > 1 && (
        <SmallSelect
          aria-label={`${label} kind`}
          value={value.kind}
          disabled={disabled}
          onChange={(event) => onChange(convert(value, event.target.value as ExprKind, columns))}
          className="w-24"
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </SmallSelect>
      )}
      {value.kind === 'column' && (
        <ColumnSelect
          label={label}
          value={value}
          columns={columns}
          disabled={disabled}
          onChange={(column) => onChange(column)}
        />
      )}
      {value.kind === 'aggregate' && (
        <>
          <SmallSelect
            aria-label={`${label} function`}
            value={value.fn}
            disabled={disabled}
            onChange={(event) => {
              const fn = event.target.value as AggregateFunction;
              onChange(
                fn !== 'count' && value.arg === undefined
                  ? { kind: 'aggregate', fn, arg: columns[0]?.expr ?? { kind: 'raw', sql: '' } }
                  : { ...value, fn },
              );
            }}
            className="w-20"
          >
            {AGGREGATE_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {fn.toUpperCase()}
              </option>
            ))}
          </SmallSelect>
          <SmallSelect
            aria-label={`${label} argument`}
            value={
              value.arg === undefined
                ? STAR
                : value.arg.kind === 'column'
                  ? exprKey(value.arg)
                  : SQL
            }
            disabled={disabled}
            onChange={(event) => {
              const choice = event.target.value;
              if (choice === STAR) {
                onChange({ kind: 'aggregate', fn: value.fn });
                return;
              }
              if (choice === SQL) {
                onChange({ ...value, arg: { kind: 'raw', sql: '' } });
                return;
              }
              const column = columns.find((option) => option.key === choice);
              if (column) onChange({ ...value, arg: column.expr });
            }}
            className="min-w-24 flex-1"
          >
            {value.fn === 'count' && <option value={STAR}>* (all rows)</option>}
            {columns.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
            <option value={SQL}>SQL…</option>
          </SmallSelect>
          {value.arg !== undefined && value.arg.kind !== 'column' && (
            <SmallInput
              aria-label={`${label} argument SQL`}
              value={value.arg.kind === 'raw' ? value.arg.sql : ''}
              disabled={disabled}
              placeholder="price * qty"
              onChange={(event) =>
                onChange({ ...value, arg: { kind: 'raw', sql: event.target.value } })
              }
              className="min-w-24 flex-1 font-mono"
            />
          )}
          {value.arg !== undefined && (
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={value.distinct === true}
                disabled={disabled}
                onChange={(event) => {
                  const { distinct: _old, ...rest } = value;
                  onChange(event.target.checked ? { ...rest, distinct: true } : rest);
                }}
              />
              Distinct
            </label>
          )}
        </>
      )}
      {value.kind === 'string' && (
        <SmallInput
          aria-label={label}
          value={value.value}
          disabled={disabled}
          placeholder="text"
          onChange={(event) => onChange({ kind: 'string', value: event.target.value })}
          className="min-w-20 flex-1"
        />
      )}
      {value.kind === 'number' && (
        <SmallInput
          aria-label={label}
          value={value.value}
          disabled={disabled}
          inputMode="decimal"
          placeholder="0"
          aria-invalid={
            value.value !== '' && !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.value)
          }
          onChange={(event) => onChange({ kind: 'number', value: event.target.value.trim() })}
          className="w-24 font-mono"
        />
      )}
      {value.kind === 'boolean' && (
        <SmallSelect
          aria-label={label}
          value={value.value ? 'true' : 'false'}
          disabled={disabled}
          onChange={(event) => onChange({ kind: 'boolean', value: event.target.value === 'true' })}
          className="w-20"
        >
          <option value="true">TRUE</option>
          <option value="false">FALSE</option>
        </SmallSelect>
      )}
      {value.kind === 'parameter' && (
        <SmallInput
          aria-label={label}
          value={value.text}
          disabled={disabled}
          placeholder=":name"
          title="A placeholder the run asks a value for: :name, $1, or ? on MySQL and MariaDB"
          onChange={(event) => onChange({ kind: 'parameter', text: event.target.value.trim() })}
          className="w-24 font-mono"
        />
      )}
      {value.kind === 'raw' && (
        <RawInput label={label} sql={value.sql} disabled={disabled} onChange={onChange} />
      )}
    </span>
  );
}

function ColumnSelect(props: {
  readonly label: string;
  readonly value: QueryExpr & { kind: 'column' };
  readonly columns: readonly ColumnOption[];
  readonly disabled: boolean;
  readonly onChange: (column: QueryExpr) => void;
}) {
  const key = exprKey(props.value);
  const known = props.columns.some((option) => option.key === key);
  return (
    <SmallSelect
      aria-label={props.label}
      value={key}
      disabled={props.disabled}
      onChange={(event) => {
        const column = props.columns.find((option) => option.key === event.target.value);
        if (column) props.onChange(column.expr);
      }}
      className="min-w-24 flex-1"
    >
      {!known && <option value={key}>{props.value.column || '(pick a column)'}</option>}
      {props.columns.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </SmallSelect>
  );
}

/** SQL typed by hand, marked invalid (with the reason as its tooltip) until it is one expression. */
function RawInput(props: {
  readonly label: string;
  readonly sql: string;
  readonly disabled: boolean;
  readonly onChange: (expr: QueryExpr) => void;
}) {
  const dialect = useBuilder().target.dialect;
  const problem = props.sql.trim() === '' ? undefined : checkFragment(props.sql, dialect);
  return (
    <SmallInput
      aria-label={`${props.label} SQL`}
      value={props.sql}
      disabled={props.disabled}
      placeholder="lower(name)"
      aria-invalid={problem !== undefined}
      title={problem}
      onChange={(event) => props.onChange({ kind: 'raw', sql: event.target.value })}
      className="min-w-24 flex-1 font-mono"
    />
  );
}
