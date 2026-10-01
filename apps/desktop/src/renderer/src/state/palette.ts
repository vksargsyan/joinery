import type { IconName } from '../components/icon-names';
import { create } from 'zustand';

/**
 * The command palette's state (components/CommandPalette.tsx), as VS Code's quick input: open on
 * Go to Object (⌘P: the text has no prefix) or on the commands (⌘⇧P: the text starts with ">"),
 * or as a pick list a command asks the user to choose from (a connection, a schema).
 */

export interface PickItem<T> {
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly value: T;
}

interface Pick {
  readonly placeholder: string;
  readonly items: readonly PickItem<unknown>[];
  readonly resolve: (value: unknown) => void;
}

interface PaletteState {
  readonly open: boolean;
  readonly text: string;
  readonly pick: Pick | undefined;
}

export const usePalette = create<PaletteState>()(() => ({
  open: false,
  text: '',
  pick: undefined,
}));

/** Opens Go to Object, or the commands with ">". */
export function openPalette(text = ''): void {
  const current = usePalette.getState().pick;
  current?.resolve(undefined);
  usePalette.setState({ open: true, text, pick: undefined });
}

export function closePalette(): void {
  const current = usePalette.getState().pick;
  current?.resolve(undefined);
  usePalette.setState({ open: false, text: '', pick: undefined });
}

export function setPaletteText(text: string): void {
  usePalette.setState({ text });
}

/** Asks the user to pick one item; undefined when they close the list. */
export function quickPick<T>(options: {
  readonly placeholder: string;
  readonly items: readonly PickItem<T>[];
}): Promise<T | undefined> {
  usePalette.getState().pick?.resolve(undefined);
  return new Promise((resolve) => {
    usePalette.setState({
      open: true,
      text: '',
      pick: {
        placeholder: options.placeholder,
        items: options.items,
        resolve: (value) => resolve(value as T | undefined),
      },
    });
  });
}

/** Ends a pick with the chosen value. */
export function choose(value: unknown): void {
  const current = usePalette.getState().pick;
  usePalette.setState({ open: false, text: '', pick: undefined });
  current?.resolve(value);
}
