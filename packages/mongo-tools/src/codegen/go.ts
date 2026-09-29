import type { BsonValue } from '../bson';
import { formatDouble } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  collationFields,
  dateParts,
  hasContent,
  layoutList,
  quoteC,
  type ExportTarget,
} from './common';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const HELPERS = {
  objectID: `func objectID(s string) bson.ObjectID {
\tid, err := bson.ObjectIDFromHex(s)
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\treturn id
}`,
  decimal128: `func decimal128(s string) bson.Decimal128 {
\td, err := bson.ParseDecimal128(s)
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\treturn d
}`,
  uuidBinary: `func uuidBinary(s string) bson.Binary {
\tdata, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\treturn bson.Binary{Subtype: 0x04, Data: data}
}`,
} as const;

type Helper = keyof typeof HELPERS;

function byteLiteral(bytes: Uint8Array): string {
  return `[]byte{${Array.from(bytes, (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}}`;
}

/**
 * Go values for the v2 driver: `bson.D` (ordered) for documents, `bson.A` for arrays, the bson
 * package's types for the rest, and small helper functions for values that are parsed from text
 * (ObjectIDs, Decimal128s, UUIDs). Output is gofmt-formatted.
 */
export class GoValues {
  readonly imports = new Set<string>();
  readonly helpers = new Set<Helper>();

  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'nil';
      case 'bool':
        return String(v.value);
      case 'string':
        return quoteC(v.value);
      case 'int32':
        // An untyped int constant is encoded as an Int32 when it fits.
        return String(v.value);
      case 'int64':
        return `int64(${v.value})`;
      case 'double':
        if (Number.isNaN(v.value)) return this.use('math', 'math.NaN()');
        if (v.value === Infinity) return this.use('math', 'math.Inf(1)');
        if (v.value === -Infinity) return this.use('math', 'math.Inf(-1)');
        // Go constants have no negative zero.
        if (Object.is(v.value, -0)) return this.use('math', 'math.Copysign(0, -1)');
        return formatDouble(v.value);
      case 'decimal':
        return this.helper('decimal128', `decimal128("${v.value}")`);
      case 'objectId':
        return this.helper('objectID', `objectID("${v.hex}")`);
      case 'date': {
        const p = dateParts(v.date);
        return this.use(
          'time',
          `time.Date(${p.year}, time.${MONTHS[p.month - 1]}, ${p.day}, ${p.hour}, ${p.minute}, ${p.second}, ${p.millisecond * 1_000_000}, time.UTC)`,
        );
      }
      case 'binary':
        return `bson.Binary{Subtype: 0x${v.subtype.toString(16).padStart(2, '0')}, Data: ${byteLiteral(v.bytes)}}`;
      case 'uuid':
        this.imports.add('encoding/hex');
        this.imports.add('strings');
        return this.helper('uuidBinary', `uuidBinary("${v.uuid}")`);
      case 'regex':
        return v.flags === ''
          ? `bson.Regex{Pattern: ${quoteC(v.pattern)}}`
          : `bson.Regex{Pattern: ${quoteC(v.pattern)}, Options: "${v.flags}"}`;
      case 'timestamp':
        return `bson.Timestamp{T: ${v.t}, I: ${v.i}}`;
      case 'minKey':
        return 'bson.MinKey{}';
      case 'maxKey':
        return 'bson.MaxKey{}';
      case 'symbol':
        return `bson.Symbol(${quoteC(v.value)})`;
      case 'code':
        return v.scope === undefined
          ? `bson.JavaScript(${quoteC(v.code)})`
          : `bson.CodeWithScope{Code: ${quoteC(v.code)}, Scope: ${this.value(v.scope, level, used)}}`;
      case 'dbref': {
        const entries: [string, BsonValue][] = [
          ['$ref', v.collection],
          ['$id', v.id],
        ];
        if (v.db !== undefined) entries.push(['$db', v.db]);
        return this.document(entries, level, used);
      }
      case 'array':
        return layoutList(
          v.items.map((item) => this.value(item, level + 1)),
          { open: 'bson.A{', close: '}', trailingComma: true },
          '\t',
          level,
          used,
        );
      case 'document':
        return this.document(v.entries, level, used);
    }
  }

  document(entries: readonly (readonly [string, BsonValue])[], level: number, used = 0): string {
    if (entries.length === 1) {
      // One field whose value spans lines hugs it: bson.D{{"$match", bson.D{ ... }}}.
      const [key, item] = entries[0]!;
      const prefix = `bson.D{{${quoteC(key)}, `;
      const value = this.value(item, level, used + prefix.length);
      if (value.includes('\n')) return `${prefix}${value}}}`;
    }
    return layoutList(
      entries.map(([key, item]) => {
        const prefix = `{${quoteC(key)}, `;
        return `${prefix}${this.value(item, level + 1, prefix.length)}}`;
      }),
      { open: 'bson.D{', close: '}', trailingComma: true },
      '\t',
      level,
      used,
    );
  }

  private use(pkg: string, text: string): string {
    this.imports.add(pkg);
    return text;
  }

  private helper(name: Helper, text: string): string {
    this.helpers.add(name);
    return text;
  }
}

