import { ENGINE_IDS, connectionProfileSchema, type ConnectionProfileInput } from '@querybara/core';
import {
  DB_TABLE_MODES as IPC_TABLE_MODES,
  FIELD_SHAPES as IPC_FIELD_SHAPES,
  storedProfileSchema,
  type StoredProfile,
  type TransferInspection,
  type TransferJob,
  type TransferPlanInfo,
} from '@querybara/ipc';
import {
  DB_TABLE_MODES,
  DEFAULT_DB_TRANSFER_OPTIONS,
  FIELD_SHAPES,
  MONGO_FIELD_TYPES,
  transferSupport,
  type DbTransferSpec,
  type TransferPlan,
} from '@querybara/transfer';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { transferSpecOf } from '../src/job-runner/transfer-db';
import {
  DEFAULT_TRANSFER_OPTIONS,
  MONGO_FIELD_TYPES as RENDERER_BSON_TYPES,
  TransferDbWizard,
  buildTransferJob,
  canTransfer,
  childrenOf,
  stepProblem,
  stepsFor,
  type TransferDbApi,
} from '../src/renderer/src/state/transfer-db/wizard';
import { profileInput } from './helpers';

/**
 * The data transfer wizard's state machine with a fake main (spec §12): source objects,
 * target, options, mapping (planned by the job runner) and review, the job it starts, and the
 * write rules it applies first. The renderer's copies of the engine's lists are checked here.
 */

function stored(overrides: Partial<ConnectionProfileInput>): StoredProfile {
  return storedProfileSchema.parse({
    ...connectionProfileSchema.parse(profileInput(overrides)),
    version: 1,
  });
}

const presentation = (patch: object) => ({
  presentation: {
    folderId: null,
    tags: [],
    environment: 'dev',
    readOnly: false,
    confirmWrites: false,
    ...patch,
  },
});

const PG = stored({ id: 'pg', name: 'Shop', engine: 'postgres' });
const MY = stored({
  id: 'my',
  name: 'Archive',
  engine: 'mysql',
  endpoint: { kind: 'host', host: 'h', port: 3306 },
});
const RO = stored({
  id: 'ro',
  name: 'Locked',
  engine: 'mysql',
  endpoint: { kind: 'host', host: 'h', port: 3306 },
  ...presentation({ readOnly: true }),
} as Partial<ConnectionProfileInput>);
const PROD = stored({
  id: 'prod',
  name: 'Prod',
  engine: 'mysql',
  endpoint: { kind: 'host', host: 'h', port: 3306 },
  ...presentation({ environment: 'production' }),
} as Partial<ConnectionProfileInput>);
const MONGO = stored({
  id: 'mongo',
  name: 'Docs',
  engine: 'mongodb',
  endpoint: { kind: 'host', host: 'h', port: 27017 },
});
const REDIS = stored({
  id: 'redis',
  name: 'Cache',
  engine: 'redis',
  endpoint: { kind: 'host', host: 'h', port: 6379 },
});

const PG_INFO: TransferInspection = {
  engine: 'postgres',
  serverVersion: '16.4',
  databases: ['shop', 'other'],
  database: 'shop',
  schemas: ['public', 'sales'],
  objects: [
    { name: 'orders', kind: 'table', rows: 120, foreignKeys: [] },
    {
      name: 'items',
      kind: 'table',
      rows: 400,
      foreignKeys: [{ name: 'items_order_id_fkey', columns: ['order_id'], refTable: 'orders' }],
    },
  ],
};

const MY_INFO: TransferInspection = {
  engine: 'mysql',
  serverVersion: '8.4.2',
  databases: ['archive', 'mysql'],
  database: 'archive',
  schemas: [],
  objects: [],
};

function plan(patch: Partial<TransferPlanInfo> = {}): TransferPlanInfo {
  return {
    sourceEngine: 'postgres',
    targetEngine: 'mysql',
    sourceVersion: '16.4',
    targetVersion: '8.4.2',
    tables: [
      {
        source: 'orders',
        target: 'orders',
        kind: 'table',
        action: 'create',
        exists: false,
        rows: 120,
        columns: [
          {
            source: 'id',
            target: 'id',
            sourceType: 'integer',
            targetType: 'int',
            defaultType: 'int',
            nullable: false,
            key: true,
            editable: true,
            skipped: false,
          },
        ],
        problems: [],
        warnings: [],
      },
    ],
    before: ['CREATE TABLE `orders` (`id` int NOT NULL)'],
    after: [],
    destructive: [],
    creates: ['Create table orders'],
    problems: [],
    warnings: [],
    ...patch,
  };
}

