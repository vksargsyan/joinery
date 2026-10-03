import {
  commandLine,
  searchCreateArgs,
  type SearchDocument,
  type SearchFieldDefinition,
  type SearchFieldSuggestion,
  type SearchFieldType,
  type SearchIndexDefinition,
  type SearchIndexInfo,
  type SearchKeyType,
} from '@querybara/redis-tools';

/**
 * The Search indexes tool's logic (RediSearch, FT.*), apart from React: a new index being
 * written (its fields as editable rows, checked and turned into the FT.CREATE it sends),
 * query snippets per field type, and the columns of a result.
 */

/** A field row of the new-index form: strings where the user types, so every edit is kept. */
export interface FieldDraft {
  readonly id: number;
  readonly identifier: string;
  readonly attribute: string;
  readonly type: SearchFieldType;
  readonly sortable: boolean;
  readonly noStem: boolean;
  readonly weight: string;
  readonly separator: string;
  readonly caseSensitive: boolean;
  readonly algorithm: 'FLAT' | 'HNSW';
  readonly dim: string;
  readonly distance: 'COSINE' | 'L2' | 'IP';
  readonly dataType: 'FLOAT32' | 'FLOAT64' | 'FLOAT16' | 'BFLOAT16';
  /** From "Suggest from keys": how many sample documents had it, and a value. */
  readonly seen?: number;
  readonly example?: string;
}

export interface IndexDraft {
  readonly name: string;
  readonly keyType: SearchKeyType;
  /** Comma or space separated. */
  readonly prefixes: string;
  readonly filter: string;
  readonly fields: readonly FieldDraft[];
}

let nextId = 1;

export function newField(patch: Partial<Omit<FieldDraft, 'id'>> = {}): FieldDraft {
  return {
    id: nextId++,
    identifier: '',
    attribute: '',
    type: 'TEXT',
    sortable: false,
    noStem: false,
    weight: '1',
    separator: ',',
    caseSensitive: false,
    algorithm: 'HNSW',
    dim: '',
    distance: 'COSINE',
    dataType: 'FLOAT32',
    ...patch,
  };
}

export function emptyDraft(prefix = ''): IndexDraft {
  const base = prefix.replace(/[:._-]+$/, '').replace(/[^\w]+/g, '_');
  return {
    name: base !== '' ? `idx_${base}` : '',
    keyType: 'HASH',
    prefixes: prefix,
    filter: '',
    fields: [],
  };
}

export function fieldFromSuggestion(suggestion: SearchFieldSuggestion): FieldDraft {
  return newField({
    identifier: suggestion.identifier,
    attribute: suggestion.attribute ?? '',
    type: suggestion.type,
    sortable: suggestion.sortable === true,
    seen: suggestion.seen,
    example: suggestion.example,
  });
}

/** Adds suggested fields the draft does not have yet (by identifier). */
export function mergeSuggestions(
  fields: readonly FieldDraft[],
  suggestions: readonly SearchFieldSuggestion[],
): FieldDraft[] {
  const have = new Set(fields.map((field) => field.identifier));
  return [
    ...fields.filter((field) => field.identifier.trim() !== ''),
    ...suggestions.filter((s) => !have.has(s.identifier)).map(fieldFromSuggestion),
  ];
}

export function splitPrefixes(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== '');
}

