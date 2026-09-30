import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron';

/**
 * The window's chrome, as VS Code draws it: no native title bar. The page draws a 35px title
 * bar in the Kiln chrome ground, with the macOS traffic lights inset into it and, on Windows
 * and Linux, the window controls overlaid at its right in the theme's colours. The app's name
 * appears in the application menu, not in the window.
 */

export const TITLE_BAR_HEIGHT = 35;

type Theme = 'dark' | 'light';

/** The theme the page draws, from the setting, as the page resolves it (components/theme.ts). */
export function effectiveTheme(
  setting: 'system' | 'light' | 'dark' | 'high-contrast',
  systemDark: boolean,
): Theme {
  if (setting === 'light') return 'light';
  if (setting === 'system') return systemDark ? 'dark' : 'light';
  return 'dark';
}

/** Kiln's chrome ground and muted ink, per theme (Tenmoku, Bisque). */
const CHROME: Readonly<Record<Theme, { readonly ground: string; readonly ink: string }>> = {
  dark: { ground: '#110f0e', ink: '#a39a8b' },
  light: { ground: '#eee7da', ink: '#6b6255' },
};

/** The Windows and Linux window controls, drawn over the page's title bar. */
export function titleBarOverlay(theme: Theme): TitleBarOverlay {
  return { color: CHROME[theme].ground, symbolColor: CHROME[theme].ink, height: TITLE_BAR_HEIGHT };
}

/** The BrowserWindow options that hide the native title bar. */
export function windowChrome(
  platform: string,
  theme: Theme,
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay' | 'backgroundColor'
> {
  return {
    titleBarStyle: 'hidden',
    backgroundColor: CHROME[theme].ground,
    // The 12px traffic lights centred in the 35px bar, 12px from the edge.
    ...(platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 12 } }
      : { titleBarOverlay: titleBarOverlay(theme) }),
  };
}
