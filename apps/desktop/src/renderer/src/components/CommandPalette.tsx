import { isSqlEngine } from '@joinery/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { fuzzyMatch } from '../lib/fuzzy';
import { keyCaps } from '../lib/keys';
import { allCommands, isEnabled, runCommand, useCommands } from '../state/commands';
import { useConnections } from '../state/connections';
import { useExplorer } from '../state/explorer';
import { bindingOf, useKeybindings } from '../state/keybindings';
import { choose, closePalette, setPaletteText, usePalette } from '../state/palette';
import {
  connectedProfiles,
  explorerEntries,
  refreshQuickOpen,
  rememberEntry,
  useQuickOpen,
  type ObjectEntry,
} from '../state/quick-open';
import { useWindowState } from '../state/window';
import { EngineIcon } from './EngineIcon';
import { openObjectData } from './ObjectMenu';
import { mongoNodeOpener } from './mongo/MongoTree';
import { Icon, cx } from './ui';

/**
 * The command palette, as VS Code's quick input, at the top of the window. Without a prefix it
 * is Go to Object (⌘P): the tables, views and collections of the connected connections, the
 * recently opened first. With ">" it is the commands (⌘⇧P): recently used first, then the
 * others, each with its key binding as key caps. Commands that ask for a choice (a connection, a
 * schema) show their list here too. Arrows move, Enter runs, Escape closes; the match shows in
 * rust.
 */

interface Row {
  readonly key: string;
  readonly icon: ReactNode;
  /** Shown before the label, muted: a command's category. */
  readonly prefix?: string;
  readonly label: string;
  /** Matched positions in `prefix: label` (or the label alone without a prefix). */
  readonly matches: readonly number[];
  readonly description?: string;
  readonly binding?: string;
  /** Starts a group: shown on the right of its first row. */
  readonly group?: string;
  readonly run: () => void;
}

const LIMIT = 200;

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  return open ? <PaletteBody /> : null;
}

