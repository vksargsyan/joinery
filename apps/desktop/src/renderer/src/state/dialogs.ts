import type { CellValue } from '@joinery/core';
import type { SecretStatus } from '@joinery/ipc';
import type { ConfirmationReason } from '@joinery/sql-tools';
import { create } from 'zustand';

import type { ParameterPrompt } from './run-plan';

/**
 * Modal prompts that code outside React awaits: the safety confirmation, parameter values,
 * secrets for "ask every time", and plain confirmations. One is shown at a time; later ones
 * queue behind it.
 */

export interface RiskyStatement {
  readonly index: number;
  readonly line: number;
  readonly text: string;
  readonly reasons: readonly ConfirmationReason[];
}

export type Prompt =
  | {
      readonly kind: 'confirm-run';
      readonly production: boolean;
      readonly statements: readonly RiskyStatement[];
      readonly resolve: (ok: boolean) => void;
    }
  | {
      readonly kind: 'parameters';
      readonly prompts: readonly ParameterPrompt[];
      readonly resolve: (values: Map<string, CellValue> | null) => void;
    }
  | {
      readonly kind: 'secrets';
      readonly profileName: string;
      readonly missing: SecretStatus['missing'];
      readonly resolve: (values: Record<string, string> | null) => void;
    }
  | {
      readonly kind: 'confirm';
      readonly title: string;
      readonly message: string;
      /** Shown in a monospace block under the message: the exact command or statement. */
      readonly detail?: string;
      readonly confirmLabel: string;
      readonly danger: boolean;
      readonly resolve: (ok: boolean) => void;
    };

type Pending = Prompt extends infer P ? (P extends Prompt ? Omit<P, 'resolve'> : never) : never;

interface DialogState {
  readonly queue: readonly Prompt[];
  /** Closes the current prompt (its resolve was already called). */
  readonly dismiss: (prompt: Prompt) => void;
}

export const useDialogs = create<DialogState>()((set) => ({
  queue: [],
  dismiss: (prompt) => set((state) => ({ queue: state.queue.filter((p) => p !== prompt) })),
}));

/** Queues a prompt; resolves with the answer its dialog gives. */
function ask<T>(pending: Pending): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const prompt = {
      ...pending,
      resolve: (value: T) => {
        if (settled) return;
        settled = true;
        useDialogs.getState().dismiss(prompt);
        resolve(value);
      },
    } as Prompt;
    useDialogs.setState((state) => ({ queue: [...state.queue, prompt] }));
  });
}

export function confirmRun(
  statements: readonly RiskyStatement[],
  production: boolean,
): Promise<boolean> {
  return ask<boolean>({ kind: 'confirm-run', statements, production });
}

export function askParameters(
  prompts: readonly ParameterPrompt[],
): Promise<Map<string, CellValue> | null> {
  return ask<Map<string, CellValue> | null>({ kind: 'parameters', prompts });
}

export function askSecrets(
  profileName: string,
  missing: SecretStatus['missing'],
): Promise<Record<string, string> | null> {
  return ask<Record<string, string> | null>({ kind: 'secrets', profileName, missing });
}

export function confirm(options: {
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
  readonly confirmLabel?: string;
  readonly danger?: boolean;
}): Promise<boolean> {
  return ask<boolean>({
    kind: 'confirm',
    title: options.title,
    message: options.message,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    confirmLabel: options.confirmLabel ?? 'OK',
    danger: options.danger ?? false,
  });
}
