import { statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  createDatabase,
  currentDatabase,
  inspectBackup,
  nativeBackup,
  nativeRestore,
  planRestore,
  runBackup,
  runRestore,
  type BackupInspection,
  type BackupObject,
  type BackupObjectKind,
  type BackupProgress,
  type BackupSelection,
  type BackupSummary,
  type LogLevel,
  type ObjectRef,
  type RestoreConflict,
  type RestoreProgress,
  type RestoreSummary,
} from '@joinery/backup';
import {
  ENGINES,
  JoineryError,
  isSqlEngine,
  type EngineId,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { fileSink } from '@joinery/transfer';
import {
  connectThroughTransport,
  needsTransport,
  tunnelledProfile,
  type TransportSession,
} from '@joinery/tunnel';

import { closeQuietly, missingPasswordHint } from '../connect';
import { CliError, EXIT, InterruptedError, type ExitCode } from '../errors';
import { formatDuration, plural, targetFor, writeLine, type Runtime } from '../runtime';
import { confirmOperation } from '../safety';
import { resolvedProfile, withPassword, type Target, type TargetOverrides } from '../target';

/**
 * `joinery backup` and `joinery restore` (spec §14): the desktop job runner's @joinery/backup
 * engine on the command line, for PostgreSQL, MySQL, MariaDB, MongoDB and Redis. Progress goes
 * to stderr; `restore --list` prints an archive's objects on stdout.
 *
 * Archive passphrases never come from the command line: they are read from an environment
 * variable (--passphrase-env, default JOINERY_BACKUP_PASSPHRASE) or asked for without echo.
 * Restores follow the write rules: a read-only target refuses, production and "confirm writes"
 * profiles need --yes or a confirmation, and restoring over existing objects lists what is
 * dropped or overwritten and needs --yes or a confirmation every time.
 *
 * Exit codes: 0 done, 1 restored but statements failed (--continue), 2 failed, 130 interrupted.
 */

export const PASSPHRASE_ENV = 'JOINERY_BACKUP_PASSPHRASE';

/** The shortest passphrase a new encrypted backup accepts (the desktop wizard's rule too). */
export const MIN_PASSPHRASE_LENGTH = 8;

export type BackupFileFormat = 'jbak' | 'sql' | 'sql-gz' | 'custom';

export interface BackupOptions extends TargetOverrides {
  readonly out: string;
  /** Default: from the file's extension, else jbak. */
  readonly format?: BackupFileFormat;
  readonly encrypt: boolean;
  readonly passphraseEnv?: string;
  readonly compress: boolean;
  readonly native: boolean;
  readonly schemas: readonly string[];
  readonly tables: readonly string[];
  readonly excludeTables: readonly string[];
  readonly excludeData: readonly string[];
  readonly structure: boolean;
  readonly data: boolean;
  readonly grants: boolean;
  readonly ownership: boolean;
  readonly snapshot: boolean;
  readonly deferrable: boolean;
  readonly rowsPerInsert?: number;
  readonly collections: readonly string[];
  readonly documents?: 'bson' | 'ejson';
  readonly pattern?: string;
}

export interface RestoreOptions extends TargetOverrides {
  readonly file: string;
  readonly passphraseEnv?: string;
  /** Objects to restore: ids, qualified names or names (default everything). */
  readonly select: readonly string[];
  readonly structure: boolean;
  readonly data: boolean;
  readonly createDatabase: boolean;
  readonly native: boolean;
  readonly continueOnError: boolean;
  readonly replace: boolean;
  readonly keepExpiry: boolean;
  readonly list: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly errorLog?: string;
}

/** The format a file name suggests. */
export function formatFromName(file: string): BackupFileFormat {
  const name = file.toLowerCase();
  if (name.endsWith('.sql.gz') || name.endsWith('.gz')) return 'sql-gz';
  if (name.endsWith('.sql')) return 'sql';
  if (name.endsWith('.dump') || name.endsWith('.backup')) return 'custom';
  return 'jbak';
}

/**
 * `name` as an object reference: `schema.name` on PostgreSQL (the schema is left open when
 * there is no dot), a plain name elsewhere.
 */
export function objectRef(kind: BackupObjectKind, name: string, postgres: boolean): ObjectRef {
  const dot = name.indexOf('.');
  if (postgres && dot > 0) return { kind, schema: name.slice(0, dot), name: name.slice(dot + 1) };
  return { kind, name };
}

/** The --table, --exclude-table, --exclude-data and --schema flags as a backup selection. */
export function selectionOf(options: BackupOptions, postgres: boolean): BackupSelection {
  const refs = (names: readonly string[]): ObjectRef[] =>
    names.map((n) => objectRef('table', n, postgres));
  return {
    ...(options.schemas.length > 0 ? { schemas: [...options.schemas] } : {}),
    ...(options.tables.length > 0 ? { include: refs(options.tables) } : {}),
    ...(options.excludeTables.length > 0 ? { exclude: refs(options.excludeTables) } : {}),
    ...(options.excludeData.length > 0 ? { excludeData: refs(options.excludeData) } : {}),
  };
}

/**
 * The archive objects `--select` names: an object id (`table:public.orders`), a qualified name
 * (`public.orders`) or a plain name when only one object has it. Every name must match.
 */
export function selectObjects(
  objects: readonly BackupObject[],
  wanted: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const spec of wanted) {
    const byId = objects.find((o) => o.id === spec);
    const matches = byId
      ? [byId]
      : objects.filter(
          (o) => o.parent === undefined && (o.qualifiedName === spec || o.name === spec),
        );
    if (matches.length === 0) {
      throw new CliError(`The backup has no object "${spec}"`, {
        code: 'NOT_FOUND',
        hint: 'List the objects with --list',
      });
    }
    if (matches.length > 1 && !byId) {
      throw new CliError(`"${spec}" names ${matches.length} objects in the backup`, {
        hint: `Use one of the ids: ${matches.map((o) => o.id).join(', ')}`,
      });
    }
    for (const match of matches) if (!ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

/** One line per conflict, for the confirmation. */
export function describeConflicts(conflicts: readonly RestoreConflict[]): string[] {
  return conflicts.map((c) =>
    c.id === 'database'
      ? `  ${c.qualifiedName}: the script runs over them`
      : `  ${c.action === 'drop' ? 'drop and recreate' : c.action === 'append' ? 'add rows to' : 'overwrite'} ${c.kind} ${c.qualifiedName}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Shared

interface Opened {
  readonly session: Session;
  readonly target: Target;
  /** The profile with secrets, pointing at a tunnel's local end (for the native tools). */
  readonly resolved: ResolvedProfile;
  close(): Promise<void>;
}

/** Connects to any engine's target, asking for a password once when a login without one fails. */
async function openAny(
  runtime: Runtime,
  target: Target,
  overrides: TargetOverrides,
): Promise<Opened> {
  const open = (current: Target, engine: EngineId): Promise<TransportSession> => {
    const adapter = runtime.ctx.adapters(engine);
    return needsTransport(current.profile)
      ? connectThroughTransport(
          adapter,
          resolvedProfile(current),
          runtime.tunnels.manager(overrides.tunnel),
        )
      : adapter
          .connect(resolvedProfile(current))
          .then((session) => ({ session, close: () => session.close() }));
  };
  runtime.reporter.progress(`Connecting to ${target.label}…`, true);
  let current = target;
  let opened: TransportSession;
  try {
    try {
      opened = await open(current, current.profile.engine);
    } catch (error) {
      const refused = error instanceof JoineryError && error.code === 'AUTH_FAILED';
      if (!refused || current.passwordKnown) throw error;
      if (!runtime.ctx.prompter.interactive) {
        throw new CliError(error.message, {
          code: 'AUTH_FAILED',
          hint: missingPasswordHint(current),
          cause: error,
        });
      }
      current = withPassword(
        current,
        await runtime.ctx.prompter.secret(`Password for ${current.label}: `),
      );
      opened = await open(current, current.profile.engine);
    }
    if (current.profile.engine === 'mysql' && /mariadb/i.test(opened.session.serverVersion)) {
      // A mysql:// target that is MariaDB gets MariaDB's rules, as `joinery query` does.
      const first = opened;
      opened = await open(current, 'mariadb').finally(() => first.close().catch(() => undefined));
    }
  } finally {
    runtime.reporter.clearProgress();
  }
  const resolved = resolvedProfile(current);
  const transport = opened.transport;
  return {
    session: opened.session,
    target: current,
    resolved: transport ? tunnelledProfile(resolved, transport) : resolved,
    close: opened.close,
  };
}

/** The target with another default database (a restore into the database it created). */
function inDatabase(target: Target, database: string): Target {
  const { profile } = target;
  return {
    ...target,
    profile: { ...profile, options: { ...profile.options, defaultDatabase: database } },
  };
}

function withAbort<T>(runtime: Runtime, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return runtime.interrupts.guard(
    () => controller.abort(),
    () => work(controller.signal),
  );
}

function logTo(runtime: Runtime): (level: LogLevel, message: string) => void {
  return (level, message) => {
    if (level === 'info') runtime.reporter.debug(message);
    else runtime.reporter.warn(message);
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The archive passphrase from the environment, or asked for without echo (twice when it
 * encrypts a new backup). Never from the command line, which other users can see.
 */
async function passphrase(
  runtime: Runtime,
  variable: string | undefined,
  purpose: 'encrypt' | 'decrypt',
): Promise<string> {
  const name = variable ?? PASSPHRASE_ENV;
  const fromEnv = runtime.ctx.env[name];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (purpose === 'encrypt' && fromEnv.length < MIN_PASSPHRASE_LENGTH) {
      throw new CliError(
        `The passphrase in ${name} is shorter than ${MIN_PASSPHRASE_LENGTH} characters`,
      );
    }
    return fromEnv;
  }
  if (!runtime.ctx.prompter.interactive) {
    throw new CliError(
      purpose === 'encrypt'
        ? 'Encrypting the backup needs a passphrase'
        : 'The backup is encrypted and needs its passphrase',
      { code: 'AUTH_FAILED', hint: `Set ${name}, or run in a terminal to be asked` },
    );
  }
  const typed = await runtime.ctx.prompter.secret('Backup passphrase: ');
  if (purpose === 'decrypt') return typed;
  if (typed.length < MIN_PASSPHRASE_LENGTH) {
    throw new CliError(`The passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  if ((await runtime.ctx.prompter.secret('Passphrase again: ')) !== typed) {
    throw new CliError('The passphrases do not match');
  }
  return typed;
}

// ---------------------------------------------------------------------------------------------
// backup

function checkBackupOptions(
  options: BackupOptions,
  engine: EngineId,
  format: BackupFileFormat,
): void {
  const sql = isSqlEngine(engine);
  if (!sql && format !== 'jbak') {
    throw new CliError(
      `${ENGINES[engine].displayName} backups are Joinery archives (.jbak), not ${format}`,
      { hint: 'Leave --format out, or use --format jbak' },
    );
  }
  if (options.native && !sql) {
    throw new CliError('--native backs up PostgreSQL, MySQL and MariaDB only');
  }
  if (options.native && format === 'jbak') {
    throw new CliError('pg_dump and mysqldump do not write Joinery archives', {
      hint: 'Use --format sql, sql-gz or (PostgreSQL) custom',
    });
  }
  if (!options.native && format === 'custom') {
    throw new CliError('The custom format is written by pg_dump', { hint: 'Add --native' });
  }
  if (format === 'custom' && engine !== 'postgres') {
    throw new CliError('The custom format is PostgreSQL only');
  }
  if (options.encrypt && format !== 'jbak') {
    throw new CliError('Encryption needs the Joinery archive format (.jbak)');
  }
  if (!options.structure && !options.data) {
    throw new CliError('--schema-only and --data-only leave nothing to back up');
  }
}

function backupLine(progress: BackupProgress): string {
  return `${progress.phase}${progress.object !== undefined ? ` ${progress.object}` : ''} · ${plural(progress.rows, 'row')} · ${formatBytes(progress.bytes)} · ${formatDuration(progress.elapsedMs)}`;
}

/** `joinery backup`. */
export async function backupCommand(
  runtime: Runtime,
  spec: string,
  options: BackupOptions,
): Promise<ExitCode> {
  const { reporter, ctx } = runtime;
  const format = options.format ?? formatFromName(options.out);
  const path = resolve(ctx.cwd, options.out);
  const target = await targetFor(runtime, spec, options);
  const engine = target.profile.engine;
  checkBackupOptions(options, engine, format);
  const key = options.encrypt
    ? await passphrase(runtime, options.passphraseEnv, 'encrypt')
    : undefined;
  runtime.interrupts.throwIfInterrupted();
  const opened = await openAny(runtime, target, options);
  try {
    const { session } = opened;
    const postgres = session.engine === 'postgres';
    const common = {
      output: fileSink(path),
      onProgress: (progress: BackupProgress) => reporter.progress(backupLine(progress)),
      onLog: logTo(runtime),
    };
    const summary: BackupSummary = await withAbort(runtime, async (signal) => {
      if (options.native) {
        const selection = selectionOf(options, postgres);
        return nativeBackup({
          ...common,
          signal,
          resolved: opened.resolved,
          engine: session.engine,
          serverVersion: session.serverVersion,
          database: options.database ?? (await currentDatabase(session)),
          format: format === 'jbak' ? 'sql' : format,
          ...(selection.schemas !== undefined ? { schemas: selection.schemas } : {}),
          ...(selection.include !== undefined
            ? {
                tables: selection.include.map((ref) => ({
                  ...(ref.schema !== undefined ? { schema: ref.schema } : {}),
                  name: ref.name,
                })),
              }
            : {}),
          structure: options.structure,
          data: options.data,
          grants: options.grants,
          ownership: options.ownership,
          deferrable: options.deferrable,
        });
      }
      return runBackup({
        ...common,
        signal,
        session,
        format: format === 'custom' ? 'jbak' : format,
        producer: 'joinery-cli',
        compress: options.compress,
        ...(key !== undefined ? { encryption: { passphrase: key } } : {}),
        selection: selectionOf(options, postgres),
        structure: options.structure,
        data: options.data,
        grants: options.grants,
        ownership: options.ownership,
        consistent: options.snapshot,
        deferrable: options.deferrable,
        ...(options.rowsPerInsert !== undefined ? { rowsPerStatement: options.rowsPerInsert } : {}),
        ...(options.collections.length > 0 ? { collections: options.collections } : {}),
        ...(options.documents !== undefined ? { documentFormat: options.documents } : {}),
        ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
      });
    });
    reporter.clearProgress();
    for (const warning of summary.warnings) reporter.warn(warning);
    if (summary.status === 'cancelled') throw new InterruptedError();
    if (summary.status === 'failed') {
      throw summary.error
        ? new CliError(summary.error.message, {
            code: summary.error.code,
            ...(summary.error.hint !== undefined ? { hint: summary.error.hint } : {}),
          })
        : new CliError('The backup failed');
    }
    reporter.info(
      `Backed up ${plural(summary.objects, 'object')} and ${plural(summary.rows, engine === 'mongodb' ? 'document' : engine === 'redis' ? 'key' : 'row')} to ${basename(path)} (${formatBytes(summary.bytesWritten)}${key !== undefined ? ', encrypted' : ''}) in ${formatDuration(summary.durationMs)}`,
    );
    return EXIT.ok;
  } finally {
    reporter.clearProgress();
    await closeQuietly(opened);
  }
}

// ---------------------------------------------------------------------------------------------
// restore

function restoreLine(name: string, progress: RestoreProgress): string {
  const share =
    progress.totalBytes !== undefined && progress.totalBytes > 0
      ? ` ${Math.min(100, Math.floor((progress.bytes / progress.totalBytes) * 100))}%`
      : '';
  return `${name}:${share} ${progress.phase}${progress.object !== undefined ? ` ${progress.object}` : ''} · ${plural(progress.rows, 'row')}${progress.failed > 0 ? ` · ${progress.failed} failed` : ''} · ${formatDuration(progress.elapsedMs)}`;
}

function fileExists(runtime: Runtime, file: string): string {
  const path = resolve(runtime.ctx.cwd, file);
  try {
    if (statSync(path).isDirectory()) throw new CliError(`${file} is a folder, not a backup file`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read ${file}`, { code: 'NOT_FOUND' });
  }
  return path;
}

async function inspect(
  runtime: Runtime,
  path: string,
  options: RestoreOptions,
): Promise<{ readonly info: BackupInspection; readonly passphrase?: string }> {
  const info = await inspectBackup(path);
  if (info.format !== 'jbak' || !info.encrypted) return { info };
  const key = await passphrase(runtime, options.passphraseEnv, 'decrypt');
  return { info: await inspectBackup(path, key), passphrase: key };
}

async function listObjects(runtime: Runtime, info: BackupInspection): Promise<void> {
  const manifest = info.manifest;
  if (!manifest) {
    runtime.reporter.info(
      `${info.format === 'custom' ? 'A pg_dump custom archive' : 'A SQL script'}: no object list; it restores as a whole`,
    );
    return;
  }
  runtime.reporter.info(
    `${ENGINES[manifest.engine].displayName} ${manifest.serverVersion} · ${manifest.database} · ${manifest.createdAt}`,
  );
  for (const object of manifest.objects) {
    if (object.parent !== undefined) continue;
    const rows = object.data !== undefined ? `\t${object.data.count}` : '';
    await writeLine(runtime, `${object.id}\t${object.kind}\t${object.qualifiedName}${rows}`);
  }
}

function checkFits(engine: EngineId, info: BackupInspection): void {
  const from = info.engine;
  if (from === undefined) {
    if (!isSqlEngine(engine)) throw new CliError(`This file does not restore into ${engine}`);
    return;
  }
  const mysqlFamily = (e: EngineId): boolean => e === 'mysql' || e === 'mariadb';
  if (from !== engine && !(mysqlFamily(from) && mysqlFamily(engine))) {
    throw new CliError(
      `This is a ${ENGINES[from].displayName} backup; it does not restore into ${ENGINES[engine].displayName}`,
    );
  }
}

/** `joinery restore`. */
export async function restoreCommand(
  runtime: Runtime,
  spec: string,
  options: RestoreOptions,
): Promise<ExitCode> {
  const { reporter, ctx } = runtime;
  const path = fileExists(runtime, options.file);
  const name = basename(path);
  const { info, passphrase: key } = await inspect(runtime, path, options);
  if (options.list) {
    await listObjects(runtime, info);
    return EXIT.ok;
  }
  if (options.createDatabase && options.database === undefined) {
    throw new CliError('--create-database needs --database <name>');
  }
  const target = await targetFor(
    runtime,
    spec,
    options.createDatabase ? { ...options, database: undefined } : options,
  );
  const engine = target.profile.engine;
  checkFits(engine, info);
  if (target.policy.readOnly) {
    throw new CliError(`"${target.label}" is read-only, so nothing can be restored into it`, {
      code: 'READ_ONLY',
      hint: target.readOnlySource === 'flag' ? 'Leave out --read-only' : '',
    });
  }
  if (options.createDatabase && !isSqlEngine(engine)) {
    throw new CliError('--create-database works with PostgreSQL, MySQL and MariaDB');
  }
  const native = options.native || info.format === 'custom';
  if (native && (info.format === 'jbak' || !isSqlEngine(engine))) {
    throw new CliError('--native restores SQL scripts and pg_dump archives only');
  }
  const select =
    info.manifest && options.select.length > 0
      ? selectObjects(info.manifest.objects, options.select)
      : undefined;
  if (!info.manifest && options.select.length > 0) {
    throw new CliError('--select needs a Joinery archive (.jbak)');
  }

  runtime.interrupts.throwIfInterrupted();
  let opened = await openAny(runtime, target, options);
  try {
    if (options.createDatabase && options.database !== undefined) {
      if (!options.dryRun) {
        await confirmWrites(
          runtime,
          opened.target,
          options,
          `Create the database ${options.database} on ${opened.target.label} and restore ${name} into it?`,
        );
        await createDatabase(
          opened.session,
          options.database,
          info.manifest?.databaseOptions ?? {},
        );
        reporter.info(`Created the database ${options.database}`);
      }
      const next = inDatabase(opened.target, options.database);
      if (options.dryRun) {
        reporter.info(`Would create the database ${options.database} and restore ${name} into it`);
        return EXIT.ok;
      }
      await closeQuietly(opened);
      opened = await openAny(runtime, next, options);
    }
    const { session } = opened;
    const request = {
      session,
      path,
      ...(key !== undefined ? { passphrase: key } : {}),
      ...(select !== undefined ? { select } : {}),
      structure: options.structure,
      data: options.data,
      replace: options.replace,
    };
    const plan = await planRestore(request);
    for (const warning of plan.warnings) reporter.warn(warning);
    for (const skipped of plan.skipped)
      reporter.warn(`${skipped.id} is left out: ${skipped.reason}`);
    if (plan.added.length > 0) {
      reporter.info(`Also restored because others need them: ${plan.added.join(', ')}`);
    }
    if (options.dryRun) {
      reporter.info(
        plan.objects.length > 0
          ? `Would restore ${plural(plan.objects.length, 'object')} into ${opened.target.label}`
          : `Would run ${name} on ${opened.target.label}`,
      );
      for (const line of describeConflicts(plan.conflicts)) reporter.print(line);
      return EXIT.ok;
    }
    if (plan.conflicts.length > 0) {
      reporter.print(`Restoring ${name} changes what is there:`);
      for (const line of describeConflicts(plan.conflicts)) reporter.print(line);
      // Destructive: always confirmed, whatever the profile says.
      const script = plan.conflicts.find((c) => c.id === 'database');
      const question = script
        ? `Run ${name} over ${script.qualifiedName}?`
        : `Restore over ${plural(plan.conflicts.length, 'existing object')}?`;
      await confirmOperation(question, {
        yes: options.yes,
        prompter: ctx.prompter,
        reporter,
        hint: 'Pass --yes to restore over them, or --dry-run to see the plan',
      });
    } else if (!options.createDatabase) {
      await confirmWrites(
        runtime,
        opened.target,
        options,
        `Restore ${name} into ${opened.target.label}?`,
      );
    }
    const common = {
      onError: options.continueOnError ? ('continue' as const) : ('stop' as const),
      onProgress: (progress: RestoreProgress) => reporter.progress(restoreLine(name, progress)),
      onLog: logTo(runtime),
      confirmedConflicts: plan.conflicts.map((c) => c.id),
    };
    const summary: RestoreSummary = await withAbort(runtime, async (signal) =>
      native
        ? nativeRestore({
            ...common,
            signal,
            session,
            resolved: opened.resolved,
            engine: session.engine,
            serverVersion: session.serverVersion,
            database: options.database ?? (await currentDatabase(session)),
            path,
          })
        : runRestore({
            ...common,
            ...request,
            signal,
            absoluteTtl: options.keepExpiry,
          }),
    );
    reporter.clearProgress();
    for (const warning of summary.warnings) reporter.warn(warning);
    writeErrors(runtime, options.errorLog, summary);
    for (const error of summary.errors.slice(0, 10)) {
      reporter.print(
        `error: ${error.object !== undefined ? `${error.object}: ` : ''}${error.message}`,
      );
    }
    if (summary.errors.length > 10) {
      reporter.print(`… ${plural(summary.errors.length - 10, 'more error')}`);
    }
    if (summary.status === 'cancelled') throw new InterruptedError();
    if (summary.status === 'failed') {
      throw summary.error
        ? new CliError(summary.error.message, {
            code: summary.error.code,
            ...(summary.error.hint !== undefined ? { hint: summary.error.hint } : {}),
          })
        : new CliError('The restore failed and was rolled back where it could be');
    }
    reporter.info(
      `Restored ${name}: ${plural(summary.objects, 'object')}, ${plural(summary.rows, engine === 'mongodb' ? 'document' : engine === 'redis' ? 'key' : 'row')}${summary.failed > 0 ? `, ${summary.failed} failed` : ''} in ${formatDuration(summary.durationMs)}`,
    );
    return summary.failed > 0 ? EXIT.partial : EXIT.ok;
  } finally {
    reporter.clearProgress();
    await closeQuietly(opened);
  }
}

/** Production and "confirm writes" profiles ask once before a restore writes. */
async function confirmWrites(
  runtime: Runtime,
  target: Target,
  options: RestoreOptions,
  question: string,
): Promise<void> {
  if (!target.policy.production && target.policy.confirmWrites !== true) return;
  await confirmOperation(question, {
    yes: options.yes,
    prompter: runtime.ctx.prompter,
    reporter: runtime.reporter,
  });
}

function writeErrors(runtime: Runtime, file: string | undefined, summary: RestoreSummary): void {
  if (file === undefined) return;
  const lines = summary.errors.map(
    (error) =>
      `-- ${error.object ?? `statement ${error.statement ?? '?'}`}${error.line !== undefined ? ` (line ${error.line})` : ''}\n-- error: ${error.message.replace(/\n/g, ' ')}\n${error.text ?? ''}\n`,
  );
  writeFileSync(resolve(runtime.ctx.cwd, file), lines.join(''));
}
