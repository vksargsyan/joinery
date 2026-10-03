import type { ColumnDef, SchemaSnapshot, TableDef } from '@querybara/core';
import { member, parseJsonTree, stringAt, type JsonNode } from '@querybara/search-tools';

import type { SearchContext } from './context';
import { listIndices } from './indices';

/**
 * A SchemaSnapshot of a cluster, for the metadata cache and autocomplete: one schema named after
 * the cluster, each (non-hidden) index a table whose columns are its mapped fields, flattened to
 * dotted paths ("customer.name", multi-fields as "title.keyword") with the field type as
 * `dataType`. Index settings, aliases and templates are left out.
 */

function fieldsOf(properties: JsonNode | undefined, prefix: string, out: ColumnDef[]): void {
  if (properties?.type !== 'object') return;
  for (const field of properties.members) {
    const path = `${prefix}${field.key}`;
    const type =
      stringAt(field.value, 'type') ?? (member(field.value, 'properties') ? 'object' : 'unknown');
    out.push({
      name: path,
      ordinal: out.length + 1,
      dataType: type,
      nullable: true,
      default: null,
      autoIncrement: false,
    });
    fieldsOf(member(field.value, 'properties'), `${path}.`, out);
    const multi = member(field.value, 'fields');
    if (multi?.type === 'object') {
      for (const sub of multi.members) {
        out.push({
          name: `${path}.${sub.key}`,
          ordinal: out.length + 1,
          dataType: stringAt(sub.value, 'type') ?? 'unknown',
          nullable: true,
          default: null,
          autoIncrement: false,
        });
      }
    }
  }
}

export async function introspectSearch(
  ctx: SearchContext,
  clusterName: string,
): Promise<SchemaSnapshot> {
  const indices = await listIndices(ctx);
  const tables: TableDef[] = [];
  if (indices.length > 0) {
    const { text } = await ctx.json({ method: 'GET', path: '/_mapping' });
    const root = parseJsonTree(text);
    const known = new Set(indices.map((i) => i.name));
    if (root.type === 'object') {
      for (const index of root.members) {
        if (!known.has(index.key)) continue;
        const columns: ColumnDef[] = [];
        fieldsOf(member(member(index.value, 'mappings'), 'properties'), '', columns);
        tables.push({
          name: index.key,
          kind: 'table',
          columns,
          uniques: [],
          indexes: [],
          foreignKeys: [],
          checks: [],
          triggers: [],
          options: {},
        });
      }
    }
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return {
    engine: 'elasticsearch',
    serverVersion: ctx.facts.version,
    database: clusterName,
    options: {},
    schemas: [
      {
        name: clusterName,
        tables,
        views: [],
        routines: [],
        sequences: [],
        types: [],
        events: [],
      },
    ],
    extensions: [],
    capturedAt: new Date().toISOString(),
  };
}
