import { connectionProfileSchema, errorDataSchema, type ResolvedProfile } from '@joinery/core';
import { connectionCheckResultSchema, hostKeyInfoSchema, serverInfoSchema } from '@joinery/ipc';
import { z } from 'zod';

/**
 * Control messages between main and a connection host over the utility process's parent port
 * (spec §3). Both ends validate with these schemas. The renderer's RPC traffic never uses this
 * channel: it runs on MessagePorts that main transfers with an `attach` message.
 *
 * `connect` and `check` carry a ResolvedProfile, i.e. unsealed secrets. They go main → host
 * only; nothing on this channel travels back towards the renderer.
 *
 * SSH host keys are verified in main, which owns the known-hosts file and the window: a host
 * opening a tunnel sends `host-key` and waits for main's `host-key-decision` (spec §4).
 */

export const resolvedProfileSchema: z.ZodType<ResolvedProfile> = z.object({
  profile: connectionProfileSchema,
  secrets: z.record(z.string(), z.string()),
  endpointOverride: z
    .object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) })
    .optional(),
});

export const mainToHostSchema = z.discriminatedUnion('type', [
  /** Serve mode: connect with this profile, then answer `ready` or `failed`. */
  z.object({ type: z.literal('connect'), resolved: resolvedProfileSchema }),
  /** Serve connectionHostContract on the MessagePort transferred with this message. */
  z.object({ type: z.literal('attach') }),
  /** Test Connection mode: run the stepwise check, report each step, then `check-done`. */
  z.object({ type: z.literal('check'), resolved: resolvedProfileSchema }),
  /** Close every session and exit. */
  z.object({ type: z.literal('shutdown') }),
  /**
   * Main's answer to a `host-key` request: trust the key, or refuse it (with `error` when main
   * has a more precise reason, such as a changed host key).
   */
  z.object({
    type: z.literal('host-key-decision'),
    requestId: z.string().min(1).max(128),
    decision: z.enum(['trust', 'reject']),
    error: errorDataSchema.optional(),
  }),
]);
export type MainToHost = z.infer<typeof mainToHostSchema>;

export const hostToMainSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), info: serverInfoSchema }),
  /**
   * Before `ready`: the connect failed. After `ready`: the connection broke (its SSH tunnel
   * dropped), so main restarts the host, which reopens the tunnel.
   */
  z.object({ type: z.literal('failed'), error: errorDataSchema }),
  z.object({ type: z.literal('check-step'), result: connectionCheckResultSchema }),
  z.object({ type: z.literal('check-done') }),
  /** An SSH server presented this host key: may the tunnel trust it? */
  z.object({
    type: z.literal('host-key'),
    requestId: z.string().min(1).max(128),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    key: hostKeyInfoSchema,
  }),
]);
export type HostToMain = z.infer<typeof hostToMainSchema>;
