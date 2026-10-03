import {
  requiresWriteConfirmation,
  type ConnectionProfile,
  type SqlDialect,
} from '@querybara/core';

import { isTrivia, tokenize, type TokenKind } from './lexer';

/**
 * The safety check before running (spec §6): DELETE or UPDATE without WHERE, DROP and TRUNCATE
 * ask for confirmation; on production profiles every write asks; read-only profiles refuse
 * writes. Token-based, no full parser: it classifies by leading keywords and looks for WHERE at
 * the statement's own parenthesis depth.
 */

export type StatementKind =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'merge'
  | 'ddl'
  | 'dcl'
  | 'transaction'
  | 'session'
  | 'explain'
  | 'call'
  | 'other';

export type StatementRisk =
  | 'update-without-where'
  | 'delete-without-where'
  /** DROP of an object, ALTER ... DROP COLUMN/PARTITION, MariaDB CREATE OR REPLACE TABLE. */
  | 'drop'
  /** TRUNCATE, ALTER TABLE ... TRUNCATE PARTITION. */
  | 'truncate'
  | 'alter'
  /** EXPLAIN ANALYZE (MariaDB: ANALYZE) of a writing statement: it executes the write. */
  | 'explain-analyze'
  /** CALL, EXECUTE, PostgreSQL DO: the routine may write anything. */
  | 'unknown-effects'
  /** SELECT ... FOR UPDATE / FOR SHARE, LOCK TABLE(S). */
  | 'locks'
  /** SET GLOBAL / PERSIST, ALTER SYSTEM: server-wide settings. */
  | 'server-config';

export interface StatementAnalysis {
  /** The top-level command. Data-modifying CTEs are reflected in isWrite and risks, not here. */
  readonly kind: StatementKind;
  /**
   * Changes data, schema, permissions, locks or server state, or may (CALL). Unrecognised
   * statements count as writes so read-only profiles stay read-only.
   */
  readonly isWrite: boolean;
  readonly risks: readonly StatementRisk[];
}

/** Analyses one statement (as returned by splitStatements). */
export function analyzeStatement(text: string, dialect: SqlDialect): StatementAnalysis {
  const words = toWords(text, dialect);
  if (words.length === 0) return { kind: 'other', isWrite: false, risks: [] };
  return new Analyzer(words, dialect).statement(0, words.length);
}

export interface SafetyPolicy {
  /** Locked read-only profile: writes are refused. */
  readonly readOnly: boolean;
  /** Production profile: every write asks. */
  readonly production: boolean;
  /** The profile's own "ask before every write" switch. */
  readonly confirmWrites?: boolean;
}

/** Why a statement needs confirmation: a risk that always asks, or `write` under the policy. */
export type ConfirmationReason = StatementRisk | 'write';

export type SafetyDecision =
  | { readonly action: 'run' }
  | { readonly action: 'confirm'; readonly reasons: readonly ConfirmationReason[] }
  | { readonly action: 'refuse'; readonly reason: 'read-only' };

/** Risks that ask for confirmation on every profile. */
export const ALWAYS_CONFIRM: ReadonlySet<StatementRisk> = new Set<StatementRisk>([
  'update-without-where',
  'delete-without-where',
  'drop',
  'truncate',
  'explain-analyze',
]);

