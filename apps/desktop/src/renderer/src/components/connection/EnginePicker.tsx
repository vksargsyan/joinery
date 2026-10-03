import { ENGINES, type EngineFamily, type EngineId } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  COMING_SOON_ENGINES,
  DIALOG_ENGINES,
  type DialogEngine,
} from '../../state/connection-form';
import { ENGINE_TONES, EngineIcon } from '../EngineIcon';
import { Icon, cx } from '../ui';

/**
 * The first step of a new connection, as Navicat's: which database it is. One card per engine
 * with its pictogram, family and default port, the last used engine picked; a search narrows the
 * cards. Arrows move between cards, Enter or a double-click goes on to the form.
 */

const FAMILY_LABELS: Readonly<Record<EngineFamily, string>> = {
  sql: 'Relational',
  document: 'Document',
  'key-value': 'Key-value',
  search: 'Search',
};

/** Cards per row. */
const COLUMNS = 3;

/** The engine of the connection saved last, to pick first. */
export function lastUsedEngine(profiles: readonly StoredProfile[]): DialogEngine | undefined {
  const latest = [...profiles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return DIALOG_ENGINES.find((engine) => engine === latest?.engine);
}

function matches(engine: EngineId, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  const info = ENGINES[engine];
  return (
    info.displayName.toLowerCase().includes(needle) ||
    FAMILY_LABELS[info.family].toLowerCase().includes(needle)
  );
}

export function EnginePicker(props: {
  readonly selected: DialogEngine | undefined;
  readonly lastUsed: DialogEngine | undefined;
  readonly onSelect: (engine: DialogEngine) => void;
  /** Enter or a double-click: this engine, and on to the form. */
  readonly onChoose: (engine: DialogEngine) => void;
  /** The pasted-URI box, under the cards. */
  readonly uri: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const cards = useRef(new Map<DialogEngine, HTMLDivElement>());
  const shown = DIALOG_ENGINES.filter((engine) => matches(engine, search));
  const soon = COMING_SOON_ENGINES.filter((engine) => matches(engine, search));
  // The card that takes the focus when tabbing into the group.
  const current = shown.find((engine) => engine === props.selected) ?? shown[0];

  // The picked card has the focus at first, so arrows and Enter work straight away (the
  // dialog's own first focus would land on the search).
  useEffect(() => {
    // After the dialog's own first focus, which lands on the search.
    const frame = requestAnimationFrame(() => {
      if (current !== undefined) cards.current.get(current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, []);

  const move = (engine: DialogEngine, by: number): void => {
    const next = shown[shown.indexOf(engine) + by];
    if (next === undefined) return;
    props.onSelect(next);
    cards.current.get(next)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, engine: DialogEngine): void => {
    switch (event.key) {
      case 'ArrowRight':
        move(engine, 1);
        break;
      case 'ArrowLeft':
        move(engine, -1);
        break;
      case 'ArrowDown':
        move(engine, COLUMNS);
        break;
      case 'ArrowUp':
        move(engine, -COLUMNS);
        break;
      case ' ':
        props.onSelect(engine);
        break;
      case 'Enter':
        props.onChoose(engine);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-[13px] font-semibold text-fg">Choose a database</h3>
          <p className="mt-0.5 text-xs text-muted">The engine this connection talks to.</p>
        </div>
        <label className="flex h-[26px] w-56 items-center gap-1.5 rounded-sm border border-border bg-deep px-1.5 focus-within:border-focus">
          <Icon name="search" className="h-3.5 w-3.5 text-faint" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search !== '') {
                event.stopPropagation();
                setSearch('');
              }
              if (event.key === 'Enter' && shown.length === 1) props.onChoose(shown[0]!);
            }}
            placeholder="Search"
            aria-label="Search engines"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none! placeholder:text-faint"
          />
        </label>
      </div>

      <div
        role="radiogroup"
        aria-label="Database engine"
        className="grid gap-2.5"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
      >
        {shown.map((engine) => {
          const info = ENGINES[engine];
          const checked = engine === props.selected;
          return (
            <div
              key={engine}
              ref={(node) => {
                if (node) cards.current.set(engine, node);
                else cards.current.delete(engine);
              }}
              role="radio"
              aria-checked={checked}
              aria-label={info.displayName}
              tabIndex={engine === current ? 0 : -1}
              onClick={() => props.onSelect(engine)}
              onDoubleClick={() => props.onChoose(engine)}
              onKeyDown={(event) => onKeyDown(event, engine)}
              data-testid={`engine-${engine}`}
              className={cx(
                'group relative flex cursor-default items-center gap-3 rounded-md border px-3 py-3 outline-none select-none',
                'transition-[background-color,border-color] duration-100',
                'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus',
                checked
                  ? 'border-accent bg-list-active'
                  : 'border-border bg-deep hover:border-strong hover:bg-list-hover',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-current/12 ring-1 ring-current/20 ring-inset',
                  ENGINE_TONES[engine],
                )}
              >
                <EngineIcon engine={engine} className="h-6 w-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">
                  {info.displayName}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  {FAMILY_LABELS[info.family]} · {info.defaultPort}
                </span>
              </span>
              {checked ? (
                <span
                  aria-hidden="true"
                  className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-fg"
                >
                  <Icon name="check" className="h-3 w-3" />
                </span>
              ) : (
                engine === props.lastUsed && (
                  <span className="absolute top-1.5 right-2 text-[10px] text-faint">Last used</span>
                )
              )}
            </div>
          );
        })}
        {soon.map((engine) => (
          <div
            key={engine}
            aria-disabled="true"
            className="relative flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-3 opacity-50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-hover">
              <EngineIcon engine={engine} className="h-6 w-6" />
            </span>
            <span className="text-[13px] text-fg">{ENGINES[engine].displayName}</span>
            <span className="absolute top-1.5 right-2 text-[10px] text-faint">Soon</span>
          </div>
        ))}
      </div>
      {shown.length === 0 && soon.length === 0 && (
        <p className="py-6 text-center text-xs text-muted">No engine matches “{search.trim()}”.</p>
      )}

      <div className="mt-auto">{props.uri}</div>
    </div>
  );
}
