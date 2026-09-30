import { open } from 'node:fs/promises';

import { JoineryError, toErrorData, type ResolvedProfile, type Session } from '@joinery/core';
import { fileSource, gunzip, gzipSink, isGzip, type Sink } from '@joinery/transfer';

import { checkConfirmed } from '../common';
import { scriptConflicts } from '../sql/restore';
import type {
  BackupFormat,
  BackupProgress,
  BackupSummary,
  Logger,
  RestoreError,
  RestoreProgress,
  RestoreSummary,
  TransferStatus,
} from '../types';
import { Pacer, isCancel, queryRows } from '../util';
import { BytePipe, withoutUnknownSettings } from './pg-script';
import {
  mysqlEnvironment,
  mysqlOptionFile,
  nativeEndpoint,
  pgEnvironment,
  privateFolder,
  runTool,
} from './run';
import { chooseTool, detectNativeTools, serverFamily, type NativeTool } from './tools';

/**
 * Backups and restores with the native tools (spec §14): pg_dump in plain or custom format and
 * mysqldump (or mariadb-dump) scripts, restored with psql, pg_restore or the mysql client. The
 * tool streams through this process (stdout into the file, the file into stdin), so progress,
 * cancellation, gzip and the file grants work as for the app's own format.
 */

/** Native formats: SQL scripts, or PostgreSQL's custom archive (pg_restore). */
export type NativeFormat = Exclude<BackupFormat, 'jbak'> | 'custom';

export interface NativeCommon {
  /** The profile with secrets, pointing at a tunnel's local end when there is one. */
  readonly resolved: ResolvedProfile;
  readonly engine: string;
  readonly serverVersion: string;
  readonly database: string;
  /** Tools found earlier (default: look now). */
  readonly tools?: readonly NativeTool[];
  readonly signal?: AbortSignal;
  readonly onLog?: Logger;
  readonly progressIntervalMs?: number;
}

export interface NativeBackupOptions extends NativeCommon {
  readonly output: Sink;
  readonly format: NativeFormat;
  /** PostgreSQL schemas (default all). */
  readonly schemas?: readonly string[];
  /** Only these tables (PostgreSQL `schema.table`; MySQL names). */
  readonly tables?: readonly { readonly schema?: string; readonly name: string }[];
  readonly structure?: boolean;
  readonly data?: boolean;
  readonly grants?: boolean;
  readonly ownership?: boolean;
  readonly deferrable?: boolean;
  readonly onProgress?: (progress: BackupProgress) => void;
}

/** A pg_dump pattern that matches exactly this name. */
function pgPattern(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function toolFor(
  tools: readonly NativeTool[],
  task: Parameters<typeof chooseTool>[1],
  options: NativeCommon,
): { tool: NativeTool; warnings: string[] } {
  const choice = chooseTool(tools, task, options.engine, options.serverVersion);
  if (!choice.tool) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: choice.reason ?? 'No native tool fits this server',
      hint: 'Use the Joinery backup format, which needs no external tools',
    });
  }
  return { tool: choice.tool, warnings: choice.warnings };
}

function failure(tool: NativeTool, code: number | null, tail: readonly string[]): JoineryError {
  const lines = tail.filter((line) => /error|fatal|denied|unknown|failed/i.test(line));
  const shown = (lines.length > 0 ? lines : tail).slice(-5).join('\n');
  return new JoineryError({
    code: 'INTERNAL',
    message: `${tool.name} ended with exit code ${code ?? 'unknown'}${shown ? `: ${shown.split('\n')[0]}` : ''}`,
    ...(shown ? { detail: shown } : {}),
  });
}

