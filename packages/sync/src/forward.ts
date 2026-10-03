import type { SchemaSnapshot } from '@querybara/core';

import { diffSchemas } from './diff/index';
import type { CompareOptions } from './options';
import { generateScript } from './script';
import type { GeneratedScript, ScriptOptions } from './script';

/**
 * The script that creates every object of a snapshot in an empty database: ER forward
 * engineering and "dump structure". It is the structure sync against an empty target, so
 * objects come out in dependency order. PostgreSQL's `public` schema is assumed to exist.
 */
export function renderSnapshotDdl(
  snapshot: SchemaSnapshot,
  options: CompareOptions & ScriptOptions = {},
): GeneratedScript {
  const pg = snapshot.engine === 'postgres';
  const empty: SchemaSnapshot = {
    ...snapshot,
    extensions: [],
    schemas: snapshot.schemas
      .filter((schema) => !pg || schema.name === 'public')
      .map((schema) => ({
        name: schema.name,
        tables: [],
        views: [],
        routines: [],
        sequences: [],
        types: [],
        events: [],
        ...(schema.comment !== undefined ? { comment: schema.comment } : {}),
        ...(schema.owner !== undefined ? { owner: schema.owner } : {}),
      })),
  };
  const diff = diffSchemas(snapshot, empty, options);
  return generateScript(diff, { header: false, comments: false, include: 'all', ...options });
}
