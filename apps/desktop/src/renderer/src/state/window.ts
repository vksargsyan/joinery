import { create } from 'zustand';

/**
 * The window as the title bar needs it: the platform (macOS insets its traffic lights into the
 * bar) and whether the window is in full screen, where macOS hides them.
 */
export interface WindowState {
  readonly platform: string;
  readonly fullScreen: boolean;
}

export const useWindowState = create<WindowState>(() => ({
  // Tests import this outside a page.
  platform: typeof window === 'undefined' ? 'darwin' : (window.querybara?.platform ?? 'darwin'),
  fullScreen: false,
}));

export function setFullScreen(fullScreen: boolean): void {
  useWindowState.setState({ fullScreen });
}
