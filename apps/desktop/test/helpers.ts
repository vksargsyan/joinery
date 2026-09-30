import { capabilitiesFor, type ConnectionProfileInput } from '@joinery/core';
import type { ServerInfo } from '@joinery/ipc';

import type { HostProcess, HostProcessFactory } from '../src/main/host-process';
import type { MainToHost } from '../src/shared/host-protocol';

export const SERVER_INFO: ServerInfo = {
  engine: 'postgres',
  serverVersion: '16.4',
  capabilities: capabilitiesFor('postgres', '16.4'),
};

/** A connection host process that records what main sends and lets the test answer. */
export class FakeHostProcess implements HostProcess<string> {
  readonly sent: { readonly message: MainToHost; readonly ports: readonly string[] }[] = [];
  killed = false;
  readonly #messageListeners: ((message: unknown) => void)[] = [];
  readonly #exitListeners: ((code: number | null) => void)[] = [];

  constructor(
    readonly label: string,
    private readonly onSend?: (process: FakeHostProcess, message: MainToHost) => void,
  ) {}

  send(message: MainToHost, ports: readonly string[] = []): void {
    this.sent.push({ message, ports: [...ports] });
    this.onSend?.(this, message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListeners.push(listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.#exitListeners.push(listener);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.exit(null);
  }

  /** The host posts a message to main. */
  emit(message: unknown): void {
    for (const listener of this.#messageListeners) listener(message);
  }

  /** The process exits (crash when not killed). */
  exit(code: number | null): void {
    for (const listener of this.#exitListeners.splice(0)) listener(code);
  }

  messagesOfType<T extends MainToHost['type']>(type: T): Extract<MainToHost, { type: T }>[] {
    return this.sent
      .map((entry) => entry.message)
      .filter((message): message is Extract<MainToHost, { type: T }> => message.type === type);
  }
}

export function fakeHosts(onSend?: (process: FakeHostProcess, message: MainToHost) => void): {
  readonly spawn: HostProcessFactory<string>;
  readonly processes: FakeHostProcess[];
} {
  const processes: FakeHostProcess[] = [];
  return {
    processes,
    spawn: (label) => {
      const process = new FakeHostProcess(label, onSend);
      processes.push(process);
      return process;
    },
  };
}

/** A profile input as the renderer would build it. */
export function profileInput(
  overrides: Partial<ConnectionProfileInput> = {},
): ConnectionProfileInput {
  const now = '2026-09-29T10:00:00.000Z';
  return {
    id: crypto.randomUUID(),
    name: 'Local Postgres',
    engine: 'postgres',
    endpoint: { kind: 'host', host: 'localhost', port: 5432 },
    auth: {
      method: 'password',
      user: 'app',
      password: { id: crypto.randomUUID(), policy: 'save' },
    },
    tls: { mode: 'disable' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
