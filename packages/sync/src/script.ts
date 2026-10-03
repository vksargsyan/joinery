import type { SqlDialect } from '@querybara/core';

import type { SchemaDiff, SyncOperation, SyncWarning } from './model';
import { missingDependencies } from './selection';
import { tokenizeSql } from './sql-text';

/** Script generation switches. */
export interface ScriptOptions {
  /** Operations to include: the selected ones (default) or all of them. */
  readonly include?: 'selected' | 'all';
  /** A leading comment block describing the compare (default true). */
  readonly header?: boolean;
  /** A comment line before each operation (default true). */
  readonly comments?: boolean;
  /** PostgreSQL: wrap the script in one transaction (default true). */
  readonly transaction?: boolean;
  /**
   * MySQL/MariaDB: run with FOREIGN_KEY_CHECKS = 0 so tables and keys can be dropped and added in
   * any order (default true). Foreign keys added this way do not validate existing rows.
   */
  readonly disableForeignKeyChecks?: boolean;
}

/** One statement of the script and the operation it comes from. */
export interface ScriptStatement {
  /** The operation the statement belongs to; null for BEGIN/COMMIT and session settings. */
  readonly operationId: string | null;
  readonly sql: string;
}

/** A deployment script, as plain statements for drivers and as runnable text. */
export interface GeneratedScript {
  readonly dialect: SqlDialect;
  /** Plain statements in execution order: no terminators, no DELIMITER. Drivers run these. */
  readonly statements: readonly string[];
  readonly steps: readonly ScriptStatement[];
  /** A runnable script with terminators, comments and (MySQL) DELIMITER blocks. */
  readonly text: string;
  /** The script runs in one transaction (PostgreSQL). */
  readonly transactional: boolean;
  /** MySQL/MariaDB DDL is not transactional, so the UI offers a backup first (spec §13). */
  readonly backupRecommended: boolean;
  readonly warnings: readonly SyncWarning[];
  /** Included operations whose dependencies are not included. */
  readonly missingDependencies: readonly {
    readonly operationId: string;
    readonly missing: readonly string[];
  }[];
  readonly operationCount: number;
}

/** True when a MySQL statement holds semicolons of its own (routine, trigger and event bodies). */
export function isCompoundStatement(sql: string, dialect: SqlDialect): boolean {
  return tokenizeSql(sql, dialect).some((t) => t.kind === 'punct' && t.text === ';');
}

const DELIMITERS = ['$$', ';;', '//', '$$$', '@@'];

/**
 * Joins statements into a script. MySQL/MariaDB compound statements go inside a DELIMITER block
 * whose delimiter does not occur in them; PostgreSQL needs none (bodies are dollar-quoted).
 */
export function formatStatements(statements: readonly string[], dialect: SqlDialect): string {
  if (dialect === 'postgres') return statements.map((s) => `${s};`).join('\n');
  const out: string[] = [];
  let delimiter: string | null = null;
  for (const sql of statements) {
    if (isCompoundStatement(sql, dialect)) {
      const wanted = DELIMITERS.find((d) => !sql.includes(d)) ?? '$$';
      if (delimiter !== wanted) {
        if (delimiter !== null) out.push('DELIMITER ;');
        out.push(`DELIMITER ${wanted}`);
        delimiter = wanted;
      }
      out.push(`${sql}${wanted}`);
    } else {
      if (delimiter !== null) {
        out.push('DELIMITER ;');
        delimiter = null;
      }
      out.push(`${sql};`);
    }
  }
  if (delimiter !== null) out.push('DELIMITER ;');
  return out.join('\n');
}

function commentLine(text: string): string {
  return `-- ${text.replace(/[\r\n]+/g, ' ')}`;
}

function describe(op: SyncOperation, include: 'selected' | 'all'): string {
  const kind = op.objectKind.replace(/-/g, ' ');
  const verb =
    op.kind === 'create'
      ? 'Create'
      : op.kind === 'drop'
        ? 'Drop'
        : op.kind === 'rename'
          ? 'Rename'
          : 'Alter';
  const flags: string[] = [];
  if (op.destructive) flags.push('destructive');
  if (include === 'all' && !op.selected) flags.push('not selected by default');
  return `${verb} ${kind} ${op.qualifiedName}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`;
}

/**
 * The deployment script (spec §13, step 7): included operations' steps in dependency order.
 * PostgreSQL scripts run in one transaction, except `ALTER TYPE ... ADD VALUE`, which runs
 * first on its own because a new enum label cannot be used in the transaction that adds it.
 */
