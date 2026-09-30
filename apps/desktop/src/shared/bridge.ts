/**
 * The preload bridge (spec §3, §18): the only API the page gets from outside the sandbox. It is
 * deliberately tiny. Everything else goes over typed, zod-validated RPC on MessagePorts that main
 * hands to the page through the message below (ADR 0004).
 */

/** IPC channel on which the page asks main for a fresh main-contract port. */
export const HELLO_CHANNEL = 'joinery:hello';
/** IPC channel on which main sends MessagePorts to the preload, which forwards them. */
export const PORT_CHANNEL = 'joinery:port';

/** `window.joinery`, exposed with contextBridge. */
export interface JoineryBridge {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  /**
   * Asks main for a MessagePort serving the main contract. It arrives as a window `message`
   * event carrying a `PortMessage` of kind `main`; register the listener first.
   */
  requestMainPort(): void;
}

/**
 * What the preload posts to the page, with the port in `event.ports[0]`. The page accepts it
 * only from its own window and origin, and only in this exact shape.
 */
export type PortMessage =
  | { readonly joinery: 'port'; readonly kind: 'main' }
  | { readonly joinery: 'port'; readonly kind: 'connection'; readonly connectionId: string };

/** Payload main sends on PORT_CHANNEL; the preload adds the `joinery: 'port'` tag. */
export type PortPayload =
  { readonly kind: 'main' } | { readonly kind: 'connection'; readonly connectionId: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** Checks a payload from main (preload side). */
export function isPortPayload(value: unknown): value is PortPayload {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'main') return Object.keys(value).length === 1;
  return (
    value['kind'] === 'connection' &&
    typeof value['connectionId'] === 'string' &&
    value['connectionId'].length > 0 &&
    value['connectionId'].length <= 128 &&
    Object.keys(value).length === 2
  );
}

/** Checks a window message (page side). */
export function isPortMessage(value: unknown): value is PortMessage {
  if (!isRecord(value) || value['joinery'] !== 'port') return false;
  const { joinery: _tag, ...payload } = value;
  return isPortPayload(payload);
}

/** Wraps a payload from main into the message the page accepts. */
export function toPortMessage(payload: PortPayload): PortMessage {
  return payload.kind === 'main'
    ? { joinery: 'port', kind: 'main' }
    : { joinery: 'port', kind: 'connection', connectionId: payload.connectionId };
}
