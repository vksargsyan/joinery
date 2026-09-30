import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';

/**
 * The About box and the update notice (spec §20), with no server: the version and runtime, the
 * update preferences saved as settings, the menu's About and Check for Updates items, and the
 * third-party licences the build wrote. A development run never updates, and says so.
 */

test.describe.configure({ mode: 'serial' });

/** The app's version, so a release's version bump does not change the test. */
const VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
  }
).version;

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

/** Clicks an item of the native application menu by its label, as a user would. */
async function clickMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate(({ Menu }, wanted) => {
    const items = (Menu.getApplicationMenu()?.items ?? []).flatMap(
      (menu) => menu.submenu?.items ?? [],
    );
    const item = items.find((candidate) => candidate.label === wanted);
    if (!item) throw new Error(`No menu item ${wanted}`);
    item.click();
  }, label);
}

test('shows the version, runtime and why a development run does not update', async () => {
  await page.getByRole('button', { name: 'About Joinery' }).click();
  const dialog = page.getByRole('dialog', { name: 'About Joinery' });
  await expect(dialog.getByTestId('about-version')).toHaveText(`Version ${VERSION}`);
  await expect(dialog.getByText(/Electron \d+.*Chromium .*Node\.js/)).toBeVisible();
  await expect(dialog.getByTestId('update-status')).toHaveText(
    'Updates are off in development runs.',
  );
  await expect(dialog.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
});

test('saves the update channel and automatic checks as settings', async () => {
  const dialog = page.getByRole('dialog', { name: 'About Joinery' });
  const channel = dialog.getByLabel('Update channel');
  await expect(channel).toHaveValue('stable');
  await channel.selectOption('beta');
  await expect(channel).toHaveValue('beta');
  const auto = dialog.getByLabel('Check for updates automatically');
  await expect(auto).toBeChecked();
  await auto.click();
  await expect(auto).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // The menu's About item opens the same box, which reads the saved preferences back.
  await clickMenuItem(launched.app, 'About Joinery');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Update channel')).toHaveValue('beta');
  await expect(dialog.getByLabel('Check for updates automatically')).not.toBeChecked();
  await dialog.getByLabel('Update channel').selectOption('stable');
  await dialog.getByLabel('Check for updates automatically').click();
  await expect(dialog.getByLabel('Check for updates automatically')).toBeChecked();
});

test('lists the third-party licences the build shipped', async () => {
  const dialog = page.getByRole('dialog', { name: 'About Joinery' });
  await dialog.getByRole('tab', { name: 'Third-party licences' }).click();
  const packages = dialog.getByRole('list', { name: 'Third-party packages' });
  await expect(packages.getByText('react', { exact: true })).toBeVisible();
  await dialog.getByLabel('Filter packages').fill('Apache-2.0');
  await expect(packages.getByText('react', { exact: true })).toBeHidden();
  const mongodb = packages
    .getByRole('listitem')
    .filter({ has: page.getByText('mongodb', { exact: true }) });
  await mongodb.getByText('mongodb', { exact: true }).click();
  await expect(mongodb.getByText(/Apache License/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('answers Check for Updates from the menu in a quiet notice', async () => {
  await clickMenuItem(launched.app, 'Check for Updates…');
  const notice = page.getByTestId('update-notice');
  await expect(notice).toHaveText(/Updates are off in development runs\./);
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toBeHidden();
});
