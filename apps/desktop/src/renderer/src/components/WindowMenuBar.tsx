import { Menubar } from 'radix-ui';

import { mainApi } from '../lib/main-client';
import { openAbout } from '../state/updates';
import type { WindowMenuCommand } from '@joinery/ipc';

import { bindingLabel } from '../lib/keys';
import { useBindingOf } from '../state/keybindings';
import { openKeybindingsPanel } from '../state/keybindings-panel';
import { openPalette } from '../state/palette';
import { windowMenus, type PageMenuCommand } from '../../../shared/window-menu';

/**
 * The window's menu bar on Windows and Linux, in the title bar as VS Code draws it: the native
 * menu bar hides with the native title bar there. The same items as the native menu
 * (shared/window-menu.ts); each runs in main, except About, which opens here. Kiln's floating
 * surface, a rust wash on the highlighted item, the accelerator right-aligned in `faint`.
 */

const PAGE_BINDINGS: Readonly<Partial<Record<PageMenuCommand, string>>> = {
  'command-palette': 'workbench.commandPalette',
  'quick-open': 'workbench.quickOpen',
  'keyboard-shortcuts': 'workbench.keyboardShortcuts',
};

function runMenuItem(command: WindowMenuCommand | PageMenuCommand): void {
  if (command === 'about') openAbout();
  else if (command === 'command-palette') openPalette('>');
  else if (command === 'quick-open') openPalette('');
  else if (command === 'keyboard-shortcuts') openKeybindingsPanel();
  else void mainApi().app.menu({ command });
}

/** The item's keys: the page's own binding for its commands (the user may change them). */
function MenuShortcut(props: {
  readonly command: WindowMenuCommand | PageMenuCommand;
  readonly shortcut: string | undefined;
}) {
  const binding = useBindingOf(PAGE_BINDINGS[props.command as PageMenuCommand] ?? 'none');
  const text = binding !== undefined ? bindingLabel(binding, false) : props.shortcut;
  return text === undefined ? null : <span className="text-xs text-faint">{text}</span>;
}

export function WindowMenuBar(props: { readonly platform: string }) {
  const menus = windowMenus({
    platform: props.platform,
    appName: 'Joinery',
    development: import.meta.env.DEV,
  });
  return (
    <Menubar.Root
      aria-label="Application menu"
      className="flex items-center [-webkit-app-region:no-drag]"
    >
      {menus.map((menu) => (
        <Menubar.Menu key={menu.label}>
          <Menubar.Trigger className="h-[22px] rounded-sm px-2 text-[13px] text-muted outline-none hover:bg-hover hover:text-fg data-[highlighted]:bg-hover data-[state=open]:bg-pressed data-[state=open]:text-fg">
            {menu.label}
          </Menubar.Trigger>
          <Menubar.Portal>
            <Menubar.Content
              align="start"
              sideOffset={4}
              className="z-50 min-w-56 rounded-md border border-border bg-raised p-1 text-[13px] text-fg shadow-widget"
            >
              {menu.items.map((item, index) =>
                item === 'separator' ? (
                  <Menubar.Separator key={`separator-${index}`} className="my-1 h-px bg-border" />
                ) : (
                  <Menubar.Item
                    key={item.label}
                    onSelect={() => {
                      runMenuItem(item.command);
                    }}
                    className="flex cursor-default items-center gap-6 rounded-sm px-2 py-1 outline-none data-[highlighted]:bg-list-active"
                  >
                    <span className="flex-1">{item.label}</span>
                    <MenuShortcut command={item.command} shortcut={item.shortcut} />
                  </Menubar.Item>
                ),
              )}
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      ))}
    </Menubar.Root>
  );
}
