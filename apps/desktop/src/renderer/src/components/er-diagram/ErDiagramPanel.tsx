import { DropdownMenu } from 'radix-ui';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { rasteriseSvg } from '../../lib/raster';
import { useConnections } from '../../state/connections';
import { cachedProfile } from '../../state/data';
import {
  keyLetters,
  matchingTables,
  tableLabel,
  type ColumnMode,
  type ErDiagram,
  type ErEnd,
  type ErRelation,
  type ErTable,
} from '../../state/er-diagram/model';
import { useErDiagrams } from '../../state/er-diagram/panels';
import { useErDiagram, type ErDiagramView } from '../../state/er-diagram/view';
import { openTableDesigner } from '../dock';
import { useTheme } from '../theme';
import { Button, EnvironmentBadge, Icon, cx } from '../ui';
import { ErCanvas } from './ErCanvas';
import {
  END_NAMES,
  EndGlyph,
  KEY_LETTER_CLASSES,
  KEY_LETTER_NAMES,
  KIND_LABELS,
  KeyLetters,
  KindGlyph,
  ErViewProvider,
  actionsOf,
  canDesign,
  cardinality,
  openData,
  openDesign,
  schemaColor,
} from './parts';

/**
 * An ER diagram panel (spec §8): the toolbar (schema, columns shown, types, views, layout,
 * export), the tables of the diagram on the left with a filter and their visibility, the canvas
 * in the middle with its legend, and the selected table's columns and relationships on the
 * right. Ctrl/Cmd+F filters; Escape clears the filter, then the selection.
 */
export function ErDiagramPanel(props: { readonly panelId: string }) {
  const view = useErDiagrams((state) => state.views[props.panelId]);
  if (!view) return null;
  return (
    <ErViewProvider value={view}>
      <Panel view={view} />
    </ErViewProvider>
  );
}

