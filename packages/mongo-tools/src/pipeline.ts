import { JoineryError } from '@joinery/core';

import { isBsonDocument, Int32, type BsonDocument } from './bson';
import { collectionReference } from './find-text';
import { formatShell, formatShellInline } from './shell/format';

/**
 * Aggregation stage facts for the pipeline editor (spec §9): the stage picker's list, which
 * stages must come first or last, and how a per-stage preview is run on a sample.
 */

export interface StageInfo {
  /** The operator, e.g. "$match". */
  readonly name: string;
  /** "first": only valid as the first stage; "last": only as the last. */
  readonly position?: 'first' | 'last';
  /** Writes to the database ($out, $merge); never run in a preview. */
  readonly writes?: boolean;
  /** The stage cannot be previewed at all (a change stream never ends). */
  readonly previewable?: false;
  /** A starting point for the stage body in shell syntax. */
  readonly template: string;
  readonly description: string;
}

export const AGGREGATION_STAGES: readonly StageInfo[] = [
  { name: '$match', template: '{ field: value }', description: 'Filter documents' },
  { name: '$project', template: '{ field: 1 }', description: 'Reshape documents' },
  { name: '$addFields', template: '{ newField: expression }', description: 'Add fields' },
  { name: '$set', template: '{ field: expression }', description: 'Add or replace fields' },
  { name: '$unset', template: "'field'", description: 'Remove fields' },
  {
    name: '$group',
    template: '{ _id: "$field", count: { $sum: 1 } }',
    description: 'Group and accumulate',
  },
  { name: '$sort', template: '{ field: 1 }', description: 'Sort documents' },
  { name: '$limit', template: '10', description: 'Keep the first N documents' },
  { name: '$skip', template: '10', description: 'Skip N documents' },
  { name: '$count', template: "'count'", description: 'Count documents' },
  { name: '$unwind', template: "'$arrayField'", description: 'One document per array element' },
  {
    name: '$lookup',
    template: "{ from: 'collection', localField: 'field', foreignField: '_id', as: 'joined' }",
    description: 'Join another collection',
  },
  {
    name: '$graphLookup',
    template:
      "{ from: 'collection', startWith: '$field', connectFromField: 'field', connectToField: '_id', as: 'graph' }",
    description: 'Recursive lookup',
  },
  { name: '$facet', template: '{ facet: [] }', description: 'Several pipelines on one input' },
  {
    name: '$bucket',
    template: "{ groupBy: '$field', boundaries: [0, 100], default: 'other' }",
    description: 'Group into ranges',
  },
  {
    name: '$bucketAuto',
    template: "{ groupBy: '$field', buckets: 5 }",
    description: 'Group into N even ranges',
  },
  { name: '$sortByCount', template: "'$field'", description: 'Group, count and sort' },
  {
    name: '$replaceRoot',
    template: "{ newRoot: '$field' }",
    description: 'Promote a sub-document',
  },
  { name: '$replaceWith', template: "'$field'", description: 'Replace each document' },
  { name: '$sample', template: '{ size: 100 }', description: 'Random sample' },
  {
    name: '$unionWith',
    template: "{ coll: 'collection', pipeline: [] }",
    description: 'Append another collection',
  },
  { name: '$redact', template: "'$$KEEP'", description: 'Restrict content by field values' },
  {
    name: '$setWindowFields',
    template: '{ sortBy: { field: 1 }, output: { total: { $sum: "$value" } } }',
    description: 'Window functions',
  },
  {
    name: '$densify',
    template: "{ field: 'date', range: { step: 1, unit: 'day', bounds: 'full' } }",
    description: 'Fill gaps in a sequence',
  },
  {
    name: '$fill',
    template: "{ output: { field: { method: 'linear' } } }",
    description: 'Fill nulls',
  },
  {
    name: '$geoNear',
    position: 'first',
    template:
      "{ near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'distance', spherical: true }",
    description: 'Sort by distance (needs a geospatial index)',
  },
  {
    name: '$search',
    position: 'first',
    template: "{ index: 'default', text: { query: 'term', path: 'field' } }",
    description: 'Atlas Search',
  },
  {
    name: '$searchMeta',
    position: 'first',
    template: "{ index: 'default', facet: {} }",
    description: 'Atlas Search metadata',
  },
  {
    name: '$vectorSearch',
    position: 'first',
    template:
      "{ index: 'vector_index', path: 'embedding', queryVector: [], numCandidates: 100, limit: 10 }",
    description: 'Atlas Vector Search',
  },
  {
    name: '$collStats',
    position: 'first',
    template: '{ storageStats: {} }',
    description: 'Collection statistics',
  },
  { name: '$indexStats', position: 'first', template: '{}', description: 'Index usage' },
  {
    name: '$planCacheStats',
    position: 'first',
    template: '{}',
    description: 'Plan cache entries',
  },
  {
    name: '$listSearchIndexes',
    position: 'first',
    template: '{}',
    description: 'Atlas Search indexes',
  },
  {
    name: '$documents',
    position: 'first',
    template: '[{ x: 1 }]',
    description: 'Literal input documents (db-level aggregate)',
  },
  {
    name: '$currentOp',
    position: 'first',
    template: '{ allUsers: true }',
    description: 'Running operations (admin database)',
  },
  {
    name: '$listSessions',
    position: 'first',
    template: '{}',
    description: 'Sessions (config.system.sessions)',
  },
  {
    name: '$changeStream',
    position: 'first',
    previewable: false,
    template: '{}',
    description: 'Change stream (use the change stream viewer)',
  },
  {
    name: '$out',
    position: 'last',
    writes: true,
    template: "'outputCollection'",
    description: 'Write the results to a collection',
  },
  {
    name: '$merge',
    position: 'last',
    writes: true,
    template: "{ into: 'collection', whenMatched: 'merge', whenNotMatched: 'insert' }",
    description: 'Merge the results into a collection',
  },
];

