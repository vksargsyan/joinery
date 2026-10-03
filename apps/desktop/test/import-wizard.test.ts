import { QuerybaraError, tableDefSchema } from '@querybara/core';
import type {
  ImportJob,
  NewTablePlanInput,
  TransferPreview,
  TransferPreviewInput,
} from '@querybara/ipc';
import { describe, expect, it, vi } from 'vitest';

import {
  ImportWizard,
  buildImportJob,
  importSettingsOf,
  stepProblem,
  tableNameFromFile,
  type ImportTarget,
  type ImportWizardApi,
} from '../src/renderer/src/state/import-wizard';

/**
 * The import wizard's state machine (spec §12) with a fake app: file → preview (every option
 * change previews again) → mapping (auto-matched, or the new table planned) → options →
 * review → a job, after the write rules.
 */

const TARGET: ImportTarget = {
  profileId: 'p1',
  profileName: 'Shop',
  dialect: 'postgres',
  database: 'shop',
  schema: 'public',
  table: 'people',
  readOnly: false,
  production: false,
  confirmWrites: false,
};

function preview(overrides: Partial<TransferPreview> = {}): TransferPreview {
  return {
    format: 'csv',
    compression: 'none',
    encoding: 'utf-8',
    bom: false,
    complete: true,
    csv: { delimiter: ',', quote: '"', escape: '"', nullMarker: '', header: true },
    columns: [
      { name: 'ID', type: 'integer', nullable: false, maxLength: 1, samples: 2 },
      { name: 'Full Name', type: 'text', nullable: false, maxLength: 5, samples: 2 },
      { name: 'extra', type: 'text', nullable: true, maxLength: 3, samples: 1 },
    ],
    rows: [
      ['1', 'Ada', 'x'],
      ['2', 'Grace', null],
    ],
    size: 40,
    ...overrides,
  };
}

function fakeApi(overrides: Partial<ImportWizardApi> = {}) {
  const previews: TransferPreviewInput[] = [];
  const plans: NewTablePlanInput[] = [];
  const started: ImportJob[] = [];
  const confirms: string[] = [];
  let answer = true;
  const api: ImportWizardApi = {
    pickFile: async () => '/data/People 2024.csv',
    preview: async (input) => {
      previews.push(input);
      return preview(
        input.csv?.delimiter === ';'
          ? { csv: { delimiter: ';', quote: '"', escape: '"', nullMarker: '', header: true } }
          : {},
      );
    },
    autoMatch: async ({ sources, targets }) =>
      sources.flatMap((source) => {
        const target = targets.find(
          (t) => t.replace(/_/g, '') === source.toLowerCase().replace(/ /g, ''),
        );
        return target ? [{ source, target }] : [];
      }),
    planTable: async (input) => {
      plans.push(input);
      const columns = input.columns.map((column) => ({
        source: column.inferred.name,
        name: column.name ?? column.inferred.name.toLowerCase().replace(/ /g, '_'),
        dataType: column.dataType ?? (column.inferred.type === 'integer' ? 'integer' : 'text'),
        nullable: column.nullable ?? true,
      }));
      return {
        columns,
        primaryKey: columns.filter((c) => input.primaryKey?.includes(c.source)).map((c) => c.name),
        statements: [`CREATE TABLE "${input.schema}"."${input.name}" (…)`],
      };
    },
    loadTable: async () =>
      tableDefSchema.parse({
        name: 'people',
        columns: [
          { name: 'id', ordinal: 1, dataType: 'integer', nullable: false },
          { name: 'full_name', ordinal: 2, dataType: 'text', nullable: true },
          {
            name: 'created',
            ordinal: 3,
            dataType: 'timestamp',
            nullable: false,
            default: 'now()',
          },
          {
            name: 'upper_name',
            ordinal: 4,
            dataType: 'text',
            nullable: true,
            generated: { expression: 'upper(full_name)', stored: true },
          },
        ],
        primaryKey: { name: 'people_pkey', columns: ['id'] },
      }),
    confirm: async (options) => {
      confirms.push(options.title);
      return answer;
    },
    start: async (job) => {
      started.push(job);
      return 'job-1';
    },
    ...overrides,
  };
  return {
    api,
    previews,
    plans,
    started,
    confirms,
    answer: (value: boolean) => {
      answer = value;
    },
  };
}

