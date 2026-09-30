import { BSON_TYPES } from '@joinery/mongo-tools';
import { DropdownMenu } from 'radix-ui';
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import { formatCount } from '../../lib/format';
import { useCollectionState, type CollectionView } from '../../state/mongo/collection-view';
import { useQueryBuilder, type Blocked, type QueryBuilder } from '../../state/mongo/query-builder';
import {
  OPERATOR_LABELS,
  TYPE_CHOICES,
  VALUE_TYPES,
  VALUE_TYPE_LABELS,
  baseType,
  isQueryPath,
  operatorInput,
  operatorsFor,
  valueTypeFor,
  type BuilderField,
  type Condition,
  type ConditionOperator,
  type OrGroup,
  type ValueType,
} from '../../state/mongo/query-builder-model';
import { MenuItem } from '../Sidebar';
import { Button, Icon, cx } from '../ui';
import { Segmented, SmallSelect } from './parts';

/**
 * The visual query builder (spec §9, "Browsing and editing"): the collection's fields from a
 * schema sample on the left, and drop zones for the filter (conditions, AND, with OR groups one
 * level deep), the projection and the sort (reordered by drag, Alt+↑/↓ or the move buttons),
 * with skip and limit. Every field also has an "Add to…" menu, the keyboard and click way to do
 * what dragging does. The find() text under the builder follows every change and can be edited;
 * the builder reads it back, or says why it cannot and stays read-only.
 */

const FIELD_DRAG = 'application/x-joinery-field';
const SORT_DRAG = 'application/x-joinery-sort-key';

const ZONE = 'flex flex-col gap-1 rounded border border-dashed border-border bg-panel-2/40 p-1.5';
const ZONE_OVER = 'border-accent bg-accent/10';
const CONTROL =
  'h-6 rounded border border-border bg-panel-2 px-1.5 font-mono text-xs text-fg placeholder:text-muted/60 focus:border-accent focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-50';

const PLACEHOLDERS: Readonly<Record<ValueType, string>> = {
  string: 'text',
  int: '42',
  long: '42',
  double: '4.2',
  decimal: '9.99',
  objectId: '24 hex digits',
  date: '2026-01-31T09:30:00Z',
  bool: 'true',
  uuid: '0f8fad5b-d9cb-…',
  shell: "{ a: 1 } or 'text'",
};

export function QueryBuilderPanel({ view }: { readonly view: CollectionView }) {
  const blocked = useQueryBuilder(view.builder, (s) => s.blocked);
  const pending = useQueryBuilder(view.builder, (s) => s.pending);
  const extras = useCollectionState(view, (s) => s.extras);
  const kept = Object.keys(extras);
  return (
    <div className="flex max-h-80 min-h-40 gap-2" data-testid="mongo-builder">
      <FieldList view={view} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-auto">
        {blocked ? (
          <BlockedNote blocked={blocked} />
        ) : (
          <>
            <FilterZone view={view} />
            <div className="flex flex-wrap gap-1.5">
              <ProjectionZone builder={view.builder} />
              <SortZone builder={view.builder} />
            </div>
            <PageInputs view={view} />
          </>
        )}
        {!blocked && pending !== undefined && (
          <p className="text-[11px] text-muted" data-testid="builder-pending">
            Not in the find() text yet: {pending}
          </p>
        )}
        {kept.length > 0 && (
          <p className="text-[11px] text-muted">Kept from the find() text: {kept.join(', ')}.</p>
        )}
      </div>
    </div>
  );
}

function BlockedNote({ blocked }: { readonly blocked: Blocked }) {
  return (
    <div
      role="status"
      data-testid="builder-blocked"
      data-kind={blocked.kind}
      className="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-xs text-warning"
    >
      <Icon name="warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {blocked.kind === 'unsupported' ? (
          <>
            <strong>This query can’t be shown in the builder:</strong> {blocked.message}. Edit the
            find() text below; the builder follows once the query is simple again.
          </>
        ) : (
          blocked.message
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Drag and drop

/** A drop zone for fields dragged from the field list. */
function useFieldDrop(onDrop: (path: string) => void, disabled = false) {
  const [over, setOver] = useState(false);
  const accepts = (event: DragEvent): boolean =>
    !disabled && event.dataTransfer.types.includes(FIELD_DRAG);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const path = event.dataTransfer.getData(FIELD_DRAG);
        if (path !== '') onDrop(path);
      },
    },
  };
}

