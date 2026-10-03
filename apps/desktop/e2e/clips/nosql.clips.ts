import { expect, test } from '@playwright/test';

import { DEMO } from '../screenshots/harness';
import { openTool, profileItem, treeMenu, treeRow, visible } from '../screenshots/nosql';
import { film, stubFileDialog } from './director';

/**
 * MongoDB, Redis and Elasticsearch scenes: SQL on MongoDB, the offline RDB dump analysis, and
 * SQL on Elasticsearch translated to Query DSL. Nothing is written to the servers.
 */

const DUMP = process.env['QUERYBARA_DEMO_RDB'] ?? '/tmp/larchwood-files/larchwood.rdb';

test('sql-to-mongo', async () => {
  await film({ connections: [DEMO.mongodb], connect: [DEMO.mongodb.name] }, async (clip) => {
    const { page } = clip;
    const catalog = profileItem(page, DEMO.mongodb.name);
    await treeRow(page, 'catalog', catalog).click();
    await treeRow(page, 'Collections', catalog).click();
    await expect(treeRow(page, 'products', catalog)).toBeVisible();
    await treeMenu(page, treeRow(page, 'catalog', catalog), 'New SQL query');
    const tab = visible(page, 'mongo-sql');
    await expect(tab).toBeVisible();
    const translation = tab.getByRole('region', { name: 'MongoDB query' });

    await clip.start('sql-to-mongo');
    await clip.show('A SQL tab on the MongoDB catalog database', 1600);
    await clip.click(tab.getByTestId('mongo-sql-editor'), { position: { x: 200, y: 14 } });
    await clip.typeCode('SELECT name, price.amount\nFROM products');
    await expect(translation.getByText('find()', { exact: true })).toBeVisible();
    await clip.show('The find() appears as you type', 1500);
    await page.keyboard.press('Enter');
    await clip.typeCode("WHERE wood = 'walnut'");
    await clip.show('WHERE becomes the filter', 1300);
    await page.keyboard.press('Enter');
    await clip.typeCode('ORDER BY price.amount DESC');
    await clip.show('ORDER BY becomes the sort', 1300);
    await clip.click(tab.getByRole('button', { name: 'Run', exact: true }));
    await expect(tab.getByTestId('mongo-sql-ran')).toContainText('find() on products');
    await clip.show('Run: the walnut products, dearest first', 2000);

    await clip.click(tab.getByTestId('mongo-sql-editor'), { position: { x: 400, y: 60 } });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    clip.beat('A second query, with GROUP BY');
    await clip.typeCode(
      'SELECT wood, COUNT(*) AS products, AVG(price.amount) AS avg_price\nFROM products\nGROUP BY wood\nORDER BY avg_price DESC',
    );
    await expect(translation.getByText(/^aggregate\(\) · \d stages?$/)).toBeVisible();
    await clip.show('GROUP BY turns it into an aggregate() pipeline', 2200);
    await clip.click(tab.getByRole('button', { name: 'Run', exact: true }));
    await expect(tab.getByTestId('mongo-sql-ran')).toContainText('aggregate() on products');
    await expect(tab.getByTestId('mongo-sql-count')).toContainText('7 documents');
    await clip.show('Seven woods, their products and average price', 2200);
  });
});

test('redis-rdb', async () => {
  await film({ connections: [DEMO.redis], connect: [DEMO.redis.name] }, async (clip) => {
    const { page } = clip;
    await stubFileDialog(clip.launched, 'open', DUMP);
    await openTool(page, DEMO.redis.name, 'Dump analysis');
    const panel = visible(page, 'dump-analysis');
    await expect(panel.getByRole('button', { name: 'Choose RDB file…' }).first()).toBeVisible();

    await clip.start('redis-rdb');
    await clip.show('Dump analysis: what fills a Redis server, from its RDB file', 2000);
    await clip.point(panel.getByText(/reads it offline/), 900);
    await clip.show('Read offline: nothing connects to a server', 1400);
    await clip.click(panel.getByRole('button', { name: 'Choose RDB file…' }).last());
    const report = panel.getByTestId('dump-report');
    await expect(report.getByTestId('dump-file')).toHaveText('larchwood.rdb');
    await clip.hold(400);
    await clip.show('larchwood.rdb: keys, size in the dump, expiring keys', 2000);
    await clip.point(report.getByRole('region', { name: 'By type' }), 600);
    await clip.show('Keys by type, as a share of the dump', 1800);
    await clip.point(report.getByRole('region', { name: 'Expiry' }), 600);
    await clip.show('When the keys expire', 1400);
    const firstPattern = report.getByTestId('dump-pattern').first();
    await expect(firstPattern).toContainText('product:*');
    await clip.point(firstPattern, 700);
    await clip.show('By pattern: product:* holds half of the dump', 2000);
    const biggest = report.getByTestId('dump-biggest').first();
    await expect(biggest).toContainText('orders:stream');
    await clip.scrollTo(report.getByRole('region', { name: 'Largest keys' }));
    await clip.point(biggest, 700);
    await clip.show('The largest keys, biggest first: the orders stream', 2400);
  });
});

test('es-sql-to-dsl', async () => {
  await film(
    { connections: [DEMO.elasticsearch], connect: [DEMO.elasticsearch.name] },
    async (clip) => {
      const { page } = clip;
      const search = profileItem(page, DEMO.elasticsearch.name);
      await treeRow(page, 'SQL', search).dblclick();
      const sql = visible(page, 'search-sql');
      await expect(sql.getByTestId('sql-editor')).toBeVisible();

      await clip.start('es-sql-to-dsl');
      await clip.show('A SQL tab on Elasticsearch', 1500);
      await clip.click(sql.getByTestId('sql-editor'), { position: { x: 200, y: 14 } });
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Delete');
      await clip.hold(500);
      await clip.enterLines(
        'SELECT wood, COUNT(*) AS products, MAX(lead_time_days) AS lead_days\nFROM products\nWHERE active = true\nGROUP BY wood',
      );
      await clip.show('SQL over the products index', 900);
      await clip.click(sql.getByRole('button', { name: 'Run', exact: true }));
      await expect(sql.getByTestId('sql-row-count')).toHaveText('7 rows');
      await clip.show('Seven rows, one per wood', 1800);
      await clip.click(sql.getByRole('button', { name: 'Translate to DSL' }));
      const dsl = sql.getByTestId('sql-dsl');
      await expect(dsl).toContainText('"aggregations"');
      await expect(dsl).toContainText('"composite"');
      await clip.show('Translate to DSL: the same query as Query DSL', 2400);
      await clip.point(dsl.getByText('"aggregations"').first(), 1200);
      await clip.show('GROUP BY became a composite aggregation', 2200);
    },
  );
});
