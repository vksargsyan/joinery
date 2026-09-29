import { describe, expect, it } from 'vitest';

import { refMatches, resolveSelection, type Selectable } from '../src';

/**
 * Selective backup and restore planning: dependencies come along, attached objects follow their
 * table, foreign keys only when every table they link is chosen, exclusions take what needs
 * them.
 */

function object(
  id: string,
  kind: Selectable['kind'],
  dependsOn: string[] = [],
  parent?: string,
): Selectable {
  const name = id.split(':')[1]!;
  return {
    id,
    kind,
    schema: 's',
    name: name
      .split('.')
      .pop()!
      .replace(/\(.*\)$/, ''),
    qualifiedName: name,
    dependsOn,
    ...(parent !== undefined ? { parent } : {}),
  };
}

const OBJECTS: readonly Selectable[] = [
  object('schema:s', 'schema'),
  object('type:s.mood', 'type', ['schema:s']),
  object('routine:s.touch()', 'routine', ['schema:s']),
  object('table:s.customers', 'table', ['schema:s', 'type:s.mood']),
  object('table:s.orders', 'table', ['schema:s']),
  object('table:s.notes', 'table', ['schema:s']),
  object(
    'fk:s.orders.customer',
    'foreign-key',
    ['table:s.orders', 'table:s.customers'],
    'table:s.orders',
  ),
  object('fk:s.notes.self', 'foreign-key', ['table:s.notes'], 'table:s.notes'),
  object(
    'trigger:s.orders.touch',
    'trigger',
    ['table:s.orders', 'routine:s.touch()'],
    'table:s.orders',
  ),
  object('view:s.big', 'view', ['table:s.orders']),
  object('view:s.bigger', 'view', ['view:s.big']),
];

describe('resolveSelection', () => {
  it('chooses everything by default, in order', () => {
    const result = resolveSelection(OBJECTS);
    expect(result.ids).toEqual(OBJECTS.map((o) => o.id));
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('brings dependencies and attached objects, but not foreign keys to unchosen tables', () => {
    const result = resolveSelection(OBJECTS, { include: (o) => o.id === 'table:s.orders' });
    expect(result.ids).toEqual([
      'schema:s',
      'routine:s.touch()',
      'table:s.orders',
      'trigger:s.orders.touch',
    ]);
    expect(result.added).toEqual(['schema:s', 'routine:s.touch()']);
    expect(result.skipped).toEqual([
      { id: 'fk:s.orders.customer', reason: 'links to s.customers, which is not selected' },
    ]);
  });

  it('keeps a foreign key when both of its tables are chosen, and self-references', () => {
    const result = resolveSelection(OBJECTS, {
      include: (o) => ['table:s.orders', 'table:s.customers', 'table:s.notes'].includes(o.id),
    });
    expect(result.ids).toContain('fk:s.orders.customer');
    expect(result.ids).toContain('fk:s.notes.self');
    expect(result.ids).toContain('type:s.mood');
    expect(result.skipped).toEqual([]);
  });

  it('closes over chains of views', () => {
    const result = resolveSelection(OBJECTS, { include: (o) => o.id === 'view:s.bigger' });
    expect(result.ids).toEqual([
      'schema:s',
      'routine:s.touch()',
      'table:s.orders',
      'trigger:s.orders.touch',
      'view:s.big',
      'view:s.bigger',
    ]);
  });

  it('excludes what needs an excluded object, and says why when it was wanted', () => {
    const result = resolveSelection(OBJECTS, { exclude: (o) => o.id === 'table:s.orders' });
    expect(result.ids).not.toContain('table:s.orders');
    expect(result.ids).not.toContain('view:s.big');
    expect(result.ids).not.toContain('view:s.bigger');
    expect(result.ids).not.toContain('trigger:s.orders.touch');
    expect(result.ids).toContain('table:s.customers');
    expect(result.skipped.map((s) => s.id)).toEqual(['view:s.big', 'view:s.bigger']);
    expect(result.skipped[1]!.reason).toBe('needs s.big, which is left out');
  });

  it('matches references by kind, schema and name; routines by name; views either way', () => {
    const view = OBJECTS.find((o) => o.id === 'view:s.big')!;
    expect(refMatches(view, { kind: 'view', name: 'big' })).toBe(true);
    expect(refMatches(view, { kind: 'materialized-view', schema: 's', name: 'big' })).toBe(true);
    expect(refMatches(view, { kind: 'view', schema: 'other', name: 'big' })).toBe(false);
    expect(refMatches(view, { kind: 'table', name: 'big' })).toBe(false);
    const routine = OBJECTS.find((o) => o.kind === 'routine')!;
    expect(refMatches(routine, { kind: 'routine', name: 'touch' })).toBe(true);
  });
});
