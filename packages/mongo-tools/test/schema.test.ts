import { describe, expect, it } from 'vitest';

import {
  SchemaAnalyzer,
  analyzeSchema,
  parseShellDocument,
  toEjson,
  toJsonSchema,
  type SchemaField,
} from '../src';

const docs = [
  "{ _id: 1, name: 'Ada', age: 36, tags: ['a', 'b'], address: { city: 'London', zip: '1' } }",
  "{ _id: 2, name: 'Alan', age: NumberLong(41), tags: [], address: { city: 'Wilmslow' } }",
  "{ _id: 3, name: 'Grace', age: null, tags: ['a', { k: 1 }], items: [{ sku: 'x', qty: 1 }, { sku: 'y' }] }",
  "{ _id: 4, name: 'Ada', age: 1.5 }",
].map((text) => parseShellDocument(text));

function field(fields: readonly SchemaField[], path: string): SchemaField {
  const found = fields.find((f) => f.name === path.split('.')[0]);
  if (!found) throw new Error(`no field ${path}`);
  const rest = path.split('.').slice(1);
  if (rest.length === 0) return found;
  if (rest[0] === '[]') {
    if (!found.items) throw new Error(`no items at ${path}`);
    return rest.length === 1 ? found.items : field(found.items.fields, rest.slice(1).join('.'));
  }
  return field(found.fields, rest.join('.'));
}

describe('schema analysis', () => {
  const analysis = analyzeSchema(docs);

  it('reports fields in first-seen order with presence and type mix', () => {
    expect(analysis.documentCount).toBe(4);
    expect(analysis.fields.map((f) => f.name)).toEqual([
      '_id',
      'name',
      'age',
      'tags',
      'address',
      'items',
    ]);
    const age = field(analysis.fields, 'age');
    expect(age.share).toBe(1);
    expect(age.types).toEqual(
      expect.arrayContaining([
        { type: 'int', count: 1 },
        { type: 'long', count: 1 },
        { type: 'null', count: 1 },
        { type: 'double', count: 1 },
      ]),
    );
    const address = field(analysis.fields, 'address');
    expect(address.share).toBe(0.5);
    expect(address.documentValues).toBe(2);
    const zip = field(analysis.fields, 'address.zip');
    expect(zip.path).toBe('address.zip');
    expect(zip.share).toBe(0.25);
    expect(zip.presence).toBe(0.5);
  });

  it('describes array elements with their own paths and lengths', () => {
    const tags = field(analysis.fields, 'tags');
    expect(tags.arrayLengths).toEqual({ min: 0, max: 2, average: 4 / 3 });
    const items = field(analysis.fields, 'tags.[]');
    expect(items.path).toBe('tags[]');
    expect(items.queryPath).toBe('tags');
    expect(items.count).toBe(4);
    expect(items.types.map((t) => t.type).sort()).toEqual(['object', 'string']);
    const sku = field(analysis.fields, 'items.[].sku');
    expect(sku.path).toBe('items[].sku');
    expect(sku.queryPath).toBe('items.sku');
    expect(sku.count).toBe(2);
    expect(sku.documents).toBe(1);
    expect(field(analysis.fields, 'items.[].qty').presence).toBe(0.5);
  });

  it('counts the most common values', () => {
    const name = field(analysis.fields, 'name');
    expect(name.topValues[0]).toEqual({ value: '"Ada"', display: "'Ada'", count: 2 });
    expect(name.topValuesExact).toBe(true);
    expect(name.distinctValues).toBe(3);
  });

  it('stays bounded on many fields and values', () => {
    const analyzer = new SchemaAnalyzer({ maxFields: 50, topValues: 3 });
    for (let i = 0; i < 2000; i++) {
      analyzer.add(parseShellDocument(`{ k${i % 100}: ${i}, v: ${i % 7}, u: ${i} }`));
    }
    const result = analyzer.result();
    expect(result.truncated).toBe(true);
    expect(result.fields.length).toBeLessThanOrEqual(50);
    const v = result.fields.find((f) => f.name === 'v')!;
    expect(v.topValues).toHaveLength(3);
    expect(v.topValuesExact).toBe(true);
    const u = result.fields.find((f) => f.name === 'u')!;
    expect(u.topValuesExact).toBe(false);
    expect(u.distinctValues).toBeUndefined();
    // Space-saving never reports more than it counted for certain.
    for (const entry of u.topValues) expect(entry.count).toBeLessThanOrEqual(1);
  });

  it('caps depth and array elements', () => {
    const deep = parseShellDocument(`{ a: ${'{ a: '.repeat(30)}1${' }'.repeat(30)} }`);
    const result = analyzeSchema(
      [
        deep,
        parseShellDocument(`{ big: [${Array.from({ length: 500 }, (_, i) => i).join(',')}] }`),
      ],
      {
        maxDepth: 5,
        maxArrayItems: 10,
      },
    );
    let node = result.fields[0]!;
    let depth = 1;
    while (node.fields.length > 0) {
      node = node.fields[0]!;
      depth += 1;
    }
    expect(depth).toBe(5);
    expect(result.fields[1]!.items!.count).toBe(10);
  });

  it('exports a $jsonSchema validator', () => {
    const schema = toJsonSchema(analysis);
    expect(schema).toMatchObject({
      bsonType: 'object',
      required: ['_id', 'name', 'age'],
      properties: {
        _id: { bsonType: 'int' },
        name: { bsonType: 'string' },
        tags: { bsonType: 'array', items: { bsonType: ['string', 'object'] } },
        address: {
          bsonType: 'object',
          required: ['city'],
          properties: { city: { bsonType: 'string' }, zip: { bsonType: 'string' } },
        },
        items: { bsonType: 'array', items: { bsonType: 'object', required: ['sku'] } },
      },
    });
    const age = (schema['properties'] as Record<string, { bsonType: string[] }>)['age']!;
    expect([...age.bsonType].sort()).toEqual(['double', 'int', 'long', 'null']);
    // It serialises as Extended JSON for collMod without number wrappers.
    expect(toEjson(schema)).not.toContain('$number');
    expect(toJsonSchema(analysis, { requiredThreshold: 0.5 })['required']).toContain('address');
    expect(toJsonSchema(analysis, { additionalProperties: false })['additionalProperties']).toBe(
      false,
    );
  });

  it('exports standard JSON Schema', () => {
    const schema = toJsonSchema(analysis, { dialect: 'json-schema' });
    expect(schema['$schema']).toContain('json-schema.org');
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['age']).toEqual({ type: expect.arrayContaining(['integer', 'null', 'number']) });
    expect(props['address']).toMatchObject({ type: 'object', required: ['city'] });
    const dated = toJsonSchema(
      analyzeSchema([parseShellDocument("{ d: ISODate('2024-01-01') }")]),
      {
        dialect: 'json-schema',
      },
    );
    expect((dated['properties'] as Record<string, unknown>)['d']).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });
});