function fake(options: { plan?: TransferPlanInfo; confirm?: boolean } = {}) {
  const calls = {
    inspect: [] as {
      profileId: string;
      database?: string | undefined;
      schema?: string | undefined;
    }[],
    plans: [] as TransferJob[],
    confirms: [] as { title: string; detail?: string | undefined; danger: boolean }[],
    started: [] as TransferJob[],
  };
  const api: TransferDbApi = {
    profiles: async () => [PG, MY, RO, PROD, MONGO, REDIS],
    inspect: async (profileId, database, schema) => {
      calls.inspect.push({ profileId, database, schema });
      if (profileId === 'pg') return PG_INFO;
      if (profileId === 'redis')
        return {
          engine: 'redis',
          serverVersion: '7.0',
          databases: ['0', '1'],
          database: '0',
          schemas: [],
          objects: [],
          keys: 12,
        };
      if (profileId === 'mongo')
        return {
          engine: 'mongodb',
          serverVersion: '8.0',
          databases: ['admin'],
          schemas: [],
          objects: [],
        };
      return MY_INFO;
    },
    plan: async (job) => {
      calls.plans.push(job);
      return options.plan ?? plan();
    },
    confirm: async (request) => {
      calls.confirms.push(request);
      return options.confirm ?? true;
    },
    start: async (job) => {
      calls.started.push(job);
      return 'job-1';
    },
  };
  return { api, calls };
}

async function atReview(wizard: TransferDbWizard, target = 'my'): Promise<void> {
  await wizard.open();
  await wizard.next();
  await wizard.chooseTarget(target);
  await wizard.next();
  await wizard.next();
  await wizard.next();
}

