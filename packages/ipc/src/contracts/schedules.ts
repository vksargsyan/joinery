import { z } from 'zod';

import { idSchema } from '../schemas/common';
import {
  scheduleEventSchema,
  scheduleInfoSchema,
  scheduleRunInfoSchema,
  scheduleSaveInputSchema,
} from '../schemas/schedules';

/**
 * The `schedules.*` namespace of the main contract: scheduled backups, SQL files, exports and
 * comparisons, which main runs while Querybara is open, and their run history.
 */
export const schedulesMainContractShape = {
  list: { input: z.void(), output: z.array(scheduleInfoSchema) },
  /**
   * Creates or updates a schedule. Its output folder must have been picked with
   * `dialogs.openDirectory` (and a SQL file with `dialogs.openFile`) in this window.
   */
  save: { input: scheduleSaveInputSchema, output: scheduleInfoSchema },
  delete: { input: z.object({ id: idSchema }), output: z.void() },
  setEnabled: {
    input: z.object({ id: idSchema, enabled: z.boolean() }),
    output: scheduleInfoSchema,
  },
  /** Runs it now, whatever its schedule says; the run is recorded as manual. */
  runNow: { input: z.object({ id: idSchema }), output: z.object({ runId: idSchema }) },
  runs: {
    input: z.object({ id: idSchema, limit: z.number().int().min(1).max(200).optional() }),
    output: z.array(scheduleRunInfoSchema),
  },
  /** What changed, for as long as the caller reads; the panel reloads on each event. */
  events: { input: z.void(), item: scheduleEventSchema },
} as const;
