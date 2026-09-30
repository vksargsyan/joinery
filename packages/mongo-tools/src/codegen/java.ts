import type { BsonDocument, BsonValue } from '../bson';
import { formatDouble } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  collationFields,
  fitsInt32,
  hasContent,
  indentWidth,
  layoutList,
  quoteC,
  timestampLong,
  type ExportTarget,
} from './common';

const INDENT = '    ';

/**
 * Java values for the sync driver with `org.bson.Document`: documents are
 * `new Document(k, v).append(k, v)` chains, arrays `Arrays.asList(...)`, and the other BSON
 * types their `org.bson` classes (UUIDs as standard subtype-4 `BsonBinary`).
 */
export class JavaValues {
  /** Fully qualified names to import. */
  readonly imports = new Set<string>();

  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'null';
      case 'bool':
        return String(v.value);
      case 'string':
        return quoteC(v.value);
      case 'int32':
        return String(v.value);
      case 'int64':
        return `${v.value}L`;
      case 'double':
        if (Number.isNaN(v.value)) return 'Double.NaN';
        if (v.value === Infinity) return 'Double.POSITIVE_INFINITY';
        if (v.value === -Infinity) return 'Double.NEGATIVE_INFINITY';
        return formatDouble(v.value);
      case 'decimal':
        return this.use('org.bson.types.Decimal128', `Decimal128.parse("${v.value}")`);
      case 'objectId':
        return this.use('org.bson.types.ObjectId', `new ObjectId("${v.hex}")`);
      case 'date': {
        const iso = v.date.toISOString();
        this.use('java.util.Date', '');
        if (/^\d{4}-/.test(iso)) {
          return this.use('java.time.Instant', `Date.from(Instant.parse("${iso}"))`);
        }
        return `new Date(${v.date.getTime()}L)`;
      }
      case 'binary':
        this.use('java.util.Base64', '');
        return this.use(
          'org.bson.types.Binary',
          `new Binary((byte) 0x${v.subtype.toString(16).padStart(2, '0')}, Base64.getDecoder().decode("${v.base64}"))`,
        );
      case 'uuid':
        this.use('java.util.UUID', '');
        return this.use('org.bson.BsonBinary', `new BsonBinary(UUID.fromString("${v.uuid}"))`);
      case 'regex':
        return this.use(
          'org.bson.BsonRegularExpression',
          v.flags === ''
            ? `new BsonRegularExpression(${quoteC(v.pattern)})`
            : `new BsonRegularExpression(${quoteC(v.pattern)}, "${v.flags}")`,
        );
      case 'timestamp':
        return this.use(
          'org.bson.BsonTimestamp',
          fitsInt32(v.t) && fitsInt32(v.i)
            ? `new BsonTimestamp(${v.t}, ${v.i})`
            : `new BsonTimestamp(${timestampLong(v.t, v.i)}L)`,
        );
      case 'minKey':
        return this.use('org.bson.types.MinKey', 'new MinKey()');
      case 'maxKey':
        return this.use('org.bson.types.MaxKey', 'new MaxKey()');
      case 'symbol':
        return this.use('org.bson.types.Symbol', `new Symbol(${quoteC(v.value)})`);
      case 'code':
        if (v.scope === undefined)
          return this.use('org.bson.types.Code', `new Code(${quoteC(v.code)})`);
        return this.use(
          'org.bson.types.CodeWithScope',
          `new CodeWithScope(${quoteC(v.code)}, ${this.document(Object.entries(v.scope), level, used)})`,
        );
      case 'dbref': {
        const id = this.value(v.id, level, used);
        return this.use(
          'com.mongodb.DBRef',
          v.db === undefined
            ? `new DBRef(${quoteC(v.collection)}, ${id})`
            : `new DBRef(${quoteC(v.db)}, ${quoteC(v.collection)}, ${id})`,
        );
      }
      case 'array': {
        this.use('java.util.Arrays', '');
        const items = v.items.map((item) => this.value(item, level + 1));
        // A lone null would be taken as the varargs array itself.
        if (items.length === 1 && items[0] === 'null') return 'Arrays.asList((Object) null)';
        return layoutList(items, { open: 'Arrays.asList(', close: ')' }, INDENT, level, used);
      }
      case 'document':
        return this.document(v.entries, level, used);
    }
  }

  /** `new Document("a", 1).append("b", 2)`, one `.append` per line when it does not fit. */
  document(entries: readonly (readonly [string, BsonValue])[], level: number, used = 0): string {
    this.imports.add('org.bson.Document');
    if (entries.length === 0) return 'new Document()';
    const parts = entries.map(([key, item], i) => {
      const prefix = i === 0 ? `new Document(${quoteC(key)}, ` : `.append(${quoteC(key)}, `;
      return `${prefix}${this.value(item, level + 1, prefix.length)})`;
    });
    const inline = parts.join('');
    if (!inline.includes('\n') && indentWidth(INDENT) * level + used + inline.length <= 90) {
      return inline;
    }
    const inner = INDENT.repeat(level + 1);
    return (
      parts[0]! +
      parts
        .slice(1)
        .map((part) => `\n${inner}${part}`)
        .join('')
    );
  }

  private use(name: string, text: string): string {
    this.imports.add(name);
    return text;
  }
}

