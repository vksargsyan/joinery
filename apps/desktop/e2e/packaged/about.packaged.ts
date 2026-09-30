import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { EXECUTABLE, launchPackaged, type PackagedApp } from './launch';

/**
 * The About box of the packaged app (spec §20): the version, the updater's status and the
 * licence report the build wrote into the archive. JOINERY_EXPECT_UPDATE_STATUS names text the
 * status must contain: a test build says so, and JOINERY_DISABLE_UPDATES=1 makes it the
 * administrator's policy. With JOINERY_E2E_UPDATE_CHECK=1 (release builds whose updates are on)
 * it also checks for updates against GitHub, which loads electron-updater from the archive and
 * must end in an answer from the release feed.
 */

const EXPECTED_STATUS = process.env['JOINERY_EXPECT_UPDATE_STATUS'];
const UPDATE_CHECK = process.env['JOINERY_E2E_UPDATE_CHECK'] === '1';
const VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    version: string;
  }
).version;

test.skip(!EXECUTABLE, 'Set JOINERY_PACKAGED_APP to the packaged executable');

let app: PackagedApp | undefined;

test.afterAll(async () => {
  await app?.close();
});

test('shows the version, the update status and the third-party licences', async () => {
  app = await launchPackaged(EXECUTABLE!);
  const { page } = app;

  // About lives in the application menu: on Windows and Linux the window's own menu bar; on
  // macOS the native one, which a test driving the page cannot reach, so the #about link.
  const dialog = page.getByRole('dialog', { name: 'About Joinery' });
  if (process.platform === 'darwin') {
    await page.evaluate(() => {
      location.hash = 'about';
    });
  } else {
    await page.getByRole('menubar', { name: 'Application menu' }).getByText('Help').click();
    await page.getByRole('menuitem', { name: 'About Joinery' }).click();
  }
  await expect(dialog.getByTestId('about-version')).toHaveText(`Version ${VERSION}`);
  const status = dialog.getByTestId('update-status');
  await expect(status).not.toBeEmpty();
  await expect(status).not.toContainText('Reading');
  if (EXPECTED_STATUS) await expect(status).toContainText(EXPECTED_STATUS);

  if (UPDATE_CHECK) {
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    // Any answer the feed can give: nothing newer, no published release yet, or an update.
    await expect(status).toHaveText(
      /is up to date|No release was found|has no update for this platform|Downloading|is ready/,
      { timeout: 60_000 },
    );
  }

  await dialog.getByRole('tab', { name: 'Third-party licences' }).click();
  const packages = dialog.getByRole('list', { name: 'Third-party packages' });
  await expect(packages.getByText('electron-updater', { exact: true })).toBeVisible();
  await dialog.getByLabel('Filter packages').fill('electron-updater');
  await packages.getByText('electron-updater', { exact: true }).click();
  await expect(packages.getByText(/Permission is hereby granted/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