/** The policy a profile implies (spec §4: read-only lock, production, confirm writes). */
export function safetyPolicyFor(profile: ConnectionProfile): SafetyPolicy {
  return {
    readOnly: profile.presentation.readOnly,
    production: profile.presentation.environment === 'production',
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

/**
 * What to do before running one statement. For a script, decide per statement: any refusal
 * refuses the run, and the confirmations can be shown together.
 */
export function decideSafety(analysis: StatementAnalysis, policy: SafetyPolicy): SafetyDecision {
  if (policy.readOnly && analysis.isWrite) return { action: 'refuse', reason: 'read-only' };
  const reasons: ConfirmationReason[] = analysis.risks.filter((risk) => ALWAYS_CONFIRM.has(risk));
  if (analysis.isWrite && (policy.production || policy.confirmWrites === true)) {
    reasons.push('write');
  }
  return reasons.length > 0 ? { action: 'confirm', reasons } : { action: 'run' };
}

/** analyzeStatement + decideSafety. */
export function checkStatementSafety(
  text: string,
  dialect: SqlDialect,
  policy: SafetyPolicy,
): SafetyDecision {
  return decideSafety(analyzeStatement(text, dialect), policy);
}

interface Word {
  readonly kind: TokenKind;
  /** Upper-cased text for words, raw text otherwise. */
  readonly text: string;
  /** Parenthesis depth relative to the statement start. */
  readonly depth: number;
}

/**
 * Significant tokens with MySQL executable comments opened up: `/*!40101 SET x = 1 *\/` is
 * analysed as `SET x = 1`, since the server runs it.
 */
function toWords(text: string, dialect: SqlDialect): Word[] {
  const words: Word[] = [];
  let depth = 0;
  const visit = (source: string): void => {
    for (const token of tokenize(source, dialect)) {
      if (isTrivia(token.kind) || token.kind === 'client-command') continue;
      if (token.kind === 'executable-comment') {
        const body = /^\/\*M?!\d{0,6}([\s\S]*?)(?:\*\/)?$/.exec(token.text);
        if (body?.[1]) visit(body[1]);
        continue;
      }
      if (token.kind === 'punctuation' && token.text === ')') depth = Math.max(0, depth - 1);
      words.push({
        kind: token.kind,
        text: token.kind === 'word' ? token.text.toUpperCase() : token.text,
        depth,
      });
      if (token.kind === 'punctuation' && token.text === '(') depth++;
    }
  };
  visit(text);
  return words;
}

const READ: StatementAnalysis = { kind: 'select', isWrite: false, risks: [] };

const DML_START = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'VALUES',
  'TABLE',
  'REPLACE',
  'WITH',
]);

const DCL_OBJECTS = new Set(['USER', 'ROLE', 'GROUP']);

const TRANSACTION_WORDS = new Set([
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'ABORT',
  'END',
  'XA',
  'UNLOCK',
]);

const SESSION_WORDS = new Set([
  'USE',
  'RESET',
  'DISCARD',
  'DEALLOCATE',
  'PREPARE',
  'LISTEN',
  'UNLISTEN',
  'NOTIFY',
  'DECLARE',
  'FETCH',
  'MOVE',
  'CLOSE',
]);

const READ_ONLY_OTHER = new Set(['SHOW', 'HELP', 'CHECK', 'CHECKSUM', 'HANDLER']);

/** Words after ALTER TABLE ... DROP that remove structure, not data. */
const HARMLESS_DROP_TARGETS = new Set([
  'DEFAULT',
  'NOT',
  'CONSTRAINT',
  'INDEX',
  'KEY',
  'PRIMARY',
  'FOREIGN',
  'CHECK',
  'EXPRESSION',
  'IDENTITY',
  'TRIGGER',
]);

class Analyzer {
  constructor(
    private readonly words: readonly Word[],
    private readonly dialect: SqlDialect,
  ) {}

