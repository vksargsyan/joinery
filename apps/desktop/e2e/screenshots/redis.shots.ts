import {
  createRedisAdapter,
  redisProfileFromUrl,
  type RedisSession,
} from '@querybara/driver-redis';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { chooseEngine, connectionTab, openNewConnection, type LaunchedApp } from '../app';
import {
  addConnection,
  capture,
  connectProfile,
  DEMO,
  DEMO_CA,
  launchForShots,
  type DemoProfile,
} from './harness';
import { closeTabs, openTool, profileItem, splitTab, treeRow, visible } from './nosql';

/**
 * Redis scenes on the demo server (Larchwood's sessions, carts, leaderboards, order stream and
 * product search index), the dump of the same data, and the demo Cluster: the key browser with
 * a cart hash, the order stream's consumer group, the CLI, the INFO dashboard with the slow log,
 * the Cluster topology, a search index query and the dump analysis. Nothing is written to the
 * servers; the dashboard scene only reads.
 */

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;

const CART = 'cart:1705';
const DUMP = process.env['QUERYBARA_DEMO_RDB'] ?? '/tmp/larchwood-files/larchwood.rdb';

test.beforeAll(async () => {
  launched = await launchForShots();
  page = launched.page;
  await addConnection(page, DEMO.redis);
  await connectProfile(page, DEMO.redis.name);
});

test.afterAll(async () => {
  await launched?.close();
});

function sessions(): Locator {
  return profileItem(page, DEMO.redis.name);
}

/**
 * The Cluster profile: the form is switched to "Cluster" with the URI's node as the seed, then
 * verified against the demo CA like the others.
 */
async function addClusterConnection(profile: DemoProfile): Promise<void> {
  const url = new URL(profile.uri);
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await chooseEngine(dialog, 'Redis');
  await dialog.getByLabel('Name', { exact: true }).fill(profile.name);
  await dialog.getByLabel('Environment').selectOption(profile.environment);
  await dialog.getByLabel('Connect with', { exact: true }).selectOption('cluster');
  await dialog.getByLabel('Seed 1', { exact: true }).fill(url.hostname);
  await dialog.getByLabel('Seed 1 port', { exact: true }).fill(url.port);
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('password');
  await dialog.getByLabel('Password', { exact: true }).fill(decodeURIComponent(url.password));
  await dialog.getByLabel('Password storage').selectOption('session');
  await connectionTab(dialog, 'TLS');
  await dialog.getByLabel('TLS mode').selectOption('verify-full');
  await dialog.locator('#cx-ca').fill(DEMO_CA);
  await connectionTab(dialog, 'General');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(profileItem(page, profile.name)).toBeVisible();
}

/** A direct session on the demo server, as the storefront would hold. */
async function demoRedis(): Promise<RedisSession> {
  const session = await createRedisAdapter().connect(
    redisProfileFromUrl(DEMO.redis.uri, { tls: { mode: 'verify-full', caPath: DEMO_CA } }),
  );
  await session.command(['CLIENT', 'SETNAME', 'storefront']);
  return session;
}

/** Read-only Lua reports that walk the keyspace: slow enough to land in the slow log. */
const REPORTS = [
  "local n = 0 for r = 1, ARGV[1] do for _, k in ipairs(redis.call('KEYS', 'cart:*')) do n = n + #redis.call('HVALS', k) end end return n",
  "local s = 0 for r = 1, ARGV[1] do for _, k in ipairs(redis.call('KEYS', 'stock:*')) do s = s + redis.call('GET', k) end end return s",
];

/**
 * Reads like a storefront's while `load.running`: carts, stock and the bestseller board at a
 * rate that rises and falls, some session lookups that miss, and a report now and then. Writes
 * nothing.
 */
