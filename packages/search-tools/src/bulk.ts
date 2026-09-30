import { compactJson } from './json';

/**
 * `_bulk` bodies for the document grid's bulk actions (spec §11): delete or partially update
 * the selected documents, each action carrying the version it was read at (`if_seq_no` /
 * `if_primary_term`), so a document changed meanwhile fails on its own line instead of being
 * overwritten. Per-item outcomes come back in the bulk reply.
 */

/** A document a bulk action targets. */
export interface BulkTarget {
  readonly index: string;
  readonly id: string;
  readonly routing?: string;
  readonly seqNo?: number;
  readonly primaryTerm?: number;
}

function actionLine(action: 'delete' | 'update', target: BulkTarget): string {
  const fields = [
    `"_index":${JSON.stringify(target.index)}`,
    `"_id":${JSON.stringify(target.id)}`,
    ...(target.routing !== undefined ? [`"routing":${JSON.stringify(target.routing)}`] : []),
    ...(target.seqNo !== undefined && target.primaryTerm !== undefined
      ? [`"if_seq_no":${target.seqNo}`, `"if_primary_term":${target.primaryTerm}`]
      : []),
  ];
  return `{"${action}":{${fields.join(',')}}}`;
}

/** NDJSON that deletes the documents (one line each, ending in a newline). */
export function bulkDeleteLines(targets: readonly BulkTarget[]): string {
  return targets.map((t) => `${actionLine('delete', t)}\n`).join('');
}

/** NDJSON that merges `doc` (a partial document, JSON text) into each document. */
export function bulkUpdateLines(targets: readonly BulkTarget[], doc: string): string {
  const body = `{"doc":${compactJson(doc)}}`;
  return targets.map((t) => `${actionLine('update', t)}\n${body}\n`).join('');
}
