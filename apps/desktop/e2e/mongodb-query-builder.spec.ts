import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { MongoSession } from '@querybara/driver-mongodb';
import { toEjson } from '@querybara/mongo-tools';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connectMongo, scratchMongoDatabase, withoutTls } from './mongo-db';

/**
 * The MongoDB visual query builder against the test replica set (spec §9, "Browsing and
 * editing"): the field list from a schema sample, a filter with an OR group, projection, sort
 * and limit built from the keyboard and with clicks (and one drag), the find() text following
 * each change, the run and its result count, an incomplete value that stops the run, and the
 * builder following the text when it is edited by hand, including a query it cannot show.
 * With QUERYBARA_E2E_SHOTS set, screenshots are saved there as mongo-builder-*.png.
 */

const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E Mongo builder';

test.skip(!MONGO_URL, 'Set QUERYBARA_TEST_MONGODB_URL to run the MongoDB end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: MongoSession | undefined;
let database: ReturnType<typeof scratchMongoDatabase> | undefined;
let db = '';

const CITIES = ['London', 'Paris', 'Yerevan', 'Oslo'];

test.beforeAll(async () => {
  direct = await connectMongo(MONGO_URL!);
  database = scratchMongoDatabase(direct);
  db = database.name;
  const orders = Array.from({ length: 40 }, (_, i) => ({
    _id: i + 1,
    status: i % 2 === 0 ? 'open' : 'shipped',
    total: i * 5,
    at: new Date(Date.UTC(2026, 0, 1 + i)),
    customer: { name: `Customer ${i % 5}`, address: { city: CITIES[i % CITIES.length] } },
    tags: i % 3 === 0 ? ['red'] : ['blue', 'big'],
  }));
  await direct.insertMany({ db, collection: 'orders' }, toEjson(orders));
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await database?.drop().catch(() => undefined);
  await direct?.close();
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function panel(): Locator {
  return page.getByTestId('mongo-collection-panel').filter({ visible: true });
}

function builder(): Locator {
  return panel().getByTestId('mongo-builder');
}

function findText(): Locator {
  return panel().getByTestId('mongo-find-text');
}

function field(path: string): Locator {
  return builder().locator(`[data-testid="builder-field"][data-path="${path}"]`);
}

function condition(path: string): Locator {
  return builder().locator(`[data-testid="builder-condition"][data-path="${path}"]`);
}

/** A control of the condition on `path`: "operator", "value", "value type", "values"… */
function control(path: string, what: string): Locator {
  return condition(path).getByLabel(`${path} ${what}`, { exact: true });
}

/** Opens a field's "Add to…" menu with a click and picks an item. */
async function addTo(path: string, item: string): Promise<void> {
  await builder()
    .getByRole('button', { name: `Add ${path} to…`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Replaces the text of a Monaco editor (typed as one input, so brackets are not auto-closed). */
async function replaceText(editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

test('opens a collection and shows the builder with the sampled fields', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(withoutTls(MONGO_URL!));
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('treeitem', { name: NAME }).locator('[data-tree-row]').first().dblclick();
  await treeRow(db).click();
  await treeRow('Collections').click();
  await treeRow('orders').dblclick();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('40 documents loaded');

  await panel().getByRole('radio', { name: 'Builder' }).click();
  await expect(builder().getByTestId('builder-sample-summary')).toHaveText(
    'Fields of 40 sampled documents',
  );
  await expect(field('status')).toContainText('String');
  await expect(field('total')).toContainText('Int32');
  await expect(field('at')).toContainText('Date');
  await expect(field('customer.address.city')).toContainText('String');
  await expect(field('tags')).toContainText('String[]');
  // The find() text stays under the builder; the fields are hidden meanwhile.
  await expect(findText()).toContainText('db.orders.find({})');
  await expect(panel().getByTestId('mongo-filter')).toBeHidden();
});

test('builds a filter from the keyboard and with clicks, the find() text following', async () => {
  // Keyboard: the field's menu button, Enter to open, Enter on "Add to filter"; the new
  // condition's value takes the focus.
  await builder().getByRole('button', { name: 'Add status to…', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Add to filter', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(control('status', 'value')).toBeFocused();
  await page.keyboard.type('open');
  await expect(findText()).toContainText("db.orders.find({ status: 'open' })");

  // Clicks: total > 100, typed as the field's Int32.
  await addTo('total', 'Add to filter');
  await control('total', 'operator').selectOption('$gt');
  await expect(control('total', 'value type')).toHaveValue('int');
  await control('total', 'value').fill('100');
  await expect(findText()).toContainText("db.orders.find({ status: 'open', total: { $gt: 100 } })");

  // An OR group: the city is London or Paris, or the tags hold 'red'.
  await addTo('customer.address.city', 'Add to a new OR group');
  await control('customer.address.city', 'operator').selectOption('$in');
  await control('customer.address.city', 'values').fill('London\nParis');
  await addTo('tags', 'Add to OR group 1');
  await control('tags', 'value').fill('red');
  await expect(builder().getByRole('group', { name: 'OR group 1' })).toBeVisible();
  await expect(findText()).toContainText(
    "db.orders.find({ status: 'open', total: { $gt: 100 }, $or: [ { 'customer.address.city': { $in: [ 'London', 'Paris' ] } }, { tags: 'red' } ] })",
  );
});

test('runs the built query, and stops a run while a value is incomplete', async () => {
  await panel().getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('5 documents loaded');
  await panel().getByRole('button', { name: 'Count matches' }).click();
  await expect(panel().getByTestId('mongo-total')).toContainText('5 matching');

  // A field dropped on the filter: a date condition, first with a value that is not a date.
  // (Dropped at the zone's top, clear of the OR group, which takes drops of its own.)
  await field('at').dragTo(builder().getByTestId('builder-filter'), {
    targetPosition: { x: 12, y: 8 },
  });
  const at = condition('at');
  await expect(at).toBeVisible();
  await control('at', 'operator').selectOption('$gte');
  await control('at', 'value').fill('soon');
  await expect(at.getByTestId('builder-condition-issue')).toContainText('Enter an ISO date');
  await expect(builder().getByTestId('builder-pending')).toContainText('Filter on at');
  await expect(findText()).not.toContainText('at:');
  await control('at', 'value').press('Enter');
  await expect(panel().getByTestId('mongo-notice')).toContainText(
    'Fix the query first. Filter on at: Enter an ISO date',
  );
  await control('at', 'value').fill('2026-01-30');
  await expect(findText()).toContainText("at: { $gte: ISODate('2026-01-30T00:00:00.000Z') }");
  await control('at', 'value').press('Enter');
  // Two of the five are older than that.
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('3 documents loaded');
  await at.getByRole('button', { name: 'Remove the condition on at' }).click();
  await expect(findText()).not.toContainText('at:');
});

test('adds projection, sort and limit, and keeps the projection rule', async () => {
  await addTo('total', 'Add to projection');
  await addTo('_id', 'Add to projection');
  const projection = builder().getByTestId('builder-projection');
  // _id comes with included fields anyway, so adding it next to them excludes it.
  await expect(
    projection
      .getByRole('radiogroup', { name: '_id projection' })
      .getByRole('radio', { name: 'Exclude' }),
  ).toBeChecked();
  // Excluding a field next to an included one is refused, with the reason.
  await addTo('status', 'Add to projection');
  await projection
    .getByRole('radiogroup', { name: 'status projection' })
    .getByRole('radio', { name: 'Exclude' })
    .click();
  await expect(projection.getByTestId('builder-projection-issue')).toContainText(
    'either includes or excludes',
  );
  await projection.getByRole('button', { name: 'Remove status from the projection' }).click();
  await expect(projection.getByTestId('builder-projection-issue')).toBeHidden();

  // Sort by total descending, then by _id; Alt+Up moves _id first and back down.
  await addTo('total', 'Add to sort');
  const sort = builder().getByTestId('builder-sort');
  await sort
    .getByRole('radiogroup', { name: 'total sort direction' })
    .getByRole('radio', { name: 'Desc' })
    .click();
  await addTo('_id', 'Add to sort');
  await expect(findText()).toContainText('.sort({ total: -1, _id: 1 })');
  await sort.getByRole('button', { name: /^Reorder sort key _id/ }).press('Alt+ArrowUp');
  await expect(findText()).toContainText('.sort({ _id: 1, total: -1 })');
  await sort.getByRole('button', { name: 'Move _id down' }).click();
  await expect(findText()).toContainText('.sort({ total: -1, _id: 1 })');

  await builder().getByTestId('builder-limit').fill('3');
  await expect(findText()).toContainText(
    "db.orders.find({ status: 'open', total: { $gt: 100 }, $or: [ { 'customer.address.city': { $in: [ 'London', 'Paris' ] } }, { tags: 'red' } ] }, { total: 1, _id: 0 }).sort({ total: -1, _id: 1 }).limit(3)",
  );
  await shot('mongo-builder');
  await builder().getByTestId('builder-limit').press('Enter');
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('3 documents loaded');
  await panel().getByRole('radio', { name: 'JSON' }).click();
  const json = panel().getByTestId('mongo-json-text');
  await expect(json).toContainText('{ total: 180 }');
  await expect(json).not.toContainText('status');
});

test('follows the find() text when it is edited, and says when it cannot show it', async () => {
  await replaceText(
    findText(),
    "db.orders.find({ status: 'shipped', total: { $lte: 20 } }).sort({ _id: 1 })",
  );
  await expect(builder().getByTestId('builder-condition')).toHaveCount(2);
  await expect(control('status', 'value')).toHaveValue('shipped');
  await expect(control('total', 'operator')).toHaveValue('$lte');
  await expect(control('total', 'value')).toHaveValue('20');
  await expect(builder().getByRole('group', { name: 'OR group 1' })).toBeHidden();
  await expect(builder().getByTestId('builder-projection-entry')).toHaveCount(0);
  await expect(builder().getByTestId('builder-sort-entry')).toHaveCount(1);
  await expect(builder().getByTestId('builder-limit')).toHaveValue('');
  await panel().getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('2 documents loaded');

  await replaceText(findText(), "db.orders.find({ tags: { $elemMatch: { $eq: 'red' } } })");
  const blocked = builder().getByTestId('builder-blocked');
  await expect(blocked).toContainText('This query can’t be shown in the builder');
  await expect(blocked).toContainText('$elemMatch is not in the builder');
  await expect(builder().getByRole('button', { name: 'Add status to…' })).toBeDisabled();
  await shot('mongo-builder-blocked');
  // The text still runs.
  await panel().getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel().getByTestId('mongo-loaded')).toHaveText('14 documents loaded');

  await replaceText(findText(), "db.orders.find({ tags: 'red' })");
  await expect(blocked).toBeHidden();
  await expect(control('tags', 'value')).toHaveValue('red');
  await expect(builder().getByRole('button', { name: 'Add status to…' })).toBeEnabled();

  await panel().getByRole('radio', { name: 'Fields' }).click();
  await expect(builder()).toBeHidden();
  await expect(panel().getByTestId('mongo-filter')).toHaveValue("{ tags: 'red' }");
});
