import { useSyncExternalStore } from 'react';

import { useSettings } from '../state/data';

const query = window.matchMedia('(prefers-color-scheme: light)');

function subscribe(callback: () => void): () => void {
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

/**
 * The effective theme: the setting, with "system" following the OS. Dark is the default
 * (the desktop's stored default); high contrast uses the dark palette for now.
 */
export function useTheme(): 'dark' | 'light' {
  const setting = useSettings().data?.theme ?? 'dark';
  const systemLight = useSyncExternalStore(subscribe, () => query.matches);
  if (setting === 'light') return 'light';
  if (setting === 'system') return systemLight ? 'light' : 'dark';
  return 'dark';
}
