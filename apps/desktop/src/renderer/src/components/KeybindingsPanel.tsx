import { useEffect, useMemo, useRef, useState } from 'react';

import { fuzzyMatch } from '../lib/fuzzy';
import { bindingLabel, chordOf, parseBinding } from '../lib/keys';
import { allCommands, useCommands, type Command } from '../state/commands';
import {
  DEFAULT_KEYBINDINGS,
  conflicts,
  effectiveBindings,
  setKeybinding,
  useKeybindings,
} from '../state/keybindings';
import { useWindowState } from '../state/window';
import { KeyCaps } from './CommandPalette';
import { Icon, cx } from './ui';

/**
 * The Keyboard Shortcuts editor, as VS Code's: every command with its key binding and where the
 * binding comes from (Default, or User for the user's own). A double-click, Enter or the pencil
 * records a new binding: press the keys (a chord of two too), then Enter; Escape cancels. A
 * binding that two commands share is marked. The user's bindings are kept in the app's settings.
 */

export function KeybindingsPanel() {
  const version = useCommands((s) => s.version);
  const overrides = useKeybindings((s) => s.overrides);
  const mac = useWindowState((s) => s.platform) === 'darwin';
  const [search, setSearch] = useState('');
  const [recording, setRecording] = useState<Command>();
  const [selected, setSelected] = useState<string>();

  const bindings = useMemo(() => effectiveBindings(overrides), [overrides]);
  const shared = useMemo(() => conflicts(bindings), [bindings]);
  const userSet = new Set(overrides.map((o) => o.command));

  const rows = useMemo(() => {
    const commands = allCommands().sort((a, b) =>
      `${a.category}: ${a.title}`.localeCompare(`${b.category}: ${b.title}`),
    );
    const needle = search.trim();
    if (needle === '') return commands;
    return commands.filter((command) => {
      const binding = bindings.get(command.id) ?? '';
      return (
        fuzzyMatch(needle, `${command.category}: ${command.title}`) !== undefined ||
        command.id.toLowerCase().includes(needle.toLowerCase()) ||
        (binding !== '' && bindingLabel(binding, mac).toLowerCase().includes(needle.toLowerCase()))
      );
    });
    // Commands registered later show too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, search, bindings, mac]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="keybindings-panel">
      <div className="flex h-[35px] shrink-0 items-center gap-2 border-b border-border px-3">
        <label className="flex h-[24px] w-96 items-center gap-1.5 rounded-sm border border-border bg-deep px-1.5 focus-within:border-focus">
          <Icon name="search" className="h-3.5 w-3.5 text-faint" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Type to search in key bindings"
            aria-label="Search key bindings"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none! placeholder:text-faint"
          />
        </label>
        <span className="text-[11px] text-muted">
          Double-click a row to change its key binding.
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" role="grid" aria-label="Key bindings">
        <div
          role="row"
          className="sticky top-0 z-10 grid h-[24px] grid-cols-[minmax(260px,1fr)_220px_90px_88px] items-center border-b border-border bg-panel px-3 text-[11px] font-medium text-muted"
        >
          <span role="columnheader">Command</span>
          <span role="columnheader">Key binding</span>
          <span role="columnheader">Source</span>
          <span />
        </div>
        {rows.map((command) => {
          const binding = bindings.get(command.id) ?? '';
          const key = parseBinding(binding).join(' ');
          const others = (shared.get(key) ?? []).filter((id) => id !== command.id);
          const user = userSet.has(command.id);
          const isSelected = selected === command.id;
          return (
            <div
              key={command.id}
              role="row"
              aria-selected={isSelected}
              tabIndex={0}
              onClick={() => setSelected(command.id)}
              onDoubleClick={() => setRecording(command)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setRecording(command);
              }}
              className={cx(
                'group grid h-[30px] cursor-default grid-cols-[minmax(260px,1fr)_220px_90px_88px] items-center px-3 text-[13px] outline-none',
                isSelected ? 'bg-list-active' : 'hover:bg-list-hover',
                'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus',
              )}
            >
              <span role="gridcell" className="flex min-w-0 items-center gap-2">
                {command.icon ? (
                  <Icon name={command.icon} className="text-muted" />
                ) : (
                  <span className="w-4" />
                )}
                <span className="truncate">
                  <span className="text-muted">{command.category}: </span>
                  {command.title}
                </span>
                <span className="truncate font-mono text-[11px] text-faint">{command.id}</span>
              </span>
              <span role="gridcell" className="flex min-w-0 items-center gap-1.5">
                {binding !== '' ? (
                  <KeyCaps binding={binding} mac={mac} />
                ) : (
                  <span className="text-faint">—</span>
                )}
                {others.length > 0 && (
                  <span
                    className="text-warning"
                    title={`Also bound to ${others.join(', ')}`}
                    aria-label={`Also bound to ${others.join(', ')}`}
                  >
                    <Icon name="warning" className="h-3.5 w-3.5" />
                  </span>
                )}
              </span>
              <span role="gridcell" className={cx('text-xs', user ? 'text-rust' : 'text-muted')}>
                {user ? 'User' : DEFAULT_KEYBINDINGS[command.id] !== undefined ? 'Default' : ''}
              </span>
              <span
                role="gridcell"
                className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-aria-selected:opacity-100"
              >
                <RowButton
                  icon="edit"
                  label={`Change the key binding of ${command.title}`}
                  onClick={() => setRecording(command)}
                />
                {binding !== '' && (
                  <RowButton
                    icon="trash"
                    label={`Remove the key binding of ${command.title}`}
                    onClick={() => void setKeybinding(command.id, '')}
                  />
                )}
                {user && (
                  <RowButton
                    icon="restore"
                    label={`Reset the key binding of ${command.title}`}
                    onClick={() => void setKeybinding(command.id, undefined)}
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>
      {recording && (
        <Recorder
          command={recording}
          mac={mac}
          bindings={bindings}
          onDone={(binding) => {
            setRecording(undefined);
            if (binding !== undefined) void setKeybinding(recording.id, binding);
          }}
        />
      )}
    </div>
  );
}

function RowButton(props: {
  readonly icon: 'edit' | 'trash' | 'restore';
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="rounded-sm p-1 text-muted hover:bg-hover hover:text-fg"
    >
      <Icon name={props.icon} className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Records a key binding: the keys pressed (up to a chord of two), Enter to keep them, Escape to
 * cancel. While it records, the window's key bindings stand still.
 */
function Recorder(props: {
  readonly command: Command;
  readonly mac: boolean;
  readonly bindings: ReadonlyMap<string, string>;
  readonly onDone: (binding: string | undefined) => void;
}) {
  const [chords, setChords] = useState<string[]>([]);
  const recorded = useRef<string[]>([]);
  const { onDone, mac } = props;

  useEffect(() => {
    useKeybindings.setState({ recording: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (plain && event.key === 'Escape') {
        onDone(undefined);
        return;
      }
      if (plain && event.key === 'Enter') {
        if (recorded.current.length > 0) onDone(recorded.current.join(' '));
        return;
      }
      const chord = chordOf(event, mac);
      if (chord === undefined) return;
      const current = recorded.current;
      recorded.current = current.length >= 2 ? [chord] : [...current, chord];
      setChords(recorded.current);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      useKeybindings.setState({ recording: false });
    };
  }, [onDone, mac]);

  const binding = chords.join(' ');
  const taken =
    binding === ''
      ? []
      : [...props.bindings]
          .filter(
            ([id, other]) => id !== props.command.id && parseBinding(other).join(' ') === binding,
          )
          .map(([id]) => id);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[18vh]"
      onMouseDown={() => onDone(undefined)}
    >
      <div
        role="dialog"
        aria-label="Record a key binding"
        data-state="open"
        data-palette
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[420px] flex-col items-center gap-3 rounded-md border border-border bg-raised px-6 py-5 text-center shadow-widget"
      >
        <p className="text-[13px] text-fg">
          Press the keys for <span className="text-rust">{props.command.title}</span>, then Enter
        </p>
        <div
          className="flex h-[34px] min-w-56 items-center justify-center rounded-sm border border-focus bg-deep px-3"
          data-testid="recorded-keys"
        >
          {binding === '' ? (
            <span className="text-xs text-faint">Waiting for keys…</span>
          ) : (
            <KeyCaps binding={binding} mac={mac} />
          )}
        </div>
        <p className={cx('text-xs', taken.length > 0 ? 'text-warning' : 'text-muted')}>
          {taken.length > 0
            ? `${taken.length === 1 ? 'Another command has' : `${taken.length} other commands have`} this key binding: ${taken.join(', ')}`
            : 'A second key makes a chord, as ⌘K ⌘S. Escape cancels.'}
        </p>
      </div>
    </div>
  );
}
