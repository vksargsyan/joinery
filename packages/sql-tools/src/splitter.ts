import type { SqlDialect } from '@querybara/core';

import { Scanner } from './lexer';

/**
 * Statement splitting for Run all / Run statement at cursor / Run selection and Run SQL File
 * (spec §6). Handles MySQL DELIMITER, PostgreSQL dollar quoting and SQL-standard function bodies
 * (`BEGIN ATOMIC ... END`), nested comments and strings.
 */

export interface SqlStatement {
  /** The statement: from its first to its last significant token, without the delimiter. */
  readonly text: string;
  /** Offset of the first character; `source.slice(start, end) === text`. */
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
  /** 1-based line of `start`. */
  readonly line: number;
  /** 1-based column of `start`, in UTF-16 code units. */
  readonly column: number;
  /** The delimiter that ended it (`;`, `$$`...), or '' at the end of input or a DELIMITER line. */
  readonly delimiter: string;
}

/**
 * Splits a script into statements. Leading and trailing comments of a statement stay in the gap
 * between statements; comments inside it are kept. Statements with nothing but comments and
 * whitespace are skipped. MySQL executable comments (`/*!40101 ... *\/`) count as statements.
 *
 * MySQL/MariaDB honour the client `DELIMITER` command the way the mysql client does: first word
 * of a line, between statements (not after unterminated statement text).
 */
export function splitStatements(text: string, dialect: SqlDialect): SqlStatement[] {
  const splitter = new StatementSplitter(dialect);
  const statements = splitter.push(text);
  for (const statement of splitter.end()) statements.push(statement);
  return statements;
}

/**
 * The statement to run for "run statement at cursor": the one containing `offset`, or when the
 * cursor sits in the gap after a statement (on its delimiter, a trailing comment, blank lines),
 * that preceding statement. Before the first statement, the first one. Undefined only when
 * there are no statements. `statements` must be in order, as splitStatements returns them.
 */
export function statementAt(
  statements: readonly SqlStatement[],
  offset: number,
): SqlStatement | undefined {
  let low = 0;
  let high = statements.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (statements[mid]!.start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return statements[Math.max(found, 0)];
}

/** Text retained for pending statements, as the chunks it arrived in (no re-copying). */
class TextStore {
  private chunks: string[] = [];
  private starts: number[] = [];
  private head = 0;
  end = 0;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.starts.push(this.end);
    this.end += chunk.length;
  }

  slice(from: number, to: number): string {
    if (from >= to) return '';
    let index = this.chunks.length - 1;
    while (index > this.head && this.starts[index]! > from) index--;
    const first = this.chunks[index]!;
    const firstStart = this.starts[index]!;
    if (to <= firstStart + first.length) return first.slice(from - firstStart, to - firstStart);
    const parts = [first.slice(from - firstStart)];
    for (let i = index + 1; i < this.chunks.length; i++) {
      const start = this.starts[i]!;
      if (start >= to) break;
      const chunk = this.chunks[i]!;
      parts.push(to >= start + chunk.length ? chunk : chunk.slice(0, to - start));
    }
    return parts.join('');
  }

  /** Drops whole chunks that end at or before `offset`. */
  release(offset: number): void {
    while (this.head < this.chunks.length - 1) {
      const chunkEnd = this.starts[this.head]! + this.chunks[this.head]!.length;
      if (chunkEnd > offset) break;
      this.head++;
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.starts = this.starts.slice(this.head);
      this.head = 0;
    }
  }
}

/** Tracks 1-based line and column over text fed to it in order. */
class LineCounter {
  line = 1;
  column = 1;
  offset = 0;
  private afterCr = false;

  feed(text: string): void {
    this.offset += text.length;
    if (text.length === 0) return;
    if (!this.afterCr && !text.includes('\r')) {
      let lines = 0;
      let last = -1;
      let at = text.indexOf('\n');
      while (at >= 0) {
        lines++;
        last = at;
        at = text.indexOf('\n', at + 1);
      }
      if (lines === 0) {
        this.column += text.length;
      } else {
        this.line += lines;
        this.column = text.length - last;
      }
      return;
    }
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 10) {
        if (!this.afterCr) this.line++;
        this.column = 1;
        this.afterCr = false;
      } else if (code === 13) {
        this.line++;
        this.column = 1;
        this.afterCr = true;
      } else {
        this.column++;
        this.afterCr = false;
      }
    }
  }
}

/**
 * Incremental splitter for Run SQL File: push chunks as they are read, collect the statements
 * each push completes, then call `end()`. Results are identical to splitStatements on the
 * concatenated text however it is chunked. Memory stays bounded by the largest statement or
 * comment (plus a chunk): text before the pending statement is released once it is consumed.
 */
export class StatementSplitter {
  private readonly scanner: Scanner;
  private readonly postgres: boolean;
  private readonly store = new TextStore();
  private readonly lines = new LineCounter();
  private ended = false;

