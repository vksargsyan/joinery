import { z } from 'zod';

/**
 * Wire messages. Every message carries `$rpc: 1` (the protocol version), so other traffic on the
 * same port is ignored. The client sends `call`, `cancel` and `credit`; the server answers with
 * `result`, `error`, `progress`, `item` and `end`. Call ids are chosen by the client; since the
 * message type tells which way a message flows, each end of a port can run one client and one
 * server at once without their ids colliding.
 *
 * Payloads (`i`, `v`) are `unknown` here: they are validated against the contract separately.
 */

export const PROTOCOL_VERSION = 1;

/** Upper bound on a stream's credit: how far a producer may run ahead of its consumer. */
export const MAX_STREAM_WINDOW = 64;

const callId = z.number().int().nonnegative();
const version = z.literal(PROTOCOL_VERSION);

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    $rpc: version,
    t: z.literal('call'),
    id: callId,
    /** Method path, e.g. "profiles.list". */
    m: z.string().min(1).max(256),
    /** How the client calls it, unary or stream; must match the server's contract. */
    k: z.enum(['unary', 'stream']),
    i: z.unknown(),
    /** Initial stream credit (items the server may send before it hears back). */
    w: z.number().int().min(1).max(MAX_STREAM_WINDOW).optional(),
  }),
  z.object({ $rpc: version, t: z.literal('cancel'), id: callId }),
  z.object({
    $rpc: version,
    t: z.literal('credit'),
    id: callId,
    n: z.number().int().min(1).max(MAX_STREAM_WINDOW),
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({ $rpc: version, t: z.literal('result'), id: callId, v: z.unknown() }),
  /** `e` is validated as ErrorData by the client. */
  z.object({ $rpc: version, t: z.literal('error'), id: callId, e: z.unknown() }),
  z.object({ $rpc: version, t: z.literal('progress'), id: callId, v: z.unknown() }),
  z.object({ $rpc: version, t: z.literal('item'), id: callId, v: z.unknown() }),
  z.object({ $rpc: version, t: z.literal('end'), id: callId }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** True for anything that claims to be an RPC message; the rest is someone else's traffic. */
export function isRpcMessage(data: unknown): data is { readonly $rpc: unknown } {
  return typeof data === 'object' && data !== null && '$rpc' in data;
}

const SERVER_MESSAGE_TYPES: ReadonlySet<unknown> = new Set([
  'result',
  'error',
  'progress',
  'item',
  'end',
]);

/** True for a server-to-client message: on a shared port, the local client's traffic. */
export function isServerMessageType(data: { readonly $rpc: unknown }): boolean {
  return 't' in data && SERVER_MESSAGE_TYPES.has(data.t);
}

/** The call id of a malformed message, if usable, so the server can still answer it. */
export function callIdOf(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || !('id' in data)) return undefined;
  const parsed = callId.safeParse(data.id);
  return parsed.success ? parsed.data : undefined;
}
