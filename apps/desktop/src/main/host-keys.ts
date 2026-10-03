import { QuerybaraError, newId, toErrorData, type ErrorData } from '@querybara/core';
import type { HostKeyAnswer, HostKeyPrompt, HostKeyPromptEvent } from '@querybara/ipc';
import type { KnownHostsStore } from '@querybara/tunnel';

import type { HostToMain } from '../shared/host-protocol';
import type { HostProcess } from './host-process';

/**
 * SSH host key verification for every connection host (spec §4). Hosts have no window, so their
 * tunnels ask main for each host key the SSH server presents. Main trusts a key remembered in
 * the known-hosts file, and asks the user about a new one (trust once, trust and remember, or
 * cancel). A key that differs from the remembered one is a loud, blocking warning that offers no
 * way to trust it except removing the remembered key first. A question nobody answers in time,
 * or asked while no window listens, counts as cancelled.
 *
 * The tunnel code (and ssh2 with it) loads on first use, so it stays out of the app's start-up.
 */

export type HostKeyRequest = Omit<Extract<HostToMain, { type: 'host-key' }>, 'type'>;

/** Who is asking, shown in the question. */
export interface HostKeyContext {
  readonly profileName: string;
  readonly purpose: HostKeyPrompt['purpose'];
}

/** Main's answer for a host, as sent in `host-key-decision`. */
export interface HostKeyVerdict {
  readonly decision: 'trust' | 'reject';
  /** Why a key was refused, when there is more to say than "not trusted" (a changed key). */
  readonly error?: ErrorData;
}

/** Decides about one host key; never rejects. */
export interface HostKeyVerification {
  verify(request: HostKeyRequest, context: HostKeyContext): Promise<HostKeyVerdict>;
}

export const DEFAULT_HOST_KEY_PROMPT_TIMEOUT_MS = 120_000;

interface OpenPrompt {
  readonly prompt: HostKeyPrompt;
  readonly answer: Promise<HostKeyAnswer>;
  settle(answer: HostKeyAnswer): void;
}

export class HostKeyBroker implements HostKeyVerification {
  readonly #store: KnownHostsStore;
  readonly #timeoutMs: number;
  readonly #open = new Map<string, OpenPrompt>();
  /** Open prompts by what they ask, so hosts asking the same question share one dialog. */
  readonly #byQuestion = new Map<string, OpenPrompt>();
  readonly #listeners = new Set<(event: HostKeyPromptEvent) => void>();

  constructor(options: { readonly store: KnownHostsStore; readonly timeoutMs?: number }) {
    this.#store = options.store;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HOST_KEY_PROMPT_TIMEOUT_MS;
  }

  async verify(request: HostKeyRequest, context: HostKeyContext): Promise<HostKeyVerdict> {
    try {
      return await this.#verify(request, context);
    } catch (error) {
      return { decision: 'reject', error: toErrorData(error) };
    }
  }

  /** Answers an open question. Unknown or closed ids are ignored. */
  answer(promptId: string, answer: HostKeyAnswer): void {
    this.#open.get(promptId)?.settle(answer);
  }

  /** The questions open now, for a window that starts listening. */
  snapshot(): HostKeyPrompt[] {
    return [...this.#open.values()].map((open) => open.prompt);
  }

  /**
   * Listens for questions opening and closing. When the last listener leaves (the window closed
   * or reloaded), every open question is cancelled.
   */
  subscribe(listener: (event: HostKeyPromptEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
      for (const open of [...this.#open.values()]) open.settle('cancel');
    };
  }

  async #verify(request: HostKeyRequest, context: HostKeyContext): Promise<HostKeyVerdict> {
    const { host, port, key } = request;
    const known = await this.#store.lookup(host, port);
    if (known.some((k) => k.fingerprintSha256 === key.fingerprintSha256)) {
      return { decision: 'trust' };
    }
    if (known.length > 0) {
      const answer = await this.#ask({
        kind: 'changed',
        host,
        port,
        key,
        known: known.map((k) => ({
          algorithm: k.algorithm,
          fingerprintSha256: k.fingerprintSha256,
        })),
        ...context,
      });
      if (answer !== 'forget-known') {
        const { hostKeyChangedError } = await import('@querybara/tunnel');
        return { decision: 'reject', error: hostKeyChangedError(host, port, key, known).toJSON() };
      }
      // The user removed the remembered key on purpose: the new one is now simply unknown.
      await this.#store.forget(host, port);
    }
    const answer = await this.#ask({ kind: 'unknown', host, port, key, known: [], ...context });
    switch (answer) {
      case 'trust-remember':
        await this.#store.remember({ host, port, ...key });
        return { decision: 'trust' };
      case 'trust-once':
        return { decision: 'trust' };
      default:
        return { decision: 'reject' };
    }
  }

