import type { BsonDocument, BsonValue } from '../bson';
import { formatDouble } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  hasContent,
  layoutList,
  needsEscape,
  wellFormed,
  type ExportTarget,
} from './common';

const INDENT = '    ';
const INT64_MIN = -9223372036854775808n;

/**
 * A PHP string literal: single-quoted (nothing is interpolated, so `$gt` stays as it is) unless
 * it holds control characters, which only double quotes can escape.
 */
export function quotePhp(value: string): string {
  const text = wellFormed(value);
  if (![...text].some((c) => needsEscape(c.codePointAt(0)!))) {
    return `'${text.replace(/[\\']/g, (c) => `\\${c}`)}'`;
  }
  let out = '"';
  for (const c of text) {
    const code = c.codePointAt(0)!;
    if (c === '\\' || c === '"' || c === '$') out += `\\${c}`;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (needsEscape(code)) out += `\\u{${code.toString(16)}}`;
    else out += c;
  }
  return `${out}"`;
}

/**
 * PHP values for the `mongodb/mongodb` library: documents are associative arrays (cast to
 * objects when PHP would otherwise encode them as BSON arrays: empty, or keys 0..n-1), arrays
 * are lists, and the other BSON types are `MongoDB\BSON` classes.
 */
export class PhpValues {
  /** Classes to import with `use`. */
  readonly imports = new Set<string>();

  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'null';
      case 'bool':
        return String(v.value);
      case 'string':
      case 'symbol':
        // The extension cannot create Symbols: a symbol is written as a string.
        return quotePhp(v.value);
      case 'int32':
        return String(v.value);
      case 'int64':
        return this.use(
          'MongoDB\\BSON\\Int64',
          v.value === INT64_MIN ? 'new Int64(PHP_INT_MIN)' : `new Int64(${v.value})`,
        );
      case 'double':
        if (Number.isNaN(v.value)) return 'NAN';
        if (v.value === Infinity) return 'INF';
        if (v.value === -Infinity) return '-INF';
        return formatDouble(v.value);
      case 'decimal':
        return this.use('MongoDB\\BSON\\Decimal128', `new Decimal128('${v.value}')`);
      case 'objectId':
        return this.use('MongoDB\\BSON\\ObjectId', `new ObjectId('${v.hex}')`);
      case 'date': {
        const iso = v.date.toISOString();
        this.imports.add('MongoDB\\BSON\\UTCDateTime');
        return /^\d{4}-/.test(iso)
          ? `new UTCDateTime(new DateTimeImmutable('${iso}'))`
          : `new UTCDateTime(${v.date.getTime()})`;
      }
      case 'binary':
        return this.use(
          'MongoDB\\BSON\\Binary',
          `new Binary(base64_decode('${v.base64}'), ${v.subtype})`,
        );
      case 'uuid':
        return this.use(
          'MongoDB\\BSON\\Binary',
          `new Binary(hex2bin('${v.hex}'), Binary::TYPE_UUID)`,
        );
      case 'regex':
        return this.use(
          'MongoDB\\BSON\\Regex',
          v.flags === ''
            ? `new Regex(${quotePhp(v.pattern)})`
            : `new Regex(${quotePhp(v.pattern)}, '${v.flags}')`,
        );
      case 'timestamp':
        // The constructor takes the increment first.
        return this.use('MongoDB\\BSON\\Timestamp', `new Timestamp(${v.i}, ${v.t})`);
      case 'minKey':
        return this.use('MongoDB\\BSON\\MinKey', 'new MinKey()');
      case 'maxKey':
        return this.use('MongoDB\\BSON\\MaxKey', 'new MaxKey()');
      case 'code':
        return this.use(
          'MongoDB\\BSON\\Javascript',
          v.scope === undefined
            ? `new Javascript(${quotePhp(v.code)})`
            : `new Javascript(${quotePhp(v.code)}, ${this.value(v.scope, level, used)})`,
        );
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
          { open: '[', close: ']', trailingComma: true },
          INDENT,
          level,
          used,
        );
      case 'document':
        return this.document(v.entries, level, used);
    }
  }

  document(entries: readonly (readonly [string, BsonValue])[], level: number, used = 0): string {
    // PHP encodes an array whose keys are 0..n-1 (or no keys) as a BSON array.
    const listLike = entries.every(([key], i) => key === String(i));
    const cast = listLike ? '(object) ' : '';
    return layoutList(
      entries.map(([key, item]) => {
        const prefix = `${quotePhp(key)} => `;
        return prefix + this.value(item, level + 1, prefix.length);
      }),
      { open: `${cast}[`, close: ']', trailingComma: true },
      INDENT,
      level,
      used,
    );
  }

  private use(name: string, text: string): string {
    this.imports.add(name);
    return text;
  }
}

/** A complete PHP script that runs the query with the mongodb/mongodb library. */
export function phpProgram(target: ExportTarget, database: string): string {
  const values = new PhpValues();
  const body: string[] = [];
  const assign = (name: string, value: BsonValue): void => {
    const prefix = `$${name} = `;
    body.push(`${prefix}${values.value(value, 0, prefix.length)};`);
  };
  let call: string;
  if (target.kind === 'find') {
    const { query } = target;
    assign('filter', query.filter);
    const options: BsonDocument = {};
    if (hasContent(query.projection)) options['projection'] = query.projection;
    if (hasContent(query.sort)) options['sort'] = query.sort;
    if (query.skip !== undefined && query.skip > 0) options['skip'] = query.skip;
    if (query.limit !== undefined && query.limit > 0) options['limit'] = query.limit;
    if (hasContent(query.collation)) options['collation'] = query.collation;
    if (query.hint !== undefined) options['hint'] = query.hint;
    if (query.maxTimeMS !== undefined) options['maxTimeMS'] = query.maxTimeMS;
    if (Object.keys(options).length > 0) {
      assign('options', options);
      call = '$collection->find($filter, $options)';
    } else {
      call = '$collection->find($filter)';
    }
  } else {
    assign('pipeline', [...target.pipeline]);
    call = '$collection->aggregate($pipeline)';
  }
  const uses = ['MongoDB\\BSON\\Document', 'MongoDB\\Client', ...values.imports].sort((a, b) =>
    a.localeCompare(b),
  );
  return `<?php

// composer require mongodb/mongodb
// Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}

require __DIR__ . '/vendor/autoload.php';

${uses.map((name) => `use ${name};`).join('\n')}

$uri = getenv('${URI_VARIABLE}');
if ($uri === false) {
    fwrite(STDERR, "Set the ${URI_VARIABLE} environment variable\\n");
    exit(1);
}

$client = new Client($uri);
$collection = $client->selectCollection(${quotePhp(database)}, ${quotePhp(target.collection)});

${body.join('\n')}

foreach (${call} as $document) {
    // Relaxed Extended JSON prints every BSON type (json_encode fails on NaN and Infinity).
    echo Document::fromPHP($document)->toRelaxedExtendedJSON(), PHP_EOL;
}
`;
}