export function generateScript(diff: SchemaDiff, options: ScriptOptions = {}): GeneratedScript {
  const include = options.include ?? 'selected';
  const pg = diff.dialect === 'postgres';
  const transactional = pg && options.transaction !== false;
  const fkChecks = !pg && options.disableForeignKeyChecks !== false;
  const included = (op: SyncOperation): boolean => include === 'all' || op.selected;

  const pre: { op: SyncOperation; sql: string }[] = [];
  const main: { op: SyncOperation; sql: string }[] = [];
  for (const [opIndex, stepIndex] of diff.order) {
    const op = diff.operations[opIndex]!;
    if (!included(op)) continue;
    const s = op.steps[stepIndex]!;
    const bucket = s.preTransaction && transactional ? pre : main;
    for (const sql of s.statements) bucket.push({ op, sql });
  }

  const steps: ScriptStatement[] = [];
  const text: string[] = [];
  const operationIds = new Set<string>();
  const warnings: SyncWarning[] = [...diff.warnings];

  if (options.header !== false) {
    const count = diff.operations.filter(included).length;
    const destructive = diff.operations.filter((op) => included(op) && op.destructive).length;
    text.push(
      commentLine('Querybara structure sync'),
      commentLine(`Source: ${diff.sourceEngine} ${diff.sourceDatabase}`),
      commentLine(`Target: ${diff.targetEngine} ${diff.targetDatabase}`),
      commentLine(`Operations: ${count}${destructive > 0 ? ` (${destructive} destructive)` : ''}`),
    );
    for (const warning of diff.warnings) text.push(commentLine(`Warning: ${warning.message}`));
    text.push('');
  }

  const described = new Set<string>();
  const emit = (entries: readonly { op: SyncOperation; sql: string }[]): void => {
    let current: SyncOperation | null = null;
    let block: string[] = [];
    const flush = (): void => {
      if (block.length > 0) text.push(formatStatements(block, diff.dialect));
      block = [];
    };
    for (const entry of entries) {
      if (entry.op !== current) {
        flush();
        if (options.comments !== false) {
          if (text.length > 0 && text[text.length - 1] !== '') text.push('');
          const first = !described.has(entry.op.id);
          described.add(entry.op.id);
          text.push(commentLine(`${describe(entry.op, include)}${first ? '' : ' (continued)'}`));
          if (first && entry.op.reason !== undefined) text.push(commentLine(entry.op.reason));
          for (const warning of first ? entry.op.warnings : []) {
            if (warning.code !== 'rebuild')
              text.push(commentLine(`  ${warning.code}: ${warning.message}`));
          }
        }
        current = entry.op;
      }
      operationIds.add(entry.op.id);
      steps.push({ operationId: entry.op.id, sql: entry.sql });
      block.push(entry.sql);
    }
    flush();
  };

  const control = (sql: string): void => {
    steps.push({ operationId: null, sql });
    text.push(formatStatements([sql], diff.dialect));
  };

  if (pre.length > 0) {
    if (options.comments !== false) {
      text.push(
        commentLine(
          'New enum labels must be committed before they can be used, so they are added first.',
        ),
      );
    }
    emit(pre);
    text.push('');
  }
  if (main.length > 0) {
    if (transactional) control('BEGIN');
    if (fkChecks) control('SET FOREIGN_KEY_CHECKS = 0');
    emit(main);
    text.push('');
    if (fkChecks) control('SET FOREIGN_KEY_CHECKS = 1');
    if (transactional) control('COMMIT');
  }

  const unscripted = diff.operations.filter((op) => included(op) && op.statements.length === 0);
  if (unscripted.length > 0 && options.comments !== false) {
    text.push(commentLine('Not scripted (change these manually):'));
    for (const op of unscripted) {
      const why = op.warnings.find((w) => w.code === 'unsupported')?.message ?? 'no statements';
      text.push(commentLine(`  ${describe(op, include)}: ${why}`));
    }
  }

  const missing = missingDependencies(diff, include === 'all' ? () => true : undefined);
  for (const m of missing) {
    warnings.push({
      code: 'missing-dependency',
      message: `${m.operationId} needs ${m.missing.join(', ')}, which ${m.missing.length === 1 ? 'is' : 'are'} not selected`,
    });
  }
  return {
    dialect: diff.dialect,
    statements: steps.map((s) => s.sql),
    steps,
    text: `${text
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`,
    transactional,
    backupRecommended: !pg && steps.length > 0,
    warnings,
    missingDependencies: missing,
    operationCount: operationIds.size,
  };
}
