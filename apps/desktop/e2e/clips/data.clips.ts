import { expect, test, type Locator } from '@playwright/test';

import { DEMO } from '../screenshots/harness';
import { profileItem, treeRow, visible } from '../screenshots/nosql';
import { film, openShopTables, stubFileDialog, type Clip } from './director';

/**
 * Data-movement scenes on Larchwood: structure sync with its drifted staging copy (applied, so
 * the staging database changes), a transfer of the orders into MongoDB with their items embedded
 * (into a new `larchwood` database), and a CSV import into a new table. Each run of the demo
 * databases starts them afresh, so the scenes can write.
 */

const PRICE_LIST = '/tmp/larchwood-files/products-price-list-2026-autumn.csv';

/** Picks a menu item from a tree row's menu, opened at the pointer with a right click. */
async function rowMenu(clip: Clip, row: Locator, item: string): Promise<void> {
  await clip.click(row, { button: 'right', position: { x: 60, y: 10 } });
  const entry = clip.page.getByRole('menuitem', { name: item, exact: true });
  await expect(entry).toBeVisible();
  await clip.hold(300);
  await clip.click(entry);
}

test('structure-sync', async () => {
  await film(
    {
      connections: [DEMO.postgres, DEMO.postgresStaging],
      connect: [DEMO.postgres.name],
    },
    async (clip) => {
      const { page } = clip;
      await page
        .getByRole('toolbar', { name: 'Window' })
        .getByRole('button', { name: 'Compare' })
        .click();
      await page.getByRole('menuitem', { name: 'Compare structure…' }).click();
      const view = visible(page, 'structure-compare');
      const side = async (role: 'Source' | 'Target', profile: string, database: string) => {
        await view
          .getByLabel(`${role} connection`)
          .selectOption({ label: `${profile} · PostgreSQL` });
        await view.getByLabel(`${role} database`).fill(database);
        await view.getByLabel(`${role} schemas`).fill('shop');
      };
      await side('Source', DEMO.postgres.name, 'larchwood');
      await side('Target', DEMO.postgresStaging.name, 'larchwood_staging');

      await clip.start('structure-sync');
      await clip.show('Larchwood and its staging copy: compare schema shop', 1800);
      await clip.click(view.getByRole('button', { name: 'Compare', exact: true }));
      const summary = view.getByTestId('sync-summary');
      await expect(summary).toBeVisible({ timeout: 60_000 });
      await clip.show('The differences, grouped by object', 2200);
      await clip.click(view.getByRole('button', { name: 'shop.products.price' }));
      await expect(view.getByTestId('source-ddl')).toBeVisible();
      await clip.show('One difference: both definitions side by side', 2400);
      await clip.click(view.getByRole('tab', { name: 'Script' }));
      await expect(view.getByTestId('sync-script')).toContainText('ALTER');
      await clip.show('The script that makes staging match', 2200);
      await clip.click(view.getByRole('button', { name: 'Select all', exact: true }));
      await expect(view.getByText(/^\d+ destructive operations? ticked$/)).toBeVisible();
      await clip.show('Select all: the destructive drop is ticked too', 1200);
      await clip.click(view.getByRole('button', { name: 'Apply…' }));
      const review = page.getByRole('alertdialog', { name: 'Review and apply' });
      await expect(review.getByTestId('apply-script')).not.toHaveText('Generating the script…');
      await clip.show('Review and apply: every statement before it runs', 2400);
      const tick = review.getByRole('checkbox', { name: /^I reviewed this script/ });
      if ((await tick.count()) > 0) await clip.check(tick);
      await clip.click(review.getByRole('button', { name: 'Apply', exact: true }));
      await expect(view.getByText(/^No differences:/)).toBeVisible({ timeout: 120_000 });
      await clip.show('Applied and compared again: zero differences', 2800);
    },
  );
});

