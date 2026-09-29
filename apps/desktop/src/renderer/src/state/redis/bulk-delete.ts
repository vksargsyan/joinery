import type { BulkDeleteProgress, BulkDeleteResult } from '@joinery/driver-redis';
import { parseDisplayBytes } from '@joinery/redis-tools';

/**
 * Bulk delete by pattern (spec §10): a dry run counts the matching keys first (SCAN only), the
 * user confirms the count and a sample, then SCAN + UNLINK runs in batches with progress and
 * can be cancelled. Keys written between the count and the run are deleted too when they
 * match; the confirmation says so.
 */

export type BulkDeletePhase =
  'idle' | 'counting' | 'confirming' | 'deleting' | 'done' | 'cancelled' | 'failed';

export interface BulkDeleteState {
  readonly phase: BulkDeletePhase;
  /** The pattern in display form. */
  readonly pattern: string;
  readonly type: string;
  /** Keys the dry run matched (the number confirmed). */
  readonly counted?: number;
  readonly sample: readonly Uint8Array[];
  readonly progress: BulkDeleteProgress;
  readonly error?: string;
}

const NO_PROGRESS: BulkDeleteProgress = { matched: 0, deleted: 0, failed: 0, scanCalls: 0 };

export function initialBulkDelete(pattern = '', type = ''): BulkDeleteState {
  return { phase: 'idle', pattern, type, sample: [], progress: NO_PROGRESS };
}

/** What the flow needs from the connection: one bulk delete call, dry or real. */
export type BulkDeleteCall = (
  request: { readonly match: Uint8Array; readonly type?: string; readonly dryRun: boolean },
  onProgress: (progress: BulkDeleteProgress) => void,
  signal: AbortSignal,
) => Promise<BulkDeleteResult>;

/**
 * Runs the whole flow and reports each state: count, ask, delete. `confirm` sees the dry run's
 * count and sample and answers whether to go on. Cancelling the signal stops the running
 * phase; a cancelled delete keeps what it already deleted and says how many.
 */
export async function runBulkDelete(options: {
  readonly pattern: string;
  readonly type: string;
  readonly call: BulkDeleteCall;
  readonly confirm: (counted: number, sample: readonly Uint8Array[]) => Promise<boolean>;
  readonly onState: (state: BulkDeleteState) => void;
  readonly signal: AbortSignal;
}): Promise<BulkDeleteState> {
  const { pattern, type, call, onState, signal } = options;
  let state: BulkDeleteState = { ...initialBulkDelete(pattern, type), phase: 'counting' };
  const set = (next: BulkDeleteState): BulkDeleteState => {
    state = next;
    onState(state);
    return state;
  };
  if (pattern.trim() === '') {
    return set({ ...state, phase: 'failed', error: 'Enter a pattern, e.g. session:*' });
  }
  set(state);
  const match = parseDisplayBytes(pattern.trim());
  const request = { match, dryRun: true, ...(type !== '' ? { type } : {}) };
  try {
    const counted = await call(request, (progress) => set({ ...state, progress }), signal);
    if (counted.cancelled || signal.aborted) {
      return set({ ...state, phase: 'cancelled', progress: counted });
    }
    set({
      ...state,
      phase: counted.matched === 0 ? 'done' : 'confirming',
      counted: counted.matched,
      sample: counted.sample,
      progress: NO_PROGRESS,
    });
    if (counted.matched === 0) return state;
    const ok = await options.confirm(counted.matched, counted.sample);
    if (!ok || signal.aborted) return set({ ...state, phase: 'cancelled' });
    set({ ...state, phase: 'deleting' });
    const result = await call(
      { ...request, dryRun: false },
      (progress) => set({ ...state, progress }),
      signal,
    );
    return set({
      ...state,
      phase: result.cancelled ? 'cancelled' : 'done',
      progress: result,
    });
  } catch (error) {
    if (signal.aborted) return set({ ...state, phase: 'cancelled' });
    return set({
      ...state,
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One line for the dialog: "Deleted 1,200 of 5,000 matching keys (2 refused)". */
export function describeBulkDelete(state: BulkDeleteState): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  const { progress } = state;
  const refused = progress.failed > 0 ? ` (${n(progress.failed)} refused)` : '';
  switch (state.phase) {
    case 'idle':
      return 'Count the matching keys first; nothing is deleted until you confirm.';
    case 'counting':
      return `Counting… ${n(progress.matched)} matching keys so far`;
    case 'confirming':
      return `${n(state.counted ?? 0)} keys match ${state.pattern}`;
    case 'deleting':
      return `Deleting… ${n(progress.deleted)} of about ${n(state.counted ?? progress.matched)} keys${refused}`;
    case 'done':
      return state.counted === 0
        ? `No keys match ${state.pattern}`
        : `Deleted ${n(progress.deleted)} keys${refused}`;
    case 'cancelled':
      return progress.deleted > 0
        ? `Cancelled after deleting ${n(progress.deleted)} keys${refused}`
        : 'Cancelled: nothing was deleted';
    case 'failed':
      return state.error ?? 'The bulk delete failed';
  }
}