export async function nativeBackup(options: NativeBackupOptions): Promise<BackupSummary> {
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const log = options.onLog ?? (() => undefined);
  const warnings: string[] = [];
  let bytes = 0;
  let status: TransferStatus = 'completed';
  let error: JoineryError | undefined;
  const pg = serverFamily(options.engine, options.serverVersion).family === 'postgres';
  const structure = options.structure !== false;
  const data = options.data !== false;
  const progress = (force = false): void => {
    if (!options.onProgress || !pacer.due(force)) return;
    options.onProgress({
      phase: 'Dumping',
      objectsDone: 0,
      objectsTotal: 0,
      rows: 0,
      bytes,
      elapsedMs: pacer.elapsedMs,
    });
  };
  const counted: Sink = {
    write: async (chunk) => {
      await options.output.write(chunk);
      bytes += chunk.length;
      progress();
    },
    close: () => options.output.close(),
    abort: (reason) => options.output.abort(reason),
  };
  const out: Sink = options.format === 'sql-gz' ? gzipSink(counted) : counted;
  const folder = await privateFolder();
  try {
    if (options.format === 'custom' && !pg) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'The custom format is PostgreSQL only',
      });
    }
    if (!structure && !data) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'Choose the structure, the data, or both',
      });
    }
    const tools = options.tools ?? (await detectNativeTools());
    const { tool, warnings: toolWarnings } = toolFor(tools, 'dump', options);
    for (const w of toolWarnings) {
      warnings.push(w);
      log('warning', w);
    }
    const endpoint = nativeEndpoint(options.resolved, options.database);
    let args: string[];
    let env: NodeJS.ProcessEnv;
    if (pg) {
      env = await pgEnvironment(endpoint, folder.path);
      args = [
        '--no-password',
        `--format=${options.format === 'custom' ? 'custom' : 'plain'}`,
        '--verbose',
      ];
      if (!structure) args.push('--data-only');
      if (!data) args.push('--schema-only');
      if (options.ownership !== true) args.push('--no-owner');
      if (options.grants !== true) args.push('--no-privileges');
      if (options.deferrable === true) args.push('--serializable-deferrable');
      for (const schema of options.schemas ?? []) args.push(`--schema=${pgPattern(schema)}`);
      // With --schema, pg_dump leaves extensions out even when the schema's tables use their
      // types; since 14 it can be told to keep them, as the Joinery format does.
      if ((options.schemas ?? []).length > 0 && tool.major >= 14) args.push('--extension=*');
      for (const table of options.tables ?? []) {
        args.push(
          `--table=${table.schema !== undefined ? `${pgPattern(table.schema)}.` : ''}${pgPattern(table.name)}`,
        );
      }
    } else {
      env = mysqlEnvironment();
      const server = serverFamily(options.engine, options.serverVersion);
      args = [
        await mysqlOptionFile(tool, endpoint, folder.path),
        '--single-transaction',
        '--hex-blob',
        '--no-tablespaces',
        '--default-character-set=utf8mb4',
        '--verbose',
      ];
      if (structure) args.push('--routines', '--events', '--triggers');
      else args.push('--no-create-info', '--skip-triggers');
      if (!data) args.push('--no-data');
      if (tool.family === 'mysql') {
        args.push('--set-gtid-purged=OFF');
        if (server.family === 'mariadb') args.push('--column-statistics=0');
      }
      args.push('--', options.database, ...(options.tables ?? []).map((t) => t.name));
    }
    log('info', `Running ${tool.name} ${tool.version} (${tool.path})`);
    const result = await runTool({
      tool,
      args,
      env,
      output: (chunk) => out.write(chunk),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onLine: (line) => log(/warning/i.test(line) ? 'warning' : 'info', line),
    });
    if (result.code !== 0) throw failure(tool, result.code, result.tail);
    await out.close();
  } catch (caught) {
    status = isCancel(caught, options.signal) ? 'cancelled' : 'failed';
    error = caught instanceof JoineryError ? caught : new JoineryError(toErrorData(caught));
    await out.abort(caught).catch(() => undefined);
  } finally {
    await folder.dispose();
  }
  progress(true);
  return {
    status,
    format: options.format,
    objects: 0,
    dataObjects: 0,
    rows: 0,
    bytesWritten: bytes,
    durationMs: pacer.elapsedMs,
    warnings,
    ...(error !== undefined && status === 'failed' ? { error: error.toJSON() } : {}),
  };
}

export interface NativeRestoreOptions extends NativeCommon {
  /** A session on the target, for the check of what the database already holds. */
  readonly session: Session;
  readonly path: string;
  readonly onError?: 'stop' | 'continue';
  /** PostgreSQL: one transaction (default true; stop on error only). */
  readonly singleTransaction?: boolean;
  /** `['database']` to run over a database that is not empty. */
  readonly confirmedConflicts?: readonly string[];
  readonly onProgress?: (progress: RestoreProgress) => void;
}

/** True when the file is a pg_dump custom-format archive. */
export async function isPgCustomArchive(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(5);
    await handle.read(head, 0, 5, 0);
    return head.toString('latin1') === 'PGDMP';
  } finally {
    await handle.close();
  }
}