  /** Analyses words[from, to), a statement whose own tokens sit at depth words[from].depth. */
  statement(from: number, to: number): StatementAnalysis {
    let i = from;
    while (i < to && this.isPunct(i, '(')) i++;
    const first = i < to ? this.words[i] : undefined;
    if (!first) return other(false);
    if (first.kind !== 'word') return other(true);
    const depth = first.depth;
    const next = this.wordAt(i + 1, to);
    switch (first.text) {
      case 'SELECT':
        return this.select(i, to, depth);
      case 'VALUES':
      case 'TABLE':
        return READ;
      case 'WITH':
        return this.with(i + 1, to, depth);
      case 'INSERT':
      case 'REPLACE':
      case 'LOAD':
        return next === 'INDEX' ? other(true) : write('insert');
      case 'UPDATE':
        return this.filtered('update', i, to, depth);
      case 'DELETE':
        return this.filtered('delete', i, to, depth);
      case 'MERGE':
        return write('merge');
      case 'COPY':
        return this.copy(i, to, depth);
      case 'CREATE':
        return this.create(i + 1, to);
      case 'DROP':
        return write(DCL_OBJECTS.has(next ?? '') ? 'dcl' : 'ddl', 'drop');
      case 'ALTER':
        return this.alter(i + 1, to, depth);
      case 'TRUNCATE':
        return write('ddl', 'truncate');
      case 'RENAME':
        return next === 'USER' ? write('dcl') : write('ddl', 'alter');
      case 'COMMENT':
      case 'SECURITY':
      case 'IMPORT':
      case 'REFRESH':
        return write('ddl');
      case 'GRANT':
      case 'REVOKE':
      case 'REASSIGN':
        return write('dcl');
      case 'CALL':
      case 'EXECUTE':
      case 'EXEC':
        return write('call', 'unknown-effects');
      case 'DO':
        // PostgreSQL DO runs an anonymous code block; MySQL DO evaluates expressions.
        return this.dialect === 'postgres' ? write('call', 'unknown-effects') : other(false);
      case 'LOCK':
        return { kind: 'transaction', isWrite: true, risks: ['locks'] };
      case 'SET':
        return this.set(i + 1, to);
      case 'EXPLAIN':
      case 'DESCRIBE':
      case 'DESC':
        return this.explain(i + 1, to);
      case 'ANALYZE':
      case 'ANALYSE':
        return this.analyze(i + 1, to);
      default:
        break;
    }
    const transaction: StatementAnalysis = { kind: 'transaction', isWrite: false, risks: [] };
    if (first.text === 'BEGIN' && next === 'NOT') return write('call', 'unknown-effects');
    if (first.text === 'PREPARE' && next === 'TRANSACTION') return transaction;
    // START REPLICA and MySQL RESET MASTER/REPLICA/PERSIST administer the server.
    if (first.text === 'START') return next === 'TRANSACTION' ? transaction : other(true);
    if (first.text === 'RESET' && this.dialect !== 'postgres') return other(true);
    if (TRANSACTION_WORDS.has(first.text)) return transaction;
    if (SESSION_WORDS.has(first.text)) return { kind: 'session', isWrite: false, risks: [] };
    if (READ_ONLY_OTHER.has(first.text)) return other(false);
    // Anything else (VACUUM, OPTIMIZE, FLUSH, KILL, unknown commands) counts as a write.
    return other(true);
  }

  private select(from: number, to: number, depth: number): StatementAnalysis {
    let isWrite = false;
    const risks: StatementRisk[] = [];
    for (let i = from; i < to; i++) {
      const word = this.words[i]!;
      if (word.kind !== 'word') continue;
      if (word.text === 'INTO' && word.depth === depth) {
        // PostgreSQL SELECT INTO creates a table; MySQL INTO OUTFILE/DUMPFILE writes a server
        // file. MySQL INTO @var only assigns variables.
        const target = this.wordAt(i + 1, to);
        if (this.dialect === 'postgres' || target === 'OUTFILE' || target === 'DUMPFILE')
          isWrite = true;
      } else if (word.text === 'FOR') {
        const a = this.wordAt(i + 1, to);
        const b = this.wordAt(i + 2, to);
        if (
          a === 'UPDATE' ||
          a === 'SHARE' ||
          (a === 'NO' && b === 'KEY') ||
          (a === 'KEY' && b === 'SHARE')
        ) {
          isWrite = true;
          addRisk(risks, 'locks');
        }
      } else if (
        word.text === 'LOCK' &&
        this.wordAt(i + 1, to) === 'IN' &&
        this.wordAt(i + 2, to) === 'SHARE'
      ) {
        isWrite = true;
        addRisk(risks, 'locks');
      }
    }
    return { kind: 'select', isWrite, risks };
  }

  /** WITH [RECURSIVE] name AS (body), ... main: the bodies may be data-modifying (PostgreSQL). */
  private with(from: number, to: number, depth: number): StatementAnalysis {
    let isWrite = false;
    const risks: StatementRisk[] = [];
    for (let i = from; i < to; i++) {
      const word = this.words[i]!;
      if (word.depth !== depth) continue;
      if (this.isPunct(i, '(')) {
        const previous = this.words[i - 1];
        const close = this.closing(i, to);
        if (previous?.text === 'AS' || previous?.text === 'MATERIALIZED') {
          const body = this.statement(i + 1, close);
          isWrite ||= body.isWrite;
          for (const risk of body.risks) addRisk(risks, risk);
        }
        i = close;
        continue;
      }
      if (word.kind === 'word' && DML_START.has(word.text) && word.text !== 'WITH') {
        const main = this.statement(i, to);
        for (const risk of main.risks) addRisk(risks, risk);
        return { kind: main.kind, isWrite: isWrite || main.isWrite, risks };
      }
    }
    return { kind: 'select', isWrite, risks };
  }

