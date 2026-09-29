import { createReadStream, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  JoineryError,
  type CellValue,
  type ResultChunk,
  type Session,
  type SqlDialect,
} from '@joinery/core';
import {
  StatementSplitter,
  analyzeStatement,
  splitStatements,
  bindParameters,
  decideSafety,
  findParameters,
  parameterNames,
  type SqlStatement,
} from '@joinery/sql-tools';

import { cancellable, closeQuietly } from '../connect';
import type { Prompter } from '../context';
import {
  BrokenPipeError,
  CliError,
  EXIT,
  InterruptedError,
  formatError,
  type ExitCode,
} from '../errors';
import { createResultWriter, type OutputFormat, type ResultWriter } from '../output/formats';
import { formatDuration, openTarget, plural, type Runtime } from '../runtime';
import { confirmStatement, type ConfirmState } from '../safety';
import type { TargetOverrides } from '../target';

export interface QueryOptions extends TargetOverrides {
  /** -e: SQL text. */
  readonly execute?: string;
  /** -f: a .sql file, or '-' for stdin. */
  readonly file?: string;
  readonly format: OutputFormat;
  /** --param name=value, in order (later values win). */
  readonly params: readonly (readonly [string, string])[];
  /** --continue: keep going after a failed statement (default: stop). */
  readonly continueOnError: boolean;
  /** Rows to print per result set; 0 prints all. */
  readonly rowLimit: number;
  readonly maxColumnWidth?: number;
  /** --yes: run statements that need confirmation without asking. */
  readonly yes: boolean;
  /** --error-log: failed statements and their errors are written here. */
  readonly errorLog?: string;
}

/** Where the SQL comes from. */
interface ScriptInput {
  /** For progress and error locations: the file name, '(stdin)' or '-e'. */
  readonly name: string;
  readonly chunks: AsyncIterable<string>;
  /** Size in bytes, when known (files), for the progress percentage. */
  readonly size?: number;
  readonly bytesRead: () => number;
  /** The SQL is read from stdin, so stdin cannot answer prompts. */
  readonly fromStdin: boolean;
  /** -e text: short, no progress line. */
  readonly inline: boolean;
}

const READ_CHUNK_BYTES = 256 * 1024;
/** Commands whose row count is worth reporting even when it is 0. */
const DML = /^(INSERT|UPDATE|DELETE|MERGE|REPLACE|COPY|LOAD)\b/i;

/**
 * `joinery query <target>`: runs SQL statement by statement (spec §6, "Run SQL File"). Files
 * and stdin stream through StatementSplitter, so memory stays flat for large dumps; results
 * stream to stdout in the chosen format; the safety policy gates risky statements; Ctrl+C
 * cancels the running statement through the session. Exit 0 when every statement ran, 2 when
 * one failed or was refused, 130 when interrupted.
 */
