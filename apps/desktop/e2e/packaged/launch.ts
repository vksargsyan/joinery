import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

/** The packaged executable under test, from JOINERY_PACKAGED_APP. */
export const EXECUTABLE = process.env['JOINERY_PACKAGED_APP'];

export interface PackagedApp {
  readonly page: Page;
  close(): Promise<void>;
}

/**
 * Starts the packaged app with a throwaway user data directory and returns its window. Its fuses
 * turn off the Node inspector that Playwright's Electron launcher attaches to, so the app is
 * started directly and driven through the renderer's DevTools port.
 */
export async function launchPackaged(executable: string): Promise<PackagedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'joinery-packaged-'));
  const args = ['--remote-debugging-port=0'];
  // Chromium refuses to start its sandbox as root (a CI or dev container); see e2e/app.ts.
  if (process.getuid?.() === 0 || process.env['JOINERY_E2E_NO_SANDBOX'] === '1') {
    args.push('--no-sandbox');
  }
  const child = spawn(executable, args, {
    env: { ...process.env, JOINERY_USER_DATA_DIR: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  const stop = async (): Promise<void> => {
    if (running()) {
      child.kill();
      await exited;
    }
    rmSync(userData, { recursive: true, force: true });
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error(`No DevTools endpoint within 60 s:\n${output}`)),
        60_000,
      );
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`The app exited (${code ?? signal}) before it was ready:\n${output}`));
      });
    });
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('The app has no browser context');
    const page =
      context.pages().find((open) => open.url().startsWith('app://')) ??
      (await context.waitForEvent('page'));
    return {
      page,
      async close() {
        // Quit the way a user does, so the app and its launcher clean up (an AppImage run with
        // APPIMAGE_EXTRACT_AND_RUN removes its extracted copy only then); kill it if it hangs.
        // The command gets no answer: the connection goes away with the app.
        const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
        void cdp?.send('Browser.close').catch(() => undefined);
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
        await browser.close().catch(() => undefined);
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
