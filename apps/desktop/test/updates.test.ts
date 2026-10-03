import { QuerybaraError } from '@querybara/core';
import type { AppCommand, UpdateStatus } from '@querybara/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { menuTemplate } from '../src/main/menu';
import { windowMenus } from '../src/shared/window-menu';
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

const FEED: UpdateFeed = {
  owner: 'vksargsyan',
  repo: 'querybara',
  publisherNames: ['Querybara Ltd'],
};
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
        policy: { disabled: true, sources: ['QUERYBARA_DISABLE_UPDATES'] },
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
      releaseNotesUrl: 'https://github.com/vksargsyan/querybara/releases/tag/v1.0.0',
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
      releaseNotesUrl: 'https://github.com/vksargsyan/querybara/releases/tag/v1.1.0',
      requestId: 1,
    });
    expect(() => updates.install()).toThrow(QuerybaraError);

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
    // A repository with no production release, as a release's first smoke test sees it: the
    // provider wraps the "latest version" error in a feed error with another code.
    const wrapped = Object.assign(
      new Error(
        'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/vksargsyan/querybara/releases/latest), please ensure a production release exists: HttpError: 406 \n    at GitHubProvider.getLatestTagName,\nXML:\n<feed/>',
      ),
      { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' },
    );
    expect(updateErrorMessage(wrapped)).toBe('No release was found on the update server');
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
        [{ command: 'about' } as AppCommand],
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
    expect(() => off.install(undefined, {} as never)).toThrow(QuerybaraError);

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
      appName: 'Querybara',
      development: false,
      commands,
    });
    expect(labels(windows)).toEqual(
      expect.arrayContaining(['Release Notes', 'Check for Updates…', 'About Querybara']),
    );
    const mac = menuTemplate({
      platform: 'darwin',
      appName: 'Querybara',
      development: false,
      commands,
    });
    const appMenu = mac[0]?.submenu;
    expect(Array.isArray(appMenu) && appMenu.slice(0, 2).map((item) => item.label)).toEqual([
      'About Querybara',
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
      labels(menuTemplate({ platform: 'linux', appName: 'Querybara', development: false })),
    ).not.toContain('About Querybara');
  });
});

describe('the window menu bar (Windows, Linux)', () => {
  it('holds the items of the native menu, run in main or opened by the page', () => {
    const ROLE_COMMANDS: Record<string, string> = { togglefullscreen: 'toggleFullScreen' };
    for (const platform of ['win32', 'linux']) {
      for (const development of [false, true]) {
        const native = menuTemplate({
          platform,
          appName: 'Querybara',
          development,
          commands: {
            about: () => {},
            checkForUpdates: () => {},
            releaseNotes: () => {},
            commandPalette: () => {},
            quickOpen: () => {},
            keyboardShortcuts: () => {},
          },
        });
        const page = windowMenus({ platform, appName: 'Querybara', development });
        expect(page.map((m) => m.label)).toEqual(native.map((m) => m.label ?? 'Help'));
        native.forEach((menu, i) => {
          const items = (menu.submenu as Electron.MenuItemConstructorOptions[]).map((item) =>
            item.type === 'separator'
              ? 'separator'
              : item.role !== undefined
                ? (ROLE_COMMANDS[item.role] ?? item.role)
                : item.label,
          );
          expect(
            page[i]!.items.map((item) =>
              item === 'separator'
                ? 'separator'
                : [
                      'checkForUpdates',
                      'releaseNotes',
                      'about',
                      'command-palette',
                      'quick-open',
                      'keyboard-shortcuts',
                    ].includes(item.command)
                  ? item.label
                  : item.command,
            ),
          ).toEqual(items);
        });
      }
    }
  });
});
