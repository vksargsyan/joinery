import { JoineryError } from '@joinery/core';
import {
  ShellParseError,
  formatFindText,
  formatShellInline,
  locationAt,
  parseFindText,
  parseShellDocument,
  type BsonDocument,
  type QueryModel,
} from '@joinery/mongo-tools';

/**
 * The collection view's query bar (spec §9): filter, projection, sort, skip and limit typed in
 * mongosh syntax, validated as the user types with the shell parser (errors carry their
 * position), and the `db.coll.find(...)` text generated from them. The text is editable too:
 * when it parses, the fields follow it. Collation, hint and maxTimeMS have no field; they come
 * from the text and are kept while the fields change.
 */

export const QUERY_FIELDS = ['filter', 'projection', 'sort', 'skip', 'limit'] as const;
export type QueryField = (typeof QUERY_FIELDS)[number];
export type QueryFields = Readonly<Record<QueryField, string>>;

/** A problem in a field or in the find text, located for the editor's marker. */
export interface TextIssue {
  readonly message: string;
  /** 0-based offset into the text. */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** The parts of a find() the fields do not show. */
export type QueryExtras = Pick<QueryModel, 'collation' | 'hint' | 'maxTimeMS'>;

export const EMPTY_FIELDS: QueryFields = {
  filter: '',
  projection: '',
  sort: '',
  skip: '',
  limit: '',
};

/** The issue of a thrown parse error (a ShellParseError or any JoineryError). */
export function issueOf(text: string, error: unknown): TextIssue {
  if (error instanceof ShellParseError) {
    return { message: error.reason, offset: error.offset, line: error.line, column: error.column };
  }
  const offset = error instanceof JoineryError && error.position !== undefined ? error.position : 0;
  const { line, column } = locationAt(text, offset);
  const message = error instanceof Error ? error.message : String(error);
  return { message, offset, line, column };
}

const DOCUMENT_FIELDS: ReadonlySet<QueryField> = new Set(['filter', 'projection', 'sort']);

/** Parses a document field; '' is an empty document. */
function documentField(field: QueryField, text: string): BsonDocument {
  return text.trim() === '' ? {} : parseShellDocument(text, field);
}

/** Parses skip or limit; '' is none. */
function countField(field: QueryField, text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) {
    const at = text.search(/[^\s\d]|\S\s+\S/);
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `${field === 'skip' ? 'Skip' : 'Limit'} must be a whole number`,
      position: Math.max(0, at),
    });
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `${field === 'skip' ? 'Skip' : 'Limit'} is too large`,
      position: text.indexOf(trimmed),
    });
  }
  return n;
}

/** Checks one field as typed; undefined when it is valid (or empty). */
export function checkField(field: QueryField, text: string): TextIssue | undefined {
  try {
    if (DOCUMENT_FIELDS.has(field)) documentField(field, text);
    else countField(field, text);
    return undefined;
  } catch (error) {
    return issueOf(text, error);
  }
}

/** Every field's issue. */
export function checkFields(fields: QueryFields): Partial<Record<QueryField, TextIssue>> {
  const issues: Partial<Record<QueryField, TextIssue>> = {};
  for (const field of QUERY_FIELDS) {
    const issue = checkField(field, fields[field]);
    if (issue) issues[field] = issue;
  }
  return issues;
}

/** The query model of valid fields plus the extras; throws on an invalid field. */
export function modelOf(fields: QueryFields, extras: QueryExtras = {}): QueryModel {
  const projection = documentField('projection', fields.projection);
  const sort = documentField('sort', fields.sort);
  const skip = countField('skip', fields.skip);
  const limit = countField('limit', fields.limit);
  return {
    filter: documentField('filter', fields.filter),
    ...(Object.keys(projection).length > 0 ? { projection } : {}),
    ...(Object.keys(sort).length > 0 ? { sort } : {}),
    ...(skip !== undefined && skip > 0 ? { skip } : {}),
    ...(limit !== undefined && limit > 0 ? { limit } : {}),
    ...extras,
  };
}

function documentText(doc: BsonDocument | undefined): string {
  return doc === undefined || Object.keys(doc).length === 0 ? '' : formatShellInline(doc);
}

/** The fields showing a model (a find text parsed back). */
export function fieldsOf(model: QueryModel): { fields: QueryFields; extras: QueryExtras } {
  return {
    fields: {
      filter: documentText(model.filter),
      projection: documentText(model.projection),
      sort: documentText(model.sort),
      skip: model.skip !== undefined && model.skip > 0 ? String(model.skip) : '',
      limit: model.limit !== undefined && model.limit > 0 ? String(model.limit) : '',
    },
    extras: {
      ...(model.collation !== undefined ? { collation: model.collation } : {}),
      ...(model.hint !== undefined ? { hint: model.hint } : {}),
      ...(model.maxTimeMS !== undefined ? { maxTimeMS: model.maxTimeMS } : {}),
    },
  };
}

/** The `db.coll.find(...)` text of the fields, or undefined while one is invalid. */
export function findTextOf(
  collection: string,
  fields: QueryFields,
  extras: QueryExtras = {},
): string | undefined {
  try {
    return formatFindText(collection, modelOf(fields, extras));
  } catch {
    return undefined;
  }
}

export type ParsedFindInput =
  | { readonly ok: true; readonly fields: QueryFields; readonly extras: QueryExtras }
  | { readonly ok: false; readonly issue: TextIssue };

/**
 * Parses find() text typed by the user into fields. The text may name the collection (it must
 * be this one), be a bare `find(...)`, or be just a filter document.
 */
export function parseFindInput(text: string, collection: string): ParsedFindInput {
  try {
    const parsed = parseFindText(text);
    if (parsed.collection !== undefined && parsed.collection !== collection) {
      const offset = Math.max(0, text.indexOf(parsed.collection));
      const { line, column } = locationAt(text, offset);
      return {
        ok: false,
        issue: {
          message: `This view shows ${collection}; open ${parsed.collection} to query it`,
          offset,
          line,
          column,
        },
      };
    }
    return { ok: true, ...fieldsOf(parsed.query) };
  } catch (error) {
    return { ok: false, issue: issueOf(text, error) };
  }
}