test('pg-to-mongo', async () => {
  await film(
    {
      connections: [DEMO.postgres, DEMO.mongodb],
      connect: [DEMO.postgres.name, DEMO.mongodb.name],
    },
    async (clip) => {
      const { page } = clip;
      await openShopTables(page, DEMO.postgres.name);
      const larchwood = profileItem(page, DEMO.postgres.name);
      await treeRow(page, 'orders', larchwood).click();
      const rows = visible(page, 'table-data-panel');
      await expect(rows.getByTestId('table-row-count')).toContainText('rows');

      await clip.start('pg-to-mongo');
      await clip.show('The orders table in PostgreSQL', 1100);
      await rowMenu(clip, treeRow(page, 'orders', larchwood), 'Transfer data to…');
      const wizard = page.getByRole('dialog', { name: 'Transfer data' });
      await expect(wizard.getByLabel('Transfer orders', { exact: true })).toBeChecked();
      await clip.show('Transfer data: orders is the source', 1300);
      await clip.click(wizard.getByRole('button', { name: 'Next' }));
      await clip.select(wizard.getByLabel('Connection'), {
        label: `${DEMO.mongodb.name} · MongoDB`,
      });
      await clip.typeInto(wizard.getByLabel('Database'), 'larchwood');
      await clip.show('The target: a new larchwood database on MongoDB', 1300);
      await clip.click(wizard.getByRole('button', { name: 'Next' }));
      const embeds = wizard.getByTestId('transfer-embeds');
      await expect(embeds).toBeVisible();
      await clip.show('Child rows can be embedded, through a foreign key', 1000);
      await clip.check(embeds.getByLabel(/^order_items/).first());
      await clip.typeInto(wizard.getByLabel('Field for order_items in orders'), 'items');
      await clip.show('Embed order_items as an items array in each order', 1600);
      await clip.click(wizard.getByRole('button', { name: 'Next' }));
      await expect(wizard.getByTestId('transfer-mapping')).toBeVisible({ timeout: 60_000 });
      await clip.show('Each column and the BSON type it lands as', 1500);
      await clip.click(wizard.getByRole('button', { name: 'Next' }));
      await expect(wizard.getByTestId('transfer-review')).toBeVisible();
      await clip.show('Review, then Transfer', 1000);
      await clip.click(wizard.getByRole('button', { name: 'Transfer', exact: true }));
      await expect(wizard).toBeHidden({ timeout: 60_000 });
      const job = page.getByTestId('job-item').filter({ hasText: 'orders' }).first();
      await expect(job).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });
      await expect(job).toContainText('6,400 rows');
      await clip.show('The transfer runs as a job: 6,400 rows', 1300);

      const catalog = profileItem(page, DEMO.mongodb.name);
      await rowMenu(clip, catalog.locator('[data-tree-row]').first(), 'Refresh objects');
      const db = treeRow(page, 'larchwood', catalog);
      await expect(db).toBeVisible({ timeout: 30_000 });
      clip.beat('A new larchwood database on MongoDB');
      await clip.click(db);
      await clip.click(treeRow(page, 'Collections', catalog));
      await clip.click(treeRow(page, 'orders', catalog));
      const panel = visible(page, 'mongo-collection-panel');
      await expect(panel.getByTestId('mongo-loaded')).toContainText('loaded');
      clip.beat('The orders collection');
      await clip.click(panel.getByRole('button', { name: 'Document 1', exact: true }));
      const tree = panel.getByTestId('mongo-tree');
      await clip.click(tree.getByRole('button', { name: 'Expand items' }).first());
      await clip.click(tree.getByRole('button', { name: 'Expand 0' }).first());
      await clip.show('Each order is a document with its items inside', 2400);
    },
  );
});

test('import-preview', async () => {
  await film({ connections: [DEMO.postgres], connect: [DEMO.postgres.name] }, async (clip) => {
    const { page } = clip;
    await openShopTables(page, DEMO.postgres.name);
    await stubFileDialog(clip.launched, 'open', PRICE_LIST);
    const larchwood = profileItem(page, DEMO.postgres.name);
    await treeRow(page, 'products', larchwood).click();
    await expect(visible(page, 'table-data-panel').getByTestId('table-row-count')).toContainText(
      'rows',
    );

    await clip.start('import-preview');
    await clip.show('Larchwood: the products of schema shop', 1000);
    await rowMenu(clip, treeRow(page, 'Tables', larchwood), 'Import into new table…');
    const wizard = page.getByRole('dialog', { name: 'Import into a new table in shop' });
    await expect(wizard).toBeVisible();
    await clip.show('Import into a new table: CSV, JSON, Excel, XML, Parquet', 1500);
    await clip.click(wizard.getByRole('button', { name: 'Choose file…' }));
    const preview = wizard.getByTestId('import-preview');
    await expect(preview).toContainText('LW-TAB-OAK-1001');
    await clip.show('The autumn price list, previewed before anything is written', 1800);
    await clip.point(preview.locator('thead'), 900);
    await clip.show('Format, encoding, delimiter and each column’s type detected', 2100);
    const header = wizard.getByRole('checkbox', { name: 'First row holds the column names' });
    await clip.click(header);
    await expect(header).not.toBeChecked();
    await clip.show('Change an option and the preview follows', 1700);
    await clip.click(header);
    await expect(header).toBeChecked();
    await expect(preview).toContainText('LW-TAB-OAK-1001');
    await clip.show('Back to the header row', 700);
    await clip.click(wizard.getByRole('button', { name: 'Next' }));
    const columns = wizard.getByTestId('import-new-columns');
    await expect(columns).toBeVisible();
    clip.beat('Next: the new table');
    await clip.typeInto(wizard.getByLabel('Table name'), 'price_list_autumn');
    await expect(wizard.getByTestId('import-ddl')).toContainText('price_list_autumn');
    await clip.point(columns, 700);
    await clip.show('The new table: column names and types from the file', 2200);
    await clip.check(wizard.getByLabel('id is in the primary key', { exact: true }));
    await expect(wizard.getByTestId('import-ddl')).toContainText('PRIMARY KEY');
    await clip.point(wizard.getByTestId('import-ddl'), 700);
    await clip.show('id as the primary key; the CREATE TABLE it will run', 2200);
    await clip.click(wizard.getByRole('button', { name: 'Next' }));
    await clip.click(wizard.getByRole('button', { name: 'Next' }));
    await expect(wizard.getByTestId('import-review')).toBeVisible();
    await clip.show('Review, then Import', 1400);
    await clip.click(wizard.getByRole('button', { name: 'Import', exact: true }));
    await expect(wizard).toBeHidden({ timeout: 60_000 });
    const table = treeRow(page, 'price_list_autumn', larchwood);
    await expect(table).toBeVisible({ timeout: 30_000 });
    await clip.click(table);
    const rows = visible(page, 'table-data-panel');
    await expect(rows.getByTestId('table-row-count')).toContainText('86');
    await clip.show('86 rows in shop.price_list_autumn', 2400);
  });
});
