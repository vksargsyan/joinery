import { describe, expect, it } from 'vitest';

import {
  TRANSFER_DATA_TYPE_PATTERN,
  jobInfoSchema,
  jobSpecSchema,
  mainContract,
  parseRequest,
  transferJobSchema,
  transferPlanSchema,
} from '../src';

/**
 * The data transfer additions (spec §12): transfer jobs validate what reaches DDL, the plan
 * round-trips, and the wizard's requests are on the main contract.
 */

const job = {
  kind: 'transfer',
  profileId: 'p1',
  database: 'shop',
  schema: 'public',
  objects: [
    {
      name: 'orders',
      target: 'orders_copy',
      mode: 'drop-create',
      columns: [
        { source: 'total', dataType: 'numeric(12,2)' },
        { source: 'note', skip: true },
        { source: 'items', shape: 'child', target: 'order_items' },
      ],
      embed: [{ table: 'items', foreignKey: 'items_order_id_fkey', field: 'items' }],
    },
  ],
  target: { profileId: 'p2', database: 'archive' },
  options: { batchSize: 500, parallel: 4, onError: 'skip', disableConstraints: true },
  confirmed: true,
} as const;

describe('transfer jobs', () => {
  it('are job specs', () => {
    expect(jobSpecSchema.parse(job)).toEqual(job);
    expect(
      transferJobSchema.parse({ ...job, objects: [], keyPatterns: ['user:*'] }).keyPatterns,
    ).toEqual(['user:*']);
  });

  it('refuse column types that are not types', () => {
    for (const dataType of [
      'int; DROP TABLE x',
      'varchar(1), evil int',
      "enum('a'), x int, y enum('b')",
      '',
    ]) {
      const result = transferJobSchema.safeParse({
        ...job,
        objects: [{ name: 'orders', columns: [{ source: 'total', dataType }] }],
      });
      expect(result.success, dataType).toBe(false);
    }
    for (const ok of [
      'varchar(255)',
      'timestamp(3) with time zone',
      "enum('a','b''c')",
      'decimal',
      'int unsigned',
      'text[]',
    ]) {
      expect(TRANSFER_DATA_TYPE_PATTERN.test(ok), ok).toBe(true);
    }
  });

  it('bound modes, batches and parallelism', () => {
    expect(transferJobSchema.safeParse({ ...job, options: { mode: 'replace' } }).success).toBe(
      false,
    );
    expect(transferJobSchema.safeParse({ ...job, options: { parallel: 64 } }).success).toBe(false);
    expect(transferJobSchema.safeParse({ ...job, options: { batchSize: 0 } }).success).toBe(false);
  });

  it('show up in the job list', () => {
    const info = jobInfoSchema.parse({
      id: 'j1',
      kind: 'transfer',
      title: 'Transfer 2 tables from Shop to Archive',
      profileId: 'p1',
      profileName: 'Shop',
      state: 'completed',
      cancelling: false,
      createdAt: '2026-09-29T10:00:00.000Z',
      errors: [{ table: 'orders', row: 3, message: 'Data too long' }],
      log: [],
      target: { table: 'orders, items', database: 'shop' },
    });
    expect(info.errors[0]?.table).toBe('orders');
  });
});

describe('the wizard requests', () => {
  it('are on the main contract', () => {
    expect(
      parseRequest(mainContract, 'transferDb.inspect', { profileId: 'p1', database: 'shop' }),
    ).toEqual({
      method: 'transferDb.inspect',
      input: { profileId: 'p1', database: 'shop' },
    });
    const { confirmed: _confirmed, ...unconfirmed } = job;
    expect(parseRequest(mainContract, 'transferDb.plan', { job: unconfirmed }).method).toBe(
      'transferDb.plan',
    );
  });

  it('get a plan back', () => {
    const plan = {
      sourceEngine: 'postgres',
      targetEngine: 'mongodb',
      sourceVersion: '16.4',
      targetVersion: '8.0.3',
      tables: [
        {
          source: 'orders',
          target: 'orders',
          kind: 'collection',
          action: 'create',
          exists: false,
          rows: 1200,
          columns: [
            {
              source: 'id',
              target: '_id',
              sourceType: 'integer',
              targetType: 'int',
              defaultType: 'int',
              nullable: false,
              key: true,
              editable: true,
              skipped: false,
              note: 'The primary key becomes _id',
            },
          ],
          embeds: [{ table: 'items', field: 'items', foreignKey: 'items_order_id_fkey' }],
          problems: [],
          warnings: [],
        },
      ],
      before: ['db.createCollection("orders")'],
      after: [],
      destructive: [],
      creates: ['Create collection orders'],
      problems: [],
      warnings: [],
    };
    expect(transferPlanSchema.parse(plan)).toEqual(plan);
  });
});
