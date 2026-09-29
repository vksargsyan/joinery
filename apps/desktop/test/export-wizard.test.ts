import type { ExportJob } from '@joinery/ipc';
import { describe, expect, it } from 'vitest';

import {
  ExportWizard,
  exportSettingsOf,
  exportStepProblem,
  suggestedName,
  writesOneFile,
  type ExportSource,
  type ExportWizardApi,
} from '../src/renderer/src/state/export-wizard';

/**
 * The export wizard's state machine (spec §12) with a fake app: tables (several from one
 * schema) or a query result → format and options → destination from main's dialogs → a job.
 */

const TABLES: ExportSource = {
  kind: 'tables',
  profileId: 'p1',
  profileName: 'Shop',
  dialect: 'postgres',
  database: 'shop',
  schema: 'public',
  tables: ['orders'],
};

const QUERY: ExportSource = {
  kind: 'query',
  profileId: 'p1',
  profileName: 'Shop',
  dialect: 'mysql',
  database: undefined,
  text: 'SELECT * FROM orders WHERE total > ?',
  params: [100],
};

function fakeApi() {
  const dialogs: { kind: 'file' | 'folder'; defaultName?: string; extensions?: string[] }[] = [];
  const started: ExportJob[] = [];
  const api: ExportWizardApi = {
    saveFile: async (options) => {
      dialogs.push({
        kind: 'file',
        defaultName: options.defaultName,
        extensions: options.filters[0]?.extensions,
      });
      return `/out/${options.defaultName}`;
    },
    openDirectory: async () => {
      dialogs.push({ kind: 'folder' });
      return '/out';
    },
    start: async (job) => {
      started.push(job);
      return 'job-9';
    },
  };
  return { api, dialogs, started };
}

