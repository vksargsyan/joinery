import type { UpdateChannel, UpdateStatus, UpdatesOffReason } from '@joinery/ipc';
import { create } from 'zustand';

import { mainApi } from '../lib/main-client';
import { keys, queryClient } from './data';
import { setFullScreen } from './window';

/**
 * Auto-update in the page (spec §20): main's updater status, the About box (which also holds
 * the update preferences and the third-party licences), and the notice. The notice is quiet by
 * design: it offers a restart once an update is ready, and otherwise speaks only to answer a
 * check the user asked for.
 */

interface UpdatesState {
  readonly status: UpdateStatus | undefined;
  readonly aboutOpen: boolean;
  /** The last user-requested check whose answer was shown and put away. */
  readonly seenRequestId: number;
  /** The ready version whose notice the user put off with "Later". */
  readonly dismissedVersion: string | undefined;
}

export const useUpdates = create<UpdatesState>()(() => ({
  status: undefined,
  aboutOpen: false,
  seenRequestId: 0,
  dismissedVersion: undefined,
}));

/** Why updates are off, in the user's words. */
export function offReasonText(reason: UpdatesOffReason): string {
  switch (reason) {
    case 'development':
      return 'Updates are off in development runs.';
    case 'test-build':
      return 'This is a test build, which does not update itself. Install a release to get updates.';
    case 'policy':
      return 'Updates are turned off by your administrator.';
    case 'unsigned':
      return 'This build is not code-signed, so it does not update itself.';
    case 'unsupported-install':
      return 'This installation (MSI, zip or unpacked folder) is updated by installing the new version, not by Joinery.';
  }
}

/** One line for the About box: where the updater stands. */
export function statusText(status: UpdateStatus): string {
  const { state } = status;
  switch (state.state) {
    case 'off':
      return offReasonText(state.reason);
    case 'idle':
      return status.autoCheck
        ? 'Joinery checks for updates automatically.'
        : 'Automatic checks are off.';
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return `Joinery ${status.currentVersion} is up to date.`;
    case 'downloading':
      return `Downloading Joinery ${state.version}… ${Math.round(state.percent)} %`;
    case 'ready':
      return `Joinery ${state.version} is ready. Restart to install it.`;
    case 'error':
      return `The last check failed: ${state.message}`;
  }
}

export type UpdateNotice =
  | { readonly kind: 'ready'; readonly version: string; readonly installsOnQuit: boolean }
  | { readonly kind: 'busy'; readonly text: string }
  | { readonly kind: 'answer'; readonly text: string; readonly tone: 'info' | 'error' };

/**
 * What the notice shows: a ready update (until put off), or the progress and answer of a check
 * the user asked for. Background checks show nothing until an update is ready.
 */
export function noticeFor(
  status: UpdateStatus | undefined,
  seenRequestId: number,
  dismissedVersion: string | undefined,
): UpdateNotice | undefined {
  if (!status) return undefined;
  const { state } = status;
  if (state.state === 'ready') {
    return state.version === dismissedVersion
      ? undefined
      : { kind: 'ready', version: state.version, installsOnQuit: state.installsOnQuit };
  }
  if (status.requestId <= seenRequestId) return undefined;
  switch (state.state) {
    case 'checking':
    case 'downloading':
      return { kind: 'busy', text: statusText(status) };
    case 'error':
      return {
        kind: 'answer',
        tone: 'error',
        text: `Could not check for updates: ${state.message}`,
      };
    case 'off':
    case 'up-to-date':
      return { kind: 'answer', tone: 'info', text: statusText(status) };
    case 'idle':
      return undefined;
  }
}

/** Follows main's updater status for the life of the page. */
export async function watchUpdates(): Promise<void> {
  for (;;) {
    try {
      for await (const status of mainApi().updates.status()) {
        // A page that just loaded does not answer checks asked for before it.
        useUpdates.setState((current) => ({
          status,
          seenRequestId: current.status === undefined ? status.requestId : current.seenRequestId,
        }));
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Follows main's commands (the menu's About, full screen) for the life of the page. */
export async function watchAppCommands(): Promise<void> {
  for (;;) {
    try {
      for await (const { command } of mainApi().app.commands()) {
        if (command === 'about') openAbout();
        else setFullScreen(command === 'enter-full-screen');
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function openAbout(open = true): void {
  useUpdates.setState({ aboutOpen: open });
}

/** Puts the notice away: the answer to the current check, or a ready update until next start. */
export function dismissNotice(): void {
  useUpdates.setState((current) => ({
    seenRequestId: current.status?.requestId ?? current.seenRequestId,
    dismissedVersion:
      current.status?.state.state === 'ready'
        ? current.status.state.version
        : current.dismissedVersion,
  }));
}

export async function checkForUpdates(): Promise<void> {
  await mainApi().updates.check();
}

export async function restartToUpdate(): Promise<void> {
  await mainApi().updates.install();
}

/** Saves the channel or the automatic check; main's updater follows the settings. */
export async function setUpdatePreferences(patch: {
  readonly updateChannel?: UpdateChannel;
  readonly updateAutoCheck?: boolean;
}): Promise<void> {
  await mainApi().settings.set(patch);
  await queryClient.invalidateQueries({ queryKey: keys.settings });
}
