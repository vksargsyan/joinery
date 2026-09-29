import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';

/**
 * The connection dialog for MongoDB and Redis (spec §4), with no server: the engine picker, the
 * endpoint forms and sign-ins, what the dialog refuses and why, URI paste, and saved profiles
 * opened again for editing. Connecting is covered by the engines' own specs.
 */

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

async function newConnection(): Promise<Locator> {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function edit(name: string): Promise<Locator> {
  const item = page.getByRole('treeitem', { name });
  await item.locator('[data-tree-row]').first().hover();
  await item.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

function field(dialog: Locator, label: string): Locator {
  return dialog.getByLabel(label, { exact: true });
}

test('offers MongoDB and Redis on their ports; Elasticsearch and OpenSearch are coming', async () => {
  const dialog = await newConnection();
  const engine = field(dialog, 'Database engine');
  await expect(engine.locator('option[value="mongodb"]')).toBeEnabled();
  await expect(engine.locator('option[value="redis"]')).toBeEnabled();
  await expect(engine.locator('option[value="elasticsearch"]')).toBeDisabled();
  await expect(engine.locator('option[value="opensearch"]')).toBeDisabled();

  await engine.selectOption('mongodb');
  await expect(field(dialog, 'Port')).toHaveValue('27017');
  await expect(field(dialog, 'Connect with').locator('option')).toHaveText([
    'Host and port',
    'Host list (replica set)',
    'SRV record (mongodb+srv)',
    'Connection URI',
  ]);
  await engine.selectOption('redis');
  await expect(field(dialog, 'Port')).toHaveValue('6379');
  await expect(field(dialog, 'Connect with').locator('option')).toHaveText([
    'Host and port',
    'Unix socket',
    'Sentinel',
    'Cluster',
    'Connection URI',
  ]);
  await engine.selectOption('postgres');
  await expect(field(dialog, 'Port')).toHaveValue('5432');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('fills a MongoDB replica set from a URI, keeps it off tunnels, saves and edits it', async () => {
  const dialog = await newConnection();
  await field(dialog, 'Paste a URI to fill the form').fill(
    'mongodb://app:e2e-M0ngo@db1.example.com:27017,db2.example.com:27018/sales?replicaSet=rs0&authSource=admin&tls=true',
  );
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(field(dialog, 'Database engine')).toHaveValue('mongodb');
  await expect(field(dialog, 'Connect with')).toHaveValue('hosts');
  await expect(field(dialog, 'Host 1')).toHaveValue('db1.example.com');
  await expect(field(dialog, 'Host 2')).toHaveValue('db2.example.com');
  await expect(field(dialog, 'Host 2 port')).toHaveValue('27018');
  await expect(field(dialog, 'Replica set')).toHaveValue('rs0');
  await expect(field(dialog, 'Default database')).toHaveValue('sales');
  await expect(field(dialog, 'Authentication')).toHaveValue('password');
  await expect(field(dialog, 'Authentication database')).toHaveValue('admin');
  await expect(field(dialog, 'User')).toHaveValue('app');
  await expect(field(dialog, 'Password')).toHaveValue('e2e-M0ngo');

  // A host list cannot go through an SSH tunnel: the dialog explains and refuses to save.
  await dialog.getByLabel('Connect through an SSH tunnel').check();
  await expect(dialog.getByText(/connects directly to one MongoDB host/)).toBeVisible();
  await field(dialog, 'SSH host').fill('bastion.example.com');
  await field(dialog, 'SSH user').fill('ops');
  await field(dialog, 'SSH password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    dialog.getByRole('alert').filter({ hasText: 'A host list or SRV record cannot go through' }),
  ).toBeVisible();
  await dialog.getByLabel('Connect through an SSH tunnel').uncheck();

  await field(dialog, 'Name').fill('E2E Mongo');
  await field(dialog, 'Read preference').selectOption('secondaryPreferred');
  await field(dialog, 'Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('treeitem', { name: 'E2E Mongo' })).toBeVisible();

  const again = await edit('E2E Mongo');
  await expect(field(again, 'Connect with')).toHaveValue('hosts');
  await expect(field(again, 'Host 1')).toHaveValue('db1.example.com');
  await expect(field(again, 'Host 2 port')).toHaveValue('27018');
  await expect(field(again, 'Replica set')).toHaveValue('rs0');
  await expect(field(again, 'Authentication database')).toHaveValue('admin');
  await expect(field(again, 'Read preference')).toHaveValue('secondaryPreferred');
  await expect(field(again, 'TLS')).toHaveValue('verify-full');
  // The password went to main and does not come back.
  await expect(field(again, 'Password')).toHaveValue('');
  await expect(again.getByText('Leave empty to keep the stored password')).toBeVisible();
  await again.getByRole('button', { name: 'Cancel' }).click();
});

test('turns TLS on for SRV and asks X.509 for TLS, a certificate and a key', async () => {
  const dialog = await newConnection();
  await field(dialog, 'Name').fill('E2E Atlas');
  await field(dialog, 'Database engine').selectOption('mongodb');
  await field(dialog, 'TLS').selectOption('disable');
  await field(dialog, 'Connect with').selectOption('srv');
  await expect(field(dialog, 'TLS')).toHaveValue('verify-full');
  await expect(dialog.getByText(/An SRV record \(mongodb\+srv\) implies TLS/)).toBeVisible();
  await field(dialog, 'SRV host name').fill('cluster0.example.net');

  await field(dialog, 'Authentication').selectOption('clientCertificate');
  await field(dialog, 'TLS').selectOption('disable');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(field(dialog, 'TLS')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('X.509 authentication needs TLS')).toBeVisible();
  await field(dialog, 'TLS').selectOption('verify-full');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Choose the client certificate')).toBeVisible();
  await field(dialog, 'Client certificate').fill('/certs/app.pem');
  await field(dialog, 'Client key').fill('/certs/app.pem');

  await field(dialog, 'Authentication').selectOption('password');
  await field(dialog, 'User').fill('ldap-user');
  await field(dialog, 'Mechanism').selectOption('PLAIN');
  await expect(field(dialog, 'Authentication database')).toHaveValue('$external');
  await expect(field(dialog, 'Authentication database')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('saves a Redis Sentinel connection, keeps it off proxies, and edits it', async () => {
  const dialog = await newConnection();
  await field(dialog, 'Name').fill('E2E Redis');
  await field(dialog, 'Database engine').selectOption('redis');
  await field(dialog, 'Connect with').selectOption('sentinel');
  await expect(dialog.getByText(/Sentinel connections cannot go through/)).toBeVisible();
  await field(dialog, 'Sentinel 1').fill('s1.example.com');
  await dialog.getByRole('button', { name: 'Add sentinel' }).click();
  await field(dialog, 'Sentinel 2').fill('s2.example.com');
  await field(dialog, 'Sentinel 2 port').fill('26380');
  await field(dialog, 'Master name').fill('mymaster');
  await field(dialog, 'Database number').fill('16x');
  await field(dialog, 'Key delimiter').fill('|');
  await field(dialog, 'Authentication').selectOption('password');
  await field(dialog, 'User').fill('app');
  await field(dialog, 'Password').fill('e2e-R3dis');
  await field(dialog, 'Password storage').selectOption('session');
  await field(dialog, 'TLS').selectOption('disable');
  await field(dialog, 'Proxy').selectOption('socks5');
  await field(dialog, 'Proxy host').fill('proxy.example.com');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    dialog.getByRole('alert').filter({ hasText: 'Sentinel and Cluster cannot go through' }),
  ).toBeVisible();
  await expect(
    dialog.getByText('Enter a database number (0 to 15 on a default server)'),
  ).toBeVisible();

  await field(dialog, 'Proxy').selectOption('none');
  await field(dialog, 'Database number').fill('3');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const again = await edit('E2E Redis');
  await expect(field(again, 'Connect with')).toHaveValue('sentinel');
  await expect(field(again, 'Sentinel 1')).toHaveValue('s1.example.com');
  await expect(field(again, 'Sentinel 2 port')).toHaveValue('26380');
  await expect(field(again, 'Master name')).toHaveValue('mymaster');
  await expect(field(again, 'Database number')).toHaveValue('3');
  await expect(field(again, 'Key delimiter')).toHaveValue('|');
  await expect(field(again, 'User')).toHaveValue('app');
  await expect(field(again, 'Password')).toHaveValue('');
  // Each endpoint form has its own inputs: the master name does not turn into the port.
  for (let round = 0; round < 2; round++) {
    await field(again, 'Connect with').selectOption('host');
    await expect(field(again, 'Host')).toHaveValue('localhost');
    await expect(field(again, 'Port')).toHaveValue('6379');
    await field(again, 'Connect with').selectOption('sentinel');
    await expect(field(again, 'Master name')).toHaveValue('mymaster');
  }
  // A cluster has no database number.
  await field(again, 'Connect with').selectOption('cluster');
  await expect(field(again, 'Database number')).toHaveCount(0);
  await expect(field(again, 'Seed 1')).toBeVisible();
  await again.getByRole('button', { name: 'Cancel' }).click();
});

test('fills a rediss:// URI with the database from its path', async () => {
  const dialog = await newConnection();
  await field(dialog, 'Paste a URI to fill the form').fill(
    'rediss://app:e2e-p%40ss@cache.example.com:6380/2',
  );
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(field(dialog, 'Database engine')).toHaveValue('redis');
  await expect(field(dialog, 'Connect with')).toHaveValue('host');
  await expect(field(dialog, 'Host')).toHaveValue('cache.example.com');
  await expect(field(dialog, 'Port')).toHaveValue('6380');
  await expect(field(dialog, 'Database number')).toHaveValue('2');
  await expect(field(dialog, 'TLS')).toHaveValue('verify-full');
  await expect(field(dialog, 'Authentication')).toHaveValue('password');
  await expect(field(dialog, 'Password')).toHaveValue('e2e-p@ss');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
