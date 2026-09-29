import { describe, expect, it } from 'vitest';

import { mainContract, parseRequest } from '../src';

describe('workspace schemas', () => {
  it('validates saved grid views as they cross to main', () => {
    const view = {
      profileId: 'p1',
      database: null,
      schema: 'public',
      table: 'items',
      name: 'Compact',
      layout: {
        columns: [
          { name: 'id', pinned: true, width: 90 },
          { name: 'note', hidden: true },
        ],
      },
      sort: [{ column: 'id', direction: 'desc' }],
      filter: '{"mode":"raw","raw":"qty > 1"}',
    };
    expect(parseRequest(mainContract, 'gridViews.save', view).input).toEqual(view);
    expect(() =>
      parseRequest(mainContract, 'gridViews.save', {
        ...view,
        layout: { columns: [{ name: 'id', width: 5 }] },
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      parseRequest(mainContract, 'gridViews.save', { ...view, sort: [{ column: 'id' }] }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('accepts only known editor kinds and bounded buffers for autosave', () => {
    const entry = {
      id: 't1',
      kind: 'sql',
      profileId: 'p1',
      database: null,
      title: 'Query',
      text: 'SELECT 1',
      cursor: 8,
      position: 0,
    };
    expect(
      parseRequest(mainContract, 'autosave.save', { upsert: [entry], remove: ['t0'] }).input,
    ).toEqual({ upsert: [entry], remove: ['t0'] });
    expect(() =>
      parseRequest(mainContract, 'autosave.save', {
        upsert: [{ ...entry, kind: 'results' }],
        remove: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      parseRequest(mainContract, 'autosave.save', {
        upsert: [{ ...entry, text: 'x'.repeat(8_000_001) }],
        remove: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
