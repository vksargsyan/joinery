import { describe, expect, it } from 'vitest';

import {
  AGGREGATION_STAGES,
  buildStagePreview,
  formatShellInline,
  mustBeFirst,
  parseShellPipeline,
  stageInfo,
  stageOperator,
} from '../src';

const pipeline = parseShellPipeline(`[
  { $match: { status: 'A' } },
  { $group: { _id: '$cust', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } },
  { $out: 'totals' },
]`);

const text = (stages: readonly object[]) => stages.map((s) => formatShellInline(s as never));

describe('stage preview', () => {
  it('samples the input, runs stages up to the one previewed and caps the output', () => {
    const plan = buildStagePreview(pipeline, 1, { sampleSize: 500, outputLimit: 10 });
    expect(text(plan.pipeline)).toEqual([
      '{ $limit: 500 }',
      "{ $match: { status: 'A' } }",
      "{ $group: { _id: '$cust', total: { $sum: '$amount' } } }",
      '{ $limit: 10 }',
    ]);
    expect(plan.sampled).toBe(true);
  });

  it('skips disabled stages and never runs $out or $merge', () => {
    const plan = buildStagePreview(pipeline, 3, { disabled: [0], sampling: 'sample' });
    expect(text(plan.pipeline)).toEqual([
      '{ $sample: { size: 1000 } }',
      "{ $group: { _id: '$cust', total: { $sum: '$amount' } } }",
      '{ $sort: { total: -1 } }',
      '{ $limit: 20 }',
    ]);
    expect(plan.skippedStages).toEqual([0, 3]);
  });

  it('keeps stages that must come first in front of the sample', () => {
    const geo = parseShellPipeline(
      "[{ $geoNear: { near: [0, 0], distanceField: 'd' } }, { $project: { d: 1 } }]",
    );
    expect(text(buildStagePreview(geo, 1).pipeline)[0]).toContain('$geoNear');
    const textSearch = parseShellPipeline("[{ $match: { $text: { $search: 'x' } } }]");
    expect(mustBeFirst(textSearch[0]!)).toBe(true);
    expect(text(buildStagePreview(textSearch, 0).pipeline)[1]).toBe('{ $limit: 1000 }');
    expect(() => buildStagePreview(parseShellPipeline('[{ $changeStream: {} }]'), 0)).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
  });

  it('validates stages and indexes', () => {
    expect(() => buildStagePreview(pipeline, 4)).toThrow('no stage 5');
    expect(() => stageOperator({ a: 1, b: 2 } as never)).toThrow('exactly one $-operator');
    expect(stageInfo('$merge')).toMatchObject({ position: 'last', writes: true });
    expect(new Set(AGGREGATION_STAGES.map((s) => s.name)).size).toBe(AGGREGATION_STAGES.length);
  });
});
