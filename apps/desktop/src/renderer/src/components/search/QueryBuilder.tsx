import {
  BUCKET_AGGREGATIONS,
  CALENDAR_INTERVALS,
  DSL_AGGREGATIONS,
  DSL_AGGREGATION_LABELS,
  DSL_OPERATOR_LABELS,
  DSL_OPERATOR_QUERIES,
  OCCURS,
  aggregationsFor,
  operatorsFor,
  sortPath,
  splitList,
  valueInput,
  type DslAggregation,
  type DslAggregationType,
  type DslCondition,
  type DslField,
  type DslFieldKind,
  type DslGroup,
  type DslItem,
  type DslOperator,
  type DslRaw,
  type DslSortItem,
  type Occur,
} from '@joinery/search-tools';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

import { formatCount } from '../../lib/format';
import type { DocumentsView } from '../../state/search/documents';
import {
  useDslBuilder,
  type ClauseTarget,
  type DslBuilder,
} from '../../state/search/query-builder';
import { useSearchView } from '../../state/search/view';
import { Segmented, SmallSelect } from '../mongo/parts';
import { MenuItem } from '../Sidebar';
import { Button, Icon, cx } from '../ui';
import { openSearchConsole } from './open';

/**
 * The Elasticsearch query builder (spec §11, ADR 0024), the documents view's second query
 * editor: the index's mapped fields on the left, and tabs for the query (a bool query's Must,
 * Filter, Should and Must not sections of conditions, groups, nested groups and JSON clauses,
 * each dragged, or moved with its menu), the sort, the aggregations (with sub-aggregations) and
 * the request it runs. Fields are dragged into a section, the sort or the aggregations, or
 * added with their + menu. Every complete change goes to the query bar; the bar's text comes
 * back into the builder.
 */

const FIELD_DRAG = 'application/x-joinery-search-field';
const CLAUSE_DRAG = 'application/x-joinery-search-clause';
const SORT_DRAG = 'application/x-joinery-search-sort';

const CONTROL =
  'h-6 rounded border border-border bg-panel-2 px-1.5 font-mono text-xs text-fg placeholder:font-sans placeholder:text-muted/60 focus:border-accent focus:outline-none aria-[invalid=true]:border-danger disabled:opacity-50';

type BuilderTab = 'query' | 'sort' | 'aggs' | 'request';

const OCCUR_META: Readonly<
  Record<Occur, { readonly label: string; readonly tone: string; readonly bar: string }>
> = {
  must: { label: 'Must', tone: 'text-accent', bar: 'bg-accent' },
  filter: { label: 'Filter', tone: 'text-success', bar: 'bg-success' },
  should: { label: 'Should', tone: 'text-warning', bar: 'bg-warning' },
  must_not: { label: 'Must not', tone: 'text-danger', bar: 'bg-danger' },
};

const KIND_TONES: Readonly<Record<DslFieldKind, string>> = {
  text: 'text-accent',
  keyword: 'text-success',
  number: 'text-warning',
  date: 'text-warning',
  boolean: 'text-fg',
  ip: 'text-fg',
  geo: 'text-danger',
  object: 'text-muted',
  nested: 'text-muted',
  other: 'text-muted',
};

function occurHint(group: DslGroup, occur: Occur): string {
  switch (occur) {
    case 'must':
      return 'match every one; they score';
    case 'filter':
      return 'match every one, without scoring (cached)';
    case 'must_not':
      return 'match none of them';
    case 'should': {
      const msm = group.minimumShouldMatch.trim();
      if (msm !== '') return `match at least ${msm} of them`;
      return group.clauses.must.length + group.clauses.filter.length > 0
        ? 'optional: a match raises the score'
        : 'match at least one of them';
    }
  }
}

/** A group's issue about minimum_should_match (shown by its Should section, not the group). */
function isMsmIssue(issue: string | undefined): boolean {
  return issue?.startsWith('minimum_should_match') ?? false;
}

