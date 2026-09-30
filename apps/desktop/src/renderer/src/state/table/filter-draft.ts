import { newId, type CellValue, type SqlDialect } from '@joinery/core';
import {
  checkRawWhere,
  formatCell,
  operatorsFor,
  parseCellInput,
  validateFilter,
  type ColumnInfo,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
  type RawWhereCheck,
} from '@joinery/table-data';

/**
 * The filter bar's editable model (spec §7: a visual builder with column, operator, value and
 * AND/OR groups, or a raw WHERE clause). The builder keeps what the user typed as text, with a
 * stable id per node so issues can be shown next to the right row; `compileDraft` turns it into
 * the engine's FilterNode, parsing each operand for its column and collecting every problem.
 */

export interface ConditionDraft {
  readonly id: string;
  readonly type: 'condition';
  readonly column: string;
  readonly operator: FilterOperator;
  /** The operand; a comma-separated list for in / not in; the low end for between. */
  readonly text: string;
  /** The high end for between. */
  readonly text2: string;
  readonly caseSensitive: boolean;
  readonly disabled: boolean;
}

export interface GroupDraft {
  readonly id: string;
  readonly type: 'group';
  readonly combinator: 'and' | 'or';
  readonly children: readonly FilterDraft[];
  readonly disabled: boolean;
}

export type FilterDraft = ConditionDraft | GroupDraft;

export const OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = {
  '=': '=',
  '!=': '≠',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  contains: 'contains',
  'not-contains': 'does not contain',
  'starts-with': 'starts with',
  'ends-with': 'ends with',
  like: 'like',
  'not-like': 'not like',
  in: 'in',
  'not-in': 'not in',
  between: 'between',
  'is-null': 'is null',
  'is-not-null': 'is not null',
  'is-empty': 'is empty',
  'is-not-empty': 'is not empty',
  'is-true': 'is true',
  'is-false': 'is false',
  'json-contains': 'JSON contains',
};

const NO_OPERAND: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  'is-null',
  'is-not-null',
  'is-empty',
  'is-not-empty',
  'is-true',
  'is-false',
]);

/** Operators whose operand is text as typed (patterns, substrings, JSON documents). */
const TEXT_OPERAND: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  'contains',
  'not-contains',
  'starts-with',
  'ends-with',
  'like',
  'not-like',
  'json-contains',
]);

/** How many operands an operator takes in the builder: none, one, a list, or two. */
export function operandShape(operator: FilterOperator): 'none' | 'one' | 'list' | 'range' {
  if (NO_OPERAND.has(operator)) return 'none';
  if (operator === 'in' || operator === 'not-in') return 'list';
  if (operator === 'between') return 'range';
  return 'one';
}

/** Whether the operator matches text case-insensitively unless told otherwise. */
export function isTextOperator(operator: FilterOperator): boolean {
  return TEXT_OPERAND.has(operator) && operator !== 'json-contains';
}

/** An empty AND group: the root of a new filter. */
export function emptyFilter(): GroupDraft {
  return { id: newId(), type: 'group', combinator: 'and', children: [], disabled: false };
}

/** A condition on `column` with the first operator the column offers. */
export function newCondition(column: ColumnInfo, dialect: SqlDialect): ConditionDraft {
  return {
    id: newId(),
    type: 'condition',
    column: column.name,
    operator: operatorsFor(column, dialect)[0] ?? 'is-null',
    text: '',
    text2: '',
    caseSensitive: false,
    disabled: false,
  };
}

function mapTree(
  node: FilterDraft,
  visit: (node: FilterDraft) => FilterDraft | null,
): FilterDraft | null {
  const next = visit(node);
  if (next === null || next.type === 'condition') return next;
  const children = next.children
    .map((child) => mapTree(child, visit))
    .filter((child): child is FilterDraft => child !== null);
  return children.length === next.children.length &&
    children.every((child, i) => child === next.children[i])
    ? next
    : { ...next, children };
}

