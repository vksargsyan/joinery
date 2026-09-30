import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { SearchSession } from '@joinery/driver-elasticsearch';
import { parseJsonTree, stringAt } from '@joinery/search-tools';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connectSearch, e2eIndex } from './search';

/**
 * The Elasticsearch module's documents, queries and index management end to end (spec §11):
 * the document grid pages past its first page and edits a document through the conflict path;
 * the query builder builds a query, a sort and aggregations, and reads typed Query DSL back;
 * SQL runs and translates to Query DSL whose aggregations show as a table; an index is created
 * from the explorer, reindexed with a changed mapping (a server task) with its alias moved in
 * the same plan, and the alias is swapped back from the aliases panel. Indices are named for
 * the run and deleted afterwards.
 */

const ES_URL = process.env['JOINERY_TEST_ELASTICSEARCH_URL'];
const SHOTS = process.env['JOINERY_E2E_SHOTS'];
const NAME = 'E2E Search Module';

test.skip(!ES_URL, 'Set JOINERY_TEST_ELASTICSEARCH_URL to run the Elasticsearch end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: SearchSession | undefined;
const prefix = e2eIndex();
const docs = `${prefix}-docs`;
const v1 = `${prefix}-orders-v1`;
const v2 = `${prefix}-orders-v2`;
const alias = `${prefix}-orders`;
const TOTAL = 250;
const repository = `${prefix}-repo`;
const restored = `restored-${docs}`;
let repoDir: string | undefined;

test.beforeAll(async () => {
  direct = await connectSearch(ES_URL!);
  await direct.createIndex(
    docs,
    JSON.stringify({
      settings: { number_of_replicas: 0 },
      mappings: {
        properties: {
          n: { type: 'long' },
          team: { type: 'keyword' },
          name: { type: 'keyword' },
          customer: { properties: { city: { type: 'keyword' } } },
        },
      },
    }),
  );
  const lines: string[] = [];
  for (let n = 0; n < TOTAL; n++) {
    lines.push(
      `{"index": {"_id": "doc-${n}"}}`,
      `{"n": ${n}, "team": "t${n % 3}", "name": "name ${n}", "big": 1234567890123456789, "customer": {"city": "c${n % 5}"}}`,
    );
  }
  await direct.bulk(lines.join('\n'), { index: docs, refresh: true });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  if (direct) {
    await direct.deleteSnapshot(repository, 'nightly').catch(() => undefined);
    await direct.deleteResource('snapshot-repository', repository).catch(() => undefined);
    for (const index of [docs, v1, v2, restored]) {
      await direct.request({ method: 'DELETE', path: `/${index}` }).catch(() => undefined);
    }
    await direct.close();
  }
  if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function profileItem(): Locator {
  return page.getByRole('treeitem', { name: NAME, exact: true });
}

function treeRow(text: string): Locator {
  return profileItem()
    .locator('[data-tree-row]')
    .filter({ has: page.getByText(text, { exact: true }) });
}

function visible(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

async function menu(row: Locator, item: string): Promise<void> {
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Replaces the text of a Monaco editor (typed as one input, so brackets are not auto-closed). */
async function replaceEditorText(editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** A grid cell through Glide's accessibility table (the first data column is 1). */
function cell(scope: Locator, column: number, row: number): Locator {
  return scope.getByTestId(`glide-cell-${column + 1}-${row}`);
}

test('connects to Elasticsearch and lists the indices', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Database engine', { exact: true }).selectOption('elasticsearch');
  await dialog.getByLabel('Paste a URI to fill the form').fill(ES_URL!);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await profileItem().locator('[data-tree-row]').first().dblclick();
  await expect(profileItem().getByText('Connected', { exact: true })).toBeAttached();
  for (const tool of ['Console', 'SQL', 'Cluster', 'Templates and pipelines', 'Snapshots']) {
    await expect(treeRow(tool)).toBeVisible();
  }
  await treeRow('Indices').click();
  await expect(treeRow(docs)).toBeVisible();
});

test('browses documents in a grid and pages past the first page', async () => {
  await treeRow(docs).dblclick();
  const view = visible('search-documents');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('documents-loaded')).toHaveText('100 loaded');
  await expect(view.getByTestId('documents-total')).toHaveText(`· ${TOTAL} matching`);
  await expect(view.getByTestId('documents-paging')).toHaveText('· point in time');
  // Sort by n, so the last row is known.
  await view.getByTestId('documents-sort').fill('[{"n": "asc"}]');
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(view.getByTestId('documents-loaded')).toHaveText('100 loaded');
  await expect(cell(view, 0, 0)).toHaveText('doc-0');
  // Flattened fields: the mapped ones first, then the nested and unmapped ones.
  const grid = view.getByTestId('data-grid-canvas');
  const box = await grid.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 100 * 26);
  await expect(view.getByTestId('documents-loaded')).toHaveText('200 loaded');
  await page.mouse.wheel(0, 100 * 26);
  await expect(view.getByTestId('documents-loaded')).toHaveText(`${TOTAL} loaded`);
  await expect(view.getByText('All matching documents are loaded.')).toBeVisible();
  await page.mouse.wheel(0, 100 * 26);
  await expect(cell(view, 0, TOTAL - 1)).toHaveText(`doc-${TOTAL - 1}`);
  // Columns: _id, then the mapped fields as the server lists them (alphabetically): big,
  // customer.city, n, name, team.
  await expect(cell(view, 1, TOTAL - 1)).toHaveText('1234567890123456789');
  await expect(cell(view, 2, TOTAL - 1)).toHaveText('c4');
  await shot('search-documents');
});

test('edits a document, and shows the stored version when it changed meanwhile', async () => {
  const view = visible('search-documents');
  await view.getByTestId('documents-query').fill('n:7');
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(view.getByTestId('documents-loaded')).toHaveText('1 loaded');
  // Select the row's first cell (row marker 32 px, header 28 px, rows 26 px), then Edit.
  const box = await view.getByTestId('data-grid-canvas').boundingBox();
  await page.mouse.click(box!.x + 32 + 60, box!.y + 28 + 13);
  await view.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit doc-7' });
  await expect(editor.getByTestId('document-source')).toContainText('"name": "name 7"');
  await replaceEditorText(
    editor.getByTestId('document-source'),
    '{"n": 7, "team": "t1", "name": "edited in the app", "big": 1234567890123456789}',
  );
  // Someone else changes the document before it is saved.
  await direct!.indexDocument(docs, '{"n": 7, "team": "t1", "name": "changed elsewhere"}', {
    id: 'doc-7',
    refresh: true,
  });
  await editor.getByTestId('document-save').click();
  const conflict = editor.getByTestId('document-conflict');
  await expect(conflict).toBeVisible();
  await expect(editor.getByTestId('document-current')).toContainText('changed elsewhere');
  await shot('search-document-conflict');
  // Overwrite theirs after a confirmation.
  await editor.getByTestId('document-overwrite').click();
  const confirm = page.getByRole('alertdialog').last();
  await expect(confirm).toContainText('Overwrite the newer version?');
  await confirm.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(view.getByTestId('search-notice')).toHaveText('Saved doc-7');
  await expect(cell(view, 4, 0)).toHaveText('edited in the app');
  const stored = await direct!.getDocument(docs, 'doc-7');
  expect(stringAt(parseJsonTree(stored.source!), 'name')).toBe('edited in the app');
  expect(stored.source).toContain('1234567890123456789');
});

test('builds a query, a sort and aggregations visually, and reads typed Query DSL back', async () => {
  const view = visible('search-documents');
  await view.getByRole('radio', { name: 'Builder' }).click();
  const builder = view.getByTestId('search-builder');
  await expect(builder).toBeVisible();
  // The bar's Lucene query from the last test shows as a condition; start over.
  await expect(builder.getByTestId('search-builder-condition').first()).toHaveAttribute(
    'data-operator',
    'query_string',
  );
  await builder.getByRole('button', { name: 'Clear all' }).click();
  await expect(builder.getByTestId('search-builder-condition')).toHaveCount(0);

  // team is t1, as a filter.
  await builder.getByRole('button', { name: 'Add team to…' }).click();
  await page.getByRole('menuitem', { name: 'Filter' }).click();
  const team = builder.locator('[data-testid="search-builder-condition"][data-field="team"]');
  await expect(team.getByTestId('search-builder-value')).toBeFocused();
  await expect(view.getByTestId('search-builder-pending')).toContainText('team: type a value');
  // Pick t1 from the field's most common values.
  await team.getByTestId('search-builder-top-values').click();
  const topValues = page.getByTestId('search-builder-top-value');
  await expect(topValues).toHaveCount(3);
  await shot('search-builder-top-values');
  await topValues.filter({ hasText: 't1' }).click();
  await expect(team.getByTestId('search-builder-value')).toHaveValue('t1');
  // 100 ≤ n < 200, dragged into Must.
  const must = builder.locator('[data-testid="search-builder-section"][data-occur="must"]');
  await builder
    .locator('[data-testid="search-builder-field"][data-path="n"]')
    .dragTo(must.getByText('drop fields or clauses here'));
  const n = builder.locator('[data-testid="search-builder-condition"][data-field="n"]');
  await n.getByTestId('search-builder-operator').selectOption('range');
  await n.getByTestId('search-builder-lower').fill('100');
  await n.getByTestId('search-builder-upper').fill('200');
  await n.getByLabel('n upper bound').selectOption('ex');
  await expect(view.getByTestId('documents-built-query')).toContainText(
    '{"bool": {"must": [{"range": {"n": {"gte": 100, "lt": 200}}}], "filter": [{"term": {"team": "t1"}}]}}',
  );
  await shot('search-builder-query');

  // Sort by n, descending.
  await builder.getByTestId('search-builder-tab-sort').click();
  await builder.getByTestId('search-builder-add-sort').selectOption('n');
  const sortKey = builder.getByTestId('search-builder-sort-entry');
  await sortKey.getByRole('radio', { name: 'Descending' }).click();
  // Documents per city, with the stats of n in each.
  await builder.getByRole('button', { name: 'Add customer.city to…' }).click();
  await page.getByRole('menuitem', { name: 'Aggregate: Terms' }).click();
  const city = builder.locator('[data-testid="search-builder-agg"][data-name="by_customer_city"]');
  await city.getByTestId('search-builder-add-sub-agg').selectOption('stats');
  const stats = city.locator('[data-testid="search-builder-agg"][data-name="stats_field"]');
  await stats.getByTestId('search-builder-agg-field').selectOption('n');
  await expect(
    city.locator('[data-testid="search-builder-agg"][data-name="stats_n"]'),
  ).toBeVisible();
  await shot('search-builder-aggregations');
  await builder.getByTestId('search-builder-tab-request').click();
  await expect(builder.getByTestId('search-builder-request-text')).toContainText(
    `GET /${docs}/_search`,
  );
  await expect(builder.getByTestId('search-builder-request-text')).toContainText('"stats_n": {');

  await view.getByRole('button', { name: 'Search', exact: true }).click();
  // n in [100, 200) with n % 3 === 1: 100, 103, … 199.
  await expect(view.getByTestId('documents-total')).toHaveText('· 34 matching');
  await expect(cell(view, 0, 0)).toHaveText('doc-199');
  await view.getByTestId('documents-tab-aggregations').click();
  const aggregations = view.getByTestId('search-aggregations');
  await expect(aggregations).toContainText('by_customer_city');
  await expect(aggregations).toContainText('stats_n');
  await shot('search-builder-results');
  await view.getByTestId('documents-tab-documents').click();

  // Typed Query DSL comes back into the builder; what it does not break down stays JSON.
  await view.getByRole('radio', { name: 'Text' }).click();
  await expect(view.getByTestId('documents-sort')).toHaveValue('[{"n": "desc"}]');
  await view
    .getByTestId('documents-query')
    .fill('{"bool": {"filter": [{"term": {"team": "t2"}}, {"ids": {"values": ["doc-2"]}}]}}');
  await view.getByRole('radio', { name: 'Builder' }).click();
  await builder.getByTestId('search-builder-tab-query').click();
  const filter = builder.locator('[data-testid="search-builder-section"][data-occur="filter"]');
  await expect(filter.getByTestId('search-builder-condition')).toHaveAttribute(
    'data-field',
    'team',
  );
  await expect(filter.getByTestId('search-builder-json').getByRole('textbox')).toHaveValue(
    '{"ids": {"values": ["doc-2"]}}',
  );
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(view.getByTestId('documents-total')).toHaveText('· 1 matching');
  // Back to plain text for the tests after this one.
  await builder.getByRole('button', { name: 'Clear all' }).click();
  await view.getByRole('radio', { name: 'Text' }).click();
});

test('runs SQL and translates it to Query DSL with its aggregations as a table', async () => {
  await treeRow('SQL').dblclick();
  const sql = visible('search-sql');
  await expect(sql).toBeVisible();
  await replaceEditorText(
    sql.getByTestId('sql-editor'),
    `SELECT team, COUNT(*) AS c FROM "${docs}" GROUP BY team ORDER BY team`,
  );
  await sql.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(sql.getByTestId('sql-row-count')).toHaveText('3 rows');
  const results = sql.getByTestId('sql-results');
  await expect(results.locator('tbody tr').first()).toHaveText(/t0\s*84/);
  await sql.getByRole('button', { name: 'Translate to DSL' }).click();
  await expect(sql.getByTestId('sql-dsl')).toContainText('"aggregations"');
  await sql.getByRole('button', { name: 'Run DSL' }).click();
  const aggregations = sql.getByTestId('search-aggregations');
  await expect(aggregations).toBeVisible();
  await aggregations.getByRole('radio', { name: 'Table' }).click();
  const table = aggregations.getByTestId('aggregation-table');
  await expect(table).toContainText('t0');
  await expect(table).toContainText('84');
  await shot('search-sql-translate');
});

test('creates an index, reindexes it with a changed mapping and moves its alias', async () => {
  await menu(treeRow('Indices'), 'Create index…');
  const dialog = page.getByRole('dialog', { name: 'Create index' });
  await dialog.getByLabel('Name', { exact: true }).fill(v1);
  await dialog.getByLabel('Replicas').fill('0');
  await dialog.getByLabel('Aliases (comma-separated)').fill(alias);
  await replaceEditorText(
    dialog.getByTestId('create-index-mappings'),
    '{"properties": {"total": {"type": "long"}, "sku": {"type": "keyword"}}}',
  );
  await expect(dialog.getByTestId('create-index-preview')).toContainText(`PUT /${v1}`);
  await dialog.getByTestId('create-index-submit').click();
  await expect(dialog).toBeHidden();
  const panel = visible('search-index');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('index-facts')).toContainText('open');
  await expect(treeRow(v1)).toBeVisible();

  await direct!.bulk(
    Array.from({ length: 30 }, (_, i) => `{"index": {}}\n{"total": ${i}, "sku": "s${i}"}`).join(
      '\n',
    ),
    { index: v1, refresh: true },
  );

  // Changing a field's type cannot happen in place: the editor says so and plans a reindex.
  await panel.getByRole('tab', { name: 'Mappings' }).click();
  await expect(panel.getByTestId('mapping-fields')).toContainText('total');
  await replaceEditorText(
    panel.getByTestId('mapping-editor'),
    '{"properties": {"total": {"type": "double"}, "sku": {"type": "keyword"}}}',
  );
  await panel.getByRole('button', { name: 'Check changes' }).click();
  await expect(panel.getByTestId('mapping-plan')).toContainText('cannot change');
  await panel.getByRole('button', { name: 'Reindex with this mapping…' }).click();
  const plan = page.getByRole('dialog', { name: `Reindex ${v1}` });
  await expect(plan.getByRole('textbox', { name: 'New index' })).toHaveValue(v2);
  await expect(plan.getByTestId('reindex-plan')).toContainText(
    `Move ${alias} to ${v2} in one step`,
  );
  await shot('search-reindex-plan');
  await plan.getByTestId('reindex-run').click();
  await expect(plan).toBeHidden();
  await expect(panel.getByTestId('reindex-progress')).toContainText('Reindex finished');
  await expect(panel.getByTestId('reindex-counts')).toContainText('30 of 30 copied');

  expect(await direct!.count(v2)).toBe(30);
  const mapping = parseJsonTree(await direct!.getMapping(v2));
  expect(stringAt(mapping, v2, 'mappings', 'properties', 'total', 'type')).toBe('double');
  const aliases = await direct!.listAliases();
  expect(aliases.filter((a) => a.alias === alias).map((a) => a.index)).toEqual([v2]);
});

test('swaps the alias back in one step from the aliases panel', async () => {
  await treeRow('Templates and pipelines').dblclick();
  const admin = visible('search-admin');
  await expect(admin).toBeVisible();
  await expect(admin.getByTestId('admin-aliases')).toContainText(alias);
  await admin.getByLabel('Alias', { exact: true }).last().selectOption(alias);
  await admin.getByLabel('Move it to').selectOption(v1);
  await admin.getByRole('button', { name: 'Swap…' }).click();
  await expect(admin.getByTestId('search-notice')).toHaveText('Aliases changed');
  const aliases = await direct!.listAliases();
  expect(aliases.filter((a) => a.alias === alias).map((a) => a.index)).toEqual([v1]);
  await expect(admin.locator(`[data-alias="${alias}"]`)).toContainText(v1);
  await shot('search-aliases');
});

test('shows cluster health, explains an unassigned shard and the disk watermarks', async () => {
  // A replica on a one-node cluster cannot be assigned.
  const nodes = await direct!.nodes();
  await direct!.putSettings(v2, '{"index": {"number_of_replicas": 1}}');
  await treeRow('Cluster').dblclick();
  const cluster = visible('search-cluster');
  await expect(cluster.getByTestId('cluster-status')).toContainText(':');
  await expect(cluster.getByTestId('cluster-nodes')).toContainText(nodes[0]!.name);
  await cluster.getByRole('tab', { name: 'Shards' }).click();
  await cluster.getByLabel('Filter shards by index').fill(v2);
  if (nodes.length === 1) {
    await expect(cluster.locator('[data-shard-state="UNASSIGNED"]')).toHaveCount(1);
    await cluster.getByRole('button', { name: 'Explain the first unassigned' }).click();
    const explain = page.getByTestId('allocation-explain');
    await expect(explain).toContainText('same_shard');
    await shot('search-allocation-explain');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  }
  await cluster.getByRole('tab', { name: 'Disk' }).click();
  await expect(cluster.getByTestId('cluster-watermarks')).toContainText('Flood stage');
  await expect(cluster.getByTestId('cluster-disks')).toContainText(nodes[0]!.name);
  await shot('search-cluster-disk');
  await direct!.putSettings(v2, '{"index": {"number_of_replicas": 0}}');
});

test('snapshots an index into a file system repository and restores it renamed', async () => {
  const settings = await direct!.request({
    method: 'GET',
    path: '/_nodes/settings',
    query: 'filter_path=nodes.*.settings.path.repo',
  });
  const base = /"repo"\s*:\s*\[\s*"([^"]+)"/.exec(settings.body)?.[1];
  test.skip(base === undefined, 'The server has no path.repo, so it refuses fs repositories');
  repoDir = `${base}/${prefix}`;
  await treeRow('Snapshots').dblclick();
  const snapshots = visible('search-snapshots');
  await snapshots.getByRole('button', { name: 'Register repository…' }).click();
  const register = page.getByRole('dialog', { name: 'Register a snapshot repository' });
  await register.getByLabel('Name', { exact: true }).fill(repository);
  await register.getByLabel(/Location/).fill(repoDir);
  await register.getByRole('button', { name: 'Register…' }).click();
  await expect(register).toBeHidden();
  await expect(snapshots.getByTestId('snapshot-repositories')).toContainText(repository);

  await snapshots.getByRole('button', { name: 'New snapshot…' }).click();
  const create = page.getByRole('dialog', { name: 'New snapshot' });
  await create.getByLabel('Name (lower case)').fill('nightly');
  await create.getByLabel(/^Indices/).fill(docs);
  await create.getByRole('button', { name: 'Create…' }).click();
  await expect(create).toBeHidden();
  const row = snapshots.locator('[data-snapshot="nightly"]');
  await expect(row).toContainText('success', { timeout: 60_000 });

  await row.getByRole('button', { name: 'Restore…' }).click();
  const restore = page.getByRole('dialog', { name: 'Restore nightly' });
  await expect(restore.getByTestId('restore-preview')).toContainText(`${docs} → ${restored}`);
  await restore.getByRole('button', { name: 'Restore…' }).click();
  // A restore is destructive: it always asks.
  const confirm = page.getByRole('alertdialog').last();
  await expect(confirm).toContainText('restores indices from a snapshot');
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(snapshots.getByTestId('search-notice')).toContainText('Restoring nightly');
  await expect
    .poll(async () => (await direct!.request({ method: 'HEAD', path: `/${restored}` })).status)
    .toBe(200);
  await direct!.clusterHealth({ index: restored, waitForStatus: 'green' });
  expect(await direct!.count(restored)).toBe(TOTAL);
  await shot('search-snapshots');
});