export async function nativeRestore(options: NativeRestoreOptions): Promise<RestoreSummary> {
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const log = options.onLog ?? (() => undefined);
  const onError = options.onError ?? 'stop';
  const warnings: string[] = [];
  const errors: RestoreError[] = [];
  let bytes = 0;
  let totalBytes = 0;
  let status: TransferStatus = 'completed';
  let fatal: JoineryError | undefined;
  const pg = serverFamily(options.engine, options.serverVersion).family === 'postgres';
  const progress = (force = false): void => {
    if (!options.onProgress || !pacer.due(force)) return;
    options.onProgress({
      phase: 'Restoring',
      objectsDone: 0,
      objectsTotal: 0,
      rows: 0,
      statements: 0,
      failed: errors.length,
      bytes,
      ...(totalBytes > 0 ? { totalBytes } : {}),
      elapsedMs: pacer.elapsedMs,
    });
  };
  const folder = await privateFolder();
  try {
    checkConfirmed(await scriptConflicts(options.session), options.confirmedConflicts);
    const handle = await open(options.path, 'r');
    const head = Buffer.alloc(5);
    try {
      totalBytes = (await handle.stat()).size;
      await handle.read(head, 0, 5, 0);
    } finally {
      await handle.close();
    }
    const custom = head.toString('latin1') === 'PGDMP';
    const gzip = isGzip(head);
    const tools = options.tools ?? (await detectNativeTools());
    const { tool, warnings: toolWarnings } = toolFor(tools, 'restore-script', options);
    for (const w of toolWarnings) {
      warnings.push(w);
      log('warning', w);
    }
    const endpoint = nativeEndpoint(options.resolved, options.database);
    const raw = fileSource(options.path);
    const counted: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of raw) {
          bytes += chunk.length;
          progress();
          yield chunk;
        }
      },
    };
    const onLine = (line: string): void => {
      const isError = /\bERROR\b|pg_restore: error/i.test(line);
      if (isError && errors.length < 1000) errors.push({ message: line });
      log(isError ? 'error' : /warning/i.test(line) ? 'warning' : 'info', line);
    };
    const signal = options.signal !== undefined ? { signal: options.signal } : {};
    let args: string[];
    let env: NodeJS.ProcessEnv;
    let input: AsyncIterable<Uint8Array> = gzip && !custom ? gunzip(counted) : counted;
    let producer: Promise<unknown> | undefined;
    let pipe: BytePipe | undefined;
    if (pg) {
      env = await pgEnvironment(endpoint, folder.path);
      const single = onError === 'stop' && options.singleTransaction !== false;
      args = [
        '--no-password',
        '-X',
        '-q',
        '-v',
        `ON_ERROR_STOP=${onError === 'stop' ? 1 : 0}`,
        ...(single ? ['--single-transaction'] : []),
        '--file=-',
      ];
      if (custom) {
        // pg_restore turns the archive into a script that psql runs, so both kinds of backup
        // go through the same filter and the same error handling.
        const archiveTool = toolFor(tools, 'restore-archive', options).tool;
        const script = new BytePipe();
        pipe = script;
        log('info', `Running ${archiveTool.name} ${archiveTool.version} (${archiveTool.path})`);
        producer = runTool({
          tool: archiveTool,
          args: ['--no-owner', '--file=-'],
          env,
          input: counted,
          output: (chunk) => script.write(chunk),
          ...signal,
          onLine,
        }).then(
          (result) => {
            script.end(
              result.code === 0 ? undefined : failure(archiveTool, result.code, result.tail),
            );
            return result;
          },
          (error: unknown) => script.end(error),
        );
        input = script;
      }
      const known = new Set(
        (await queryRows(options.session, 'SELECT name FROM pg_catalog.pg_settings')).map((row) =>
          String(row[0]),
        ),
      );
      input = withoutUnknownSettings(input, known, (setting) => {
        const message = `Skipped SET ${setting}: the server does not have this setting`;
        if (!warnings.includes(message)) {
          warnings.push(message);
          log('warning', message);
        }
      });
    } else {
      env = mysqlEnvironment();
      args = [
        await mysqlOptionFile(tool, endpoint, folder.path),
        '--default-character-set=utf8mb4',
        ...(onError === 'continue' ? ['--force'] : []),
        '--',
        options.database,
      ];
    }
    log('info', `Running ${tool.name} ${tool.version} (${tool.path})`);
    const result = await runTool({ tool, args, env, input, ...signal, onLine }).finally(() =>
      pipe?.end(),
    );
    await producer;
    if (result.code !== 0 && !(onError === 'continue' && errors.length > 0)) {
      status = 'failed';
      if (errors.length === 0) fatal = failure(tool, result.code, result.tail);
    }
  } catch (caught) {
    status = isCancel(caught, options.signal) ? 'cancelled' : 'failed';
    fatal = caught instanceof JoineryError ? caught : new JoineryError(toErrorData(caught));
  } finally {
    await folder.dispose();
  }
  progress(true);
  return {
    status,
    objects: 0,
    rows: 0,
    statements: 0,
    failed: errors.length,
    errors,
    warnings,
    durationMs: pacer.elapsedMs,
    ...(fatal !== undefined && status === 'failed' ? { error: fatal.toJSON() } : {}),
  };
}
