import { schemaSnapshotSchema, type SchemaSnapshot } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import type { SchemaSnapshotInput } from '../src';
import { fakeClock, memoryStore, postgresProfile, thrown } from './helpers';

/** A snapshot shaped like PostgreSQL introspection output, using most of the snapshot schema. */
const SHOP: SchemaSnapshotInput = {
  engine: 'postgres',
  serverVersion: '16.4 (Debian 16.4-1.pgdg120+2)',
  database: 'shop',
  options: { encoding: 'UTF8', collation: 'en_US.utf8' },
  extensions: [{ name: 'pgcrypto', schema: 'public', version: '1.3' }],
  capturedAt: '2026-09-29T09:59:00.000Z',
  schemas: [
    {
      name: 'public',
      owner: 'postgres',
      tables: [
        {
          name: 'customers',
          columns: [
            {
              name: 'id',
              ordinal: 1,
              dataType: 'bigint',
              nullable: false,
              identity: { generation: 'always', start: '1', increment: '1' },
            },
            { name: 'email', ordinal: 2, dataType: 'character varying(320)', nullable: false },
            {
              name: 'created_at',
              ordinal: 3,
              dataType: 'timestamp with time zone',
              nullable: false,
              default: 'now()',
            },
            { name: 'tags', ordinal: 4, dataType: 'text[]', nullable: true, comment: 'Free-form' },
          ],
          primaryKey: { name: 'customers_pkey', columns: ['id'] },
          uniques: [{ name: 'customers_email_key', columns: ['email'] }],
          indexes: [
            {
              name: 'customers_lower_email_idx',
              columns: [{ name: null, expression: 'lower((email)::text)' }],
              method: 'btree',
              definition:
                'CREATE INDEX customers_lower_email_idx ON public.customers USING btree (lower((email)::text))',
            },
          ],
          checks: [{ name: 'customers_email_check', expression: "(email)::text ~~ '%@%'::text" }],
        },
        {
          name: 'orders',
          kind: 'partitioned',
          columns: [
            {
              name: 'id',
              ordinal: 1,
              dataType: 'bigint',
              nullable: false,
              default: "nextval('orders_id_seq'::regclass)",
            },
            { name: 'customer_id', ordinal: 2, dataType: 'bigint', nullable: false },
            { name: 'placed_on', ordinal: 3, dataType: 'date', nullable: false },
            { name: 'total', ordinal: 4, dataType: 'numeric(12,2)', nullable: false, default: '0' },
          ],
          primaryKey: { name: 'orders_pkey', columns: ['id', 'placed_on'] },
          foreignKeys: [
            {
              name: 'orders_customer_id_fkey',
              columns: ['customer_id'],
              refTable: 'customers',
              refColumns: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          partitioning: {
            method: 'RANGE',
            key: '(placed_on)',
            partitions: [{ name: 'orders_2026', bound: "FROM ('2026-01-01') TO ('2027-01-01')" }],
          },
          triggers: [
            {
              name: 'orders_audit',
              timing: 'AFTER',
              events: ['INSERT', 'UPDATE'],
              definition:
                'CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION audit()',
            },
          ],
        },
      ],
      views: [
        {
          name: 'order_totals',
          materialized: true,
          definition: ' SELECT customer_id, sum(total) AS total FROM orders GROUP BY customer_id;',
          columns: ['customer_id', 'total'],
        },
      ],
      routines: [
        {
          name: 'audit',
          kind: 'function',
          signature: '',
          returns: 'trigger',
          language: 'plpgsql',
          definition: 'CREATE OR REPLACE FUNCTION public.audit() RETURNS trigger ...',
        },
      ],
      sequences: [
        {
          name: 'orders_id_seq',
          dataType: 'bigint',
          start: '1',
          increment: '1',
          ownedBy: 'orders.id',
        },
      ],
      types: [
        {
          name: 'order_status',
          kind: 'enum',
          values: ['new', 'paid', 'shipped'],
          definition: "CREATE TYPE public.order_status AS ENUM ('new', 'paid', 'shipped')",
        },
      ],
    },
  ],
};

describe('metadata cache', () => {
  it('round-trips a realistic snapshot per (profile, database)', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile());
    const info = store.metadataCache.put(profile.id, SHOP);
    expect(info).toEqual({
      profileId: profile.id,
      database: 'shop',
      capturedAt: '2026-09-29T09:59:00.000Z',
      storedAt: clock.iso(),
    });
    const cached = store.metadataCache.get(profile.id, 'shop');
    const expected: SchemaSnapshot = schemaSnapshotSchema.parse(SHOP);
    expect(cached).toEqual({ ...info, snapshot: expected });
    expect(store.metadataCache.get(profile.id, 'other')).toBeUndefined();
  });

  it('replaces a database snapshot and lists what is cached', () => {
    const clock = fakeClock();
    const store = memoryStore({ clock });
    const profile = store.profiles.save(postgresProfile());
    store.metadataCache.put(profile.id, SHOP);
    store.metadataCache.put(profile.id, { ...SHOP, database: 'analytics', schemas: [] });
    clock.advance();
    store.metadataCache.put(profile.id, {
      ...SHOP,
      capturedAt: '2026-09-29T10:30:00.000Z',
      schemas: [],
    });
    expect(store.metadataCache.list(profile.id)).toEqual([
      expect.objectContaining({ database: 'analytics' }),
      expect.objectContaining({
        database: 'shop',
        capturedAt: '2026-09-29T10:30:00.000Z',
        storedAt: clock.iso(),
      }),
    ]);
    expect(store.metadataCache.get(profile.id, 'shop')?.snapshot.schemas).toEqual([]);
  });

  it('invalidates one database or the whole profile', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    store.metadataCache.put(profile.id, SHOP);
    store.metadataCache.put(profile.id, { ...SHOP, database: 'analytics' });
    expect(store.metadataCache.invalidate(profile.id, 'shop')).toBe(1);
    expect(store.metadataCache.get(profile.id, 'shop')).toBeUndefined();
    expect(store.metadataCache.invalidate(profile.id)).toBe(1);
    expect(store.metadataCache.list(profile.id)).toEqual([]);
  });

  it('validates input and treats an unreadable entry as a miss', () => {
    const store = memoryStore();
    const profile = store.profiles.save(postgresProfile());
    expect(
      thrown(() =>
        store.metadataCache.put(profile.id, { ...SHOP, engine: 'oracle' as 'postgres' }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(thrown(() => store.metadataCache.put('missing', SHOP))).toMatchObject({
      code: 'NOT_FOUND',
    });
    store.metadataCache.put(profile.id, SHOP);
    store.db.run('UPDATE metadata_cache SET snapshot = \'{"engine":"postgres"}\'');
    expect(store.metadataCache.get(profile.id, 'shop')).toBeUndefined();
    expect(store.metadataCache.list(profile.id)).toEqual([]);
  });
});
