import type { SchemaDef, SchemaSnapshot, SqlEngineId, TableDef } from '@querybara/core';
import {
  ER_MODEL_FORMAT,
  erModelDocumentSchema,
  type ErModelDocument,
  type ErModelDocumentInput,
} from '@querybara/ipc';

import { editedSchema, type EditContext, type ModelState } from './edit';
import { tableId, type DisplayOptions } from './model';
import type { Point } from '../query-builder/layout';

/**
 * ER model documents (spec §8, forward engineering): what a model file holds and what a draft
 * of unapplied changes keeps. A document holds the edited schema (and any other schema the model
 * changed), the live name of each table and column, and the layout. A draft also holds the
 * database the model started from, so reopening it changes only what the user changed. A file
 * holds none, and opening it on a database rebases it there: the model becomes what that
 * database's schema should look like, a table or column keeps its origin where the database has
 * it (or has one of the same name), and the rest is new. Pure.
 */

export interface DiagramLayout {
  /** Top-left corners by table id. */
  readonly positions: Readonly<Record<string, Point>>;
  readonly hidden: ReadonlySet<string>;
  readonly display: DisplayOptions;
  readonly includeViews: boolean;
}

export interface DocumentInput {
  readonly model: ModelState;
  readonly context: EditContext;
  /** The database the model started from; left out of files. */
  readonly base?: SchemaSnapshot;
  readonly layout: DiagramLayout;
  /** The schema the diagram's ids use (the database on MySQL and MariaDB). */
  readonly diagramSchema: string;
  readonly savedAt: string;
}

/** The schemas of the model that differ from where it started; always the edited one. */
function changedSchemas(
  model: ModelState,
  context: EditContext,
  base: SchemaSnapshot | undefined,
): SchemaDef[] {
  const edited = editedSchema(model.snapshot, context);
  if (!base) return [edited];
  return model.snapshot.schemas.filter((schema) => {
    if (schema.name === edited.name) return true;
    const before = base.schemas.find((s) => s.name === schema.name);
    return !before || JSON.stringify(before) !== JSON.stringify(schema);
  });
}

function placeOf(id: string, diagramSchema: string): { schema?: string; table: string } {
  const [schema, table] = JSON.parse(id) as [string, string];
  return schema === diagramSchema ? { table } : { schema, table };
}

function idOf(
  place: { readonly schema?: string; readonly table: string },
  diagramSchema: string,
): string {
  return tableId(place.schema ?? diagramSchema, place.table);
}

export function modelDocument(input: DocumentInput): ErModelDocumentInput {
  const { model, context, base, layout, diagramSchema } = input;
  return {
    format: ER_MODEL_FORMAT,
    version: 1,
    engine: context.engine,
    database: model.snapshot.database,
    schema: context.schema,
    savedAt: input.savedAt,
    model: {
      schemas: changedSchemas(model, context, base),
      tableOrigins: { ...model.tableOrigins },
      columnOrigins: Object.fromEntries(
        Object.entries(model.columnOrigins).map(([table, columns]) => [table, { ...columns }]),
      ),
    },
    ...(base ? { base } : {}),
    layout: {
      positions: Object.entries(layout.positions).map(([id, point]) => ({
        ...placeOf(id, diagramSchema),
        x: Math.round(point.x),
        y: Math.round(point.y),
      })),
      hidden: [...layout.hidden].map((id) => placeOf(id, diagramSchema)),
      display: { ...layout.display },
      includeViews: layout.includeViews,
    },
  };
}

/** A document's layout on a diagram whose ids use `diagramSchema`. */
export function documentLayout(document: ErModelDocument, diagramSchema: string): DiagramLayout {
  return {
    positions: Object.fromEntries(
      document.layout.positions.map((p) => [idOf(p, diagramSchema), { x: p.x, y: p.y }]),
    ),
    hidden: new Set(document.layout.hidden.map((p) => idOf(p, diagramSchema))),
    display: document.layout.display,
    includeViews: document.layout.includeViews,
  };
}

/** Pretty JSON, so model files read and diff well in version control. */
export function documentText(document: ErModelDocumentInput): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Engines whose models can be opened on each other: MySQL and MariaDB are one family. */
export function sameFamily(a: SqlEngineId, b: SqlEngineId): boolean {
  return (a === 'postgres') === (b === 'postgres');
}