function PaletteBody() {
  const text = usePalette((s) => s.text);
  const pick = usePalette((s) => s.pick);
  const mode = pick ? 'pick' : text.startsWith('>') ? 'commands' : 'objects';
  const query = mode === 'commands' ? text.slice(1).trimStart() : text;
  const mac = useWindowState((s) => s.platform) === 'darwin';
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // What the rows read; each subscription re-renders the list when it changes.
  const commandsVersion = useCommands((s) => s.version);
  const recentCommands = useCommands((s) => s.recent);
  const overrides = useKeybindings((s) => s.overrides);
  const children = useExplorer((s) => s.children);
  const snapshots = useQuickOpen((s) => s.snapshots);
  const loading = useQuickOpen((s) => s.loading);
  const recentObjects = useQuickOpen((s) => s.recent);
  const statuses = useConnections((s) => s.byProfile);

  useEffect(() => {
    if (mode === 'objects') refreshQuickOpen();
  }, [mode]);
  useEffect(() => setSelected(0), [query, mode]);
  useEffect(() => input.current?.focus(), [pick]);

  const rows = useMemo((): Row[] => {
    if (mode === 'pick' && pick) {
      return pick.items
        .flatMap((item, index) => {
          const match = fuzzyMatch(query, item.label);
          if (!match) return [];
          return [
            {
              score: match.score,
              row: {
                key: `pick-${index}`,
                icon: item.icon ? <Icon name={item.icon} className="text-muted" /> : null,
                label: item.label,
                matches: match.indices,
                ...(item.description !== undefined ? { description: item.description } : {}),
                run: () => choose(item.value),
              } satisfies Row,
            },
          ];
        })
        .sort((a, b) => (query === '' ? 0 : b.score - a.score))
        .map(({ row }) => row);
    }
    if (mode === 'commands') {
      const commands = allCommands().filter(isEnabled);
      const recent = new Map(recentCommands.map((id, i) => [id, i]));
      const scored = commands.flatMap((command) => {
        const full = `${command.category}: ${command.title}`;
        const match =
          fuzzyMatch(query, full) ??
          (command.keywords?.some((word) => fuzzyMatch(query, word) !== undefined)
            ? { score: 0, indices: [] }
            : undefined);
        if (!match) return [];
        return [{ command, full, match, recent: recent.get(command.id) }];
      });
      const recentRows = scored
        .filter((s) => s.recent !== undefined)
        .sort((a, b) => (query === '' ? a.recent! - b.recent! : b.match.score - a.match.score));
      const otherRows = scored
        .filter((s) => s.recent === undefined)
        .sort((a, b) =>
          query === '' ? a.full.localeCompare(b.full) : b.match.score - a.match.score,
        );
      const toRow = (s: (typeof scored)[number], group?: string): Row => {
        const binding = bindingOf(s.command.id);
        return {
          key: s.command.id,
          icon: s.command.icon ? <Icon name={s.command.icon} className="text-muted" /> : null,
          prefix: s.command.category,
          label: s.command.title,
          matches: s.match.indices,
          ...(binding !== undefined ? { binding } : {}),
          ...(group !== undefined ? { group } : {}),
          run: () => {
            closePalette();
            void runCommand(s.command.id);
          },
        };
      };
      return [
        ...recentRows.map((s, i) => toRow(s, i === 0 ? 'recently used' : undefined)),
        ...otherRows.map((s, i) =>
          toRow(s, i === 0 && recentRows.length > 0 ? 'other commands' : undefined),
        ),
      ];
    }
    // Go to Object.
    const entries = new Map<string, ObjectEntry>();
    for (const profile of connectedProfiles()) {
      for (const entry of snapshots[profile.id] ?? []) entries.set(entry.key, entry);
      for (const entry of explorerEntries(profile, children[profile.id])) {
        entries.set(entry.key, entry);
      }
    }
    const open = (entry: ObjectEntry): void => {
      closePalette();
      rememberEntry(entry.key);
      if (isSqlEngine(entry.profile.engine)) {
        openObjectData(entry.profile, entry.node, entry.profile.engine);
      } else mongoNodeOpener(entry.profile, entry.node)?.();
    };
    const toRow = (entry: ObjectEntry, indices: readonly number[], group?: string): Row => ({
      key: entry.key,
      icon: <EngineIcon engine={entry.profile.engine} />,
      label: entry.node.name,
      matches: indices,
      description: `${entry.where}${entry.node.kind === 'table' || entry.node.kind === 'collection' ? '' : ` · ${entry.node.kind.replace('-', ' ')}`} — ${entry.profile.name}`,
      ...(group !== undefined ? { group } : {}),
      run: () => open(entry),
    });
    if (query === '') {
      const recentRows = recentObjects.flatMap((key) => {
        const entry = entries.get(key);
        return entry ? [entry] : [];
      });
      const recentKeys = new Set(recentRows.map((e) => e.key));
      const rest = [...entries.values()]
        .filter((e) => !recentKeys.has(e.key))
        .sort((a, b) => a.node.name.localeCompare(b.node.name))
        .slice(0, LIMIT);
      return [
        ...recentRows.map((e, i) => toRow(e, [], i === 0 ? 'recently opened' : undefined)),
        ...rest.map((e, i) =>
          toRow(e, [], i === 0 && recentRows.length > 0 ? 'all objects' : undefined),
        ),
      ];
    }
    return [...entries.values()]
      .flatMap((entry) => {
        const match = fuzzyMatch(query, entry.node.name);
        return match ? [{ entry, match }] : [];
      })
      .sort(
        (a, b) =>
          b.match.score - a.match.score || a.entry.node.name.length - b.entry.node.name.length,
      )
      .slice(0, LIMIT)
      .map(({ entry, match }) => toRow(entry, match.indices));
    // The rows follow what they read; the subscriptions above re-render on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    query,
    pick,
    commandsVersion,
    recentCommands,
    overrides,
    children,
    snapshots,
    recentObjects,
    statuses,
  ]);

  const connected = connectedProfiles().length > 0;
  const index = Math.min(selected, Math.max(0, rows.length - 1));
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const placeholder =
    mode === 'pick'
      ? pick!.placeholder
      : mode === 'commands'
        ? 'Type the name of a command to run'
        : 'Search tables, views and collections by name (type > for commands)';

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={() => closePalette()} aria-hidden="true" />
      <div
        role="dialog"
        aria-label={mode === 'commands' ? 'Commands' : mode === 'pick' ? 'Choose' : 'Go to object'}
        data-palette
        data-state="open"
        className="fixed top-[42px] left-1/2 z-50 flex w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-md border border-border bg-raised p-1.5 shadow-widget"
        data-testid="command-palette"
      >
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={rows[index] ? `palette-row-${index}` : undefined}
          aria-label={placeholder}
          spellCheck={false}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setPaletteText(event.target.value)}
          onKeyDown={(event) => {
            const move = (to: number): void => {
              event.preventDefault();
              if (rows.length === 0) return;
              setSelected((to + rows.length) % rows.length);
            };
            if (event.key === 'ArrowDown') move(index + 1);
            else if (event.key === 'ArrowUp') move(index - 1);
            else if (event.key === 'PageDown') move(Math.min(rows.length - 1, index + 10));
            else if (event.key === 'PageUp') move(Math.max(0, index - 10));
            else if (event.key === 'Enter') {
              event.preventDefault();
              rows[index]?.run();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              closePalette();
            }
          }}
          className="h-[30px] w-full rounded-sm border border-focus bg-deep px-2 text-[13px] text-fg outline-none! placeholder:text-faint"
        />
        <div
          ref={list}
          id="palette-list"
          role="listbox"
          aria-label="Results"
          className="mt-1.5 max-h-[min(440px,60vh)] overflow-auto"
        >
          {rows.map((row, i) => (
            <PaletteRow
              key={row.key}
              row={row}
              index={i}
              selected={i === index}
              first={i === 0}
              mac={mac}
              onHover={() => setSelected(i)}
            />
          ))}
          {rows.length === 0 && (
            <p className="px-2 py-2 text-[13px] text-muted">
              {mode === 'objects' && !connected
                ? 'Connect to a database to search its tables and collections.'
                : mode === 'objects' && loading > 0
                  ? 'Reading the connected databases…'
                  : 'No matching results'}
            </p>
          )}
        </div>
        {mode === 'objects' && loading > 0 && rows.length > 0 && (
          <p className="flex items-center gap-1.5 px-2 pt-1.5 text-[11px] text-faint">
            <span className="h-2.5 w-2.5 animate-spin rounded-full border border-rust/30 border-t-rust" />
            Reading the connected databases…
          </p>
        )}
      </div>
    </>
  );
}

