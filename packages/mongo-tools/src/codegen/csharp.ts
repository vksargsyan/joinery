import type { BsonValue } from '../bson';
import { formatDouble } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  dateParts,
  fitsInt32,
  hasContent,
  layoutList,
  quoteC,
  timestampLong,
  type ExportTarget,
} from './common';

const INDENT = '    ';

const SUBTYPES: Readonly<Record<number, string>> = {
  0: 'BsonBinarySubType.Binary',
  1: 'BsonBinarySubType.Function',
  2: 'BsonBinarySubType.OldBinary',
  3: 'BsonBinarySubType.UuidLegacy',
  4: 'BsonBinarySubType.UuidStandard',
  5: 'BsonBinarySubType.MD5',
};

/**
 * C# values for MongoDB.Driver with `BsonDocument`: collection initializers for documents and
 * arrays, implicit conversions for strings, numbers, booleans, ObjectIds and DateTimes, and the
 * `Bson*` classes for the rest.
 */
export class CSharpValues {
  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'BsonNull.Value';
      case 'bool':
        return String(v.value);
      case 'string':
        return quoteC(v.value);
      case 'int32':
        return String(v.value);
      case 'int64':
        return `${v.value}L`;
      case 'double':
        if (Number.isNaN(v.value)) return 'double.NaN';
        if (v.value === Infinity) return 'double.PositiveInfinity';
        if (v.value === -Infinity) return 'double.NegativeInfinity';
        // The implicit double conversion reuses a cached 0.0 for -0.0.
        if (Object.is(v.value, -0)) return 'new BsonDouble(-0.0)';
        return formatDouble(v.value);
      case 'decimal':
        return `new BsonDecimal128(Decimal128.Parse("${v.value}"))`;
      case 'objectId':
        return `new ObjectId("${v.hex}")`;
      case 'date': {
        const p = dateParts(v.date);
        if (p.year < 1 || p.year > 9999) return `new BsonDateTime(${v.date.getTime()})`;
        const parts = [p.year, p.month, p.day, p.hour, p.minute, p.second];
        if (p.millisecond > 0) parts.push(p.millisecond);
        return `new DateTime(${parts.join(', ')}, DateTimeKind.Utc)`;
      }
      case 'binary': {
        const subtype =
          SUBTYPES[v.subtype] ?? `(BsonBinarySubType)0x${v.subtype.toString(16).padStart(2, '0')}`;
        return `new BsonBinaryData(Convert.FromBase64String("${v.base64}"), ${subtype})`;
      }
      case 'uuid':
        return `new BsonBinaryData(Guid.Parse("${v.uuid}"), GuidRepresentation.Standard)`;
      case 'regex':
        return v.flags === ''
          ? `new BsonRegularExpression(${quoteC(v.pattern)})`
          : `new BsonRegularExpression(${quoteC(v.pattern)}, "${v.flags}")`;
      case 'timestamp':
        return fitsInt32(v.t) && fitsInt32(v.i)
          ? `new BsonTimestamp(${v.t}, ${v.i})`
          : `new BsonTimestamp(${timestampLong(v.t, v.i)}L)`;
      case 'minKey':
        return 'BsonMinKey.Value';
      case 'maxKey':
        return 'BsonMaxKey.Value';
      case 'symbol':
        return `BsonSymbolTable.Lookup(${quoteC(v.value)})`;
      case 'code':
        return v.scope === undefined
          ? `new BsonJavaScript(${quoteC(v.code)})`
          : `new BsonJavaScriptWithScope(${quoteC(v.code)}, ${this.document(Object.entries(v.scope), level, used)})`;
      case 'dbref': {
        // The driver has no DBRef class for BsonDocument: write the document form.
        const entries: [string, BsonValue][] = [
          ['$ref', v.collection],
          ['$id', v.id],
        ];
        if (v.db !== undefined) entries.push(['$db', v.db]);
        return this.document(entries, level, used);
      }
      case 'array':
        if (v.items.length === 0) return 'new BsonArray()';
        return layoutList(
          v.items.map((item) => this.value(item, level + 1)),
          {
            open: 'new BsonArray {',
            openMultiline: `new BsonArray\n${INDENT.repeat(level)}{`,
            close: '}',
            pad: true,
            trailingComma: true,
          },
          INDENT,
          level,
          used,
        );
      case 'document':
        return this.document(v.entries, level, used);
    }
  }

  /** `new BsonDocument("k", v)` for one field, a collection initializer for more. */
  document(entries: readonly (readonly [string, BsonValue])[], level: number, used = 0): string {
    if (entries.length === 0) return 'new BsonDocument()';
    if (entries.length === 1) {
      const [key, item] = entries[0]!;
      const prefix = `new BsonDocument(${quoteC(key)}, `;
      return `${prefix}${this.value(item, level, used + prefix.length)})`;
    }
    return layoutList(
      entries.map(([key, item]) => {
        const prefix = `{ ${quoteC(key)}, `;
        return `${prefix}${this.value(item, level + 1, prefix.length)} }`;
      }),
      {
        open: 'new BsonDocument {',
        openMultiline: `new BsonDocument\n${INDENT.repeat(level)}{`,
        close: '}',
        pad: true,
        trailingComma: true,
      },
      INDENT,
      level,
      used,
    );
  }
}