function collationBuilder(collation: BsonDocument, imports: Set<string>): string {
  imports.add('com.mongodb.client.model.Collation');
  let text = 'Collation.builder()';
  for (const [name, value] of collationFields(collation)) {
    switch (name) {
      case 'locale':
        text += `.locale(${quoteC(String(value))})`;
        break;
      case 'caseLevel':
      case 'numericOrdering':
      case 'normalization':
      case 'backwards':
        text += `.${name}(${Boolean(value)})`;
        break;
      case 'strength':
        imports.add('com.mongodb.client.model.CollationStrength');
        text += `.collationStrength(CollationStrength.fromInt(${Number(value)}))`;
        break;
      case 'caseFirst':
        imports.add('com.mongodb.client.model.CollationCaseFirst');
        text += `.collationCaseFirst(CollationCaseFirst.fromString(${quoteC(String(value))}))`;
        break;
      case 'alternate':
        imports.add('com.mongodb.client.model.CollationAlternate');
        text += `.collationAlternate(CollationAlternate.fromString(${quoteC(String(value))}))`;
        break;
      case 'maxVariable':
        imports.add('com.mongodb.client.model.CollationMaxVariable');
        text += `.collationMaxVariable(CollationMaxVariable.fromString(${quoteC(String(value))}))`;
        break;
    }
  }
  return `${text}.build()`;
}

/** A complete Java program (class `Query`) that runs the query with the sync driver. */
export function javaProgram(target: ExportTarget, database: string): string {
  const values = new JavaValues();
  const imports = values.imports;
  imports.add('com.mongodb.client.MongoClient');
  imports.add('com.mongodb.client.MongoClients');
  imports.add('com.mongodb.client.MongoCollection');
  imports.add('org.bson.Document');
  const pad = INDENT.repeat(3);
  const body: string[] = [];
  const declare = (type: string, name: string, value: BsonValue | BsonDocument): void => {
    const prefix = `${type} ${name} = `;
    body.push(`${pad}${prefix}${values.value(value, 3, prefix.length)};`);
  };
  let iterable: string;
  if (target.kind === 'find') {
    const { query } = target;
    imports.add('com.mongodb.client.FindIterable');
    declare('Document', 'filter', query.filter);
    const chain: string[] = [];
    if (hasContent(query.projection)) {
      declare('Document', 'projection', query.projection);
      chain.push('.projection(projection)');
    }
    if (hasContent(query.sort)) {
      declare('Document', 'sort', query.sort);
      chain.push('.sort(sort)');
    }
    if (query.skip !== undefined && query.skip > 0) chain.push(`.skip(${query.skip})`);
    if (query.limit !== undefined && query.limit > 0) chain.push(`.limit(${query.limit})`);
    if (hasContent(query.collation))
      chain.push(`.collation(${collationBuilder(query.collation, imports)})`);
    if (query.hint !== undefined) {
      chain.push(
        typeof query.hint === 'string'
          ? `.hintString(${quoteC(query.hint)})`
          : `.hint(${values.value(query.hint, 5)})`,
      );
    }
    if (query.maxTimeMS !== undefined) {
      imports.add('java.util.concurrent.TimeUnit');
      chain.push(`.maxTime(${query.maxTimeMS}, TimeUnit.MILLISECONDS)`);
    }
    const head = `${pad}FindIterable<Document> results = collection.find(filter)`;
    const oneLine = head + chain.join('') + ';';
    body.push(
      oneLine.length <= 100 && !oneLine.includes('\n')
        ? oneLine
        : head + chain.map((call) => `\n${pad}${INDENT}${INDENT}${call}`).join('') + ';',
    );
    iterable = 'results';
  } else {
    imports.add('com.mongodb.client.AggregateIterable');
    imports.add('java.util.List');
    declare('List<Document>', 'pipeline', [...target.pipeline]);
    body.push(`${pad}AggregateIterable<Document> results = collection.aggregate(pipeline);`);
    iterable = 'results';
  }
  const sorted = [...imports]
    .filter((name) => name !== '')
    .sort((a, b) => {
      // java.* after the others, as IDEs order them.
      const group = (name: string) => (name.startsWith('java.') ? 1 : 0);
      return group(a) - group(b) || a.localeCompare(b);
    });
  const importLines: string[] = [];
  let previous: number | undefined;
  for (const name of sorted) {
    const group = name.startsWith('java.') ? 1 : 0;
    if (previous !== undefined && group !== previous) importLines.push('');
    importLines.push(`import ${name};`);
    previous = group;
  }
  return `// Maven: org.mongodb:mongodb-driver-sync
// Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}
${importLines.join('\n')}

public class Query {
    public static void main(String[] args) {
        String uri = System.getenv("${URI_VARIABLE}");
        if (uri == null) {
            throw new IllegalStateException("Set the ${URI_VARIABLE} environment variable");
        }
        try (MongoClient client = MongoClients.create(uri)) {
            MongoCollection<Document> collection = client.getDatabase(${quoteC(database)}).getCollection(${quoteC(target.collection)});
${body.join('\n')}
            for (Document document : ${iterable}) {
                // The collection's codecs also cover DBRef, which Document.toJson() alone lacks.
                System.out.println(document.toJson(collection.getCodecRegistry().get(Document.class)));
            }
        }
    }
}
`;
}
