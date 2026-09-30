import type { WindowMenuCommand } from '@joinery/ipc';

/**
 * The window's own menu bar on Windows and Linux. The native menu bar hides with the native
 * title bar there, so the page draws these menus in its title bar, as VS Code does. They hold
 * the same items as the native menu (main/menu.ts, which keeps its accelerators working): each
 * runs in main (`app.menu`), except About, which the page opens itself.
 */

export type WindowMenuItem =
  | {
      readonly label: string;
      readonly command: WindowMenuCommand | 'about';
      /** The accelerator as the native menu shows it. */
      readonly shortcut?: string;
    }
  | 'separator';

export interface WindowMenu {
  readonly label: string;
  readonly items: readonly WindowMenuItem[];
}

export function windowMenus(options: {
  readonly platform: string;
  readonly appName: string;
  readonly development: boolean;
}): WindowMenu[] {
  const windows = options.platform === 'win32';
  return [
    { label: 'File', items: [{ label: windows ? 'Exit' : 'Quit', command: 'quit' }] },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', command: 'undo', shortcut: 'Ctrl+Z' },
        { label: 'Redo', command: 'redo', shortcut: windows ? 'Ctrl+Y' : 'Ctrl+Shift+Z' },
        'separator',
        { label: 'Cut', command: 'cut', shortcut: 'Ctrl+X' },
        { label: 'Copy', command: 'copy', shortcut: 'Ctrl+C' },
        { label: 'Paste', command: 'paste', shortcut: 'Ctrl+V' },
        { label: 'Select All', command: 'selectAll', shortcut: 'Ctrl+A' },
      ],
    },
    {
      label: 'View',
      items: [
        ...(options.development
          ? ([
              { label: 'Reload', command: 'reload', shortcut: 'Ctrl+R' },
              {
                label: 'Toggle Developer Tools',
                command: 'toggleDevTools',
                shortcut: 'Ctrl+Shift+I',
              },
              'separator',
            ] satisfies WindowMenuItem[])
          : []),
        { label: 'Actual Size', command: 'resetZoom', shortcut: 'Ctrl+0' },
        { label: 'Zoom In', command: 'zoomIn', shortcut: 'Ctrl+=' },
        { label: 'Zoom Out', command: 'zoomOut', shortcut: 'Ctrl+-' },
        'separator',
        { label: 'Toggle Full Screen', command: 'toggleFullScreen', shortcut: 'F11' },
      ],
    },
    {
      label: 'Window',
      items: [
        { label: 'Minimize', command: 'minimize' },
        { label: 'Close', command: 'close', shortcut: 'Ctrl+W' },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Release Notes', command: 'releaseNotes' },
        { label: 'Check for Updates…', command: 'checkForUpdates' },
        'separator',
        { label: `About ${options.appName}`, command: 'about' },
      ],
    },
  ];
}