const STAGES_BY_NAME = new Map(AGGREGATION_STAGES.map((stage) => [stage.name, stage]));

/** The stage's facts, or undefined for an operator not in the list. */
export function stageInfo(name: string): StageInfo | undefined {
  return STAGES_BY_NAME.get(name);
}

/** The operator of a stage document; a stage has exactly one `$` key. */
export function stageOperator(stage: BsonDocument): string {
  const keys = Object.keys(stage);
  if (keys.length !== 1 || !keys[0]!.startsWith('$')) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `A pipeline stage must have exactly one $-operator; found ${keys.length === 0 ? 'none' : keys.map((k) => `"${k}"`).join(', ')}`,
    });
  }
  return keys[0]!;
}

/** True when the stage must run first: `position: 'first'`, or a $match using $text. */
export function mustBeFirst(stage: BsonDocument): boolean {
  const name = stageOperator(stage);
  if (stageInfo(name)?.position === 'first') return true;
  const body = stage[name];
  return name === '$match' && isBsonDocument(body) && '$text' in body;
}

export interface StagePreviewOptions {
  /** Documents taken from the input (after any stage that must run first). Default 1000. */
  readonly sampleSize?: number;
  /** `limit` (default): the first N input documents; `sample`: $sample (random, slower). */
  readonly sampling?: 'limit' | 'sample';
  /** Indexes of stages switched off in the editor. */
  readonly disabled?: readonly number[];
  /** Most documents returned; default 20. */
  readonly outputLimit?: number;
}

export interface StagePreviewPlan {
  /** The pipeline to run. */
  readonly pipeline: readonly BsonDocument[];
  readonly sampled: boolean;
  /** Stage indexes left out: disabled ones and $out / $merge. */
  readonly skippedStages: readonly number[];
}

/**
 * The pipeline that previews the output of stage `stageIndex` (spec §9, per-stage preview on a
 * sample): the enabled stages up to it, with the input cut to a sample right after any stage
 * that must come first ($geoNear, $search, $collStats, a $match on $text...) and the output
 * capped. $out and $merge are left out, so a preview never writes; a $changeStream cannot be
 * previewed (NOT_SUPPORTED).
 */
export function buildStagePreview(
  pipeline: readonly BsonDocument[],
  stageIndex: number,
  options: StagePreviewOptions = {},
): StagePreviewPlan {
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= pipeline.length) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `The pipeline has no stage ${stageIndex + 1}`,
    });
  }
  const sampleSize = Math.max(1, Math.floor(options.sampleSize ?? 1000));
  const outputLimit = Math.max(1, Math.floor(options.outputLimit ?? 20));
  const disabled = new Set(options.disabled ?? []);
  const skipped: number[] = [];
  const stages: BsonDocument[] = [];
  for (let i = 0; i <= stageIndex; i++) {
    const stage = pipeline[i]!;
    const name = stageOperator(stage);
    const info = stageInfo(name);
    if (info?.previewable === false) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `A ${name} stage cannot be previewed`,
        hint: 'Open the change stream viewer to watch changes live',
      });
    }
    if (disabled.has(i) || info?.writes) {
      skipped.push(i);
      continue;
    }
    stages.push(stage);
  }
  const lead = stages.length > 0 && mustBeFirst(stages[0]!) ? 1 : 0;
  const sampling: BsonDocument =
    options.sampling === 'sample'
      ? { $sample: { size: new Int32(sampleSize) } }
      : { $limit: new Int32(sampleSize) };
  const run = [
    ...stages.slice(0, lead),
    sampling,
    ...stages.slice(lead),
    { $limit: new Int32(outputLimit) },
  ];
  return { pipeline: run, sampled: true, skippedStages: skipped };
}

/**
 * The `db.coll.aggregate([...])` text of a pipeline, as mongosh would print it. With
 * `multiline`, the pipeline wraps one stage per line when it does not fit on one.
 */
export function formatAggregateText(
  collection: string,
  pipeline: readonly BsonDocument[],
  options: { readonly multiline?: boolean } = {},
): string {
  const body = options.multiline ? formatShell([...pipeline]) : formatShellInline([...pipeline]);
  return `${collectionReference(collection)}.aggregate(${body})`;
}
