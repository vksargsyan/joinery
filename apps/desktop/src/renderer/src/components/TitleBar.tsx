import type { ReactNode } from 'react';

import { useWindowState } from '../state/window';
import { SyncMenu } from './sync/SyncMenu';
import { Icon, cx } from './ui';

/**
 * The window's title bar, drawn by the page as VS Code draws its own (the native one is hidden,
 * see main/window-chrome.ts): 35px on the chrome ground, dragging the window. On macOS it leaves
 * room for the traffic lights (not in full screen, where they hide); on Windows and Linux for
 * the window controls overlaid at its right. In the middle, the active tab's title, or on a
 * production connection the red banner naming it; at the right, the window's actions as icons
 * with tooltips. The app's name is in the application menu only, and so is About.
 */

export function TitleBar(props: {
  readonly title: string | undefined;
  readonly production: string | undefined;
  readonly theme: 'dark' | 'light';
  readonly onToggleTheme: () => void;
  readonly onNewQuery: () => void;
  readonly newQueryDisabled: boolean;
  readonly historyOpen: boolean;
  readonly onToggleHistory: () => void;
  readonly onSchedules: () => void;
  readonly jobsOpen: boolean;
  readonly jobsRunning: number;
  readonly onToggleJobs: () => void;
}) {
  const mac = useWindowState((s) => s.platform === 'darwin');
  const fullScreen = useWindowState((s) => s.fullScreen);
  return (
    <header
      className="relative flex h-[35px] shrink-0 items-center border-b border-border bg-panel text-muted select-none [-webkit-app-region:drag]"
      style={{
        paddingLeft: mac && !fullScreen ? 78 : 8,
        // The overlaid window controls (Windows, Linux) take the rest of the bar's width.
        paddingRight:
          'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 6px)',
      }}
      data-testid="title-bar"
    >
      <div className="pointer-events-none absolute inset-x-0 flex justify-center px-[260px]">
        {props.production !== undefined ? (
          <span
            role="status"
            data-testid="production-banner"
            className="truncate rounded-sm bg-env-production px-2 py-0.5 text-[11px] font-bold tracking-wide text-accent-fg uppercase"
          >
            Production · {props.production}
          </span>
        ) : (
          props.title !== undefined && (
            <span className="truncate text-xs" data-testid="window-title">
              {props.title}
            </span>
          )
        )}
      </div>
      <span className="flex-1" />
      <div
        className="relative flex items-center gap-0.5 [-webkit-app-region:no-drag]"
        role="toolbar"
        aria-label="Window"
      >
        <TitleButton
          label="New query"
          icon="plus"
          onClick={props.onNewQuery}
          disabled={props.newQueryDisabled}
        />
        <TitleButton
          label="History"
          icon="history"
          pressed={props.historyOpen}
          onClick={props.onToggleHistory}
        />
        <SyncMenu
          trigger={
            <button type="button" aria-label="Compare" title="Compare" className={BUTTON}>
              <Icon name="compare" />
            </button>
          }
        />
        <TitleButton label="Schedules" icon="schedule" onClick={props.onSchedules} />
        <TitleButton
          label="Jobs"
          icon="jobs"
          pressed={props.jobsOpen}
          onClick={props.onToggleJobs}
          badge={
            props.jobsRunning > 0 ? (
              <span
                className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-accent px-0.5 text-center text-[9px] leading-3.5 font-semibold text-accent-fg"
                aria-label={`${props.jobsRunning} running`}
              >
                {props.jobsRunning}
              </span>
            ) : undefined
          }
        />
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <TitleButton
          label="Switch theme"
          tooltip={props.theme === 'dark' ? 'Switch to Bisque (light)' : 'Switch to Tenmoku (dark)'}
          icon={props.theme === 'dark' ? 'sun' : 'moon'}
          onClick={props.onToggleTheme}
        />
      </div>
    </header>
  );
}

const BUTTON =
  'relative flex h-[22px] w-[26px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg active:bg-pressed disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-pressed aria-pressed:text-fg data-[state=open]:bg-pressed data-[state=open]:text-fg';

function TitleButton(props: {
  readonly label: string;
  readonly tooltip?: string;
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly onClick: () => void;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.tooltip ?? props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(BUTTON)}
    >
      <Icon name={props.icon} />
      {props.badge}
    </button>
  );
}
