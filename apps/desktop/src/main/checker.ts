import {
  QuerybaraError,
  fromErrorData,
  type ConnectionCheckResult,
  type ResolvedProfile,
} from '@querybara/core';

import { hostToMainSchema } from '../shared/host-protocol';
import type { HostProcessFactory } from './host-process';
import { answerHostKeyRequest, type HostKeyVerification } from './host-keys';

export interface ConnectionCheckOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Answers SSH host key questions; without it every host key is refused. */
  readonly hostKeys?: HostKeyVerification;
}

/**
 * Test Connection (spec §4) in a short-lived connection host: drivers never load into main, and
 * a check that hangs or crashes takes only its own process down. Yields each step as the host
 * reports it. Stopping early (abort, leaving the loop) kills the process. The timeout waits
 * while the user answers a host key question.
 */
export async function* runConnectionCheck<P>(
  spawn: HostProcessFactory<P>,
  resolved: ResolvedProfile,
  options: ConnectionCheckOptions = {},
): AsyncGenerator<ConnectionCheckResult> {
  const queue: ConnectionCheckResult[] = [];
  let finished: { error?: QuerybaraError } | undefined;
  let wake: (() => void) | undefined;
  const settle = (outcome: { error?: QuerybaraError }): void => {
    finished ??= outcome;
    wake?.();
  };

  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        settle({
          error: new QuerybaraError({ code: 'TIMEOUT', message: 'The connection test timed out' }),
        }),
      timeoutMs,
    );
  };
  let pendingHostKeys = 0;

  const process = spawn(`Querybara connection test: ${resolved.profile.name}`);
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
    } else if (message.type === 'host-key') {
      pendingHostKeys += 1;
      clearTimeout(timer);
      void answerHostKeyRequest(
        process,
        message,
        options.hostKeys,
        { profileName: resolved.profile.name, purpose: 'test' },
        () => finished === undefined,
      ).finally(() => {
        pendingHostKeys -= 1;
        if (pendingHostKeys === 0 && finished === undefined) armTimer();
      });
    }
  });
  process.onExit((code) =>
    settle({
      error: new QuerybaraError({
        code: 'CONNECTION_FAILED',
        message: `The connection test stopped unexpectedly${code === null ? '' : ` (code ${code})`}`,
      }),
    }),
  );
  armTimer();
  const onAbort = (): void =>
    settle({ error: new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' }) });
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
    finished ??= {};
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    process.kill();
  }
}
