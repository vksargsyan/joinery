import { z } from 'zod';

/** Ids minted by one process and passed back by another: sessions, executions, connections. */
export const idSchema = z.string().min(1).max(128);

/** A readonly string list, so callers can pass core values such as `BrowseNode.path` as is. */
export const stringListSchema: z.ZodType<readonly string[], readonly string[]> = z.array(
  z.string(),
);

/**
 * Progress of a long call (spec §3: every long call emits progress events). `total` is absent
 * when the work has no known size.
 */
export const taskProgressSchema = z.object({
  /** What is happening now, e.g. "Reading columns" or "Opening SSH tunnel". */
  phase: z.string().optional(),
  completed: z.number().nonnegative(),
  total: z.number().nonnegative().optional(),
});
export type TaskProgress = z.infer<typeof taskProgressSchema>;
