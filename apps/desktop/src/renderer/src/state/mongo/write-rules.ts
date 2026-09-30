import { requiresWriteConfirmation } from '@joinery/core';

import { profileById } from '../data';
import { confirm } from '../dialogs';

/**
 * The write rules (spec §4) as the MongoDB tool panels apply them, the same way the collection
 * view does: a read-only profile changes nothing, a production (or confirm-writes) profile asks
 * before every write, and destructive or administrative changes always show their command and
 * ask. The connection host checks the same rules again whatever the page sends.
 */

export interface WriteRules {
  readonly readOnlyProfile: boolean;
  readonly production: boolean;
  /** Every write asks first (production, or the profile says so). */
  readonly confirmWrites: boolean;
}

export const DEFAULT_WRITE_RULES: WriteRules = {
  readOnlyProfile: false,
  production: false,
  confirmWrites: false,
};

/** The profile's rules; the defaults when the profile is not known (yet). */
export async function loadWriteRules(profileId: string): Promise<WriteRules> {
  const profile = await profileById(profileId);
  if (!profile) return DEFAULT_WRITE_RULES;
  return {
    readOnlyProfile: profile.presentation.readOnly,
    production: profile.presentation.environment === 'production',
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

export interface WriteConfirmation {
  readonly title: string;
  /** The exact mongosh command that runs. */
  readonly command: string;
  /** Always ask (drops, deletes, admin changes); otherwise only on confirm-writes profiles. */
  readonly always?: boolean;
  readonly destructive?: boolean;
  readonly confirmLabel?: string;
  /** What the change does, shown above the command. */
  readonly message?: string;
}

/** Asks before a write when the rules (or the kind of change) say so; true when it may run. */
export async function confirmMongoWrite(
  rules: WriteRules,
  request: WriteConfirmation,
): Promise<boolean> {
  const ask = request.always === true || request.destructive === true || rules.confirmWrites;
  if (!ask) return true;
  const production = rules.production ? ' This connection is marked production.' : '';
  const message =
    request.message ??
    (request.destructive === true
      ? 'This cannot be undone. This runs:'
      : rules.confirmWrites && request.always !== true
        ? rules.production
          ? 'This connection is marked production, so every write asks first. This runs:'
          : 'This connection asks before every write. This runs:'
        : 'This runs:');
  return confirm({
    title: request.title,
    message: request.message !== undefined ? `${message}${production}` : message,
    detail: request.command,
    confirmLabel: request.confirmLabel ?? 'Run it',
    danger: request.destructive === true || rules.production,
  });
}

/** The notice a write gets on a read-only profile (or on a view). */
export const READ_ONLY_TEXT = 'This connection is read-only.';
