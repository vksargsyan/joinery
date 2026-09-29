import type { MenuItemConstructorOptions } from 'electron';

/**
 * The application menu: standard roles only (the Edit roles make copy and paste work on macOS).
 * Reload and developer tools exist only in development builds.
 */
export function menuTemplate(options: {
  readonly platform: string;
  readonly appName: string;
  readonly development: boolean;
}): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: options.appName,
      submenu: [
        { role: 'about' },
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
      : [{ role: 'minimize' }, { role: 'close' }],
  });
  return template;
}