/** Focuses a new clause's first control (after the menu that added it closes). */
function focusItem(id: string | undefined): void {
  if (id === undefined) return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`)?.focus();
  });
}

/** Enter in a value runs the search. */
function runOnEnter(view: DocumentsView) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target;
    const runs =
      target instanceof HTMLInputElement ||
      (target instanceof HTMLTextAreaElement && (event.ctrlKey || event.metaKey));
    if (event.key === 'Enter' && runs) {
      event.preventDefault();
      void view.search();
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Drag and drop

function useDrop(handlers: {
  readonly field?: (path: string) => void;
  readonly clause?: (id: string) => void;
  readonly sort?: (index: number) => void;
}) {
  const [over, setOver] = useState(false);
  const kind = (event: DragEvent): string | undefined => {
    const types = event.dataTransfer.types;
    if (handlers.field && types.includes(FIELD_DRAG)) return FIELD_DRAG;
    if (handlers.clause && types.includes(CLAUSE_DRAG)) return CLAUSE_DRAG;
    if (handlers.sort && types.includes(SORT_DRAG)) return SORT_DRAG;
    return undefined;
  };
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        const type = kind(event);
        if (!type) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = type === FIELD_DRAG ? 'copy' : 'move';
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        const type = kind(event);
        if (!type) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const data = event.dataTransfer.getData(type);
        if (type === FIELD_DRAG) handlers.field?.(data);
        else if (type === CLAUSE_DRAG) handlers.clause?.(data);
        else if (data !== '') handlers.sort?.(Number(data));
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The panel

export function QueryBuilderPanel({ view }: { readonly view: DocumentsView }) {
  const builder = view.builder;
  const [tab, setTab] = useState<BuilderTab>('query');
  const blocked = useDslBuilder(builder, (s) => s.blocked);
  const pending = useDslBuilder(builder, (s) => s.pending);
  const clauseCount = useDslBuilder(builder, (s) => {
    let n = 0;
    const count = (group: DslGroup): void => {
      for (const occur of OCCURS) {
        for (const item of group.clauses[occur]) {
          n += 1;
          if (item.kind === 'group') count(item);
        }
      }
    };
    count(s.model.query);
    return n;
  });
  const sortCount = useDslBuilder(builder, (s) => s.model.sort.length);
  const aggCount = useDslBuilder(builder, (s) => s.model.aggs.length);
  const tabs: { id: BuilderTab; label: string; count?: number }[] = [
    { id: 'query', label: 'Query', count: clauseCount },
    { id: 'sort', label: 'Sort', count: sortCount },
    { id: 'aggs', label: 'Aggregations', count: aggCount },
    { id: 'request', label: 'Request' },
  ];
  return (
    <div
      className="flex h-[clamp(15rem,42vh,30rem)] gap-2"
      data-testid="search-builder"
      onKeyDown={runOnEnter(view)}
    >
      <FieldList view={view} onAdded={(target) => setTab(target)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-bg">
        <div
          role="tablist"
          aria-label="Builder"
          className="flex items-center gap-0.5 border-b border-border bg-panel px-1.5"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              data-testid={`search-builder-tab-${t.id}`}
              className={cx(
                '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs transition-colors outline-none focus-visible:bg-hover',
                tab === t.id
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span
                  className={cx(
                    'min-w-4 rounded-full px-1 text-center text-[10px] tabular-nums',
                    tab === t.id ? 'bg-badge text-fg' : 'bg-panel-2 text-muted',
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => builder.clear()}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
            title="Remove every clause, sort key and aggregation"
          >
            Clear all
          </button>
        </div>
        {blocked ? (
          <BlockedNote builder={builder} message={blocked} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2" role="tabpanel">
            {tab === 'query' && <QueryTab view={view} />}
            {tab === 'sort' && <SortTab view={view} />}
            {tab === 'aggs' && <AggregationsTab view={view} />}
            {tab === 'request' && <RequestTab view={view} />}
          </div>
        )}
        {!blocked && pending !== undefined && (
          <p
            className="flex items-center gap-1.5 border-t border-border bg-warning/10 px-2 py-1 text-[11px] text-warning"
            data-testid="search-builder-pending"
            role="status"
          >
            <Icon name="warning" className="h-3.5 w-3.5" />
            Not in the query yet: {pending}
          </p>
        )}
      </div>
    </div>
  );
}

function BlockedNote(props: { readonly builder: DslBuilder; readonly message: string }) {
  return (
    <div
      className="flex flex-1 items-start justify-center p-6"
      data-testid="search-builder-blocked"
    >
      <div className="flex max-w-md flex-col items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
        <span className="flex items-center gap-1.5 font-semibold">
          <Icon name="warning" className="h-4 w-4" />
          The builder cannot read the query bar
        </span>
        <span className="text-fg">{props.message}</span>
        <Button size="sm" variant="secondary" onClick={() => props.builder.clear()}>
          Start over with an empty query
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Fields

function FieldList(props: {
  readonly view: DocumentsView;
  readonly onAdded: (tab: BuilderTab) => void;
}) {
  const { view } = props;
  const builder = view.builder;
  const list = useDslBuilder(builder, (s) => s.fieldList);
  const search = useDslBuilder(builder, (s) => s.search);
  const blocked = useDslBuilder(builder, (s) => s.blocked !== undefined);
  const needle = search.trim().toLowerCase();
  const shown =
    needle === '' ? list.fields : list.fields.filter((f) => f.path.toLowerCase().includes(needle));
  const custom =
    needle !== '' &&
    /^[^\s.]+(\.[^\s.]+)*$/.test(search.trim()) &&
    !list.fields.some((f) => f.path === search.trim())
      ? search.trim()
      : undefined;
  return (
    <section
      aria-label="Fields"
      className="flex w-60 shrink-0 flex-col overflow-hidden rounded-md border border-border bg-panel-2"
      data-testid="search-builder-fields"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted"
          aria-live="polite"
        >
          {list.status === 'loading'
            ? 'Reading the mapping…'
            : `${formatCount(Math.max(0, list.fields.length - 1))} mapped fields`}
        </span>
        <button
          type="button"
          aria-label="Read the mapping again"
          title="Read the mapping again"
          disabled={list.status === 'loading'}
          onClick={() => void view.reloadFields()}
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
        className="h-7 border-b border-border bg-transparent px-2 font-mono text-xs text-fg placeholder:font-sans placeholder:text-muted/60 focus:outline-none"
        data-testid="search-builder-field-search"
      />
      {list.status === 'error' && (
        <p role="alert" className="px-2 py-1 text-[11px] text-danger">
          Could not read the mapping: {list.error}
        </p>
      )}
      <ul aria-label="Mapped fields" className="min-h-0 flex-1 overflow-auto py-0.5">
        {shown.map((field) => (
          <FieldItem
            key={field.path}
            builder={builder}
            path={field.path}
            field={field}
            flat={needle !== ''}
            disabled={blocked}
            onAdded={props.onAdded}
          />
        ))}
        {custom !== undefined && (
          <FieldItem
            builder={builder}
            path={custom}
            field={undefined}
            flat
            disabled={blocked}
            onAdded={props.onAdded}
          />
        )}
      </ul>
      <p className="border-t border-border px-2 py-1 text-[10px] leading-snug text-muted">
        Drag a field into a section, the sort or the aggregations, or use its + menu.
      </p>
    </section>
  );
}

function FieldItem(props: {
  readonly builder: DslBuilder;
  readonly path: string;
  readonly field: DslField | undefined;
  readonly flat: boolean;
  readonly disabled: boolean;
  readonly onAdded: (tab: BuilderTab) => void;
}) {
  const { builder, path, field } = props;
  const focusNext = useRef<string | undefined>(undefined);
  const container = field?.kind === 'nested' || field?.kind === 'object';
  const aggregations = aggregationsFor(field).slice(0, 3);
  const sortable = field === undefined || !['object', 'nested', 'geo'].includes(field.kind);
  const add = (occur: Occur): void => {
    focusNext.current =
      field?.kind === 'nested'
        ? builder.addGroup(builder.rootTarget(occur), path)
        : builder.addCondition(path, builder.rootTarget(occur));
    props.onAdded('query');
  };
  return (
    <li
      draggable={!props.disabled}
      onDragStart={(event) => {
        event.dataTransfer.setData(FIELD_DRAG, path);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      data-testid="search-builder-field"
      data-path={path}
      title={
        field
          ? `${field.path} · ${field.type}${field.multiField ? ' (multi-field)' : ''}`
          : 'Not in the mapping'
      }
      className={cx(
        'group flex h-6 items-center gap-1.5 pr-1 text-xs hover:bg-hover',
        !props.disabled && 'cursor-grab active:cursor-grabbing',
      )}
      style={{ paddingLeft: 8 + (props.flat ? 0 : (field?.depth ?? 0)) * 12 }}
    >
      <span
        className={cx(
          'min-w-0 flex-1 truncate font-mono',
          container && 'text-muted',
          field?.multiField && 'italic',
        )}
      >
        {props.flat ? path : (field?.name ?? path)}
      </span>
      <span
        className={cx(
          'shrink-0 font-mono text-[10px]',
          field ? KIND_TONES[field.kind] : 'text-muted',
        )}
      >
        {field ? field.type : 'new path'}
      </span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Add ${path} to…`}
            title="Add to the query, the sort or the aggregations"
            disabled={props.disabled}
            className="rounded p-0.5 text-muted opacity-60 group-hover:opacity-100 hover:bg-panel hover:text-fg disabled:opacity-30"
          >
            <Icon name="plus" className="h-3 w-3" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="z-50 min-w-52 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
            onCloseAutoFocus={(event) => {
              const id = focusNext.current;
              focusNext.current = undefined;
              if (id === undefined) return;
              event.preventDefault();
              focusItem(id);
            }}
          >
            <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
              {field?.kind === 'nested' ? 'Nested group in' : 'Condition in'}
            </DropdownMenu.Label>
            {OCCURS.map((occur) => (
              <MenuItem key={occur} onSelect={() => add(occur)}>
                <span className="flex items-center gap-2">
                  <span className={cx('h-2 w-2 rounded-full', OCCUR_META[occur].bar)} />
                  {OCCUR_META[occur].label}
                </span>
              </MenuItem>
            ))}
            {(sortable || aggregations.length > 0) && (
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            )}
            {sortable && (
              <MenuItem
                onSelect={() => {
                  builder.addSort(path);
                  props.onAdded('sort');
                }}
              >
                Sort by {sortPath(field, path)}
              </MenuItem>
            )}
            {aggregations.map((type) => (
              <MenuItem
                key={type}
                onSelect={() => {
                  builder.addAggregation(type, path);
                  props.onAdded('aggs');
                }}
              >
                Aggregate: {DSL_AGGREGATION_LABELS[type]}
              </MenuItem>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Query

function QueryTab({ view }: { readonly view: DocumentsView }) {
  const root = useDslBuilder(view.builder, (s) => s.model.query);
  return (
    <div className="flex flex-col gap-1.5" data-testid="search-builder-query">
      <Sections view={view} group={root} depth={0} />
    </div>
  );
}

function Sections(props: {
  readonly view: DocumentsView;
  readonly group: DslGroup;
  readonly depth: number;
}) {
  return (
    <>
      {OCCURS.map((occur) => (
        <Section key={occur} {...props} occur={occur} />
      ))}
    </>
  );
}

function Section(props: {
  readonly view: DocumentsView;
  readonly group: DslGroup;
  readonly occur: Occur;
  readonly depth: number;
}) {
  const { view, group, occur, depth } = props;
  const builder = view.builder;
  const items = group.clauses[occur];
  const target: ClauseTarget = { group: group.id, occur };
  const meta = OCCUR_META[occur];
  const msmIssue = useDslBuilder(builder, (s) =>
    occur === 'should' && isMsmIssue(s.issues[group.id]) ? s.issues[group.id] : undefined,
  );
  const drop = useDrop({
    field: (path) => {
      const field = builder.field(path);
      focusItem(
        field?.kind === 'nested'
          ? builder.addGroup(target, path)
          : builder.addCondition(path, target),
      );
    },
    clause: (id) => builder.moveClause(id, target),
  });
  const empty = items.length === 0;
  return (
    <section
      aria-label={depth === 0 ? meta.label : `${meta.label} (in the group)`}
      data-testid="search-builder-section"
      data-occur={occur}
      {...drop.props}
      className={cx(
        'relative flex flex-col gap-1 rounded-md border py-1 pr-1.5 pl-3 transition-colors',
        empty ? 'border-dashed border-border/80' : 'border-border bg-panel/60',
        drop.over && 'border-accent bg-accent/10',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'absolute top-1 bottom-1 left-1 w-[3px] rounded-full',
          meta.bar,
          empty && 'opacity-40',
        )}
      />
      <div className="flex min-h-5 items-center gap-2">
        <span className={cx('text-[11px] font-semibold tracking-wide uppercase', meta.tone)}>
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {empty ? 'drop fields or clauses here' : occurHint(group, occur)}
        </span>
        {occur === 'should' && !empty && (
          <label
            className="flex items-center gap-1 text-[11px] text-muted"
            title="minimum_should_match: how many of these must match (a number, or a percentage such as 75%)"
          >
            at least
            <input
              value={group.minimumShouldMatch}
              onChange={(event) =>
                builder.updateGroup(group.id, { minimumShouldMatch: event.target.value })
              }
              placeholder={group.clauses.must.length + group.clauses.filter.length > 0 ? '0' : '1'}
              aria-label="Minimum should match"
              aria-invalid={msmIssue !== undefined}
              className={cx(CONTROL, 'w-12 text-center')}
              data-testid="search-builder-msm"
            />
          </label>
        )}
        <AddMenu view={view} target={target} label={meta.label} />
      </div>
      {!empty && (
        <ul className="flex flex-col gap-1" aria-label={`${meta.label} clauses`}>
          {items.map((item) => (
            <Clause key={item.id} view={view} item={item} target={target} depth={depth} />
          ))}
        </ul>
      )}
      {msmIssue !== undefined && (
        <p role="alert" className="text-[11px] text-danger">
          {msmIssue}
        </p>
      )}
    </section>
  );
}

function AddMenu(props: {
  readonly view: DocumentsView;
  readonly target: ClauseTarget;
  readonly label: string;
}) {
  const builder = props.view.builder;
  const fields = useDslBuilder(builder, (s) => s.fieldList.fields);
  const nested = fields.filter((f) => f.kind === 'nested');
  const focusNext = useRef<string | undefined>(undefined);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Add to ${props.label}`}
          title={`Add to ${props.label}`}
          className="flex h-5 items-center gap-0.5 rounded px-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="plus" className="h-3 w-3" />
          Add
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-50 min-w-56 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
          onCloseAutoFocus={(event) => {
            const id = focusNext.current;
            focusNext.current = undefined;
            if (id === undefined) return;
            event.preventDefault();
            focusItem(id);
          }}
        >
          <MenuItem onSelect={() => (focusNext.current = builder.addCondition('', props.target))}>
            Lucene query over every field
          </MenuItem>
          <MenuItem onSelect={() => (focusNext.current = builder.addGroup(props.target))}>
            Group (a bool query of its own)
          </MenuItem>
          {nested.map((field) => (
            <MenuItem
              key={field.path}
              onSelect={() => (focusNext.current = builder.addGroup(props.target, field.path))}
            >
              Nested group on <span className="font-mono">{field.path}</span>
            </MenuItem>
          ))}
          <MenuItem onSelect={() => (focusNext.current = builder.addRaw(props.target))}>
            Clause written as JSON
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Clause(props: {
  readonly view: DocumentsView;
  readonly item: DslItem;
  readonly target: ClauseTarget;
  readonly depth: number;
}) {
  const { view, item, target } = props;
  const builder = view.builder;
  const issue = useDslBuilder(builder, (s) =>
    item.kind === 'group' ? undefined : s.issues[item.id],
  );
  const warning = useDslBuilder(builder, (s) => s.warnings[item.id]);
  const [dragging, setDragging] = useState(false);
  const drop = useDrop({
    clause: (id) => builder.moveClause(id, target, item.id),
    field: (path) => focusItem(builder.addCondition(path, target)),
  });
  return (
    <li
      {...drop.props}
      className={cx(
        'flex items-start gap-1 rounded',
        drop.over && 'shadow-[0_-2px_0_0_var(--color-accent)]',
        dragging && 'opacity-40',
      )}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(CLAUSE_DRAG, item.id);
          event.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        aria-label="Drag to move the clause"
        title="Drag to another section, or before another clause"
        className="mt-0.5 cursor-grab rounded px-0.5 font-mono text-xs text-muted/70 hover:bg-hover hover:text-fg active:cursor-grabbing"
      >
        ⠿
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {item.kind === 'condition' ? (
          <ConditionRow view={view} condition={item} invalid={issue !== undefined} />
        ) : item.kind === 'group' ? (
          <GroupBox view={view} group={item} depth={props.depth + 1} />
        ) : (
          <RawClause builder={builder} raw={item} invalid={issue !== undefined} />
        )}
        {issue !== undefined && (
          <p role="alert" className="text-[11px] text-danger" data-testid="search-builder-issue">
            {issue}
          </p>
        )}
        {warning !== undefined && (
          <p
            className="flex items-center gap-1 text-[11px] text-warning"
            data-testid="search-builder-warning"
          >
            <Icon name="warning" className="h-3 w-3" />
            {warning}
          </p>
        )}
      </div>
      <ClauseMenu builder={builder} item={item} target={target} />
    </li>
  );
}

function ClauseMenu(props: {
  readonly builder: DslBuilder;
  readonly item: DslItem;
  readonly target: ClauseTarget;
}) {
  const { builder, item, target } = props;
  const what =
    item.kind === 'condition'
      ? item.field || 'Lucene query'
      : item.kind === 'group'
        ? 'group'
        : 'JSON clause';
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Actions for the ${what} clause`}
          title="Move or remove"
          className="mt-0.5 shrink-0 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="more" className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-50 min-w-44 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
            Move to
          </DropdownMenu.Label>
          {OCCURS.filter((occur) => occur !== target.occur).map((occur) => (
            <MenuItem
              key={occur}
              onSelect={() => builder.moveClause(item.id, { group: target.group, occur })}
            >
              <span className="flex items-center gap-2">
                <span className={cx('h-2 w-2 rounded-full', OCCUR_META[occur].bar)} />
                {OCCUR_META[occur].label}
              </span>
            </MenuItem>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <MenuItem danger onSelect={() => builder.removeClause(item.id)}>
            Remove
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const TEXT_PLACEHOLDERS: Partial<Record<DslOperator, string>> = {
  match: 'words to find',
  match_and: 'every one of these words',
  match_phrase: 'an exact phrase',
  match_phrase_prefix: 'a phrase, then the start of a word',
  query_string: 'status:paid AND total:>100',
  prefix: 'the start of the value',
  wildcard: 'pa*d?',
  regexp: 'pa[a-z]+',
  fuzzy: 'a value, give or take a typo',
};

function valuePlaceholder(kind: DslFieldKind | undefined, upper = false): string {
  switch (kind) {
    case 'number':
      return upper ? '100' : '0';
    case 'date':
      return upper ? 'now/d' : 'now-7d/d';
    case 'ip':
      return '10.0.0.1';
    case 'boolean':
      return 'true';
    default:
      return upper ? 'z' : 'exact value';
  }
}

function ConditionRow(props: {
  readonly view: DocumentsView;
  readonly condition: DslCondition;
  readonly invalid: boolean;
}) {
  const { view, condition: c, invalid } = props;
  const builder = view.builder;
  const field = useDslBuilder(builder, (s) => s.fieldList.fields.find((f) => f.path === c.field));
  const operators = operatorsFor(c.field, field);
  if (!operators.includes(c.operator)) operators.push(c.operator);
  const set = (patch: Partial<Omit<DslCondition, 'kind' | 'id'>>): void =>
    builder.updateCondition(c.id, patch);
  const focus = { 'data-focus-id': c.id };
  const input = valueInput(c.operator);
  const label = c.field === '' ? 'every field' : c.field;
  return (
    <div
      role="group"
      aria-label={`Condition on ${label}`}
      data-testid="search-builder-condition"
      data-field={c.field}
      data-operator={c.operator}
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      <span
        className={cx(
          'max-w-[16rem] truncate rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs',
          c.field === '' && 'text-muted italic',
        )}
        title={
          field
            ? `${field.path} · ${field.type}`
            : c.field === ''
              ? 'A Lucene query over every field'
              : 'Not in the mapping'
        }
      >
        {label}
      </span>
      {operators.length > 1 ? (
        <SmallSelect
          aria-label={`${label} operator`}
          value={c.operator}
          title={DSL_OPERATOR_QUERIES[c.operator]}
          onChange={(event) => set({ operator: event.target.value as DslOperator })}
          className="h-6"
          data-testid="search-builder-operator"
          {...(input === 'none' ? focus : {})}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {DSL_OPERATOR_LABELS[op]}
            </option>
          ))}
        </SmallSelect>
      ) : (
        <span className="px-1 text-xs text-muted" title={DSL_OPERATOR_QUERIES[c.operator]}>
          {DSL_OPERATOR_LABELS[c.operator]}
        </span>
      )}
      {input === 'none' && <span className="text-[11px] text-muted">has a value</span>}
      {input === 'text' && (
        <input
          aria-label={`${label} text`}
          aria-invalid={invalid}
          value={c.value}
          placeholder={TEXT_PLACEHOLDERS[c.operator]}
          spellCheck={false}
          onChange={(event) => set({ value: event.target.value })}
          className={cx(CONTROL, 'max-w-[32rem] min-w-40 flex-1')}
          data-testid="search-builder-value"
          {...focus}
        />
      )}
      {input === 'value' &&
        (field?.kind === 'boolean' ? (
          <SmallSelect
            aria-label={`${label} value`}
            value={c.value === 'false' ? 'false' : 'true'}
            onChange={(event) => set({ value: event.target.value })}
            className="h-6"
            data-testid="search-builder-value"
            {...focus}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </SmallSelect>
        ) : (
          <input
            aria-label={`${label} value`}
            aria-invalid={invalid}
            value={c.value}
            placeholder={valuePlaceholder(field?.kind)}
            spellCheck={false}
            title='Typed by the mapping; "quotes" make a string'
            onChange={(event) => set({ value: event.target.value })}
            className={cx(CONTROL, 'max-w-[24rem] min-w-32 flex-1')}
            data-testid="search-builder-value"
            {...focus}
          />
        ))}
      {input === 'value' && field?.kind !== 'boolean' && (
        <TopValues
          builder={builder}
          path={c.field}
          field={field}
          label={label}
          onPick={(text) => set({ value: text })}
        />
      )}
      {input === 'list' && (
        <input
          aria-label={`${label} values`}
          aria-invalid={invalid}
          value={c.value}
          placeholder='a, b, "c, with a comma"'
          spellCheck={false}
          title="Separated by commas; quote a value that has one"
          onChange={(event) => set({ value: event.target.value })}
          className={cx(CONTROL, 'max-w-[32rem] min-w-40 flex-1')}
          data-testid="search-builder-value"
          {...focus}
        />
      )}
      {input === 'list' && (
        <TopValues
          builder={builder}
          path={c.field}
          field={field}
          label={label}
          picked={splitList(c.value)}
          onPick={(text) => {
            const values = splitList(c.value);
            if (!values.includes(text)) set({ value: [...values, text].join(', ') });
          }}
        />
      )}
      {input === 'range' && (
        <span className="flex flex-wrap items-center gap-1">
          <BoundSelect
            label={`${label} lower bound`}
            inclusive={c.lowerInclusive}
            options={['≥', '>']}
            onChange={(inclusive) => set({ lowerInclusive: inclusive })}
          />
          <input
            aria-label={`${label} from`}
            aria-invalid={invalid}
            value={c.lower}
            placeholder={valuePlaceholder(field?.kind)}
            spellCheck={false}
            onChange={(event) => set({ lower: event.target.value })}
            className={cx(CONTROL, 'w-28')}
            data-testid="search-builder-lower"
            {...focus}
          />
          <span className="text-[11px] text-muted">and</span>
          <BoundSelect
            label={`${label} upper bound`}
            inclusive={c.upperInclusive}
            options={['≤', '<']}
            onChange={(inclusive) => set({ upperInclusive: inclusive })}
          />
          <input
            aria-label={`${label} to`}
            aria-invalid={invalid}
            value={c.upper}
            placeholder={valuePlaceholder(field?.kind, true)}
            spellCheck={false}
            onChange={(event) => set({ upper: event.target.value })}
            className={cx(CONTROL, 'w-28')}
            data-testid="search-builder-upper"
          />
          {(field?.kind === 'date' || c.format !== '' || c.timeZone !== '') && (
            <DateOptions condition={c} label={label} onChange={set} />
          )}
        </span>
      )}
      {input === 'geo' && (
        <span className="flex items-center gap-1">
          <input
            aria-label={`${label} distance`}
            aria-invalid={invalid}
            value={c.distance}
            placeholder="10km"
            spellCheck={false}
            onChange={(event) => set({ distance: event.target.value })}
            className={cx(CONTROL, 'w-16')}
          />
          <span className="text-[11px] text-muted">of</span>
          <input
            aria-label={`${label} point`}
            aria-invalid={invalid}
            value={c.value}
            placeholder="lat,lon"
            spellCheck={false}
            onChange={(event) => set({ value: event.target.value })}
            className={cx(CONTROL, 'w-36')}
            data-testid="search-builder-value"
            {...focus}
          />
        </span>
      )}
    </div>
  );
}

/** A date range's format and time zone: behind a toggle until one is set. */
function DateOptions(props: {
  readonly condition: DslCondition;
  readonly label: string;
  readonly onChange: (patch: { readonly format?: string; readonly timeZone?: string }) => void;
}) {
  const { condition: c, label } = props;
  const [open, setOpen] = useState(c.format !== '' || c.timeZone !== '');
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="The date format and time zone of the bounds (format, time_zone)"
        className="rounded px-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
        data-testid="search-builder-date-options"
      >
        Format, zone…
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 border-l border-border pl-1.5">
      <input
        aria-label={`${label} date format`}
        value={c.format}
        placeholder="format"
        spellCheck={false}
        title="How the bounds are written, such as yyyy-MM-dd; empty for the field's format"
        onChange={(event) => props.onChange({ format: event.target.value })}
        className={cx(CONTROL, 'w-32')}
        data-testid="search-builder-format"
      />
      <input
        aria-label={`${label} time zone`}
        value={c.timeZone}
        placeholder="UTC"
        spellCheck={false}
        title="The time zone of the bounds, such as +01:00 or Europe/Berlin; empty for UTC"
        onChange={(event) => props.onChange({ timeZone: event.target.value })}
        className={cx(CONTROL, 'w-28')}
        data-testid="search-builder-time-zone"
      />
    </span>
  );
}

/**
 * A field's most common values (a terms aggregation, read when the menu first opens), to pick
 * one as the value or add it to the list.
 */
function TopValues(props: {
  readonly builder: DslBuilder;
  readonly path: string;
  readonly field: DslField | undefined;
  readonly label: string;
  readonly picked?: readonly string[];
  readonly onPick: (text: string) => void;
}) {
  const { builder, path, field } = props;
  const state = useDslBuilder(builder, (s) => s.topValues[path]);
  const aggregatable =
    field !== undefined &&
    (['keyword', 'number', 'ip', 'date'].includes(field.kind) ||
      (field.kind === 'text' && field.keyword !== undefined));
  if (!aggregatable) return null;
  const max = Math.max(1, ...(state?.values ?? []).map((v) => v.count));
  return (
    <DropdownMenu.Root onOpenChange={(open) => open && void builder.loadTopValues(path)}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Top values of ${props.label}`}
          title="The most common values in this index"
          className="flex h-6 items-center gap-0.5 rounded border border-border bg-panel-2 px-1.5 text-[11px] text-muted hover:border-accent hover:text-fg"
          data-testid="search-builder-top-values"
        >
          Top
          <Icon name="chevron-down" className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="z-50 max-h-80 w-72 overflow-auto rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          <DropdownMenu.Label className="flex items-center justify-between gap-2 px-2 pt-1 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
            <span className="truncate">Top values of {sortPath(field, path)}</span>
            <span>Docs</span>
          </DropdownMenu.Label>
          {(state === undefined || state.status === 'loading') && (
            <p className="px-2 py-1.5 text-xs text-muted">Reading the top values…</p>
          )}
          {state?.status === 'error' && (
            <p role="alert" className="px-2 py-1.5 text-xs text-danger">
              {state.error}
            </p>
          )}
          {state?.status === 'done' && state.values.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted">No document has a value here.</p>
          )}
          {state?.values.map((value) => {
            const picked = props.picked?.includes(value.text) ?? false;
            return (
              <DropdownMenu.Item
                key={value.text}
                onSelect={() => props.onPick(value.text)}
                disabled={picked}
                data-testid="search-builder-top-value"
                className="relative flex cursor-default items-center gap-2 overflow-hidden rounded px-2 py-1 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-list-active"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0.5 left-0 rounded-r bg-accent/10"
                  style={{ width: `${Math.max(4, (value.count / max) * 100)}%` }}
                />
                <span className="relative min-w-0 flex-1 truncate font-mono text-xs">
                  {value.text}
                </span>
                <span className="relative text-[11px] text-muted tabular-nums">
                  {picked ? <Icon name="check" className="h-3 w-3" /> : formatCount(value.count)}
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BoundSelect(props: {
  readonly label: string;
  readonly inclusive: boolean;
  readonly options: readonly [string, string];
  readonly onChange: (inclusive: boolean) => void;
}) {
  return (
    <SmallSelect
      aria-label={props.label}
      value={props.inclusive ? 'in' : 'ex'}
      onChange={(event) => props.onChange(event.target.value === 'in')}
      className="h-6 w-11 px-1 font-mono"
    >
      <option value="in">{props.options[0]}</option>
      <option value="ex">{props.options[1]}</option>
    </SmallSelect>
  );
}

function RawClause(props: {
  readonly builder: DslBuilder;
  readonly raw: DslRaw;
  readonly invalid: boolean;
  readonly onChange?: (text: string) => void;
  readonly label?: string;
}) {
  const { raw } = props;
  return (
    <div className="flex min-w-0 items-start gap-1.5" data-testid="search-builder-json">
      <span
        className="mt-0.5 rounded border border-border px-1 font-mono text-[10px] text-muted"
        title="Kept as written: the builder does not break this down"
      >
        JSON
      </span>
      <AutoTextarea
        value={raw.text}
        label={props.label ?? 'Clause as JSON'}
        invalid={props.invalid}
        focusId={raw.id}
        onChange={(text) =>
          props.onChange ? props.onChange(text) : props.builder.setRaw(raw.id, text)
        }
      />
    </div>
  );
}

/** A monospace textarea as tall as its text (up to eight lines). */
function AutoTextarea(props: {
  readonly value: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly focusId?: string;
  readonly onChange: (text: string) => void;
}) {
  const lines = Math.min(
    8,
    Math.max(1, Math.ceil(props.value.length / 90), props.value.split('\n').length),
  );
  return (
    <textarea
      aria-label={props.label}
      aria-invalid={props.invalid}
      value={props.value}
      rows={lines}
      spellCheck={false}
      onChange={(event) => props.onChange(event.target.value)}
      className={cx(CONTROL, 'h-auto min-w-0 flex-1 resize-y py-0.5 leading-snug')}
      {...(props.focusId !== undefined ? { 'data-focus-id': props.focusId } : {})}
    />
  );
}

function GroupBox(props: {
  readonly view: DocumentsView;
  readonly group: DslGroup;
  readonly depth: number;
}) {
  const { view, group } = props;
  const issue = useDslBuilder(view.builder, (s) =>
    isMsmIssue(s.issues[group.id]) ? undefined : s.issues[group.id],
  );
  const nested = group.path !== '';
  return (
    <div
      role="group"
      aria-label={nested ? `Nested group on ${group.path}` : 'Group'}
      data-testid="search-builder-group"
      data-path={group.path}
      data-focus-id={group.id}
      tabIndex={-1}
      className={cx(
        'flex flex-col gap-1 rounded-md border p-1.5',
        nested ? 'border-accent/40 bg-accent/5' : 'border-border bg-panel-2/50',
      )}
    >
      <div className="flex items-center gap-2 text-[11px]">
        {nested ? (
          <>
            <span className="font-semibold text-accent">Nested</span>
            <span className="rounded bg-panel-2 px-1.5 font-mono text-xs">{group.path}</span>
            <span className="truncate text-muted">
              one {group.path} entry must match all of this
            </span>
          </>
        ) : (
          <>
            <span className="font-semibold text-fg">Group</span>
            <span className="truncate text-muted">a bool query of its own</span>
          </>
        )}
      </div>
      {issue !== undefined && (
        <p role="alert" className="text-[11px] text-danger">
          {issue}
        </p>
      )}
      <Sections view={view} group={group} depth={props.depth} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sort

function SortTab({ view }: { readonly view: DocumentsView }) {
  const builder = view.builder;
  const sort = useDslBuilder(builder, (s) => s.model.sort);
  const fields = useDslBuilder(builder, (s) => s.fieldList.fields);
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const drop = useDrop({ field: (path) => builder.addSort(path) });
  const choices = fields.filter(
    (f) =>
      !['object', 'nested', 'geo'].includes(f.kind) &&
      !(f.kind === 'text' && f.keyword !== undefined),
  );
  return (
    <section
      aria-label="Sort"
      data-testid="search-builder-sort"
      {...drop.props}
      className={cx(
        'flex min-h-full flex-col gap-1.5 rounded-md border border-dashed p-2',
        drop.over ? 'border-accent bg-accent/10' : 'border-transparent',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-fg uppercase">Sort</span>
        <span className="flex-1 text-[11px] text-muted">
          {sort.length === 0
            ? 'Index order. Drag fields here, or add a key.'
            : 'By the first key, then the next'}
        </span>
        <SmallSelect
          aria-label="Add a sort key"
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (value === '{json}') builder.addRawSort();
            else if (value !== '') builder.addSort(value);
          }}
          className="h-6 max-w-56"
          data-testid="search-builder-add-sort"
        >
          <option value="">Add a sort key…</option>
          <option value="_score">_score (relevance)</option>
          {choices.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
          <option value="{json}">Written as JSON…</option>
        </SmallSelect>
      </div>
      {sort.length > 0 && (
        <ol className="flex flex-col gap-1" aria-label="Sort keys">
          {sort.map((item, index) => (
            <SortRow
              key={item.id}
              builder={builder}
              item={item}
              index={index}
              count={sort.length}
              dragging={dragging}
              setDragging={setDragging}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function SortRow(props: {
  readonly builder: DslBuilder;
  readonly item: DslSortItem;
  readonly index: number;
  readonly count: number;
  readonly dragging: number | undefined;
  readonly setDragging: (index: number | undefined) => void;
}) {
  const { builder, item, index } = props;
  const issue = useDslBuilder(builder, (s) => s.issues[item.id]);
  const drop = useDrop({
    sort: (from) => {
      props.setDragging(undefined);
      if (Number.isInteger(from) && from !== index) builder.moveSort(from, index);
    },
  });
  const name = item.kind === 'field' ? item.field : 'JSON sort key';
  return (
    <li
      {...drop.props}
      data-testid="search-builder-sort-entry"
      data-field={item.kind === 'field' ? item.field : ''}
      className={cx(
        'flex flex-col gap-0.5 rounded-md border border-border bg-panel/60 px-1.5 py-1',
        drop.over && props.dragging !== index && 'ring-1 ring-accent',
        props.dragging === index && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(SORT_DRAG, String(index));
            event.dataTransfer.effectAllowed = 'move';
            props.setDragging(index);
          }}
          onDragEnd={() => props.setDragging(undefined)}
          onKeyDown={(event) => {
            if (!event.altKey) return;
            if (event.key === 'ArrowUp') builder.moveSort(index, index - 1);
            else if (event.key === 'ArrowDown') builder.moveSort(index, index + 1);
            else return;
            event.preventDefault();
          }}
          aria-label={`Reorder sort key ${name} (drag, or Alt+Up / Alt+Down)`}
          title="Drag to reorder, or Alt+Up / Alt+Down"
          className="cursor-grab rounded px-0.5 font-mono text-xs text-muted hover:bg-hover active:cursor-grabbing"
        >
          ⠿
        </button>
        <span className="w-4 text-center text-[10px] text-muted tabular-nums">{index + 1}</span>
        {item.kind === 'field' ? (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.field}</span>
            <Segmented
              label={`${item.field} sort order`}
              value={item.order}
              options={[
                { value: 'asc', label: 'Ascending' },
                { value: 'desc', label: 'Descending' },
              ]}
              onChange={(order) => builder.updateSort(item.id, { order })}
            />
            <SmallSelect
              aria-label={`${item.field} missing values`}
              value={item.missing}
              onChange={(event) =>
                builder.updateSort(item.id, {
                  missing: event.target.value as '' | '_first' | '_last',
                })
              }
              className="h-6"
            >
              <option value="">Missing: default</option>
              <option value="_first">Missing first</option>
              <option value="_last">Missing last</option>
            </SmallSelect>
          </>
        ) : (
          <AutoTextarea
            value={item.text}
            label="Sort key as JSON"
            invalid={issue !== undefined}
            onChange={(text) => builder.setRawSort(item.id, text)}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1"
          aria-label={`Move ${name} up`}
          disabled={index === 0}
          onClick={() => builder.moveSort(index, index - 1)}
        >
          ↑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1"
          aria-label={`Move ${name} down`}
          disabled={index === props.count - 1}
          onClick={() => builder.moveSort(index, index + 1)}
        >
          ↓
        </Button>
        <RemoveButton
          label={`Remove ${name} from the sort`}
          onClick={() => builder.removeSort(item.id)}
        />
      </div>
      {issue !== undefined && (
        <p role="alert" className="pl-8 text-[11px] text-danger">
          {issue}
        </p>
      )}
    </li>
  );
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

// ---------------------------------------------------------------------------------------------
// Aggregations

function AggregationsTab({ view }: { readonly view: DocumentsView }) {
  const builder = view.builder;
  const aggs = useDslBuilder(builder, (s) => s.model.aggs);
  const drop = useDrop({
    field: (path) => {
      const [type] = aggregationsFor(builder.field(path));
      if (type) builder.addAggregation(type, path);
    },
  });
  return (
    <section
      aria-label="Aggregations"
      data-testid="search-builder-aggs"
      {...drop.props}
      className={cx(
        'flex min-h-full flex-col gap-1.5 rounded-md border border-dashed p-2',
        drop.over ? 'border-accent bg-accent/10' : 'border-transparent',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-fg uppercase">
          Aggregations
        </span>
        <span className="flex-1 text-[11px] text-muted">
          {aggs.length === 0
            ? 'None. Drag fields here: keywords group into terms, numbers into stats, dates into a histogram.'
            : 'Their results show beside the documents after a search'}
        </span>
        <AddAggregation builder={builder} />
      </div>
      {aggs.length > 0 && <AggregationList view={view} aggs={aggs} depth={0} />}
    </section>
  );
}

function AddAggregation(props: { readonly builder: DslBuilder; readonly parent?: string }) {
  return (
    <SmallSelect
      aria-label={props.parent ? 'Add a sub-aggregation' : 'Add an aggregation'}
      value=""
      onChange={(event) => {
        const type = event.target.value as DslAggregationType | 'dsl' | '';
        if (type !== '') props.builder.addAggregation(type, '', props.parent);
      }}
      className={cx('h-6', props.parent && 'h-5 border-dashed text-[11px]')}
      data-testid={props.parent ? 'search-builder-add-sub-agg' : 'search-builder-add-agg'}
    >
      <option value="">{props.parent ? '+ Sub-aggregation…' : 'Add an aggregation…'}</option>
      <optgroup label="Buckets">
        {DSL_AGGREGATIONS.filter((t) => BUCKET_AGGREGATIONS.has(t)).map((t) => (
          <option key={t} value={t}>
            {DSL_AGGREGATION_LABELS[t]}
          </option>
        ))}
      </optgroup>
      <optgroup label="Metrics">
        {DSL_AGGREGATIONS.filter((t) => !BUCKET_AGGREGATIONS.has(t)).map((t) => (
          <option key={t} value={t}>
            {DSL_AGGREGATION_LABELS[t]}
          </option>
        ))}
      </optgroup>
      <option value="dsl">Written as JSON…</option>
    </SmallSelect>
  );
}

function AggregationList(props: {
  readonly view: DocumentsView;
  readonly aggs: readonly DslAggregation[];
  readonly depth: number;
}) {
  return (
    <ul
      className="flex flex-col gap-1"
      aria-label={props.depth === 0 ? 'Aggregations' : 'Sub-aggregations'}
    >
      {props.aggs.map((agg) => (
        <AggregationCard key={agg.id} view={props.view} agg={agg} depth={props.depth} />
      ))}
    </ul>
  );
}

function AggregationCard(props: {
  readonly view: DocumentsView;
  readonly agg: DslAggregation;
  readonly depth: number;
}) {
  const { view, agg } = props;
  const builder = view.builder;
  const issue = useDslBuilder(builder, (s) => s.issues[agg.id]);
  const fields = useDslBuilder(builder, (s) => s.fieldList.fields);
  const field = fields.find((f) => f.path === agg.field);
  const bucket = BUCKET_AGGREGATIONS.has(agg.type);
  const set = (patch: Partial<Omit<DslAggregation, 'id' | 'aggs'>>): void =>
    builder.updateAggregation(agg.id, patch);
  const fieldChoices = fields.filter(
    (f) =>
      f.path !== '_id' &&
      (agg.type === 'dsl' || aggregationsFor(f).includes(agg.type as DslAggregationType)) &&
      !(f.kind === 'text' && f.keyword !== undefined),
  );
  const calendar = CALENDAR_INTERVALS.some((i) => i.value === agg.interval) && !agg.fixed;
  return (
    <li
      data-testid="search-builder-agg"
      data-name={agg.name}
      className={cx(
        'flex flex-col gap-1 rounded-md border px-2 py-1.5',
        bucket ? 'border-border bg-panel/60' : 'border-border/70 bg-panel-2/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cx(
            'h-2 w-2 shrink-0 rounded-sm',
            bucket ? 'bg-accent' : agg.type === 'dsl' ? 'bg-muted' : 'bg-success',
          )}
        />
        <input
          aria-label="Aggregation name"
          aria-invalid={issue !== undefined && /name|used twice/.test(issue)}
          value={agg.name}
          spellCheck={false}
          onChange={(event) => set({ name: event.target.value })}
          className={cx(CONTROL, 'w-40 font-semibold')}
          data-testid="search-builder-agg-name"
        />
        <SmallSelect
          aria-label={`${agg.name} type`}
          value={agg.type}
          onChange={(event) => set({ type: event.target.value as DslAggregationType | 'dsl' })}
          className="h-6"
        >
          {[...DSL_AGGREGATIONS, 'dsl' as const].map((t) => (
            <option key={t} value={t}>
              {DSL_AGGREGATION_LABELS[t]}
            </option>
          ))}
        </SmallSelect>
        {agg.type !== 'dsl' && (
          <>
            <span className="text-[11px] text-muted">of</span>
            <SmallSelect
              aria-label={`${agg.name} field`}
              value={agg.field}
              onChange={(event) => set({ field: event.target.value })}
              className={cx('h-6 max-w-52 font-mono', agg.field === '' && 'text-muted')}
              data-testid="search-builder-agg-field"
            >
              <option value="">Choose a field…</option>
              {agg.field !== '' && !fieldChoices.some((f) => f.path === agg.field) && (
                <option value={agg.field}>{agg.field}</option>
              )}
              {fieldChoices.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </SmallSelect>
          </>
        )}
        {agg.type === 'terms' && (
          <label className="flex items-center gap-1 text-[11px] text-muted">
            top
            <input
              aria-label={`${agg.name} size`}
              value={agg.size}
              placeholder="10"
              inputMode="numeric"
              onChange={(event) => set({ size: event.target.value })}
              className={cx(CONTROL, 'w-14 text-right')}
            />
          </label>
        )}
        {agg.type === 'date_histogram' && (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            every
            <SmallSelect
              aria-label={`${agg.name} interval`}
              value={calendar ? agg.interval : 'fixed'}
              onChange={(event) =>
                event.target.value === 'fixed'
                  ? set({ fixed: true, interval: calendar ? '' : agg.interval })
                  : set({ fixed: false, interval: event.target.value })
              }
              className="h-6"
            >
              {CALENDAR_INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
              <option value="fixed">Fixed…</option>
            </SmallSelect>
            {!calendar && (
              <input
                aria-label={`${agg.name} fixed interval`}
                value={agg.interval}
                placeholder="30m"
                onChange={(event) => set({ interval: event.target.value, fixed: true })}
                className={cx(CONTROL, 'w-16')}
                title="fixed_interval: 30s, 15m, 12h, 7d…"
              />
            )}
          </span>
        )}
        {agg.type === 'histogram' && (
          <label className="flex items-center gap-1 text-[11px] text-muted">
            every
            <input
              aria-label={`${agg.name} interval`}
              value={agg.interval}
              placeholder="10"
              inputMode="decimal"
              onChange={(event) => set({ interval: event.target.value })}
              className={cx(CONTROL, 'w-16 text-right')}
            />
          </label>
        )}
        <span className="flex-1" />
        {bucket && props.depth < 3 && <AddAggregation builder={builder} parent={agg.id} />}
        <RemoveButton
          label={`Remove the aggregation ${agg.name}`}
          onClick={() => builder.removeAggregation(agg.id)}
        />
      </div>
      {agg.type === 'dsl' && (
        <AutoTextarea
          value={agg.text}
          label={`${agg.name} as JSON`}
          invalid={issue !== undefined}
          onChange={(text) => set({ text })}
        />
      )}
      {field === undefined && agg.field !== '' && agg.type !== 'dsl' && fields.length > 1 && (
        <p className="text-[11px] text-muted">{agg.field} is not in the mapping.</p>
      )}
      {issue !== undefined && (
        <p role="alert" className="text-[11px] text-danger" data-testid="search-builder-issue">
          {issue}
        </p>
      )}
      {agg.aggs.length > 0 && (
        <div className="ml-1 border-l-2 border-border pl-2">
          <AggregationList view={view} aggs={agg.aggs} depth={props.depth + 1} />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Request

function RequestTab({ view }: { readonly view: DocumentsView }) {
  // Re-render on every change of the bar's texts.
  useSearchView(view, (s) => `${s.queryText}\u0000${s.sortText}\u0000${s.aggsText}`);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  let text: string;
  let problem: string | undefined;
  try {
    text = view.consoleText();
  } catch (error) {
    text = '';
    problem = (error as Error).message;
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5" data-testid="search-builder-request">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-muted">
          What Search sends first; paging adds the size, a tiebreaker sort and a point in time.
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={text === ''}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={text === ''}
          onClick={() =>
            openSearchConsole({
              profileId: view.profileId,
              title: `${view.target.target} console`,
              text: `${text}\n`,
            })
          }
        >
          Open in console
        </Button>
      </div>
      {problem !== undefined ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : (
        <pre
          className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-panel-2 p-2 font-mono text-xs leading-relaxed text-fg"
          data-testid="search-builder-request-text"
        >
          {text}
        </pre>
      )}
    </div>
  );
}
