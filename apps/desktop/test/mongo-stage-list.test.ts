import { formatShellInline, fromEjson } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  checkStages,
  disabledIndexes,
  insertStage,
  moveStage,
  newStage,
  operatorChoices,
  parsePipelineText,
  pipelineEjson,
  pipelineText,
  pipelineWritesOutput,
  removeStage,
  setStageBody,
  setStageOperator,
  toggleStage,
  type PipelineStage,
} from '../src/renderer/src/state/mongo/stage-list';

/** The aggregation editor's stage cards and the pipeline text kept in step (spec §9). */

function stage(operator: string, body: string, enabled = true): PipelineStage {
  return { id: `${operator}-${body}`, operator, body, enabled };
}

const THREE = [
  stage('$match', "{ status: 'open' }"),
  stage('$sort', '{ total: -1 }', false),
  stage('$limit', '10'),
];

describe('stage list operations', () => {
  it('adds stages with the picked operator’s skeleton and changes operators', () => {
    const match = newStage('$match');
    expect(match).toMatchObject({ operator: '$match', body: '{ field: value }', enabled: true });
    let stages = insertStage([], -1, match);
    const group = newStage('$group');
    stages = insertStage(stages, 0, group);
    expect(stages.map((s) => s.operator)).toEqual(['$match', '$group']);
    stages = insertStage(stages, -1, newStage('$sample'));
    expect(stages.map((s) => s.operator)).toEqual(['$sample', '$match', '$group']);
    // An untouched skeleton follows the operator; typed text stays.
    stages = setStageOperator(stages, match.id, '$project');
    expect(stages[1]).toMatchObject({ operator: '$project', body: '{ field: 1 }' });
    stages = setStageBody(stages, match.id, '{ a: 1 }');
    stages = setStageOperator(stages, match.id, '$addFields');
    expect(stages[1]).toMatchObject({ operator: '$addFields', body: '{ a: 1 }' });
    expect(removeStage(stages, group.id).map((s) => s.operator)).toEqual(['$sample', '$addFields']);
    expect(operatorChoices('$custom')[0]).toBe('$custom');
    expect(operatorChoices('$match')).not.toContain('$custom');
  });

  it('reorders by drag or keyboard, clamping at the ends', () => {
    const ids = (stages: readonly PipelineStage[]) => stages.map((s) => s.operator);
    expect(ids(moveStage(THREE, 0, 2))).toEqual(['$sort', '$limit', '$match']);
    expect(ids(moveStage(THREE, 2, 0))).toEqual(['$limit', '$match', '$sort']);
    expect(ids(moveStage(THREE, 0, -1))).toEqual(ids(THREE));
    expect(ids(moveStage(THREE, 2, 9))).toEqual(ids(THREE));
    expect(ids(moveStage(THREE, 5, 0))).toEqual(ids(THREE));
  });

  it('switches stages off and leaves them out of the pipeline that runs', () => {
    expect(disabledIndexes(THREE)).toEqual([1]);
    expect(formatShellInline(fromEjson(pipelineEjson(THREE)))).toBe(
      "[ { $match: { status: 'open' } }, { $limit: 10 } ]",
    );
    expect((fromEjson(pipelineEjson(THREE, { includeDisabled: true })) as unknown[]).length).toBe(
      3,
    );
    const on = toggleStage(THREE, THREE[1]!.id);
    expect(disabledIndexes(on)).toEqual([]);
    expect(() => pipelineEjson([stage('$match', '{ a: }')])).toThrow(/Stage 1 \(\$match\)/);
  });

  it('checks each body as typed and warns about stages out of place', () => {
    const checks = checkStages([
      stage('$match', '{ total: { $gt: } }'),
      stage('$geoNear', "{ near: [0, 0], distanceField: 'd' }"),
      stage('$out', "'x'"),
      stage('$limit', '5'),
      stage('$unknownStage', '{}'),
      stage('$limit', ''),
    ]);
    const values = Object.values(checks);
    expect(values[0]!.issue).toMatchObject({ column: 17 });
    expect(values[1]!.warning).toBe('$geoNear must be the first stage');
    expect(values[2]!.warning).toBe('$out must be the last stage');
    expect(values[3]!.warning).toBeUndefined();
    expect(values[4]!.warning).toMatch(/not in Querybara's stage list/);
    expect(values[5]!.issue?.message).toBe('The stage is empty');
    // A disabled stage does not count for placement.
    const text = checkStages([
      stage('$match', '{}', false),
      stage('$match', "{ $text: { $search: 'a' } }"),
    ]);
    expect(Object.values(text)[1]!.warning).toBeUndefined();
    expect(pipelineWritesOutput([stage('$match', '{}'), stage('$merge', "{ into: 'x' }")])).toBe(
      true,
    );
    expect(pipelineWritesOutput([stage('$out', "'x'", false), stage('$match', '{}')])).toBe(false);
  });
});

describe('pipeline text', () => {
  it('writes the stages as one text with disabled stages commented out', () => {
    expect(pipelineText(THREE)).toBe(
      "[\n  { $match: { status: 'open' } },\n  // { $sort: { total: -1 } },\n  { $limit: 10 }\n]",
    );
    expect(pipelineText([])).toBe('[]');
    const multi = pipelineText([stage('$group', "{\n  _id: '$city',\n  n: { $sum: 1 }\n}", false)]);
    expect(multi).toBe(
      "[\n  // { $group: {\n  //     _id: '$city',\n  //     n: { $sum: 1 }\n  //   } }\n]",
    );
  });

  it('reads the text back into the same stages, disabled ones included', () => {
    const parsed = parsePipelineText(pipelineText(THREE), THREE);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.stages).toEqual(THREE);
    const multi = parsePipelineText(
      pipelineText([
        stage('$group', "{ _id: '$city', n: { $sum: 1 } }", false),
        stage('$count', "'n'"),
      ]),
    );
    expect(multi.ok && multi.stages.map((s) => [s.operator, s.body, s.enabled])).toEqual([
      ['$group', "{ _id: '$city', n: { $sum: 1 } }", false],
      ['$count', "'n'", true],
    ]);
  });

  it('accepts hand-written text: missing commas, plain comments and a last disabled stage', () => {
    const parsed = parsePipelineText(`[
  // Open orders first
  { $match: { status: 'open' } }
  // { $sort: { total: -1 } }
  { $project: { note: '// not a comment', re: /a\\/b/ } }, // trailing note
  // { $limit: 5 }
]`);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.stages.map((s) => [s.operator, s.enabled])).toEqual([
      ['$match', true],
      ['$sort', false],
      ['$project', true],
      ['$limit', false],
    ]);
    expect(parsed.stages[2]!.body).toContain("'// not a comment'");
  });

  it('keeps the ids of unchanged cards and reports errors where the user typed them', () => {
    const parsed = parsePipelineText('[\n  { $match: { a: 1 } },\n  { $limit: 5 }\n]', THREE);
    expect(parsed.ok && parsed.stages.map((s) => s.id)).toEqual([THREE[0]!.id, expect.any(String)]);
    const broken = parsePipelineText('[\n  // { $sort: { total: -1 } },\n  { $match: { a: } }\n]');
    expect(broken).toMatchObject({ ok: false, issue: { line: 3, column: 18 } });
    expect(parsePipelineText('{ $match: {} }')).toMatchObject({
      ok: false,
      issue: { message: 'The pipeline must be an array [ ... ]' },
    });
    expect(parsePipelineText('[{ $match: {}, $sort: {} }]')).toMatchObject({
      ok: false,
      issue: { message: expect.stringContaining('exactly one $-operator') },
    });
  });
});