function Panel({ view }: { readonly view: ErDiagramView }) {
  const theme = useTheme();
  const status = useErDiagram(view, (s) => s.status);
  const diagram = useErDiagram(view, (s) => s.diagram);
  const selected = useErDiagram(view, (s) => s.selected);
  const search = useErDiagram(view, (s) => s.search);
  const searchBox = useRef<HTMLInputElement>(null);
  const [listOpen, setListOpen] = useState(true);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setListOpen(true);
      requestAnimationFrame(() => searchBox.current?.select());
    } else if (event.key === 'Escape') {
      if (search !== '') view.setSearch('');
      else if (selected !== undefined) view.select(undefined);
      else return;
      event.preventDefault();
    }
  };

  return (
    <div
      className="flex h-full flex-col bg-bg outline-none"
      data-testid="er-diagram"
      onKeyDown={onKeyDown}
    >
      <Toolbar view={view} listOpen={listOpen} onToggleList={() => setListOpen((v) => !v)} />
      <NoticeBar view={view} />
      <div className="flex min-h-0 flex-1">
        {listOpen && diagram && (
          <aside
            aria-label="Tables of the diagram"
            className="flex w-60 shrink-0 flex-col border-r border-border bg-panel"
          >
            <TableList view={view} diagram={diagram} searchBox={searchBox} />
          </aside>
        )}
        <main className="relative min-w-0 flex-1">
          {!diagram && status === 'loading' && <Loading view={view} />}
          {!diagram && status === 'error' && <LoadError view={view} />}
          {diagram && diagram.tables.length === 0 && <Empty view={view} diagram={diagram} />}
          {diagram && diagram.tables.length > 0 && (
            <>
              <ErCanvas view={view} theme={theme} />
              <Legend />
              <LayingOut view={view} />
            </>
          )}
        </main>
        {diagram && selected !== undefined && (
          <Inspector view={view} diagram={diagram} tableId={selected} />
        )}
      </div>
      <Footer view={view} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Toolbar

function Toolbar(props: {
  readonly view: ErDiagramView;
  readonly listOpen: boolean;
  readonly onToggleList: () => void;
}) {
  const { view } = props;
  const diagram = useErDiagram(view, (s) => s.diagram);
  const schemas = useErDiagram(view, (s) => s.schemas);
  const schema = useErDiagram(view, (s) => s.schema);
  const display = useErDiagram(view, (s) => s.display);
  const includeViews = useErDiagram(view, (s) => s.includeViews);
  const laying = useErDiagram(view, (s) => s.laying);
  const exporting = useErDiagram(view, (s) => s.exporting);
  const status = useErDiagram(view, (s) => s.status);
  const loading = status === 'loading';
  const ready = diagram !== undefined && diagram.tables.length > 0;
  return (
    <div
      role="toolbar"
      aria-label="ER diagram"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-2 py-1.5"
    >
      <ToggleChip
        pressed={props.listOpen}
        onChange={props.onToggleList}
        title="Show or hide the list of tables"
        disabled={!diagram}
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden
        >
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M6 2.5v11" />
        </svg>
        Tables
      </ToggleChip>
      {schemas.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Schema
          <select
            aria-label="Schema"
            value={schema ?? ''}
            disabled={loading}
            onChange={(event) => void view.setSchema(event.target.value || undefined)}
            className="h-7 max-w-44 rounded border border-border bg-panel-2 px-1.5 text-xs text-fg focus:border-accent focus:outline-none"
          >
            <option value="">All schemas</option>
            {schemas.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Divider />
      <span className="text-xs text-muted">Columns</span>
      <Segmented<ColumnMode>
        label="Columns shown"
        value={display.columns}
        disabled={!ready}
        onChange={(columns) => void view.setColumns(columns)}
        options={[
          { value: 'all', label: 'All', title: 'Every column' },
          { value: 'keys', label: 'Keys', title: 'Key and relationship columns only' },
          { value: 'none', label: 'None', title: 'Table names only' },
        ]}
      />
      <ToggleChip
        pressed={display.types}
        disabled={!ready || display.columns === 'none'}
        onChange={() => void view.setTypes(!display.types)}
        title="Show the column types"
      >
        Types
      </ToggleChip>
      <ToggleChip
        pressed={includeViews}
        disabled={!diagram || loading}
        onChange={() => void view.setIncludeViews(!includeViews)}
        title="Add the views (and materialized views) to the diagram"
      >
        Views
      </ToggleChip>
      <Divider />
      <Button
        size="sm"
        variant="ghost"
        disabled={!ready || laying}
        onClick={() => void view.layout()}
        title="Arrange the tables automatically, related tables side by side"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden
        >
          <rect x="1.5" y="2" width="5" height="4" rx="1" />
          <rect x="9.5" y="2" width="5" height="4" rx="1" />
          <rect x="9.5" y="10" width="5" height="4" rx="1" />
          <path d="M6.5 4h3M12 6v4" />
        </svg>
        Auto layout
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!ready}
        onClick={() => view.fitAll()}
        title="Fit the whole diagram in view"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden
        >
          <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
        </svg>
        Fit
      </Button>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        disabled={loading}
        onClick={() => void view.refresh()}
        title="Read the structure again from the server"
      >
        <Icon name="refresh" className={cx('h-3.5 w-3.5', loading && 'animate-spin')} />
        Refresh
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="primary" disabled={!ready || exporting}>
            {exporting ? 'Exporting…' : 'Export'}
            <Icon name="chevron-down" className="h-3 w-3" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-56 rounded-md border border-border bg-panel p-1 text-[13px] text-fg shadow-xl"
          >
            <MenuLabel>Save as</MenuLabel>
            <MenuItem hint="vector" onSelect={() => void view.export('svg')}>
              SVG image…
            </MenuItem>
            <MenuItem hint="2×" onSelect={() => void view.export('png', rasteriseSvg)}>
              PNG image…
            </MenuItem>
            <MenuItem hint=".mmd" onSelect={() => void view.export('mermaid')}>
              Mermaid diagram…
            </MenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuLabel>Copy to the clipboard</MenuLabel>
            <MenuItem hint="Markdown" onSelect={() => view.copy('mermaid')}>
              As Mermaid
            </MenuItem>
            <MenuItem hint="Figma, docs" onSelect={() => view.copy('svg')}>
              As SVG markup
            </MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

function MenuLabel(props: { readonly children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-wide text-muted uppercase">
      {props.children}
    </DropdownMenu.Label>
  );
}

function MenuItem(props: {
  readonly children: ReactNode;
  readonly hint?: string;
  readonly onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={props.onSelect}
      className="flex cursor-default items-center gap-3 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-hover"
    >
      <span className="flex-1">{props.children}</span>
      {props.hint && <span className="text-[11px] text-muted">{props.hint}</span>}
    </DropdownMenu.Item>
  );
}

function ToggleChip(props: {
  readonly pressed: boolean;
  readonly onChange: () => void;
  readonly title: string;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onChange}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-medium',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.pressed
          ? 'border-accent/50 bg-accent/15 text-fg'
          : 'border-border text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {props.children}
    </button>
  );
}

function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly title: string;
  }[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className={cx(
        'flex h-7 items-center rounded border border-border bg-panel-2 p-0.5',
        props.disabled && 'opacity-50',
      )}
    >
      {props.options.map((option) => {
        const on = props.value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={option.title}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            className={cx(
              'h-full rounded-[3px] px-2 text-xs font-medium transition-colors',
              on ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Messages and states

function NoticeBar({ view }: { readonly view: ErDiagramView }) {
  const notice = useErDiagram(view, (s) => s.notice);
  const status = useErDiagram(view, (s) => s.status);
  const error = useErDiagram(view, (s) => s.error);
  const hasDiagram = useErDiagram(view, (s) => s.diagram !== undefined);
  useEffect(() => {
    if (notice?.kind !== 'success') return;
    const timer = setTimeout(() => view.note(undefined), 5000);
    return () => clearTimeout(timer);
  }, [notice, view]);
  // A failed reload keeps the last diagram and says so here.
  const shown =
    notice ??
    (status === 'error' && hasDiagram && error
      ? { kind: 'error' as const, text: `The structure could not be read again: ${error}` }
      : undefined);
  if (!shown) return null;
  return (
    <div
      role={shown.kind === 'error' ? 'alert' : 'status'}
      data-testid="er-notice"
      className={cx(
        'flex items-center gap-2 border-b px-3 py-1.5 text-xs',
        shown.kind === 'error'
          ? 'border-danger/30 bg-danger/10 text-danger'
          : shown.kind === 'success'
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-border bg-panel-2 text-fg',
      )}
    >
      {shown.kind === 'error' && <Icon name="warning" className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={shown.text}>
        {shown.text}
      </span>
      {notice ? (
        <button
          type="button"
          aria-label="Dismiss"
          className="rounded px-1 opacity-70 hover:bg-hover hover:opacity-100"
          onClick={() => view.note(undefined)}
        >
          ×
        </button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => void view.refresh()}>
          Retry
        </Button>
      )}
    </div>
  );
}

function Centered(props: { readonly children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">{props.children}</div>
    </div>
  );
}

function Loading({ view }: { readonly view: ErDiagramView }) {
  const place = view.target.schema ?? view.target.database;
  return (
    <Centered>
      <span
        aria-hidden
        className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent"
      />
      <p className="text-sm text-muted" role="status">
        Reading the structure{place ? ` of ${place}` : ''}…
      </p>
    </Centered>
  );
}

function LoadError({ view }: { readonly view: ErDiagramView }) {
  const error = useErDiagram(view, (s) => s.error);
  return (
    <Centered>
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/15 text-danger">
        <Icon name="warning" className="h-5 w-5" />
      </span>
      <div role="alert">
        <p className="text-sm font-semibold text-fg">The structure could not be read</p>
        <p className="mt-1 text-xs break-words text-muted">{error}</p>
      </div>
      <Button size="sm" onClick={() => void view.refresh()}>
        Try again
      </Button>
    </Centered>
  );
}

function Empty({ view, diagram }: { readonly view: ErDiagramView; readonly diagram: ErDiagram }) {
  const schema = useErDiagram(view, (s) => s.schema);
  const includeViews = useErDiagram(view, (s) => s.includeViews);
  const place = schema ?? diagram.database;
  const home = schema ?? (diagram.schemas.length === 1 ? diagram.schemas[0] : undefined);
  return (
    <Centered>
      <svg
        viewBox="0 0 64 48"
        className="h-12 w-16 text-border"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <rect x="2" y="6" width="22" height="18" rx="3" />
        <rect x="40" y="24" width="22" height="18" rx="3" strokeDasharray="3 3" />
        <path d="M24 15h8v18h8" strokeDasharray="3 3" />
      </svg>
      <div>
        <p className="text-sm font-semibold text-fg">No tables in {place}</p>
        <p className="mt-1 text-xs text-muted">
          {includeViews
            ? 'There are no tables or views here yet.'
            : 'There are no tables here yet. Views are left out unless you turn them on.'}
        </p>
      </div>
      <div className="flex gap-2">
        {!includeViews && (
          <Button size="sm" onClick={() => void view.setIncludeViews(true)}>
            Show views
          </Button>
        )}
        {home !== undefined && (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              openTableDesigner({
                profileId: view.target.profileId,
                database: diagram.database,
                schema: home,
                name: null,
              })
            }
          >
            <Icon name="plus" className="h-3.5 w-3.5" />
            New table
          </Button>
        )}
      </div>
    </Centered>
  );
}

function LayingOut({ view }: { readonly view: ErDiagramView }) {
  const laying = useErDiagram(view, (s) => s.laying);
  if (!laying) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-panel/95 px-3 py-1 text-xs text-muted shadow-lg"
    >
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
      Laying out…
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Legend

const ENDS: readonly ErEnd[] = ['one', 'zero-or-one', 'zero-or-many'];

function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <section
      aria-label="Legend"
      className="absolute bottom-3 left-3 z-10 rounded-lg border border-border bg-panel/95 text-[11px] shadow-lg backdrop-blur"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 font-semibold tracking-wide text-muted uppercase hover:text-fg"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} className="h-3 w-3" />
        Legend
      </button>
      {open && (
        <div className="grid grid-cols-[auto_auto] gap-x-5 gap-y-1 border-t border-border px-3 pt-2 pb-2.5">
          <ul className="flex flex-col gap-1">
            {ENDS.map((end) => (
              <li key={end} className="flex items-center gap-2 text-fg">
                <EndGlyph end={end} />
                {END_NAMES[end]}
              </li>
            ))}
          </ul>
          <ul className="flex flex-col gap-1">
            {(['P', 'F', 'U'] as const).map((letter) => (
              <li key={letter} className="flex items-center gap-2 text-fg">
                <span className={cx('w-3 font-mono font-bold', KEY_LETTER_CLASSES[letter])}>
                  {letter}
                </span>
                {KEY_LETTER_NAMES[letter]}
              </li>
            ))}
            <li className="flex items-center gap-2 text-fg">
              <span className="w-3 font-mono font-bold text-muted">*</span>
              not null
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Table list

function TableList(props: {
  readonly view: ErDiagramView;
  readonly diagram: ErDiagram;
  readonly searchBox: RefObject<HTMLInputElement | null>;
}) {
  const { view, diagram } = props;
  const search = useErDiagram(view, (s) => s.search);
  const hidden = useErDiagram(view, (s) => s.hidden);
  const selected = useErDiagram(view, (s) => s.selected);
  const matches = useMemo(() => matchingTables(diagram, search), [diagram, search]);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of diagram.relations) {
      out.set(r.child, (out.get(r.child) ?? 0) + 1);
      if (r.parent !== r.child) out.set(r.parent, (out.get(r.parent) ?? 0) + 1);
    }
    return out;
  }, [diagram]);
  const searching = search.trim() !== '';
  const shown = diagram.tables.filter((t) => !searching || matches.has(t.id));
  const groups = useMemo(() => {
    const out: { key: string; title: string | undefined; tables: ErTable[] }[] = [];
    const several = diagram.schemas.length > 1;
    for (const table of shown) {
      const key = table.external ? '\u0000external' : several ? table.schema : '';
      let group = out.find((g) => g.key === key);
      if (!group) {
        group = {
          key,
          title: table.external ? 'Other schemas' : several ? table.schema : undefined,
          tables: [],
        };
        out.push(group);
      }
      group.tables.push(table);
    }
    return out;
  }, [shown, diagram.schemas.length]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="er-table-list">
      <div className="border-b border-border p-2">
        <div className="relative">
          <svg
            viewBox="0 0 16 16"
            className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            ref={props.searchBox}
            type="search"
            aria-label="Find tables and columns"
            placeholder="Find tables and columns"
            value={search}
            onChange={(event) => view.setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const first = shown.find((t) => !hidden.has(t.id)) ?? shown[0];
                if (first) view.focus(first.id);
              }
            }}
            className="h-7 w-full rounded border border-border bg-panel-2 pr-2 pl-7 text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          <span aria-live="polite">
            {searching
              ? `${matches.size} of ${diagram.tables.length} match`
              : `${diagram.tables.length} ${diagram.tables.length === 1 ? 'table' : 'tables'}`}
            {hidden.size > 0 && ` · ${hidden.size} hidden`}
          </span>
          <span className="flex-1" />
          {hidden.size > 0 && (
            <button
              type="button"
              className="rounded px-1 text-accent hover:bg-hover"
              onClick={() => view.showAll()}
            >
              Show all
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {shown.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted">No table or column matches “{search}”.</p>
        )}
        {groups.map((group) => (
          <section key={group.key} aria-label={group.title ?? 'Tables'}>
            {group.title && (
              <h3 className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-muted uppercase">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{
                    background: group.tables[0] ? schemaColor(diagram, group.tables[0]) : undefined,
                  }}
                />
                {group.title}
              </h3>
            )}
            <ul>
              {group.tables.map((table) => {
                const label = tableLabel(diagram, table);
                const isHidden = hidden.has(table.id);
                const count = counts.get(table.id) ?? 0;
                return (
                  <li
                    key={table.id}
                    className={cx(
                      'group flex items-center gap-1.5 pr-2 pl-2.5 text-xs',
                      table.id === selected ? 'bg-accent/15' : 'hover:bg-hover',
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Show ${label}`}
                      title={isHidden ? 'Show on the diagram' : 'Hide from the diagram'}
                      checked={!isHidden}
                      onChange={(event) => view.setHidden(table.id, !event.target.checked)}
                      className="shrink-0 accent-[var(--accent)]"
                    />
                    <button
                      type="button"
                      data-er-table={label}
                      title={`Show ${label} on the diagram`}
                      onClick={() => view.focus(table.id)}
                      className={cx(
                        'flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left focus:outline-none focus-visible:underline',
                        isHidden && 'text-muted',
                      )}
                    >
                      <KindGlyph kind={table.kind} className="text-muted" />
                      <span className={cx('min-w-0 flex-1 truncate', table.external && 'italic')}>
                        {group.title && !table.external ? table.name : label}
                      </span>
                      {count > 0 && (
                        <span
                          className="shrink-0 rounded-full bg-panel-2 px-1.5 text-[10px] leading-4 text-muted"
                          title={`${count} ${count === 1 ? 'relationship' : 'relationships'}`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Inspector

function Inspector(props: {
  readonly view: ErDiagramView;
  readonly diagram: ErDiagram;
  readonly tableId: string;
}) {
  const { view, diagram } = props;
  const table = diagram.tables.find((t) => t.id === props.tableId);
  if (!table) return null;
  const label = tableLabel(diagram, table);
  const outgoing = diagram.relations.filter((r) => r.child === table.id);
  const incoming = diagram.relations.filter((r) => r.parent === table.id);
  const kind = table.external ? 'in another schema' : KIND_LABELS[table.kind];
  const byId = (id: string): ErTable | undefined => diagram.tables.find((t) => t.id === id);
  return (
    <aside
      aria-label={`Details of ${label}`}
      data-testid="er-inspector"
      className="flex w-72 shrink-0 flex-col border-l border-border bg-panel"
    >
      <header className="relative border-b border-border px-3 pt-3.5 pb-3">
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px]"
          style={{ background: schemaColor(diagram, table) }}
        />
        <div className="flex items-start gap-2">
          <KindGlyph kind={table.kind} className="mt-0.5 text-muted" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-fg" title={label}>
              {table.name}
            </h2>
            <p className="truncate text-[11px] text-muted">
              {[table.schema, kind].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close the details"
            className="rounded px-1 text-muted hover:bg-hover hover:text-fg"
            onClick={() => view.select(undefined)}
          >
            ×
          </button>
        </div>
        {table.comment && <p className="mt-2 text-xs text-muted">{table.comment}</p>}
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="primary" onClick={() => openData(view, diagram, table)}>
            Open data
          </Button>
          <Button
            size="sm"
            disabled={!canDesign(table)}
            title={canDesign(table) ? 'Open in the table designer' : 'Only tables can be designed'}
            onClick={() => openDesign(view, diagram, table)}
          >
            Design
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Show only this table and the tables it is related to"
            onClick={() => view.isolate(table.id)}
          >
            Only related
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Take this table off the diagram"
            onClick={() => view.setHidden(table.id, true)}
          >
            Hide
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <InspectorSection title="Columns" count={table.columns.length}>
          <ul className="px-1">
            {table.columns.map((column) => (
              <li
                key={column.name}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover"
              >
                <span className="w-5 shrink-0">
                  <KeyLetters letters={keyLetters(column)} />
                </span>
                <span
                  className={cx('min-w-0 flex-1 truncate', column.primaryKey && 'font-semibold')}
                >
                  {column.name}
                  {!column.nullable && !column.primaryKey && <span className="text-muted"> *</span>}
                </span>
                {column.type && (
                  <span
                    className="max-w-[45%] shrink-0 truncate font-mono text-[10.5px] text-muted"
                    title={column.type}
                  >
                    {column.type}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </InspectorSection>
        <InspectorSection title="References" count={outgoing.length} empty="No foreign keys.">
          <RelationList
            view={view}
            diagram={diagram}
            relations={outgoing}
            other={(r) => byId(r.parent)}
            direction="out"
          />
        </InspectorSection>
        <InspectorSection
          title="Referenced by"
          count={incoming.length}
          empty="No table references it."
        >
          <RelationList
            view={view}
            diagram={diagram}
            relations={incoming}
            other={(r) => byId(r.child)}
            direction="in"
          />
        </InspectorSection>
      </div>
    </aside>
  );
}

function InspectorSection(props: {
  readonly title: string;
  readonly count: number;
  readonly empty?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="border-b border-border py-2">
      <h3 className="flex items-center gap-1.5 px-3 pb-1 text-[10.5px] font-semibold tracking-wide text-muted uppercase">
        {props.title}
        <span className="rounded-full bg-panel-2 px-1.5 text-[10px] leading-4 font-medium tracking-normal">
          {props.count}
        </span>
      </h3>
      {props.count === 0 && props.empty ? (
        <p className="px-3 py-1 text-xs text-muted">{props.empty}</p>
      ) : (
        props.children
      )}
    </section>
  );
}

function RelationList(props: {
  readonly view: ErDiagramView;
  readonly diagram: ErDiagram;
  readonly relations: readonly ErRelation[];
  readonly other: (relation: ErRelation) => ErTable | undefined;
  readonly direction: 'in' | 'out';
}) {
  return (
    <ul className="flex flex-col gap-1 px-1.5">
      {props.relations.map((relation) => {
        const other = props.other(relation);
        const name = other ? tableLabel(props.diagram, other) : '?';
        const columns = `${relation.childColumns.join(', ')} → ${relation.parentColumns.join(', ')}`;
        const actions = actionsOf(relation);
        return (
          <li key={relation.id}>
            <button
              type="button"
              className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-hover"
              title={`Show ${name}`}
              onClick={() => other && props.view.focus(other.id)}
            >
              <span className="flex items-center gap-1.5 text-xs">
                <span className="text-muted">{props.direction === 'out' ? '→' : '←'}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{name}</span>
                <span className="shrink-0 text-[10.5px] text-muted">{cardinality(relation)}</span>
              </span>
              <span
                className="truncate pl-4 font-mono text-[10.5px] text-muted"
                title={relation.name}
              >
                {columns}
              </span>
              {actions.length > 0 && (
                <span className="pl-4 text-[10px] font-medium text-warning">
                  {actions.join(' · ')}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Footer

function Footer({ view }: { readonly view: ErDiagramView }) {
  const profile = cachedProfile(view.target.profileId);
  const connection = useConnections((state) => state.byProfile[view.target.profileId]);
  const diagram = useErDiagram(view, (s) => s.diagram);
  const schema = useErDiagram(view, (s) => s.schema);
  const hidden = useErDiagram(view, (s) => s.hidden);
  const tables = diagram?.tables.filter((t) => !t.external).length ?? 0;
  const relations = diagram?.relations.length ?? 0;
  return (
    <footer className="flex items-center gap-2 border-t border-border bg-panel px-3 py-0.5 text-[11px] text-muted">
      {profile && (
        <span className="flex items-center gap-1.5">
          <EnvironmentBadge environment={profile.presentation.environment} />
          {profile.name}
        </span>
      )}
      {diagram && <span>· {[diagram.database, schema].filter(Boolean).join(' · ')}</span>}
      <span className="flex-1" />
      {diagram && (
        <span data-testid="er-stats">
          {tables} {tables === 1 ? 'table' : 'tables'} · {relations}{' '}
          {relations === 1 ? 'relationship' : 'relationships'}
          {hidden.size > 0 && ` · ${hidden.size} hidden`}
        </span>
      )}
      <span>·</span>
      <span>
        {connection?.status === 'ready' ? 'Connected' : (connection?.status ?? 'Not connected')}
      </span>
    </footer>
  );
}