  /** UPDATE and DELETE: a WHERE at the statement's own depth, and not a tautology. */
  private filtered(
    kind: 'update' | 'delete',
    from: number,
    to: number,
    depth: number,
  ): StatementAnalysis {
    for (let i = from + 1; i < to; i++) {
      const word = this.words[i]!;
      if (
        word.depth === depth &&
        word.kind === 'word' &&
        word.text === 'WHERE' &&
        !this.tautology(i + 1, to, depth)
      ) {
        return write(kind);
      }
    }
    return write(kind, kind === 'update' ? 'update-without-where' : 'delete-without-where');
  }

  /** WHERE 1=1, WHERE TRUE, WHERE 1: filters nothing. */
  private tautology(from: number, to: number, depth: number): boolean {
    let end = from;
    while (end < to && !(this.words[end]!.depth === depth && isClauseEnd(this.words[end]!))) end++;
    const clause = this.words.slice(from, end).map((word) => word.text);
    if (clause.length === 1) return clause[0] === 'TRUE' || clause[0] === '1';
    return (
      clause.length === 3 &&
      clause[1] === '=' &&
      clause[0] === clause[2] &&
      /^\d+$/.test(clause[0]!)
    );
  }

  /** PostgreSQL COPY: FROM loads rows; TO STDOUT reads; TO 'file' / PROGRAM writes on the server. */
  private copy(from: number, to: number, depth: number): StatementAnalysis {
    for (let i = from + 1; i < to; i++) {
      const word = this.words[i]!;
      if (word.depth !== depth || word.kind !== 'word') continue;
      if (word.text === 'FROM') return write('insert');
      if (word.text === 'TO') {
        const target = this.wordAt(i + 1, to);
        return target === 'STDOUT' ? READ : { kind: 'select', isWrite: true, risks: [] };
      }
    }
    return other(true);
  }

  private create(from: number, to: number): StatementAnalysis {
    let i = from;
    let replace = false;
    if (this.wordAt(i, to) === 'OR' && this.wordAt(i + 1, to) === 'REPLACE') {
      replace = true;
      i += 2;
    }
    while (['TEMPORARY', 'TEMP', 'UNLOGGED', 'GLOBAL', 'LOCAL'].includes(this.wordAt(i, to) ?? ''))
      i++;
    const object = this.wordAt(i, to) ?? '';
    if (DCL_OBJECTS.has(object)) return write('dcl');
    // MariaDB CREATE OR REPLACE TABLE/DATABASE drops the existing one first.
    if (replace && ['TABLE', 'DATABASE', 'SCHEMA', 'SEQUENCE'].includes(object))
      return write('ddl', 'drop');
    return write('ddl');
  }

  private alter(from: number, to: number, depth: number): StatementAnalysis {
    const object = this.wordAt(from, to) ?? '';
    if (object === 'SYSTEM') return { kind: 'other', isWrite: true, risks: ['server-config'] };
    const risks: StatementRisk[] = ['alter'];
    for (let i = from + 1; i < to; i++) {
      const word = this.words[i]!;
      if (word.depth !== depth || word.kind !== 'word') continue;
      const next = i + 1 < to ? this.words[i + 1] : undefined;
      const target = next?.kind === 'word' ? next.text : undefined;
      const namesColumn =
        next?.kind === 'quoted-identifier' ||
        (target !== undefined && !HARMLESS_DROP_TARGETS.has(target));
      if (word.text === 'DROP' && namesColumn) addRisk(risks, 'drop');
      if (word.text === 'TRUNCATE' && target === 'PARTITION') addRisk(risks, 'truncate');
    }
    return { kind: DCL_OBJECTS.has(object) ? 'dcl' : 'ddl', isWrite: true, risks };
  }

