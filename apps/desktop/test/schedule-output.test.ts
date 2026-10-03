import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  nameSlug,
  outputPattern,
  pruneOutputs,
  renderOutputName,
  uniqueOutputPath,
} from '../src/main/schedule-output';

const folders: string[] = [];

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'querybara-schedule-'));
  folders.push(path);
  return path;
}

afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('scheduled outputs', () => {
  const at = new Date(2026, 8, 30, 2, 5);

  it('are named from the template, in local time', () => {
    expect(renderOutputName('{name}-{date}-{time}.qbak', 'Nightly backup', at)).toBe(
      'Nightly-backup-2026-09-30-02-05.qbak',
    );
    expect(renderOutputName('orders_{date}.csv', 'x', at)).toBe('orders_2026-09-30.csv');
    expect(nameSlug(' Шоп / prod: nightly! ')).toBe('Шоп-prod-nightly');
    expect(nameSlug('***')).toBe('schedule');
  });

  it('never overwrite: a second run in the same minute gets -2, -3…', () => {
    const dir = folder();
    const first = uniqueOutputPath(dir, 'shop-2026-09-30-02-05.sql.gz');
    expect(first).toBe(join(dir, 'shop-2026-09-30-02-05.sql.gz'));
    writeFileSync(first, '');
    expect(uniqueOutputPath(dir, 'shop-2026-09-30-02-05.sql.gz')).toBe(
      join(dir, 'shop-2026-09-30-02-05-2.sql.gz'),
    );
    writeFileSync(join(dir, 'shop-2026-09-30-02-05-2.sql.gz'), '');
    expect(uniqueOutputPath(dir, 'shop-2026-09-30-02-05.sql.gz')).toBe(
      join(dir, 'shop-2026-09-30-02-05-3.sql.gz'),
    );
  });

  it('match only what the template produces', () => {
    const pattern = outputPattern('{name}-{date}-{time}.sql.gz', 'Nightly backup');
    expect(pattern.test('Nightly-backup-2026-09-30-02-05.sql.gz')).toBe(true);
    expect(pattern.test('Nightly-backup-2026-09-30-02-05-2.sql.gz')).toBe(true);
    expect(pattern.test('Nightly-backup-2026-09-30-02-05.sql')).toBe(false);
    expect(pattern.test('Other-2026-09-30-02-05.sql.gz')).toBe(false);
    expect(pattern.test('Nightly-backup-keep-me.sql.gz')).toBe(false);
    expect(outputPattern('a.b({date}).csv', 'x').test('a.b(2026-09-30).csv')).toBe(true);
  });

  it('prune to the newest N of this schedule’s outputs, and nothing else', async () => {
    const dir = folder();
    const names = [
      'nightly-2026-09-26-02-00.qbak',
      'nightly-2026-09-27-02-00.qbak',
      'nightly-2026-09-28-02-00.qbak',
      'nightly-2026-09-29-02-00.qbak',
    ];
    names.forEach((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, name);
      const time = new Date(2026, 8, 26 + i, 2, 0);
      utimesSync(path, time, time);
    });
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'weekly-2026-09-01-02-00.qbak'), 'another schedule');
    mkdirSync(join(dir, 'nightly-2026-09-01-02-00.qbak'));
    const old = new Date(2026, 8, 1, 2, 0);
    utimesSync(join(dir, 'nightly-2026-09-01-02-00.qbak'), old, old);

    const deleted = await pruneOutputs(dir, '{name}-{date}-{time}.qbak', 'nightly', 2);
    // The oldest go, the folder of the same name included (an export of several tables).
    expect(deleted.map((p) => p.slice(dir.length + 1)).sort()).toEqual([
      'nightly-2026-09-01-02-00.qbak',
      'nightly-2026-09-26-02-00.qbak',
      'nightly-2026-09-27-02-00.qbak',
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      'nightly-2026-09-28-02-00.qbak',
      'nightly-2026-09-29-02-00.qbak',
      'notes.txt',
      'weekly-2026-09-01-02-00.qbak',
    ]);
    // A folder that is gone prunes nothing.
    expect(await pruneOutputs(join(dir, 'gone'), '{date}.x', 'n', 1)).toEqual([]);
  });
});
