import {
  JoineryError,
  type ActionPreview,
  type ActionResult,
  type EngineId,
  type ServerAction,
} from '@joinery/core';

import { decideServerAction } from '../../../../shared/server-tools-safety';
import { profileById } from '../data';
import { confirm } from '../dialogs';
import type { SessionLane } from '../session-lane';

/**
 * Runs a server tools action the way spec §15 asks: the host previews the exact statements,
 * the confirmation shows them (a warning for kills, drops and table rewrites, and on
 * production), and only then does the host run the action, checking the write rules again.
 * A read-only profile is refused before anything is sent.
 */

/** The statements as the confirmation shows them: SQL ends each with a semicolon. */
export function statementsText(engine: EngineId, statements: readonly string[]): string {
  return engine === 'mongodb' ? statements.join('\n') : statements.map((s) => `${s};`).join('\n');
}

/** The confirmation's message: what the action does, why it asks, and the server's notes. */
export function confirmationMessage(preview: ActionPreview, reason: string | undefined): string {
  return [
    preview.summary,
    ...preview.notices.map((n) => `${n.message}${n.hint ? ` (${n.hint})` : ''}.`),
    reason !== undefined ? `${reason}.` : undefined,
    preview.statements.length === 1 ? 'This runs:' : 'This runs, in order:',
  ]
    .filter((line): line is string => line !== undefined && line !== '')
    .join(' ');
}

export async function runServerAction(options: {
  readonly profileId: string;
  readonly engine: EngineId;
  readonly lane: SessionLane;
  readonly action: ServerAction;
  readonly confirmLabel?: string;
}): Promise<ActionResult | undefined> {
  const profile = await profileById(options.profileId);
  if (!profile) {
    throw new JoineryError({ code: 'NOT_FOUND', message: 'The connection was deleted' });
  }
  const decision = decideServerAction(profile, options.action);
  if (decision.action === 'refuse') {
    throw new JoineryError({ code: 'READ_ONLY', message: decision.reason });
  }
  const preview = await options.lane.run((host, sessionId) =>
    host.serverTools.preview({ sessionId, action: options.action }),
  );
  const production = profile.presentation.environment === 'production';
  const ok = await confirm({
    title: preview.title,
    message: confirmationMessage(
      preview,
      decision.action === 'confirm' && production ? decision.reason : undefined,
    ),
    detail: statementsText(options.engine, preview.statements),
    confirmLabel: options.confirmLabel ?? 'Run',
    danger: (decision.action === 'confirm' && decision.destructive) || production,
  });
  if (!ok) return undefined;
  return options.lane.run((host, sessionId) =>
    host.serverTools.run({ sessionId, action: options.action, confirmed: true }),
  );
}
