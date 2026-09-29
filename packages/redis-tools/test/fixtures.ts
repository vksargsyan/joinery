import { readFileSync } from 'node:fs';

import { decodeResp, type RedisReply } from '../src';

/** A recorded reply (raw RESP captured from a real server) from test/fixtures. */
export function recorded(name: string): RedisReply {
  return decodeResp(new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));
}

/** The text of a recorded bulk-string reply (INFO, CLIENT LIST, CLUSTER NODES). */
export function recordedText(name: string): string {
  const reply = recorded(name);
  if (reply.type !== 'bulk' && reply.type !== 'verbatim') throw new Error(`${name} is not text`);
  return new TextDecoder().decode(reply.value);
}

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