  #ask(question: Omit<HostKeyPrompt, 'promptId'>): Promise<HostKeyAnswer> {
    const id = [
      question.kind,
      question.host.toLowerCase(),
      question.port,
      question.key.fingerprintSha256,
    ].join(' ');
    const existing = this.#byQuestion.get(id);
    if (existing) return existing.answer;
    if (this.#listeners.size === 0) return Promise.resolve('cancel');

    const prompt: HostKeyPrompt = {
      ...question,
      promptId: newId(),
      profileName: question.profileName.slice(0, 200),
    };
    let resolve: (answer: HostKeyAnswer) => void = () => undefined;
    const answer = new Promise<HostKeyAnswer>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => open.settle('cancel'), this.#timeoutMs);
    timer.unref?.();
    const open: OpenPrompt = {
      prompt,
      answer,
      settle: (given) => {
        if (this.#open.get(prompt.promptId) !== open) return;
        clearTimeout(timer);
        this.#open.delete(prompt.promptId);
        this.#byQuestion.delete(id);
        this.#emit({ type: 'closed', promptId: prompt.promptId });
        // Only the answers that fit the question count; anything else is a cancel.
        const fits =
          given === 'cancel' ||
          (prompt.kind === 'changed' ? given === 'forget-known' : given !== 'forget-known');
        resolve(fits ? given : 'cancel');
      },
    };
    this.#open.set(prompt.promptId, open);
    this.#byQuestion.set(id, open);
    this.#emit({ type: 'open', prompt });
    return answer;
  }

  #emit(event: HostKeyPromptEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }
}

/** The known-hosts file at `path`, shared with querybara-cli; opened on first use. */
export function knownHostsFile(path: string): KnownHostsStore {
  let file: Promise<KnownHostsStore> | undefined;
  const open = (): Promise<KnownHostsStore> =>
    (file ??= import('@querybara/tunnel').then(({ FileKnownHosts }) => new FileKnownHosts(path)));
  return {
    lookup: async (host, port) => (await open()).lookup(host, port),
    remember: async (key) => (await open()).remember(key),
    forget: async (host, port) => (await open()).forget(host, port),
  };
}

/** The broker's questions for one window: the open ones first, then every change. */
export async function* hostKeyPromptEvents(
  broker: HostKeyBroker,
  signal: AbortSignal,
): AsyncGenerator<HostKeyPromptEvent> {
  const queue: HostKeyPromptEvent[] = broker
    .snapshot()
    .map((prompt) => ({ type: 'open', prompt }) as const);
  let wake: (() => void) | undefined;
  const unsubscribe = broker.subscribe((event) => {
    queue.push(event);
    wake?.();
  });
  const onAbort = (): void => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Answers a host's `host-key` request: asks `verification` (a process with none, e.g. in tests,
 * refuses every key) and sends the decision back if `process` is still the one asking.
 */
export async function answerHostKeyRequest<P>(
  process: HostProcess<P>,
  request: HostKeyRequest,
  verification: HostKeyVerification | undefined,
  context: HostKeyContext,
  isCurrent: () => boolean,
): Promise<void> {
  const verdict: HostKeyVerdict = verification
    ? await verification.verify(request, context)
    : {
        decision: 'reject',
        error: new QuerybaraError({
          code: 'SSH_FAILED',
          message: 'SSH host keys cannot be checked here',
        }).toJSON(),
      };
  if (!isCurrent()) return;
  try {
    process.send({
      type: 'host-key-decision',
      requestId: request.requestId,
      decision: verdict.decision,
      ...(verdict.error ? { error: verdict.error } : {}),
    });
  } catch {
    // The process is gone; its exit is handled elsewhere.
  }
}

/**
 * Failures that trying again cannot fix: a changed or refused host key, rejected credentials, a
 * missing secret. The supervisor stops restarting a host that fails with one of these.
 */
const PERMANENT_ENGINE_CODES: ReadonlySet<string | number> = new Set([
  'HOST_KEY_CHANGED',
  'HOST_KEY_REJECTED',
  'AUTH_REJECTED',
  'PASSWORD_REQUIRED',
  'PASSPHRASE_REQUIRED',
  'BAD_PASSPHRASE',
  'PROXY_AUTH_FAILED',
  'FORWARD_PROHIBITED',
]);

export function isPermanentFailure(error: QuerybaraError): boolean {
  if (error.code === 'AUTH_FAILED') return true;
  return error.engineCode !== undefined && PERMANENT_ENGINE_CODES.has(error.engineCode);
}
