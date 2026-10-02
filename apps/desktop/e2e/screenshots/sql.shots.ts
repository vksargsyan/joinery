import { expect, test, type Locator, type Page } from '@playwright/test';

import { startSshServer, type TestSshServer } from '../../test/ssh-server';
import { connectionTab, openNewConnection, type LaunchedApp } from '../app';
import {
  addConnection,
  capture,
  connectProfile,
  DEMO,
  fillConnection,
  launchForShots,
} from './harness';

/**
 * The SQL scenes of the website: the query editor, Go to Object, the Objects view, connections
 * and SSH, autocomplete, explain, the query builder, ER diagrams and model editing, table data and
 * the table designer. Everything runs against the Larchwood demo databases and nothing is written
 * there: staged changes and model edits stop at their preview. The SSH scenes go through the
 * in-process test SSH server, as the ssh-tunnel end-to-end spec does, named
 * bastion.larchwood.example (demo-up.sh maps it to 127.0.0.1).
 */

test.describe.configure({ mode: 'serial' });

const SSH_USER = 'ops';
const SSH_PASSWORD = 'demo-Bastion-pw';
const BASTION = 'bastion.larchwood.example';

let launched: LaunchedApp | undefined;
let page: Page;
const servers: TestSshServer[] = [];

test.beforeAll(async () => {
  launched = await launchForShots();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  for (const server of servers) await server.close();
});

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function visible(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

/** Expands a tree row by its chevron, without opening anything. */
async function expand(text: string): Promise<void> {
  const row = treeRow(text).first();
  const item = page.getByRole('treeitem').filter({ has: row }).last();
  if ((await item.getAttribute('aria-expanded')) !== 'true') {
    await row.locator('[data-tree-chevron]').click();
  }
  await expect(item).toHaveAttribute('aria-expanded', 'true');
}

/** Closes every tab in the dock, discarding unsaved work. */
async function closeTabs(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const close = page.locator('.dv-tab [aria-label^="Close "]');
    if ((await close.count()) === 0) return;
    await close.first().click();
    const confirm = page.getByRole('alertdialog');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm
        .getByRole('button', { name: /^(Close without saving|Discard|Don’t save)/ })
        .click();
    }
    await page.waitForTimeout(150);
  }
}

/** Adds and connects the Larchwood profile once; opens larchwood › shop › Tables in the tree. */
async function openShopTables(): Promise<void> {
  if ((await page.getByRole('treeitem', { name: DEMO.postgres.name }).count()) === 0) {
    await addConnection(page, DEMO.postgres);
  }
  const profile = page.getByRole('treeitem', { name: DEMO.postgres.name }).first();
  if ((await profile.getByText('Connected', { exact: true }).count()) === 0) {
    await connectProfile(page, DEMO.postgres.name);
  }
  await expand('larchwood');
  await expand('shop');
  await expand('Tables');
  await expect(treeRow('order_items')).toBeVisible();
}

/** Opens a new query tab on Larchwood. */
async function newQuery(): Promise<void> {
  await page.getByRole('button', { name: 'New query' }).click();
  await expect(visible('query-panel')).toBeVisible();
}

/**
 * Replaces the visible SQL editor's text through the clipboard, as a paste: Monaco keeps the
 * text's own indentation (typing would auto-indent every new line).
 */
async function pasteInEditor(text: string): Promise<void> {
  await launched!.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await visible('sql-editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');
  await page.keyboard.press('Escape');
}

/** Moves the query panel's splitter so the editor takes `fraction` of the panel's height. */
async function splitEditor(fraction: number): Promise<void> {
  const separator = page
    .getByRole('separator', { name: 'Resize editor and results' })
    .filter({ visible: true });
  const handle = (await separator.boundingBox())!;
  const area = (await visible('query-panel').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, area.y + area.height * fraction, {
    steps: 8,
  });
  await page.mouse.up();
}

