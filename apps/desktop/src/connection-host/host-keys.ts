import { QuerybaraError, fromErrorData, newId } from '@querybara/core';
import type { HostKeyDecision, HostKeyVerifier } from '@querybara/tunnel';

import type { HostToMain, MainToHost } from '../shared/host-protocol';

type DecisionMessage = Extract<MainToHost, { type: 'host-key-decision' }>;

interface Pending {
  resolve(decision: HostKeyDecision): void;
  reject(error: QuerybaraError): void;
}

/**
 * The connection host's side of SSH host key verification (spec §4). The host has no window and
 * does not touch the known-hosts file: its TransportManager's verifier asks main with a
 * `host-key` message and waits for the `host-key-decision`. Main checks the remembered keys and
 * asks the user about a new or changed one; how long that may take is main's call.
 */
export class HostKeyBridge {
  readonly #post: (message: HostToMain) => void;
  readonly #pending = new Map<string, Pending>();

  constructor(post: (message: HostToMain) => void) {
    this.#post = post;
  }

  /** The HostKeyVerifier for the process's TransportManager. */
  readonly verifier: HostKeyVerifier = (host, port, key) =>
    new Promise<HostKeyDecision>((resolve, reject) => {
      const requestId = newId();
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#post({
          type: 'host-key',
          requestId,
          host,
          port,
          key: { algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 },
        });
      } catch (error) {
        this.#pending.delete(requestId);
        reject(
          new QuerybaraError(
            { code: 'SSH_FAILED', message: 'The host key could not be checked' },
            { cause: error },
          ),
        );
      }
    });

  /** Settles the request main answered. Unknown or already settled ids are ignored. */
  settle(message: DecisionMessage): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    if (message.error) pending.reject(fromErrorData(message.error));
    else pending.resolve(message.decision);
  }

  /** Requests still waiting for main. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}
