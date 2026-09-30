import { JoineryError } from '@joinery/core';
import type { UpdateStatus } from '@joinery/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { menuTemplate } from '../src/main/menu';
import { NO_POLICY, type UpdateFeed } from '../src/main/update-policy';
import {
  AppCommands,
  UpdateController,
  subscriptionStream,
  updateErrorMessage,
  updateHandlers,
  type UpdateEnvironment,
  type UpdaterEvents,
  type UpdaterFactory,
} from '../src/main/updates';

/**
 * The update controller (spec §20) over a fake updater: automatic and requested checks, the
 * download to "ready, restart", errors, channels and the policy, and the main contract's
 * handlers. No network, no Electron.
 */

const FEED: UpdateFeed = { owner: 'vksargsyan', repo: 'joinery', publisherNames: ['Joinery Ltd'] };
const ON: UpdateEnvironment = {
  availability: { enabled: true },
  policy: NO_POLICY,
  feed: FEED,
  install: 'nsis',
};

/** An updater whose check runs `script` against the controller's event handlers. */
function fakeUpdater(
  script: (events: UpdaterEvents) => Promise<void> | void = (e) => e.notAvailable(),
) {
  const fake = {
    configured: [] as { channel: string; allowPrerelease: boolean }[],
    checks: 0,
    installs: 0,
    created: 0,
    events: undefined as UpdaterEvents | undefined,
    script,
  };
  const factory: UpdaterFactory = async (events) => {
    fake.created++;
    fake.events = events;
    return {
      configure: (options) => fake.configured.push({ ...options }),
      check: async () => {
        fake.checks++;
        await fake.script(events);
      },
      quitAndInstall: () => {
        fake.installs++;
      },
    };
  };
  return { fake, factory };
}

