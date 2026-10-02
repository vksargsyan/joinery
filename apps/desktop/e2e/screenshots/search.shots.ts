import {
  createSearchAdapter,
  isSearchSession,
  searchProfileFromUrl,
  type SearchSession,
} from '@joinery/driver-elasticsearch';
import { expect, test, type Locator, type Page } from '@playwright/test';

import type { LaunchedApp } from '../app';
import { addConnection, capture, connectProfile, DEMO, DEMO_CA, launchForShots } from './harness';
import { closeTabs, profileItem, replaceText, treeRow, visible } from './nosql';

/**
 * Elasticsearch scenes on the demo node (Larchwood's `products` alias over products-v2 and the
 * `logs-shop-default` data stream): the console with API autocomplete, the query builder from
 * the mapping, the document grid with an edit, SQL translated to Query DSL, and shard
 * allocation with its explanation. Nothing is written to the documents; the cluster scene gives
 * products-v2 a replica for a moment (a one-node cluster cannot place it), then takes it away.
 */

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;

test.beforeAll(async () => {
  launched = await launchForShots();
  page = launched.page;
  await addConnection(page, DEMO.elasticsearch);
  await connectProfile(page, DEMO.elasticsearch.name);
  await treeRow(page, 'Indices', search()).click();
  await expect(treeRow(page, 'products-v2', search())).toBeVisible();
});

test.afterAll(async () => {
  await launched?.close();
});

function search(): Locator {
  return profileItem(page, DEMO.elasticsearch.name);
}

/** A direct session on the demo node, verified against the demo CA. */
async function demoSearch(): Promise<SearchSession> {
  const session = await createSearchAdapter().connect(
    searchProfileFromUrl(DEMO.elasticsearch.uri, { tls: { mode: 'verify-full', caPath: DEMO_CA } }),
  );
  if (!isSearchSession(session)) throw new Error('expected a search session');
  return session;
}

function documents(): Locator {
  return visible(page, 'search-documents');
}

async function openProducts(): Promise<void> {
  await treeRow(page, 'products-v2', search()).dblclick();
  await expect(documents().getByTestId('documents-loaded')).toContainText('loaded');
}

test('es-console', async () => {
  await closeTabs(page);
  await treeRow(page, 'Console', search()).dblclick();
  const consolePanel = visible(page, 'search-console');
  const editor = consolePanel.getByTestId('search-console-editor');
  await replaceText(
    page,
    editor,
    [
      'GET /products/_search',
      '{',
      '  "query": { "match": { "description": "walnut" } },',
      '  "aggs": { "by_category": { "terms": { "field": "category" } } },',
      '  "size": 3',
      '}',
    ].join('\n'),
  );
  await consolePanel.getByRole('button', { name: 'Auto-indent' }).click();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(consolePanel.getByTestId('search-response-status')).toHaveText('200 OK');
  // The next request, typed as far as its endpoint: the completion lists what follows.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.type('GET /products/_sea');
  const suggestions = page.locator('.monaco-editor .suggest-widget').filter({ visible: true });
  await expect(suggestions).toContainText('_search');
  await capture(page, 'es-console');
  await page.keyboard.press('Escape');
});

test('es-builder', async () => {
  await closeTabs(page);
  await openProducts();
  await documents().getByRole('radio', { name: 'Builder' }).click();
  const builder = documents().getByTestId('search-builder');
  await expect(builder).toBeVisible();
  const addTo = async (path: string, item: string | RegExp): Promise<void> => {
    await builder.getByRole('button', { name: `Add ${path} to…`, exact: true }).click();
    await page
      .getByRole(
        'menuitem',
        typeof item === 'string' ? { name: item, exact: true } : { name: item },
      )
      .click();
  };
  const condition = (field: string): Locator =>
    builder.locator(`[data-testid="search-builder-condition"][data-field="${field}"]`);

  // Tables and desks in walnut, oak or cherry, up to 1,500 euros, still sold.
  await addTo('description', 'Must');
  await condition('description').getByTestId('search-builder-value').fill('table desk');
  await addTo('wood', 'Filter');
  await condition('wood').getByTestId('search-builder-operator').selectOption('terms');
  await condition('wood').getByTestId('search-builder-value').fill('walnut, oak, cherry');
  await addTo('price', 'Filter');
  await condition('price').getByTestId('search-builder-operator').selectOption('range');
  await condition('price').getByTestId('search-builder-upper').fill('1500');
  await addTo('active', 'Filter');
  await condition('active').getByTestId('search-builder-value').selectOption('true');
  // The most expensive first.
  await addTo('price', /^Sort by/);
  await builder
    .getByTestId('search-builder-sort-entry')
    .getByRole('radio', { name: 'Descending' })
    .click();
  // Products per wood, with the lowest price of each.
  await addTo('wood', 'Aggregate: Terms');
  const byWood = builder.getByTestId('search-builder-agg').first();
  await byWood.getByTestId('search-builder-add-sub-agg').selectOption('min');
  await byWood
    .getByTestId('search-builder-agg')
    .last()
    .getByTestId('search-builder-agg-field')
    .selectOption('price');
  await builder.getByTestId('search-builder-tab-query').click();
  await documents().getByRole('button', { name: 'Search', exact: true }).click();
  await expect(documents().getByTestId('documents-total')).toContainText('matching');
  await capture(page, 'es-builder');

  // The aggregations: as built, and their buckets in place of the documents.
  await builder.getByTestId('search-builder-tab-aggs').click();
  await documents().getByTestId('documents-tab-aggregations').click();
  await expect(documents().getByTestId('search-aggregations')).toContainText('min_price');
  await capture(page, 'es-builder-aggregations');
});

