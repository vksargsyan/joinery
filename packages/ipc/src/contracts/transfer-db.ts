import {
  transferInspectInputSchema,
  transferInspectionSchema,
  transferPlanInputSchema,
  transferPlanSchema,
} from '../schemas/transfer-db';

/**
 * The `transferDb.*` namespace of the main contract (spec §12): what the data transfer wizard
 * asks before a transfer starts. Main resolves the profiles' secrets and hands the work to the
 * job runner, which connects, reads and writes nothing; the transfer itself is a `transfer`
 * job started with `jobs.start`.
 */
export const transferDbMainContractShape = {
  /** A connection's databases, PostgreSQL schemas, and tables or collections (with row estimates). */
  inspect: { input: transferInspectInputSchema, output: transferInspectionSchema },
  /**
   * What a transfer will do: target tables with columns and types (the engine pair's mapping
   * and the user's changes), the statements before and after the data, what is dropped,
   * emptied or created, and the problems that stop it.
   */
  plan: { input: transferPlanInputSchema, output: transferPlanSchema },
};
