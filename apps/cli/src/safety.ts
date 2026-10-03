import type { ConfirmationReason, SafetyDecision } from '@querybara/sql-tools';

import type { Prompter } from './context';
import { CliError } from './errors';
import type { Reporter } from './reporter';
import type { Target } from './target';

/**
 * The safety check before running (spec §6), as the CLI applies it: risky statements (UPDATE or
 * DELETE without WHERE, DROP, TRUNCATE) and, on production profiles, every write need `--yes`
 * or an interactive confirmation; read-only profiles refuse writes outright.
 */

const REASONS: Readonly<Record<ConfirmationReason, string>> = {
  'update-without-where': 'UPDATE without WHERE changes every row',
  'delete-without-where': 'DELETE without WHERE removes every row',
  drop: 'it drops an object and its data',
  truncate: 'TRUNCATE removes every row',
  'explain-analyze': 'EXPLAIN ANALYZE executes the statement',
  alter: 'it alters the schema',
  'unknown-effects': 'the routine may write anything',
  locks: 'it takes locks',
  'server-config': 'it changes server-wide settings',
  write: 'it writes',
};

/** Human text for confirmation reasons; `write` names the profile rule behind it. */
export function describeReasons(reasons: readonly ConfirmationReason[], target: Target): string {
  return reasons
    .map((reason) =>
      reason === 'write'
        ? target.profile.presentation.environment === 'production'
          ? `it writes to the production connection "${target.label}"`
          : `"${target.label}" asks before every write`
        : REASONS[reason],
    )
    .join('; ');
}

/** Remembers "yes to all" across the statements of one run. */
export interface ConfirmState {
  yesToAll: boolean;
}

export interface ConfirmDeps {
  /** --yes */
  readonly yes: boolean;
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly state: ConfirmState;
}

/**
 * Applies a safety decision for one statement: returns when it may run, throws READ_ONLY when
 * refused and CONFIRMATION_REQUIRED when it needs a confirmation nobody gave. With a terminal
 * the user is asked (yes / no / all); without one, `--yes` is the only way through.
 */
export async function confirmStatement(
  decision: SafetyDecision,
  statement: { readonly index: number; readonly text: string },
  target: Target,
  deps: ConfirmDeps,
): Promise<void> {
  if (decision.action === 'run') return;
  if (decision.action === 'refuse') {
    throw new CliError(`Statement ${statement.index} writes, but "${target.label}" is read-only`, {
      code: 'READ_ONLY',
      hint:
        target.readOnlySource === 'flag'
          ? 'Writes are refused because --read-only was given'
          : 'The profile is locked read-only; unlock it in the app or use another profile to write',
    });
  }
  if (deps.yes || deps.state.yesToAll) return;
  const why = describeReasons(decision.reasons, target);
  if (!deps.prompter.interactive) {
    throw new CliError(`Statement ${statement.index} needs confirmation: ${why}`, {
      code: 'CONFIRMATION_REQUIRED',
      hint: 'Pass --yes to run it without asking, or run in a terminal to confirm it',
    });
  }
  deps.reporter.print(`Statement ${statement.index} needs confirmation: ${why}`);
  deps.reporter.print(excerpt(statement.text));
  const answer = await deps.prompter.confirm('Run it?', { allowAll: true });
  if (answer === 'all') deps.state.yesToAll = true;
  if (answer === 'no') {
    throw new CliError(`Statement ${statement.index} was not confirmed`, {
      code: 'CONFIRMATION_REQUIRED',
    });
  }
}

/**
 * Asks once before a whole operation (applying a sync script). Returns when confirmed, throws
 * CONFIRMATION_REQUIRED otherwise. `requireFlag` insists on --yes even with a terminal.
 */
export async function confirmOperation(
  question: string,
  deps: Omit<ConfirmDeps, 'state'> & { readonly requireFlag?: boolean; readonly hint?: string },
): Promise<void> {
  if (deps.yes) return;
  if (deps.requireFlag || !deps.prompter.interactive) {
    throw new CliError(question.replace(/\?$/, ' needs confirmation'), {
      code: 'CONFIRMATION_REQUIRED',
      hint: deps.hint ?? 'Pass --yes to confirm',
    });
  }
  if ((await deps.prompter.confirm(question)) !== 'yes') {
    throw new CliError('Not confirmed; nothing was changed', { code: 'CONFIRMATION_REQUIRED' });
  }
}

/** The statement, indented and cut to a few lines, for confirmation prompts. */
export function excerpt(text: string, maxLines = 6, width = 120): string {
  const lines = text.split(/\r?\n/);
  const shown = lines
    .slice(0, maxLines)
    .map((line) => `    ${line.length > width ? `${line.slice(0, width - 1)}…` : line}`);
  if (lines.length > maxLines) shown.push(`    … (${lines.length - maxLines} more lines)`);
  return shown.join('\n');
}
