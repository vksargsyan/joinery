import { type Locator, type Page } from '@playwright/test';

/**
 * Small helpers shared by the MongoDB, Redis and Elasticsearch scenes (mongo.shots.ts,
 * redis.shots.ts, search.shots.ts): side bar rows, visible panels, menus and Monaco text.
 */

/** A side bar row by its exact label, anywhere in the tree or inside one profile. */
export function treeRow(page: Page, text: string, scope?: Locator): Locator {
  return (scope ?? page)
    .locator('[data-tree-row]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first();
}

/** The profile's item in the side bar. */
export function profileItem(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

/** The visible element with a test id (dock panels keep hidden copies mounted). */
export function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

/** Opens a tree row's actions menu and picks an item. */
export async function treeMenu(page: Page, row: Locator, item: string | RegExp): Promise<void> {
  await row.hover();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page
    .getByRole('menuitem', typeof item === 'string' ? { name: item, exact: true } : { name: item })
    .click();
}

/** Replaces the text of a Monaco editor (typed as one input, so brackets are not auto-closed). */
export async function replaceText(page: Page, editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

/** Expands a profile's "Tools" folder when needed and opens one of its tools. */
export async function openTool(page: Page, profile: string, tool: string): Promise<void> {
  const item = profileItem(page, profile);
  const row = treeRow(page, tool, item);
  if (!(await row.isVisible())) await treeRow(page, 'Tools', item).click();
  await row.click();
}

/** Closes every dock tab, so each scene's tab strip shows only what the scene is about. */
export async function closeTabs(page: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const tab = page.locator('.dv-tab').first();
    if (!(await tab.isVisible().catch(() => false))) return;
    await tab.click({ button: 'middle' });
    await page.waitForTimeout(100);
  }
}

/**
 * Drags a dock tab onto an edge of its group's content, splitting the group so two panels show
 * side by side (`right`) or one above the other (`bottom`).
 */
export async function splitTab(page: Page, title: string, side: 'right' | 'bottom'): Promise<void> {
  const tab = page.locator('.dv-tab').filter({ hasText: title }).first();
  await tab.click();
  const from = await tab.boundingBox();
  const content = await page
    .locator('.dv-content-container')
    .filter({ visible: true })
    .first()
    .boundingBox();
  if (!from || !content) throw new Error(`no tab or dock content for ${title}`);
  const to =
    side === 'right'
      ? { x: content.x + content.width - 24, y: content.y + content.height / 2 }
      : { x: content.x + content.width / 2, y: content.y + content.height - 24 };
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(300);
}
