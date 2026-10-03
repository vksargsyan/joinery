import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RedisSession } from '@querybara/driver-redis';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connectRedis } from './redis';

/**
 * The Redis configuration editor end to end (spec §15, "CONFIG GET and SET"): the grouped,
 * searchable parameter list with secrets masked, typed editors with validation, the pending
 * changes with the exact CONFIG SET before Apply, the change taking effect on the server and
 * being restored through the editor, the confirmation before CONFIG REWRITE, and the
 * explanation an ACL user without CONFIG gets. Only harmless parameters change (the eviction
 * policy with no memory limit, the LFU factor), and the originals are restored in any case.
 */

const REDIS_URL = process.env['QUERYBARA_TEST_REDIS_URL'];
const REDIS_ACL_USER = process.env['QUERYBARA_TEST_REDIS_ACL_USER'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E Redis Config';
const ACL_NAME = 'E2E Redis Config ACL';

test.skip(!REDIS_URL, 'Set QUERYBARA_TEST_REDIS_URL to run the Redis end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let redis: RedisSession | undefined;
const original: Record<string, string> = {};

async function serverValue(name: string): Promise<string> {
  return (await redis!.configGet(name)).values[name] ?? '';
}

test.beforeAll(async () => {
  redis = await connectRedis(REDIS_URL!);
  for (const name of ['maxmemory-policy', 'lfu-log-factor'])
    original[name] = await serverValue(name);
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  if (redis) {
    try {
      await redis.configApply(Object.entries(original).map(([name, value]) => ({ name, value })));
    } finally {
      await redis.close();
    }
  }
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function profileItem(name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function treeRow(scope: Locator, text: string): Locator {
  return scope.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function panel(): Locator {
  return page.getByTestId('redis-config').filter({ visible: true });
}

function row(name: string): Locator {
  return panel().locator(`[data-testid="config-row"][data-name="${name}"]`);
}

async function addConnection(name: string, url: string): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = profileItem(name);
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
}

async function openConfiguration(name: string): Promise<void> {
  const item = profileItem(name);
  const tool = treeRow(item, 'Configuration');
  if (!(await tool.isVisible())) await treeRow(item, 'Tools').click();
  await tool.click();
  await expect(panel()).toBeVisible();
}

async function search(text: string): Promise<void> {
  await panel().getByLabel('Search parameters').fill(text);
}

test('lists the parameters by group, with secrets masked', async () => {
  await addConnection(NAME, REDIS_URL!);
  await openConfiguration(NAME);
  await expect(panel().getByTestId('config-summary')).toContainText('parameters');
  await expect(panel().getByRole('rowgroup', { name: 'Memory and eviction' })).toBeVisible();
  await search('maxmemory-policy');
  await expect(row('maxmemory-policy')).toBeVisible();
  await expect(panel().getByLabel('maxmemory-policy', { exact: true })).toHaveValue(
    original['maxmemory-policy']!,
  );
  await expect(row('maxmemory-policy')).toContainText('noeviction');
  // The password is never shown: only whether it is set, and a field to replace it.
  await search('requirepass');
  await expect(row('requirepass').getByTestId('secret-state')).toHaveText('•••••••• (set)');
  const password = panel().getByLabel('requirepass', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveValue('');
  // Parameters read at startup have no editor.
  await search('databases');
  await expect(row('databases')).toContainText('startup only');
  await expect(panel().getByLabel('databases', { exact: true })).toHaveCount(0);
  await shot('redis-config');
});

test('validates, previews and applies changes, then restores them', async () => {
  const factor = Number(original['lfu-log-factor']);
  await search('maxmemory-policy');
  await panel().getByLabel('maxmemory-policy', { exact: true }).selectOption('allkeys-lfu');
  const pending = panel().getByTestId('config-pending');
  await expect(pending.getByTestId('pending-change')).toHaveCount(1);

  await search('lfu-log-factor');
  const lfu = panel().getByLabel('lfu-log-factor', { exact: true });
  await lfu.fill('many');
  await expect(row('lfu-log-factor')).toContainText('Must be a whole number');
  await expect(pending.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await lfu.fill(String(factor + 1));
  await expect(pending.getByTestId('config-command')).toHaveText(
    `CONFIG SET lfu-log-factor ${factor + 1} maxmemory-policy allkeys-lfu`,
  );
  await expect(pending).toContainText('all or none');
  await shot('redis-config-pending');
  await pending.getByRole('button', { name: 'Apply' }).click();
  await expect(panel().getByTestId('config-result')).toHaveText(
    'Applied lfu-log-factor, maxmemory-policy.',
  );
  await expect(pending).toBeHidden();
  expect(await serverValue('maxmemory-policy')).toBe('allkeys-lfu');
  expect(await serverValue('lfu-log-factor')).toBe(String(factor + 1));
  await panel().getByRole('button', { name: 'Dismiss' }).click();
  await expect(panel().getByTestId('config-result')).toBeHidden();

  // The list shows the new values, marked as changed from the default.
  await panel().getByLabel('Show').selectOption('changed');
  await search('maxmemory-policy');
  await expect(row('maxmemory-policy')).toContainText('changed');
  await expect(panel().getByLabel('maxmemory-policy', { exact: true })).toHaveValue('allkeys-lfu');
  await panel().getByLabel('Show').selectOption('all');

  // Restore both through the editor.
  await panel()
    .getByLabel('maxmemory-policy', { exact: true })
    .selectOption(original['maxmemory-policy']!);
  await search('lfu-log-factor');
  await panel().getByLabel('lfu-log-factor', { exact: true }).fill(String(factor));
  await expect(pending.getByTestId('config-command')).toHaveText(
    `CONFIG SET lfu-log-factor ${factor} maxmemory-policy ${original['maxmemory-policy']}`,
  );
  await pending.getByRole('button', { name: 'Apply' }).click();
  await expect(panel().getByTestId('config-result')).toHaveText(
    'Applied lfu-log-factor, maxmemory-policy.',
  );
  expect(await serverValue('maxmemory-policy')).toBe(original['maxmemory-policy']);
  expect(await serverValue('lfu-log-factor')).toBe(String(factor));
  await panel().getByRole('button', { name: 'Dismiss' }).click();
});

test('shows the exact command and asks before rewriting the configuration file', async () => {
  await panel().getByRole('button', { name: 'Rewrite config file…' }).click();
  const confirm = page.getByRole('alertdialog').last();
  await expect(confirm).toContainText('rewrites the configuration file on disk');
  await expect(confirm.getByTestId('confirm-detail')).toHaveText('CONFIG REWRITE');
  // Declined: the shared test server's file stays as it is.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(panel().getByTestId('config-result')).toBeHidden();

  await panel().getByRole('button', { name: 'Reset statistics…' }).click();
  const reset = page.getByRole('alertdialog').last();
  await expect(reset.getByTestId('confirm-detail')).toHaveText('CONFIG RESETSTAT');
  await reset.getByRole('button', { name: 'Cancel' }).click();
  await expect(reset).toBeHidden();
});

test('explains why an ACL user without CONFIG cannot see the configuration', async () => {
  test.skip(!REDIS_ACL_USER, 'Set QUERYBARA_TEST_REDIS_ACL_USER for the ACL case');
  const [user, password] = REDIS_ACL_USER!.split(':') as [string, string];
  const url = new URL(REDIS_URL!);
  url.username = user;
  url.password = password;
  await addConnection(ACL_NAME, url.toString());
  await openConfiguration(ACL_NAME);
  const unavailable = panel().getByTestId('config-unavailable');
  await expect(unavailable).toContainText('Not allowed to read the configuration');
  await expect(unavailable).toContainText('may not run CONFIG GET');
  await expect(unavailable).toContainText('+config|get');
  await shot('redis-config-acl');
});
