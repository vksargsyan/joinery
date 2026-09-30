import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startSshServer, type TestSshServer } from '../test/ssh-server';
import { connectionTab, launchApp, openNewConnection, type LaunchedApp } from './app';

/**
 * An SSH tunnel end to end (spec §4): an in-process SSH server in the test process forwards to
 * the PostgreSQL test server. The connection asks about the server's host key, the answer is
 * remembered in known_hosts, queries run through the tunnel, and reconnecting (after a
 * disconnect, and after the tunnel drops) does not ask again. A changed host key is a blocking
 * warning that only lets the user remove the remembered key.
 */

const PG_URL = process.env['JOINERY_TEST_POSTGRES_URL'];
const NAME = 'E2E Postgres via SSH';
const SSH_USER = 'tunnel';
const SSH_PASSWORD = 'e2e-Bastion-pw';

test.skip(!PG_URL, 'Set JOINERY_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let ssh: TestSshServer;
let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  ssh = await startSshServer({ user: SSH_USER, password: SSH_PASSWORD });
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await ssh?.close();
});

async function runQuery(sql: string): Promise<void> {
  const editor = page.getByTestId('sql-editor').last();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(sql);
  await page.keyboard.press('ControlOrMeta+Enter');
}

function hostKeyPrompt() {
  return page.getByRole('dialog', { name: 'Trust this SSH server?' });
}

test('asks about the host key, runs a query through the tunnel and reconnects without asking', async () => {
  // Create the connection: the database as the SSH server sees it, plus the tunnel.
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(PG_URL!);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  // Main parses the URI asynchronously; typing before it answers races the fill.
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await connectionTab(dialog, 'SSH');
  await dialog.getByLabel('Connect through an SSH tunnel').check();
  await dialog.getByLabel('SSH host').fill('127.0.0.1');
  await dialog.getByLabel('SSH port').fill(String(ssh.port));
  await dialog.getByLabel('SSH user').fill(SSH_USER);
  await dialog.getByLabel('SSH password', { exact: true }).fill(SSH_PASSWORD);
  await dialog.getByLabel('SSH password storage').selectOption('session');

  // Test Connection asks about the unknown host key; trusting it once does not remember it.
  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  await expect(hostKeyPrompt()).toBeVisible();
  await expect(hostKeyPrompt().getByTestId('host-key-fingerprint')).toContainText(
    ssh.hostKeyFingerprint,
  );
  await hostKeyPrompt().getByRole('button', { name: 'Trust once' }).click();
  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await expect(dialog.getByTestId('check-ssh')).toContainText(`127.0.0.1:${ssh.port}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // Connecting asks again; this time the key is trusted and remembered.
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(hostKeyPrompt()).toBeVisible();
  await hostKeyPrompt().getByRole('button', { name: 'Trust and remember' }).click();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
  expect(readFileSync(join(userData, 'known_hosts'), 'utf8')).toContain(
    `[127.0.0.1]:${ssh.port} ssh-ed25519 ${ssh.hostKeyFingerprint}`,
  );

  await page.getByRole('button', { name: 'New query' }).click();
  await expect(page.getByTestId('query-panel')).toBeVisible();
  await runQuery('select generate_series(1, 3) as n');
  await expect(page.getByTestId('row-count')).toHaveText('3 rows');
  const forwardsBefore = ssh.stats.forwards;
  expect(forwardsBefore).toBeGreaterThan(0);

  // Disconnect and connect again: no question this time.
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(profile.getByText('Not connected', { exact: true })).toBeAttached();
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await expect(hostKeyPrompt()).toHaveCount(0);

  // The tunnel drops: the host restarts and reopens it on its own, again without asking.
  const connectionsBefore = ssh.stats.connections;
  ssh.dropAll();
  const banner = page.getByTestId('connection-lost');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('restarted');
  expect(ssh.stats.connections).toBeGreaterThan(connectionsBefore);
  await banner.getByRole('button', { name: 'Reconnect' }).click();
  await expect(banner).toBeHidden();
  await runQuery('select 42 as answer');
  await expect(page.getByTestId('row-count')).toHaveText('1 row');
  await expect(hostKeyPrompt()).toHaveCount(0);
  expect(ssh.stats.forwards).toBeGreaterThan(forwardsBefore);
});

test('warns about a changed host key and trusts the new one only after the old one is removed', async () => {
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(profile.getByText('Not connected', { exact: true })).toBeAttached();

  // Pretend Joinery remembered another key for this server.
  const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
  const knownHosts = join(userData, 'known_hosts');
  const remembered = 'SHA256:rememberedKeyrememberedKeyrememberedKey01';
  writeFileSync(knownHosts, `[127.0.0.1]:${ssh.port} ssh-ed25519 ${remembered}\n`);

  const warning = page.getByRole('alertdialog', { name: 'Warning: the SSH host key has changed' });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('man-in-the-middle');
  await expect(warning).toContainText(remembered);
  await expect(warning.getByTestId('host-key-fingerprint')).toContainText(ssh.hostKeyFingerprint);
  // No trust button: only removing the remembered key, after confirming it with the admin.
  await expect(warning.getByRole('button', { name: /trust/i })).toHaveCount(0);
  await expect(warning.getByRole('button', { name: 'Remove the remembered key' })).toBeDisabled();
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(profile.getByText(/has CHANGED/)).toBeVisible();
  expect(readFileSync(knownHosts, 'utf8')).toContain(remembered);

  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(warning).toBeVisible();
  await warning.getByLabel('The administrator confirmed that the host key changed').check();
  await warning.getByRole('button', { name: 'Remove the remembered key' }).click();
  await expect(hostKeyPrompt()).toBeVisible();
  await hostKeyPrompt().getByRole('button', { name: 'Trust and remember' }).click();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  const now = readFileSync(knownHosts, 'utf8');
  expect(now).toContain(ssh.hostKeyFingerprint);
  expect(now).not.toContain(remembered);
});
