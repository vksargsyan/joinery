import { QuerybaraError, type CellValue, type QueryParams, type SqlDialect } from '@querybara/core';

import { tokenize } from './lexer';

/**
 * Query parameters (spec §6): `:name`, `$1` and `?` placeholders prompt for values before
 * running, then bind in the driver's native form (`$n` for pg, `?` for mysql2).
 */

export type ParameterStyle = 'named' | 'numbered' | 'positional';

export interface SqlParameter {
  /** `named` for `:name`, `numbered` for `$1`, `positional` for `?`. */
  readonly style: ParameterStyle;
  /** `name` for `:name`, `1` for `$1` (and `$01`), the 1-based ordinal among the `?`s for `?`. */
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface ParameterOptions {
  /**
   * Treat `?` as a placeholder. Defaults to true for MySQL/MariaDB and false for PostgreSQL,
   * where `?`, `?|` and `?&` are jsonb operators.
   */
  readonly questionMarks?: boolean;
}

export interface BoundQuery {
  /** The text with placeholders in the driver's native form. */
  readonly text: string;
  /** Values in native order: by `$n` for PostgreSQL, one per `?` for MySQL/MariaDB. */
  readonly values: CellValue[];
}

/**
 * Placeholders in `text`, in order. Strings, comments, quoted identifiers, dollar-quoted bodies,
 * PostgreSQL `::type` casts, `:=` assignments, MySQL `@variables` and `name:` labels are ignored.
 */
export function findParameters(
  text: string,
  dialect: SqlDialect,
  options?: ParameterOptions,
): SqlParameter[] {
  const questionMarks = options?.questionMarks ?? dialect !== 'postgres';
  const found: SqlParameter[] = [];
  let ordinal = 0;
  for (const token of tokenize(text, dialect)) {
    if (token.kind === 'parameter') {
      const first = token.text.charCodeAt(0);
      if (first === 58 /* : */) {
        found.push({
          style: 'named',
          name: token.text.slice(1),
          start: token.start,
          end: token.end,
        });
      } else if (first === 36 /* $ */) {
        const name = String(Number.parseInt(token.text.slice(1), 10));
        found.push({ style: 'numbered', name, start: token.start, end: token.end });
      } else if (questionMarks) {
        found.push({
          style: 'positional',
          name: String(++ordinal),
          start: token.start,
          end: token.end,
        });
      }
    } else if (token.kind === 'operator' && questionMarks && token.text.includes('?')) {
      // PostgreSQL lexes `?` as an operator character; split out the lone ones (`=?` → `=`, ?),
      // leaving the jsonb operators `?|` and `?&` alone.
      for (let i = 0; i < token.text.length; i++) {
        if (token.text[i] !== '?') continue;
        const next = token.text[i + 1];
        if (next === '|' || next === '&') {
          i++;
          continue;
        }
        const start = token.start + i;
        found.push({ style: 'positional', name: String(++ordinal), start, end: start + 1 });
      }
    }
  }
  return found;
}

/**
 * The values to prompt for, in binding order: unique names in order of first use, unique `$n`
 * numbers ascending, or one entry per `?`. Throws a VALIDATION_FAILED QuerybaraError when the text
 * mixes placeholder styles.
 */
export function parameterNames(parameters: readonly SqlParameter[]): string[] {
  const style = styleOf(parameters);
  const names = [...new Set(parameters.map((parameter) => parameter.name))];
  if (style === 'numbered') names.sort((a, b) => Number(a) - Number(b));
  return names;
}

/**
 * Rewrites placeholders into the driver's native form and orders the values to match.
 *
 * - `:name` takes values by name (a record).
 * - `$n` takes an array (`values[n - 1]`) or a record keyed by the number (`{ '1': ... }`).
 * - `?` takes an array with exactly one value per `?` (or a record keyed by ordinal).
 *
 * PostgreSQL output numbers placeholders `$1..$k` compactly, reusing a number for a repeated name;
 * MySQL/MariaDB output has one `?` and one value per occurrence. Throws a VALIDATION_FAILED
 * QuerybaraError, with `position` set, for mixed styles, missing values or a wrong value count.
 */
export function bindParameters(
  text: string,
  dialect: SqlDialect,
  values: QueryParams | undefined,
  options?: ParameterOptions,
): BoundQuery {
  const parameters = findParameters(text, dialect, options);
  if (parameters.length === 0) return { text, values: [] };
  const style = styleOf(parameters);
  const order = parameterNames(parameters);
  const given = values ?? [];

  if (Array.isArray(given)) {
    if (style === 'named') {
      throw invalid(
        `Named parameters need values by name, e.g. { ${order[0]}: ... }`,
        parameters[0]!,
      );
    }
    if (style === 'positional' && given.length !== parameters.length) {
      throw invalid(
        `Expected ${parameters.length} parameter value${parameters.length === 1 ? '' : 's'}, got ${given.length}`,
        parameters[0]!,
      );
    }
  }

  const lookup = (name: string): CellValue | undefined => {
    if (Array.isArray(given)) return (given as readonly CellValue[])[Number(name) - 1];
    const record = given as Readonly<Record<string, CellValue>>;
    return Object.hasOwn(record, name) ? record[name] : undefined;
  };

  const missing = order.filter((name) => lookup(name) === undefined);
  if (missing.length > 0) {
    const label = (name: string): string =>
      style === 'named' ? `:${name}` : style === 'numbered' ? `$${name}` : `? #${name}`;
    const first = parameters.find((parameter) => parameter.name === missing[0])!;
    throw invalid(`Missing value for parameter ${missing.map(label).join(', ')}`, first);
  }

  const postgres = dialect === 'postgres';
  const native = new Map(order.map((name, index) => [name, index + 1]));
  const out: string[] = [];
  const bound: CellValue[] = postgres ? order.map((name) => lookup(name)!) : [];
  let last = 0;
  for (const parameter of parameters) {
    out.push(text.slice(last, parameter.start));
    if (postgres) {
      out.push(`$${native.get(parameter.name)!}`);
    } else {
      out.push('?');
      bound.push(lookup(parameter.name)!);
    }
    last = parameter.end;
  }
  out.push(text.slice(last));
  return { text: out.join(''), values: bound };
}

function styleOf(parameters: readonly SqlParameter[]): ParameterStyle | undefined {
  const first = parameters[0];
  if (!first) return undefined;
  const other = parameters.find((parameter) => parameter.style !== first.style);
  if (other) {
    throw invalid(
      `Cannot mix ${describeStyle(first.style)} and ${describeStyle(other.style)} placeholders in one statement`,
      other,
    );
  }
  return first.style;
}

function describeStyle(style: ParameterStyle): string {
  return style === 'named' ? ':name' : style === 'numbered' ? '$n' : '?';
}

function invalid(message: string, at: SqlParameter): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message, position: at.start });
}
