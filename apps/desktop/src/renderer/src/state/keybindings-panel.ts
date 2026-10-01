import { newId } from '@joinery/core';

import { currentDock } from '../components/dock';
import { panelWithKey, registerPanel, unregisterPanel } from './panels';

/** The Keyboard Shortcuts editor's tab (components/KeybindingsPanel.tsx): one at a time. */

const PANEL_KEY = 'keybindings';

export function openKeybindingsPanel(): void {
  const open = panelWithKey(PANEL_KEY);
  if (open) {
    currentDock()?.getPanel(open.id)?.api.setActive();
    return;
  }
  const id = newId();
  registerPanel({
    id,
    kind: 'keybindings',
    profileId: '',
    title: 'Keyboard Shortcuts',
    key: PANEL_KEY,
  });
  currentDock()?.addPanel({
    id,
    component: 'keybindings',
    tabComponent: 'panelTab',
    title: 'Keyboard Shortcuts',
    params: { panelId: id },
  });
}

export function disposeKeybindingsPanel(panelId: string): void {
  unregisterPanel(panelId);
}