/** The definition a draft describes, or what is wrong with it. */
export function definitionOfDraft(
  draft: IndexDraft,
): { readonly definition: SearchIndexDefinition } | { readonly problem: string } {
  const name = draft.name.trim();
  if (name === '') return { problem: 'Name the index' };
  if (/\s/.test(name)) return { problem: 'An index name has no spaces' };
  if (draft.fields.length === 0) return { problem: 'Add at least one field' };
  const fields: SearchFieldDefinition[] = [];
  const names = new Set<string>();
  for (const field of draft.fields) {
    const identifier = field.identifier.trim();
    if (identifier === '') return { problem: 'Every field needs a name or a JSON path' };
    if (draft.keyType === 'JSON' && !identifier.startsWith('$')) {
      return { problem: `${identifier}: JSON fields are paths starting with $` };
    }
    const attribute = field.attribute.trim();
    const queryName = attribute !== '' ? attribute : identifier;
    if (draft.keyType === 'JSON' && attribute === '') {
      return { problem: `${identifier}: give the path a name to query it by` };
    }
    if (names.has(queryName.toLowerCase())) return { problem: `${queryName} is used twice` };
    names.add(queryName.toLowerCase());
    const common = {
      identifier,
      ...(attribute !== '' && attribute !== identifier ? { attribute } : {}),
      type: field.type,
    };
    if (field.type === 'VECTOR') {
      const dim = Number(field.dim);
      if (!Number.isInteger(dim) || dim < 1 || dim > 32768) {
        return { problem: `${queryName}: a vector needs its dimension (1 to 32,768)` };
      }
      fields.push({
        ...common,
        vector: {
          algorithm: field.algorithm,
          dim,
          distance: field.distance,
          dataType: field.dataType,
        },
      });
      continue;
    }
    const weight = Number(field.weight);
    if (field.type === 'TEXT' && !(weight > 0)) {
      return { problem: `${queryName}: the weight is a positive number` };
    }
    if (field.type === 'TAG' && field.separator.length !== 1) {
      return { problem: `${queryName}: the separator is one character` };
    }
    fields.push({
      ...common,
      ...(field.sortable && field.type !== 'GEOSHAPE' ? { sortable: true } : {}),
      ...(field.type === 'TEXT' && weight !== 1 ? { weight } : {}),
      ...(field.type === 'TEXT' && field.noStem ? { noStem: true } : {}),
      ...(field.type === 'TAG' ? { separator: field.separator } : {}),
      ...(field.type === 'TAG' && field.caseSensitive ? { caseSensitive: true } : {}),
    });
  }
  const filter = draft.filter.trim();
  return {
    definition: {
      name,
      keyType: draft.keyType,
      prefixes: splitPrefixes(draft.prefixes),
      ...(filter !== '' ? { filter } : {}),
      fields,
    },
  };
}

/** The FT.CREATE line a draft sends, or null while it has a problem. */
export function createPreview(draft: IndexDraft): string | null {
  const result = definitionOfDraft(draft);
  return 'definition' in result
    ? commandLine('FT.CREATE', searchCreateArgs(result.definition))
    : null;
}

// ---------------------------------------------------------------------------------------------
// Queries

const escapeTag = (value: string): string =>
  value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~| ]/g, '\\$&');

/** A query clause for a field, to start from: `@title:term`, `@tags:{value}`, `@year:[a b]`. */
export function querySnippet(attribute: string, type: string, example = ''): string {
  const name = `@${attribute}`;
  switch (type.toUpperCase()) {
    case 'TAG':
      return `${name}:{${example !== '' ? escapeTag(example.split(',')[0]!) : 'value'}}`;
    case 'NUMERIC':
      return `${name}:[${example !== '' && !Number.isNaN(Number(example)) ? `${example} ${example}` : '0 +inf'}]`;
    case 'GEO':
      return `${name}:[${example !== '' ? example.replace(',', ' ') : '0 0'} 10 km]`;
    case 'VECTOR':
      return `*=>[KNN 10 ${name} $vector]`;
    default:
      return `${name}:${example !== '' ? (example.split(/\s+/)[0] ?? 'term') : 'term'}`;
  }
}

/** Fields that SORTBY takes. */
export function sortableFields(info: SearchIndexInfo): string[] {
  return info.fields.filter((f) => f.flags.includes('SORTABLE')).map((f) => f.attribute);
}

/**
 * The columns of a result: the index's fields in schema order, then any other field a
 * document returned (`$` for a JSON index).
 */
export function resultColumns(
  documents: readonly SearchDocument[],
  info: SearchIndexInfo | undefined,
): string[] {
  const returned = new Set<string>();
  for (const document of documents) for (const [name] of document.fields) returned.add(name);
  const ordered = (info?.fields ?? []).map((f) => f.attribute).filter((name) => returned.has(name));
  const rest = [...returned].filter((name) => !ordered.includes(name));
  return [
    ...ordered,
    ...rest.sort((a, b) => (a === '$' ? 1 : b === '$' ? -1 : a.localeCompare(b))),
  ];
}
