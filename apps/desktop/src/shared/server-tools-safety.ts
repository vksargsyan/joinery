import {
  CHECK_OPERATIONS,
  QuerybaraError,
  requiresWriteConfirmation,
  type ConnectionProfile,
  type ServerAction,
} from '@querybara/core';

/**
 * The write rules of the server tools (spec §4, §15), shared by the connection host (which
 * enforces them whatever the page sends) and the page (which asks before it sends): a
 * read-only profile refuses every change; kills, maintenance, settings, drops and revokes are
 * confirmed on every profile, after showing the exact statement; every change is confirmed on
 * production profiles and profiles that confirm writes.
 */

export interface ServerActionRule {
  /** Changes the server: refused on a read-only profile. */
  readonly write: boolean;
  /** Confirmed on every profile, with the statement shown. */
  readonly alwaysConfirm: boolean;
  /** Loses data or disrupts other clients: the confirmation is a warning. */
  readonly destructive: boolean;
  /** What the action does, as the subject of a sentence: "Terminating session 4211". */
  readonly what: string;
}

const HEAVY = new Set(['cluster', 'optimize', 'repair', 'compact']);

export function serverActionRule(action: ServerAction): ServerActionRule {
  switch (action.kind) {
    case 'session':
      return {
        write: true,
        alwaysConfirm: true,
        destructive: true,
        what: `${action.operation === 'cancel' ? 'Cancelling the query of' : 'Terminating'} session ${action.id}`,
      };
    case 'maintenance': {
      const check = CHECK_OPERATIONS.includes(action.operation);
      const heavy =
        HEAVY.has(action.operation) ||
        (action.operation === 'vacuum' && action.options.includes('full')) ||
        (action.operation === 'reindex' && !action.options.includes('concurrently'));
      return {
        write: !check,
        alwaysConfirm: true,
        destructive: heavy,
        what: `Running ${action.operation.toUpperCase()}`,
      };
    }
    case 'setting':
      return {
        // SET on the tools' own session changes nothing for anyone else.
        write: action.scope !== 'session',
        alwaysConfirm: true,
        destructive: false,
        what: `Changing ${action.name}`,
      };
    case 'topQueries':
      return action.operation === 'reset'
        ? { write: true, alwaysConfirm: true, destructive: true, what: 'Resetting the statistics' }
        : {
            write: true,
            alwaysConfirm: false,
            destructive: false,
            what: 'Turning on statement statistics',
          };
    case 'profiler':
      return {
        write: true,
        alwaysConfirm: true,
        destructive: false,
        what: `Changing the profiler of ${action.database}`,
      };
    case 'createAccount':
      return {
        write: true,
        alwaysConfirm: false,
        destructive: false,
        what: `Creating ${action.account.name}`,
      };
    case 'alterAccount':
      return {
        write: true,
        alwaysConfirm: false,
        destructive: false,
        what: `Changing ${action.account.name}`,
      };
    case 'grant':
    case 'grantRole':
      return { write: true, alwaysConfirm: false, destructive: false, what: 'Granting privileges' };
    case 'createPolicy':
      return {
        write: true,
        alwaysConfirm: false,
        destructive: false,
        what: `Creating policy ${action.name}`,
      };
    case 'defaultPrivileges':
      return action.operation === 'grant'
        ? {
            write: true,
            alwaysConfirm: false,
            destructive: false,
            what: 'Changing default privileges',
          }
        : {
            write: true,
            alwaysConfirm: true,
            destructive: true,
            what: 'Revoking default privileges',
          };
    case 'dropAccount':
      return {
        write: true,
        alwaysConfirm: true,
        destructive: true,
        what: `Dropping ${action.account.name}`,
      };
    case 'revoke':
    case 'revokeRole':
      return { write: true, alwaysConfirm: true, destructive: true, what: 'Revoking privileges' };
    case 'dropPolicy':
      return {
        write: true,
        alwaysConfirm: true,
        destructive: true,
        what: `Dropping policy ${action.name}`,
      };
    case 'rowSecurity':
      return {
        write: true,
        alwaysConfirm: true,
        destructive: true,
        what: `${action.enabled ? 'Enabling' : 'Disabling'} row-level security on ${action.table}`,
      };
  }
}

export type ServerActionDecision =
  | { readonly action: 'run' }
  | { readonly action: 'confirm'; readonly destructive: boolean; readonly reason: string }
  | { readonly action: 'refuse'; readonly reason: string };

/** What to do before running an action under a profile's rules. */
export function decideServerAction(
  profile: ConnectionProfile,
  action: ServerAction,
): ServerActionDecision {
  const rule = serverActionRule(action);
  if (rule.write && profile.presentation.readOnly) {
    return {
      action: 'refuse',
      reason: `"${profile.name}" is read-only: ${lowerFirst(rule.what)} was refused`,
    };
  }
  if (rule.alwaysConfirm || rule.destructive) {
    return {
      action: 'confirm',
      destructive: rule.destructive,
      reason:
        profile.presentation.environment === 'production'
          ? `${rule.what} on a production connection`
          : rule.what,
    };
  }
  if (rule.write && requiresWriteConfirmation(profile)) {
    return {
      action: 'confirm',
      destructive: false,
      reason:
        profile.presentation.environment === 'production'
          ? `${rule.what} on a production connection`
          : `"${profile.name}" confirms every change`,
    };
  }
  return { action: 'run' };
}

/** Throws READ_ONLY or CONFIRMATION_REQUIRED when the rules do not let the action run. */
export function checkServerAction(
  profile: ConnectionProfile,
  action: ServerAction,
  confirmed: boolean | undefined,
): void {
  const decision = decideServerAction(profile, action);
  if (decision.action === 'refuse') {
    throw new QuerybaraError({ code: 'READ_ONLY', message: decision.reason });
  }
  if (decision.action === 'confirm' && confirmed !== true) {
    throw new QuerybaraError({
      code: 'CONFIRMATION_REQUIRED',
      message: `${serverActionRule(action).what} needs confirmation`,
      hint: 'Preview the action and confirm it',
    });
  }
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
