import { z } from 'zod';

import { updateStatusSchema } from '../schemas/updates';

/**
 * The main contract's `updates.*` methods (spec §20): follow the updater's status, ask for a
 * check, restart into a downloaded update. The channel and "check automatically" are ordinary
 * settings (`updateChannel`, `updateAutoCheck`); main applies them when they change.
 */
export const updatesMainContractShape = {
  /** The current status, then every change, for as long as the caller reads. */
  status: { input: z.void(), item: updateStatusSchema },
  /** Checks now, as the user asked; the outcome arrives on `status`. */
  check: { input: z.void(), output: z.void() },
  /** Quits and installs the downloaded update. Fails with NOT_FOUND when none is ready. */
  install: { input: z.void(), output: z.void() },
};
