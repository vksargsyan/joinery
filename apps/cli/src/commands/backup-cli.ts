import type { TlsMode } from '@querybara/core';
import { Option, type Command } from 'commander';

import type { ExitCode } from '../errors';
import { collect, positiveInteger } from '../options';
import type { Runtime } from '../runtime';
import type { TunnelFlags } from '../tunnels';
import {
  PASSPHRASE_ENV,
  backupCommand,
  restoreCommand,
  type BackupFileFormat,
  type BackupOptions,
  type RestoreOptions,
} from './backup';

/**
 * The `backup` and `restore` commands' flags (spec §14). They are registered by the program
 * with its shared TLS, --yes and tunnel options, and turned into the commands' options here.
 */

type Job = (runtime: Runtime) => Promise<ExitCode>;

/** The program's own option builders, shared by every command that connects. */
export interface ProgramOptionHelpers<T> {
  readonly tlsOption: () => Option;
  readonly yesOption: (what: string) => Option;
  readonly tunnelFlags: (options: T) => { tunnel?: TunnelFlags };
}

export interface BackupCliOptions {
  out: string;
  format?: BackupFileFormat;
  encrypt?: boolean;
  passphraseEnv?: string;
  compress?: boolean;
  native?: boolean;
  schema?: string[];
  table?: string[];
  excludeTable?: string[];
  excludeData?: string[];
  schemaOnly?: boolean;
  dataOnly?: boolean;
  grants?: boolean;
  owners?: boolean;
  snapshot?: boolean;
  deferrable?: boolean;
  rowsPerInsert?: number;
  collection?: string[];
  documents?: 'bson' | 'ejson';
  pattern?: string;
  database?: string;
  tls?: TlsMode;
}

export interface RestoreCliOptions {
  list?: boolean;
  dryRun?: boolean;
  select?: string[];
  schemaOnly?: boolean;
  dataOnly?: boolean;
  database?: string;
  createDatabase?: boolean;
  native?: boolean;
  continue?: boolean;
  errorLog?: string;
  replace?: boolean;
  keepExpiry?: boolean;
  passphraseEnv?: string;
  readOnly?: boolean;
  yes?: boolean;
  tls?: TlsMode;
}

/** The backup command's options from its flags. */
export function backupOptions(options: BackupCliOptions): BackupOptions {
  return {
    out: options.out,
    ...(options.format !== undefined ? { format: options.format } : {}),
    encrypt: options.encrypt === true,
    ...(options.passphraseEnv !== undefined ? { passphraseEnv: options.passphraseEnv } : {}),
    compress: options.compress !== false,
    native: options.native === true,
    schemas: options.schema ?? [],
    tables: options.table ?? [],
    excludeTables: options.excludeTable ?? [],
    excludeData: options.excludeData ?? [],
    structure: options.dataOnly !== true,
    data: options.schemaOnly !== true,
    grants: options.grants === true,
    ownership: options.owners === true,
    snapshot: options.snapshot !== false,
    deferrable: options.deferrable === true,
    ...(options.rowsPerInsert !== undefined ? { rowsPerInsert: options.rowsPerInsert } : {}),
    collections: options.collection ?? [],
    ...(options.documents !== undefined ? { documents: options.documents } : {}),
    ...(options.pattern !== undefined ? { pattern: options.pattern } : {}),
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
  };
}

/** The restore command's options from its flags. */
export function restoreOptions(file: string, options: RestoreCliOptions): RestoreOptions {
  return {
    file,
    ...(options.passphraseEnv !== undefined ? { passphraseEnv: options.passphraseEnv } : {}),
    select: options.select ?? [],
    structure: options.dataOnly !== true,
    data: options.schemaOnly !== true,
    createDatabase: options.createDatabase === true,
    native: options.native === true,
    continueOnError: options.continue === true,
    replace: options.replace === true,
    keepExpiry: options.keepExpiry === true,
    list: options.list === true,
    dryRun: options.dryRun === true,
    yes: options.yes === true,
    ...(options.errorLog !== undefined ? { errorLog: options.errorLog } : {}),
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
  };
}

