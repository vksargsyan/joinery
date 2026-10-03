import { toEjson } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import { commandSafety, parseCommands, relaxedText } from '../src/mongo';

/** querybara query on MongoDB targets: command documents, their write rules and the output. */

describe('MongoDB commands in querybara query', () => {
  it('reads one command document or an array of them', () => {
    expect(parseCommands('{ find: "orders", filter: { total: { $gt: 100 } } }')).toHaveLength(1);
    expect(
      parseCommands('[{ ping: 1 }, { count: "orders" }]').map((c) => Object.keys(c)[0]),
    ).toEqual(['ping', 'count']);
    expect(() => parseCommands('[1, 2]')).toThrow('A MongoDB command must be a document');
    expect(() => parseCommands('{ find: }')).toThrow(/line 1, column/);
  });

  it('classifies writes and destructive commands', () => {
    const [find, insert, drop, deleteAll, deleteOne, updateAll, out] = parseCommands(
      `[{ find: "o" }, { insert: "o", documents: [{}] }, { drop: "o" },
        { delete: "o", deletes: [{ q: {}, limit: 0 }] }, { delete: "o", deletes: [{ q: { _id: 1 }, limit: 1 }] },
        { update: "o", updates: [{ q: {}, u: { $set: { a: 1 } }, multi: true }] },
        { aggregate: "o", pipeline: [{ $merge: { into: "x" } }], cursor: {} }]`,
    );
    expect(commandSafety(find!)).toEqual({ name: 'find', writes: false, destructive: false });
    expect(commandSafety(insert!)).toMatchObject({ writes: true, destructive: false });
    expect(commandSafety(drop!)).toMatchObject({ writes: true, destructive: true });
    expect(commandSafety(deleteAll!)).toMatchObject({ destructive: true });
    expect(commandSafety(deleteOne!)).toMatchObject({ writes: true, destructive: false });
    expect(commandSafety(updateAll!)).toMatchObject({ destructive: true });
    expect(commandSafety(out!)).toMatchObject({ writes: true, destructive: false });
  });

  it('prints documents as indented relaxed Extended JSON', () => {
    expect(relaxedText(toEjson({ _id: 1, total: 2.5, at: new Date('2026-01-01T00:00:00Z') }))).toBe(
      '{\n  "_id": 1,\n  "total": 2.5,\n  "at": {\n    "$date": "2026-01-01T00:00:00Z"\n  }\n}',
    );
  });
});