function goCollation(fields: Map<string, string | number | boolean>): string {
  const parts: string[] = [];
  for (const [name, value] of fields) {
    const field = name[0]!.toUpperCase() + name.slice(1);
    parts.push(`${field}: ${typeof value === 'string' ? quoteC(value) : String(value)}`);
  }
  return `&options.Collation{${parts.join(', ')}}`;
}

/** A complete Go program that runs the query with the v2 driver. */
export function goProgram(target: ExportTarget, database: string): string {
  const values = new GoValues();
  const body: string[] = [];
  const assign = (name: string, value: BsonValue): void => {
    const prefix = `${name} := `;
    body.push(`\t${prefix}${values.value(value, 1, prefix.length)}`);
  };
  let contextSetup = '\tctx := context.Background()';
  let call: string;
  if (target.kind === 'find') {
    const { query } = target;
    assign('filter', query.filter);
    const setters: string[] = [];
    if (hasContent(query.projection)) {
      assign('projection', query.projection);
      setters.push('SetProjection(projection)');
    }
    if (hasContent(query.sort)) {
      assign('sort', query.sort);
      setters.push('SetSort(sort)');
    }
    if (query.skip !== undefined && query.skip > 0) setters.push(`SetSkip(${query.skip})`);
    if (query.limit !== undefined && query.limit > 0) setters.push(`SetLimit(${query.limit})`);
    if (hasContent(query.collation)) {
      setters.push(`SetCollation(${goCollation(collationFields(query.collation))})`);
    }
    if (query.hint !== undefined) {
      setters.push(
        `SetHint(${typeof query.hint === 'string' ? quoteC(query.hint) : values.value(query.hint, 2)})`,
      );
    }
    if (query.maxTimeMS !== undefined) {
      // The v2 driver takes time limits from the context.
      values.imports.add('time');
      contextSetup = `\tctx, cancel := context.WithTimeout(context.Background(), ${query.maxTimeMS}*time.Millisecond)\n\tdefer cancel()`;
    }
    if (setters.length > 0) {
      const inline = `\topts := options.Find().${setters.join('.')}`;
      body.push(
        inline.length <= 100 && !inline.includes('\n')
          ? inline
          : `\topts := options.Find().\n${setters.map((s) => `\t\t${s}`).join('.\n')}`,
      );
      call = 'collection.Find(ctx, filter, opts)';
    } else {
      call = 'collection.Find(ctx, filter)';
    }
  } else {
    body.push(
      `\tpipeline := ${layoutList(
        target.pipeline.map((stage) => values.value(stage, 2)),
        { open: 'mongo.Pipeline{', close: '}', trailingComma: true },
        '\t',
        1,
        'pipeline := '.length,
      )}`,
    );
    call = 'collection.Aggregate(ctx, pipeline)';
  }
  if (values.helpers.size > 0) values.imports.add('log');
  const stdlib = [...new Set(['context', 'fmt', 'log', 'os', ...values.imports])].sort();
  const helpers = [...values.helpers].sort().map((name) => `\n${HELPERS[name]}\n`);
  return `// go get go.mongodb.org/mongo-driver/v2/mongo
// Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}

package main

import (
${stdlib.map((pkg) => `\t"${pkg}"`).join('\n')}

\t"go.mongodb.org/mongo-driver/v2/bson"
\t"go.mongodb.org/mongo-driver/v2/mongo"
\t"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func main() {
\turi := os.Getenv("${URI_VARIABLE}")
\tif uri == "" {
\t\tlog.Fatal("Set the ${URI_VARIABLE} environment variable")
\t}
\tclient, err := mongo.Connect(options.Client().ApplyURI(uri))
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\tdefer func() {
\t\tif err := client.Disconnect(context.Background()); err != nil {
\t\t\tlog.Fatal(err)
\t\t}
\t}()

${contextSetup}
\tcollection := client.Database(${quoteC(database)}).Collection(${quoteC(target.collection)})
${body.join('\n')}
\tcursor, err := ${call}
\tif err != nil {
\t\tlog.Fatal(err)
\t}
\tdefer cursor.Close(ctx)
\tfor cursor.Next(ctx) {
\t\tvar document bson.D
\t\tif err := cursor.Decode(&document); err != nil {
\t\t\tlog.Fatal(err)
\t\t}
\t\ttext, err := bson.MarshalExtJSON(document, false, false)
\t\tif err != nil {
\t\t\tlog.Fatal(err)
\t\t}
\t\tfmt.Println(string(text))
\t}
\tif err := cursor.Err(); err != nil {
\t\tlog.Fatal(err)
\t}
}
${helpers.join('')}`;
}