function controller(options: {
  environment?: UpdateEnvironment;
  factory: UpdaterFactory;
  autoCheck?: boolean;
  channel?: 'stable' | 'beta';
}) {
  const statuses: UpdateStatus[] = [];
  const updates = new UpdateController({
    currentVersion: '1.0.0',
    settings: {
      updateChannel: options.channel ?? 'stable',
      updateAutoCheck: options.autoCheck ?? true,
    },
    environment: Promise.resolve(options.environment ?? ON),
    createUpdater: options.factory,
    firstCheckDelayMs: 1000,
    checkIntervalMs: 60_000,
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  });
  updates.subscribe((status) => statuses.push(status));
  return { updates, statuses };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateController', () => {
  it('stays off without touching an updater, and answers a requested check with the reason', async () => {
    const { fake, factory } = fakeUpdater();
    const { updates, statuses } = controller({
      factory,
      environment: {
        availability: { enabled: false, reason: 'policy' },
        policy: { disabled: true, sources: ['JOINERY_DISABLE_UPDATES'] },
        install: 'deb',
      },
    });
    await updates.start();
    expect(updates.status()).toMatchObject({
      state: { state: 'off', reason: 'policy' },
      managed: { disabled: true, channel: false },
      requestId: 0,
    });
    expect(updates.status().releaseNotesUrl).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await updates.check();
    expect(fake.created).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ state: { state: 'off' }, requestId: 1 });
  });

  it('checks on its own after start-up and then on an interval', async () => {
    const { fake, factory } = fakeUpdater();
    const { updates } = controller({ factory });
    await updates.start();
    expect(updates.status().state).toEqual({ state: 'idle' });
    expect(fake.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.checks).toBe(1);
    expect(updates.status()).toMatchObject({
      state: { state: 'up-to-date' },
      lastCheckedAt: '2026-09-29T12:00:00.000Z',
      requestId: 0,
      releaseNotesUrl: 'https://github.com/vksargsyan/joinery/releases/tag/v1.0.0',
    });
    expect(fake.configured).toEqual([{ channel: 'latest', allowPrerelease: false }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.checks).toBe(2);
  });

  it('checks only when asked while automatic checks are off, and follows the setting', async () => {
    const { fake, factory } = fakeUpdater();
    const { updates } = controller({ factory, autoCheck: false });
    await updates.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fake.checks).toBe(0);
    await updates.check();
    expect(fake.checks).toBe(1);
    expect(updates.status()).toMatchObject({ state: { state: 'up-to-date' }, requestId: 1 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fake.checks).toBe(1);

    updates.applySettings({ updateChannel: 'stable', updateAutoCheck: true });
    expect(updates.status().autoCheck).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.checks).toBe(2);
    updates.applySettings({ updateChannel: 'stable', updateAutoCheck: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fake.checks).toBe(2);
  });

  it('downloads a new version to "ready" and restarts into it on request', async () => {
    const { fake, factory } = fakeUpdater((events) => {
      events.checking();
      events.available('1.1.0');
      events.progress(42.5);
    });
    const { updates, statuses } = controller({ factory });
    await updates.start();
    await updates.check();
    expect(updates.status()).toMatchObject({
      state: { state: 'downloading', version: '1.1.0', percent: 42.5 },
      releaseNotesUrl: 'https://github.com/vksargsyan/joinery/releases/tag/v1.1.0',
      requestId: 1,
    });
    expect(() => updates.install()).toThrow(JoineryError);

    fake.events?.progress(150);
    expect(updates.status().state).toMatchObject({ percent: 100 });
    fake.events?.downloaded('1.1.0');
    expect(updates.status().state).toEqual({
      state: 'ready',
      version: '1.1.0',
      installsOnQuit: true,
    });
    expect(statuses.map((s) => s.state.state)).toContain('checking');

    // Nothing more to check once an update waits; a request is answered with "ready".
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await updates.check();
    expect(fake.checks).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ state: { state: 'ready' }, requestId: 2 });
    // A late error does not hide the ready update.
    fake.events?.error(new Error('late'));
    expect(updates.status().state.state).toBe('ready');

    updates.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.installs).toBe(1);
  });

  it('reports a failed check in one line and tries again later', async () => {
    const { fake, factory } = fakeUpdater(() => {
      throw Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack'), {
        code: 'ERR_X',
      });
    });
    const { updates } = controller({ factory });
    await updates.start();
    await updates.check();
    expect(updates.status().state).toEqual({
      state: 'error',
      message: 'net::ERR_INTERNET_DISCONNECTED',
    });
    fake.script = (events) => events.notAvailable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates.status().state).toEqual({ state: 'up-to-date' });
  });

  it('keeps checking after a download fails', async () => {
    const { fake, factory } = fakeUpdater((events) => events.available('1.1.0'));
    const { updates } = controller({ factory });
    await updates.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.status().state).toMatchObject({ state: 'downloading' });
    fake.events?.error(new Error('sha512 checksum mismatch'));
    expect(updates.status().state).toEqual({
      state: 'error',
      message: 'sha512 checksum mismatch',
    });
    fake.script = (events) => events.notAvailable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.checks).toBe(2);
    expect(updates.status().state).toEqual({ state: 'up-to-date' });
  });

  it('uses the chosen channel unless a policy pins one', async () => {
    const { fake, factory } = fakeUpdater();
    const { updates } = controller({ factory, channel: 'beta', autoCheck: false });
    await updates.start();
    expect(updates.status().channel).toBe('beta');
    await updates.check();
    expect(fake.configured.at(-1)).toEqual({ channel: 'beta', allowPrerelease: true });
    updates.applySettings({ updateChannel: 'stable', updateAutoCheck: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.configured.at(-1)).toEqual({ channel: 'latest', allowPrerelease: false });

    const pinned = fakeUpdater();
    const managed = controller({
      factory: pinned.factory,
      channel: 'beta',
      autoCheck: false,
      environment: { ...ON, policy: { disabled: false, channel: 'stable', sources: ['p'] } },
    });
    await managed.updates.start();
    expect(managed.updates.status()).toMatchObject({
      channel: 'stable',
      managed: { disabled: false, channel: true },
    });
    await managed.updates.check();
    expect(pinned.fake.configured).toEqual([{ channel: 'latest', allowPrerelease: false }]);
  });

  it('stops scheduling when disposed', async () => {
    const { fake, factory } = fakeUpdater();
    const { updates } = controller({ factory });
    await updates.start();
    updates.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fake.checks).toBe(0);
  });
});