/** Adds `backup` and `restore` to the program. */
export function addBackupCommands<T>(
  program: Command,
  schedule: (job: Job) => void,
  helpers: ProgramOptionHelpers<T>,
): void {
  program
    .command('backup')
    .description(
      'back up a database to a Querybara archive (.qbak), SQL, or with pg_dump/mysqldump',
    )
    .argument('<target>', 'profile name or id, or connection URI')
    .requiredOption('--out <file>', 'the backup file to write')
    .addOption(
      new Option('--format <format>', 'file format (default: from --out, else qbak)').choices([
        'qbak',
        'sql',
        'sql-gz',
        'custom',
      ]),
    )
    .option('--encrypt', 'encrypt the archive with a passphrase (AES-256-GCM)')
    .option(
      '--passphrase-env <VAR>',
      `take the passphrase from this variable (default ${PASSPHRASE_ENV}, else a prompt)`,
    )
    .option('--no-compress', 'archives: store each object without gzip')
    .option('--native', 'use pg_dump, mysqldump or mariadb-dump from PATH')
    .option(
      '--schema <name>',
      'PostgreSQL: back up this schema; repeatable (default: every schema)',
      collect(String),
    )
    .option(
      '--table <name>',
      'back up this table and what it needs; repeatable (default: everything)',
      collect(String),
    )
    .option('--exclude-table <name>', 'leave this table out; repeatable', collect(String))
    .option(
      '--exclude-data <name>',
      'back up this table without its rows; repeatable',
      collect(String),
    )
    .addOption(new Option('--schema-only', 'the structure without data').conflicts('dataOnly'))
    .option('--data-only', 'the data without the structure')
    .option('--grants', 'include privileges (GRANT statements)')
    .option('--owners', 'include owners and definers')
    .option('--no-snapshot', 'do not read everything in one snapshot transaction')
    .option('--deferrable', 'PostgreSQL: wait for a snapshot free of serialization anomalies')
    .option('--rows-per-insert <n>', 'rows per INSERT statement (default 500)', positiveInteger)
    .option('--collection <name>', 'MongoDB: back up this collection; repeatable', collect(String))
    .addOption(
      new Option('--documents <format>', 'MongoDB: documents as BSON or Extended JSON').choices([
        'bson',
        'ejson',
      ]),
    )
    .option('--pattern <glob>', 'Redis: back up the keys matching this pattern (default *)')
    .option('--database <name>', 'database to back up (Redis: its number)')
    .addOption(helpers.tlsOption())
    .addHelpText(
      'after',
      `
The Querybara archive holds one file per object and a manifest, so a restore can pick objects;
with --encrypt it is sealed with AES-256-GCM under a key derived from the passphrase (scrypt),
and any change to the file is detected. The passphrase is never read from the command line:
set ${PASSPHRASE_ENV} (or --passphrase-env) or type it when asked. SQL databases are read in
one consistent snapshot (MySQL and MariaDB: InnoDB tables); MongoDB keeps collection options
and indexes; Redis keeps each key's TTL.

Examples:
  querybara backup prod --out shop.qbak --encrypt
  querybara backup prod --out shop.sql.gz --schema public --exclude-data public.audit_log
  querybara backup prod --out shop.dump --native
  querybara backup "mongodb://app@localhost/app" --out app.qbak
  querybara backup "redis://localhost/2" --out sessions.qbak --pattern "session:*"`,
    )
    .action((target: string, options: BackupCliOptions & T) => {
      schedule((runtime) =>
        backupCommand(runtime, target, {
          ...backupOptions(options),
          ...helpers.tunnelFlags(options),
        }),
      );
    });

  program
    .command('restore')
    .description('restore a backup (.qbak, .sql, .sql.gz or a pg_dump archive) into a database')
    .argument('<target>', 'profile name or id, or connection URI')
    .argument('<file>', 'the backup file')
    .option('--list', 'print the objects in the archive and exit; nothing connects')
    .option('--dry-run', 'show what would be restored and dropped, and change nothing')
    .option(
      '--select <object>',
      'restore this object (id, schema.name or name) and what it needs; repeatable',
      collect(String),
    )
    .addOption(new Option('--schema-only', 'the structure without data').conflicts('dataOnly'))
    .option('--data-only', 'the data without the structure')
    .option('--database <name>', 'the database to restore into (Redis: its number)')
    .option('--create-database', 'create --database first (PostgreSQL, MySQL, MariaDB)')
    .option('--native', 'run a SQL script with psql or mysql (pg_dump archives use pg_restore)')
    .option('--continue', 'keep going after a failed statement (default: stop and roll back)')
    .option('--error-log <file>', 'write failed statements and their errors to a file')
    .option('--replace', 'Redis: overwrite keys that exist (default: keep them)')
    .option('--keep-expiry', 'Redis: expire keys at their original time, not their TTL from now')
    .option(
      '--passphrase-env <VAR>',
      `take the passphrase from this variable (default ${PASSPHRASE_ENV}, else a prompt)`,
    )
    .option('--read-only', 'refuse to write (the restore is refused)')
    .addOption(
      helpers.yesOption('restore over existing objects and into production without asking'),
    )
    .addOption(helpers.tlsOption())
    .addHelpText(
      'after',
      `
Restoring over existing objects drops and recreates them (Redis --replace overwrites keys):
the objects are listed first and the restore needs a confirmation or --yes, every time.
Read-only targets refuse; production and "confirm writes" profiles ask first. PostgreSQL
restores run in one transaction; MySQL and MariaDB commit table by table.

Exit codes: 0 restored, 1 restored but statements failed (--continue), 2 failed, 130
interrupted.

Examples:
  querybara restore dev shop.qbak --list
  querybara restore dev shop.qbak --database shop_copy --create-database
  querybara restore dev shop.qbak --select public.orders --dry-run
  querybara restore dev shop.sql.gz --native --continue --error-log restore-errors.log`,
    )
    .action((target: string, file: string, options: RestoreCliOptions & T) => {
      schedule((runtime) =>
        restoreCommand(runtime, target, {
          ...restoreOptions(file, options),
          ...helpers.tunnelFlags(options),
        }),
      );
    });
}