/** Takes keyboard focus off form fields, so no focus ring shows in a shot. */
async function blur(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Starts a test SSH server standing in for the demo bastion. */
async function startBastion(): Promise<TestSshServer> {
  const server = await startSshServer({ user: SSH_USER, password: SSH_PASSWORD });
  servers.push(server);
  return server;
}

/** Turns on the SSH tunnel in the open connection dialog, through a test bastion. */
async function throughBastion(dialog: Locator, server: TestSshServer): Promise<void> {
  await connectionTab(dialog, 'SSH');
  await dialog.getByLabel('Connect through an SSH tunnel').check();
  await dialog.getByLabel('SSH host', { exact: true }).fill(BASTION);
  await dialog.getByLabel('SSH port', { exact: true }).fill(String(server.port));
  await dialog.getByLabel('SSH user', { exact: true }).fill(SSH_USER);
  await dialog.getByLabel('SSH password', { exact: true }).fill(SSH_PASSWORD);
  await dialog.getByLabel('SSH password storage').selectOption('session');
}

const HERO_SQL = `-- Monthly revenue by category, 2026
with monthly as (
  select date_trunc('month', o.placed_at)::date as month, p.category,
         count(distinct o.id)             as orders,
         sum(oi.quantity)                 as units,
         sum(oi.quantity * oi.unit_price) as revenue
  from shop.orders o
  join shop.order_items oi on oi.order_id = o.id
  join shop.products p     on p.id = oi.product_id
  where o.status <> 'cancelled' and o.placed_at >= '2026-01-01'
  group by 1, 2
)
select month, category, orders, units, revenue,
       round(revenue / orders, 2) as avg_order,
       round(100 * revenue / sum(revenue) over (partition by month), 1) as share_pct
from monthly order by month desc, revenue desc;`;

test('hero-query', async () => {
  await openShopTables();
  await newQuery();
  await pasteInEditor(HERO_SQL);
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(visible('row-count')).toHaveText('54 rows');
  await splitEditor(0.51);
  await blur();
  await capture(page, 'hero-query');
});

test('command-palette', async () => {
  await page.keyboard.press('ControlOrMeta+P');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('or');
  await expect(palette.getByRole('option').first()).toContainText('orders');
  await capture(page, 'command-palette');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('objects-view', async () => {
  await closeTabs();
  await openShopTables();
  // A click lists the schema's objects (and folds the schema, which the chevron opens again).
  await treeRow('shop').click();
  const grid = page.getByRole('grid', { name: 'Objects' });
  await expect(grid).toBeVisible();
  await expect(page.getByTestId('objects-status')).toContainText('8 tables');
  await expand('shop');
  await grid
    .getByRole('row')
    .filter({ has: page.getByText('orders', { exact: true }) })
    .click();
  await capture(page, 'objects-view');
});

test('connection-dialog', async () => {
  await closeTabs();
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog
    .getByLabel('Paste a URI to fill the form')
    .fill('postgres://reporting@db.internal.larchwood.example:5432/larchwood');
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Larchwood · reporting');
  await dialog.getByLabel('Environment').selectOption('production');
  await connectionTab(dialog, 'SSH');
  await dialog.getByLabel('Connect through an SSH tunnel').check();
  await dialog.getByRole('button', { name: 'Add jump host' }).click();
  const jump = dialog.getByRole('group', { name: 'Jump host' });
  await jump.getByLabel('SSH host', { exact: true }).fill('jump.larchwood.example');
  await jump.getByLabel('SSH user', { exact: true }).fill(SSH_USER);
  await jump.getByLabel('SSH authentication').selectOption('agent');
  const server = dialog.getByRole('group', { name: 'SSH server' });
  await server.getByLabel('SSH host', { exact: true }).fill(BASTION);
  await server.getByLabel('SSH user', { exact: true }).fill(SSH_USER);
  await server.getByLabel('SSH authentication').selectOption('agent');
  await blur();
  await capture(page, 'connection-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('connection-test and host-key-prompt', async () => {
  const server = await startBastion();
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await fillConnection(page, { ...DEMO.postgresStaging, name: 'Larchwood staging' });
  await throughBastion(dialog, server);
  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  const prompt = page.getByRole('dialog', { name: 'Trust this SSH server?' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId('host-key-fingerprint')).toContainText(server.hostKeyFingerprint);
  await capture(page, 'host-key-prompt');
  // Trusted, the key is remembered; a second test runs without the question in its timings.
  await prompt.getByRole('button', { name: 'Trust and remember' }).click();
  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await dialog.getByRole('button', { name: 'Test Connection' }).click();
  await expect(dialog.getByText('Connection succeeded')).toBeHidden();
  await expect(dialog.getByText('Connection succeeded')).toBeVisible();
  await expect(prompt).toBeHidden();
  await blur();
  await dialog.getByRole('region', { name: 'Connection test' }).scrollIntoViewIfNeeded();
  await capture(page, 'connection-test');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('autocomplete', async () => {
  await closeTabs();
  await openShopTables();
  await newQuery();
  const base = `-- Large orders still in the workshop
select o.id, o.placed_at, o.total, c.name, c.city
from shop.orders o
join shop.customers c on c.id = o.customer_id
where o.status = 'in_workshop'`;
  await pasteInEditor(base);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(visible('row-count')).toContainText('rows');
  // Columns of shop.orders, resolved through the alias o.
  const suggestions = page.locator('.suggest-widget.visible');
  await expect(async () => {
    await pasteInEditor(base);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('  and o.');
    await expect(suggestions).toContainText('shipping', { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  // Monaco's suggestion list is a fixed-position overflow widget; inside a dock panel whose
  // overlay contains layout and paint (dockview's dv-render-overlay), it lands offset by the
  // panel's origin, away from the cursor. The scene is captured only once it sits at the cursor.
  const cursor = (await visible('sql-editor').locator('.cursor').first().boundingBox())!;
  const list = (await suggestions.boundingBox())!;
  const atCursor = Math.abs(list.x - cursor.x) < 40 && Math.abs(list.y - cursor.y) < 60;
  test.info().annotations.push({
    type: 'autocomplete',
    description: atCursor
      ? 'captured'
      : `not captured: list at ${list.x},${list.y}, cursor at ${cursor.x},${cursor.y}`,
  });
  if (atCursor) await capture(page, 'autocomplete');
  await page.keyboard.press('Escape');
});

test('explain', async () => {
  await closeTabs();
  await openShopTables();
  await newQuery();
  await pasteInEditor(`-- Revenue by country from delivered orders
select c.country,
       count(distinct o.id)             as orders,
       sum(oi.quantity * oi.unit_price) as revenue
from shop.customers c
join shop.orders o       on o.customer_id = c.id
join shop.order_items oi on oi.order_id = o.id
where o.status = 'delivered'
group by c.country
order by revenue desc;`);
  await page.getByRole('button', { name: 'Explain Analyze' }).click();
  const plan = visible('sql-plan');
  await expect(plan.getByTestId('plan-kind')).toHaveText('Analyzed');
  const hottest = plan.locator('[data-testid="plan-node"][data-hottest="true"]');
  await expect(hottest).toHaveCount(1);
  await splitEditor(0.3);
  await hottest.click();
  await capture(page, 'explain');
});

test('query-builder', async () => {
  await closeTabs();
  await openShopTables();
  await treeRow('larchwood').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New query builder' }).click();
  const view = visible('query-builder');
  await expect(view).toBeVisible();
  const search = view.getByLabel('Search tables');
  for (const table of ['customers', 'orders', 'order_items']) {
    await search.fill(table);
    await view.getByRole('button', { name: new RegExp(`^Add (shop\\.)?${table}$`) }).click();
  }
  await search.fill('');
  await expect(view.getByTestId('builder-table')).toHaveCount(3);
  await expect(view.locator('.react-flow__edge')).toHaveCount(2);
  for (const column of [
    'customers.name',
    'customers.city',
    'orders.total',
    'order_items.quantity',
  ]) {
    await view.getByRole('checkbox', { name: column, exact: true }).check();
  }
  await view.getByRole('tab', { name: 'Criteria' }).click();
  await view.getByRole('button', { name: 'Add condition' }).click();
  await view
    .getByLabel('Criteria condition 1', { exact: true })
    .selectOption({ label: 'orders.status' });
  await view.getByLabel('Criteria condition 1 operator').selectOption('=');
  await view.getByLabel('Criteria condition 1 value kind').selectOption('string');
  await view.getByLabel('Criteria condition 1 value', { exact: true }).fill('shipped');
  await view.getByRole('button', { name: 'Add condition' }).click();
  await view
    .getByLabel('Criteria condition 2', { exact: true })
    .selectOption({ label: 'orders.total' });
  await view.getByLabel('Criteria condition 2 operator').selectOption('>');
  await view.getByLabel('Criteria condition 2 value', { exact: true }).fill('2000');
  await view.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(view.getByTestId('row-count')).toContainText('rows');
  await view.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(600);
  await blur();
  await capture(page, 'query-builder');
});

function diagram(): Locator {
  return visible('er-diagram');
}

function box(label: string): Locator {
  return diagram().locator(`[data-testid="er-table"][data-table="${label}"]`);
}

/** Opens the shop schema's diagram with room for the boxes: no table list, the legend folded. */
async function openShopDiagram(): Promise<void> {
  await treeRow('shop').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'ER diagram' }).click();
  await expect(box('orders')).toBeVisible();
  const tables = diagram().getByRole('button', { name: 'Tables', pressed: true });
  if ((await tables.count()) > 0) await tables.click();
  const legend = diagram().getByRole('region', { name: 'Legend' });
  if ((await legend.getByRole('button', { expanded: true }).count()) > 0) {
    await legend.getByRole('button', { expanded: true }).click();
  }
}

async function fitDiagram(): Promise<void> {
  await diagram().getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800);
}

test('er-diagram', async () => {
  await closeTabs();
  await openShopTables();
  await openShopDiagram();
  await box('orders').click();
  await expect(box('orders')).toHaveAttribute('data-tone', 'selected');
  await expect(diagram().getByTestId('er-inspector')).toBeVisible();
  await fitDiagram();
  await capture(page, 'er-diagram');
  await page.keyboard.press('Escape');
});

test('er-model-apply and er-models', async () => {
  const view = diagram();
  await view.getByTestId('er-edit').click();
  const bar = view.getByTestId('er-edit-bar');
  await expect(bar).toBeVisible();
  await box('customers').click();
  const editor = view.getByTestId('er-table-editor');
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  const added = editor.locator('[data-testid="er-column"]').last();
  const name = added.getByLabel(/^Name of column /);
  await name.fill('loyalty_tier');
  await name.press('Enter');
  const column = editor.locator('[data-testid="er-column"][data-column="loyalty_tier"]');
  const type = column.getByLabel('Type of loyalty_tier');
  await type.fill('text');
  await type.press('Enter');
  const def = column.getByLabel('Default of loyalty_tier');
  await def.fill("'standard'");
  await def.press('Enter');
  await editor.getByRole('button', { name: 'Delete column marketing_opt_in' }).click();
  await blur();
  await bar.getByTestId('er-review-button').click();
  const review = page.getByTestId('er-review');
  await expect(review).toContainText('This change loses data');
  await capture(page, 'er-model-apply');
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();

  // Closing keeps the changes as a draft; the diagram brings them back (ADR 0018).
  await expect(view.getByTestId('er-kept')).toHaveText('Kept');
  await page.getByRole('button', { name: 'Close ER diagram (shop)' }).click();
  await expect(page.getByTestId('er-diagram')).toHaveCount(0);
  await openShopDiagram();
  await expect(diagram().getByTestId('er-notice')).toContainText('Restored your unapplied changes');
  await fitDiagram();
  // A step back, so the folded legend clears the boxes.
  await diagram().locator('.react-flow__controls-zoomout').click();
  await page.waitForTimeout(500);
  await capture(page, 'er-models');
  await diagram().getByTestId('er-edit-bar').getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
});

test('table-data and table-apply', async () => {
  await closeTabs();
  await openShopTables();
  await treeRow('orders').click();
  const view = visible('table-data-panel');
  await expect(view).toBeVisible();
  const bar = view.getByTestId('filter-bar');
  await bar.getByRole('button', { name: 'Add condition' }).click();
  let condition = bar.getByTestId('filter-condition').last();
  await condition.getByLabel('Column').selectOption('status');
  await condition.getByLabel('Operator').selectOption('=');
  await condition.getByLabel('Value').fill('in_workshop');
  await bar.getByRole('button', { name: 'Add condition' }).click();
  condition = bar.getByTestId('filter-condition').last();
  await condition.getByLabel('Column').selectOption('total');
  await condition.getByLabel('Operator').selectOption('>=');
  await condition.getByLabel('Value').fill('2500');
  await bar.getByRole('button', { name: 'Apply filter' }).click();
  await expect(view.getByTestId('table-row-count')).toContainText('rows loaded');
  await page.waitForTimeout(500);

  // Select a cell of the first row, walk to the last column (note) and edit it.
  const canvas = view.getByTestId('data-grid-canvas');
  const grid = (await canvas.boundingBox())!;
  await page.mouse.click(grid.x + 80, grid.y + 28 + 13);
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const cellEditor = page.getByTestId('cell-editor');
  await expect(cellEditor).toBeVisible();
  const input = cellEditor.getByRole('textbox').first();
  await input.fill('Deliver after 2 pm');
  await input.press('Enter');
  await expect(cellEditor).toBeHidden();
  // Enter moved the selection down a row; back onto the edited cell.
  await page.keyboard.press('ArrowUp');
  await expect(view.getByTestId('pending-changes')).toHaveText('1 edited');
  await capture(page, 'table-data');

  await view.getByRole('button', { name: /^Apply \(/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply changes' });
  await expect(dialog.getByTestId('apply-preview')).toContainText('UPDATE');
  await capture(page, 'table-apply');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await view.getByRole('button', { name: 'Discard' }).click();
  await expect(view.getByTestId('pending-changes')).toHaveCount(0);
});

test('table-designer', async () => {
  await closeTabs();
  await openShopTables();
  await treeRow('products').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Design table' }).click();
  const designer = visible('table-designer');
  await expect(designer).toBeVisible();
  await expect(designer.getByLabel('Column 1 name')).toHaveValue('id');
  // Narrow the price, drop the weight, add a finish column.
  const names = await designer
    .locator('input[aria-label^="Column "][aria-label$=" name"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const price = names.indexOf('price') + 1;
  await designer.getByLabel(`Column ${price} type`).fill('numeric(8,2)');
  const weight = names.indexOf('weight_kg') + 1;
  await designer.getByLabel(`Remove column ${weight}`).click();
  await designer.getByRole('button', { name: 'Add column' }).click();
  const last = names.length;
  await designer.getByLabel(`Column ${last} name`).fill('finish');
  await designer.getByLabel(`Column ${last} type`).fill('text');
  await blur();
  await designer.getByRole('button', { name: 'Save' }).click();
  const review = page.getByRole('dialog', { name: 'Review and save' });
  await expect(review.getByTestId('design-script')).toContainText('ALTER TABLE');
  // Each risk's Check counts the rows it touches (read-only queries).
  const checks = review.getByRole('button', { name: 'Check', exact: true });
  const count = await checks.count();
  for (let i = 0; i < count; i++) await checks.nth(i).click();
  await expect(review.getByTestId('check-count')).toHaveCount(count);
  await capture(page, 'table-designer');
  await review.getByRole('button', { name: 'Back to the designer' }).click();
  await expect(review).toBeHidden();
});
