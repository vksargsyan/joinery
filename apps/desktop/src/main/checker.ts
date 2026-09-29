import {
  JoineryError,
  fromErrorData,
  type ConnectionCheckResult,
  type ResolvedProfile,
} from '@joinery/core';

import { hostToMainSchema } from '../shared/host-protocol';
import type { HostProcessFactory } from './host-process';

/**
 * Test Connection (spec §4) in a short-lived connection host: drivers never load into main, and
 * a check that hangs or crashes takes only its own process down. Yields each step as the host
 * reports it. Stopping early (abort, leaving the loop) kills the process.
 */
export async function* runConnectionCheck<P>(
  spawn: HostProcessFactory<P>,
  resolved: ResolvedProfile,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): AsyncGenerator<ConnectionCheckResult> {
  const queue: ConnectionCheckResult[] = [];
  let finished: { error?: JoineryError } | undefined;
  let wake: (() => void) | undefined;
  const settle = (outcome: { error?: JoineryError }): void => {
    finished ??= outcome;
    wake?.();
  };

  const process = spawn(`Joinery connection test: ${resolved.profile.name}`);
  process.onMessage((raw) => {
    const parsed = hostToMainSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'check-step') {
      queue.push(message.result);
      wake?.();
    } else if (message.type === 'check-done') {
      settle({});
    } else if (message.type === 'failed') {
      settle({ error: fromErrorData(message.error) });
    }
  });
  process.onExit((code) =>
    settle({
      error: new JoineryError({
        code: 'CONNECTION_FAILED',
        message: `The connection test stopped unexpectedly${code === null ? '' : ` (code ${code})`}`,
      }),
    }),
  );
  const timer = setTimeout(
    () =>
      settle({
        error: new JoineryError({ code: 'TIMEOUT', message: 'The connection test timed out' }),
      }),
    options.timeoutMs ?? 60_000,
  );
  const onAbort = (): void =>
    settle({ error: new JoineryError({ code: 'CANCELLED', message: 'Cancelled' }) });
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    process.send({ type: 'check', resolved });
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (finished) {
        if (finished.error) throw finished.error;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    process.kill();
  }
}
