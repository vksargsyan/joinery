import { expect, test, type Page } from '@playwright/test';

import { DEMO } from '../screenshots/harness';
import { treeRow, visible } from '../screenshots/nosql';
import { film, openShopTables } from './director';

/**
 * PostgreSQL scenes on Larchwood: the command palette, visual explain, ER model editing with
 * Review & apply, and staged grid edits on a production profile.
 */

test('command-palette', async () => {
  await film(
    {
      connections: [DEMO.postgres, DEMO.mongodb],
      connect: [DEMO.postgres.name, DEMO.mongodb.name],
    },
    async (clip) => {
      const { page } = clip;
      const palette = page.getByTestId('command-palette');
      const options = palette.getByRole('option');
      // The customers are open as the scene begins; the palette remembers them as recent.
      await page.keyboard.press('ControlOrMeta+P');
      await expect(options.filter({ hasText: 'order_items' })).toHaveCount(1);
      await page.keyboard.type('customers');
      await expect(options.first()).toContainText('customers');
      await page.keyboard.press('Enter');
      const table = visible(page, 'table-data-panel');
      await expect(table.getByTestId('table-row-count')).toContainText('rows');

      await clip.start('command-palette');
      await clip.show('Larchwood on PostgreSQL and Catalog on MongoDB, customers open', 1500);

      await clip.shortcut('ControlOrMeta+P', ['Ctrl', 'P'], { global: true });
      await expect(palette).toBeVisible();
      await clip.show('Go to Object: every table, view and collection, recent first', 1700);
      await clip.type('prod');
      const collection = options.filter({ hasText: DEMO.mongodb.name }).first();
      await expect(collection).toBeVisible();
      await clip.show('One list for PostgreSQL tables and MongoDB collections', 1700);
      await clip.click(collection);
      await expect(
        visible(page, 'mongo-collection-panel').getByTestId('mongo-loaded'),
      ).toContainText('loaded');
      await clip.show('The products collection opens', 1800);

      await clip.shortcut('ControlOrMeta+P', ['Ctrl', 'P'], { global: true });
      await clip.type('oi');
      await expect(options.first()).toContainText('order_items');
      await clip.show('Two letters find order_items', 1500);
      await page.keyboard.press('Enter');
      await expect(table.getByTestId('table-row-count')).toContainText('rows');
      await clip.show('Enter opens its rows', 1800);

      await clip.shortcut('ControlOrMeta+Shift+P', ['Ctrl', 'Shift', 'P'], { global: true });
      await expect(palette.getByRole('combobox')).toHaveValue('>');
      await clip.show('Ctrl+Shift+P: every command, with its shortcut', 2000);
      await clip.type('new query');
      await expect(options.first()).toContainText('New Query Tab');
      await clip.show('A few letters filter the commands', 1300);
      await page.keyboard.press('Enter');
      const query = visible(page, 'query-panel');
      await expect(query).toBeVisible();
      await clip.show('A new query tab on Larchwood', 900);
      await clip.click(visible(page, 'sql-editor'), { position: { x: 120, y: 12 } });
      await clip.typeCode('select count(*) from shop.order_items');
      await clip.shortcut('ControlOrMeta+Enter', ['Ctrl', 'Enter']);
      await expect(visible(page, 'row-count')).toHaveText('1 row');
      await clip.show('Type, Ctrl+Enter, the answer', 1600);
    },
  );
});

/** Moves the query panel's splitter so the editor takes `fraction` of the panel's height. */
async function splitEditor(page: Page, fraction: number): Promise<void> {
  const separator = page
    .getByRole('separator', { name: 'Resize editor and results' })
    .filter({ visible: true });
  const handle = (await separator.boundingBox())!;
  const area = (await visible(page, 'query-panel').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, area.y + area.height * fraction, {
    steps: 8,
  });
  await page.mouse.up();
}

test('visual-explain', async () => {
  await film({ connections: [DEMO.postgres], connect: [DEMO.postgres.name] }, async (clip) => {
    const { page } = clip;
    await openShopTables(page, DEMO.postgres.name);
    await page.getByRole('button', { name: 'New query' }).click();
    await expect(visible(page, 'query-panel')).toBeVisible();
    await splitEditor(page, 0.3);

    await clip.start('visual-explain');
    await clip.show('A query tab on Larchwood, PostgreSQL 16', 1000);
    await clip.click(visible(page, 'sql-editor'), { position: { x: 160, y: 12 } });
    clip.beat('Typing a query: revenue by country from delivered orders');
    await clip.typeCode(
      [
        'select c.country, count(*) as orders, sum(o.total) as revenue',
        'from shop.orders o',
        'join shop.customers c on c.id = o.customer_id',
        "where o.status = 'delivered'",
        'group by c.country order by revenue desc;',
      ].join('\n'),
    );
    await clip.hold(1000);

    await clip.click(page.getByRole('button', { name: 'Explain Analyze' }));
    const plan = visible(page, 'sql-plan');
    await expect(plan.getByTestId('plan-kind')).toHaveText('Analyzed');
    await clip.show('Explain Analyze runs it and draws the plan as a tree', 2200);
    const hottest = plan.locator('[data-testid="plan-node"][data-hottest="true"]');
    await expect(hottest).toHaveCount(1);
    await clip.point(hottest, 700);
    await clip.show('The slowest node is marked in the tree', 1600);
    await clip.click(plan.getByTestId('plan-hottest'));
    await clip.show('Slowest step: its own time, rows and cost', 2400);
    await clip.point(plan.getByTestId('plan-execution'), 600);
    await clip.show('Planning and execution time, rows and misestimates', 1800);
    await clip.click(plan.getByRole('radiogroup', { name: 'Plan view' }).getByRole('radio').nth(1));
    await clip.show('The raw plan is one click away', 1600);
    await clip.click(plan.getByRole('radio', { name: 'Plan', exact: true }));
    await clip.show('Back to the tree', 1000);
  });
});

