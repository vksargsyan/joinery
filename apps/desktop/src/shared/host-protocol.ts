import { connectionProfileSchema, errorDataSchema, type ResolvedProfile } from '@querybara/core';
import {
  connectionCheckResultSchema,
  hostKeyInfoSchema,
  mongoGridFsBucketSchema,
  mongoGridFsTransferProgressSchema,
  serverInfoSchema,
} from '@querybara/ipc';
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

/**
 * Work main hands a connection host outside the renderer's RPC: files that move by path, which
 * main checked against the window's file grants (spec §9, GridFS). The host runs it on its
 * metadata session and answers with `response`.
 */
export const hostRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gridfs-upload'),
    bucket: mongoGridFsBucketSchema,
    path: z.string().min(1).max(4096),
    filename: z.string().min(1).max(1024),
    contentType: z.string().min(1).max(255).optional(),
    metadata: z.string().min(1).optional(),
    chunkSizeBytes: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('gridfs-download'),
    bucket: mongoGridFsBucketSchema,
    id: z.string().min(1),
    path: z.string().min(1).max(4096),
  }),
]);
export type HostRequest = z.infer<typeof hostRequestSchema>;

const requestIdSchema = z.string().min(1).max(128);

export const mainToHostSchema = z.discriminatedUnion('type', [
  /** Serve mode: connect with this profile, then answer `ready` or `failed`. */
  z.object({ type: z.literal('connect'), resolved: resolvedProfileSchema }),
  /** Serve connectionHostContract on the MessagePort transferred with this message. */
  z.object({ type: z.literal('attach') }),
  /** Test Connection mode: run the stepwise check, report each step, then `check-done`. */
  z.object({ type: z.literal('check'), resolved: resolvedProfileSchema }),
  /** Close every session and exit. */
  z.object({ type: z.literal('shutdown') }),
  /** Run a HostRequest; the answer is `response`, with `request-progress` on the way. */
  z.object({ type: z.literal('request'), requestId: requestIdSchema, request: hostRequestSchema }),
  /** Stop a running request (its answer is then a CANCELLED error). */
  z.object({ type: z.literal('cancel-request'), requestId: requestIdSchema }),
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
  /** How far a request got, in bytes. */
  z.object({
    type: z.literal('request-progress'),
    requestId: requestIdSchema,
    progress: mongoGridFsTransferProgressSchema,
  }),
  /** The answer to a `request`: `result` (checked by main against the method's schema) or `error`. */
  z.object({
    type: z.literal('response'),
    requestId: requestIdSchema,
    result: z.unknown().optional(),
    error: errorDataSchema.optional(),
  }),
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
