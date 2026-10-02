import { expect, test, type Locator, type Page } from '@playwright/test';

import type { LaunchedApp } from '../app';
import { addConnection, capture, connectProfile, DEMO, launchForShots } from './harness';
import { closeTabs, profileItem, replaceText, treeMenu, treeRow, visible } from './nosql';

/**
 * MongoDB scenes on the demo replica set (Larchwood's `catalog` database): the collection view,
 * the visual query builder, the aggregation editor, schema analysis, the SQL tab and code export.
 * Nothing is written to the server.
 */

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;

test.beforeAll(async () => {
  launched = await launchForShots();
  page = launched.page;
  await addConnection(page, DEMO.mongodb);
  await connectProfile(page, DEMO.mongodb.name);
  const catalog = profileItem(page, DEMO.mongodb.name);
  await treeRow(page, 'catalog', catalog).click();
  await treeRow(page, 'Collections', catalog).click();
  await expect(treeRow(page, 'products', catalog)).toBeVisible();
});

test.afterAll(async () => {
  await launched?.close();
});

function panel(): Locator {
  return visible(page, 'mongo-collection-panel');
}

function builder(): Locator {
  return panel().getByTestId('mongo-builder');
}

function condition(path: string): Locator {
  return builder().locator(`[data-testid="builder-condition"][data-path="${path}"]`);
}

function control(path: string, what: string): Locator {
  return condition(path).getByLabel(`${path} ${what}`, { exact: true });
}

