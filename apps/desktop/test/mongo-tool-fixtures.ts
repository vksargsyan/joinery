import { connectionProfileSchema, type ConnectionProfileInput } from '@joinery/core';
import type { StoredProfile } from '@joinery/ipc';

import type { HostClient } from '../src/renderer/src/lib/main-client';
import { useConnections } from '../src/renderer/src/state/connections';
import { keys, queryClient } from '../src/renderer/src/state/data';
import { useDialogs, type Prompt } from '../src/renderer/src/state/dialogs';
import { profileInput } from './helpers';

/**
 * Shared pieces for the MongoDB tool panel tests: a connected profile whose host is a fake that
 * records the calls, and answers to the confirmations the panels ask.
 */

export const PROFILE_ID = 'mongo-tools-profile';

export interface Call {
  readonly method: string;
  readonly input: Record<string, unknown>;
}

export function storedProfile(
  presentation: ConnectionProfileInput['presentation'] = {},
): StoredProfile {
  return {
    ...connectionProfileSchema.parse(
      profileInput({
        id: PROFILE_ID,
        name: 'Shop',
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        presentation,
      }),
    ),
    version: 1,
  };
}

/** Makes `host` the live connection of the test profile. */
export function connectHost(
  host: object,
  presentation: ConnectionProfileInput['presentation'] = {},
): void {
  queryClient.setQueryData(keys.profiles, [storedProfile(presentation)]);
  useConnections.setState({
    byProfile: {
      [PROFILE_ID]: {
        profileId: PROFILE_ID,
        status: 'ready',
        host: host as HostClient,
        generation: 1,
        connectionId: 'c1',
      },
    },
  });
}

export function disconnectAll(): void {
  useConnections.setState({ byProfile: {} });
  queryClient.clear();
}

/** Records calls by method. */
export function recorder() {
  const calls: Call[] = [];
  return {
    calls,
    record(method: string, input: object): void {
      calls.push({ method, input: input as Record<string, unknown> });
    },
    of(method: string): Call[] {
      return calls.filter((call) => call.method === method);
    },
  };
}

/** An async stream of items, as an RPC stream call returns. */
export async function* streamOf<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** Answers every confirmation with `answer`, recording what was asked. */
export function answerConfirms() {
  const asked: { title: string; message: string; detail?: string }[] = [];
  let answer = true;
  const unsubscribe = useDialogs.subscribe((state) => {
    const prompt: Prompt | undefined = state.queue[0];
    if (prompt?.kind !== 'confirm') return;
    asked.push({
      title: prompt.title,
      message: prompt.message,
      ...(prompt.detail !== undefined ? { detail: prompt.detail } : {}),
    });
    prompt.resolve(answer);
  });
  return {
    asked,
    answer(value: boolean): void {
      answer = value;
    },
    stop: unsubscribe,
  };
}
