import { compactJson, member, nodeText, parseJsonTree, stringAt, type JsonNode } from './json';

/**
 * Mappings (spec §11): the fields of a mapping as a flat list, and what a proposed mapping
 * would change. Elasticsearch and OpenSearch accept new fields, new multi-fields and a few
 * updatable parameters on an existing index; any other change to an existing field (its type,
 * analyzer, index or doc_values...) is refused, and the data has to move to a new index with a
 * reindex (see reindex.ts). The mapping editor shows this before anything is sent.
 */

/** One field of a mapping. */
export interface MappingField {
  /** The dotted path, e.g. "customer.name" or "title.keyword" for a multi-field. */
  readonly path: string;
  /** "keyword", "text", "long"...; "object" or "nested" for containers. */
  readonly type: string;
  /** A multi-field (under a field's `fields`): it is not in `_source`. */
  readonly multiField: boolean;
  /** The field's definition without its sub-fields, compact JSON. */
  readonly definition: string;
}

/** Parameters an existing field may change in place (the rest need a reindex). */
const UPDATABLE_PARAMETERS = new Set([
  'ignore_above',
  'ignore_malformed',
  'search_analyzer',
  'search_quote_analyzer',
  'meta',
  'dynamic',
  'boost',
]);

/** Mapping-level settings that may change on an existing index. */
const ROOT_UPDATABLE = new Set([
  '_meta',
  'dynamic',
  'date_detection',
  'numeric_detection',
  'dynamic_templates',
  'dynamic_date_formats',
]);

/**
 * The `mappings` object inside a `GET /<index>/_mapping` reply (`{"<index>": {"mappings":
 * {...}}}`), a `mappings` wrapper, or a bare mapping with `properties`. Undefined when the text
 * holds none.
 */
export function mappingRoot(text: string): JsonNode | undefined {
  const root = parseJsonTree(text);
  if (root.type !== 'object') return undefined;
  if (member(root, 'properties') !== undefined || member(root, 'dynamic') !== undefined) {
    return root;
  }
  const direct = member(root, 'mappings');
  if (direct?.type === 'object') return direct;
  for (const m of root.members) {
    const inner = member(m.value, 'mappings');
    if (inner?.type === 'object') return inner;
  }
  return root.members.length === 0 ? root : undefined;
}

function definitionOf(text: string, node: JsonNode): string {
  if (node.type !== 'object') return compactJson(nodeText(text, node));
  const members = node.members
    .filter((m) => m.key !== 'properties' && m.key !== 'fields')
    .map((m) => `${JSON.stringify(m.key)}:${compactJson(nodeText(text, m.value))}`);
  return `{${members.join(',')}}`;
}

function typeOf(node: JsonNode): string {
  return stringAt(node, 'type') ?? 'object';
}

/** The fields of a mapping, depth first (objects before their properties). */
export function mappingFields(text: string): MappingField[] {
  const mappings = mappingRoot(text);
  if (!mappings) return [];
  const out: MappingField[] = [];
  const walk = (properties: JsonNode | undefined, prefix: string): void => {
    if (properties?.type !== 'object') return;
    for (const m of properties.members) {
      const path = prefix === '' ? m.key : `${prefix}.${m.key}`;
      out.push({
        path,
        type: typeOf(m.value),
        multiField: false,
        definition: definitionOf(text, m.value),
      });
      const fields = member(m.value, 'fields');
      if (fields?.type === 'object') {
        for (const f of fields.members) {
          out.push({
            path: `${path}.${f.key}`,
            type: typeOf(f.value),
            multiField: true,
            definition: definitionOf(text, f.value),
          });
        }
      }
      walk(member(m.value, 'properties'), path);
    }
  };
  walk(member(mappings, 'properties'), '');
  return out;
}

/** One difference between the current and the proposed mapping. */
export interface MappingChange {
  readonly path: string;
  readonly kind: 'added' | 'updated' | 'changed' | 'removed';
  /** Why it needs a reindex (changed, removed), or what changes in place (updated). */
  readonly reason: string;
}

