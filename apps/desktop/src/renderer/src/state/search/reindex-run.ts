import type { ReindexPlan, ReindexStep, SearchTaskStatus } from '@querybara/search-tools';

import { errorInfo, errorMessage } from '../../lib/errors';

/**
 * Runs a reindex plan (spec §11) step by step: create the new index, start `_reindex` as a
 * server task and follow its progress through the Tasks API until it completes, refresh, then
 * move the aliases. A failed or cancelled copy stops before the aliases move, so clients never
 * switch to a half-filled index. Free of React and IPC, so it can be tested.
 */

export type ReindexRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ReindexRunState {
  readonly plan: ReindexPlan;
  /** The step running (or where the run stopped). */
  readonly step: number;
  readonly status: ReindexRunStatus;
  readonly taskId: string | undefined;
  readonly task: SearchTaskStatus | undefined;
  readonly error: string | undefined;
}

export interface ReindexRunDeps {
  /** Runs a create, refresh or aliases step. */
  run(step: ReindexStep): Promise<void>;
  /** Starts the reindex step as a server task; resolves with its id. */
  start(step: ReindexStep): Promise<string>;
  task(taskId: string): Promise<SearchTaskStatus>;
  /** Waits between polls of the task. */
  sleep(ms: number): Promise<void>;
  /** Cancellation was asked for (the task is being cancelled). */
  cancelled(): boolean;
}

/** The share of a task's documents handled so far, 0 to 1; undefined before it knows. */
export function taskProgress(task: SearchTaskStatus | undefined): number | undefined {
  const progress = task?.progress;
  if (!progress || progress.total === 0) return task?.completed ? 1 : undefined;
  const handled =
    progress.created +
    progress.updated +
    progress.deleted +
    progress.noops +
    progress.versionConflicts;
  return Math.min(1, handled / progress.total);
}

/** Runs the plan (see the module comment); every state change goes to `onChange`. */
export async function runReindexPlan(
  plan: ReindexPlan,
  deps: ReindexRunDeps,
  onChange: (state: ReindexRunState) => void,
  pollMs = 1000,
): Promise<ReindexRunState> {
  let state: ReindexRunState = {
    plan,
    step: 0,
    status: 'running',
    taskId: undefined,
    task: undefined,
    error: undefined,
  };
  const update = (patch: Partial<ReindexRunState>): ReindexRunState => {
    state = { ...state, ...patch };
    onChange(state);
    return state;
  };
  onChange(state);
  for (const [index, step] of plan.steps.entries()) {
    update({ step: index });
    try {
      if (step.kind !== 'reindex') {
        if (deps.cancelled()) return update({ status: 'cancelled' });
        await deps.run(step);
        continue;
      }
      const taskId = await deps.start(step);
      update({ taskId });
      for (;;) {
        const task = await deps.task(taskId);
        update({ task });
        if (task.completed) break;
        await deps.sleep(pollMs);
      }
      const task = state.task!;
      if (task.cancelled || (deps.cancelled() && task.error !== undefined)) {
        return update({ status: 'cancelled' });
      }
      if (task.error !== undefined || task.failures > 0) {
        return update({
          status: 'failed',
          error: `The copy reported ${task.failures > 0 ? `${task.failures} failures` : 'an error'}${task.error ? `: ${task.error}` : ''}`,
        });
      }
    } catch (error) {
      if (errorInfo(error).code === 'CANCELLED') return update({ status: 'cancelled' });
      return update({ status: 'failed', error: errorMessage(error) });
    }
  }
  return update({ status: 'done', step: plan.steps.length });
}
