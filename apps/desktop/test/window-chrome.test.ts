import { describe, expect, it } from 'vitest';

import {
  TITLE_BAR_HEIGHT,
  effectiveTheme,
  titleBarOverlay,
  windowChrome,
} from '../src/main/window-chrome';
import { BISQUE, TENMOKU } from '../src/renderer/src/lib/kiln';

/**
 * The window's chrome, drawn by the page as VS Code does: the native title bar hidden, the
 * macOS traffic lights inset into the page's 35px bar, the Windows and Linux controls overlaid
 * on it in Kiln's chrome colours for the theme in force.
 */

describe('the window chrome', () => {
  it('insets the traffic lights on macOS and overlays the controls elsewhere', () => {
    expect(windowChrome('darwin', 'dark')).toEqual({
      titleBarStyle: 'hidden',
      backgroundColor: TENMOKU.bgDeep,
      trafficLightPosition: { x: 12, y: 12 },
    });
    expect(windowChrome('win32', 'light')).toEqual({
      titleBarStyle: 'hidden',
      backgroundColor: BISQUE.bgDeep,
      titleBarOverlay: { color: BISQUE.bgDeep, symbolColor: BISQUE.muted, height: 35 },
    });
    expect(titleBarOverlay('dark')).toEqual({
      color: TENMOKU.bgDeep,
      symbolColor: TENMOKU.muted,
      height: TITLE_BAR_HEIGHT,
    });
  });

  it('follows the theme the page draws, "system" by the OS', () => {
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
    expect(effectiveTheme('high-contrast', false)).toBe('dark');
    expect(effectiveTheme('system', true)).toBe('dark');
    expect(effectiveTheme('system', false)).toBe('light');
  });
});
