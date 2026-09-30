import type { UpdateState, UpdateStatus } from '@joinery/ipc';
import { updateStatusSchema } from '@joinery/ipc';
import { describe, expect, it } from 'vitest';

import {
  dismissNotice,
  noticeFor,
  offReasonText,
  statusText,
  useUpdates,
} from '../src/renderer/src/state/updates';

/**
 * The page's side of auto-update (spec §20): the notice speaks up for a ready update and for
 * checks the user asked for, never for background checks; the About box's status line.
 */

function status(state: UpdateState, requestId = 0): UpdateStatus {
  return updateStatusSchema.parse({
    currentVersion: '1.0.0',
    channel: 'stable',
    autoCheck: true,
    managed: { disabled: false, channel: false },
    state,
    releaseNotesUrl: 'https://github.com/vksargsyan/joinery/releases/tag/v1.1.0',
    requestId,
  });
}

describe('noticeFor', () => {
  it('offers a ready update until it is put off', () => {
    const ready = status({ state: 'ready', version: '1.1.0', installsOnQuit: true });
    expect(noticeFor(ready, 0, undefined)).toEqual({
      kind: 'ready',
      version: '1.1.0',
      installsOnQuit: true,
    });
    expect(noticeFor(ready, 0, '1.1.0')).toBeUndefined();
    const deb = status({ state: 'ready', version: '1.2.0', installsOnQuit: false });
    expect(noticeFor(deb, 0, '1.1.0')).toEqual({
      kind: 'ready',
      version: '1.2.0',
      installsOnQuit: false,
    });
  });

  it('keeps background checks quiet', () => {
    for (const state of [
      { state: 'checking' },
      { state: 'up-to-date' },
      { state: 'error', message: 'offline' },
      { state: 'downloading', version: '1.1.0', percent: 10 },
    ] as UpdateState[]) {
      expect(noticeFor(status(state, 3), 3, undefined)).toBeUndefined();
    }
    expect(noticeFor(undefined, 0, undefined)).toBeUndefined();
  });

  it('answers a check the user asked for', () => {
    expect(noticeFor(status({ state: 'checking' }, 1), 0, undefined)).toEqual({
      kind: 'busy',
      text: 'Checking for updates…',
    });
    expect(
      noticeFor(status({ state: 'downloading', version: '1.1.0', percent: 41.6 }, 1), 0, undefined),
    ).toEqual({ kind: 'busy', text: 'Downloading Joinery 1.1.0… 42 %' });
    expect(noticeFor(status({ state: 'up-to-date' }, 1), 0, undefined)).toEqual({
      kind: 'answer',
      tone: 'info',
      text: 'Joinery 1.0.0 is up to date.',
    });
    expect(noticeFor(status({ state: 'error', message: 'offline' }, 1), 0, undefined)).toEqual({
      kind: 'answer',
      tone: 'error',
      text: 'Could not check for updates: offline',
    });
    expect(noticeFor(status({ state: 'off', reason: 'policy' }, 2), 1, undefined)).toEqual({
      kind: 'answer',
      tone: 'info',
      text: 'Updates are turned off by your administrator.',
    });
    expect(noticeFor(status({ state: 'idle' }, 2), 1, undefined)).toBeUndefined();
  });
});

describe('status text', () => {
  it('explains every reason updates are off', () => {
    for (const reason of [
      'development',
      'test-build',
      'policy',
      'unsigned',
      'unsupported-install',
    ] as const) {
      expect(offReasonText(reason)).toMatch(/\.$/);
    }
    expect(statusText(status({ state: 'off', reason: 'test-build' }))).toContain('test build');
  });

  it('describes the idle states by the automatic-check setting', () => {
    expect(statusText(status({ state: 'idle' }))).toBe('Joinery checks for updates automatically.');
    expect(statusText({ ...status({ state: 'idle' }), autoCheck: false })).toBe(
      'Automatic checks are off.',
    );
    expect(statusText(status({ state: 'ready', version: '2.0.0', installsOnQuit: true }))).toBe(
      'Joinery 2.0.0 is ready. Restart to install it.',
    );
  });
});

describe('dismissNotice', () => {
  it('marks the current answer seen and puts off a ready version', () => {
    useUpdates.setState({ status: status({ state: 'up-to-date' }, 4), seenRequestId: 2 });
    dismissNotice();
    expect(useUpdates.getState()).toMatchObject({ seenRequestId: 4, dismissedVersion: undefined });
    useUpdates.setState({
      status: status({ state: 'ready', version: '1.1.0', installsOnQuit: true }, 4),
    });
    dismissNotice();
    expect(useUpdates.getState().dismissedVersion).toBe('1.1.0');
  });
});
