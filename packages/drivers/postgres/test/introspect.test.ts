import { describe, expect, it } from 'vitest';

import { checkExpression, splitPartitionKey, triggerShape } from '../src/introspect';

describe('introspection helpers', () => {
  it('reads trigger timing and events from tgtype bits', () => {
    // ROW | BEFORE | INSERT | UPDATE
    expect(triggerShape(1 | 2 | 4 | 16)).toEqual({
      timing: 'BEFORE',
      events: ['INSERT', 'UPDATE'],
    });
    expect(triggerShape(8 | 32)).toEqual({ timing: 'AFTER', events: ['DELETE', 'TRUNCATE'] });
    expect(triggerShape(1 | 64 | 4)).toEqual({ timing: 'INSTEAD OF', events: ['INSERT'] });
  });

  it('splits pg_get_partkeydef into method and key', () => {
    expect(splitPartitionKey('RANGE (created_at)')).toEqual({
      method: 'RANGE',
      key: '(created_at)',
    });
    expect(splitPartitionKey('HASH (id, region)')).toEqual({ method: 'HASH', key: '(id, region)' });
    expect(splitPartitionKey('LIST (lower(region))')).toEqual({
      method: 'LIST',
      key: '(lower(region))',
    });
  });

  it('strips the CHECK keyword (and NOT VALID) from constraint definitions', () => {
    expect(checkExpression('CHECK ((price > (0)::numeric))')).toBe('((price > (0)::numeric))');
    expect(checkExpression('CHECK ((a < b)) NOT VALID')).toBe('((a < b))');
  });
});
