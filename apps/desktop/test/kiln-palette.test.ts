import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BISQUE, TENMOKU, withAlpha, type KilnPalette } from '../src/renderer/src/lib/kiln';

/**
 * The Kiln design system's colours live twice: as `--k-*` properties in styles.css for the DOM,
 * and in lib/kiln.ts for Monaco and the data grids, which draw on a canvas. They must agree.
 */

const css = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/styles.css'), 'utf8');

/** The `--k-*` properties declared in the rule whose selector starts as given. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return new Map([...body.matchAll(/--k-([a-z-]+):\s*(#[0-9a-f]+);/g)].map((m) => [m[1]!, m[2]!]));
}

const camel = (name: string): string =>
  name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

function asPalette(values: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...values].map(([name, value]) => [camel(name), value]));
}

describe('the Kiln palette', () => {
  it('is the same in styles.css and lib/kiln.ts, in both themes', () => {
    const tenmoku = asPalette(block(":root[data-theme='dark']"));
    const bisque = asPalette(block(":root[data-theme='light']"));
    expect(tenmoku).toEqual({ ...TENMOKU });
    expect(bisque).toEqual({ ...BISQUE });
    expect(Object.keys(tenmoku)).toEqual(Object.keys(bisque));
  });

  it('keeps each theme to Kiln Tenmoku and Bisque values', () => {
    const pick = (p: KilnPalette) => [p.bg, p.bgDeep, p.fg, p.rust, p.onAccent];
    expect(pick(TENMOKU)).toEqual(['#161412', '#110f0e', '#e6ded0', '#e8906a', '#1a1310']);
    expect(pick(BISQUE)).toEqual(['#f6f1e7', '#eee7da', '#2b2620', '#aa4924', '#fff8f0']);
  });

  it('writes a colour with an alpha as #rrggbbaa', () => {
    expect(withAlpha('#e8906a', 0.26)).toBe('#e8906a42');
    expect(withAlpha('#e8906a99', 1)).toBe('#e8906aff');
    expect(withAlpha('#000000', 0)).toBe('#00000000');
  });
});
