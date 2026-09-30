import { DropdownMenu, Popover } from 'radix-ui';
import type { ReactNode } from 'react';

import {
  hiddenCount,
  nudgeColumn,
  resetWidth,
  setHidden,
  setPinned,
  showAll,
  type ColumnLayout,
} from '../../state/grid-layout';
import { MenuItem } from '../MenuItem';
import { PointerAnchor } from '../PointerAnchor';
import { Button, cx } from '../ui';

/**
 * Column controls shared by the table data grid and the query result grid (spec §7: hide,
 * reorder, pin and resize columns): the Columns popover lists every column with its visibility,
 * pin and order (the keyboard way to do what header drags do), and the header menu acts on one
 * column. Both only produce a new layout; the grid owns it.
 */

export function ColumnsPopover(props: {
  readonly layout: ColumnLayout;
  /** The column's name as shown (result grids key columns by position). */
  readonly label: (key: string) => string;
  readonly onChange: (layout: ColumnLayout) => void;
  /** Back to every column, in order, unpinned, at its own width. */
  readonly onReset: () => void;
}) {
  const { layout, label, onChange } = props;
  const hidden = hiddenCount(layout);
  const visible = layout.columns.filter((c) => !c.hidden);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" title="Show, hide, pin and order the columns">
          Columns{hidden > 0 ? ` (${hidden} hidden)` : ''}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          aria-label="Columns"
          data-testid="columns-popover"
          className="z-50 flex max-h-[70vh] w-72 flex-col rounded border border-border bg-raised text-[13px] shadow-widget"
        >
          <ul className="min-h-0 flex-1 overflow-auto p-1" aria-label="Columns">
            {layout.columns.map((column) => {
              const name = label(column.key);
              const position = visible.indexOf(column);
              return (
                <li
                  key={column.key}
                  className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover"
                  data-testid="column-row"
                  data-column={name}
                >
                  <label className="flex min-w-0 flex-1 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!column.hidden}
                      disabled={!column.hidden && visible.length === 1}
                      onChange={(event) =>
                        onChange(setHidden(layout, column.key, !event.target.checked))
                      }
                    />
                    <span className="truncate font-mono text-xs">{name}</span>
                  </label>
                  <IconToggle
                    label={column.pinned ? `Unpin ${name}` : `Pin ${name}`}
                    pressed={column.pinned === true}
                    onClick={() => onChange(setPinned(layout, column.key, !column.pinned))}
                  >
                    Pin
                  </IconToggle>
                  <IconToggle
                    label={`Move ${name} left`}
                    disabled={column.hidden === true || position <= 0}
                    onClick={() => onChange(nudgeColumn(layout, column.key, -1))}
                  >
                    ↑
                  </IconToggle>
                  <IconToggle
                    label={`Move ${name} right`}
                    disabled={column.hidden === true || position >= visible.length - 1}
                    onClick={() => onChange(nudgeColumn(layout, column.key, 1))}
                  >
                    ↓
                  </IconToggle>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-between gap-2 border-t border-border p-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={hidden === 0}
              onClick={() => onChange(showAll(layout))}
            >
              Show all
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onReset}>
              Reset columns
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function IconToggle(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      {...(props.pressed === undefined ? {} : { 'aria-pressed': props.pressed })}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        'rounded px-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30',
        props.pressed === true && 'bg-accent/15 text-accent',
      )}
    >
      {props.children}
    </button>
  );
}

/** Where a header menu opened, and on which column (a layout key). */
export interface HeaderMenuAt {
  readonly x: number;
  readonly y: number;
  readonly key: string;
}

/** The menu of one column header: sort (table grids), hide, pin, width. */
export function HeaderMenu(props: {
  readonly at: HeaderMenuAt;
  readonly layout: ColumnLayout;
  readonly label: string;
  readonly onChange: (layout: ColumnLayout) => void;
  readonly onClose: () => void;
  /** Server-side sort, for table grids. */
  readonly onSort?: (direction: 'asc' | 'desc' | null) => void;
}) {
  const { at, layout, onChange } = props;
  const column = layout.columns.find((c) => c.key === at.key);
  if (!column) return null;
  const lastVisible = layout.columns.filter((c) => !c.hidden).length <= 1;
  return (
    <DropdownMenu.Root open onOpenChange={(open) => !open && props.onClose()} modal={false}>
      <DropdownMenu.Trigger asChild>
        <PointerAnchor x={at.x} y={at.y} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={2}
          collisionPadding={8}
          aria-label={`Column ${props.label}`}
          className="z-50 min-w-52 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          <DropdownMenu.Label className="truncate px-2 pt-1 pb-1.5 font-mono text-[12px] text-fg">
            {props.label}
          </DropdownMenu.Label>
          {props.onSort && (
            <>
              <MenuItem icon="sort-asc" onSelect={() => props.onSort?.('asc')}>
                Sort ascending
              </MenuItem>
              <MenuItem icon="sort-desc" onSelect={() => props.onSort?.('desc')}>
                Sort descending
              </MenuItem>
              <MenuItem icon="close" onSelect={() => props.onSort?.(null)}>
                Clear sort
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <MenuItem
            icon="eye-off"
            disabled={lastVisible}
            onSelect={() => onChange(setHidden(layout, at.key, true))}
          >
            Hide column
          </MenuItem>
          <MenuItem icon="pin" onSelect={() => onChange(setPinned(layout, at.key, !column.pinned))}>
            {column.pinned ? 'Unpin column' : 'Pin column'}
          </MenuItem>
          <MenuItem
            icon="width"
            disabled={column.width === undefined}
            onSelect={() => onChange(resetWidth(layout, at.key))}
          >
            Reset width
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
