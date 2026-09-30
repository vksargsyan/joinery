import { atLeast } from '@joinery/core';
import type { TableDef } from '@joinery/core';
import { diagnose } from '@joinery/sql-tools';

import { canonicalCharset, canonicalCollation } from '../normalize';
import { isFullyParenthesized, referencedNames } from '../sql-text';
import { canonicalType } from '../types';
import { findType, parseType } from './catalog';
import { dependentViews, prepare, referencingTables } from './prepare';
import type { Prepared } from './prepare';
import type { DesignContext, ValidationIssue } from './types';
import { validateColumns } from './validate-columns';
import { fkTypeProblem, keyProblem, validateForeignKeys, validateKeys } from './validate-keys';
import {
  BLOB_LIKE,
  checkName,
  columnNamed,
  columnsIn,
  duplicates,
  expressionProblem,
  Issues,
  MYSQL_CHARSETS,
  MYSQL_ENGINES,
  MYSQL_OPTION_KEYS,
  MYSQL_ROW_FORMATS,
  PG_STORAGE_PARAMETERS,
  sameName,
} from './validate-shared';

/**
 * Validation before saving (spec §8: "invalid combinations are flagged before saving"). Every
 * rule reports a path into the edited table, a stable code and a message; errors block the
 * save, warnings explain. Rules only flag what the server would refuse, silently change, or
 * what would make the next compare differ; anything subtler is left to the server.
 */

// ---------------------------------------------------------------------------------------------
// Names

