import { QuerybaraError } from '@querybara/core';
import { z } from 'zod';

/**
 * Error helpers. Messages name the kind of thing and its id, never a value: callers pass
 * secrets and connection URIs through this package, and error text ends up in logs.
 */

/** Validates `value` against `schema`, throwing VALIDATION_FAILED with a readable detail. */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Zod issue messages describe the expectation and the path, not the rejected input.
  throw new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `Invalid ${what}`,
    detail: z.prettifyError(result.error),
  });
}

export function notFound(what: string, id: string): QuerybaraError {
  return new QuerybaraError({ code: 'NOT_FOUND', message: `${what} ${id} does not exist` });
}

/** Optimistic concurrency failure: the row changed since the caller read it. */
export function versionConflict(what: string, id: string, expected: number, actual: number) {
  return new QuerybaraError({
    code: 'CONFLICT',
    message: `${what} ${id} was changed elsewhere (version ${actual}, expected ${expected})`,
    hint: 'Reload it and apply the change again.',
  });
}

/** A stored row no longer parses: a bug or a hand-edited database, never user input. */
export function corruptRow(what: string, id: string, cause?: unknown): QuerybaraError {
  return new QuerybaraError(
    { code: 'INTERNAL', message: `Stored ${what} ${id} is unreadable` },
    cause === undefined ? undefined : { cause },
  );
}
