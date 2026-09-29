import { connectionProfileSchema, errorDataSchema, type ResolvedProfile } from '@joinery/core';
import { connectionCheckResultSchema, serverInfoSchema } from '@joinery/ipc';
import { z } from 'zod';

/**
 * Control messages between main and a connection host over the utility process's parent port
 * (spec §3). Both ends validate with these schemas. The renderer's RPC traffic never uses this
 * channel: it runs on MessagePorts that main transfers with an `attach` message.
 *
 * `connect` and `check` carry a ResolvedProfile, i.e. unsealed secrets. They go main → host
 * only; nothing on this channel travels back towards the renderer.
 */

const resolvedProfileSchema: z.ZodType<ResolvedProfile> = z.object({
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
]);
export type MainToHost = z.infer<typeof mainToHostSchema>;

export const hostToMainSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), info: serverInfoSchema }),
  z.object({ type: z.literal('failed'), error: errorDataSchema }),
  z.object({ type: z.literal('check-step'), result: connectionCheckResultSchema }),
  z.object({ type: z.literal('check-done') }),
]);
export type HostToMain = z.infer<typeof hostToMainSchema>;