test('er-to-alter', async () => {
  await film({ connections: [DEMO.postgres], connect: [DEMO.postgres.name] }, async (clip) => {
    const { page } = clip;
    await openShopTables(page, DEMO.postgres.name);
    const diagram = visible(page, 'er-diagram');
    const box = (table: string) =>
      diagram.locator(`[data-testid="er-table"][data-table="${table}"]`);
    await treeRow(page, 'shop').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'ER diagram' }).click();
    await expect(box('customers')).toBeVisible();
    // Room for the boxes: no table list, the legend folded, the whole schema in view.
    const tables = diagram.getByRole('button', { name: 'Tables', pressed: true });
    if ((await tables.count()) > 0) await tables.click();
    const legend = diagram.getByRole('region', { name: 'Legend' });
    if ((await legend.getByRole('button', { expanded: true }).count()) > 0) {
      await legend.getByRole('button', { expanded: true }).click();
    }
    await diagram.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(800);

    await clip.start('er-to-alter');
    await clip.show('The shop schema of Larchwood as an ER diagram', 1600);
    await clip.click(diagram.getByTestId('er-edit'));
    const bar = diagram.getByTestId('er-edit-bar');
    await expect(bar).toBeVisible();
    await clip.show('Edit model: changes stay in the model until you apply them', 1400);
    await clip.click(box('customers'), { position: { x: 60, y: 14 } });
    const editor = diagram.getByTestId('er-table-editor');
    await expect(editor).toBeVisible();
    await clip.show('customers, column by column', 1200);
    await clip.click(editor.getByRole('button', { name: 'Add', exact: true }));
    const added = editor.locator('[data-testid="er-column"]').last();
    const name = added.getByLabel(/^Name of column /);
    await clip.typeInto(name, 'loyalty_tier');
    await page.keyboard.press('Enter');
    const column = editor.locator('[data-testid="er-column"][data-column="loyalty_tier"]');
    await clip.typeInto(column.getByLabel('Type of loyalty_tier'), 'text');
    await page.keyboard.press('Enter');
    await clip.typeInto(column.getByLabel('Default of loyalty_tier'), "'standard'");
    await page.keyboard.press('Enter');
    await clip.show('A new column: loyalty_tier, text, default standard', 1600);

    await clip.click(bar.getByTestId('er-review-button'));
    const review = page.getByTestId('er-review');
    await expect(review.getByTestId('er-script')).toContainText('ALTER TABLE');
    await clip.show('Review & apply: the exact ALTER TABLE script', 2800);
    await clip.point(review.getByTestId('er-script'), 1200);
    await clip.click(page.getByTestId('er-apply'));
    await expect(review).toBeHidden({ timeout: 60_000 });
    await expect(box('customers')).toContainText('loyalty_tier');
    await clip.show('Applied in one transaction; the diagram shows the new column', 2200);
  });
});

test('safe-edits', async () => {
  await film(
    { connections: [DEMO.postgresProduction], connect: [DEMO.postgresProduction.name] },
    async (clip) => {
      const { page } = clip;
      await openShopTables(page, DEMO.postgresProduction.name);
      await treeRow(page, 'orders').click();
      const view = visible(page, 'table-data-panel');
      await expect(view.getByTestId('table-row-count')).toContainText('rows');
      await page.waitForTimeout(500);
      const canvas = (await view.getByTestId('data-grid-canvas').boundingBox())!;
      const row = (n: number): number => canvas.y + 28 + 13 + 26 * n;

      await clip.start('safe-edits');
      await clip.show('The orders table on a connection marked production', 1600);

      // The note of the first two orders: walk to the last column, edit, Enter.
      for (const [n, note] of ['Deliver after 2 pm', 'Leave with the neighbour'].entries()) {
        await clip.clickAt(canvas.x + 80, row(n));
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('ArrowRight');
          await page.waitForTimeout(70);
        }
        await clip.hold(250);
        await page.keyboard.press('Enter');
        const cellEditor = page.getByTestId('cell-editor');
        await expect(cellEditor).toBeVisible();
        const input = cellEditor.getByRole('textbox').first();
        await page.keyboard.press('ControlOrMeta+a');
        await clip.type(note);
        await clip.hold(300);
        await input.press('Enter');
        await expect(cellEditor).toBeHidden();
        if (n === 0) await clip.show('Edit a cell right in the grid', 800);
        else await clip.hold(500);
      }
      await expect(view.getByTestId('pending-changes')).toHaveText('2 edited');
      await clip.point(view.getByTestId('pending-changes'), 400);
      await clip.show('Two edits staged in the grid; nothing is written yet', 1800);

      await clip.click(view.getByRole('button', { name: /^Apply \(/ }));
      const dialog = page.getByRole('dialog', { name: 'Apply changes' });
      await expect(dialog.getByTestId('apply-preview')).toContainText('UPDATE');
      await clip.show('Apply shows the exact SQL before it runs: two UPDATEs', 2800);
      await clip.click(dialog.getByRole('button', { name: 'Apply on production' }));
      const confirm = page.getByRole('alertdialog', { name: 'Run on a production connection?' });
      await expect(confirm).toBeVisible();
      await clip.show('Production asks once more, with each statement listed', 2600);
      await clip.click(confirm.getByRole('button', { name: 'Run anyway' }));
      await expect(view.getByTestId('pending-changes')).toHaveCount(0);
      await clip.show('Applied: 2 updated, in one transaction', 2000);
    },
  );
});
