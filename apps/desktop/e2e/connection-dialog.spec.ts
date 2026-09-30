import { expect, test, type Locator, type Page } from '@playwright/test';

import { chooseEngine, connectionTab, launchApp, openNewConnection, type LaunchedApp } from './app';

/**
 * The connection dialog (spec §4), with no server: the engine step, the tabbed form with its
 * endpoint forms and sign-ins, what the dialog refuses and why (and on which tab), URI paste, and
 * saved profiles opened again for editing. Connecting is covered by the engines' own specs.
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
  await openNewConnection(page);
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

test('starts with the engine, then offers its endpoints on its port', async () => {
  const dialog = await newConnection();
  const picker = dialog.getByRole('radiogroup', { name: 'Database engine' });
  const card = (name: string) => picker.getByRole('radio', { name, exact: true });
  await expect(picker.getByRole('radio')).toHaveCount(6);
  // With no connection yet, PostgreSQL is picked; the search narrows the cards.
  await expect(card('PostgreSQL')).toHaveAttribute('aria-checked', 'true');
  await dialog.getByLabel('Search engines').fill('key');
  await expect(picker.getByRole('radio')).toHaveCount(1);
  await expect(card('Redis')).toBeVisible();
  await dialog.getByLabel('Search engines').fill('');

  // Elasticsearch and Redis start without sign-in; every engine starts with TLS off.
  await chooseEngine(dialog, 'Elasticsearch');
  await expect(dialog.getByTestId('connection-engine')).toHaveText('Elasticsearch');
  await expect(field(dialog, 'Connect with').locator('option')).toHaveText([
    'Node URLs',
    'Cloud ID (Elastic Cloud)',
  ]);
  await expect(field(dialog, 'Node URL 1')).toHaveValue('http://localhost:9200');
  await expect(field(dialog, 'Authentication')).toHaveValue('none');
  await expect(field(dialog, 'TLS mode')).toHaveValue('disable');

  await dialog.getByRole('button', { name: 'Back' }).click();
  await chooseEngine(dialog, 'MongoDB');
  await expect(field(dialog, 'Port')).toHaveValue('27017');
  await expect(field(dialog, 'Connect with').locator('option')).toHaveText([
    'Host and port',
    'Host list (replica set)',
    'SRV record (mongodb+srv)',
    'Connection URI',
  ]);
  await dialog.getByRole('button', { name: 'Back' }).click();
  await chooseEngine(dialog, 'Redis');
  await expect(field(dialog, 'Port')).toHaveValue('6379');
  await expect(field(dialog, 'Authentication')).toHaveValue('none');
  await expect(field(dialog, 'TLS mode')).toHaveValue('disable');
  await expect(field(dialog, 'Connect with').locator('option')).toHaveText([
    'Host and port',
    'Unix socket',
    'Sentinel',
    'Cluster',
    'Connection URI',
  ]);

  // Back on the first step the picked card has the focus: arrows move, Enter goes on.
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(card('Redis')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(card('MySQL')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('connection-engine')).toHaveText('PostgreSQL');
  await expect(field(dialog, 'Port')).toHaveValue('5432');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('fills a MongoDB replica set from a URI, takes it through SSH, saves and edits it', async () => {
  const dialog = await newConnection();
  await field(dialog, 'Paste a URI to fill the form').fill(
    'mongodb://app:e2e-M0ngo@db1.example.com:27017,db2.example.com:27018/sales?replicaSet=rs0&authSource=admin&tls=true',
  );
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(dialog.getByTestId('connection-engine')).toHaveText('MongoDB');
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

  // A host list goes through an SSH tunnel: the dialog says how every member is reached.
  await connectionTab(dialog, 'SSH');
  await dialog.getByLabel('Connect through an SSH tunnel').check();
  await expect(dialog.getByText(/reaches every member through it/)).toBeVisible();
  await field(dialog, 'SSH host').fill('bastion.example.com');
  await field(dialog, 'SSH user').fill('ops');
  await field(dialog, 'SSH password storage').selectOption('session');
  await expect(dialog.getByRole('tab', { name: 'SSH (on)' })).toBeVisible();

  await connectionTab(dialog, 'General');
  await field(dialog, 'Name').fill('E2E Mongo');
  await field(dialog, 'Password storage').selectOption('session');
  await connectionTab(dialog, 'Advanced');
  await field(dialog, 'Read preference').selectOption('secondaryPreferred');
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
  await expect(field(again, 'TLS mode')).toHaveValue('verify-full');
  await expect(again.getByLabel('Connect through an SSH tunnel')).toBeChecked();
  await expect(field(again, 'SSH host')).toHaveValue('bastion.example.com');
  await expect(field(again, 'SSH user')).toHaveValue('ops');
  // The passwords (the database's and the SSH server's) went to main and do not come back.
  await expect(field(again, 'Password')).toHaveValue('');
  await expect(again.getByText('Leave empty to keep the stored password')).toHaveCount(2);
  await again.getByRole('button', { name: 'Cancel' }).click();
});

test('turns TLS on for SRV and asks X.509 for TLS, a certificate and a key', async () => {
  const dialog = await newConnection();
  await chooseEngine(dialog, 'MongoDB');
  await field(dialog, 'Name').fill('E2E Atlas');
  // TLS starts off; an SRV record turns it on, and the TLS tab says so.
  await expect(field(dialog, 'TLS mode')).toHaveValue('disable');
  await field(dialog, 'Connect with').selectOption('srv');
  await expect(field(dialog, 'TLS mode')).toHaveValue('verify-full');
  await expect(dialog.getByRole('tab', { name: 'TLS (on)' })).toBeVisible();
  await field(dialog, 'SRV host name').fill('cluster0.example.net');
  await connectionTab(dialog, 'TLS');
  await expect(dialog.getByText(/An SRV record \(mongodb\+srv\) implies TLS/)).toBeVisible();

  await connectionTab(dialog, 'General');
  await field(dialog, 'Authentication').selectOption('clientCertificate');
  await connectionTab(dialog, 'TLS');
  await field(dialog, 'TLS mode').selectOption('disable');
  await connectionTab(dialog, 'General');
  // Saving opens the tab with the problem, marked on its tab.
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('tab', { name: 'TLS (has errors)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(field(dialog, 'TLS mode')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('X.509 authentication needs TLS')).toBeVisible();
  await field(dialog, 'TLS mode').selectOption('verify-full');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Choose the client certificate')).toBeVisible();
  await field(dialog, 'Client certificate').fill('/certs/app.pem');
  await field(dialog, 'Client key').fill('/certs/app.pem');

  await connectionTab(dialog, 'General');
  await field(dialog, 'Authentication').selectOption('password');
  await field(dialog, 'User').fill('ldap-user');
  await field(dialog, 'Mechanism').selectOption('PLAIN');
  await expect(field(dialog, 'Authentication database')).toHaveValue('$external');
  await expect(field(dialog, 'Authentication database')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('saves a Redis Sentinel connection through a proxy, and edits it', async () => {
  const dialog = await newConnection();
  await chooseEngine(dialog, 'Redis');
  await field(dialog, 'Name').fill('E2E Redis');
  await field(dialog, 'Connect with').selectOption('sentinel');
  await field(dialog, 'Sentinel 1').fill('s1.example.com');
  await dialog.getByRole('button', { name: 'Add sentinel' }).click();
  await field(dialog, 'Sentinel 2').fill('s2.example.com');
  await field(dialog, 'Sentinel 2 port').fill('26380');
  await field(dialog, 'Master name').fill('mymaster');
  await field(dialog, 'Authentication').selectOption('password');
  await field(dialog, 'User').fill('app');
  await field(dialog, 'Password').fill('e2e-R3dis');
  await field(dialog, 'Password storage').selectOption('session');
  await connectionTab(dialog, 'Advanced');
  await field(dialog, 'Database number').fill('16x');
  await field(dialog, 'Key delimiter').fill('|');
  // Sentinel goes through a proxy: the dialog says every node is reached through it.
  await connectionTab(dialog, 'Proxy');
  await field(dialog, 'Proxy type').selectOption('socks5');
  await expect(dialog.getByText(/Sentinel and Cluster reach every node through it/)).toBeVisible();
  await field(dialog, 'Proxy host').fill('proxy.example.com');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('tab', { name: 'Advanced (has errors)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    dialog.getByText('Enter a database number (0 to 15 on a default server)'),
  ).toBeVisible();

  await field(dialog, 'Database number').fill('3');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const again = await edit('E2E Redis');
  await expect(field(again, 'Connect with')).toHaveValue('sentinel');
  await expect(field(again, 'Proxy type')).toHaveValue('socks5');
  await expect(field(again, 'Proxy host')).toHaveValue('proxy.example.com');
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
  await expect(dialog.getByTestId('connection-engine')).toHaveText('Redis');
  await expect(field(dialog, 'Connect with')).toHaveValue('host');
  await expect(field(dialog, 'Host')).toHaveValue('cache.example.com');
  await expect(field(dialog, 'Port')).toHaveValue('6380');
  await expect(field(dialog, 'Database number')).toHaveValue('2');
  await expect(field(dialog, 'TLS mode')).toHaveValue('verify-full');
  await expect(field(dialog, 'Authentication')).toHaveValue('password');
  await expect(field(dialog, 'Password')).toHaveValue('e2e-p@ss');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