  private set(from: number, to: number): StatementAnalysis {
    const first = this.wordAt(from, to);
    if (first === 'TRANSACTION' || first === 'CONSTRAINTS')
      return { kind: 'transaction', isWrite: false, risks: [] };
    if (first === 'SESSION' && this.wordAt(from + 1, to) === 'CHARACTERISTICS') {
      return { kind: 'transaction', isWrite: false, risks: [] };
    }
    if (first === 'PASSWORD' || (first === 'DEFAULT' && this.wordAt(from + 1, to) === 'ROLE'))
      return write('dcl');
    for (let i = from; i < to; i++) {
      const word = this.words[i]!;
      const global =
        (word.kind === 'word' &&
          (word.text === 'GLOBAL' || word.text === 'PERSIST' || word.text === 'PERSIST_ONLY')) ||
        (word.kind === 'variable' && /^@@(global|persist|persist_only)\./i.test(word.text));
      if (global) return { kind: 'session', isWrite: true, risks: ['server-config'] };
    }
    return { kind: 'session', isWrite: false, risks: [] };
  }

  /**
   * EXPLAIN only plans, except EXPLAIN ANALYZE (PostgreSQL, MySQL 8), which runs the statement.
   * `EXPLAIN (ANALYZE false) ...` does not.
   */
  private explain(from: number, to: number): StatementAnalysis {
    let analyze = false;
    let i = from;
    if (this.isPunct(i, '(')) {
      const close = this.closing(i, to);
      for (let j = i + 1; j < close; j++) {
        if (this.words[j]!.text !== 'ANALYZE' && this.words[j]!.text !== 'ANALYSE') continue;
        const value = this.words[j + 1]?.text;
        analyze = !(value === 'FALSE' || value === 'OFF' || value === '0');
      }
      i = close + 1;
    }
    for (; i < to; i++) {
      const word = this.words[i]!;
      if (word.kind === 'word' && DML_START.has(word.text)) break;
      if (word.text === 'ANALYZE' || word.text === 'ANALYSE') analyze = true;
    }
    if (!analyze || i >= to) return { kind: 'explain', isWrite: false, risks: [] };
    return this.executed(i, to);
  }

  /** MariaDB `ANALYZE [FORMAT=JSON] <statement>` runs it like EXPLAIN ANALYZE; otherwise statistics upkeep. */
  private analyze(from: number, to: number): StatementAnalysis {
    if (this.dialect !== 'mariadb') return other(true);
    for (let i = from; i < to; i++) {
      const word = this.words[i]!;
      if (word.kind !== 'word') continue;
      if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH'].includes(word.text)) {
        return this.executed(i, to);
      }
      if (word.text !== 'FORMAT' && word.text !== 'JSON' && word.text !== 'TRADITIONAL') break;
    }
    return other(true);
  }

  private executed(from: number, to: number): StatementAnalysis {
    const inner = this.statement(from, to);
    const risks = [...inner.risks];
    if (inner.isWrite) addRisk(risks, 'explain-analyze');
    return { kind: 'explain', isWrite: inner.isWrite, risks };
  }

  private wordAt(i: number, to: number): string | undefined {
    const word = i < to ? this.words[i] : undefined;
    return word?.kind === 'word' ? word.text : undefined;
  }

  private isPunct(i: number, text: string): boolean {
    const word = this.words[i];
    return word?.kind === 'punctuation' && word.text === text;
  }

  /** Index of the `)` matching the `(` at `open`, or `to` when unbalanced. */
  private closing(open: number, to: number): number {
    const depth = this.words[open]!.depth;
    for (let i = open + 1; i < to; i++) {
      if (this.words[i]!.depth === depth && this.isPunct(i, ')')) return i;
    }
    return to;
  }
}

function isClauseEnd(word: Word): boolean {
  return (
    (word.kind === 'word' &&
      ['ORDER', 'LIMIT', 'RETURNING', 'GROUP', 'HAVING', 'WINDOW'].includes(word.text)) ||
    word.kind === 'delimiter'
  );
}

function write(kind: StatementKind, ...risks: StatementRisk[]): StatementAnalysis {
  return { kind, isWrite: true, risks };
}

function other(isWrite: boolean): StatementAnalysis {
  return { kind: 'other', isWrite, risks: [] };
}

function addRisk(risks: StatementRisk[], risk: StatementRisk): void {
  if (!risks.includes(risk)) risks.push(risk);
}
