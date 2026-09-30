import { useMemo, useRef, type KeyboardEvent } from 'react';

import { entryLabel, searchEntries } from '../../state/query-builder/catalog';
import { Button, Icon } from '../ui';
import { TABLE_DRAG_TYPE } from './Canvas';
import { SmallInput, useBuilder, useBuilderSelector, useReadOnly } from './parts';

/**
 * The tables and views of the builder's database (spec §8, from the metadata cache), with a
 * search box. Click or Enter adds one to the canvas, joined through its foreign keys; each can
 * also be dragged onto the canvas. Arrow keys move between the search box and the list.
 */

const SHOWN = 300;

export function TableList() {
  const builder = useBuilder();
  const readOnly = useReadOnly();
  const catalog = useBuilderSelector((state) => state.catalog);
  const search = useBuilderSelector((state) => state.search);
  const list = useRef<HTMLUListElement>(null);
  const matches = useMemo(
    () => (catalog.status === 'ready' ? searchEntries(catalog.catalog, search) : []),
    [catalog, search],
  );
  const focusItem = (index: number): void => {
    const items = list.current?.querySelectorAll<HTMLButtonElement>('button[data-entry]');
    items?.[Math.max(0, Math.min(index, items.length - 1))]?.focus();
  };
  const onListKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const items = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-entry]') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') focusItem(index + 1);
    else if (event.key === 'ArrowUp') {
      if (index <= 0) list.current?.parentElement?.querySelector('input')?.focus();
      else focusItem(index - 1);
    } else return;
    event.preventDefault();
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="builder-table-list">
      <div className="border-b border-border p-1.5">
        <SmallInput
          type="search"
          aria-label="Search tables"
          placeholder="Search tables"
          value={search}
          onChange={(event) => builder.setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusItem(0);
            } else if (
              event.key === 'Enter' &&
              matches.length === 1 &&
              catalog.status === 'ready'
            ) {
              builder.addTable(matches[0]!);
            }
          }}
          className="w-full"
        />
      </div>
      {catalog.status === 'loading' && <p className="p-2 text-xs text-muted">Loading tables…</p>}
      {catalog.status === 'error' && (
        <div role="alert" className="flex flex-col gap-1 p-2 text-xs text-danger">
          {catalog.error}
          <Button size="sm" onClick={() => void builder.reloadCatalog()}>
            Retry
          </Button>
        </div>
      )}
      {catalog.status === 'ready' && matches.length === 0 && (
        <p className="p-2 text-xs text-muted">
          {search ? 'No table matches.' : 'This database has no tables.'}
        </p>
      )}
      <ul
        ref={list}
        aria-label="Tables"
        className="min-h-0 flex-1 overflow-auto py-1"
        onKeyDown={onListKey}
      >
        {catalog.status === 'ready' &&
          matches.slice(0, SHOWN).map((entry) => {
            const label = entryLabel(catalog.catalog, entry);
            return (
              <li key={`${entry.schema}.${entry.name}`}>
                <button
                  type="button"
                  data-entry
                  draggable={!readOnly}
                  disabled={readOnly}
                  aria-label={`Add ${label}`}
                  title={`Add ${label} to the query (or drag it onto the canvas)`}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-50"
                  onClick={() => builder.addTable(entry)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      TABLE_DRAG_TYPE,
                      JSON.stringify({ schema: entry.schema, name: entry.name }),
                    );
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <Icon name="table" className="h-3.5 w-3.5 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {entry.kind === 'view' && <span className="text-[10px] text-muted">view</span>}
                </button>
              </li>
            );
          })}
        {matches.length > SHOWN && (
          <li className="px-2 py-1 text-[11px] text-muted">
            {matches.length - SHOWN} more: narrow the search.
          </li>
        )}
      </ul>
    </div>
  );
}