/** Replaces the node `id` (a condition or group) with `patch` applied. */
export function updateNode(
  root: GroupDraft,
  id: string,
  patch: Partial<Omit<ConditionDraft, 'id' | 'type'>> | Partial<Omit<GroupDraft, 'id' | 'type'>>,
): GroupDraft {
  return mapTree(root, (node) =>
    node.id === id ? ({ ...node, ...patch } as FilterDraft) : node,
  ) as GroupDraft;
}

/** Appends `child` to the group `groupId`. */
export function addChild(root: GroupDraft, groupId: string, child: FilterDraft): GroupDraft {
  return mapTree(root, (node) =>
    node.id === groupId && node.type === 'group'
      ? { ...node, children: [...node.children, child] }
      : node,
  ) as GroupDraft;
}

/** Removes a node; the root itself is emptied instead. */
export function removeNode(root: GroupDraft, id: string): GroupDraft {
  if (root.id === id) return { ...root, children: [] };
  return mapTree(root, (node) => (node.id === id ? null : node)) as GroupDraft;
}

/** Points a condition at another column, keeping the operator when the column offers it. */
export function setConditionColumn(
  condition: ConditionDraft,
  column: ColumnInfo,
  dialect: SqlDialect,
): ConditionDraft {
  const operators = operatorsFor(column, dialect);
  return {
    ...condition,
    column: column.name,
    operator: operators.includes(condition.operator)
      ? condition.operator
      : (operators[0] ?? 'is-null'),
  };
}

/** Whether the draft has at least one enabled condition. */
export function hasConditions(node: FilterDraft): boolean {
  if (node.disabled) return false;
  return node.type === 'condition' || node.children.some(hasConditions);
}

type Parsed =
  { readonly ok: true; readonly value: CellValue } | { readonly ok: false; readonly error: string };

/** A column the operand parser accepts: any value may be looked for, NULL included. */
function operandColumn(column: ColumnInfo): ColumnInfo {
  const { readOnly: _readOnly, ...rest } = column;
  return { ...rest, nullable: true };
}

/**
 * The operand typed for `operator` on `column`, as the engine expects it: text as typed for
 * text operators, otherwise parsed for the column's type (numbers, dates, booleans...).
 */
export function parseOperand(text: string, column: ColumnInfo, operator: FilterOperator): Parsed {
  if (TEXT_OPERAND.has(operator)) return { ok: true, value: text };
  const parsed = parseCellInput(text, operandColumn(column));
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error };
}

/** Splits an in-list: commas separate values, "quoted" values keep commas, NULL is NULL. */
export function splitList(text: string): { readonly text: string; readonly isNull: boolean }[] {
  const items: { text: string; isNull: boolean }[] = [];
  let i = 0;
  while (i <= text.length) {
    while (text[i] === ' ') i++;
    let item = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          item += '"';
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else item += text[i++];
      }
      while (i < text.length && text[i] !== ',') i++;
    } else {
      while (i < text.length && text[i] !== ',') item += text[i++];
      item = item.trim();
    }
    if (quoted || item !== '') items.push({ text: item, isNull: !quoted && /^null$/i.test(item) });
    i++;
  }
  return items;
}

export interface CompiledFilter {
  /** The filter to query with; undefined when nothing is enabled. */
  readonly filter: FilterGroup | undefined;
  /** Problems by draft node id; the filter must not run while any exists. */
  readonly issues: Readonly<Record<string, string>>;
}

/**
 * Turns the builder's draft into the engine's filter: operands parsed for their columns, then
 * `validateFilter` for what the engine itself rejects. Issues are keyed by draft node id.
 */
