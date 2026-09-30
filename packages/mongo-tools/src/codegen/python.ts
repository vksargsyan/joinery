import type { BsonDocument, BsonValue } from '../bson';
import { formatDouble } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  dateParts,
  hasContent,
  hex4,
  layoutList,
  quoteString,
  type ExportTarget,
} from './common';

/** A Python string literal in double quotes, as black writes them. */
export function quotePython(value: string): string {
  return quoteString(
    value,
    '"',
    { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' },
    (code) => (code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${hex4(code)}`),
  );
}

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Python values for PyMongo: dicts keep key order, the bson package supplies BSON types. */
export class PythonValues {
  /** `module → names` to import. */
  readonly imports = new Map<string, Set<string>>();
  private readonly indent = '    ';

  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'None';
      case 'bool':
        return v.value ? 'True' : 'False';
      case 'string':
      case 'symbol':
        // PyMongo has no Symbol type: a symbol is written as a string.
        return quotePython(v.value);
      case 'int32':
        return String(v.value);
      case 'int64':
        return this.use('bson', 'Int64', `Int64(${v.value})`);
      case 'double':
        if (Number.isNaN(v.value)) return 'float("nan")';
        if (v.value === Infinity) return 'float("inf")';
        if (v.value === -Infinity) return 'float("-inf")';
        return formatDouble(v.value);
      case 'decimal':
        return this.use('bson', 'Decimal128', `Decimal128("${v.value}")`);
      case 'objectId':
        return this.use('bson', 'ObjectId', `ObjectId("${v.hex}")`);
      case 'date': {
        const p = dateParts(v.date);
        if (p.year < 1 || p.year > 9999) {
          // Outside Python's datetime range.
          return this.use('bson', 'DatetimeMS', `DatetimeMS(${v.date.getTime()})`);
        }
        const parts = [p.year, p.month, p.day, p.hour, p.minute, p.second, p.millisecond * 1000];
        while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
        this.use('datetime', 'timezone', '');
        return this.use(
          'datetime',
          'datetime',
          `datetime(${parts.join(', ')}, tzinfo=timezone.utc)`,
        );
      }
      case 'binary':
        return this.use(
          'bson',
          'Binary',
          `Binary(bytes.fromhex("${hexBytes(v.bytes)}"), ${v.subtype})`,
        );
      case 'uuid':
        this.use('uuid', 'UUID', '');
        return this.use('bson', 'Binary', `Binary.from_uuid(UUID("${v.uuid}"))`);
      case 'regex':
        return this.use(
          'bson',
          'Regex',
          v.flags === ''
            ? `Regex(${quotePython(v.pattern)})`
            : `Regex(${quotePython(v.pattern)}, "${v.flags}")`,
        );
      case 'timestamp':
        return this.use('bson', 'Timestamp', `Timestamp(${v.t}, ${v.i})`);
      case 'minKey':
        return this.use('bson', 'MinKey', 'MinKey()');
      case 'maxKey':
        return this.use('bson', 'MaxKey', 'MaxKey()');
      case 'code':
        return this.use(
          'bson',
          'Code',
          v.scope === undefined
            ? `Code(${quotePython(v.code)})`
            : `Code(${quotePython(v.code)}, ${this.value(v.scope, level, used)})`,
        );
      case 'dbref': {
        const args = [quotePython(v.collection), this.value(v.id, level, used)];
        if (v.db !== undefined) args.push(quotePython(v.db));
        return this.use('bson', 'DBRef', `DBRef(${args.join(', ')})`);
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
            const prefix = `${quotePython(key)}: `;
            return prefix + this.value(item, level + 1, prefix.length);
          }),
          { open: '{', close: '}', trailingComma: true },
          this.indent,
          level,
          used,
        );
    }
  }

  /** A document as `[(key, value), ...]` pairs, the form PyMongo's `sort` and `hint` take. */
  pairs(doc: BsonDocument, level: number, used = 0): string {
    return layoutList(
      Object.entries(doc).map(([key, item]) => {
        const prefix = `(${quotePython(key)}, `;
        return `${prefix}${this.value(item, level + 1, prefix.length)})`;
      }),
      { open: '[', close: ']', trailingComma: true },
      this.indent,
      level,
      used,
    );
  }

  private use(module: string, name: string, text: string): string {
    let names = this.imports.get(module);
    if (!names) this.imports.set(module, (names = new Set()));
    names.add(name);
    return text;
  }
}

/** A complete Python script that runs the query with PyMongo. */
export function pythonProgram(target: ExportTarget, database: string): string {
  const values = new PythonValues();
  const body: string[] = [];
  const assign = (name: string, text: string): void => {
    body.push(`    ${name} = ${text}`);
  };
  let call: string;
  if (target.kind === 'find') {
    const { query } = target;
    assign('query_filter', values.value(query.filter, 1, 'query_filter = '.length));
    const args = ['query_filter'];
    if (hasContent(query.projection)) {
      assign('projection', values.value(query.projection, 1, 'projection = '.length));
      args.push('projection');
    }
    if (hasContent(query.sort)) args.push(`sort=${values.pairs(query.sort, 2, 5)}`);
    if (query.skip !== undefined && query.skip > 0) args.push(`skip=${query.skip}`);
    if (query.limit !== undefined && query.limit > 0) args.push(`limit=${query.limit}`);
    if (hasContent(query.collation)) args.push(`collation=${values.value(query.collation, 2, 10)}`);
    if (query.hint !== undefined) {
      args.push(
        `hint=${typeof query.hint === 'string' ? quotePython(query.hint) : values.pairs(query.hint, 2, 5)}`,
      );
    }
    if (query.maxTimeMS !== undefined) args.push(`max_time_ms=${query.maxTimeMS}`);
    call = layoutList(
      args,
      { open: 'collection.find(', close: ')', trailingComma: true },
      '    ',
      1,
      20,
    );
  } else {
    assign('pipeline', values.value([...target.pipeline], 1, 'pipeline = '.length));
    call = 'collection.aggregate(pipeline)';
  }
  const stdlib = ['import os'];
  const thirdParty: string[] = [];
  for (const module of [...values.imports.keys()].sort()) {
    const names = [...values.imports.get(module)!].sort();
    let line = `from ${module} import ${names.join(', ')}`;
    if (line.length > 88) {
      line = `from ${module} import (\n${names.map((name) => `    ${name},`).join('\n')}\n)`;
    }
    if (module === 'bson') thirdParty.push(line);
    else stdlib.push(line);
  }
  thirdParty.push('from pymongo import MongoClient');
  // Dates outside datetime's range need DatetimeMS in results too, or decoding them fails.
  const client = values.imports.get('bson')?.has('DatetimeMS')
    ? `os.environ["${URI_VARIABLE}"], datetime_conversion="DATETIME_AUTO"`
    : `os.environ["${URI_VARIABLE}"]`;
  return `# pip install pymongo
# Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}
${stdlib.join('\n')}

${thirdParty.join('\n')}

with MongoClient(${client}) as client:
    collection = client[${quotePython(database)}][${quotePython(target.collection)}]
${body.join('\n')}
    for document in ${call}:
        print(document)
`;
}
