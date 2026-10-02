import { rdbAnalyzeInputSchema, rdbAnalyzeProgressSchema, rdbReportSchema } from '../schemas/redis';

/**
 * The `redisDump.*` namespace of the main contract: Redis and Valkey RDB files analysed
 * offline, with no connection. The file is one the window picked with `dialogs.openFile`; the
 * job runner reads it (spec: memory analysis of dump files).
 */
export const redisDumpMainContractShape = {
  /**
   * Reads an RDB file to its end and sums it: keys by database, type, encoding, expiry and
   * pattern, the largest keys. Reports progress in bytes; cancelling stops the reading.
   */
  analyze: {
    input: rdbAnalyzeInputSchema,
    output: rdbReportSchema,
    progress: rdbAnalyzeProgressSchema,
  },
} as const;
