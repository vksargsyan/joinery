import { z } from 'zod';

import {
  erModelDraftKeySchema,
  erModelDraftListSchema,
  erModelDraftPutSchema,
  erModelDraftSchema,
  erModelDraftSummarySchema,
} from '../schemas/er-models';

/**
 * The `erModels.*` namespace of the main contract (spec §8): drafts of unapplied ER model
 * changes in the local store.
 */
export const erModelsMainContractShape = {
  /** A connection's drafts (of one database when given), newest first, without their models. */
  listDrafts: { input: erModelDraftListSchema, output: z.array(erModelDraftSummarySchema) },
  /** One place's draft, or null. */
  getDraft: { input: erModelDraftKeySchema, output: erModelDraftSchema.nullable() },
  /** Keeps a draft, replacing the place's previous one. NOT_FOUND for an unknown profile. */
  putDraft: { input: erModelDraftPutSchema, output: erModelDraftSummarySchema },
  deleteDraft: { input: erModelDraftKeySchema, output: z.object({ deleted: z.boolean() }) },
} as const;