function validateNames(p: Prepared, issues: Issues): void {
  const t = p.edited;
  checkName(issues, p, 'name', t.name, 'table');
  const fold = (n: string): string => (p.pg ? n : n.toLowerCase());
  const renamed = p.live !== null && p.live.name !== t.name;
  if ((p.live === null || renamed) && p.schemaDef !== undefined) {
    const relations = [
      ...p.schemaDef.tables.map((x) => x.name),
      ...p.schemaDef.views.map((x) => x.name),
      ...(p.pg ? p.schemaDef.sequences.map((x) => x.name) : []),
    ];
    if (relations.some((r) => r === t.name)) {
      issues.add('name', 'name-taken', `${p.schema} already has a table or view named ${t.name}`);
    }
  }
  if (!p.pg && t.columns.length === 0) {
    issues.add('columns', 'no-columns', 'A table needs at least one column');
  } else if (t.columns.length === 0) {
    issues.add('columns', 'no-columns', 'The table has no columns', 'warning');
  }
  t.columns.forEach((c, i) => checkName(issues, p, `columns[${i}].name`, c.name, 'column'));
  for (const [i, first] of duplicates(t.columns, (c) => fold(c.name))) {
    issues.add(
      `columns[${i}].name`,
      'duplicate-name',
      `Column ${t.columns[i]!.name} is defined twice (see row ${first + 1})`,
    );
  }
  t.indexes.forEach((x, i) => checkName(issues, p, `indexes[${i}].name`, x.name, 'index'));
  t.uniques.forEach((x, i) => checkName(issues, p, `uniques[${i}].name`, x.name, 'constraint'));
  t.checks.forEach((x, i) => checkName(issues, p, `checks[${i}].name`, x.name, 'check'));
  t.foreignKeys.forEach((x, i) =>
    checkName(issues, p, `foreignKeys[${i}].name`, x.name, 'foreign key'),
  );
  t.triggers.forEach((x, i) => checkName(issues, p, `triggers[${i}].name`, x.name, 'trigger'));
  if (t.primaryKey !== undefined && p.pg) {
    checkName(issues, p, 'primaryKey.name', t.primaryKey.name, 'primary key');
  }

  // Names that must be unique within the table: indexes (with the primary key and unique
  // constraints, which create one) and constraints.
  const keyLike: { path: string; name: string }[] = [
    ...(p.pg && t.primaryKey !== undefined
      ? [{ path: 'primaryKey.name', name: t.primaryKey.name }]
      : []),
    ...t.uniques.map((x, i) => ({ path: `uniques[${i}].name`, name: x.name })),
  ];
  const indexLike = [
    ...keyLike,
    ...t.indexes.map((x, i) => ({ path: `indexes[${i}].name`, name: x.name })),
  ];
  for (const [i] of duplicates(indexLike, (x) => fold(x.name))) {
    issues.add(indexLike[i]!.path, 'duplicate-name', `Name ${indexLike[i]!.name} is used twice`);
  }
  if (!p.pg) {
    indexLike.forEach((x) => {
      if (x.name.toUpperCase() === 'PRIMARY')
        issues.add(x.path, 'reserved-index-name', 'PRIMARY is the primary key’s name');
    });
  }
  const constraints: { path: string; name: string }[] = [
    ...(p.pg ? keyLike : []),
    ...t.checks.map((x, i) => ({ path: `checks[${i}].name`, name: x.name })),
    ...t.foreignKeys.map((x, i) => ({ path: `foreignKeys[${i}].name`, name: x.name })),
  ];
  for (const [i] of duplicates(constraints, (x) => fold(x.name))) {
    issues.add(
      constraints[i]!.path,
      'duplicate-name',
      `Name ${constraints[i]!.name} is used twice`,
    );
  }
  for (const [i] of duplicates(t.triggers, (x) => fold(x.name))) {
    issues.add(
      `triggers[${i}].name`,
      'duplicate-name',
      `Trigger ${t.triggers[i]!.name} is defined twice`,
    );
  }

  // Names shared with the rest of the schema.
  const others = p.schemaDef?.tables ?? [];
  if (p.pg && p.schemaDef !== undefined) {
    const relations = new Set([
      ...others.flatMap((x) => [
        x.name,
        ...x.indexes.map((i) => i.name),
        ...x.uniques.map((u) => u.name),
        ...(x.primaryKey !== undefined ? [x.primaryKey.name] : []),
        ...(x.partitioning?.partitions.map((pt) => pt.name) ?? []),
      ]),
      ...p.schemaDef.views.map((v) => v.name),
      ...p.schemaDef.sequences.map((s) => s.name),
    ]);
    for (const x of indexLike) {
      if (relations.has(x.name))
        issues.add(x.path, 'name-taken', `${p.schema} already has a relation named ${x.name}`);
    }
  }
  if (!p.pg) {
    const fks = new Set(others.flatMap((x) => x.foreignKeys.map((f) => f.name.toLowerCase())));
    t.foreignKeys.forEach((fk, i) => {
      if (fks.has(fk.name.toLowerCase()))
        issues.add(
          `foreignKeys[${i}].name`,
          'name-taken',
          `Foreign key names are unique per database; ${fk.name} is taken`,
        );
    });
    if (p.dialect === 'mysql') {
      const checks = new Set(others.flatMap((x) => x.checks.map((c) => c.name.toLowerCase())));
      t.checks.forEach((c, i) => {
        if (checks.has(c.name.toLowerCase()))
          issues.add(
            `checks[${i}].name`,
            'name-taken',
            `MySQL check names are unique per database; ${c.name} is taken`,
          );
      });
    }
    const triggers = new Set(others.flatMap((x) => x.triggers.map((g) => g.name.toLowerCase())));
    t.triggers.forEach((g, i) => {
      if (triggers.has(g.name.toLowerCase()))
        issues.add(
          `triggers[${i}].name`,
          'name-taken',
          `Trigger names are unique per database; ${g.name} is taken`,
        );
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Checks, triggers, partitioning, options

function validateChecks(p: Prepared, issues: Issues): void {
  const t = p.edited;
  const autoIncrement = t.columns.filter((c) => c.autoIncrement).map((c) => c.name);
  t.checks.forEach((check, i) => {
    const path = `checks[${i}].expression`;
    if (check.expression.trim() === '') {
      issues.add(path, 'check-expression', 'The check condition is empty');
      return;
    }
    const problem = expressionProblem(check.expression, p);
    if (problem !== undefined)
      issues.add(path, 'expression-syntax', `The condition has an ${problem}`);
    if (!p.pg && columnsIn(p, check.expression, autoIncrement).length > 0)
      issues.add(path, 'check-auto-increment', 'A check cannot use the AUTO_INCREMENT column');
  });
  if (
    t.checks.length > 0 &&
    p.dialect === 'mysql' &&
    p.version !== undefined &&
    !atLeast(p.version, '8.0.16')
  )
    issues.add(
      'checks',
      'check-ignored',
      'MySQL before 8.0.16 parses checks but does not enforce them',
      'warning',
    );
}

const TRIGGER_HEAD =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`(?:[^`]|``)+`|[^\s(]+)/i;

function validateTriggers(p: Prepared, issues: Issues): void {
  p.edited.triggers.forEach((trigger, i) => {
    const path = `triggers[${i}]`;
    const adapted = p.table.triggers[i] ?? trigger;
    if (trigger.definition.trim() === '') {
      issues.add(`${path}.definition`, 'trigger-definition', 'The trigger has no definition');
      return;
    }
    const head = TRIGGER_HEAD.exec(adapted.definition);
    if (!head) {
      issues.add(
        `${path}.definition`,
        'trigger-definition',
        'The definition must be a CREATE TRIGGER statement',
      );
      return;
    }
    const written = head[1]!.replace(/^["`]|["`]$/g, '');
    const bare =
      written.includes('.') && !/^["`]/.test(head[1]!)
        ? written.slice(written.lastIndexOf('.') + 1)
        : written;
    if (!sameName(p, bare, trigger.name))
      issues.add(
        `${path}.name`,
        'trigger-name-mismatch',
        `The definition creates trigger ${bare}, not ${trigger.name}`,
      );
    const on =
      /\bON\s+((?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|[\w$]+))?)/i.exec(
        adapted.definition.slice(head[0].length),
      );
    if (on) {
      const parts = on[1]!.split(/\s*\.\s*/).map((s) => s.replace(/^["`]|["`]$/g, ''));
      const table = parts[parts.length - 1]!;
      if (
        !sameName(p, table, p.table.name) &&
        !(p.pg && table.toLowerCase() === p.table.name.toLowerCase() && !/"/.test(on[1]!))
      )
        issues.add(
          `${path}.definition`,
          'trigger-table',
          `The definition is on ${table}, not ${p.table.name}`,
        );
    }
    if (!p.pg) {
      if (trigger.timing === 'INSTEAD OF')
        issues.add(`${path}.timing`, 'trigger-timing', 'MySQL triggers run BEFORE or AFTER');
      if (trigger.events.includes('TRUNCATE'))
        issues.add(`${path}.events`, 'trigger-event', 'MySQL has no TRUNCATE triggers');
      if (trigger.events.length > 1)
        issues.add(`${path}.events`, 'trigger-event', 'A MySQL trigger fires on exactly one event');
    } else if (trigger.timing === 'INSTEAD OF') {
      issues.add(
        `${path}.timing`,
        'trigger-timing',
        'INSTEAD OF triggers are for views, not tables',
      );
    }
  });
}

const PG_PARTITION_METHODS = ['RANGE', 'LIST', 'HASH'];
const MYSQL_PARTITION_METHODS = [
  'RANGE',
  'LIST',
  'HASH',
  'KEY',
  'LINEAR HASH',
  'LINEAR KEY',
  'RANGE COLUMNS',
  'LIST COLUMNS',
];

function validatePartitioning(p: Prepared, issues: Issues): void {
  const t = p.edited;
  const part = t.partitioning;
  if (part === undefined) {
    if (p.pg && t.kind === 'partitioned')
      issues.add(
        'partitioning',
        'partition-key-required',
        'A partitioned table needs a partition key',
      );
    return;
  }
  const method = part.method.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!(p.pg ? PG_PARTITION_METHODS : MYSQL_PARTITION_METHODS).includes(method))
    issues.add(
      'partitioning.method',
      'partition-method',
      `Unknown partitioning method ${part.method}`,
    );
  if (part.key.trim() === '' && !(method.endsWith('KEY') && !p.pg)) {
    issues.add('partitioning.key', 'partition-key-required', 'The partition key is empty');
    return;
  }
  const keyColumnNames = columnsIn(
    p,
    part.key,
    t.columns.map((c) => c.name),
  );
  if (part.key.trim() !== '' && keyColumnNames.length === 0)
    issues.add(
      'partitioning.key',
      'partition-key-columns',
      'The partition key uses no column of the table',
      'warning',
    );
  const fold = (c: string): string => c.toLowerCase();
  const unique: { path: string; columns: string[] }[] = [
    ...(t.primaryKey !== undefined ? [{ path: 'primaryKey', columns: t.primaryKey.columns }] : []),
    ...t.uniques.map((u, i) => ({ path: `uniques[${i}]`, columns: u.columns })),
    ...t.indexes.flatMap((x, i) =>
      x.unique ? [{ path: `indexes[${i}]`, columns: x.columns.map((c) => c.name ?? '') }] : [],
    ),
  ];
  for (const key of unique) {
    const missing = keyColumnNames.filter((c) => !key.columns.some((k) => fold(k) === fold(c)));
    if (missing.length > 0)
      issues.add(
        key.path,
        'partition-unique-key',
        `Every unique key of a partitioned table must include the partition key column(s): add ${missing.join(', ')}`,
      );
  }
  if (!p.pg) {
    if (method.startsWith('RANGE') || method.startsWith('LIST')) {
      if (part.partitions.length === 0)
        issues.add(
          'partitioning.partitions',
          'partitions-required',
          `${method} partitioning needs at least one partition`,
        );
      part.partitions.forEach((x, i) => {
        if (x.bound === undefined || x.bound.trim() === '')
          issues.add(
            `partitioning.partitions[${i}].bound`,
            'partition-bound',
            `Partition ${x.name} needs its ${method.startsWith('RANGE') ? 'LESS THAN value' : 'value list'}`,
          );
      });
    }
  }
  part.partitions.forEach((x, i) =>
    checkName(issues, p, `partitioning.partitions[${i}].name`, x.name, 'partition'),
  );
  for (const [i] of duplicates(part.partitions, (x) => x.name.toLowerCase()))
    issues.add(
      `partitioning.partitions[${i}].name`,
      'duplicate-name',
      `Partition ${part.partitions[i]!.name} is defined twice`,
    );
}

function validateOptions(p: Prepared, issues: Issues): void {
  const t = p.edited;
  const options = t.options;
  if (p.pg) {
    for (const [key, value] of Object.entries(options)) {
      const path = `options.${key}`;
      if (key === 'tablespace') {
        if (value.trim() === '') issues.add(path, 'option-value', 'The tablespace name is empty');
        continue;
      }
      if (['engine', 'charset', 'collation', 'autoIncrement', 'rowFormat'].includes(key)) {
        issues.add(path, 'option-unsupported', `${key} is a MySQL option`);
        continue;
      }
      const kind = PG_STORAGE_PARAMETERS[key.replace(/^toast\./, '')];
      if (kind === undefined) {
        issues.add(path, 'unknown-option', `Unknown storage parameter ${key}`, 'warning');
        continue;
      }
      if (kind === 'int' && !/^-?\d+$/.test(value))
        issues.add(path, 'option-value', `${key} takes an integer`);
      if (kind === 'real' && !/^-?\d+(\.\d+)?$/.test(value))
        issues.add(path, 'option-value', `${key} takes a number`);
      if (kind === 'bool' && !/^(true|false|on|off|yes|no|1|0)$/i.test(value))
        issues.add(path, 'option-value', `${key} takes true or false`);
      if (
        key === 'fillfactor' &&
        /^\d+$/.test(value) &&
        (Number(value) < 10 || Number(value) > 100)
      )
        issues.add(path, 'option-value', 'fillfactor is between 10 and 100');
    }
    return;
  }
  for (const [key, value] of Object.entries(options)) {
    const path = `options.${key}`;
    if (!MYSQL_OPTION_KEYS.includes(key)) {
      issues.add(
        path,
        'unknown-option',
        `${key} is not a table option the designer writes`,
        'warning',
      );
      continue;
    }
    if (key === 'engine' && !MYSQL_ENGINES.has(value.toLowerCase()))
      issues.add(path, 'unknown-engine', `Unknown storage engine ${value}`, 'warning');
    if (key === 'rowFormat' && !MYSQL_ROW_FORMATS.has(value.toLowerCase()))
      issues.add(path, 'option-value', `Unknown row format ${value}`);
    if (key === 'autoIncrement' && !/^[1-9]\d*$/.test(value))
      issues.add(path, 'option-value', 'AUTO_INCREMENT takes a positive integer');
    if (key === 'charset' && MYSQL_CHARSETS[canonicalCharset(value) ?? ''] === undefined)
      issues.add(path, 'unknown-charset', `Unknown character set ${value}`, 'warning');
  }
  const charset = canonicalCharset(options.charset);
  const collation = canonicalCollation(options.collation);
  if (charset !== undefined && collation !== undefined) {
    const prefix = canonicalCharset(collation.split('_')[0]);
    if (prefix !== undefined && MYSQL_CHARSETS[prefix] !== undefined && prefix !== charset)
      issues.add(
        'options.collation',
        'collation-mismatch',
        `Collation ${options.collation!} does not belong to character set ${options.charset!}`,
      );
  } else if (charset !== undefined && collation === undefined) {
    issues.add(
      'options.collation',
      'collation-missing',
      'Pick a collation too: the server picks the character set’s default, which reads back as a difference',
      'warning',
    );
  }
  if ((options.engine ?? '').toLowerCase() === 'memory') {
    t.columns.forEach((c, i) => {
      const entry = findType(p.catalog, parseType(c.dataType, p.engine) ?? c.dataType);
      if (entry !== undefined && BLOB_LIKE.has(entry.name))
        issues.add(
          `columns[${i}].dataType`,
          'engine-type',
          `The MEMORY engine cannot store ${entry.name.toUpperCase()} columns`,
        );
    });
  }
  if (t.comment !== undefined && [...t.comment].length > 2048)
    issues.add('comment', 'comment-too-long', 'Table comments are limited to 2,048 characters');
}

// ---------------------------------------------------------------------------------------------
// The live table and what depends on it

function validateAgainstLive(p: Prepared, issues: Issues): void {
  const live = p.live;
  if (live === null) return;
  const t = p.table;
  const kept = new Set(t.columns.map((c) => c.name));
  const dropped = live.columns
    .filter((c) => !kept.has(p.columnRenames.get(c.name) ?? c.name))
    .map((c) => c.name);
  const expressions: { path: string; text: string; what: string }[] = [
    ...t.checks.map((c, i) => ({
      path: `checks[${i}].expression`,
      text: c.expression,
      what: `Check ${c.name}`,
    })),
    ...t.columns.flatMap((c, i) =>
      c.generated !== undefined
        ? [
            {
              path: `columns[${i}].generated.expression`,
              text: c.generated.expression,
              what: `Generated column ${c.name}`,
            },
          ]
        : [],
    ),
    ...t.indexes.flatMap((x, i) =>
      [...x.columns.map((c) => c.expression ?? ''), x.where ?? '']
        .filter((e) => e !== '')
        .map((text) => ({ path: `indexes[${i}]`, text, what: `Index ${x.name}` })),
    ),
    ...(t.partitioning !== undefined
      ? [{ path: 'partitioning.key', text: t.partitioning.key, what: 'The partition key' }]
      : []),
  ];
  const live_columns = new Set(t.columns.map((c) => c.name.toLowerCase()));
  for (const e of expressions) {
    const used = columnsIn(p, e.text, dropped).filter((c) => !live_columns.has(c.toLowerCase()));
    if (used.length > 0)
      issues.add(
        e.path,
        'dropped-column-in-use',
        `${e.what} uses ${used.join(', ')}, which ${used.length === 1 ? 'is' : 'are'} dropped`,
      );
  }
  const home = p.schemaDef?.name ?? p.schema;
  for (const { schema, view } of dependentViews(p, [{ schema: home, name: live.name }])) {
    if (!(schema.name === home) && !p.pg) continue;
    const refsTable = referencedNames(view.definition, p.dialect).some(
      (r) => r.name.toLowerCase() === live.name.toLowerCase(),
    );
    if (!refsTable) continue;
    const used = columnsIn(p, view.definition, dropped);
    if (used.length === 0) continue;
    issues.add(
      'columns',
      'dropped-column-in-view',
      p.pg
        ? `View ${schema.name}.${view.name} uses ${used.join(', ')}: change or drop the view before dropping ${used.length === 1 ? 'it' : 'them'}`
        : `View ${view.name} uses ${used.join(', ')} and stops working when ${used.length === 1 ? 'it is' : 'they are'} dropped`,
      p.pg ? 'error' : 'warning',
    );
  }
  for (const { schema, table } of referencingTables(p)) {
    table.foreignKeys.forEach((fk) => {
      if (fk.refTable !== live.name) return;
      if (p.pg && (fk.refSchema ?? schema.name) !== home) return;
      const display = `${p.pg ? `${schema.name}.` : ''}${table.name}.${fk.name}`;
      const gone = fk.refColumns.filter((c) => dropped.includes(c));
      if (gone.length > 0) {
        issues.add(
          'columns',
          'dropped-column-referenced',
          `Foreign key ${display} references ${gone.join(', ')}; drop it first`,
        );
        return;
      }
      const refColumns = fk.refColumns.map((c) => p.columnRenames.get(c) ?? c);
      const problem = keyProblem(p, t, refColumns);
      if (problem !== undefined && problem.severity === 'error')
        issues.add(
          'primaryKey',
          'referenced-key-dropped',
          `Foreign key ${display} needs a unique key on (${refColumns.join(', ')})`,
        );
      fk.columns.forEach((c, k) => {
        const child = columnNamed(p, table, c);
        const parent = columnNamed(p, t, refColumns[k] ?? null);
        if (child === undefined || parent === undefined) return;
        const liveParent = columnNamed(p, live, fk.refColumns[k] ?? null);
        if (
          liveParent !== undefined &&
          canonicalType(liveParent.dataType, p.dialect) ===
            canonicalType(parent.dataType, p.dialect)
        )
          return;
        const mismatch = fkTypeProblem(p, child, table, parent, t);
        if (mismatch !== undefined)
          issues.add(
            `columns[${t.columns.indexOf(parent)}].dataType`,
            'fk-type-mismatch',
            `Foreign key ${display}: ${mismatch.message}`,
            mismatch.severity,
          );
      });
    });
  }
  if (p.dialect === 'mysql' && p.columnRenames.size > 0) {
    const renamed = [...p.columnRenames.keys()];
    const users: { text: string; what: string }[] = [
      ...live.checks.map((c) => ({ text: c.expression, what: `check ${c.name}` })),
      ...live.columns.flatMap((c) =>
        c.generated !== undefined
          ? [{ text: c.generated.expression, what: `generated column ${c.name}` }]
          : [],
      ),
      ...live.indexes.flatMap((x) =>
        x.columns
          .filter((c) => c.expression !== undefined)
          .map((c) => ({ text: c.expression!, what: `functional index ${x.name}` })),
      ),
      ...(live.partitioning !== undefined
        ? [{ text: live.partitioning.key, what: 'the partition key' }]
        : []),
    ];
    for (const use of users) {
      for (const column of columnsIn(p, use.text, renamed)) {
        const i = t.columns.findIndex((c) => c.name === p.columnRenames.get(column));
        issues.add(
          `columns[${i}].name`,
          'rename-blocked',
          `MySQL cannot rename ${column} while ${use.what} uses it; remove that first, save, then rename`,
        );
      }
    }
  }
  if (p.pg && p.live !== null) {
    const order = t.columns.map((c) => c.name);
    const liveOrder = live.columns
      .map((c) => p.columnRenames.get(c.name) ?? c.name)
      .filter((n) => order.includes(n));
    const editedOrder = order.filter((n) => liveOrder.includes(n));
    if (liveOrder.join('\u0000') !== editedOrder.join('\u0000'))
      issues.add(
        'columns',
        'reorder-unsupported',
        'PostgreSQL cannot reorder columns without rebuilding the table; the new order is not applied',
        'warning',
      );
    const firstNew = order.findIndex((n) => !liveOrder.includes(n));
    if (firstNew !== -1 && order.slice(firstNew).some((n) => liveOrder.includes(n)))
      issues.add(
        'columns',
        'reorder-unsupported',
        'PostgreSQL adds new columns after the existing ones',
        'warning',
      );
  }
}

// ---------------------------------------------------------------------------------------------

/** Every rule over a prepared design. */
export function validatePrepared(p: Prepared): ValidationIssue[] {
  const issues = new Issues();
  issues.list.push(...p.issues);
  validateNames(p, issues);
  const types = validateColumns(p, issues);
  validateKeys(p, issues, types);
  validateForeignKeys(p, issues);
  validateChecks(p, issues);
  validateTriggers(p, issues);
  validatePartitioning(p, issues);
  validateOptions(p, issues);
  validateAgainstLive(p, issues);
  return dedupe(issues.list);
}

function dedupe(list: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = `${i.path}\u0000${i.code}\u0000${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Validates an edited table (spec §8): types and their parameters for the engine and version,
 * defaults, AUTO_INCREMENT / identity / generated combinations, names, keys and indexes,
 * foreign keys against the referenced keys and types, checks, triggers, partitioning, options,
 * and — when the live table is known — what the change would break (dropped columns still in
 * use, keys other tables reference, renames MySQL refuses). `live` defaults to the snapshot's
 * table of the same name.
 */
export function validateTable(
  edited: TableDef,
  context: DesignContext,
  live?: TableDef | null,
): ValidationIssue[] {
  const fromSnapshot =
    live !== undefined
      ? live
      : (context.snapshot?.schemas
          .find(
            (s) =>
              s.name === context.schema ||
              (context.engine !== 'postgres' && context.snapshot!.schemas.length === 1),
          )
          ?.tables.find((t) => t.name === edited.name) ?? null);
  return validatePrepared(prepare(fromSnapshot, edited, context));
}

/**
 * Parses the table's expressions — checks, generated columns, expression defaults, index
 * expressions and predicates, the partition key — with the SQL editor's parser (`diagnose`
 * from @joinery/sql-tools) and reports syntax errors. Asynchronous because the parser loads
 * on first use; the UI runs it after typing pauses, next to the synchronous `validateTable`.
 */
export async function diagnoseTable(
  edited: TableDef,
  context: DesignContext,
): Promise<ValidationIssue[]> {
  const dialect = context.engine;
  const pieces: { path: string; text: string }[] = [
    ...edited.checks.map((c, i) => ({ path: `checks[${i}].expression`, text: c.expression })),
    ...edited.columns.flatMap((c, i) => [
      ...(c.generated !== undefined
        ? [{ path: `columns[${i}].generated.expression`, text: c.generated.expression }]
        : []),
      ...(c.default !== null && isFullyParenthesized(c.default.trim(), dialect)
        ? [{ path: `columns[${i}].default`, text: c.default }]
        : []),
    ]),
    ...edited.indexes.flatMap((x, i) => [
      ...x.columns.flatMap((c, k) =>
        c.expression !== undefined
          ? [{ path: `indexes[${i}].columns[${k}].expression`, text: c.expression }]
          : [],
      ),
      ...(x.where !== undefined ? [{ path: `indexes[${i}].where`, text: x.where }] : []),
    ]),
    ...(edited.partitioning !== undefined && edited.partitioning.key.trim() !== ''
      ? [{ path: 'partitioning.key', text: edited.partitioning.key }]
      : []),
  ];
  const issues: ValidationIssue[] = [];
  for (const piece of pieces) {
    if (piece.text.trim() === '') continue;
    const prefix = 'SELECT (';
    const diagnostics = await diagnose(`${prefix}${piece.text})`, dialect);
    const first = diagnostics[0];
    if (first === undefined) continue;
    const at = Math.max(0, Math.min(piece.text.length, first.start - prefix.length));
    issues.push({
      path: piece.path,
      code: 'syntax',
      message: `Syntax error near position ${at + 1}: ${first.message}`,
      severity: 'error',
    });
  }
  return issues;
}
