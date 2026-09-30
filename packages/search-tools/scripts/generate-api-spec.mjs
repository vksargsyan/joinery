#!/usr/bin/env node
/**
 * Regenerates src/api/spec.json, the console's autocomplete data, from the open Elasticsearch
 * API specification (https://github.com/elastic/elasticsearch-specification, Apache License 2.0):
 * its compiled `output/schema/schema.json` for one branch.
 *
 *   node scripts/generate-api-spec.mjs [--branch main] [--schema path/to/schema.json]
 *
 * What is kept, to stay small enough for the renderer: every public stack endpoint (name,
 * methods, URL templates, query parameter names, body kind, a one-line summary), and the
 * property names and value types of the request bodies and of every type reachable from them
 * (queries, aggregations, mappings, settings...). Descriptions, responses and examples are
 * dropped. The output is formatted with Prettier so `prettier --check` accepts it as is.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const branch = option('branch') ?? 'main';
const schemaPath = option('schema');
const out = join(here, '..', 'src', 'api', 'spec.json');

const url = `https://raw.githubusercontent.com/elastic/elasticsearch-specification/${branch}/output/schema/schema.json`;
const schema = schemaPath
  ? JSON.parse(await readFile(schemaPath, 'utf8'))
  : await fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    });

const typesByKey = new Map(schema.types.map((type) => [fullName(type.name), type]));
const nameCounts = new Map();
for (const type of schema.types) {
  nameCounts.set(type.name.name, (nameCounts.get(type.name.name) ?? 0) + 1);
}

function fullName(name) {
  return `${name.namespace}::${name.name}`;
}

/** A short, unique key for a type: its name, or "<last namespace part>.<name>" when shared. */
function keyOf(name) {
  if (name.name === 'Request' || name.name === 'Response' || nameCounts.get(name.name) > 1) {
    const namespace = name.namespace.replace(/^_global\./, '').replace(/^_types\./, '');
    return `${namespace}.${name.name}`;
  }
  return name.name;
}

const NUMBER_ALIASES = new Set([
  'byte',
  'short',
  'integer',
  'long',
  'float',
  'double',
  'uint',
  'ulong',
  'number',
]);

/**
 * Endpoints whose request bodies are described key by key: the ones a console session writes by
 * hand. Every other endpoint still completes its path, methods and query parameters.
 */
const BODY_ENDPOINTS = new Set([
  'async_search.submit',
  'bulk',
  'cluster.put_component_template',
  'cluster.put_settings',
  'count',
  'delete_by_query',
  'eql.search',
  'esql.async_query',
  'esql.query',
  'explain',
  'field_caps',
  'ilm.put_lifecycle',
  'index',
  'indices.analyze',
  'indices.clone',
  'indices.create',
  'indices.put_alias',
  'indices.put_index_template',
  'indices.put_mapping',
  'indices.put_settings',
  'indices.put_template',
  'indices.rollover',
  'indices.shrink',
  'indices.simulate_index_template',
  'indices.split',
  'indices.update_aliases',
  'indices.validate_query',
  'ingest.put_pipeline',
  'ingest.simulate',
  'mget',
  'msearch',
  'open_point_in_time',
  'reindex',
  'scroll',
  'search',
  'search_template',
  'snapshot.create',
  'snapshot.create_repository',
  'snapshot.restore',
  'sql.query',
  'sql.translate',
  'termvectors',
  'update',
  'update_by_query',
]);

const types = {};
const pending = [];

/** The compact reference text of a value type (see src/api/spec.ts for the grammar). */
function ref(value) {
  switch (value.kind) {
    case 'instance_of': {
      const { name, namespace } = value.type;
      if (namespace === '_builtins') {
        if (name === 'string') return 's';
        if (name === 'boolean') return 'b';
        if (name === 'number') return 'n';
        if (name === 'null') return 'null';
        return '*';
      }
      if (namespace === '_types' && NUMBER_ALIASES.has(name)) return 'n';
      const type = typesByKey.get(`${namespace}::${name}`);
      // Generic parameters (TDocument...) are user data.
      if (!type) return '*';
      const key = keyOf(type.name);
      if (!(key in types)) {
        types[key] = null;
        pending.push(type);
      }
      return key;
    }
    case 'array_of':
      return `[]${wrap(ref(value.value))}`;
    case 'dictionary_of':
      return `${value.singleKey ? '{1}' : '{}'}${wrap(ref(value.value))}`;
    case 'union_of': {
      const items = [...new Set(value.items.map(ref))];
      return items.length === 1 ? items[0] : `(${items.join('|')})`;
    }
    case 'literal_value':
      return typeof value.value === 'string'
        ? `enum:${value.value}`
        : typeof value.value === 'number'
          ? 'n'
          : 'b';
    case 'user_defined_value':
    default:
      return '*';
  }
}