test('es-documents', async () => {
  await closeTabs(page);
  await openProducts();
  const view = documents();
  await view.getByTestId('documents-query').fill('category:desks');
  await view.getByTestId('documents-sort').fill('[{"price": "desc"}]');
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(view.getByTestId('documents-loaded')).toContainText('loaded');
  // Select the first row's first cell (row marker 32 px, header 28 px, rows 26 px), then Edit.
  const box = await view.getByTestId('data-grid-canvas').boundingBox();
  if (!box) throw new Error('no grid');
  await page.mouse.click(box.x + 32 + 60, box.y + 28 + 13);
  await view.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: /^Edit / });
  const source = editor.getByTestId('document-source');
  await expect(source).toContainText('"lead_time_days"');
  // An edit made, not saved: a longer lead time and a new price, read from the stored source.
  const title = (await editor.getByRole('heading').first().innerText()).trim();
  const id = title.replace(/^Edit\s+/, '');
  const direct = await demoSearch();
  let stored: string;
  try {
    stored = (await direct.getDocument('products-v2', id)).source ?? '{}';
  } finally {
    await direct.close();
  }
  const product = JSON.parse(stored) as Record<string, unknown>;
  const edited = { ...product, price: 1849.0, lead_time_days: 42 };
  // Pasted, so the editor keeps the text as it is (typing would auto-indent and auto-close).
  await launched!.app.evaluate(
    ({ clipboard }, text) => clipboard.writeText(text),
    JSON.stringify(edited, null, 2),
  );
  await source.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(source).toContainText('"lead_time_days": 42');
  await capture(page, 'es-documents');
  await editor.getByRole('button', { name: 'Cancel' }).click();
});

test('es-sql', async () => {
  await closeTabs(page);
  await treeRow(page, 'SQL', search()).dblclick();
  const sql = visible(page, 'search-sql');
  await replaceText(
    page,
    sql.getByTestId('sql-editor'),
    'SELECT wood, COUNT(*) AS products, MIN(price) AS from_eur, MAX(price) AS to_eur\nFROM products\nWHERE active = true\nGROUP BY wood\nORDER BY wood',
  );
  await sql.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(sql.getByTestId('sql-row-count')).toHaveText('7 rows');
  await sql.getByRole('button', { name: 'Translate to DSL' }).click();
  await expect(sql.getByTestId('sql-dsl')).toContainText('"aggregations"');
  await capture(page, 'es-sql');

  // The same question in ES|QL.
  await sql.getByRole('radio', { name: 'ES|QL' }).click();
  await replaceText(
    page,
    sql.getByTestId('sql-editor'),
    'FROM products\n| WHERE active == true\n| STATS products = COUNT(*), avg_price = ROUND(AVG(price), 2) BY wood\n| SORT avg_price DESC',
  );
  await sql.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(sql.getByTestId('sql-row-count')).toHaveText('7 rows');
  await capture(page, 'es-esql');
});

test('es-cluster', async () => {
  await closeTabs(page);
  const direct = await demoSearch();
  try {
    await direct.putSettings('products-v2', '{"index": {"number_of_replicas": 1}}');
    await treeRow(page, 'Cluster', search()).dblclick();
    const cluster = visible(page, 'search-cluster');
    await expect(cluster.getByTestId('cluster-status')).toContainText(':');
    await cluster.getByRole('tab', { name: 'Shards' }).click();
    await expect(cluster.locator('[data-shard-state="UNASSIGNED"]').first()).toBeVisible();
    await cluster.getByRole('button', { name: 'Explain the first unassigned' }).click();
    const explain = page.getByTestId('allocation-explain');
    await expect(explain).toContainText('same_shard');
    await capture(page, 'es-cluster');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  } finally {
    await direct.putSettings('products-v2', '{"index": {"number_of_replicas": 0}}');
    await direct.close();
  }
});
