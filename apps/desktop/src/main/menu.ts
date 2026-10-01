import type { MenuItemConstructorOptions } from 'electron';

/** What the app's own menu items do (spec §20: About with the licence report, updates). */
export interface MenuCommands {
  readonly about: () => void;
  readonly checkForUpdates: () => void;
  readonly releaseNotes: () => void;
  /** The page's command palette, Go to Object and Keyboard Shortcuts (the page holds the keys). */
  readonly commandPalette?: () => void;
  readonly quickOpen?: () => void;
  readonly keyboardShortcuts?: () => void;
}

/**
 * The application menu: standard roles (the Edit roles make copy and paste work on macOS), and
 * with `commands` the About box and Check for Updates, in the app menu on macOS and under Help
 * elsewhere. Reload and developer tools exist only in development builds.
 */
export function menuTemplate(options: {
  readonly platform: string;
  readonly appName: string;
  readonly development: boolean;
  readonly commands?: MenuCommands;
}): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const commands = options.commands;
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: options.appName,
      submenu: [
        commands ? { label: `About ${options.appName}`, click: commands.about } : { role: 'about' },
        ...(commands
          ? ([
              { label: 'Check for Updates…', click: commands.checkForUpdates },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  } else {
    template.push({ label: 'File', submenu: [{ role: 'quit' }] });
  }
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });
  template.push({
    label: 'View',
    submenu: [
      ...(commands?.commandPalette && commands.quickOpen
        ? ([
            { label: 'Command Palette…', click: commands.commandPalette },
            { label: 'Go to Table or Collection…', click: commands.quickOpen },
            ...(commands.keyboardShortcuts
              ? ([
                  { label: 'Keyboard Shortcuts', click: commands.keyboardShortcuts },
                ] satisfies MenuItemConstructorOptions[])
              : []),
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      ...(options.development
        ? ([
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });
  template.push({
    label: 'Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : // Ctrl+W closes the tab (the page's key binding), as in VS Code.
        [{ role: 'minimize' }, { role: 'close', accelerator: 'Ctrl+Shift+W' }],
  });
  if (commands) {
    template.push({
      role: 'help',
      submenu: [
        { label: 'Release Notes', click: commands.releaseNotes },
        ...(mac
          ? []
          : ([
              { label: 'Check for Updates…', click: commands.checkForUpdates },
              { type: 'separator' },
              { label: `About ${options.appName}`, click: commands.about },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    });
  }
  return template;
}
