import type { MainToHost } from '../shared/host-protocol';

/**
 * A connection host process as main sees it: an Electron utilityProcess in the app, a fake in
 * tests. `P` is the transferable port type (MessagePortMain in the app).
 */
export interface HostProcess<P> {
  /** Sends a control message over the parent port, transferring `ports` with it. */
  send(message: MainToHost, ports?: readonly P[]): void;
  /** Raw messages from the host; the caller validates them. */
  onMessage(listener: (message: unknown) => void): void;
  /** The process exited, crashed or was killed. */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

/** Starts a new host process; `label` names it for the OS and crash reports. */
export type HostProcessFactory<P> = (label: string) => HostProcess<P>;