async function addTo(path: string, item: string): Promise<void> {
  await builder()
    .getByRole('button', { name: `Add ${path} to…`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function openProducts(): Promise<void> {
  await treeRow(page, 'products').click();
  await expect(panel().getByTestId('mongo-loaded')).toContainText('documents loaded');
}

test('mongo-collection', async () => {
  await closeTabs(page);
  await openProducts();
  await panel().getByTestId('mongo-filter').fill("{ active: true, 'price.amount': { $lt: 1500 } }");
  await panel().getByTestId('mongo-sort').fill("{ 'price.amount': -1 }");
  await panel().getByTestId('mongo-filter').press('Enter');
  await expect(panel().getByTestId('mongo-loaded')).toContainText('documents loaded');
  await panel().getByRole('button', { name: 'Document 1', exact: true }).click();
  const tree = panel().getByTestId('mongo-tree');
  await tree.getByRole('button', { name: 'Expand price' }).first().click();
  await tree.getByRole('button', { name: 'Expand variants' }).first().click();
  await tree.getByRole('button', { name: 'Expand 0' }).first().click();
  await capture(page, 'mongo-collection');
  await panel().getByRole('radio', { name: 'Table' }).click();
  await capture(page, 'mongo-collection-table');
});

test('mongo-builder', async () => {
  await closeTabs(page);
  await openProducts();
  await panel().getByRole('radio', { name: 'Builder' }).click();
  await expect(builder().getByTestId('builder-sample-summary')).toContainText('sampled');
  await addTo('category', 'Add to filter');
  await control('category', 'operator').selectOption('$in');
  await control('category', 'values').fill('tables\ndesks');
  await addTo('price.amount', 'Add to filter');
  await control('price.amount', 'operator').selectOption('$lt');
  await control('price.amount', 'value').fill('1200');
  await addTo('price.amount', 'Add to sort');
  await builder()
    .getByTestId('builder-sort')
    .getByRole('radiogroup', { name: 'price.amount sort direction' })
    .getByRole('radio', { name: 'Desc' })
    .click();
  await panel().getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel().getByTestId('mongo-loaded')).toContainText('loaded');
  await panel().getByRole('radio', { name: 'Table' }).click();
  await capture(page, 'mongo-builder');
});

test('mongo-aggregation', async () => {
  await closeTabs(page);
  await treeMenu(page, treeRow(page, 'products'), 'Aggregate…');
  const agg = visible(page, 'mongo-aggregation-panel');
  await expect(agg).toBeVisible();
  const cards = agg.getByTestId('stage-card');
  await cards.nth(0).getByTestId('stage-operator').selectOption('$unwind');
  await replaceText(page, cards.nth(0).getByTestId('stage-body'), "'$reviews'");
  const stages: readonly (readonly [string, string])[] = [
    ['$group', "{ _id: '$wood', rating: { $avg: '$reviews.rating' } }"],
    ['$sort', '{ rating: -1 }'],
    ['$set', "{ rating: { $round: ['$rating', 2] } }"],
  ];
  for (const [index, [operator, body]] of stages.entries()) {
    await agg.getByTestId('stage-add').click();
    const card = cards.nth(index + 1);
    await card.getByTestId('stage-operator').selectOption(operator);
    await replaceText(page, card.getByTestId('stage-body'), body);
  }
  await expect(cards.nth(3).getByTestId('stage-preview-summary')).toContainText('7 documents');
  await agg.getByTestId('aggregation-run').click();
  await expect(agg.getByTestId('aggregation-count')).toContainText('7 documents');
  await agg.getByRole('radio', { name: 'Table' }).click();
  // The $group and $sort cards: the averages per wood, then in order.
  await agg.getByTestId('aggregation-stages').evaluate((element) => {
    const card = element.querySelectorAll('[data-testid="stage-card"]')[1];
    if (!card) return;
    const top = card.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTo(0, element.scrollTop + top - 8);
  });
  await capture(page, 'mongo-aggregation');
});

test('mongo-schema', async () => {
  await closeTabs(page);
  await treeMenu(page, treeRow(page, 'products'), 'Analyse schema');
  const schema = visible(page, 'mongo-schema-panel');
  await expect(schema.getByTestId('schema-summary')).toContainText('documents sampled');
  await schema.locator('tr[data-field="discontinued_at"]').click();
  await expect(schema.getByTestId('schema-field-detail')).toContainText('discontinued_at');
  await capture(page, 'mongo-schema');
});

test('mongo-sql', async () => {
  await closeTabs(page);
  await treeMenu(page, treeRow(page, 'catalog'), 'New SQL query');
  const tab = visible(page, 'mongo-sql');
  await replaceText(
    page,
    tab.getByTestId('mongo-sql-editor'),
    [
      'SELECT category, wood, COUNT(*) AS products,',
      'FROM products',
      'WHERE active = true',
      'GROUP BY category, wood',
      'ORDER BY category, from_eur',
    ].join('\n'),
  );
  // The indented line goes in last: Monaco would carry its indentation to the lines after it.
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('  MIN(price.amount) AS from_eur, MAX(price.amount) AS to_eur');
  await expect(tab.getByText(/^aggregate\(\) · \d stages?$/)).toBeVisible();
  await tab.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(tab.getByTestId('mongo-sql-count')).toContainText('documents');
  await capture(page, 'mongo-sql');
});

test('mongo-code-export', async () => {
  await closeTabs(page);
  await openProducts();
  await panel().getByTestId('mongo-filter').fill("{ wood: 'oak', 'variants.in_stock': true }");
  await panel().getByTestId('mongo-projection').fill("{ sku: 1, name: 1, 'price.amount': 1 }");
  await panel().getByTestId('mongo-sort').fill("{ 'price.amount': -1 }");
  await panel().getByTestId('mongo-limit').fill('20');
  await panel().getByTestId('mongo-filter').press('Enter');
  await expect(panel().getByTestId('mongo-loaded')).toContainText('loaded');
  await panel().getByRole('button', { name: 'Export code…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export code' });
  await dialog.getByRole('radio', { name: 'Python' }).click();
  await expect(dialog.getByTestId('code-export-install')).toHaveText('pip install pymongo');
  await capture(page, 'mongo-code-export');
  await page.keyboard.press('Escape');
});
