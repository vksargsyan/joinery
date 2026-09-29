import { JoineryError, requiresWriteConfirmation, type ConnectionProfile } from '@joinery/core';
import { classifyRequest, type RequestSafety, type SearchRequest } from '@joinery/search-tools';

/**
 * The write rules for Elasticsearch and OpenSearch (spec §4, §11), shared by the connection host
 * (which enforces them whatever the page sends) and the page (which asks before it sends): a
 * read-only profile refuses every write; destructive requests (index and document deletes,
 * close, delete by query, force merge, bulk deletes) ask on every profile; every write asks on
 * production profiles and profiles that confirm writes.
 */

export interface SearchWritePolicy {
  readonly readOnly: boolean;
  /** Production, or "confirm every write". */
  readonly confirmWrites: boolean;
  readonly production: boolean;
  readonly profileName: string;
}

export function searchWritePolicy(profile: ConnectionProfile): SearchWritePolicy {
  return {
    readOnly: profile.presentation.readOnly,
    confirmWrites: requiresWriteConfirmation(profile),
    production: profile.presentation.environment === 'production',
    profileName: profile.name,
  };
}

export type SearchWriteDecision =
  | { readonly action: 'run' }
  | {
      readonly action: 'confirm';
      readonly destructive: boolean;
      /** What the confirmation says: why it asks. */
      readonly reason: string;
    }
  | { readonly action: 'refuse'; readonly reason: string };

/** What to do before an operation under a profile's policy. */
export function decideSearchWrite(
  operation: Pick<RequestSafety, 'writes' | 'destructive'>,
  policy: SearchWritePolicy,
): SearchWriteDecision {
  if (!operation.writes) return { action: 'run' };
  if (policy.readOnly) {
    return {
      action: 'refuse',
      reason: `"${policy.profileName}" is read-only, so writes are refused`,
    };
  }
  if (operation.destructive !== undefined) {
    return { action: 'confirm', destructive: true, reason: `This ${operation.destructive}.` };
  }
  if (policy.confirmWrites) {
    return {
      action: 'confirm',
      destructive: false,
      reason: policy.production
        ? 'This is a production connection, which confirms every write.'
        : `"${policy.profileName}" confirms every write.`,
    };
  }
  return { action: 'run' };
}

/** What to do before a console request (classified by method, path and body). */
export function decideSearchRequest(
  request: Pick<SearchRequest, 'method' | 'path' | 'body'>,
  policy: SearchWritePolicy,
): SearchWriteDecision & { readonly safety: RequestSafety } {
  const safety = classifyRequest(request);
  return { ...decideSearchWrite(safety, policy), safety };
}

/**
 * Enforces the rules for one operation in the connection host: READ_ONLY on a read-only
 * profile, CONFIRMATION_REQUIRED when it needs a confirmation the page did not send. `what`
 * completes "… needs confirmation" ("Deleting the index orders").
 */
export function checkSearchWrite(
  policy: SearchWritePolicy,
  operation: Pick<RequestSafety, 'writes' | 'destructive'>,
  confirmed: boolean | undefined,
  what: string,
): void {
  const decision = decideSearchWrite(operation, policy);
  if (decision.action === 'refuse') {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: `${decision.reason}: ${what.charAt(0).toLowerCase()}${what.slice(1)} was not run`,
    });
  }
  if (decision.action === 'confirm' && confirmed !== true) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `${what} needs confirmation`,
      hint: decision.reason,
    });
  }
}
