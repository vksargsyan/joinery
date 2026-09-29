import type { DriverAdapter, EngineId } from '@joinery/core';

/**
 * Everything the CLI touches in the outside world, injected so commands run the same in the
 * real process and in tests: streams, environment, platform, prompts, signals and adapters.
 */

/** A writable text stream: process.stdout / process.stderr or a test double. */
export interface OutputStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once(event: 'drain' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly isTTY?: boolean;
  /** Terminal width, when the stream is a terminal. */
  readonly columns?: number;
}

/** A readable byte or text stream: process.stdin or a test double. */
export interface InputStream extends AsyncIterable<string | Buffer> {
  readonly isTTY?: boolean;
  setEncoding?(encoding: BufferEncoding): unknown;
}

/** The answer to a confirmation prompt: run it, stop, or run this and every later one. */
export type ConfirmAnswer = 'yes' | 'no' | 'all';

/**
 * Interactive prompts. `interactive` is false when there is no terminal to ask on (stdin or
 * stderr redirected); commands then fail with a message naming the flag or variable to use.
 */
export interface Prompter {
  readonly interactive: boolean;
  /** Reads a secret without echoing it. */
  secret(label: string): Promise<string>;
  /** Reads a line of text (echoed). */
  text(label: string): Promise<string>;
  /** Asks a yes/no question; `allowAll` adds an "all" answer for runs of statements. */
  confirm(question: string, options?: { readonly allowAll?: boolean }): Promise<ConfirmAnswer>;
}

/** Ctrl+C: subscribe to SIGINT; returns the unsubscribe function. */
export interface SignalSource {
  onInterrupt(handler: () => void): () => void;
}

/** Creates the driver adapter for an engine. */
export type AdapterFactory = (engine: EngineId) => DriverAdapter;

export interface CliContext {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly stdin: InputStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly cwd: string;
  readonly prompter: Prompter;
  readonly signals: SignalSource;
  readonly adapters: AdapterFactory;
  /** Clock for timings; tests pin it. */
  readonly now: () => number;
}
