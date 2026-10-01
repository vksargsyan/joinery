import { describe, expect, it } from 'vitest';

import { fuzzyMatch } from '../src/renderer/src/lib/fuzzy';
import {
  bindingLabel,
  chordOf,
  isPlainChord,
  keyCaps,
  normalizeChord,
  parseBinding,
} from '../src/renderer/src/lib/keys';
import {
  DEFAULT_KEYBINDINGS,
  conflicts,
  effectiveBindings,
} from '../src/renderer/src/state/keybindings';

/** Key chords, fuzzy matching and the bindings the palette and the window use (VS Code's). */

const key = (
  code: string,
  keyName: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({
  code,
  key: keyName,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('chords', () => {
  it('reads ⌘ as mod on macOS and Ctrl as mod elsewhere', () => {
    expect(chordOf(key('KeyP', 'P', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+p');
    expect(chordOf(key('KeyP', 'p', { ctrlKey: true }), false)).toBe('mod+p');
    expect(chordOf(key('Tab', 'Tab', { ctrlKey: true }), true)).toBe('ctrl+tab');
  });

  it('reads letters, digits and punctuation by position, named keys by name', () => {
    expect(chordOf(key('Digit1', '!', { shiftKey: true }), true)).toBe('shift+1');
    expect(chordOf(key('BracketLeft', '{', { metaKey: true, shiftKey: true }), true)).toBe(
      'mod+shift+[',
    );
    expect(chordOf(key('F5', 'F5'), true)).toBe('f5');
    expect(chordOf(key('ArrowDown', 'ArrowDown'), true)).toBe('down');
    expect(chordOf(key('ShiftLeft', 'Shift', { shiftKey: true }), true)).toBeUndefined();
  });

  it('writes chords in one order, and splits sequences', () => {
    expect(normalizeChord('Shift+Mod+P')).toBe('mod+shift+p');
    expect(parseBinding('mod+k  mod+s')).toEqual(['mod+k', 'mod+s']);
    expect(parseBinding('')).toEqual([]);
    expect(isPlainChord('f5')).toBe(true);
    expect(isPlainChord('shift+f5')).toBe(true);
    expect(isPlainChord('mod+p')).toBe(false);
  });

  it('shows key caps as each platform writes them', () => {
    expect(keyCaps('mod+k mod+s', true)).toEqual([
      ['⌘', 'K'],
      ['⌘', 'S'],
    ]);
    expect(bindingLabel('mod+shift+p', true)).toBe('⌘⇧P');
    expect(bindingLabel('mod+shift+p', false)).toBe('Ctrl+Shift+P');
    expect(bindingLabel('ctrl+shift+tab', true)).toBe('⌃⇧Tab');
  });
});

describe('fuzzyMatch', () => {
  it('matches characters in order, ignoring case and spaces', () => {
    expect(fuzzyMatch('create tab', 'Table: Create Table…')?.indices).toEqual([
      7, 8, 9, 10, 11, 12, 14, 15, 16,
    ]);
    expect(fuzzyMatch('xyz', 'Table: Create Table…')).toBeUndefined();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('prefers word starts and runs over scattered characters', () => {
    const words = fuzzyMatch('mt', 'manager_teams')!;
    expect(words.indices).toEqual([0, 8]);
    const run = fuzzyMatch('ord', 'orders')!.score;
    const scattered = fuzzyMatch('ord', 'old_reports_d')!.score;
    expect(run).toBeGreaterThan(scattered);
  });
});

describe('bindings', () => {
  it('puts the user’s bindings over the defaults, "" for none', () => {
    const bindings = effectiveBindings([
      { command: 'query.new', key: 'mod+alt+n' },
      { command: 'workbench.toggleTheme', key: '' },
    ]);
    expect(bindings.get('query.new')).toBe('mod+alt+n');
    expect(bindings.get('workbench.toggleTheme')).toBe('');
    expect(bindings.get('workbench.quickOpen')).toBe(DEFAULT_KEYBINDINGS['workbench.quickOpen']);
  });

  it('finds commands that share a binding', () => {
    const bindings = effectiveBindings([{ command: 'query.history', key: 'mod+t' }]);
    expect(conflicts(bindings).get('mod+t')).toEqual(['query.new', 'query.history']);
    expect(conflicts(effectiveBindings([])).size).toBe(0);
  });
});