async function storefrontLoad(
  session: RedisSession,
  load: { readonly running: boolean },
): Promise<void> {
  const carts = ['cart:7379', 'cart:5450', 'cart:2443', 'cart:2785', 'cart:4906'];
  const start = Date.now();
  let tick = 0;
  while (load.running) {
    const wave = 0.5 + 0.5 * Math.sin((Date.now() - start) / 4_000);
    const burst = 20 + Math.round(120 * wave);
    for (let i = 0; i < burst; i++) {
      await session.command(['HGETALL', carts[i % carts.length]!]);
      await session.command(['GET', `stock:${1001 + (i % 30)}`]);
      if (i % 7 === 0) await session.command(['GET', `session:${(tick * 31 + i).toString(16)}`]);
      if (i % 10 === 0) {
        await session.command(['ZREVRANGE', 'leaderboard:bestsellers:2026-09', '0', '9']);
      }
    }
    if (tick % 8 === 5) {
      const report = (tick - 5) / 8;
      await session.command(['EVAL', REPORTS[report % 2]!, '0', String(200 + (report % 6) * 70)]);
    }
    tick += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test('redis-browser', async () => {
  await closeTabs(page);
  await treeRow(page, 'db0', sessions()).click();
  await treeRow(page, 'cart', sessions()).dblclick();
  const browser = visible(page, 'key-browser');
  await expect(browser.getByTestId('scan-complete')).toBeVisible();
  await browser.locator('[data-testid="key-row"][data-name="1705"]').click();
  await expect(visible(page, 'hash-editor')).toBeVisible();
  await expect(visible(page, 'value-ttl')).toHaveText(/\d/);
  await splitTab(page, CART, 'right');
  await expect(visible(page, 'key-browser')).toBeVisible();
  await expect(visible(page, 'hash-editor')).toBeVisible();
  // Splitting the dock scrolled the list; the namespace starts at the top.
  await visible(page, 'key-browser').evaluate((element) => {
    for (const node of element.querySelectorAll('*')) node.scrollTop = 0;
  });
  await capture(page, 'redis-browser');
});

test('redis-stream', async () => {
  await closeTabs(page);
  await treeRow(page, 'orders', sessions()).click();
  await treeRow(page, 'stream', sessions()).click();
  const stream = visible(page, 'stream-editor');
  await expect(stream.getByTestId('stream-entry').first()).toBeVisible();
  await stream.getByRole('tab', { name: 'Consumer groups' }).click();
  await stream.getByRole('row', { name: /fulfilment/ }).click();
  await expect(stream.getByTestId('pending-entries')).toContainText('workshop-bergen');
  await capture(page, 'redis-stream');
});

test('redis-cli', async () => {
  await closeTabs(page);
  await page.getByRole('button', { name: 'New query' }).click();
  const cli = visible(page, 'redis-cli');
  const input = cli.getByTestId('cli-input');
  for (const command of [
    `HGETALL ${CART}`,
    `TTL ${CART}`,
    'ZREVRANGE leaderboard:bestsellers:2026-09 0 4 WITHSCORES',
    'XPENDING orders:stream fulfilment',
  ]) {
    const entries = await cli.getByTestId('cli-entry').count();
    await input.click();
    await input.pressSequentially(command);
    await input.press('Enter');
    await expect(cli.getByTestId('cli-entry')).toHaveCount(entries + 1);
    await expect(cli.getByTestId('cli-reply').last()).toBeVisible();
  }
  await input.click();
  await input.pressSequentially('XAUTOCL');
  await expect(cli.getByTestId('cli-suggestions')).toContainText('XAUTOCLAIM');
  await input.press('Tab');
  await expect(cli.getByTestId('cli-docs')).toContainText('XAUTOCLAIM key');
  // Not run: the scene stops at the suggestions for the optional arguments.
  await input.pressSequentially('orders:stream fulfilment workshop-graz 3600000 0-0 ');
  await capture(page, 'redis-cli');
});

/** Folds the server's key tree, so the side bar shows the Tools folder without scrolling. */
async function foldKeys(): Promise<void> {
  const db0 = treeRow(page, 'db0', sessions());
  if (await treeRow(page, 'cart', sessions()).isVisible()) {
    await db0.locator('[data-tree-chevron]').click();
  }
}

test('redis-search', async () => {
  await closeTabs(page);
  await foldKeys();
  await openTool(page, DEMO.redis.name, 'Search indexes');
  const panel = visible(page, 'redis-search');
  await panel.getByTestId('search-index').filter({ hasText: 'idx:products' }).click();
  await expect(panel.getByTestId('search-header')).toContainText('idx:products');
  await panel
    .getByTestId('search-query')
    .fill('@name:(desk | table) @wood:{oak | walnut | cherry}');
  await panel.getByLabel('Sort by').selectOption('price');
  await panel.getByRole('button', { name: '↑ Ascending' }).click();
  await panel.getByText('Scores', { exact: true }).click();
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByTestId('search-total')).toContainText('match');
  await expect(panel.getByTestId('search-document').first()).toContainText('product:');
  await capture(page, 'redis-search');
});

test('redis-rdb', async () => {
  await closeTabs(page);
  await foldKeys();
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, DUMP);
  await openTool(page, DEMO.redis.name, 'Dump analysis');
  const panel = visible(page, 'dump-analysis');
  await panel.getByRole('button', { name: 'Choose RDB file…' }).first().click();
  const report = panel.getByTestId('dump-report');
  await expect(report.getByTestId('dump-file')).toHaveText('larchwood.rdb');
  await expect(report.getByTestId('dump-biggest').first()).toBeVisible();
  await capture(page, 'redis-rdb');
});