/** Parenthesises a union or enum inside an array or dictionary reference. */
function wrap(text) {
  return text.startsWith('enum:') ? `(${text})` : text;
}

/** An interface's properties with its ancestors', and the property name aliases. */
function properties(type, seen = new Set()) {
  const props = {};
  const aliases = {};
  if (seen.has(fullName(type.name))) return { props, aliases };
  seen.add(fullName(type.name));
  if (type.inherits) {
    const parent = typesByKey.get(fullName(type.inherits.type));
    if (parent) {
      const inherited = properties(parent, seen);
      Object.assign(props, inherited.props);
      Object.assign(aliases, inherited.aliases);
    }
  }
  const own =
    type.kind === 'request'
      ? type.body.kind === 'properties'
        ? type.body.properties
        : []
      : (type.properties ?? []);
  for (const property of own) {
    if (property.availability?.stack?.visibility === 'private') continue;
    props[property.name] = ref(property.type);
    for (const alias of property.aliases ?? []) aliases[alias] = property.name;
  }
  return { props, aliases };
}

function describe(type) {
  switch (type.kind) {
    case 'interface':
    case 'request': {
      const { props, aliases } = properties(type);
      return Object.keys(aliases).length > 0 ? { props, aliases } : { props };
    }
    case 'enum':
      return { enum: type.members.map((member) => member.name) };
    case 'type_alias':
      return { ref: ref(type.type) };
    default:
      return { ref: '*' };
  }
}

function summary(description) {
  if (!description) return undefined;
  const line = description.split('\n')[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

const endpoints = [];
for (const endpoint of schema.endpoints) {
  const stack = endpoint.availability?.stack;
  if (!stack || stack.visibility === 'private' || stack.visibility === 'feature_flag') continue;
  const request = typesByKey.get(fullName(endpoint.request));
  const media = endpoint.requestMediaType ?? [];
  const body =
    !request || request.body.kind === 'no_body'
      ? undefined
      : media.includes('application/x-ndjson')
        ? 'ndjson'
        : 'json';
  const entry = {
    name: endpoint.name,
    methods: [...new Set(endpoint.urls.flatMap((u) => u.methods))],
    paths: endpoint.urls.map((u) => u.path),
  };
  const params = [...new Set((request?.query ?? []).map((p) => p.name))].sort();
  if (params.length > 0) entry.params = params;
  if (body) entry.body = body;
  if (!BODY_ENDPOINTS.has(endpoint.name)) {
    // Path, methods and parameters only.
  } else if (request && request.body.kind === 'properties') {
    entry.type = keyOf(request.name);
    if (!(entry.type in types)) {
      types[entry.type] = null;
      pending.push(request);
    }
  } else if (request && request.body.kind === 'value') {
    entry.type = ref(request.body.value);
  }
  const text = summary(endpoint.description);
  if (text) entry.summary = text;
  if (stack.stability && stack.stability !== 'stable') entry.stability = stack.stability;
  if (stack.since) entry.since = stack.since;
  endpoints.push(entry);
}

while (pending.length > 0) {
  const type = pending.shift();
  types[keyOf(type.name)] = describe(type);
}

endpoints.sort((a, b) => a.name.localeCompare(b.name));
const sortedTypes = Object.fromEntries(
  Object.entries(types).sort(([a], [b]) => a.localeCompare(b)),
);
const spec = {
  source: {
    repository: 'https://github.com/elastic/elasticsearch-specification',
    branch,
    license: 'Apache-2.0',
    generated: new Date().toISOString().slice(0, 10),
  },
  endpoints,
  types: sortedTypes,
};

const config = await prettier.resolveConfig(out);
const text = await prettier.format(JSON.stringify(spec), { ...config, parser: 'json' });
await writeFile(out, text);
console.log(
  `Wrote ${out}: ${endpoints.length} endpoints, ${Object.keys(sortedTypes).length} types, ${Math.round(text.length / 1024)} KiB`,
);