/** Focuses a condition's first control (after the menu that added it closes). */
function focusCondition(id: string | undefined): void {
  if (id === undefined) return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`)?.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Fields

function typeLabel(field: BuilderField): string {
  if (field.type !== 'array') return BSON_TYPES[field.type].label;
  return field.elementType === undefined ? 'Array' : `${BSON_TYPES[field.elementType].label}[]`;
}

function fieldTitle(field: BuilderField): string {
  const types = field.types.map((t) => BSON_TYPES[t].label).join(', ');
  return `${field.display} · ${types} · in ${Math.round(field.share * 100)}% of the sample`;
}

function FieldList({ view }: { readonly view: CollectionView }) {
  const builder = view.builder;
  const sample = useQueryBuilder(builder, (s) => s.sample);
  const search = useQueryBuilder(builder, (s) => s.search);
  const blocked = useQueryBuilder(builder, (s) => s.blocked !== undefined);
  const filter = useQueryBuilder(builder, (s) => s.query.filter);
  const groups = filter.filter((item): item is OrGroup => item.kind === 'or');
  const needle = search.trim();
  const shown =
    needle === ''
      ? sample.fields
      : sample.fields.filter((f) => f.path.toLowerCase().includes(needle.toLowerCase()));
  const custom =
    needle !== '' && isQueryPath(needle) && !sample.fields.some((f) => f.path === needle)
      ? needle
      : undefined;
  return (
    <section
      aria-label="Fields"
      className="flex w-60 shrink-0 flex-col rounded border border-border bg-panel-2"
      data-testid="builder-fields"
    >
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-0.5">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted"
          data-testid="builder-sample-summary"
          aria-live="polite"
        >
          {sample.status === 'loading'
            ? 'Sampling the collection…'
            : sample.status === 'done'
              ? `Fields of ${formatCount(sample.documentCount)} sampled ${sample.documentCount === 1 ? 'document' : 'documents'}`
              : 'Fields'}
        </span>
        <button
          type="button"
          aria-label="Sample the fields again"
          title="Sample the fields again"
          disabled={sample.status === 'loading'}
          onClick={() => void builder.loadFields()}
          className="rounded p-0.5 text-muted hover:bg-hover disabled:opacity-50"
        >
          <Icon name="refresh" className="h-3 w-3" />
        </button>
      </div>
      <input
        type="search"
        value={search}
        onChange={(event) => builder.setSearch(event.target.value)}
        placeholder="Find a field or type a path"
        aria-label="Find a field or type a path"
        spellCheck={false}
        className="h-6 border-b border-border bg-transparent px-1.5 font-mono text-xs text-fg placeholder:font-sans placeholder:text-muted/60 focus:outline-none"
        data-testid="builder-field-search"
      />
      {sample.status === 'error' && (
        <p role="alert" className="px-1.5 py-1 text-[11px] text-danger">
          Could not sample the fields: {sample.error}
        </p>
      )}
      {sample.status === 'done' && sample.fields.length === 0 && (
        <p className="px-1.5 py-1 text-[11px] text-muted">
          No documents to sample: type a field path above.
        </p>
      )}
      <ul aria-label="Collection fields" className="min-h-0 flex-1 overflow-auto py-0.5">
        {shown.map((field) => (
          <FieldItem
            key={field.path}
            builder={builder}
            path={field.path}
            field={field}
            groups={groups}
            disabled={blocked}
          />
        ))}
        {custom !== undefined && (
          <FieldItem
            builder={builder}
            path={custom}
            field={undefined}
            groups={groups}
            disabled={blocked}
          />
        )}
      </ul>
    </section>
  );
}

function FieldItem(props: {
  readonly builder: QueryBuilder;
  readonly path: string;
  readonly field: BuilderField | undefined;
  readonly groups: readonly OrGroup[];
  readonly disabled: boolean;
}) {
  const { builder, path, field } = props;
  const focusNext = useRef<string | undefined>(undefined);
  const added = (id: string | undefined): void => {
    focusNext.current = id;
  };
  return (
    <li
      draggable={!props.disabled}
      onDragStart={(event) => {
        event.dataTransfer.setData(FIELD_DRAG, path);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      data-testid="builder-field"
      data-path={path}
      title={field ? fieldTitle(field) : 'Not in the sample'}
      className={cx(
        'flex h-6 items-center gap-1 pr-1 text-xs hover:bg-hover',
        !props.disabled && 'cursor-grab active:cursor-grabbing',
      )}
      style={{ paddingLeft: 6 + (field?.depth ?? 0) * 12 }}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{field ? field.name : path}</span>
      <span className="shrink-0 text-[10px] text-muted">
        {field ? typeLabel(field) : 'new path'}
      </span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Add ${path} to…`}
            title="Add to the filter, projection or sort"
            disabled={props.disabled}
            className="rounded p-0.5 text-muted hover:bg-panel hover:text-fg disabled:opacity-40"
          >
            <Icon name="plus" className="h-3 w-3" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="z-50 min-w-44 rounded border border-border bg-panel p-1 text-[13px] shadow-xl"
            onCloseAutoFocus={(event) => {
              const id = focusNext.current;
              focusNext.current = undefined;
              if (id === undefined) return;
              event.preventDefault();
              focusCondition(id);
            }}
          >
            <MenuItem onSelect={() => added(builder.addCondition(path))}>Add to filter</MenuItem>
            {props.groups.map((group, index) => (
              <MenuItem key={group.id} onSelect={() => added(builder.addCondition(path, group.id))}>
                Add to OR group {index + 1}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => added(builder.addOrGroup(path)?.condition)}>
              Add to a new OR group
            </MenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem onSelect={() => builder.addProjection(path)}>Add to projection</MenuItem>
            <MenuItem onSelect={() => builder.addSort(path)}>Add to sort</MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Zones

function ZoneHeader(props: {
  readonly title: string;
  readonly hint: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold text-fg">{props.title}</span>
      <span className="flex-1 truncate text-[11px] text-muted">{props.hint}</span>
      {props.children}
    </div>
  );
}

function EmptyHint({ children }: { readonly children: ReactNode }) {
  return <p className="px-1 py-0.5 text-[11px] text-muted">{children}</p>;
}

function RemoveButton(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
    >
      <Icon name="close" className="h-3 w-3" />
    </button>
  );
}

function FilterZone({ view }: { readonly view: CollectionView }) {
  const builder = view.builder;
  const filter = useQueryBuilder(builder, (s) => s.query.filter);
  const drop = useFieldDrop((path) => focusCondition(builder.addCondition(path)));
  let groupNumber = 0;
  return (
    <section
      aria-label="Filter"
      data-testid="builder-filter"
      {...drop.props}
      className={cx(ZONE, drop.over && ZONE_OVER)}
    >
      <ZoneHeader title="Filter" hint="Documents matching all of these (AND)">
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[11px]"
          onClick={() => builder.addOrGroup()}
          data-testid="builder-add-or"
        >
          <Icon name="plus" className="h-3 w-3" />
          OR group
        </Button>
      </ZoneHeader>
      {filter.length === 0 ? (
        <EmptyHint>Every document matches. Drag fields here, or use a field’s + menu.</EmptyHint>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Filter conditions">
          {filter.map((item, index) => {
            if (item.kind === 'or') groupNumber += 1;
            return (
              <li key={item.id} className="flex items-start gap-1">
                <Joiner text={index === 0 ? 'where' : 'and'} />
                {item.kind === 'or' ? (
                  <OrGroupBox view={view} group={item} number={groupNumber} />
                ) : (
                  <ConditionRow view={view} condition={item} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Joiner({ text }: { readonly text: string }) {
  return (
    <span className="w-12 shrink-0 pt-1 pr-0.5 text-right text-[10px] font-semibold text-muted uppercase">
      {text}
    </span>
  );
}

function OrGroupBox(props: {
  readonly view: CollectionView;
  readonly group: OrGroup;
  readonly number: number;
}) {
  const { view, group, number } = props;
  const builder = view.builder;
  const drop = useFieldDrop((path) => focusCondition(builder.addCondition(path, group.id)));
  return (
    <div
      role="group"
      aria-label={`OR group ${number}`}
      data-testid="builder-or-group"
      {...drop.props}
      className={cx(
        'flex min-w-0 flex-1 flex-col gap-1 rounded border border-dashed border-accent/60 bg-accent/5 p-1',
        drop.over && ZONE_OVER,
      )}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-semibold text-accent">Any of these (OR)</span>
        <span className="flex-1" />
        <RemoveButton
          label={`Remove OR group ${number}`}
          onClick={() => builder.removeGroup(group.id)}
        />
      </div>
      {group.conditions.length === 0 ? (
        <EmptyHint>Drag fields here, or use a field’s + menu → Add to OR group {number}.</EmptyHint>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={`OR group ${number} conditions`}>
          {group.conditions.map((condition, index) => (
            <li key={condition.id} className="flex items-start gap-1">
              <Joiner text={index === 0 ? 'either' : 'or'} />
              <ConditionRow view={view} condition={condition} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConditionRow(props: { readonly view: CollectionView; readonly condition: Condition }) {
  const { view, condition: c } = props;
  const builder = view.builder;
  const issue = useQueryBuilder(builder, (s) => s.issues.conditions[c.id]);
  const field = useQueryBuilder(builder, (s) => s.sample.fields.find((f) => f.path === c.path));
  const operators = operatorsFor(field);
  if (!operators.includes(c.operator)) operators.push(c.operator);
  const input = operatorInput(c.operator);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    const runs =
      target instanceof HTMLInputElement ||
      (target instanceof HTMLTextAreaElement && (event.ctrlKey || event.metaKey));
    if (event.key === 'Enter' && runs) {
      event.preventDefault();
      void view.run();
    }
  };
  return (
    <div
      role="group"
      aria-label={`Condition on ${c.path}`}
      data-testid="builder-condition"
      data-path={c.path}
      data-operator={c.operator}
      className="flex min-w-0 flex-1 flex-col gap-0.5"
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="max-w-[14rem] truncate font-mono text-xs" title={c.path}>
          {c.path}
        </span>
        <SmallSelect
          aria-label={`${c.path} operator`}
          value={c.operator}
          onChange={(event) =>
            builder.updateCondition(c.id, { operator: event.target.value as ConditionOperator })
          }
          className="h-6"
          data-testid="builder-operator"
          {...(input === 'none' ? { 'data-focus-id': c.id } : {})}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </option>
          ))}
        </SmallSelect>
        <ValueEditor builder={builder} condition={c} field={field} invalid={issue !== undefined} />
        <RemoveButton
          label={`Remove the condition on ${c.path}`}
          onClick={() => builder.removeCondition(c.id)}
        />
      </div>
      {issue !== undefined && (
        <p role="alert" className="text-[11px] text-danger" data-testid="builder-condition-issue">
          {issue}
        </p>
      )}
    </div>
  );
}

function ValueEditor(props: {
  readonly builder: QueryBuilder;
  readonly condition: Condition;
  readonly field: BuilderField | undefined;
  readonly invalid: boolean;
}) {
  const { builder, condition: c, field, invalid } = props;
  const set = (patch: Parameters<QueryBuilder['updateCondition']>[1]): void =>
    builder.updateCondition(c.id, patch);
  const focus = { 'data-focus-id': c.id };
  const typePicker = (
    <SmallSelect
      aria-label={`${c.path} value type`}
      value={c.valueType}
      onChange={(event) => set({ valueType: event.target.value as ValueType })}
      className="h-6"
      data-testid="builder-value-type"
    >
      {VALUE_TYPES.map((type) => (
        <option key={type} value={type}>
          {VALUE_TYPE_LABELS[type]}
        </option>
      ))}
    </SmallSelect>
  );
  switch (operatorInput(c.operator)) {
    case 'none':
      return <span className="text-[11px] text-muted">null or missing</span>;
    case 'exists':
      return (
        <SmallSelect
          aria-label={`${c.path} exists`}
          value={c.text === 'false' ? 'false' : 'true'}
          onChange={(event) => set({ text: event.target.value })}
          className="h-6"
          {...focus}
        >
          <option value="true">is present</option>
          <option value="false">is missing</option>
        </SmallSelect>
      );
    case 'type':
      return (
        <SmallSelect
          aria-label={`${c.path} type`}
          value={c.text}
          onChange={(event) => set({ text: event.target.value })}
          className="h-6"
          {...focus}
        >
          {TYPE_CHOICES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </SmallSelect>
      );
    case 'size':
      return (
        <input
          type="number"
          min={0}
          step={1}
          aria-label={`${c.path} size`}
          aria-invalid={invalid}
          value={c.text}
          onChange={(event) => set({ text: event.target.value })}
          className={cx(CONTROL, 'w-20')}
          data-testid="builder-value"
          {...focus}
        />
      );
    case 'regex':
      return (
        <>
          <input
            aria-label={`${c.path} pattern`}
            aria-invalid={invalid}
            value={c.text}
            placeholder="^Ada"
            spellCheck={false}
            onChange={(event) => set({ text: event.target.value })}
            className={cx(CONTROL, 'min-w-32 flex-1')}
            data-testid="builder-value"
            {...focus}
          />
          <input
            aria-label={`${c.path} regex flags`}
            value={c.flags}
            placeholder="i"
            spellCheck={false}
            title="Flags: i (ignore case), m, s, u, x"
            onChange={(event) => set({ flags: event.target.value })}
            className={cx(CONTROL, 'w-12')}
          />
        </>
      );
    case 'list':
      return (
        <>
          <textarea
            aria-label={`${c.path} values`}
            aria-invalid={invalid}
            value={c.text}
            placeholder="One value per line"
            spellCheck={false}
            rows={Math.min(4, Math.max(2, c.text.split('\n').length))}
            onChange={(event) => set({ text: event.target.value })}
            className={cx(CONTROL, 'h-auto min-w-32 flex-1 py-0.5')}
            data-testid="builder-value"
            {...focus}
          />
          {typePicker}
        </>
      );
    case 'value': {
      const listId = `${c.id}-suggestions`;
      const suggestions =
        field && valueTypeFor(baseType(field)) === c.valueType ? field.suggestions : [];
      return (
        <>
          {c.valueType === 'bool' ? (
            <SmallSelect
              aria-label={`${c.path} value`}
              value={c.text === 'false' ? 'false' : 'true'}
              onChange={(event) => set({ text: event.target.value })}
              className="h-6"
              data-testid="builder-value"
              {...focus}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </SmallSelect>
          ) : (
            <input
              aria-label={`${c.path} value`}
              aria-invalid={invalid}
              value={c.text}
              placeholder={PLACEHOLDERS[c.valueType]}
              spellCheck={false}
              list={suggestions.length > 0 ? listId : undefined}
              onChange={(event) => set({ text: event.target.value })}
              className={cx(CONTROL, 'min-w-32 flex-1')}
              data-testid="builder-value"
              {...focus}
            />
          )}
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((text) => (
                <option key={text} value={text} />
              ))}
            </datalist>
          )}
          {typePicker}
        </>
      );
    }
  }
}

function ProjectionZone({ builder }: { readonly builder: QueryBuilder }) {
  const entries = useQueryBuilder(builder, (s) => s.query.projection);
  const issue = useQueryBuilder(builder, (s) => s.issues.projection);
  const drop = useFieldDrop((path) => builder.addProjection(path));
  return (
    <section
      aria-label="Projection"
      data-testid="builder-projection"
      {...drop.props}
      className={cx(ZONE, 'min-w-60 flex-1', drop.over && ZONE_OVER)}
    >
      <ZoneHeader title="Projection" hint="Fields to return" />
      {entries.length === 0 ? (
        <EmptyHint>Whole documents. Drag fields here to pick them.</EmptyHint>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Projected fields">
          {entries.map((entry) => (
            <li
              key={entry.path}
              className="flex items-center gap-1"
              data-testid="builder-projection-entry"
              data-path={entry.path}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
              <Segmented
                label={`${entry.path} projection`}
                value={entry.include ? 'include' : 'exclude'}
                options={[
                  { value: 'include', label: 'Include' },
                  { value: 'exclude', label: 'Exclude' },
                ]}
                onChange={(value) => builder.setProjection(entry.path, value === 'include')}
              />
              <RemoveButton
                label={`Remove ${entry.path} from the projection`}
                onClick={() => builder.removeProjection(entry.path)}
              />
            </li>
          ))}
        </ul>
      )}
      {issue !== undefined && (
        <p role="alert" className="text-[11px] text-danger" data-testid="builder-projection-issue">
          {issue}
        </p>
      )}
    </section>
  );
}

function SortZone({ builder }: { readonly builder: QueryBuilder }) {
  const entries = useQueryBuilder(builder, (s) => s.query.sort);
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const [over, setOver] = useState<number | undefined>(undefined);
  const drop = useFieldDrop((path) => builder.addSort(path));
  const reset = (): void => {
    setDragging(undefined);
    setOver(undefined);
  };
  return (
    <section
      aria-label="Sort"
      data-testid="builder-sort"
      {...drop.props}
      className={cx(ZONE, 'min-w-60 flex-1', drop.over && ZONE_OVER)}
    >
      <ZoneHeader title="Sort" hint="By the first key, then the next" />
      {entries.length === 0 ? (
        <EmptyHint>Natural order. Drag fields here to sort by them.</EmptyHint>
      ) : (
        <ol className="flex flex-col gap-0.5" aria-label="Sort keys">
          {entries.map((entry, index) => {
            const onHandleKey = (event: KeyboardEvent): void => {
              if (!event.altKey) return;
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                builder.moveSort(index, index - 1);
              } else if (event.key === 'ArrowDown' && index < entries.length - 1) {
                event.preventDefault();
                builder.moveSort(index, index + 1);
              }
            };
            return (
              <li
                key={entry.path}
                data-testid="builder-sort-entry"
                data-path={entry.path}
                className={cx(
                  'flex items-center gap-1 rounded',
                  over === index &&
                    dragging !== undefined &&
                    dragging !== index &&
                    'ring-1 ring-accent',
                  dragging === index && 'opacity-50',
                )}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(SORT_DRAG)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                  setOver(index);
                }}
                onDrop={(event) => {
                  if (!event.dataTransfer.types.includes(SORT_DRAG)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const from = Number(event.dataTransfer.getData(SORT_DRAG));
                  reset();
                  if (Number.isInteger(from) && from !== index) builder.moveSort(from, index);
                }}
              >
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(SORT_DRAG, String(index));
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(index);
                  }}
                  onDragEnd={reset}
                  onKeyDown={onHandleKey}
                  aria-label={`Reorder sort key ${entry.path} (drag, or Alt+Up / Alt+Down)`}
                  title="Drag to reorder, or Alt+Up / Alt+Down"
                  className="cursor-grab rounded px-0.5 font-mono text-xs text-muted hover:bg-hover active:cursor-grabbing"
                >
                  ⠿
                </button>
                <span className="w-3 text-[10px] text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
                <Segmented
                  label={`${entry.path} sort direction`}
                  value={entry.direction === 1 ? 'asc' : 'desc'}
                  options={[
                    { value: 'asc', label: 'Asc' },
                    { value: 'desc', label: 'Desc' },
                  ]}
                  onChange={(value) =>
                    builder.setSortDirection(entry.path, value === 'asc' ? 1 : -1)
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1"
                  aria-label={`Move ${entry.path} up`}
                  disabled={index === 0}
                  onClick={() => builder.moveSort(index, index - 1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1"
                  aria-label={`Move ${entry.path} down`}
                  disabled={index === entries.length - 1}
                  onClick={() => builder.moveSort(index, index + 1)}
                >
                  ↓
                </Button>
                <RemoveButton
                  label={`Remove ${entry.path} from the sort`}
                  onClick={() => builder.removeSort(entry.path)}
                />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function PageInputs({ view }: { readonly view: CollectionView }) {
  const builder = view.builder;
  const skip = useQueryBuilder(builder, (s) => s.query.skip);
  const limit = useQueryBuilder(builder, (s) => s.query.limit);
  const skipIssue = useQueryBuilder(builder, (s) => s.issues.skip);
  const limitIssue = useQueryBuilder(builder, (s) => s.issues.limit);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void view.run();
    }
  };
  const count = (
    label: 'Skip' | 'Limit',
    value: string,
    issue: string | undefined,
    onChange: (text: string) => void,
  ) => (
    <label className="flex items-center gap-1 text-[11px] font-medium text-muted">
      {label}
      <input
        type="number"
        min={0}
        step={1}
        value={value}
        placeholder="0"
        aria-invalid={issue !== undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className={cx(CONTROL, 'w-24')}
        data-testid={`builder-${label.toLowerCase()}`}
      />
    </label>
  );
  const issue = skipIssue ?? limitIssue;
  return (
    <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Skip and limit">
      {count('Skip', skip, skipIssue, (text) => builder.setSkip(text))}
      {count('Limit', limit, limitIssue, (text) => builder.setLimit(text))}
      {issue !== undefined && (
        <span role="alert" className="text-[11px] text-danger">
          {issue}
        </span>
      )}
    </div>
  );
}