test('redis-info', async () => {
  await closeTabs(page);
  await foldKeys();
  await openTool(page, DEMO.redis.name, 'INFO dashboard');
  const dashboard = visible(page, 'info-dashboard');
  await expect(dashboard.getByTestId('keyspace')).toContainText('db0');
  await dashboard.getByLabel('Refresh interval').selectOption('1000');
  // A storefront's worth of reads for the charts, and Lua reports slow enough for the slow log.
  // The load runs until the capture.
  const storefront = await demoRedis();
  const load = { running: true };
  const traffic = storefrontLoad(storefront, load);
  try {
    await page.waitForTimeout(40_000);
    await openTool(page, DEMO.redis.name, 'Slow log');
    await expect(visible(page, 'slowlog').getByRole('table').first()).toBeVisible();
    await splitTab(page, 'Slow log', 'bottom');
    await expect(visible(page, 'info-dashboard')).toBeVisible();
    await page.waitForTimeout(3_000);
    await capture(page, 'redis-info');
  } finally {
    load.running = false;
    await traffic;
    await storefront.close();
  }
});

test('redis-topology', async () => {
  await closeTabs(page);
  await addClusterConnection(DEMO.redisCluster);
  await connectProfile(page, DEMO.redisCluster.name);
  await openTool(page, DEMO.redisCluster.name, 'Topology');
  const topology = visible(page, 'topology');
  await expect(topology.getByTestId('topology-mode')).toHaveText('cluster');
  await expect(topology.getByTestId('topology-node')).toHaveCount(3);
  // The CLI beside it: each command goes to the node that owns its key's slot.
  await openTool(page, DEMO.redisCluster.name, 'CLI');
  const cli = visible(page, 'redis-cli');
  const input = cli.getByTestId('cli-input');
  for (const command of [
    'GET cart:4001',
    'GET cart:4002',
    'GET cart:4004',
    'CLUSTER KEYSLOT cart:4004',
  ]) {
    const entries = await cli.getByTestId('cli-entry').count();
    await input.click();
    await input.pressSequentially(command);
    await input.press('Enter');
    await expect(cli.getByTestId('cli-entry')).toHaveCount(entries + 1);
    await expect(cli.getByTestId('cli-reply').last()).toBeVisible();
  }
  await splitTab(page, 'CLI · Carts', 'bottom');
  await expect(visible(page, 'topology')).toBeVisible();
  // Only the Cluster profile open in the side bar.
  await sessions().locator('[data-tree-row]').first().locator('[data-tree-chevron]').click();
  await input.focus();
  await capture(page, 'redis-topology');
});