export type ParsedFile =
  | { readonly ok: true; readonly document: ErModelDocument }
  | { readonly ok: false; readonly message: string };

/** Reads a model file's text. */
export function parseModelFile(text: string): ParsedFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The file is not a Querybara ER model (it is not JSON)' };
  }
  const header = json as { format?: unknown; version?: unknown } | null;
  if (typeof header !== 'object' || header === null || header.format !== ER_MODEL_FORMAT) {
    return { ok: false, message: 'The file is not a Querybara ER model' };
  }
  if (typeof header.version === 'number' && header.version > 1) {
    return {
      ok: false,
      message: 'The model was saved by a newer Querybara; update Querybara to open it',
    };
  }
  const parsed = erModelDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `The model file is damaged${issue ? ` (${issue.path.join('.') || 'root'}: ${issue.message})` : ''}`,
    };
  }
  return { ok: true, document: parsed.data };
}

/** A draft's model, on the database it started from (its `base`). */
export function restoreDraft(document: ErModelDocument): {
  readonly base: SchemaSnapshot;
  readonly model: ModelState;
} {
  const base = document.base;
  if (!base) throw new Error('A draft keeps the database it started from');
  const changed = new Map(document.model.schemas.map((s) => [s.name, s]));
  return {
    base,
    model: {
      snapshot: {
        ...base,
        schemas: [
          ...base.schemas.map((s) => changed.get(s.name) ?? s),
          ...document.model.schemas.filter((s) => !base.schemas.some((b) => b.name === s.name)),
        ],
      },
      tableOrigins: document.model.tableOrigins,
      columnOrigins: document.model.columnOrigins,
    },
  };
}

/**
 * A model file's model on the live database it is opened on: its edited schema takes the place
 * of `context.schema` (references to its own schema follow the new name), and each table and
 * column keeps its origin where the live schema has it, else takes the live one of the same
 * name, else is new.
 */
export function rebaseModel(
  document: ErModelDocument,
  live: SchemaSnapshot,
  context: EditContext,
): ModelState {
  const liveSchema = editedSchema(live, context);
  const saved =
    document.model.schemas.find((s) => s.name === document.schema) ?? document.model.schemas[0]!;
  const pg = context.engine === 'postgres';
  const schema: SchemaDef = {
    ...saved,
    name: liveSchema.name,
    tables: saved.tables.map((table) => ({
      ...table,
      foreignKeys: table.foreignKeys.map((fk) =>
        pg && fk.refSchema === document.schema ? { ...fk, refSchema: liveSchema.name } : fk,
      ),
    })),
  };
  const liveTable = (name: string | null | undefined) =>
    name ? liveSchema.tables.find((t) => t.name === name) : undefined;
  // Saved origins claim their live tables first; names match only what is left, so a table
  // renamed away and a new table under the old name do not both claim it.
  const claimed = new Set<string>();
  const origins = new Map<string, TableDef>();
  for (const pass of ['saved', 'name'] as const) {
    for (const table of schema.tables) {
      if (origins.has(table.name)) continue;
      const found = liveTable(
        pass === 'saved' ? document.model.tableOrigins[table.name] : table.name,
      );
      if (found && !claimed.has(found.name)) {
        claimed.add(found.name);
        origins.set(table.name, found);
      }
    }
  }
  const tableOrigins: Record<string, string | null> = {};
  const columnOrigins: Record<string, Record<string, string | null>> = {};
  for (const table of schema.tables) {
    const origin = origins.get(table.name);
    tableOrigins[table.name] = origin?.name ?? null;
    const savedColumns = document.model.columnOrigins[table.name] ?? {};
    const taken = new Set<string>();
    const kept = new Map<string, string>();
    for (const pass of ['saved', 'name'] as const) {
      for (const column of table.columns) {
        if (kept.has(column.name)) continue;
        const want = pass === 'saved' ? savedColumns[column.name] : column.name;
        const found = origin?.columns.find((c) => c.name === want);
        if (found && !taken.has(found.name)) {
          taken.add(found.name);
          kept.set(column.name, found.name);
        }
      }
    }
    columnOrigins[table.name] = Object.fromEntries(
      table.columns.map((column) => [column.name, kept.get(column.name) ?? null]),
    );
  }
  return {
    snapshot: {
      ...live,
      schemas: live.schemas.map((s) => (s === liveSchema ? schema : s)),
    },
    tableOrigins,
    columnOrigins,
  };
}