/** A complete C# program (top-level statements) that runs the query with MongoDB.Driver. */
export function csharpProgram(target: ExportTarget, database: string): string {
  const values = new CSharpValues();
  const body: string[] = [];
  const declare = (name: string, value: BsonValue): void => {
    const prefix = `var ${name} = `;
    body.push(`${prefix}${values.value(value, 0, prefix.length)};`);
  };
  let documents: string;
  if (target.kind === 'find') {
    const { query } = target;
    declare('filter', query.filter);
    const options: string[] = [];
    if (hasContent(query.collation)) {
      options.push(
        `Collation = Collation.FromBsonDocument(${values.value(query.collation, 1, 36)})`,
      );
    }
    if (query.hint !== undefined) options.push(`Hint = ${values.value(query.hint, 1, 7)}`);
    if (query.maxTimeMS !== undefined) {
      options.push(`MaxTime = TimeSpan.FromMilliseconds(${query.maxTimeMS})`);
    }
    if (options.length > 0) {
      body.push(
        `var options = new FindOptions\n{\n${options.map((o) => `${INDENT}${o},`).join('\n')}\n};`,
      );
    }
    let find = options.length > 0 ? 'collection.Find(filter, options)' : 'collection.Find(filter)';
    const chain: string[] = [];
    if (hasContent(query.projection)) {
      declare('projection', query.projection);
      chain.push('.Project(projection)');
    }
    if (hasContent(query.sort)) {
      declare('sort', query.sort);
      chain.push('.Sort(sort)');
    }
    if (query.skip !== undefined && query.skip > 0) chain.push(`.Skip(${query.skip})`);
    if (query.limit !== undefined && query.limit > 0) chain.push(`.Limit(${query.limit})`);
    find += chain.join('');
    body.push(`var cursor = ${find};`);
    documents = 'cursor.ToEnumerable()';
  } else {
    body.push(
      `var pipeline = ${layoutList(
        target.pipeline.map((stage) => values.value(stage, 1)),
        {
          open: 'new BsonDocument[] {',
          openMultiline: 'new BsonDocument[]\n{',
          close: '}',
          pad: true,
          trailingComma: true,
        },
        INDENT,
        0,
        'var pipeline = '.length,
      )};`,
    );
    documents = 'collection.Aggregate<BsonDocument>(pipeline).ToEnumerable()';
  }
  return `// dotnet add package MongoDB.Driver
// Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}
using System;
using MongoDB.Bson;
using MongoDB.Driver;

var uri = Environment.GetEnvironmentVariable("${URI_VARIABLE}")
    ?? throw new InvalidOperationException("Set the ${URI_VARIABLE} environment variable");
var client = new MongoClient(uri);
var collection = client.GetDatabase(${quoteC(database)}).GetCollection<BsonDocument>(${quoteC(target.collection)});

${body.join('\n')}
foreach (var document in ${documents})
{
    Console.WriteLine(document);
}
`;
}