export function compileDraft(
  root: GroupDraft,
  columns: readonly ColumnInfo[],
  dialect: SqlDialect,
): CompiledFilter {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const issues: Record<string, string> = {};
  /** Path (child indexes in the compiled tree) → draft id, for the engine's issues. */
  const paths = new Map<string, string>();

  const convert = (node: FilterDraft, path: number[]): FilterNode | null => {
    if (node.disabled) return null;
    if (node.type === 'group') {
      const children: FilterNode[] = [];
      for (const child of node.children) {
        const converted = convert(child, [...path, children.length]);
        if (converted) children.push(converted);
      }
      if (children.length === 0) return null;
      paths.set(path.join('.'), node.id);
      return { type: 'group', combinator: node.combinator, children };
    }
    paths.set(path.join('.'), node.id);
    const column = byName.get(node.column);
    if (!column) {
      issues[node.id] = `Unknown column ${node.column}`;
      return null;
    }
    const base = {
      type: 'condition' as const,
      column: node.column,
      operator: node.operator,
      ...(node.caseSensitive && isTextOperator(node.operator) ? { caseSensitive: true } : {}),
    };
    switch (operandShape(node.operator)) {
      case 'none':
        return base;
      case 'one': {
        const parsed = parseOperand(node.text, column, node.operator);
        if (!parsed.ok) {
          issues[node.id] = parsed.error;
          return null;
        }
        return { ...base, value: parsed.value };
      }
      case 'list': {
        const values: CellValue[] = [];
        const items = splitList(node.text);
        if (items.length === 0) {
          issues[node.id] = 'Type one or more values, separated by commas';
          return null;
        }
        for (const item of items) {
          if (item.isNull) {
            values.push(null);
            continue;
          }
          const parsed = parseOperand(item.text, column, node.operator);
          if (!parsed.ok) {
            issues[node.id] = `${item.text}: ${parsed.error}`;
            return null;
          }
          values.push(parsed.value);
        }
        return { ...base, values };
      }
      case 'range': {
        const low = parseOperand(node.text, column, node.operator);
        const high = parseOperand(node.text2, column, node.operator);
        if (!low.ok || !high.ok) {
          issues[node.id] = !low.ok
            ? `From: ${low.error}`
            : `To: ${(high as { error: string }).error}`;
          return null;
        }
        return { ...base, values: [low.value, high.value] };
      }
    }
  };

  const compiled = convert(root, []);
  if (compiled === null) return { filter: undefined, issues };
  const filter: FilterGroup =
    compiled.type === 'group'
      ? compiled
      : { type: 'group', combinator: 'and', children: [compiled] };
  for (const issue of validateFilter(filter, columns, dialect)) {
    const id = paths.get(issue.path.join('.')) ?? root.id;
    issues[id] ??= issue.message;
  }
  return { filter, issues };
}

/**
 * A builder draft for an engine filter, e.g. the "open referenced row" filter of a foreign key.
 * Operands are shown the way the cell editor would show them.
 */
export function draftFromFilter(node: FilterNode): GroupDraft {
  const convert = (item: FilterNode): FilterDraft => {
    if (item.type === 'group') {
      return {
        id: newId(),
        type: 'group',
        combinator: item.combinator,
        children: item.children.map(convert),
        disabled: item.disabled === true,
      };
    }
    const values = item.values ?? [];
    const quote = (value: CellValue): string => {
      if (value === null) return 'NULL';
      const text = formatCell(value);
      return /[",]/.test(text) || /^null$/i.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return {
      id: newId(),
      type: 'condition',
      column: item.column,
      operator: item.operator,
      text:
        operandShape(item.operator) === 'list'
          ? values.map(quote).join(', ')
          : operandShape(item.operator) === 'range'
            ? formatCell(values[0] ?? null)
            : formatCell(item.value ?? null),
      text2: operandShape(item.operator) === 'range' ? formatCell(values[1] ?? null) : '',
      caseSensitive: item.caseSensitive === true,
      disabled: item.disabled === true,
    };
  };
  const draft = convert(node);
  return draft.type === 'group'
    ? draft
    : { id: newId(), type: 'group', combinator: 'and', children: [draft], disabled: false };
}

/** The raw WHERE box's check; an empty box is fine (no condition). */
export function checkRawCondition(text: string, dialect: SqlDialect): RawWhereCheck | undefined {
  if (text.trim() === '') return undefined;
  return checkRawWhere(text, dialect);
}