describe('updateErrorMessage', () => {
  it('turns updater errors into one short line', () => {
    expect(updateErrorMessage(new Error('No published versions on GitHub'))).toBe(
      'No release was found on the update server',
    );
    expect(
      updateErrorMessage(
        Object.assign(new Error('x'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }),
      ),
    ).toBe('The latest release has no update for this platform yet');
    expect(updateErrorMessage(new Error(`${'a'.repeat(400)}\n<xml/>`))).toHaveLength(300);
    expect(updateErrorMessage(new Error(''))).toBe('The update check failed');
    expect(updateErrorMessage('plain')).toBe('plain');
  });
});

describe('streams and handlers', () => {
  it('streams initial values, then pushed ones, until aborted', async () => {
    vi.useRealTimers();
    const commands = new AppCommands();
    const abort = new AbortController();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const value of subscriptionStream(
        (listener) => commands.subscribe(listener),
        abort.signal,
        [{ command: 'about' as const }],
      )) {
        seen.push(value.command);
        if (seen.length === 2) abort.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    commands.send('about');
    await reading;
    expect(seen).toEqual(['about', 'about']);
  });

  it('serves the status and requests of the main contract', async () => {
    vi.useRealTimers();
    const off = updateHandlers(undefined, () => '2.0.0');
    const abort = new AbortController();
    const stream = off.status(undefined, {
      signal: abort.signal,
    } as never) as AsyncGenerator<UpdateStatus>;
    const first = await stream.next();
    expect(first.value).toMatchObject({
      currentVersion: '2.0.0',
      state: { state: 'off', reason: 'development' },
    });
    abort.abort();
    await stream.return(undefined);
    await off.check(undefined, {} as never);
    expect(() => off.install(undefined, {} as never)).toThrow(JoineryError);

    const { fake, factory } = fakeUpdater();
    const { updates } = controller({ factory, autoCheck: false });
    await updates.start();
    const on = updateHandlers(updates, () => '1.0.0');
    await on.check(undefined, {} as never);
    expect(fake.checks).toBe(1);
  });
});

describe('the menu', () => {
  it('adds About, Check for Updates and Release Notes when given commands', () => {
    const clicks: string[] = [];
    const commands = {
      about: () => clicks.push('about'),
      checkForUpdates: () => clicks.push('check'),
      releaseNotes: () => clicks.push('notes'),
    };
    const labels = (template: ReturnType<typeof menuTemplate>) =>
      template.flatMap((menu) =>
        Array.isArray(menu.submenu) ? menu.submenu.map((item) => item.label ?? item.role) : [],
      );
    const windows = menuTemplate({
      platform: 'win32',
      appName: 'Joinery',
      development: false,
      commands,
    });
    expect(labels(windows)).toEqual(
      expect.arrayContaining(['Release Notes', 'Check for Updates…', 'About Joinery']),
    );
    const mac = menuTemplate({
      platform: 'darwin',
      appName: 'Joinery',
      development: false,
      commands,
    });
    const appMenu = mac[0]?.submenu;
    expect(Array.isArray(appMenu) && appMenu.slice(0, 2).map((item) => item.label)).toEqual([
      'About Joinery',
      'Check for Updates…',
    ]);
    for (const template of [windows, mac]) {
      for (const menu of template) {
        if (!Array.isArray(menu.submenu)) continue;
        for (const item of menu.submenu) {
          (item.click as (() => void) | undefined)?.();
        }
      }
    }
    expect(clicks.sort()).toEqual(['about', 'about', 'check', 'check', 'notes', 'notes']);
    expect(
      labels(menuTemplate({ platform: 'linux', appName: 'Joinery', development: false })),
    ).not.toContain('About Joinery');
  });
});
