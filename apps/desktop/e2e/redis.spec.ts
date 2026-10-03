import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RedisSession } from '@querybara/driver-redis';

import { chooseEngine, launchApp, openNewConnection, type LaunchedApp } from './app';
import { connectRedis, deletePrefix, e2ePrefix, redisCommand, redisText } from './redis';

/**
 * The Redis module end to end against a real server (spec §5, §10): connect, browse the
 * namespace tree, edit a hash and a sorted set, set a TTL, rename and copy a key, bulk delete
 * by pattern with the dry-run count, the CLI with autocomplete, a Pub/Sub round trip, the INFO
 * dashboard and slow log, and the Cluster topology. Keys live under a prefix unique to the run,
 * deleted afterwards. Screenshots go to QUERYBARA_E2E_SHOTS when it is set.
 */

const REDIS_URL = process.env['QUERYBARA_TEST_REDIS_URL'];
const REDIS_CLUSTER = process.env['QUERYBARA_TEST_REDIS_CLUSTER'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E Redis';
const CLUSTER_NAME = 'E2E Redis Cluster';

test.skip(!REDIS_URL, 'Set QUERYBARA_TEST_REDIS_URL to run the Redis end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let redis: RedisSession | undefined;
const prefix = e2ePrefix();
const segment = prefix.split(':')[2]!;

test.beforeAll(async () => {
  redis = await connectRedis(REDIS_URL!);
  await redisCommand(redis, 'HSET', `${prefix}user:1`, 'name', 'Ada', 'lang', 'en');
  await redisCommand(redis, 'HSET', `${prefix}user:2`, 'name', 'Alan');
  await redisCommand(redis, 'ZADD', `${prefix}board`, '10', 'alice', '20', 'bob');
  await redisCommand(redis, 'SET', `${prefix}greeting`, 'hello');
  for (let i = 0; i < 30; i++) await redisCommand(redis, 'SET', `${prefix}tmp:${i}`, 'x');
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  if (redis) {
    await deletePrefix(redis, prefix);
    await redis.close();
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

function visible(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

async function openTool(profile: string, tool: string): Promise<void> {
  const item = profileItem(profile);
  const row = treeRow(item, tool);
  if (!(await row.isVisible())) await treeRow(item, 'Tools').click();
  await row.click();
}

test('connects and browses the namespace tree', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(REDIS_URL!);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await expect(dialog.getByTestId('connection-engine')).toHaveText('Redis');
  await dialog.getByLabel('Name', { exact: true }).fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const profile = profileItem(NAME);
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await treeRow(profile, 'db0').click();
  await treeRow(profile, 'querybara').click();
  await treeRow(profile, 'e2e').click();
  await treeRow(profile, segment).click();
  await expect(treeRow(profile, 'user')).toBeVisible();
  await expect(treeRow(profile, 'board')).toBeVisible();
  await expect(treeRow(profile, 'greeting')).toBeVisible();
  await expect(treeRow(profile, 'board').getByTestId('type-badge')).toHaveText('ZSET');
  // The namespace shows how many keys it holds.
  await expect(treeRow(profile, 'user')).toContainText('2');
});

test('opens a namespace in the key browser and a key in its editor', async () => {
  const profile = profileItem(NAME);
  await treeRow(profile, 'user').dblclick();
  const browser = visible('key-browser');
  await expect(browser).toBeVisible();
  await expect(browser.getByLabel('Key pattern')).toHaveValue(`${prefix}user:*`);
  await expect(browser.getByTestId('key-count')).toHaveText('2 keys loaded');
  await expect(browser.getByTestId('scan-complete')).toBeVisible();
  // The tree view opens down to the namespace the filter points into.
  const key = browser.locator('[data-testid="key-row"][data-name="1"]');
  await expect(key).toBeVisible();
  await expect(key.getByTestId('type-badge')).toHaveText('HASH');
  // MEMORY USAGE arrives for the rows on screen.
  await expect(key).toContainText(/\d+ B/);
  await shot('redis-key-browser');
  await browser.getByRole('radio', { name: 'List' }).click();
  await expect(
    browser.locator(`[data-testid="key-row"][data-name="${prefix}user:2"]`),
  ).toBeVisible();
  await browser.locator(`[data-testid="key-row"][data-name="${prefix}user:1"]`).click();
  await expect(visible('hash-editor')).toBeVisible();
});

test('edits a hash inline', async () => {
  const editor = visible('hash-editor');
  const row = editor.locator('[data-testid="grid-row"][data-key="name"]');
  await expect(row).toContainText('Ada');
  await row.dblclick();
  await row.getByLabel('Value').fill('Grace');
  await row.getByLabel('Value').press('Enter');
  await expect(row.getByLabel('Value')).toBeHidden();
  await expect(row).toContainText('Grace');
  expect(await redisText(redis!, 'HGET', `${prefix}user:1`, 'name')).toBe('Grace');

  await editor.getByRole('button', { name: '+ Add field' }).click();
  const add = editor.getByTestId('grid-add-row');
  await add.getByLabel('Field').fill('city');
  await add.getByLabel('Value').fill('Paris');
  await add.getByLabel('Value').press('Enter');
  await expect(editor.getByTestId('grid-row').filter({ hasText: 'city' })).toContainText('Paris');
  expect(await redisText(redis!, 'HGET', `${prefix}user:1`, 'city')).toBe('Paris');
  await shot('redis-hash-editor');
});

test('edits a sorted-set score', async () => {
  await treeRow(profileItem(NAME), 'board').click();
  const editor = visible('zset-editor');
  await expect(editor.getByTestId('grid-row').first()).toContainText('alice');
  const bob = editor.locator('[data-testid="grid-row"][data-key="bob"]');
  await bob.dblclick();
  await bob.getByLabel('Score').fill('5');
  await bob.getByLabel('Score').press('Enter');
  await expect(editor.getByTestId('grid-row').first()).toContainText('bob');
  await expect(editor.getByTestId('grid-row').first()).toContainText('5');
  expect(await redisText(redis!, 'ZSCORE', `${prefix}board`, 'bob')).toBe('5');
  await shot('redis-zset-editor');
});

test('sets a TTL, then renames and copies the key', async () => {
  await treeRow(profileItem(NAME), 'greeting').click();
  const editor = visible('value-editor');
  await expect(editor.getByTestId('string-value')).toHaveValue('hello');
  await editor.getByRole('button', { name: 'TTL…' }).click();
  const ttl = page.getByRole('dialog', { name: 'Time to live' });
  await ttl.getByLabel('Expire in').fill('120');
  await ttl.getByRole('button', { name: 'Set TTL' }).click();
  await expect(ttl).toBeHidden();
  await expect(editor.getByTestId('value-ttl')).toHaveText(/min/);
  expect(Number(await redisText(redis!, 'PTTL', `${prefix}greeting`))).toBeGreaterThan(100_000);

  await editor.getByRole('button', { name: 'Rename…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename key' });
  await rename.getByLabel('New name').fill(`${prefix}welcome`);
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(visible('value-key')).toHaveText(`${prefix}welcome`);
  expect(await redisText(redis!, 'EXISTS', `${prefix}greeting`)).toBe('0');
  expect(await redisText(redis!, 'GET', `${prefix}welcome`)).toBe('hello');

  await visible('value-editor').getByRole('button', { name: 'Copy…' }).click();
  const copy = page.getByRole('dialog', { name: 'Copy key' });
  await copy.getByLabel('Copy to key').fill(`${prefix}welcome-copy`);
  await copy.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(copy).toBeHidden();
  await expect(visible('value-key')).toHaveText(`${prefix}welcome-copy`);
  expect(await redisText(redis!, 'GET', `${prefix}welcome-copy`)).toBe('hello');
});

test('bulk deletes by pattern after a dry-run count', async () => {
  await page.locator('.dv-tab', { hasText: `${prefix}user:*` }).click();
  const browser = visible('key-browser');
  await browser.getByRole('button', { name: 'Bulk delete…' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete keys by pattern' });
  await dialog.getByLabel('Pattern').fill(`${prefix}tmp:*`);
  await dialog.getByRole('button', { name: 'Count matching keys' }).click();
  await expect(dialog.getByTestId('bulk-delete-status')).toHaveText(`30 keys match ${prefix}tmp:*`);
  // The dry run deleted nothing.
  expect(await redisText(redis!, 'EXISTS', `${prefix}tmp:0`)).toBe('1');
  await dialog.getByRole('button', { name: 'Delete 30 keys' }).click();
  await expect(dialog.getByTestId('bulk-delete-status')).toHaveText('Deleted 30 keys');
  expect(await redisText(redis!, 'EXISTS', `${prefix}tmp:0`, `${prefix}tmp:29`)).toBe('0');
  await dialog.getByRole('button', { name: 'Close' }).click();
});

test('runs commands in the CLI with autocomplete', async () => {
  await page.getByRole('button', { name: 'New query' }).click();
  const cli = visible('redis-cli');
  const input = cli.getByTestId('cli-input');
  await input.click();
  await input.pressSequentially('HSE');
  const suggestions = cli.getByTestId('cli-suggestions');
  await expect(suggestions).toContainText('HSET');
  await expect(suggestions).toContainText('HSETNX');
  await shot('redis-cli-autocomplete');
  await input.fill('');
  await input.pressSequentially('hse');
  await input.press('Tab');
  await expect(input).toHaveValue('HSET ');
  await expect(cli.getByTestId('cli-docs')).toContainText('HSET key');
  await expect(cli.getByTestId('cli-next-args')).toContainText('key');
  await input.pressSequentially(`${prefix}cli name "hello world"`);
  await input.press('Enter');
  await expect(cli.getByTestId('cli-reply').last()).toHaveText('(integer) 1');
  await input.pressSequentially(`HGET ${prefix}cli name`);
  await input.press('Enter');
  await expect(cli.getByTestId('cli-reply').last()).toHaveText('"hello world"');
  expect(await redisText(redis!, 'HGET', `${prefix}cli`, 'name')).toBe('hello world');
  // History: ↑ brings the last command back.
  await input.press('ArrowUp');
  await expect(input).toHaveValue(`HGET ${prefix}cli name`);
  await input.fill('SUBSCRIBE news');
  await input.press('Enter');
  const refused = cli.getByTestId('cli-error').last();
  await expect(refused).toContainText('Pub/Sub');
  await expect(refused.getByRole('button', { name: 'Open Pub/Sub' })).toBeVisible();
  await cli.getByRole('radio', { name: 'Raw RESP' }).click();
  await expect(cli.getByTestId('cli-reply').last()).toContainText('$11\\r\\n');
});

test('round-trips a Pub/Sub message', async () => {
  await openTool(NAME, 'Pub/Sub');
  const pubsub = visible('pubsub');
  await pubsub.getByLabel('Channels').fill(`${prefix}chan`);
  await pubsub.getByRole('button', { name: 'Subscribe' }).click();
  await expect(pubsub.getByTestId('subscription-state')).toContainText('Subscribed to');
  await pubsub.getByLabel('Publish channel').fill(`${prefix}chan`);
  await pubsub.getByLabel('Message', { exact: true }).fill('ping');
  await expect(async () => {
    await pubsub.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(pubsub.getByTestId('published')).toHaveText('Delivered to 1 subscribers', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(pubsub.getByTestId('pubsub-message').first()).toContainText('ping');
  await pubsub.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(pubsub.getByTestId('subscription-state')).toHaveText('Not subscribed');
});

test('shows the INFO dashboard and the slow log', async () => {
  await openTool(NAME, 'INFO dashboard');
  const dashboard = visible('info-dashboard');
  await expect(dashboard.getByTestId('stat-Memory')).toHaveText(/\d/);
  await expect(dashboard.getByTestId('stat-Keys')).toHaveText(/\d/);
  await expect(dashboard.getByTestId('keyspace')).toContainText('db0');
  await expect(dashboard.getByTestId('replication-role')).toContainText('primary');
  await shot('redis-info-dashboard');
  await openTool(NAME, 'Slow log');
  const slowlog = visible('slowlog');
  await expect(slowlog.getByRole('table', { name: 'Slow log entries' })).toBeVisible();
});

test('creates a search index from suggested fields, queries it and drops it', async () => {
  const supported = await redis!.searchIndexes().then(
    () => true,
    () => false,
  );
  test.skip(!supported, 'The server has no search module (Redis 8, Redis Stack, valkey-search)');
  const index = `${segment}_books`;
  for (const [id, title, year, tags] of [
    ['1', 'Dune', '1965', 'scifi,classic'],
    ['2', 'Neuromancer', '1984', 'scifi,cyberpunk'],
    ['3', 'Emma', '1815', 'classic,romance'],
  ] as const) {
    await redisCommand(
      redis!,
      'HSET',
      `${prefix}book:${id}`,
      'title',
      title,
      'year',
      year,
      'tags',
      tags,
    );
  }

  await openTool(NAME, 'Search indexes');
  const panel = visible('redis-search');
  await panel.getByRole('button', { name: 'New index…' }).first().click();
  const dialog = page.getByTestId('search-create-dialog');
  await dialog.getByLabel('Index name').fill(index);
  await dialog.getByLabel('Key prefixes').fill(`${prefix}book:`);
  await dialog.getByRole('button', { name: 'Suggest from keys' }).click();
  const rows = dialog.getByTestId('search-field-row');
  await expect(rows).toHaveCount(3);
  await expect(
    rows.filter({ has: page.locator('input[value="year"]') }).getByLabel('Type'),
  ).toHaveValue('NUMERIC');
  await expect(
    rows.filter({ has: page.locator('input[value="tags"]') }).getByLabel('Type'),
  ).toHaveValue('TAG');
  await expect(page.getByTestId('search-create-preview')).toContainText(
    `FT.CREATE ${index} ON HASH PREFIX 1 ${prefix}book: SCHEMA`,
  );
  await shot('redis-search-create');
  await page.getByTestId('search-create').click();
  await expect(dialog).toBeHidden();

  // The new index opens on its query view, every document listed.
  const header = panel.getByTestId('search-header');
  await expect(header).toContainText(index);
  await expect(panel.getByTestId('search-figures')).toContainText('3 documents');
  await expect(panel.getByTestId('search-total')).toHaveText('3 documents match');
  await panel.getByTestId('search-query').fill('@tags:{scifi}');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByTestId('search-total')).toHaveText('2 documents match');
  await expect(panel.getByTestId('search-document').first()).toContainText(`${prefix}book:`);
  await panel.getByRole('button', { name: 'Explain' }).click();
  await expect(panel.getByTestId('search-explain')).toContainText('TAG:@tags');
  await shot('redis-search-query');

  await panel.getByRole('button', { name: /^Schema/ }).click();
  await expect(panel.getByTestId('search-field')).toHaveCount(3);
  await expect(panel.getByTestId('search-create-command')).toContainText(
    'SCHEMA tags TAG title TEXT year NUMERIC SORTABLE',
  );

  await panel.getByRole('button', { name: 'Drop…' }).click();
  await panel.getByRole('menuitem', { name: /Drop the index and its documents/ }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(`FT.DROPINDEX ${index} DD`);
  await confirm.getByRole('button', { name: 'Drop' }).click();
  await expect(panel.getByTestId('search-index').filter({ hasText: index })).toHaveCount(0);
  expect(await redisText(redis!, 'EXISTS', `${prefix}book:1`)).toBe('0');
});

test('analyses an RDB dump file offline', async () => {
  const dump = join(
    import.meta.dirname,
    '../../../packages/redis-tools/test/fixtures/rdb/redis-8.2.rdb',
  );
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, dump);
  await openTool(NAME, 'Dump analysis');
  const panel = visible('dump-analysis');
  await expect(panel.getByText('See what fills a Redis server')).toBeVisible();
  await shot('redis-dump-welcome');
  await panel.getByRole('button', { name: 'Choose RDB file…' }).first().click();

  const report = panel.getByTestId('dump-report');
  await expect(report.getByTestId('dump-file')).toHaveText('redis-8.2.rdb');
  await expect(report).toContainText(/Redis 8\.2\.\d+ · RDB 12/);
  await expect(report.getByTestId('stat-Keys')).toHaveText('23');
  // Types with their encodings, module types named by module.
  await expect(report.getByTestId('dump-type').first()).toContainText('HASH');
  await expect(report.getByRole('table', { name: 'Types' })).toContainText('ReJSON-RL');
  await expect(report.getByRole('table', { name: 'Types' })).toContainText('hashtable');
  // Patterns: the three profiles in database 3 are one.
  const profiles = report.getByTestId('dump-pattern').filter({ hasText: 'user:*:profile' });
  await expect(profiles).toContainText('3');
  await expect(report.getByTestId('dump-biggest').first()).toContainText('hash:big');
  await expect(report.getByTestId('dump-longest').first()).toContainText('list:big');
  await expect(report.getByRole('table', { name: 'Databases' })).toContainText('db3');
  await shot('redis-dump-analysis');
});

test('shows the Cluster topology with the slot map', async () => {
  test.skip(!REDIS_CLUSTER, 'Set QUERYBARA_TEST_REDIS_CLUSTER for the Cluster topology');
  const [seed] = REDIS_CLUSTER!.split(',');
  const [host, port] = seed!.trim().split(':') as [string, string];
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await chooseEngine(dialog, 'Redis');
  await dialog.getByLabel('Name', { exact: true }).fill(CLUSTER_NAME);
  await dialog.getByLabel('Connect with', { exact: true }).selectOption('cluster');
  await dialog.getByLabel('Seed 1', { exact: true }).fill(host);
  await dialog.getByLabel('Seed 1 port', { exact: true }).fill(port);
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('password');
  await dialog
    .getByLabel('Password', { exact: true })
    .fill(decodeURIComponent(new URL(REDIS_URL!).password));
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = profileItem(CLUSTER_NAME);
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  // Cluster primaries replace the logical databases at the root of the tree.
  await expect(treeRow(profile, `${host}:${port}`)).toBeVisible();
  await openTool(CLUSTER_NAME, 'Topology');
  const topology = visible('topology');
  await expect(topology.getByTestId('topology-mode')).toHaveText('cluster');
  await expect(topology.getByTestId('slot-map').locator('rect')).not.toHaveCount(0);
  await expect(topology.getByTestId('topology-node')).not.toHaveCount(0);
  await shot('redis-topology');

  await openTool(CLUSTER_NAME, 'CLI');
  const cli = visible('redis-cli');
  await cli.getByTestId('cli-input').pressSequentially(`HGET ${prefix}cli name`);
  await cli.getByTestId('cli-input').press('Enter');
  // The answering node is shown next to the command.
  await expect(cli.getByTestId('cli-entry').last()).toContainText(/:\d{4,5}/);
});