export async function queryCommand(
  runtime: Runtime,
  spec: string,
  options: QueryOptions,
): Promise<ExitCode> {
  const input = scriptInput(runtime, options);
  const { reporter, interrupts, ctx } = runtime;
  const connection = await openTarget(runtime, spec, options);
  const { session, target, dialect } = connection;
  const prompter = input.fromStdin ? nonInteractive() : ctx.prompter;
  const writer = createResultWriter(options.format, runtime.stdout, {
    ...(runtime.stdout.isTTY && runtime.stdout.columns ? { width: runtime.stdout.columns } : {}),
    ...(options.maxColumnWidth !== undefined ? { maxColumnWidth: options.maxColumnWidth } : {}),
  });
  const params: Record<string, CellValue> = Object.fromEntries(options.params);
  const confirm: ConfirmState = { yesToAll: false };
  const errorLog = options.errorLog ? resolve(ctx.cwd, options.errorLog) : undefined;
  if (errorLog) writeFileSync(errorLog, '');
  const started = ctx.now();
  let index = 0;
  let failures = 0;

  // A single -e statement reports without a [n] prefix.
  const inlineCount =
    options.execute !== undefined ? splitStatements(options.execute, dialect).length : undefined;
  const runner = new StatementRunner(runtime, session, writer, options);
  try {
    for await (const statement of splitStream(input.chunks, dialect)) {
      interrupts.throwIfInterrupted();
      index++;
      if (!input.inline) {
        const percent = input.size ? ` ${Math.floor((input.bytesRead() / input.size) * 100)}%` : '';
        reporter.progress(
          `${input.name}:${percent} · statement ${index.toLocaleString('en-US')} · ${formatDuration(ctx.now() - started)}`,
        );
      }
      const prefix = inlineCount === 1 ? '' : `[${index}] `;
      try {
        const analysis = analyzeStatement(statement.text, dialect);
        await confirmStatement(
          decideSafety(analysis, target.policy),
          { index, text: statement.text },
          target,
          { yes: options.yes, prompter, reporter, state: confirm },
        );
        const bound =
          options.params.length > 0
            ? await bind(statement.text, dialect, params, prompter)
            : { text: statement.text, values: [] };
        await runner.run(bound.text, bound.values, prefix);
      } catch (error) {
        if (error instanceof InterruptedError || error instanceof BrokenPipeError) throw error;
        failures++;
        const context = {
          index,
          text: statement.text,
          line: statement.line,
          column: statement.column,
          ...(input.inline ? {} : { source: input.name }),
        };
        reporter.error(formatError(error, { verbose: reporter.verbose, statement: context }));
        if (errorLog) {
          const message = error instanceof Error ? error.message : String(error);
          appendFileSync(
            errorLog,
            `-- statement ${index} (${input.name}:${statement.line}:${statement.column})\n-- error: ${message.replace(/\n/g, ' ')}\n${statement.text}\n\n`,
          );
        }
        if (!options.continueOnError) break;
      }
    }
  } finally {
    reporter.clearProgress();
    if (session.inTransaction && !interrupts.interrupted) {
      reporter.warn('A transaction was left open; it was rolled back');
      await (session.rollback ? session.rollback() : Promise.resolve()).catch(() => undefined);
    }
    await closeQuietly(connection);
  }
  if (index > 1 || !input.inline) {
    reporter.info(
      `Ran ${plural(index, 'statement')} in ${formatDuration(ctx.now() - started)}${failures > 0 ? `, ${failures} failed` : ''}`,
    );
  }
  if (index === 0 && failures === 0) reporter.info('No statements to run');
  return failures > 0 ? EXIT.error : EXIT.ok;
}

/** Runs one statement and streams its results to the writer. */
class StatementRunner {
  constructor(
    private readonly runtime: Runtime,
    private readonly session: Session,
    private readonly writer: ResultWriter,
    private readonly options: QueryOptions,
  ) {}

  async run(text: string, values: readonly CellValue[], prefix: string): Promise<void> {
    const session = this.session;
    const started = this.runtime.ctx.now();
    const outcome = await cancellable(this.runtime.interrupts, session, (execution) =>
      this.#consume(
        session.execute(text, { ...execution, ...(values.length > 0 ? { params: values } : {}) }),
      ),
    );
    const time = formatDuration(outcome.durationMs ?? this.runtime.ctx.now() - started);
    const { reporter } = this.runtime;
    if (outcome.resultSets > 0) {
      const limit = outcome.limitReached
        ? ` (row limit ${this.options.rowLimit.toLocaleString('en-US')} reached; more rows not shown)`
        : '';
      reporter.info(`${prefix}${plural(outcome.rows, 'row')}${limit} · ${time}`);
    } else {
      const status = outcome.status;
      const count = status?.rowsAffected ?? null;
      const affected =
        count !== null && (count > 0 || DML.test(status?.command ?? ''))
          ? ` · ${plural(count, 'row')} affected`
          : '';
      reporter.info(`${prefix}${status?.command ?? 'OK'}${affected} · ${time}`);
    }
  }

  async #consume(chunks: AsyncIterable<ResultChunk>): Promise<{
    resultSets: number;
    rows: number;
    limitReached: boolean;
    status: Extract<ResultChunk, { type: 'status' }> | undefined;
    durationMs: number | undefined;
  }> {
    const { rowLimit } = this.options;
    const { reporter, stdout } = this.runtime;
    let open = false;
    let resultSets = 0;
    let rows = 0;
    let inSet = 0;
    let full = false;
    let limitReached = false;
    let status: Extract<ResultChunk, { type: 'status' }> | undefined;
    let durationMs: number | undefined;
    try {
      consume: for await (const chunk of chunks) {
        switch (chunk.type) {
          case 'columns':
            if (open) await this.writer.end();
            if (stdout.isTTY) reporter.clearProgress();
            await this.writer.begin(chunk.columns);
            open = true;
            resultSets++;
            inSet = 0;
            full = false;
            break;
          case 'rows': {
            if (!open || chunk.rowCount === 0) break;
            if (full) {
              limitReached = true;
              break consume;
            }
            let take = chunk.rowCount;
            let data = chunk.data;
            if (rowLimit > 0 && inSet + take > rowLimit) {
              take = rowLimit - inSet;
              data = data.map((column) => column.slice(0, take));
              limitReached = true;
            }
            if (stdout.isTTY) reporter.clearProgress();
            await this.writer.rows(data, take);
            inSet += take;
            rows += take;
            if (limitReached) break consume;
            if (rowLimit > 0 && inSet >= rowLimit) full = true;
            break;
          }
          case 'status':
            status = chunk;
            break;
          case 'notice':
            reporter.print(`${chunk.severity.toUpperCase()}: ${chunk.message}`);
            break;
          case 'end':
            durationMs = chunk.durationMs;
            break;
        }
      }
    } finally {
      if (open) await this.writer.end().catch(() => undefined);
    }
    return { resultSets, rows, limitReached, status, durationMs };
  }
}

