import type { KeybindingOverride } from '@querybara/ipc';
import { create } from 'zustand';

import { bindingLabel, chordOf, isPlainChord, parseBinding } from '../lib/keys';
import { mainApi } from '../lib/main-client';
import { clearStatus, commandById, isEnabled, runCommand, showStatus } from './commands';
import { keys, queryClient } from './data';
import { useWindowState } from './window';

/**
 * Key bindings, as VS Code's: each command's default key, the user's own over it (kept in the
 * app's settings as keybindings.json is), and one listener on the window that runs the bound
 * command. A binding may be a chord of two keys ("mod+k mod+s"): after the first, the window
 * waits a moment for the second and says so. Keys without Ctrl, ⌘ or Alt (F5) leave text fields
 * alone; nothing runs while a dialog is open, or while the Keyboard Shortcuts editor records.
 */

/** The defaults, by command id. */
export const DEFAULT_KEYBINDINGS: Readonly<Record<string, string>> = {
  'workbench.commandPalette': 'mod+shift+p',
  'workbench.quickOpen': 'mod+p',
  'workbench.keyboardShortcuts': 'mod+k mod+s',
  'workbench.toggleTheme': 'mod+k mod+t',
  'connection.new': 'mod+shift+n',
  'connection.search': 'mod+shift+f',
  'query.new': 'mod+t',
  'query.history': 'mod+shift+h',
  'view.objects': 'mod+shift+o',
  'view.closeTab': 'mod+w',
  'view.nextTab': 'ctrl+tab',
  'view.previousTab': 'ctrl+shift+tab',
  'view.refresh': 'f5',
  'tools.jobs': 'mod+shift+j',
};

interface KeybindingsState {
  /** The user's bindings over the defaults (the settings' keybindings). */
  readonly overrides: readonly KeybindingOverride[];
  /** The Keyboard Shortcuts editor is recording keys: the window does not act on them. */
  readonly recording: boolean;
}

export const useKeybindings = create<KeybindingsState>()(() => ({
  overrides: [],
  recording: false,
}));

/** Each command's binding: the user's where they set one ("" for none), else the default. */
export function effectiveBindings(
  overrides: readonly KeybindingOverride[],
): ReadonlyMap<string, string> {
  const bindings = new Map(Object.entries(DEFAULT_KEYBINDINGS));
  for (const { command, key } of overrides) bindings.set(command, key);
  return bindings;
}

/** The binding of a command now, or undefined when it has none. */
export function bindingOf(commandId: string): string | undefined {
  const binding = effectiveBindings(useKeybindings.getState().overrides).get(commandId);
  return binding === undefined || binding === '' ? undefined : binding;
}

export function useBindingOf(commandId: string): string | undefined {
  return useKeybindings((s) => {
    const binding = effectiveBindings(s.overrides).get(commandId);
    return binding === undefined || binding === '' ? undefined : binding;
  });
}

/** Commands sharing a binding with others: binding → command ids. */
export function conflicts(bindings: ReadonlyMap<string, string>): ReadonlyMap<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const [command, binding] of bindings) {
    if (binding === '') continue;
    const key = parseBinding(binding).join(' ');
    byKey.set(key, [...(byKey.get(key) ?? []), command]);
  }
  return new Map([...byKey].filter(([, commands]) => commands.length > 1));
}

/** Sets a command's binding ("" for none), or puts back its default with `undefined`. */
export async function setKeybinding(commandId: string, key: string | undefined): Promise<void> {
  const others = useKeybindings.getState().overrides.filter((o) => o.command !== commandId);
  const normalized = key === undefined ? undefined : parseBinding(key).join(' ');
  const overrides =
    normalized === undefined || normalized === (DEFAULT_KEYBINDINGS[commandId] ?? '')
      ? others
      : [...others, { command: commandId, key: normalized }];
  useKeybindings.setState({ overrides });
  await mainApi().settings.set({ keybindings: overrides });
  await queryClient.invalidateQueries({ queryKey: keys.settings });
}

const CHORD_WAIT_MS = 1500;

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor') !== null
  );
}

/** A modal dialog other than the palette is open: shortcuts wait until it closes. */
function dialogOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"]:not([data-palette]), [role="alertdialog"][data-state="open"]',
    ) !== null
  );
}

/**
 * Listens on the window for the bound keys (before the page's own handlers, as VS Code does).
 * Returns the function that stops listening.
 */
export function startKeybindings(): () => void {
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = (): void => {
    pending = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    if (useKeybindings.getState().recording) return;
    const mac = useWindowState.getState().platform === 'darwin';
    const chord = chordOf(event, mac);
    if (chord === undefined) return;
    const bindings = effectiveBindings(useKeybindings.getState().overrides);
    const sequence = pending === undefined ? [chord] : [pending, chord];
    let exact: string[] = [];
    let starts = false;
    for (const [command, binding] of bindings) {
      const chords = parseBinding(binding);
      if (chords.length === 0) continue;
      if (chords.length === sequence.length && chords.every((c, i) => c === sequence[i])) {
        exact.push(command);
      } else if (pending === undefined && chords.length === 2 && chords[0] === chord) {
        starts = true;
      }
    }
    exact = exact.filter((id) => {
      const command = commandById(id);
      return command !== undefined && isEnabled(command);
    });
    const second = pending !== undefined;
    if (pending !== undefined) {
      const first = pending;
      reset();
      clearStatus();
      if (exact.length === 0) {
        event.preventDefault();
        showStatus(
          'info',
          `The key combination (${bindingLabel(`${first} ${chord}`, mac)}) is not a command.`,
          2500,
        );
        return;
      }
    } else if (exact.length === 0 && !starts) {
      return;
    }
    // Plain keys (F5) stay with the field being typed in; dialogs keep their keys.
    if (isPlainChord(chord) && !second && editable(event.target)) return;
    if (dialogOpen()) return;
    if (exact.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void runCommand(exact[0]!);
      return;
    }
    // The first key of a chord: wait for the second.
    event.preventDefault();
    event.stopPropagation();
    pending = chord;
    showStatus(
      'info',
      `(${bindingLabel(chord, mac)}) was pressed. Waiting for second key of chord…`,
      CHORD_WAIT_MS,
    );
    timer = setTimeout(reset, CHORD_WAIT_MS);
  };

  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => {
    reset();
    window.removeEventListener('keydown', onKeyDown, { capture: true });
  };
}