  private stmtStart = -1;
  private stmtEnd = -1;
  private stmtLine = 1;
  private stmtColumn = 1;

  // PostgreSQL body tracking, after psql: CREATE [OR REPLACE] FUNCTION|PROCEDURE ... BEGIN ...
  // END and CREATE [OR REPLACE] RULE ... DO ( ...; ... ) keep their inner semicolons.
  private words: string[] = [];
  private wordCount = 0;
  private routine = false;
  private rule = false;
  private parenDepth = 0;
  private beginDepth = 0;

  constructor(dialect: SqlDialect) {
    this.scanner = new Scanner(dialect);
    this.postgres = dialect === 'postgres';
  }

  /** Feeds the next chunk; returns the statements it completed. */
  push(chunk: string): SqlStatement[] {
    if (this.ended) throw new Error('StatementSplitter.push() called after end()');
    this.store.append(chunk);
    return this.run(false);
  }

  /** Signals the end of input; returns the remaining statements. */
  end(): SqlStatement[] {
    if (this.ended) return [];
    this.ended = true;
    return this.run(true);
  }

  private run(final: boolean): SqlStatement[] {
    const scanner = this.scanner;
    const resumeAt = scanner.resumeOffset;
    scanner.load(this.store.slice(resumeAt, this.store.end), resumeAt, final);
    const out: SqlStatement[] = [];
    for (;;) {
      const result = scanner.scan();
      if (result === 'more') break;
      if (result === 'eof') {
        this.emit(out, '');
        break;
      }
      switch (scanner.kind) {
        case 'whitespace':
        case 'line-comment':
        case 'block-comment':
          break;
        case 'client-command':
          this.emit(out, '');
          break;
        case 'delimiter':
          if (this.postgres && this.insideBody()) this.significant();
          else this.emit(out, scanner.delimiter);
          break;
        case 'word':
          this.significant();
          if (this.postgres) this.trackWord();
          break;
        case 'punctuation':
          this.significant();
          if (this.postgres) this.trackParen(scanner.tokenText());
          break;
        default:
          this.significant();
      }
    }
    this.releaseConsumed();
    return out;
  }

  private significant(): void {
    const scanner = this.scanner;
    if (this.stmtStart < 0) {
      this.stmtStart = scanner.start;
      this.advanceLinesTo(scanner.start);
      this.stmtLine = this.lines.line;
      this.stmtColumn = this.lines.column;
    }
    this.stmtEnd = scanner.end;
  }

  private emit(out: SqlStatement[], delimiter: string): void {
    if (this.stmtStart >= 0) {
      out.push({
        text: this.store.slice(this.stmtStart, this.stmtEnd),
        start: this.stmtStart,
        end: this.stmtEnd,
        line: this.stmtLine,
        column: this.stmtColumn,
        delimiter,
      });
    }
    this.stmtStart = -1;
    this.stmtEnd = -1;
    this.words = [];
    this.wordCount = 0;
    this.routine = false;
    this.rule = false;
    this.parenDepth = 0;
    this.beginDepth = 0;
  }

  private advanceLinesTo(offset: number): void {
    if (offset > this.lines.offset) this.lines.feed(this.store.slice(this.lines.offset, offset));
  }

  /** Lets go of text no pending statement or token can need again. */
  private releaseConsumed(): void {
    let keep = this.scanner.pendingTokenStart ?? this.scanner.resumeOffset;
    if (this.stmtStart >= 0) keep = Math.min(keep, this.stmtStart);
    this.advanceLinesTo(keep);
    this.store.release(keep);
  }

  private insideBody(): boolean {
    return this.beginDepth > 0 || (this.rule && this.parenDepth > 0);
  }

  private trackWord(): void {
    const scanner = this.scanner;
    if (this.wordCount < 4) {
      this.words.push(scanner.tokenText().toLowerCase());
      const [w0, w1, w2, w3] = this.words;
      const replace = w1 === 'or' && w2 === 'replace';
      this.routine =
        w0 === 'create' &&
        (w1 === 'function' ||
          w1 === 'procedure' ||
          (replace && (w3 === 'function' || w3 === 'procedure')));
      this.rule = w0 === 'create' && (w1 === 'rule' || (replace && w3 === 'rule'));
    }
    this.wordCount++;
    if (!this.routine || this.parenDepth !== 0) return;
    const length = scanner.end - scanner.start;
    if (length < 3 || length > 5) return;
    const lower = scanner.tokenText().toLowerCase();
    if (lower === 'begin') this.beginDepth++;
    else if (lower === 'case' && this.beginDepth > 0) this.beginDepth++;
    else if (lower === 'end' && this.beginDepth > 0) this.beginDepth--;
  }

  private trackParen(text: string): void {
    if (text === '(') this.parenDepth++;
    else if (text === ')' && this.parenDepth > 0) this.parenDepth--;
  }
}
