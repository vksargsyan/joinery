import { expect, test, type Locator, type Page } from '@playwright/test';

import { startSshServer, type TestSshServer } from '../test/ssh-server';
import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { withoutTls } from './mongo-db';

/**
 * A MongoDB replica set and a Redis Cluster through an SSH tunnel, end to end (ADR 0008): an
 * in-process SSH server in the test process forwards every connection the app opens to the test
 * servers. Test Connection reports the SSH step and then the topology's own steps; connecting
 * discovers the replica set or the cluster through the tunnel and the tree shows what it found.
 */

const MONGO_URL = process.env['JOINERY_TEST_MONGODB_URL'];
const REDIS_URL = process.env['JOINERY_TEST_REDIS_URL'];
const REDIS_CLUSTER = process.env['JOINERY_TEST_REDIS_CLUSTER'];
const SSH_USER = 'tunnel';
const SSH_PASSWORD = 'e2e-Bastion-nodes';

test.skip(!MONGO_URL && !REDIS_CLUSTER, 'Set the MongoDB or Redis Cluster test server variables');

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

function field(dialog: Locator, label: string): Locator {
  return dialog.getByLabel(label, { exact: true });
}

function treeRow(scope: Locator, text: string): Locator {
  return scope.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

/** Turns the SSH tunnel on, through the test server, with the password kept for this session. */
async function throughSsh(dialog: Locator): Promise<void> {
  await dialog.getByLabel('Connect through an SSH tunnel').check();
  await field(dialog, 'SSH host').fill('127.0.0.1');
  await field(dialog, 'SSH port').fill(String(ssh.port));
  await field(dialog, 'SSH user').fill(SSH_USER);
  await field(dialog, 'SSH password').fill(SSH_PASSWORD);
  await field(dialog, 'SSH password storage').selectOption('session');
}

/** Runs Test Connection, trusting the SSH server's key the first time it is asked. */
async function testConnection(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  const prompt = page.getByRole('dialog', { name: 'Trust this SSH server?' });
  const succeeded = dialog.getByText('Connection succeeded');
  await expect(prompt.or(succeeded)).toBeVisible();
  if (await prompt.isVisible()) {
    await prompt.getByRole('button', { name: 'Trust and remember' }).click();
  }
  await expect(succeeded).toBeVisible();
  await expect(dialog.getByTestId('check-ssh')).toContainText('every server through the tunnel');
}

test('connects to a MongoDB replica set through SSH', async () => {
  test.skip(!MONGO_URL, 'Set JOINERY_TEST_MONGODB_URL');
  const name = 'E2E replica set via SSH';
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(withoutTls(MONGO_URL!));
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(field(dialog, 'Connect with')).toHaveValue('hosts');
  await field(dialog, 'Name').fill(name);
  await field(dialog, 'Password storage').selectOption('session');
  await throughSsh(dialog);

  await testConnection(dialog);
  await expect(dialog.getByTestId('check-version')).toContainText('replica set rs0');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const forwards = ssh.stats.forwards;
  const profile = page.getByRole('treeitem', { name, exact: true });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await expect(treeRow(profile, 'admin')).toBeVisible();
  expect(ssh.stats.forwards).toBeGreaterThan(forwards);
});

test('connects to a Redis Cluster through SSH', async () => {
  test.skip(!REDIS_CLUSTER || !REDIS_URL, 'Set JOINERY_TEST_REDIS_CLUSTER and _URL');
  const name = 'E2E cluster via SSH';
  const seeds = REDIS_CLUSTER!.split(',').map((seed) => seed.trim());
  const [host, port] = seeds[0]!.split(':') as [string, string];
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await field(dialog, 'Name').fill(name);
  await field(dialog, 'Database engine').selectOption('redis');
  await field(dialog, 'Connect with').selectOption('cluster');
  await field(dialog, 'Seed 1').fill(host);
  await field(dialog, 'Seed 1 port').fill(port);
  await field(dialog, 'Authentication').selectOption('password');
  await field(dialog, 'Password').fill(decodeURIComponent(new URL(REDIS_URL!).password));
  await field(dialog, 'Password storage').selectOption('session');
  await field(dialog, 'TLS').selectOption('disable');
  await throughSsh(dialog);

  await testConnection(dialog);
  await expect(dialog.getByTestId('check-version')).toContainText(
    `cluster of ${seeds.length} primaries`,
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const forwards = ssh.stats.forwards;
  const profile = page.getByRole('treeitem', { name, exact: true });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  // Every primary, by the address it announces (reached through the tunnel's forwards).
  for (const seed of seeds) await expect(treeRow(profile, seed)).toBeVisible();
  expect(ssh.stats.forwards).toBeGreaterThan(forwards);
});