function PaletteRow(props: {
  readonly row: Row;
  readonly index: number;
  readonly selected: boolean;
  readonly first: boolean;
  readonly mac: boolean;
  readonly onHover: () => void;
}) {
  const { row } = props;
  const full = row.prefix !== undefined ? `${row.prefix}: ${row.label}` : row.label;
  return (
    <div
      id={`palette-row-${props.index}`}
      data-index={props.index}
      role="option"
      aria-selected={props.selected}
      onMouseMove={props.onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={row.run}
      className={cx(
        'flex h-[26px] cursor-default items-center gap-2 rounded-sm px-2 text-[13px]',
        props.selected ? 'bg-list-active text-fg' : 'text-fg/90',
        row.group !== undefined && !props.first && 'mt-1 border-t border-border pt-1',
      )}
      style={row.group !== undefined && !props.first ? { height: 31 } : undefined}
    >
      <span className="flex w-4 shrink-0 justify-center">{row.icon}</span>
      <span className="truncate">
        <Highlight text={full} indices={row.matches} mutedUpTo={row.prefix?.length} />
      </span>
      {row.description !== undefined && (
        <span className="truncate text-[12px] text-muted">{row.description}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-3">
        {row.group !== undefined && <span className="text-[11px] text-rust">{row.group}</span>}
        {row.binding !== undefined && <KeyCaps binding={row.binding} mac={props.mac} />}
      </span>
    </div>
  );
}

/** Text with the matched characters in rust; the prefix (a category) muted. */
function Highlight(props: {
  readonly text: string;
  readonly indices: readonly number[];
  readonly mutedUpTo?: number | undefined;
}) {
  const marked = new Set(props.indices);
  const parts: ReactNode[] = [];
  let run = '';
  let runMarked = false;
  let runMuted = false;
  const flush = (at: number): void => {
    if (run === '') return;
    parts.push(
      <span
        key={at}
        className={cx(
          runMarked && 'font-semibold text-rust',
          !runMarked && runMuted && 'text-muted',
        )}
      >
        {run}
      </span>,
    );
    run = '';
  };
  for (let i = 0; i < props.text.length; i++) {
    const isMarked = marked.has(i);
    const isMuted = props.mutedUpTo !== undefined && i <= props.mutedUpTo;
    if (run !== '' && (isMarked !== runMarked || isMuted !== runMuted)) flush(i);
    runMarked = isMarked;
    runMuted = isMuted;
    run += props.text[i];
  }
  flush(props.text.length);
  return <>{parts}</>;
}

/** A binding as key caps: ⌘ K  ⌘ S. */
export function KeyCaps(props: { readonly binding: string; readonly mac: boolean }) {
  return (
    <span className="flex items-center gap-1.5" aria-label={props.binding}>
      {keyCaps(props.binding, props.mac).map((caps, chord) => (
        <span key={chord} className="flex items-center gap-0.5">
          {caps.map((cap, i) => (
            <kbd
              key={i}
              className="min-w-[18px] rounded-[3px] border border-border bg-deep px-1 text-center font-sans text-[11px] leading-[16px] text-muted shadow-[inset_0_-1px_0_var(--k-border)]"
            >
              {cap}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
