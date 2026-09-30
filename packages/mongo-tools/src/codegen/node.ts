import type { BsonDocument, BsonValue } from '../bson';
import { formatDouble, formatKey, quoteShellString } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  hasContent,
  layoutList,
  type ExportTarget,
} from './common';

/** Node.js values for the official `mongodb` driver, which re-exports the bson classes. */
export class NodeValues {
  /** Classes the program takes from the `mongodb` package. */
  readonly imports = new Set<string>();
  private readonly indent = '  ';

  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'null';
      case 'bool':
        return String(v.value);
      case 'string':
        return quoteShellString(v.value);
      case 'int32':
        return String(v.value);
      case 'int64':
        return this.use('Long', `Long.fromString('${v.value}')`);
      case 'double':
        // A JS number is an Int32 to the driver when it is integral: keep Doubles explicit.
        if (Number.isFinite(v.value) && !Number.isInteger(v.value)) return String(v.value);
        if (Number.isNaN(v.value)) return 'NaN';
        if (v.value === Infinity) return 'Infinity';
        if (v.value === -Infinity) return '-Infinity';
        return this.use('Double', `new Double(${formatDouble(v.value).replace(/\.0$/, '')})`);
      case 'decimal':
        return this.use('Decimal128', `Decimal128.fromString('${v.value}')`);
      case 'objectId':
        return this.use('ObjectId', `new ObjectId('${v.hex}')`);
      case 'date':
        return `new Date('${v.date.toISOString()}')`;
      case 'binary':
        return this.use('Binary', `Binary.createFromBase64('${v.base64}', ${v.subtype})`);
      case 'uuid':
        return this.use('UUID', `new UUID('${v.uuid}')`);
      case 'regex':
        return this.regex(v.pattern, v.flags);
      case 'timestamp':
        return this.use('Timestamp', `new Timestamp({ t: ${v.t}, i: ${v.i} })`);
      case 'minKey':
        return this.use('MinKey', 'new MinKey()');
      case 'maxKey':
        return this.use('MaxKey', 'new MaxKey()');
      case 'symbol':
        return this.use('BSONSymbol', `new BSONSymbol(${quoteShellString(v.value)})`);
      case 'code':
        return this.use(
          'Code',
          v.scope === undefined
            ? `new Code(${quoteShellString(v.code)})`
            : `new Code(${quoteShellString(v.code)}, ${this.value(v.scope, level, used)})`,
        );
      case 'dbref': {
        const args = [quoteShellString(v.collection), this.value(v.id, level, used)];
        if (v.db !== undefined) args.push(quoteShellString(v.db));
        return this.use('DBRef', `new DBRef(${args.join(', ')})`);
      }
      case 'array':
        return layoutList(
          v.items.map((item) => this.value(item, level + 1)),
          { open: '[', close: ']', trailingComma: true },
          this.indent,
          level,
          used,
        );
      case 'document':
        return layoutList(
          v.entries.map(([key, item]) => {
            const prefix = `${nodeKey(key)}: `;
            return prefix + this.value(item, level + 1, prefix.length);
          }),
          { open: '{', close: '}', pad: true, trailingComma: true },
          this.indent,
          level,
          used,
        );
    }
  }

  /**
   * A regex literal when the driver sends it unchanged (it maps only the i and m flags, and the
   * pattern must read back as the same source), else a BSONRegExp.
   */
  private regex(pattern: string, flags: string): string {
    if (/^[im]*$/.test(flags)) {
      try {
        if (new RegExp(pattern, flags).source === pattern) return `/${pattern}/${flags}`;
      } catch {
        // Not JavaScript regex syntax: fall through.
      }
    }
    return this.use(
      'BSONRegExp',
      `new BSONRegExp(${quoteShellString(pattern)}, ${quoteShellString(flags)})`,
    );
  }

  private use(name: string, text: string): string {
    this.imports.add(name);
    return text;
  }
}

/** An object key: bare when it is an identifier; `__proto__` needs a computed key. */
function nodeKey(key: string): string {
  return key === '__proto__' ? "['__proto__']" : formatKey(key);
}

/** A complete Node.js script that runs the query with the `mongodb` driver. */
export function nodeProgram(target: ExportTarget, database: string): string {
  const values = new NodeValues();
  const body: string[] = [];
  const statement = (name: string, value: BsonValue): void => {
    const prefix = `    const ${name} = `;
    body.push(`${prefix}${values.value(value, 2, prefix.length - 4)};`);
  };
  let call: string;
  if (target.kind === 'find') {
    const { query } = target;
    statement('filter', query.filter);
    const options: BsonDocument = {};
    if (hasContent(query.projection)) options['projection'] = query.projection;
    if (hasContent(query.sort)) options['sort'] = query.sort;
    if (query.skip !== undefined && query.skip > 0) options['skip'] = query.skip;
    if (query.limit !== undefined && query.limit > 0) options['limit'] = query.limit;
    if (hasContent(query.collation)) options['collation'] = query.collation;
    if (query.hint !== undefined) options['hint'] = query.hint;
    if (query.maxTimeMS !== undefined) options['maxTimeMS'] = query.maxTimeMS;
    if (Object.keys(options).length > 0) {
      statement('options', options);
      call = 'collection.find(filter, options)';
    } else {
      call = 'collection.find(filter)';
    }
  } else {
    statement('pipeline', [...target.pipeline]);
    call = 'collection.aggregate(pipeline)';
  }
  const names = ['MongoClient', ...[...values.imports].sort()];
  const inline = `const { ${names.join(', ')} } = require('mongodb');`;
  const imports =
    inline.length <= 80
      ? inline
      : `const {\n${names.map((name) => `  ${name},`).join('\n')}\n} = require('mongodb');`;
  return `// npm install mongodb
// Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}
${imports}

async function main() {
  const uri = process.env.${URI_VARIABLE};
  if (!uri) throw new Error('Set the ${URI_VARIABLE} environment variable');
  const client = new MongoClient(uri);
  try {
    const collection = client.db(${quoteShellString(database)}).collection(${quoteShellString(target.collection)});
${body.join('\n')}
    for await (const document of ${call}) {
      console.log(document);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
}
