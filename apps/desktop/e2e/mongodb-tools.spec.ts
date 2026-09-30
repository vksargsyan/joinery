import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MongoSession } from '@joinery/driver-mongodb';
import { toEjson } from '@joinery/mongo-tools';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';
import { connectMongo, scratchMongoDatabase, withoutTls } from './mongo-db';

/**
 * The MongoDB tool panels against the test replica set (spec §9, "Query tools" and "Schema and
 * admin"): the aggregation editor with per-stage previews and a disabled stage, the index manager
 * (TTL and partial indexes), schema analysis applied as a validator that the document editor then
 * hits, capped and time series collections, a change stream fed from the console, the GridFS
 * browser and the users editor. With JOINERY_E2E_SHOTS set, screenshots of each panel are saved
 * there as mongo2-*.png.
 */

const MONGO_URL = process.env['JOINERY_TEST_MONGODB_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Mongo tools';

test.skip(!MONGO_URL, 'Set JOINERY_TEST_MONGODB_URL to run the MongoDB end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: MongoSession | undefined;
let database: ReturnType<typeof scratchMongoDatabase> | undefined;
let db = '';
let files = '';
const USER = `e2e_user_${randomBytes(3).toString('hex')}`;
const ROLE = `e2e_role_${randomBytes(3).toString('hex')}`;

test.beforeAll(async () => {
  direct = await connectMongo(MONGO_URL!);
  database = scratchMongoDatabase(direct);
  db = database.name;
  files = mkdtempSync(join(tmpdir(), 'joinery-e2e-mongo-'));
  const orders = Array.from({ length: 60 }, (_, i) => ({
    _id: i + 1,
    status: i % 2 === 0 ? 'open' : 'shipped',
    total: i * 5,
    at: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
  }));
  await direct.insertMany({ db, collection: 'orders' }, toEjson(orders));
  const people = Array.from({ length: 20 }, (_, i) => ({ name: `Person ${i}`, age: 20 + i }));
  await direct.insertMany({ db, collection: 'people' }, toEjson(people));
  await direct.uploadFile({ db, bucket: 'fs' }, new TextEncoder().encode('Hello from GridFS'), {
    filename: 'hello.txt',
    contentType: 'text/plain',
  });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.dropUser(db, USER).catch(() => undefined);
  await direct?.dropRole(db, ROLE).catch(() => undefined);
  await database?.drop().catch(() => undefined);
  await direct?.close();
  if (files) rmSync(files, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page
    .locator('[data-tree-row]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first();
}

/** Opens a tree row's menu and picks an item. */
async function treeMenu(text: string, item: string): Promise<void> {
  const row = treeRow(text);
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

function visible(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

/** Replaces the text of a Monaco editor (typed as one input, so brackets are not auto-closed). */
async function replaceText(editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** Answers the confirmation on top with `label`, after checking its command. */
async function confirmWith(label: string, detail?: string | RegExp): Promise<void> {
  const dialog = page.getByRole('alertdialog').last();
  await expect(dialog).toBeVisible();
  if (detail !== undefined)
    await expect(dialog.getByTestId('confirm-detail')).toContainText(detail);
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The next native open or save dialog answers with `path`. */
async function stubDialog(kind: 'open' | 'save', path: string): Promise<void> {
  await launched!.app.evaluate(
    ({ dialog }, [which, file]) => {
      if (which === 'open') {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
      } else {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      }
    },
    [kind, path] as const,
  );
}

async function showTab(title: string): Promise<void> {
  await page.locator('.dv-tab').filter({ hasText: title }).first().click();
}

test('connects and shows the scratch database', async () => {
  await page.getByRole('button', { name: 'New connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(withoutTls(MONGO_URL!));
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().click();
  await treeRow(db).click();
  await treeRow('Collections').click();
  await expect(treeRow('orders')).toBeVisible();
});

test('builds a three-stage pipeline with per-stage previews and a disabled stage', async () => {
  await treeMenu('orders', 'Aggregate…');
  const panel = visible('mongo-aggregation-panel');
  await expect(panel).toBeVisible();
  const cards = panel.getByTestId('stage-card');
  await expect(cards).toHaveCount(1);
  await replaceText(cards.nth(0).getByTestId('stage-body'), "{ status: 'open' }");

  await panel.getByTestId('stage-add').click();
  await cards.nth(1).getByTestId('stage-operator').selectOption('$sort');
  await expect(cards.nth(1).getByTestId('stage-docs')).toContainText('Sort documents');
  await replaceText(cards.nth(1).getByTestId('stage-body'), '{ total: -1 }');

  await panel.getByTestId('stage-add').click();
  await cards.nth(2).getByTestId('stage-operator').selectOption('$limit');
  await replaceText(cards.nth(2).getByTestId('stage-body'), '3');

  // Every stage previews its own output on the sample.
  await expect(cards.nth(0).getByTestId('stage-preview-summary')).toContainText(
    '20 documents from a sample of 1,000',
  );
  await expect(cards.nth(2).getByTestId('stage-preview-summary')).toContainText('3 documents');
  await expect(cards.nth(2).getByTestId('stage-preview-document').first()).toContainText('_id: 59');

  // Switching the sort off: its card is skipped, and the limit sees the unsorted input.
  await cards.nth(1).getByTestId('stage-enabled').uncheck();
  await expect(cards.nth(1)).toHaveAttribute('data-enabled', 'false');
  await expect(cards.nth(1).getByTestId('stage-preview-summary')).toHaveText('Not previewed');
  await expect(cards.nth(2).getByTestId('stage-preview-document').first()).toContainText('_id: 1,');

  // Keyboard reorder, and back.
  await cards.nth(2).getByTestId('stage-handle').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(cards.nth(1)).toHaveAttribute('data-operator', '$limit');
  await cards.nth(1).getByTestId('stage-handle').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(cards.nth(2)).toHaveAttribute('data-operator', '$limit');

  await panel.getByTestId('aggregation-run').click();
  await expect(panel.getByTestId('aggregation-count')).toContainText('3 documents');
  await panel.getByTestId('aggregation-stages').evaluate((element) => element.scrollTo(0, 0));
  await shot('mongo2-aggregation');

  // The same pipeline as one text, the disabled stage commented out.
  await panel.getByRole('radio', { name: 'Text' }).click();
  await expect(panel.getByTestId('aggregation-text')).toContainText('// { $sort: { total: -1 } },');
  await shot('mongo2-aggregation-text');
  await panel.getByRole('radio', { name: 'Stages' }).click();
});

test('creates and drops a TTL and a partial index', async () => {
  await treeMenu('orders', 'Indexes');
  const panel = visible('mongo-indexes-panel');
  await expect(panel.locator('tr[data-index="_id_"]')).toBeVisible();

  await panel.getByTestId('index-create').click();
  const dialog = page.getByTestId('index-dialog');
  await dialog.getByTestId('index-preset-ttl').click();
  await dialog.getByTestId('index-key-field').first().fill('at');
  await expect(dialog.getByTestId('index-command')).toHaveText(
    `db.getSiblingDB('${db}').orders.createIndex({ at: 1 }, { expireAfterSeconds: 3600 })`,
  );
  await shot('mongo2-index-create');
  await page.getByTestId('index-create-run').click();
  await expect(panel.locator('tr[data-index="at_1"]').getByTestId('index-badges')).toContainText(
    'TTL',
  );

  await panel.getByTestId('index-create').click();
  await dialog.getByTestId('index-preset-partial').click();
  await dialog.getByTestId('index-key-field').first().fill('total');
  await dialog.getByTestId('index-partialFilter').fill("{ status: 'open' }");
  await expect(dialog.getByTestId('index-command')).toContainText(
    "createIndex({ total: 1 }, { partialFilterExpression: { status: 'open' } })",
  );
  await page.getByTestId('index-create-run').click();
  await expect(panel.locator('tr[data-index="total_1"]').getByTestId('index-badges')).toContainText(
    'partial',
  );
  const created = await direct!.listIndexes({ db, collection: 'orders' });
  expect(created.find((i) => i.name === 'at_1')?.expireAfterSeconds).toBe(3600);
  expect(created.find((i) => i.name === 'total_1')?.partialFilterExpression).toBeDefined();
  await shot('mongo2-indexes');

  for (const name of ['at_1', 'total_1']) {
    await panel.getByRole('button', { name: `Drop ${name}` }).click();
    await confirmWith('Drop', `db.getSiblingDB('${db}').orders.dropIndex('${name}')`);
    await expect(panel.locator(`tr[data-index="${name}"]`)).toHaveCount(0);
  }
  expect((await direct!.listIndexes({ db, collection: 'orders' })).map((i) => i.name)).toEqual([
    '_id_',
  ]);
});

test('analyses a schema, applies it as a validator, and the editor then refuses a bad insert', async () => {
  await treeMenu('people', 'Analyse schema');
  const panel = visible('mongo-schema-panel');
  await expect(panel.getByTestId('schema-summary')).toContainText('20 documents sampled');
  const age = panel.locator('tr[data-field="age"]');
  await expect(age.getByTestId('schema-types')).toContainText('Int32 100%');
  await expect(age.getByTestId('schema-share')).toHaveText('100%');
  await age.click();
  await expect(panel.getByTestId('schema-field-detail')).toContainText('age');
  await expect(panel.getByTestId('schema-apply-command')).toContainText(
    "collMod: 'people', validator: { $jsonSchema:",
  );
  await shot('mongo2-schema');
  await panel.getByTestId('schema-apply').click();
  await confirmWith('Apply', "collMod: 'people'");
  await expect(panel.getByTestId('mongo-notice')).toContainText('Validator applied');

  await treeRow('people').dblclick();
  const view = visible('mongo-collection-panel');
  await view.getByRole('button', { name: 'Insert' }).click();
  await replaceText(page.getByTestId('document-editor-text'), "{ nickname: 'no name, no age' }");
  await page.getByTestId('editor-save').click();
  await expect(page.getByTestId('editor-error')).toContainText(/validation/i);
  await shot('mongo2-validator-rejected');
  await page
    .getByRole('dialog', { name: 'Insert document' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  expect(await direct!.count({ db, collection: 'people' })).toBe(20);
});

test('creates a capped and a time series collection', async () => {
  await treeMenu(db, 'Create collection…');
  const dialog = page.getByTestId('create-collection-dialog');
  await dialog.getByTestId('create-collection-name').fill('capped_log');
  await dialog.getByRole('radio', { name: 'Capped' }).click();
  await dialog.getByTestId('create-collection-size').fill('65536');
  await dialog.getByTestId('create-collection-max').fill('100');
  await expect(dialog.getByTestId('create-collection-command')).toHaveText(
    `db.getSiblingDB('${db}').createCollection('capped_log', { capped: true, size: 65536, max: 100 })`,
  );
  await shot('mongo2-create-collection');
  await page.getByTestId('create-collection-run').click();
  await confirmWith('Create', "createCollection('capped_log'");
  await expect(dialog).toBeHidden();
  await expect(treeRow('capped_log')).toBeVisible();
  expect(await direct!.collectionInfo({ db, collection: 'capped_log' })).toMatchObject({
    capped: true,
  });

  await treeMenu(db, 'Create collection…');
  await dialog.getByTestId('create-collection-name').fill('readings');
  await dialog.getByRole('radio', { name: 'Time series' }).click();
  await dialog.getByTestId('create-collection-time-field').fill('at');
  await dialog.getByTestId('create-collection-meta-field').fill('sensor');
  await dialog.getByTestId('create-collection-granularity').selectOption('minutes');
  await expect(dialog.getByTestId('create-collection-command')).toContainText(
    "timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' }",
  );
  await page.getByTestId('create-collection-run').click();
  await confirmWith('Create');
  await expect(dialog).toBeHidden();
  expect(await direct!.collectionInfo({ db, collection: 'readings' })).toMatchObject({
    type: 'timeseries',
    timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' },
  });

  await treeMenu('capped_log', 'Options');
  const options = visible('mongo-options-panel');
  await expect(options.getByTestId('options-type')).toHaveText('capped collection');
  await shot('mongo2-options');
});

test('watches a change stream while the console inserts, updates and deletes', async () => {
  await treeMenu('orders', 'Watch changes');
  const panel = visible('mongo-changes-panel');
  await panel.getByTestId('changes-start').click();
  await expect(panel.getByTestId('changes-status')).toContainText('Watching');
  // The server opens the stream asynchronously: insert probes until one shows up.
  const rows = panel.getByTestId('changes-list').locator('tbody tr');
  let probes = 0;
  await expect(async () => {
    probes += 1;
    await direct!.insertOne({ db, collection: 'orders' }, toEjson({ probe: probes }));
    await expect(rows.first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(rows).toHaveCount(probes);
  await panel.getByTestId('changes-clear').click();
  await expect(rows).toHaveCount(0);

  await treeMenu(db, 'Open console');
  const consolePanel = visible('mongo-console');
  const status = async (): Promise<string | null> => {
    for await (const found of direct!.find(
      { db, collection: 'orders' },
      { filter: toEjson({ _id: 1000 }) },
    )) {
      const doc = found.documents[0];
      if (doc !== undefined) return (JSON.parse(doc) as { status: string }).status;
    }
    return null;
  };
  const commands: [string, string | null][] = [
    ["{ insert: 'orders', documents: [{ _id: 1000, status: 'new' }] }", 'new'],
    [
      "{ update: 'orders', updates: [{ q: { _id: 1000 }, u: { $set: { status: 'changed' } } }] }",
      'changed',
    ],
    ["{ delete: 'orders', deletes: [{ q: { _id: 1000 }, limit: 1 }] }", null],
  ];
  for (const [command, after] of commands) {
    await replaceText(consolePanel.getByTestId('mongo-console-editor'), command);
    await consolePanel.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(status).toBe(after);
  }
  await shot('mongo2-console-writes');

  await showTab('Changes: orders');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-operation', 'delete');
  await expect(rows.nth(1)).toHaveAttribute('data-operation', 'update');
  await expect(rows.nth(2)).toHaveAttribute('data-operation', 'insert');
  await expect(rows.nth(1).getByTestId('change-key')).toHaveText('1000');
  await rows.nth(1).click();
  await expect(panel.getByTestId('changes-detail')).toContainText("status: 'changed'");

  // Paused, it keeps its place: a change made meanwhile arrives on resume.
  await panel.getByTestId('changes-pause').click();
  await expect(panel.getByTestId('changes-status')).toContainText('Paused');
  await direct!.insertOne({ db, collection: 'orders' }, toEjson({ _id: 1001, status: 'late' }));
  await panel.getByTestId('changes-start').click();
  await expect(rows.first().getByTestId('change-key')).toHaveText('1001');
  await shot('mongo2-changes');
  await panel.getByTestId('changes-stop').click();
  await expect(panel.getByTestId('changes-status')).toContainText('Stopped');
});

test('uploads, downloads and deletes a GridFS file', async () => {
  await treeRow('GridFS buckets').click();
  await treeRow('fs').dblclick();
  const panel = visible('mongo-gridfs-panel');
  await expect(panel.locator('tr[data-file="hello.txt"]')).toBeVisible();
  await panel.locator('tr[data-file="hello.txt"]').click();
  await expect(panel.getByTestId('gridfs-preview-text')).toHaveText('Hello from GridFS');

  const source = join(files, 'upload.txt');
  writeFileSync(source, 'Uploaded by the end-to-end test\n');
  await stubDialog('open', source);
  await panel.getByTestId('gridfs-upload').click();
  await expect(panel.getByTestId('mongo-notice')).toContainText('Uploaded upload.txt');
  const uploaded = panel.locator('tr[data-file="upload.txt"]');
  await expect(uploaded).toBeVisible();
  await uploaded.click();
  await expect(panel.getByTestId('gridfs-preview-text')).toContainText('Uploaded by');
  await shot('mongo2-gridfs');

  const target = join(files, 'downloaded.txt');
  await stubDialog('save', target);
  await panel.getByTestId('gridfs-download').click();
  await expect(panel.getByTestId('mongo-notice')).toContainText('Downloaded');
  expect(readFileSync(target, 'utf8')).toBe('Uploaded by the end-to-end test\n');

  await panel.getByTestId('gridfs-delete').click();
  await confirmWith('Delete', /getCollection\('fs\.chunks'\)\.deleteMany/);
  await expect(uploaded).toHaveCount(0);
  const left: string[] = [];
  for await (const page of direct!.listFiles({ db, bucket: 'fs' })) {
    left.push(...page.files.map((f) => f.filename));
  }
  expect(left).toEqual(['hello.txt']);
});

test('creates a user with a role and drops it', async () => {
  await treeRow('Users').click();
  await treeMenu('Users', 'Manage users');
  const panel = visible('mongo-users-panel');
  await panel.getByTestId('user-create').click();
  const dialog = page.getByTestId('user-dialog');
  await dialog.getByTestId('user-form-name').fill(USER);
  await dialog.getByTestId('user-form-password').fill('Secret-e2e-123');
  await dialog.getByTestId('role-ref-role').first().fill('readWrite');
  const command = dialog.getByTestId('user-command');
  await expect(command).toContainText(`createUser({ user: '${USER}', pwd: passwordPrompt()`);
  await expect(command).toContainText(`roles: [ { role: 'readWrite', db: '${db}' } ]`);
  await expect(command).not.toContainText('Secret-e2e-123');
  await shot('mongo2-user-create');
  await page.getByTestId('user-save').click();
  await confirmWith('Run', 'passwordPrompt()');
  await expect(dialog).toBeHidden();
  const row = panel.locator(`tr[data-user="${USER}"]`);
  await expect(row).toContainText(`readWrite@${db}`);
  expect((await direct!.usersInfo(db, { user: USER }))[0]?.roles).toEqual([
    { role: 'readWrite', db },
  ]);
  await row.click();
  await expect(panel.getByTestId('user-detail')).toContainText(`${USER}@${db}`);
  await shot('mongo2-users');

  await panel.getByTestId('user-drop').click();
  await confirmWith('Drop', `dropUser('${USER}')`);
  await expect(row).toHaveCount(0);
  expect(await direct!.usersInfo(db, { user: USER })).toEqual([]);
});

test('creates a custom role with a privilege and an inherited role, and drops it', async () => {
  const panel = visible('mongo-users-panel');
  await panel.getByRole('radio', { name: 'Roles' }).click();
  await panel.getByTestId('role-create').click();
  const dialog = page.getByTestId('role-dialog');
  await dialog.getByTestId('role-form-name').fill(ROLE);
  await dialog.getByTestId('privilege-actions').first().fill('find, collStats');
  await dialog.getByRole('button', { name: 'Add role' }).click();
  await dialog.getByTestId('role-ref-role').first().fill('read');
  await expect(dialog.getByTestId('role-command')).toContainText(
    `createRole({ role: '${ROLE}', privileges: [ { resource: { db: '${db}', collection: '' }, actions: [ 'find', 'collStats' ] } ], roles: [ { role: 'read', db: '${db}' } ] })`,
  );
  await page.getByTestId('role-save').click();
  await confirmWith('Run', 'createRole');
  const row = panel.locator(`tr[data-role="${ROLE}"]`);
  await expect(row).toContainText(`read@${db}`);
  await row.click();
  await expect(panel.getByTestId('role-detail')).toContainText('collStats, find');
  await shot('mongo2-roles');
  await panel.getByTestId('role-drop').click();
  await confirmWith('Drop', `dropRole('${ROLE}')`);
  await expect(row).toHaveCount(0);
});

test('creates a view from the stage cards', async () => {
  await treeMenu('orders', 'Create view on it…');
  const dialog = page.getByTestId('create-view-dialog');
  await dialog.getByTestId('create-view-name').fill('open_orders');
  await replaceText(dialog.getByTestId('stage-body').first(), "{ status: 'open' }");
  await expect(dialog.getByTestId('create-view-command')).toContainText(
    `createView('open_orders', 'orders', [ { $match: { status: 'open' } } ])`,
  );
  await shot('mongo2-create-view');
  await page.getByTestId('create-view-run').click();
  await confirmWith('Create', 'createView');
  await expect(dialog).toBeHidden();
  await treeRow('Views').click();
  await expect(treeRow('open_orders')).toBeVisible();
  // Read on another connection: the new view can take a moment to show there.
  await expect.poll(() => direct!.count({ db, collection: 'open_orders' })).toBe(30);
});
