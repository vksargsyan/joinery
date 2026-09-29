import { JoineryError, requiresWriteConfirmation, type ConnectionProfile } from '@joinery/core';

/**
 * The MongoDB write rules (spec §4), shared by the connection host's `mongo.*` handlers and
 * main's GridFS transfers: a read-only profile refuses every write (a dry run only counts, so it
 * runs); destructive operations need the page's confirmation on every profile; on production
 * profiles and profiles that confirm writes every write needs it.
 */

/** How much of a write the rules look at. */
export interface WriteRequest {
  readonly confirmed?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

/**
 * Checks the write rules for one operation; `what` completes "… needs confirmation" and
 * "… was refused" ("Dropping the collection shop.orders").
 */
export function checkMongoWrite(
  profile: ConnectionProfile,
  request: WriteRequest,
  what: string,
  destructive: boolean,
): void {
  if (request.dryRun === true) return;
  if (profile.presentation.readOnly) {
    throw new JoineryError({
      code: 'READ_ONLY',
      message: `"${profile.name}" is read-only: ${lowerFirst(what)} was refused`,
    });
  }
  if ((destructive || requiresWriteConfirmation(profile)) && request.confirmed !== true) {
    throw new JoineryError({
      code: 'CONFIRMATION_REQUIRED',
      message: `${what} needs confirmation${
        destructive
          ? ''
          : profile.presentation.environment === 'production'
            ? ' on a production connection'
            : ` on "${profile.name}"`
      }`,
    });
  }
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** True when an aggregation pipeline (Extended JSON array) ends in $out or $merge. */
export function pipelineWrites(pipeline: string): boolean {
  let stages: unknown;
  try {
    stages = JSON.parse(pipeline);
  } catch {
    // The driver reports the syntax error with its position.
    return false;
  }
  if (!Array.isArray(stages) || stages.length === 0) return false;
  const last: unknown = stages[stages.length - 1];
  if (typeof last !== 'object' || last === null) return false;
  const name = Object.keys(last)[0];
  return name === '$out' || name === '$merge';
}