/** Binds --param values, asking for missing ones when there is a terminal. */
async function bind(
  text: string,
  dialect: SqlDialect,
  params: Record<string, CellValue>,
  prompter: Prompter,
): Promise<{ text: string; values: CellValue[] }> {
  const found = findParameters(text, dialect);
  if (found.length === 0) return { text, values: [] };
  if (prompter.interactive) {
    const styles = new Map(found.map((p) => [p.name, p.style]));
    for (const name of parameterNames(found)) {
      if (Object.hasOwn(params, name)) continue;
      const style = styles.get(name);
      const shown =
        style === 'named' ? `:${name}` : style === 'numbered' ? `$${name}` : `? #${name}`;
      params[name] = await prompter.text(`Value for ${shown}: `);
    }
  }
  return bindParameters(text, dialect, params);
}

/** Streams statements out of text chunks (StatementSplitter keeps memory bounded). */
export async function* splitStream(
  chunks: AsyncIterable<string>,
  dialect: SqlDialect,
): AsyncGenerator<SqlStatement> {
  const splitter = new StatementSplitter(dialect);
  let first = true;
  for await (let chunk of chunks) {
    if (first) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      first = false;
    }
    yield* splitter.push(chunk);
  }
  yield* splitter.end();
}

function scriptInput(runtime: Runtime, options: QueryOptions): ScriptInput {
  const { ctx } = runtime;
  if (options.execute !== undefined && options.file !== undefined) {
    throw new CliError('Pass either -e <sql> or -f <file>, not both');
  }
  if (options.execute !== undefined) {
    const text = options.execute;
    return {
      name: '-e',
      chunks: (async function* () {
        yield text;
      })(),
      bytesRead: () => 0,
      fromStdin: false,
      inline: true,
    };
  }
  if (options.file !== undefined && options.file !== '-') {
    const path = resolve(ctx.cwd, options.file);
    let size: number;
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) throw new CliError(`${options.file} is a directory, not a SQL file`);
      size = stat.size;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        `Cannot read ${options.file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        {
          code: 'NOT_FOUND',
        },
      );
    }
    let stream: ReturnType<typeof createReadStream> | undefined;
    return {
      name: options.file,
      // Opened on first read, so a failed connection leaves no file handle behind.
      chunks: (async function* () {
        stream = createReadStream(path, { encoding: 'utf8', highWaterMark: READ_CHUNK_BYTES });
        for await (const chunk of stream) yield String(chunk);
      })(),
      size,
      bytesRead: () => stream?.bytesRead ?? 0,
      fromStdin: false,
      inline: false,
    };
  }
  if (ctx.stdin.isTTY && options.file === undefined) {
    throw new CliError('No SQL to run', {
      hint: 'Pass -e "<sql>", -f <file>, or pipe SQL into stdin',
    });
  }
  let bytes = 0;
  const stdin = ctx.stdin;
  return {
    name: '(stdin)',
    chunks: (async function* () {
      const decoder = new StringDecoder('utf8');
      for await (const chunk of stdin) {
        if (typeof chunk === 'string') {
          bytes += Buffer.byteLength(chunk);
          yield chunk;
        } else {
          bytes += chunk.length;
          yield decoder.write(chunk);
        }
      }
      const rest = decoder.end();
      if (rest) yield rest;
    })(),
    bytesRead: () => bytes,
    fromStdin: true,
    inline: false,
  };
}

/** A prompter for runs whose stdin carries the SQL: nothing can be asked. */
function nonInteractive(): Prompter {
  const refuse = (): Promise<never> =>
    Promise.reject(
      new JoineryError({
        code: 'CONFIRMATION_REQUIRED',
        message: 'Cannot prompt while reading SQL from stdin',
      }),
    );
  return { interactive: false, secret: refuse, text: refuse, confirm: refuse };
}
