import { JoineryError, type ErrorCode } from '@joinery/core';

/**
 * Exit codes. Compare commands follow diff(1): 0 no differences, 1 differences, 2 trouble.
 * `test` exits 1 when a step fails. Ctrl+C exits 130 (128 + SIGINT), as shells expect.
 */
export const EXIT = {
  ok: 0,
  /** Differences found or remaining; a failed connection test. */
  differences: 1,
  /** Any error: bad arguments, connection or SQL failure, refused or unconfirmed statement. */
  error: 2,
  interrupted: 130,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error raised by the CLI itself (bad arguments, missing profile, refused confirmation).
 * It carries a JoineryError code so it prints like driver errors, with an optional hint.
 */
export class CliError extends JoineryError {
  constructor(message: string, options: { code?: ErrorCode; hint?: string; cause?: unknown } = {}) {
    super(
      {
        code: options.code ?? 'VALIDATION_FAILED',
        message,
        ...(options.hint !== undefined ? { hint: options.hint } : {}),
      },
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'CliError';
  }
}

/** Thrown when Ctrl+C stopped the work; the runner exits 130. */
export class InterruptedError extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'InterruptedError';
  }
}

/** The consumer of stdout went away (e.g. `| head`); the run stops quietly. */
export class BrokenPipeError extends Error {
  constructor() {
    super('Output closed');
    this.name = 'BrokenPipeError';
  }
}

/** Where an error happened in a script, for the "at statement" line and the caret. */
export interface StatementContext {
  /** 1-based index of the statement in the run. */
  readonly index: number;
  readonly text: string;
  /** 1-based line and column of the statement in its file. */
  readonly line?: number;
  readonly column?: number;
  readonly source?: string;
}

/**
 * The lines to print for an error: `error: <message>`, then detail, hint, SQLSTATE or engine
 * code, and for statement errors the statement location with a caret under the position.
 * Stack traces only with --verbose. Driver and storage errors never carry secret values, and
 * nothing here adds any.
 */
export function formatError(
  error: unknown,
  options: { verbose?: boolean; statement?: StatementContext } = {},
): string[] {
  const lines: string[] = [];
  if (error instanceof JoineryError) {
    lines.push(`error: ${error.message}`);
    if (error.detail) lines.push(...indentBlock('detail', error.detail));
    if (error.hint) lines.push(...indentBlock('hint', error.hint));
    const codes: string[] = [];
    if (error.sqlState) codes.push(`SQLSTATE ${error.sqlState}`);
    if (error.engineCode !== undefined && String(error.engineCode) !== error.sqlState) {
      codes.push(`code ${String(error.engineCode)}`);
    }
    if (error.position !== undefined) codes.push(`position ${error.position + 1}`);
    if (codes.length > 0) lines.push(`  ${codes.join(', ')}`);
  } else if (error instanceof Error) {
    lines.push(`error: ${error.message}`);
  } else {
    lines.push(`error: ${String(error)}`);
  }
  const statement = options.statement;
  if (statement) {
    const where =
      statement.line !== undefined
        ? ` (${statement.source ? `${statement.source}:` : 'line '}${statement.line}${statement.column !== undefined ? `:${statement.column}` : ''})`
        : '';
    lines.push(`  at statement ${statement.index}${where}`);
    const position = error instanceof JoineryError ? error.position : undefined;
    lines.push(...caretLines(statement.text, position));
  }
  if (options.verbose && error instanceof Error && error.stack && !(error instanceof CliError)) {
    lines.push(
      ...error.stack
        .split('\n')
        .slice(1)
        .map((line) => `  ${line.trim()}`),
    );
  }
  return lines;
}

function indentBlock(label: string, text: string): string[] {
  const [first = '', ...rest] = text.split(/\r?\n/);
  return [
    `  ${label}: ${first}`,
    ...rest.map((line) => `  ${' '.repeat(label.length + 2)}${line}`),
  ];
}

const EXCERPT_WIDTH = 100;

/**
 * The statement line holding the error position with a caret under it, psql style. Without a
 * position, the first line of the statement (shortened) so the reader can tell which one failed.
 */
export function caretLines(text: string, position: number | undefined): string[] {
  if (position === undefined || position < 0 || position > text.length) {
    const first = text.trimStart().split(/\r?\n/)[0] ?? '';
    const more = text.trim().includes('\n') || first.length > EXCERPT_WIDTH;
    return [`  ${clip(first, EXCERPT_WIDTH)}${more && first.length <= EXCERPT_WIDTH ? ' …' : ''}`];
  }
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const newline = text.indexOf('\n', position);
  const lineEnd = newline === -1 ? text.length : newline;
  const lineNumber = text.slice(0, lineStart).split('\n').length;
  let line = text.slice(lineStart, lineEnd).replace(/\r$/, '').replaceAll('\t', ' ');
  let column = position - lineStart;
  if (line.length > EXCERPT_WIDTH) {
    const start = Math.max(0, Math.min(column - EXCERPT_WIDTH / 2, line.length - EXCERPT_WIDTH));
    line = `${start > 0 ? '…' : ''}${line.slice(start, start + EXCERPT_WIDTH)}${start + EXCERPT_WIDTH < line.length ? '…' : ''}`;
    column = column - start + (start > 0 ? 1 : 0);
  }
  const prefix = `  LINE ${lineNumber}: `;
  return [`${prefix}${line}`, `${' '.repeat(prefix.length + column)}^`];
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}
