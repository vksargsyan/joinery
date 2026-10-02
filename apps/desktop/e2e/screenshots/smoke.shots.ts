import { expect, test, type Page } from '@playwright/test';

import type { LaunchedApp } from '../app';
import {
  addConnection,
  capture,
  connectProfile,
  DEMO,
  launchForShots,
  typeInEditor,
} from './harness';

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;

test.beforeAll(async () => {
  launched = await launchForShots();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

test('smoke', async () => {
  await addConnection(page, DEMO.postgres);
  await connectProfile(page, DEMO.postgres.name);
  await page.getByRole('button', { name: 'New query' }).click();
  await typeInEditor(page, 'select 1 as one');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('row-count')).toHaveText('1 row');
  await capture(page, 'smoke');
});
