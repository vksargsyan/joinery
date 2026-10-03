import { create } from 'zustand';

import type { IconName } from '../components/icon-names';
import { errorMessage } from '../lib/errors';

/**
 * Commands, as VS Code has them: everything the command palette lists and a key binding can run.
 * Modules register theirs; the palette shows them as "Category: Title", recently used first.
 */

export interface Command {
  readonly id: string;
  /** "Connection", "Query", "View"... */
  readonly category: string;
  /** "New Connection…" */
  readonly title: string;
  readonly icon?: IconName;
  /** Other words the palette finds it by. */
  readonly keywords?: readonly string[];
  /** Whether it can run now; the palette leaves it out otherwise. */
  readonly enabled?: () => boolean;
  /** Kept out of "recently used" (the palette's own commands). */
  readonly unremembered?: boolean;
  readonly run: () => void | Promise<void>;
}

const registry = new Map<string, Command>();

interface CommandsState {
  /** Bumped when commands are registered or removed. */
  readonly version: number;
  /** Ids, most recent first. */
  readonly recent: readonly string[];
  /** A message about a command that failed, or a chord waiting for its second key. */
  readonly status: { readonly kind: 'error' | 'info'; readonly text: string } | undefined;
}

const RECENT_KEY = 'querybara.recentCommands';
const RECENT_LIMIT = 8;

function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export const useCommands = create<CommandsState>()(() => ({
  version: 0,
  recent: typeof localStorage === 'undefined' ? [] : readRecent(),
  status: undefined,
}));

/** Registers commands; the returned function removes them again. */
export function registerCommands(commands: readonly Command[]): () => void {
  for (const command of commands) registry.set(command.id, command);
  useCommands.setState((s) => ({ version: s.version + 1 }));
  return () => {
    for (const command of commands) {
      if (registry.get(command.id) === command) registry.delete(command.id);
    }
    useCommands.setState((s) => ({ version: s.version + 1 }));
  };
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function commandById(id: string): Command | undefined {
  return registry.get(id);
}

export function isEnabled(command: Command): boolean {
  try {
    return command.enabled?.() ?? true;
  } catch {
    return false;
  }
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a short message at the bottom of the window (a failed command, a pending chord). */
export function showStatus(kind: 'error' | 'info', text: string, ms = 5000): void {
  if (statusTimer !== undefined) clearTimeout(statusTimer);
  useCommands.setState({ status: { kind, text } });
  statusTimer = setTimeout(() => useCommands.setState({ status: undefined }), ms);
}

export function clearStatus(): void {
  if (statusTimer !== undefined) clearTimeout(statusTimer);
  useCommands.setState({ status: undefined });
}

/** Runs a command and remembers it as recently used; a failure shows as a status message. */
export async function runCommand(id: string): Promise<void> {
  const command = registry.get(id);
  if (!command || !isEnabled(command)) return;
  if (!command.unremembered) remember(id);
  try {
    await command.run();
  } catch (error) {
    showStatus('error', `${command.category}: ${command.title} failed: ${errorMessage(error)}`);
  }
}

function remember(id: string): void {
  const recent = [id, ...useCommands.getState().recent.filter((other) => other !== id)].slice(
    0,
    RECENT_LIMIT,
  );
  useCommands.setState({ recent });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Not kept: the list starts empty next time.
  }
}