/** What applying a proposed mapping means. */
export interface MappingPlan {
  readonly changes: readonly MappingChange[];
  /** Every change can be applied with `PUT /<index>/_mapping`. */
  readonly inPlace: boolean;
  /** The body for `PUT /<index>/_mapping` (the proposed mapping), when `inPlace`. */
  readonly putBody?: string;
}

function parametersOf(text: string, node: JsonNode): Map<string, string> {
  const out = new Map<string, string>();
  if (node.type !== 'object') return out;
  for (const m of node.members) {
    if (m.key === 'properties' || m.key === 'fields') continue;
    out.set(m.key, compactJson(nodeText(text, m.value)));
  }
  return out;
}

/**
 * Compares a proposed mapping with the current one (both JSON text, in any form mappingRoot
 * reads). Added fields and multi-fields and changes to updatable parameters apply in place;
 * a changed type or other parameter, or a field left out, needs a reindex (a field cannot be
 * removed from a mapping).
 */
export function planMappingChange(current: string, proposed: string): MappingPlan {
  const before = mappingRoot(current);
  const after = mappingRoot(proposed);
  if (!after) throw new Error('The proposed mapping has no "properties"');
  const changes: MappingChange[] = [];

  const compareField = (path: string, old: JsonNode, next: JsonNode): void => {
    const oldType = typeOf(old);
    const newType = typeOf(next);
    if (oldType !== newType) {
      changes.push({
        path,
        kind: 'changed',
        reason: `its type changes from ${oldType} to ${newType}, and a field's type cannot change`,
      });
      return;
    }
    const a = parametersOf(current, old);
    const b = parametersOf(proposed, next);
    const keys = new Set([...a.keys(), ...b.keys()]);
    for (const key of keys) {
      if (a.get(key) === b.get(key)) continue;
      if (UPDATABLE_PARAMETERS.has(key)) {
        changes.push({ path, kind: 'updated', reason: `${key} can change in place` });
      } else {
        changes.push({
          path,
          kind: 'changed',
          reason: b.has(key)
            ? `${key} changes, and it cannot change on an existing field`
            : `${key} is removed, and it cannot change on an existing field`,
        });
      }
    }
    compareProperties(path, member(old, 'fields'), member(next, 'fields'), true);
    compareProperties(path, member(old, 'properties'), member(next, 'properties'), false);
  };

  const compareProperties = (
    prefix: string,
    old: JsonNode | undefined,
    next: JsonNode | undefined,
    multi: boolean,
  ): void => {
    const oldMembers = old?.type === 'object' ? old.members : [];
    const newMembers = next?.type === 'object' ? next.members : [];
    const pathOf = (key: string): string => (prefix === '' ? key : `${prefix}.${key}`);
    for (const m of newMembers) {
      const previous = oldMembers.find((o) => o.key === m.key);
      if (!previous) {
        changes.push({
          path: pathOf(m.key),
          kind: 'added',
          reason: multi ? 'a new multi-field' : 'a new field',
        });
      } else {
        compareField(pathOf(m.key), previous.value, m.value);
      }
    }
    for (const o of oldMembers) {
      if (!newMembers.some((m) => m.key === o.key)) {
        changes.push({
          path: pathOf(o.key),
          kind: 'removed',
          reason: 'fields cannot be removed from a mapping; only a new index leaves it out',
        });
      }
    }
  };

  compareProperties(
    '',
    before ? member(before, 'properties') : undefined,
    member(after, 'properties'),
    false,
  );
  if (before) {
    const a = parametersOf(current, before);
    const b = parametersOf(proposed, after);
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(key) === b.get(key)) continue;
      changes.push(
        ROOT_UPDATABLE.has(key)
          ? { path: key, kind: 'updated', reason: `${key} can change in place` }
          : { path: key, kind: 'changed', reason: `${key} cannot change on an existing index` },
      );
    }
  }
  const inPlace = changes.every((c) => c.kind === 'added' || c.kind === 'updated');
  return {
    changes,
    inPlace,
    ...(inPlace ? { putBody: compactJson(nodeText(proposed, after)) } : {}),
  };
}
