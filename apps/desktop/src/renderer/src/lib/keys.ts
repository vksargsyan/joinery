/**
 * Key chords as VS Code writes them: "mod+shift+p", a sequence as "mod+k mod+s". `mod` is ⌘ on
 * macOS and Ctrl elsewhere; `ctrl` on macOS is the Control key itself. Letters, digits and
 * punctuation are read from the key's position (KeyboardEvent.code), so Shift and keyboard
 * layouts do not change them; named keys (Enter, F5, arrows) from KeyboardEvent.key.
 */

export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'space',
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
  ' ': 'space',
};

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS']);

/** The key of an event without its modifiers; undefined for a modifier alone. */
function baseKey(event: KeyEventLike): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
  if (digit) return digit[1]!;
  if (CODE_KEYS[event.code] !== undefined) return CODE_KEYS[event.code];
  if (/^F\d{1,2}$/.test(event.key)) return event.key.toLowerCase();
  if (NAMED_KEYS[event.key] !== undefined) return NAMED_KEYS[event.key];
  return event.key.length === 1 ? event.key.toLowerCase() : undefined;
}

/** "mod+shift+p" for ⌘⇧P on macOS, Ctrl+Shift+P elsewhere; undefined for a modifier alone. */
export function chordOf(event: KeyEventLike, mac: boolean): string | undefined {
  const key = baseKey(event);
  if (key === undefined) return undefined;
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (mac && event.ctrlKey) parts.push('ctrl');
  if (!mac && event.metaKey) parts.push('meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

const ORDER = ['mod', 'ctrl', 'meta', 'alt', 'shift'];

/** A chord written by hand, in the one order chordOf writes it: "Shift+Mod+P" → "mod+shift+p". */
export function normalizeChord(chord: string): string {
  const parts = chord
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const key = parts.filter((part) => !ORDER.includes(part)).at(-1) ?? '';
  const modifiers = ORDER.filter((modifier) => parts.includes(modifier));
  return [...modifiers, key].join('+');
}

/** A binding's chords: "mod+k mod+s" → ["mod+k", "mod+s"]; "" → []. */
export function parseBinding(binding: string): string[] {
  return binding
    .trim()
    .split(/\s+/)
    .filter((chord) => chord !== '')
    .map(normalizeChord);
}

/** Whether a chord leaves the keys alone while typing (it has no Ctrl, ⌘ or Alt). */
export function isPlainChord(chord: string): boolean {
  const parts = chord.split('+');
  return !parts.some(
    (part) => part === 'mod' || part === 'ctrl' || part === 'meta' || part === 'alt',
  );
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
};

const PC_NAMES: Readonly<Record<string, string>> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
};

const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: '↵',
  escape: 'Esc',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  insert: 'Ins',
  space: 'Space',
};

/**
 * The keys of a binding as key caps, chord by chord: [["⌘", "K"], ["⌘", "S"]] on macOS,
 * [["Ctrl", "K"], ["Ctrl", "S"]] elsewhere.
 */
export function keyCaps(binding: string, mac: boolean): string[][] {
  return parseBinding(binding).map((chord) =>
    chord.split('+').map((part) => {
      const modifier = (mac ? MAC_SYMBOLS : PC_NAMES)[part];
      if (modifier !== undefined) return modifier;
      return KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part.toUpperCase());
    }),
  );
}

/** A binding as text: "⌘K ⌘S", "Ctrl+K Ctrl+S". */
export function bindingLabel(binding: string, mac: boolean): string {
  return keyCaps(binding, mac)
    .map((caps) => caps.join(mac ? '' : '+'))
    .join(' ');
}