describe('the transfer wizard', () => {
  it('walks from the source objects to a job with the user’s changes', async () => {
    const { api, calls } = fake();
    const wizard = new TransferDbWizard(
      { profileId: 'pg', database: 'shop', schema: 'public', objects: ['orders'] },
      api,
    );
    await wizard.open();
    expect(wizard.state).toMatchObject({
      step: 'source',
      selected: ['orders'],
      sourceDatabase: 'shop',
      sourceSchema: 'public',
    });
    expect(calls.inspect[0]).toEqual({ profileId: 'pg', database: 'shop', schema: 'public' });
    expect(stepProblem(wizard.state)).toBeUndefined();

    await wizard.next();
    expect(wizard.state.step).toBe('target');
    expect(stepProblem(wizard.state)).toBe('Choose the connection to transfer into');
    await wizard.chooseTarget('my');
    expect(wizard.state).toMatchObject({ targetDatabase: 'archive' });

    await wizard.next();
    expect(wizard.state.step).toBe('options');
    wizard.setOptions({ batchSize: 500, onError: 'skip', parallel: 4 });
    await wizard.next();
    expect(wizard.state.step).toBe('mapping');
    expect(wizard.state.plan?.tables[0]?.target).toBe('orders');

    wizard.setColumn('orders', 'id', { dataType: 'bigint' });
    wizard.setTargetName('orders', 'orders_2024');
    await wizard.replan();
    await wizard.next();
    expect(wizard.state.step).toBe('review');
    expect(await wizard.run()).toBe('job-1');
    // Nothing destructive, a dev profile: no question asked.
    expect(calls.confirms).toEqual([]);
    expect(calls.started[0]).toEqual({
      kind: 'transfer',
      profileId: 'pg',
      database: 'shop',
      schema: 'public',
      objects: [
        { name: 'orders', target: 'orders_2024', columns: [{ source: 'id', dataType: 'bigint' }] },
      ],
      target: { profileId: 'my', database: 'archive' },
      options: {
        mode: 'create',
        batchSize: 500,
        onError: 'skip',
        parallel: 4,
        transactionPerBatch: true,
        disableConstraints: false,
        deferConstraints: true,
        resetSequences: true,
      },
    });
  });

  it('asks before dropping, emptying or overwriting, listing what happens', async () => {
    const { api, calls } = fake({
      plan: plan({
        destructive: ['Drop table orders (it exists) and create it again'],
        creates: ['Create table orders'],
      }),
    });
    const wizard = new TransferDbWizard({ profileId: 'pg', objects: ['orders'] }, api);
    await atReview(wizard);
    expect(await wizard.run()).toBe('job-1');
    expect(calls.confirms).toEqual([
      expect.objectContaining({
        danger: true,
        detail: 'Drop table orders (it exists) and create it again\nCreate table orders',
      }),
    ]);
    expect(calls.started[0]?.confirmed).toBe(true);
  });

  it('asks before any write to a production connection, and stops when told no', async () => {
    const { api, calls } = fake({ confirm: false });
    const wizard = new TransferDbWizard({ profileId: 'pg', objects: ['orders'] }, api);
    await atReview(wizard, 'prod');
    expect(await wizard.run()).toBeUndefined();
    expect(calls.confirms[0]?.title).toBe('Transfer into a production connection?');
    expect(calls.started).toEqual([]);
  });

  it('refuses a read-only target and a plan with problems', async () => {
    const { api } = fake({
      plan: plan({ problems: ['orders: orders already exists on the target'] }),
    });
    const wizard = new TransferDbWizard({ profileId: 'pg', objects: ['orders'] }, api);
    await wizard.open();
    await wizard.next();
    await wizard.chooseTarget('ro');
    expect(stepProblem(wizard.state)).toBe('"Locked" is read-only');
    expect(wizard.state.error).toMatch(/read-only/);
    await wizard.chooseTarget('my');
    await wizard.next();
    await wizard.next();
    expect(stepProblem(wizard.state)).toBe('orders: orders already exists on the target');
    expect(await wizard.run()).toBeUndefined();
  });

  it('offers only targets the source can transfer into', async () => {
    const { api } = fake();
    const wizard = new TransferDbWizard({ profileId: 'redis' }, api);
    await wizard.open();
    const { targetsFor } = await import('../src/renderer/src/state/transfer-db/wizard');
    expect(targetsFor(wizard.state).map((p) => p.id)).toEqual(['redis']);
    const sql = new TransferDbWizard({ profileId: 'pg' }, fake().api);
    await sql.open();
    expect(targetsFor(sql.state).map((p) => p.id)).toEqual(['pg', 'my', 'ro', 'prod', 'mongo']);
  });

  it('copies Redis keys by pattern, without a mapping step', async () => {
    const { api, calls } = fake({
      plan: plan({
        sourceEngine: 'redis',
        targetEngine: 'redis',
        tables: [],
        before: [],
        creates: [],
      }),
    });
    const wizard = new TransferDbWizard(
      { profileId: 'redis', database: '1', pattern: 'user:*' },
      api,
    );
    expect(stepsFor('redis')).toEqual(['source', 'target', 'options', 'review']);
    await wizard.open();
    wizard.setKeyPatterns('user:*\n\n  session:* ');
    await wizard.next();
    await wizard.chooseTarget('redis');
    await wizard.setTargetDatabase('2');
    await wizard.next();
    wizard.setOptions({ replace: true, keepTtl: false });
    await wizard.next();
    expect(wizard.state.step).toBe('review');
    await wizard.run();
    expect(calls.started[0]).toMatchObject({
      profileId: 'redis',
      database: '1',
      objects: [],
      keyPatterns: ['user:*', 'session:*'],
      target: { profileId: 'redis', database: '2' },
      options: { replace: true, keepTtl: false, batchSize: 1000, onError: 'stop', parallel: 2 },
    });
  });

  it('embeds child tables for MongoDB targets', async () => {
    const { api } = fake();
    const wizard = new TransferDbWizard(
      { profileId: 'pg', database: 'shop', objects: ['orders'] },
      api,
    );
    await wizard.open();
    expect(childrenOf(wizard.state, 'orders')).toEqual([
      { table: 'items', foreignKey: 'items_order_id_fkey' },
    ]);
    await wizard.next();
    await wizard.chooseTarget('mongo');
    // A SQL database name is the default MongoDB database.
    expect(wizard.state.targetDatabase).toBe('shop');
    wizard.toggleEmbed('orders', { table: 'items', foreignKey: 'items_order_id_fkey' });
    wizard.setEmbedField('orders', 'items_order_id_fkey', 'lines');
    const job = buildTransferJob(wizard.state, false);
    expect(job.objects).toEqual([
      {
        name: 'orders',
        embed: [{ table: 'items', foreignKey: 'items_order_id_fkey', field: 'lines' }],
      },
    ]);
    expect(job.options).toEqual({
      mode: 'create',
      batchSize: 1000,
      onError: 'stop',
      parallel: 2,
      idFromPrimaryKey: true,
    });
    expect(job.target).toEqual({ profileId: 'mongo', database: 'shop' });
  });
});

describe('the renderer’s copies of the engine’s lists', () => {
  it('match @querybara/transfer and @querybara/ipc', () => {
    expect(DEFAULT_TRANSFER_OPTIONS).toEqual(DEFAULT_DB_TRANSFER_OPTIONS);
    expect([...RENDERER_BSON_TYPES]).toEqual([...MONGO_FIELD_TYPES]);
    expect([...IPC_TABLE_MODES]).toEqual([...DB_TABLE_MODES]);
    expect([...IPC_FIELD_SHAPES]).toEqual([...FIELD_SHAPES]);
    for (const source of ENGINE_IDS) {
      for (const target of ENGINE_IDS) {
        expect(canTransfer(source, target), `${source} → ${target}`).toBe(
          transferSupport(source, target).supported,
        );
      }
    }
  });

  it('has the IPC shapes line up with the engine’s', () => {
    expectTypeOf<ReturnType<typeof transferSpecOf>>().toEqualTypeOf<DbTransferSpec>();
    // Every plan field the renderer reads is one the engine sends.
    expectTypeOf<TransferPlanInfo>().toExtend<TransferPlan>();
  });
});
