import { DropdownMenu } from 'radix-ui';
import { useEffect, useState } from 'react';

import { formatCount } from '../lib/format';
import { Icon, type IconName } from './ui';

/**
 * Navicat's pager, in a data view's status bar: first, previous, the page number (type one and
 * press Enter), next, last, and how many rows (or documents) a page holds under the gear. With
 * the total known it shows the number of pages and stops at the last one; without it, "Last"
 * is the view's to work out (it counts first).
 */

/** A page by number, a step, or the last page. */
export type PagerMove = 'first' | 'previous' | 'next' | 'last' | number;

export function Pager(props: {
  /** The page shown, from 1. */
  readonly page: number;
  readonly pageSize: number;
  readonly pageSizes: readonly number[];
  /** The page shown is full: another may follow. */
  readonly hasNext: boolean;
  /** Rows the query returns, when known. */
  readonly total: number | undefined;
  readonly busy: boolean;
  /** What a page holds, for the gear's label: "rows", "documents". */
  readonly noun: string;
  /** Prefixes the test ids ("table" → "table-pages"). */
  readonly testId: string;
  readonly onMove: (move: PagerMove) => void;
  readonly onPageSize: (size: number) => void;
}) {
  const [text, setText] = useState(String(props.page));
  useEffect(() => setText(String(props.page)), [props.page]);
  const pages =
    props.total === undefined ? undefined : Math.max(1, Math.ceil(props.total / props.pageSize));
  const atStart = props.page <= 1;
  const atEnd = pages !== undefined ? props.page >= pages : !props.hasNext;

  const step = (icon: IconName, label: string, move: PagerMove, off: boolean) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={off || props.busy}
      onClick={() => props.onMove(move)}
      className="flex h-[20px] w-[22px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent"
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
    </button>
  );
  const submit = (): void => {
    const page = Number(text);
    if (!Number.isInteger(page) || page < 1 || (pages !== undefined && page > pages)) {
      setText(String(props.page));
      return;
    }
    if (page !== props.page) props.onMove(page);
  };

  return (
    <nav
      aria-label="Pages"
      className="flex items-center gap-0.5"
      data-testid={`${props.testId}-pager`}
    >
      {step('page-first', 'First page', 'first', atStart)}
      {step('page-previous', 'Previous page', 'previous', atStart)}
      <input
        type="text"
        inputMode="numeric"
        aria-label="Page"
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') setText(String(props.page));
        }}
        onBlur={() => setText(String(props.page))}
        className="mx-0.5 h-[20px] w-11 rounded-sm border border-border bg-deep px-1 text-center text-xs text-fg tabular-nums outline-none! focus:border-focus"
      />
      {pages !== undefined && (
        <span className="px-0.5 text-muted tabular-nums" data-testid={`${props.testId}-pages`}>
          of {formatCount(pages)}
        </span>
      )}
      {step('page-next', 'Next page', 'next', atEnd)}
      {step('page-last', 'Last page', 'last', atEnd)}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Page size"
            title={`${formatCount(props.pageSize)} ${props.noun} per page`}
            className="ml-0.5 flex h-[20px] w-[22px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-pressed data-[state=open]:text-fg"
          >
            <Icon name="settings" className="h-3.5 w-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="end"
            className="z-50 min-w-44 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
          >
            <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
              {props.noun.charAt(0).toUpperCase() + props.noun.slice(1)} per page
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={String(props.pageSize)}
              onValueChange={(value) => props.onPageSize(Number(value))}
            >
              {props.pageSizes.map((size) => (
                <DropdownMenu.RadioItem
                  key={size}
                  value={String(size)}
                  className="relative flex cursor-default items-center rounded-sm py-1 pr-2 pl-7 tabular-nums outline-none data-[highlighted]:bg-list-active"
                >
                  <DropdownMenu.ItemIndicator className="absolute left-2 text-rust">
                    <Icon name="check" className="h-3.5 w-3.5" />
                  </DropdownMenu.ItemIndicator>
                  {formatCount(size)}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </nav>
  );
}
