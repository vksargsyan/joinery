import { describe, expect, it } from 'vitest';

import { commandSafety, parseShellDocument } from '../src';

/** The command classifier the desktop console and joinery-cli share (spec §4, §6). */

const safety = (text: string) => commandSafety(parseShellDocument(text));

describe('commandSafety', () => {
  it('counts reads and unknown commands as reads', () => {
    expect(safety('{ find: "orders", filter: { total: { $gt: 100 } } }')).toEqual({
      name: 'find',
      writes: false,
      destructive: false,
    });
    expect(safety('{ someFutureCommand: 1 }')).toMatchObject({ writes: false });
    expect(safety('{}')).toEqual({ name: undefined, writes: false, destructive: false });
  });

  it('knows writes, and which ones destroy', () => {
    expect(safety('{ insert: "o", documents: [{}] }')).toEqual({
      name: 'insert',
      writes: true,
      destructive: false,
    });
    expect(safety('{ createIndexes: "o", indexes: [] }')).toMatchObject({ writes: true });
    expect(safety('{ collMod: "o", validator: {} }')).toMatchObject({ destructive: false });
    for (const text of ['{ drop: "o" }', '{ dropDatabase: 1 }', '{ killOp: 1, op: 5 }']) {
      expect(safety(text)).toMatchObject({ writes: true, destructive: true });
    }
  });

  it('treats multi-document deletes and updates as destructive, single ones as writes', () => {
    expect(safety('{ delete: "o", deletes: [{ q: {}, limit: 0 }] }').destructive).toBe(true);
    expect(safety('{ delete: "o", deletes: [{ q: { _id: 1 }, limit: 1 }] }')).toMatchObject({
      writes: true,
      destructive: false,
    });
    expect(safety('{ update: "o", updates: [{ q: {}, u: {}, multi: true }] }').destructive).toBe(
      true,
    );
    expect(safety('{ update: "o", updates: [{ q: {}, u: {} }] }')).toMatchObject({
      writes: true,
      destructive: false,
    });
    expect(safety('{ renameCollection: "a.b", to: "a.c", dropTarget: true }').destructive).toBe(
      true,
    );
  });

  it('spots pipelines and map-reduce jobs that write their output', () => {
    expect(safety('{ aggregate: "o", pipeline: [{ $out: "x" }], cursor: {} }')).toMatchObject({
      writes: true,
      destructive: false,
    });
    expect(safety('{ aggregate: "o", pipeline: [{ $merge: { into: "x" } }] }').writes).toBe(true);
    expect(safety('{ aggregate: "o", pipeline: [{ $match: {} }], cursor: {} }').writes).toBe(false);
    expect(safety('{ mapReduce: "o", map: "f", reduce: "g", out: "x" }').writes).toBe(true);
    expect(safety('{ mapReduce: "o", map: "f", reduce: "g", out: { inline: 1 } }').writes).toBe(
      false,
    );
  });
});