describe('export wizard', () => {
  it('exports one table to a CSV file with its options', async () => {
    const { api, dialogs, started } = fakeApi();
    const wizard = new ExportWizard(TABLES, api, ['customers', 'orders', 'items']);
    expect(wizard.state).toMatchObject({
      step: 'source',
      available: ['customers', 'orders', 'items'],
      selected: ['orders'],
    });
    wizard.next();
    expect(wizard.state.step).toBe('format');
    wizard.setOptions({ delimiter: ';', nullMarker: '\\N', bom: true, gzip: true });
    wizard.next();
    expect(exportStepProblem(wizard.state)).toBe('Choose the file to write');
    await wizard.chooseDestination();
    expect(dialogs).toEqual([{ kind: 'file', defaultName: 'orders.csv.gz', extensions: ['gz'] }]);
    expect(await wizard.run()).toBe('job-9');
    expect(started).toEqual([
      {
        kind: 'export',
        profileId: 'p1',
        database: 'shop',
        source: { kind: 'tables', schema: 'public', tables: ['orders'] },
        format: 'csv',
        csv: { header: true, delimiter: ';', nullMarker: '\\N' },
        bom: true,
        gzip: true,
        output: { kind: 'file', path: '/out/orders.csv.gz' },
      },
    ]);
  });

  it('writes several tables into a folder, or one combined file for SQL and JSON', async () => {
    const { api, dialogs, started } = fakeApi();
    const wizard = new ExportWizard({ ...TABLES, tables: [] }, api);
    expect(exportStepProblem(wizard.state)).toBe('Choose at least one table');
    wizard.setAvailable(['a', 'b', 'c']);
    wizard.toggleTable('c');
    wizard.toggleTable('a');
    expect(wizard.state.selected).toEqual(['a', 'c']);
    wizard.next();
    expect(writesOneFile(wizard.state)).toBe(false);
    wizard.setOptions({ layout: 'combined' });
    expect(exportStepProblem(wizard.state)).toBe(
      'A combined file is not available for CSV; export one file per table',
    );
    wizard.setOptions({ format: 'sql-ddl', rowsPerStatement: 500, dropTable: true });
    expect(exportStepProblem(wizard.state)).toBeUndefined();
    expect(suggestedName(wizard.state)).toBe('public.sql');
    // Switching to a format that cannot combine goes back to one file per table.
    wizard.setOptions({ format: 'tsv' });
    expect(wizard.state.layout).toBe('per-table');
    wizard.setOptions({ format: 'sql-ddl', layout: 'combined' });
    wizard.next();
    await wizard.chooseDestination();
    await wizard.run();
    expect(started[0]).toMatchObject({
      format: 'sql-ddl',
      sql: { rowsPerStatement: 500, dropTable: true },
      output: { kind: 'file', path: '/out/public.sql' },
      source: { tables: ['a', 'c'] },
    });

    wizard.back();
    wizard.setOptions({ layout: 'per-table', format: 'json', pretty: true });
    expect(wizard.state.path).toBeUndefined();
    wizard.next();
    await wizard.chooseDestination();
    expect(dialogs.at(-1)).toEqual({ kind: 'folder' });
    await wizard.run();
    expect(started[1]).toMatchObject({
      format: 'json',
      json: { pretty: true },
      output: { kind: 'directory', path: '/out' },
    });
  });

  it('exports to an Excel workbook with its options, never gzipped or re-encoded', async () => {
    const { api, dialogs, started } = fakeApi();
    const wizard = new ExportWizard(TABLES, api);
    wizard.next();
    wizard.setOptions({ gzip: true, bom: true, encoding: 'utf-16le' });
    wizard.setOptions({ format: 'xlsx', decimalsAsNumbers: true, header: false });
    expect(wizard.state.gzip).toBe(false);
    expect(suggestedName(wizard.state)).toBe('orders.xlsx');
    wizard.next();
    await wizard.chooseDestination();
    expect(dialogs.at(-1)).toEqual({
      kind: 'file',
      defaultName: 'orders.xlsx',
      extensions: ['xlsx'],
    });
    await wizard.run();
    expect(started[0]).toEqual({
      kind: 'export',
      profileId: 'p1',
      database: 'shop',
      source: { kind: 'tables', schema: 'public', tables: ['orders'] },
      format: 'xlsx',
      xlsx: { header: false, decimals: 'number' },
      output: { kind: 'file', path: '/out/orders.xlsx' },
    });
  });

  it('combines tables into one workbook, XML, HTML or Markdown file', () => {
    const { api } = fakeApi();
    const wizard = new ExportWizard({ ...TABLES, tables: ['a', 'b'] }, api);
    wizard.next();
    for (const format of ['xlsx', 'xml', 'html', 'markdown'] as const) {
      wizard.setOptions({ format, layout: 'combined' });
      expect(exportStepProblem(wizard.state), format).toBeUndefined();
      expect(writesOneFile(wizard.state)).toBe(true);
    }
    expect(suggestedName(wizard.state)).toBe('public.md');
  });

  it('zips a file per table into one archive, never with gzip or a combined file', async () => {
    const { api, dialogs, started } = fakeApi();
    const wizard = new ExportWizard({ ...TABLES, tables: ['a', 'b'] }, api);
    wizard.next();
    wizard.setOptions({ format: 'json', layout: 'combined', gzip: true });
    wizard.setOptions({ zip: true });
    expect(wizard.state).toMatchObject({ zip: true, gzip: false, layout: 'per-table' });
    expect(writesOneFile(wizard.state)).toBe(true);
    expect(suggestedName(wizard.state)).toBe('public.zip');
    wizard.next();
    await wizard.chooseDestination();
    expect(dialogs.at(-1)).toEqual({
      kind: 'file',
      defaultName: 'public.zip',
      extensions: ['zip'],
    });
    await wizard.run();
    expect(started[0]).toMatchObject({
      format: 'json',
      zip: true,
      output: { kind: 'file', path: '/out/public.zip' },
    });
    expect(started[0]).not.toHaveProperty('gzip');
    wizard.back();
    wizard.setOptions({ gzip: true });
    expect(wizard.state).toMatchObject({ zip: false, gzip: true, path: undefined });
    wizard.setOptions({ zip: true });
    wizard.setOptions({ layout: 'combined' });
    expect(wizard.state.zip).toBe(false);
  });

  it('exports a query result again from the format step, never with DDL', async () => {
    const { api, started } = fakeApi();
    const wizard = new ExportWizard(QUERY, api);
    expect(wizard.state.step).toBe('format');
    wizard.back();
    expect(wizard.state.step).toBe('format');
    wizard.setOptions({ format: 'sql-ddl' });
    expect(exportStepProblem(wizard.state)).toBe('SQL with DDL exports tables, not a query result');
    wizard.setOptions({ format: 'jsonl' });
    wizard.next();
    await wizard.chooseDestination();
    await wizard.run();
    expect(started[0]).toEqual({
      kind: 'export',
      profileId: 'p1',
      source: { kind: 'query', text: 'SELECT * FROM orders WHERE total > ?', params: [100] },
      format: 'jsonl',
      output: { kind: 'file', path: '/out/query_result.jsonl' },
    });
  });

  it('keeps a start failure on screen', async () => {
    const { api } = fakeApi();
    const wizard = new ExportWizard(TABLES, {
      ...api,
      start: async () => {
        throw new Error('The connection was deleted');
      },
    });
    wizard.next();
    wizard.next();
    expect(await wizard.run()).toBeUndefined();
    expect(wizard.state.error).toBe('Choose the file to write');
    await wizard.chooseDestination();
    expect(await wizard.run()).toBeUndefined();
    expect(wizard.state).toMatchObject({ error: 'The connection was deleted', busy: undefined });
  });

  it('saves and applies its settings', () => {
    const { api } = fakeApi();
    const wizard = new ExportWizard(TABLES, api);
    wizard.setOptions({ format: 'json', pretty: true, gzip: true });
    const settings = exportSettingsOf(wizard.state);
    const other = new ExportWizard(QUERY, api);
    other.applySettings({ ...settings, format: 'sql-ddl' });
    expect(other.state.format).toBe('csv');
    other.applySettings(settings);
    expect(other.state).toMatchObject({ format: 'json', pretty: true, gzip: true });

    wizard.setOptions({ format: 'xlsx', decimalsAsNumbers: true, zip: true });
    const workbook = exportSettingsOf(wizard.state);
    expect(workbook).toMatchObject({
      format: 'xlsx',
      xlsx: { header: true, decimals: 'number' },
      zip: true,
      gzip: false,
    });
    const third = new ExportWizard(TABLES, api);
    third.applySettings(workbook);
    expect(third.state).toMatchObject({ format: 'xlsx', decimalsAsNumbers: true, zip: true });
  });
});