async function toOptions(wizard: ImportWizard): Promise<void> {
  await wizard.chooseFile();
  await wizard.next();
  await wizard.next();
}

describe('import wizard', () => {
  it('previews the chosen file, then maps its columns by name', async () => {
    const { api, previews } = fakeApi();
    const wizard = new ImportWizard(TARGET, api);
    expect(stepProblem(wizard.state)).toBe('Choose a file to import');
    await wizard.chooseFile();
    expect(wizard.state).toMatchObject({ step: 'preview', path: '/data/People 2024.csv' });
    expect(previews).toEqual([{ path: '/data/People 2024.csv', dialect: 'postgres' }]);
    await wizard.next();
    expect(wizard.state.step).toBe('mapping');
    expect(wizard.state.mapping).toEqual({ ID: 'id', 'Full Name': 'full_name' });
    // Generated columns cannot be imported into; defaulted ones can be left out.
    expect(wizard.state.tableColumns.map((c) => [c.name, c.defaulted])).toEqual([
      ['id', false],
      ['full_name', false],
      ['created', true],
    ]);
  });

  it('previews again when a file option changes, dropping stale answers', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeApi();
    const api: ImportWizardApi = {
      ...fake.api,
      preview: async (input) => {
        if (input.csv?.delimiter === '|') await slow;
        return fake.api.preview(input);
      },
    };
    const wizard = new ImportWizard(TARGET, api);
    await wizard.chooseFile();
    const stale = wizard.setFileOptions({ csv: { delimiter: '|' } });
    await wizard.setFileOptions({ csv: { delimiter: ';' } });
    expect(wizard.state.preview?.csv?.delimiter).toBe(';');
    release();
    await stale;
    expect(wizard.state.preview?.csv?.delimiter).toBe(';');
    expect(wizard.state.csv).toEqual({ delimiter: ';' });
    await wizard.setFileOptions({ format: 'tsv', encoding: 'windows-1252' });
    expect(fake.previews.at(-1)).toEqual({
      path: '/data/People 2024.csv',
      dialect: 'postgres',
      format: 'tsv',
      encoding: 'windows-1252',
      csv: { delimiter: ';' },
    });
  });

  it('shows a preview error and stays put', async () => {
    const { api } = fakeApi({
      preview: async () => {
        throw new QuerybaraError({ code: 'NOT_FOUND', message: '/data/x.csv does not exist' });
      },
    });
    const wizard = new ImportWizard(TARGET, api);
    await wizard.chooseFile();
    expect(wizard.state).toMatchObject({ step: 'file', error: '/data/x.csv does not exist' });
  });

  it('will not import a SQL script or a mapping that uses a column twice', async () => {
    const { api } = fakeApi({ preview: async () => preview({ format: 'sql', columns: [] }) });
    const wizard = new ImportWizard(TARGET, api);
    await wizard.chooseFile();
    expect(stepProblem(wizard.state)).toBe(
      'This is a SQL script; run it with "Run SQL file…" instead',
    );
    await wizard.next();
    expect(wizard.state.step).toBe('preview');

    const other = new ImportWizard(TARGET, fakeApi().api);
    await other.chooseFile();
    await other.next();
    other.setMapping('extra', 'id');
    expect(stepProblem(other.state)).toBe('Column "id" is mapped more than once');
    other.setMapping('extra', '');
    other.setMapping('ID', '');
    other.setMapping('Full Name', '');
    expect(stepProblem(other.state)).toBe('Map at least one column');
  });

  it('needs mapped key columns for update, upsert and delete', async () => {
    const wizard = new ImportWizard(TARGET, fakeApi().api);
    await toOptions(wizard);
    expect(wizard.state).toMatchObject({ step: 'options', keyColumns: ['id'] });
    wizard.setOptions({ mode: 'upsert', keyColumns: [] });
    expect(stepProblem(wizard.state)).toBe('Mode "upsert" needs key columns');
    wizard.setOptions({ keyColumns: ['created'] });
    expect(stepProblem(wizard.state)).toBe('Key column "created" is not mapped');
    wizard.setOptions({ keyColumns: ['id', 'full_name'], mode: 'update' });
    expect(stepProblem(wizard.state)).toBe('Update needs a mapped column besides the keys');
    wizard.setOptions({ keyColumns: ['id'] });
    expect(stepProblem(wizard.state)).toBeUndefined();
    await wizard.next();
    expect(wizard.state.step).toBe('review');
    wizard.back();
    expect(wizard.state.step).toBe('options');
  });

  it('builds the job from the preview, mapping and options', async () => {
    const { api, started } = fakeApi();
    const wizard = new ImportWizard(TARGET, api);
    await toOptions(wizard);
    wizard.setOptions({
      mode: 'upsert',
      batchSize: 500,
      transaction: 'per-batch',
      onError: 'skip',
      disableForeignKeys: true,
    });
    await wizard.next();
    expect(await wizard.run()).toBe('job-1');
    expect(started).toEqual([
      {
        kind: 'import',
        profileId: 'p1',
        database: 'shop',
        file: {
          path: '/data/People 2024.csv',
          format: 'csv',
          encoding: 'utf-8',
          csv: { delimiter: ',', quote: '"', escape: '"', nullMarker: '', header: true },
        },
        table: { schema: 'public', name: 'people' },
        mapping: [
          { source: 'ID', target: 'id' },
          { source: 'Full Name', target: 'full_name' },
        ],
        mode: 'upsert',
        keyColumns: ['id'],
        batchSize: 500,
        transaction: 'per-batch',
        onError: 'skip',
        disableForeignKeys: true,
      },
    ]);
    expect(wizard.state.jobId).toBe('job-1');
    expect(importSettingsOf(wizard.state)).toEqual({
      format: 'csv',
      mode: 'upsert',
      batchSize: 500,
      transaction: 'per-batch',
      onError: 'skip',
      disableForeignKeys: true,
    });
  });

  it('warns that replace empties the table and asks production profiles first', async () => {
    const fake = fakeApi();
    const wizard = new ImportWizard(TARGET, fake.api);
    await toOptions(wizard);
    wizard.setOptions({ mode: 'replace' });
    await wizard.next();
    fake.answer(false);
    expect(await wizard.run()).toBeUndefined();
    expect(fake.confirms).toEqual(['Replace the rows of people?']);
    expect(fake.started).toEqual([]);
    fake.answer(true);
    await wizard.run();
    expect(fake.started[0]).toMatchObject({ mode: 'replace', confirmed: true });

    const production = fakeApi();
    const prod = new ImportWizard(
      { ...TARGET, production: true, confirmWrites: true },
      production.api,
    );
    await toOptions(prod);
    await prod.next();
    await prod.run();
    expect(production.confirms).toEqual(['Import into a production connection?']);
    expect(production.started[0]?.confirmed).toBe(true);
  });

  it('refuses a read-only profile from the start', async () => {
    const { api, started } = fakeApi();
    const wizard = new ImportWizard({ ...TARGET, readOnly: true }, api);
    expect(wizard.state.error).toBe('"Shop" is read-only, so nothing can be imported into it.');
    expect(stepProblem(wizard.state)).toBe('The connection is read-only');
    expect(await wizard.run()).toBeUndefined();
    expect(started).toEqual([]);
  });

  it('plans a new table from the inferred columns and the edits', async () => {
    const fake = fakeApi();
    const wizard = new ImportWizard({ ...TARGET, table: null }, fake.api);
    await wizard.chooseFile();
    expect(wizard.state.newTableName).toBe('people_2024');
    await wizard.next();
    expect(wizard.state.step).toBe('mapping');
    expect(wizard.state.plan?.columns.map((c) => c.name)).toEqual(['id', 'full_name', 'extra']);
    expect(fake.plans.at(-1)).toMatchObject({
      dialect: 'postgres',
      name: 'people_2024',
      schema: 'public',
      primaryKey: [],
    });

    wizard.setNewColumn('extra', { include: false });
    wizard.setNewColumn('Full Name', { name: 'name', dataType: 'varchar(80)' });
    wizard.togglePrimaryKey('ID');
    wizard.setNewTableName('people');
    await vi.waitFor(() =>
      expect(wizard.state.plan?.columns.map((c) => c.name)).toEqual(['id', 'name']),
    );
    expect(fake.plans.at(-1)?.primaryKey).toEqual(['ID']);
    expect(wizard.state.plan?.primaryKey).toEqual(['id']);

    wizard.setNewColumn('ID', { dataType: 'int; DROP TABLE x' });
    expect(stepProblem(wizard.state)).toBe(
      '"int; DROP TABLE x" is not a column type Querybara can use',
    );
    wizard.setNewColumn('ID', { dataType: '' });
    await vi.waitFor(() => expect(stepProblem(wizard.state)).toBeUndefined());

    await wizard.next();
    await wizard.next();
    expect(wizard.state.step).toBe('review');
    await wizard.run();
    const job = fake.started[0]!;
    expect(job.table).toEqual({ schema: 'public', name: 'people' });
    expect(job.mode).toBe('append');
    expect(job.create?.columns.map((c) => [c.source, c.name, c.dataType])).toEqual([
      ['ID', 'id', 'integer'],
      ['Full Name', 'name', 'varchar(80)'],
    ]);
    expect(job.mapping).toEqual([
      { source: 'ID', target: 'id' },
      { source: 'Full Name', target: 'name' },
    ]);
  });

  it('applies saved settings and previews again with their file options', async () => {
    const fake = fakeApi();
    const wizard = new ImportWizard(TARGET, fake.api);
    await wizard.chooseFile();
    await wizard.applySettings({
      csv: { delimiter: ';' },
      mode: 'upsert',
      batchSize: 250,
      onError: 'skip',
    });
    expect(wizard.state.preview?.csv?.delimiter).toBe(';');
    expect(wizard.state).toMatchObject({ mode: 'upsert', batchSize: 250, onError: 'skip' });
  });

  it('previews another worksheet or header row of a workbook and imports with them', async () => {
    const workbook = (input: TransferPreviewInput): TransferPreview =>
      preview({
        format: 'xlsx',
        csv: undefined,
        sheets: ['People', 'Totals'],
        xlsx: { sheet: input.xlsx?.sheet ?? 'People', headerRow: input.xlsx?.headerRow ?? 1 },
      });
    const fake = fakeApi({
      pickFile: async () => '/data/People.xlsx',
      preview: async (i) => workbook(i),
    });
    const wizard = new ImportWizard(TARGET, fake.api);
    await wizard.chooseFile();
    expect(wizard.state.preview?.xlsx).toEqual({ sheet: 'People', headerRow: 1 });
    await wizard.setFileOptions({ xlsx: { sheet: 'Totals' } });
    await wizard.setFileOptions({ xlsx: { headerRow: 3 } });
    expect(wizard.state.preview?.xlsx).toEqual({ sheet: 'Totals', headerRow: 3 });
    await wizard.next();
    await wizard.next();
    await wizard.next();
    await wizard.run();
    expect(fake.started[0]?.file).toEqual({
      path: '/data/People.xlsx',
      format: 'xlsx',
      xlsx: { sheet: 'Totals', headerRow: 3 },
    });
    expect(importSettingsOf(wizard.state)).toMatchObject({
      format: 'xlsx',
      xlsx: { sheet: 'Totals', headerRow: 3 },
    });
    expect(tableNameFromFile('/data/People.xlsx')).toBe('people');
  });

  it('imports XML rows from the path the preview found or the one chosen', async () => {
    const fake = fakeApi({
      pickFile: async () => '/data/orders.xml',
      preview: async (input) =>
        preview({
          format: 'xml',
          csv: undefined,
          xml: {
            rowPath: input.xml?.rowPath ?? '/orders/order',
            candidates: [{ path: '/orders/order', count: 2, fields: 3 }],
          },
        }),
    });
    const wizard = new ImportWizard(TARGET, fake.api);
    await wizard.chooseFile();
    await wizard.setFileOptions({ xml: { rowPath: '/orders/item' } });
    expect(wizard.state.preview?.xml?.rowPath).toBe('/orders/item');
    await wizard.applySettings({ xml: { rowPath: '/orders/order' } });
    await wizard.next();
    await wizard.next();
    await wizard.next();
    await wizard.run();
    expect(fake.started[0]?.file).toEqual({
      path: '/data/orders.xml',
      format: 'xml',
      encoding: 'utf-8',
      xml: { rowPath: '/orders/order' },
    });
  });

  it('names a new table after its file', () => {
    expect(tableNameFromFile('/tmp/Orders 2024.csv.gz')).toBe('orders_2024');
    expect(tableNameFromFile('C:\\data\\2024-sales.json')).toBe('t_2024_sales');
    expect(tableNameFromFile('/tmp/---.csv')).toBe('imported');
  });

  it('refuses to build a job before a file is previewed', () => {
    const wizard = new ImportWizard(TARGET, fakeApi().api);
    expect(() => buildImportJob(wizard.state, false)).toThrow('Choose a file to import first');
  });
});
