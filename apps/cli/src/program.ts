import type { Environment, SecretPolicy, TlsMode } from '@querybara/core';
import type { RenameRule, RowAction } from '@querybara/sync';
import {
  DB_TABLE_MODES,
  type DbTableMode,
  type FieldShape,
  type ParquetCompression,
} from '@querybara/transfer';
import { Command, CommanderError, Option } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
import { addBackupCommands } from './commands/backup-cli';
import { compareCommand } from './commands/compare';
import { dataCompareCommand } from './commands/data-compare';
import { ddlCommand } from './commands/ddl';
import {
  addProfile,
  exportCommand,
  importCommand,
  listProfiles,
  removeProfile,
  showProfile,
  type AddProfileOptions,
} from './commands/profiles';
import { queryCommand } from './commands/query';
import { testCommand } from './commands/test';
import {
  exportDataCommand,
  importDataCommand,
  runFileCommand,
  type ExportDataOptions,
  type ImportDataOptions,
} from './commands/transfer';
import {
  embedFlag,
  renameFlag,
  shapeFlag,
  skipFlag,
  transferDbCommand,
  typeFlag,
  type TransferDbOptions,
} from './commands/transfer-db';
import type { CliContext } from './context';
import {
  BrokenPipeError,
  CliError,
  EXIT,
  InterruptedError,
  formatError,
  type ExitCode,
} from './errors';
import { Interrupts } from './interrupt';
import {
  actionList,
  collect,
  columnMap,
  delimiter,
  ignoreList,
  list,
  nonNegativeInteger,
  nonNegativeNumber,
  param,
  positiveInteger,
  proxyUrl,
  renameRule,
  sshHop,
  tlsMode,
  type IgnoreName,
} from './options';
import { OUTPUT_FORMATS, type OutputFormat } from './output/formats';
import { Sink } from './output/sink';
import { Reporter, Style } from './reporter';
import type { Runtime } from './runtime';
import { StoreHandle, resolveStorePath } from './store';
import { redactUri } from './target';
import {
  SSH_PASSWORD_ENV,
  Tunnels,
  type ProxyFlag,
  type SshHopFlag,
  type TunnelFlags,
} from './tunnels';

export const VERSION = packageJson.version;

type Job = (runtime: Runtime) => Promise<ExitCode>;

interface GlobalOptions {
  store?: string;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
}

const MAIN_HELP = `
Targets:
  Every <target>, <source> and <profile> argument is a saved profile (name or id) or a
  connection URI: postgres://user:pass@host:5432/db, mysql://user@host/db, mariadb://...
  URI passwords are used for that run only and never stored. Otherwise the password comes
  from the profile's saved secret, QUERYBARA_PASSWORD_<PROFILE> or QUERYBARA_PASSWORD, or a
  hidden prompt. TLS is off unless the URI says otherwise (?sslmode=..., rediss://,
  https://, mongodb+srv://) or --tls is given.

  An http:// or https:// URL is an Elasticsearch node: https://elastic@es.example.com:9200. It logs in with the URL's user and password, or
  with the API key in QUERYBARA_API_KEY; the scheme decides TLS (--tls sets the https mode).

SSH tunnels and proxies:
  A saved profile connects through its own SSH tunnel and proxy. A URI target takes them
  from --ssh user@host[:port] (repeat it for jump hosts, in the order to connect), with
  --ssh-key <path>, --ssh-agent or an SSH password (--ssh-password-env <VAR>, else
  ${SSH_PASSWORD_ENV}, else a hidden prompt), and --proxy socks5://host:port or
  http://host:port. Host keys are checked against the desktop app's known_hosts (next to
  the store; --known-hosts to use another file): a new key is asked about in a terminal
  and refused otherwise unless --ssh-accept-new is given; a changed key is always refused.
  A MongoDB replica set (host list, mongodb+srv or ?replicaSet=), Redis Sentinel or
  Cluster reaches every node through the tunnel or proxy, by the name the node announces;
  SRV records are still looked up on this computer.

Environment:
  QUERYBARA_STORE              local store file (default: the desktop app's querybara.db)
  QUERYBARA_PASSWORD           password for targets without one
  QUERYBARA_PASSWORD_<NAME>    password for one profile (name upper-cased, other chars as _)
  QUERYBARA_SSH_PASSWORD       SSH password for --ssh hops and profiles that ask for it
  QUERYBARA_SSH_KEY_PASSPHRASE passphrase of an encrypted SSH key
  QUERYBARA_PROXY_PASSWORD     proxy password (a --proxy URL may carry it too)
  QUERYBARA_API_KEY            Elasticsearch API key (URL targets and profiles)
  QUERYBARA_BEARER_TOKEN       bearer token for profiles that log in with one
  QUERYBARA_PASSPHRASE         seals passwords the CLI saves (the OS keychain is app-only)
  QUERYBARA_EXPORT_PASSPHRASE  passphrase for profiles export/import files
  QUERYBARA_BACKUP_PASSPHRASE  passphrase of encrypted backups (backup --encrypt, restore)
  NO_COLOR                   turn colours off

Exit codes:
  0 success / no differences, 1 differences found, a failed connection test, or an
  import or SQL file that skipped rows or failed statements, 2 error, 130 interrupted
  (Ctrl+C).
`;

/**
 * Parses the command line and runs the command. Returns the exit code instead of exiting, so
 * tests drive the whole CLI in-process; `bin.ts` exits with it.
 */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  let job: Job | undefined;
  const program = buildProgram(ctx, (next) => {
    job = next;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.ok : EXIT.error;
    throw error;
  }
  if (!job) return EXIT.ok;

  const globals = program.opts<GlobalOptions>();
  const color = globals.color !== false && !ctx.env['NO_COLOR'];
  const reporter = new Reporter(ctx.stderr, {
    verbose: globals.verbose === true,
    quiet: globals.quiet === true,
    color: color && ctx.stderr.isTTY === true,
    now: ctx.now,
  });
  const location = resolveStorePath({
    ...(globals.store !== undefined ? { flag: globals.store } : {}),
    env: ctx.env,
    platform: ctx.platform,
    homedir: ctx.homedir,
    cwd: ctx.cwd,
  });
  reporter.debug(`querybara ${VERSION}; store ${location.path} (${location.source})`);
  const interrupts = new Interrupts(reporter);
  interrupts.listen(ctx.signals);
  const stdout = new Sink(ctx.stdout);
  const store = new StoreHandle(location, ctx.env);
  const tunnels = new Tunnels({
    storePath: location.path,
    cwd: ctx.cwd,
    prompter: ctx.prompter,
    reporter,
  });
  const runtime: Runtime = {
    ctx,
    reporter,
    stdout,
    out: new Style(color && ctx.stdout.isTTY === true),
    store,
    interrupts,
    tunnels,
  };
  try {
    const code = await Promise.race([job(runtime), interrupts.hardStop]);
    return interrupts.interrupted ? EXIT.interrupted : code;
  } catch (error) {
    reporter.clearProgress();
    if (error instanceof InterruptedError || interrupts.interrupted) return EXIT.interrupted;
    if (error instanceof BrokenPipeError) return EXIT.ok;
    reporter.error(formatError(error, { verbose: reporter.verbose }));
    return EXIT.error;
  } finally {
    tunnels.closeAll();
    interrupts.dispose();
    stdout.dispose();
    store.close();
  }
}

/** Commands that connect take the SSH tunnel and proxy options. */
const TUNNEL_COMMANDS = new Set([
  'test',
  'query',
  'compare',
  'data-compare',
  'ddl',
  'import',
  'export',
  'run-file',
  'transfer',
  'backup',
  'restore',
]);

function addTunnelOptions(command: Command): void {
  command
    .option(
      '--ssh <user@host[:port]>',
      'reach URI targets through this SSH server; repeat for jump hosts, in order',
      collect(sshHop),
    )
    .addOption(
      new Option('--ssh-key <path>', 'SSH private key file (OpenSSH, PEM or PuTTY .ppk)').conflicts(
        ['sshAgent', 'sshPasswordEnv'],
      ),
    )
    .addOption(
      new Option(
        '--ssh-password-env <VAR>',
        `take the SSH password from this variable (default ${SSH_PASSWORD_ENV}, else a prompt)`,
      ).conflicts('sshAgent'),
    )
    .option('--ssh-agent', 'log in with the keys of ssh-agent (SSH_AUTH_SOCK) or Pageant')
    // Parsed when the command runs, so an invalid URL is reported without its password.
    .option(
      '--proxy <url>',
      'reach URI targets (or their first SSH server) through socks5://host:port or http://host:port',
    )
    .option(
      '--ssh-accept-new',
      'trust and remember an SSH host key not seen before (a changed key is always refused)',
    )
    .option('--known-hosts <path>', "SSH known hosts file (default: the desktop app's)");
}

interface TunnelCliOptions {
  ssh?: SshHopFlag[];
  sshKey?: string;
  sshPasswordEnv?: string;
  sshAgent?: boolean;
  proxy?: string;
  sshAcceptNew?: boolean;
  knownHosts?: string;
}

/** `--proxy`, with a password in an invalid URL masked in the message. */
function parseProxy(value: string): ProxyFlag {
  try {
    return proxyUrl(value);
  } catch (error) {
    throw new CliError(
      `--proxy ${redactUri(value)}: ${error instanceof Error ? error.message : String(error)}`,
      { hint: 'Use socks5://host:port or http://host:port' },
    );
  }
}

/** The tunnel flags of a command, or nothing when none was given. */
function tunnelFlags(options: TunnelCliOptions): { tunnel?: TunnelFlags } {
  const flags: TunnelFlags = {
    ...(options.ssh !== undefined ? { ssh: options.ssh } : {}),
    ...(options.sshKey !== undefined ? { sshKey: options.sshKey } : {}),
    ...(options.sshPasswordEnv !== undefined ? { sshPasswordEnv: options.sshPasswordEnv } : {}),
    ...(options.sshAgent ? { sshAgent: true } : {}),
    ...(options.proxy !== undefined ? { proxy: parseProxy(options.proxy) } : {}),
    ...(options.sshAcceptNew ? { sshAcceptNew: true } : {}),
    ...(options.knownHosts !== undefined ? { knownHosts: options.knownHosts } : {}),
  };
  return Object.keys(flags).length > 0 ? { tunnel: flags } : {};
}

function tlsOption(): Option {
  return new Option(
    '--tls <mode>',
    'TLS mode for this run: disable, require, verify-ca or verify-full',
  ).argParser(tlsMode);
}

function yesOption(what: string): Option {
  return new Option('-y, --yes', what);
}

/** The commander program. `schedule` receives the job the parsed command asked for. */
export function buildProgram(ctx: CliContext, schedule: (job: Job) => void): Command {
  const program = new Command('querybara')
    .description(
      "Test connections, run SQL, and compare or sync the structure and data of databases.\nThe Querybara desktop engine on the command line; shares the app's saved connections.",
    )
    .version(VERSION, '-V, --version', 'print the version')
    .helpOption('-h, --help', 'show help for a command')
    .option(
      '--store <path>',
      'local store file (env QUERYBARA_STORE; default: the desktop app store)',
    )
    .option('-v, --verbose', 'debug output on stderr (never includes secrets)')
    .option('-q, --quiet', 'only results, warnings and errors')
    .option('--no-color', 'plain output without colours')
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({
      writeOut: (text) => void ctx.stdout.write(text),
      writeErr: (text) => void ctx.stderr.write(text),
      outputError: (text, write) => write(text),
    })
    .exitOverride()
    .addHelpText('after', MAIN_HELP);

  // test -------------------------------------------------------------------------------------
  program
    .command('test')
    .description('test a connection step by step: DNS, TCP, SSH, TLS, auth, ping, version')
    .argument('<target>', 'profile name or id, or connection URI')
    .addOption(tlsOption())
    .option('--json', 'print the steps as JSON')
    .addHelpText(
      'after',
      '\nExit code 0 when every step passes, 1 when one fails (with a fix hint), 2 on errors.\n\nExamples:\n  querybara test prod-db\n  querybara test "postgres://app@db.internal:5432/app?sslmode=verify-full"\n  querybara test "postgres://app@10.0.3.7/app" --ssh ops@bastion.example.com --ssh-agent\n  querybara test "https://elastic@es.internal:9200"',
    )
    .action((target: string, options: { tls?: TlsMode; json?: boolean } & TunnelCliOptions) => {
      schedule((runtime) =>
        testCommand(runtime, target, {
          json: options.json === true,
          ...(options.tls !== undefined ? { tls: options.tls } : {}),
          ...tunnelFlags(options),
        }),
      );
    });

  // query ------------------------------------------------------------------------------------
  program
    .command('query')
    .description('run SQL statements one by one from -e, a file, or stdin')
    .argument('<target>', 'profile name or id, or connection URI')
    .option('-e, --execute <sql>', 'SQL to run (several statements allowed)')
    .option('-f, --file <path>', 'a .sql file to run, streamed ("-" for stdin)')
    .addOption(
      new Option('--format <format>', 'result format').choices(OUTPUT_FORMATS).default('table'),
    )
    .option(
      '-p, --param <name=value>',
      'bind a placeholder (:name, $1 or ?) to a value; repeatable',
      collect(param),
    )
    .addOption(new Option('--stop-on-error', 'stop at the first failed statement (default)'))
    .addOption(
      new Option('--continue', 'keep going after a failed statement').conflicts('stopOnError'),
    )
    .option('--error-log <file>', 'write failed statements and their errors to a file')
    .option(
      '--row-limit <n>',
      'print at most n rows per result set (0: all)',
      nonNegativeInteger,
      0,
    )
    .option('--max-column-width <n>', 'table format: cut longer cells with …', positiveInteger)
    .option('--database <name>', 'database to connect to')
    .option('--read-only', 'refuse statements that write')
    .addOption(yesOption('run statements that need confirmation without asking'))
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
Statements run in order, each in its own auto-commit unless the script opens a transaction.
Files stream through the statement splitter (DELIMITER, dollar quoting and comments are
handled), so large dumps run in flat memory; progress shows on stderr in a terminal.

Results go to stdout; row counts, timings and notices to stderr. csv, tsv, json and jsonl
are exact and stream: CSV writes NULL as an empty field and '' as "", TSV follows PostgreSQL
COPY text (\\N for NULL), JSON keeps bigints exact and writes binary as base64.

Safety: UPDATE/DELETE without WHERE, DROP and TRUNCATE ask for confirmation (or need
--yes); production profiles confirm every write; read-only profiles refuse writes.
Placeholders are bound only when --param is given. Ctrl+C cancels the running statement.

Examples:
  querybara query prod -e "select * from users where id = :id" --param id=42
  querybara query "postgres://app@localhost/app" -f migrate.sql --continue --error-log errors.log
  querybara query dev -f dump.sql --yes --quiet
  cat report.sql | querybara query dev --format csv > report.csv
  querybara query "mysql://app@db.internal/app" --ssh ops@jump:22 --ssh ops@bastion --ssh-key ~/.ssh/id_ed25519 -e "select 1"

Redis targets (redis://, rediss:// or a Redis profile) run redis-cli command lines, one per
line, and print redis-cli's output (--format json or jsonl: the replies as JSON); DEL, FLUSHDB
and other destructive commands ask for confirmation (or need --yes):
  querybara query "redis://localhost:6379/0" -e 'SET greeting "hello world"'

Elasticsearch targets (http://, https:// or a saved profile) run Kibana console
requests: a method and path per request, then its JSON body (NDJSON lines for _bulk); each
response body prints as JSON with numbers exactly as sent (--format json or jsonl: objects with
the request, status and body). Deleting or closing indices, delete by query and other
destructive requests ask for confirmation (or need --yes); an error status fails the request:
  querybara query "http://elastic@localhost:9200" -e 'GET _cluster/health'
  querybara query search-prod -f requests.txt --format jsonl`,
    )
    .action((target: string, options: QueryCliOptions) => {
      schedule((runtime) => queryCommand(runtime, target, queryOptions(options)));
    });

  // compare ----------------------------------------------------------------------------------
  program
    .command('compare')
    .description('compare the structure of two databases and optionally sync the target')
    .argument('<source>', 'the desired structure: profile or URI')
    .argument('<target>', 'the database to change: profile or URI')
    .option(
      '--schema <name>',
      'PostgreSQL schema to compare; repeatable (default: all)',
      collect(String),
    )
    .option(
      '--ignore <list>',
      'also ignore: comments, collation, auto-increment, definer, ownership, privileges, partitions, column-order, name-case, names, extension-versions',
      ignoreList,
    )
    .option(
      '--no-default-ignores',
      'compare auto-increment, definer, ownership and privileges too (ignored by default)',
    )
    .option(
      '--rename <kind>:<from>=<to>',
      'map a renamed object instead of drop + create; repeatable. kind: table, view, column, index, constraint (e.g. table:old_users=users, column:users.mail=email)',
      collect(renameRule),
    )
    .option('--no-detect-renames', 'do not turn identical drop + create pairs into renames')
    .option('--include-destructive', 'select destructive operations too (they start unselected)')
    .option('--out <file>', 'write the deployment script ("-" for stdout)')
    .option('--html <file>', 'write an HTML report')
    .option('--json', 'print the diff as JSON')
    .option('--apply', 'run the script on the target, then re-compare')
    .addOption(yesOption('confirm --apply (required for MySQL and MariaDB)'))
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
Exit codes follow diff(1): 0 no differences, 1 differences found (or remaining after
--apply), 2 error.

--apply runs the selected operations in dependency order with progress and stops at the
first error. PostgreSQL scripts run in one transaction and roll back on failure. MySQL and
MariaDB DDL is not transactional, so --apply warns and needs --yes. After applying, both
sides are compared again and the command fails unless no differences remain.

Examples:
  querybara compare staging prod --out deploy.sql --html report.html
  querybara compare dev "postgres://app@localhost/app_test" --schema public --json
  querybara compare model-db test-db --include-destructive --apply --yes`,
    )
    .action((source: string, target: string, options: CompareCliOptions) => {
      schedule((runtime) =>
        compareCommand(runtime, source, target, {
          schemas: options.schema ?? [],
          ignore: options.ignore ?? [],
          defaultIgnores: options.defaultIgnores !== false,
          renames: options.rename ?? [],
          detectRenames: options.detectRenames !== false,
          includeDestructive: options.includeDestructive === true,
          json: options.json === true,
          apply: options.apply === true,
          yes: options.yes === true,
          ...(options.out !== undefined ? { out: options.out } : {}),
          ...(options.html !== undefined ? { html: options.html } : {}),
          ...(options.tls !== undefined ? { tls: options.tls } : {}),
          ...tunnelFlags(options),
        }),
      );
    });

  // data-compare -----------------------------------------------------------------------------
  program
    .command('data-compare')
    .description('compare the rows of a table in two databases and optionally sync the target')
    .argument('<source>', 'the rows to copy from: profile or URI')
    .argument('<target>', 'the table to change: profile or URI')
    .requiredOption('--table <name>', 'table to compare (schema.table on PostgreSQL)')
    .option('--target-table <name>', 'table name on the target (default: the same)')
    .option('--key <columns>', 'key columns (default: primary key or unique NOT NULL key)', list)
    .option('--columns <columns>', 'compare only these columns', list)
    .option('--ignore-columns <columns>', 'leave these columns out', list)
    .option('--actions <list>', 'which differences to sync: insert,update,delete', actionList)
    .option('--float-tolerance <n>', 'treat floats within n as equal', nonNegativeNumber)
    .addOption(
      new Option('--trim <mode>', 'trim strings before comparing').choices([
        'none',
        'trailing',
        'both',
      ]),
    )
    .option('--case-insensitive', 'compare strings ignoring case')
    .option('--show-rows <n>', 'row differences to print', nonNegativeInteger, 10)
    .option(
      '--batch-size <n>',
      'rows per INSERT or DELETE statement (default 500)',
      positiveInteger,
    )
    .option(
      '--disable-fk-checks',
      'skip foreign key checks while applying (MySQL FOREIGN_KEY_CHECKS=0; PostgreSQL session_replication_role, needs superuser)',
    )
    .option('--out <file>', 'write the sync script')
    .option('--json', 'print counts and row differences as JSON')
    .option('--apply', 'apply the sync script to the target in one transaction, then re-compare')
    .addOption(yesOption('confirm --apply when it deletes rows or the target asks'))
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
Ranges of keys are checksummed on both servers; only mismatched ranges are streamed and
merged. Exit codes: 0 no differences (for the selected actions), 1 differences found or
remaining after --apply, 2 error.

Examples:
  querybara data-compare prod staging --table public.plans
  querybara data-compare prod staging --table plans --actions insert,update --out sync.sql
  querybara data-compare seed test --table countries --apply --yes`,
    )
    .action((source: string, target: string, options: DataCompareCliOptions) => {
      schedule((runtime) =>
        dataCompareCommand(runtime, source, target, {
          table: options.table,
          actions: options.actions ?? ['insert', 'update', 'delete'],
          apply: options.apply === true,
          yes: options.yes === true,
          json: options.json === true,
          showRows: options.showRows,
          ...(options.targetTable !== undefined ? { targetTable: options.targetTable } : {}),
          ...(options.key !== undefined ? { key: options.key } : {}),
          ...(options.columns !== undefined ? { columns: options.columns } : {}),
          ...(options.ignoreColumns !== undefined ? { ignoreColumns: options.ignoreColumns } : {}),
          ...(options.floatTolerance !== undefined
            ? { floatTolerance: options.floatTolerance }
            : {}),
          ...(options.trim !== undefined ? { trim: options.trim } : {}),
          ...(options.caseInsensitive ? { caseInsensitive: true } : {}),
          ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
          ...(options.disableFkChecks ? { disableForeignKeyChecks: true } : {}),
          ...(options.out !== undefined ? { out: options.out } : {}),
          ...(options.tls !== undefined ? { tls: options.tls } : {}),
          ...tunnelFlags(options),
        }),
      );
    });

  // ddl --------------------------------------------------------------------------------------
  program
    .command('ddl')
    .description('print the schema as a DDL script in dependency order')
    .argument('<target>', 'profile name or id, or connection URI')
    .option(
      '--schema <name>',
      'PostgreSQL schema to dump; repeatable (default: all)',
      collect(String),
    )
    .option('--database <name>', 'database to dump')
    .option('--out <file>', 'write the script to a file instead of stdout')
    .addOption(tlsOption())
    .action(
      (
        target: string,
        options: {
          schema?: string[];
          database?: string;
          out?: string;
          tls?: TlsMode;
        } & TunnelCliOptions,
      ) => {
        schedule((runtime) =>
          ddlCommand(runtime, target, {
            schemas: options.schema ?? [],
            ...(options.database !== undefined ? { database: options.database } : {}),
            ...(options.out !== undefined ? { out: options.out } : {}),
            ...(options.tls !== undefined ? { tls: options.tls } : {}),
            ...tunnelFlags(options),
          }),
        );
      },
    );

  // import -----------------------------------------------------------------------------------
  program
    .command('import')
    .description('import a CSV, TSV, JSON, JSON Lines, Excel, XML or Parquet file into a table')
    .argument('<target>', 'profile name or id, or connection URI')
    .requiredOption('--table <name>', 'table to import into (schema.table on PostgreSQL)')
    .requiredOption('--file <path>', 'file to read, gzip allowed ("-" for stdin)')
    .addOption(
      new Option('--format <format>', 'file format (default: from the name and content)').choices([
        'csv',
        'tsv',
        'json',
        'jsonl',
        'xlsx',
        'xml',
        'parquet',
      ]),
    )
    .option(
      '--delimiter <char>',
      'CSV delimiter: one character, or tab, comma, semicolon, pipe (default: detected)',
      delimiter,
    )
    .option('--no-header', 'the first row is data, not column names')
    .option('--sheet <name>', 'Excel: the worksheet to read (default: the first visible one)')
    .option(
      '--header-row <n>',
      'Excel: the row with the column names, 0 for none (default: detected)',
      nonNegativeInteger,
    )
    .option(
      '--row-path <path>',
      'XML: path of the row elements, e.g. /orders/order (default: detected)',
    )
    .option('--encoding <name>', 'text encoding, e.g. windows-1252 (default: detected)')
    .option('--null <text>', 'unquoted text that means NULL (default: an empty field)')
    .addOption(
      new Option('--mode <mode>', 'what to do with each row')
        .choices(['append', 'update', 'upsert', 'delete', 'replace'])
        .default('append'),
    )
    .option(
      '--key <columns>',
      'key columns for update, upsert and delete (default: primary key)',
      list,
    )
    .option('--create', "create the table from the file's columns and inferred types")
    .option('--batch-size <n>', 'rows per batch (default 1000)', positiveInteger)
    .addOption(
      new Option('--transaction <mode>', 'one transaction for the file, or one per batch')
        .choices(['single', 'per-batch'])
        .default('single'),
    )
    .addOption(
      new Option('--on-error <action>', 'stop (and roll back) or skip failing rows')
        .choices(['stop', 'skip'])
        .default('stop'),
    )
    .option(
      '--map <file=column>',
      'pair a file column with a table column; repeatable (default: match by name)',
      collect(columnMap),
    )
    .option(
      '--disable-fk-checks',
      'skip foreign key checks during the load (PostgreSQL: session_replication_role, needs superuser)',
    )
    .option('--error-log <file>', 'write every failing row and its error to a file')
    .option('--database <name>', 'database to connect to')
    .option('--read-only', 'refuse to write (the import is refused)')
    .addOption(yesOption('import without asking on production connections and for replace/delete'))
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
The format, encoding, CSV delimiter, quote and header, the Excel header row and the XML
row path are detected from the file unless given. Excel cells keep their types (numbers,
booleans, dates as ISO text); XML rows are the elements at --row-path, with their attributes
and child elements as columns. Parquet columns keep the file's types (exact decimals, dates,
timestamps; lists, maps and structs as JSON). Columns are matched to the table's by name (case, spaces, _
and - do not count);
unmatched table columns get their defaults. Rows load in batches of parameterised INSERT
(or UPDATE, upsert, DELETE) statements in one transaction by default: with --on-error stop
the first bad row rolls everything back; with skip, bad rows are reported (row, line,
column, message) and the rest is kept. Ctrl+C cancels and rolls back.

Exit codes: 0 imported, 1 imported but rows were skipped, 2 failed, 130 interrupted.
Safety: read-only targets refuse; production and "confirm writes" profiles, and the
replace (empties the table first) and delete modes, need --yes or a confirmation.

Examples:
  querybara import dev --table public.people --file people.csv
  querybara import dev --table people --file export.json.gz --mode upsert --key id
  querybara import dev --table staging.raw --file data.tsv --create --on-error skip
  querybara import dev --table sales --file q3.xlsx --sheet "July" --header-row 3
  querybara import dev --table orders --file orders.xml --row-path /export/table/row
  querybara import dev --table events --file events.parquet --create
  cat rows.csv | querybara import "mysql://app@db/shop" --table orders --file - --map "Order No=id"`,
    )
    .action((target: string, options: ImportCliOptions) => {
      schedule((runtime) => importDataCommand(runtime, target, importOptions(options)));
    });

  // export -----------------------------------------------------------------------------------
  program
    .command('export')
    .description(
      'export tables or a query result to CSV, TSV, JSON, JSON Lines, Excel, XML, Parquet, SQL, HTML or Markdown',
    )
    .argument('<target>', 'profile name or id, or connection URI')
    .option(
      '--table <name>',
      'table to export (schema.table on PostgreSQL); repeatable',
      collect(String),
    )
    .option('--query <sql>', 'export the result of this query instead')
    .addOption(
      new Option('--format <format>', 'output format')
        .choices([
          'csv',
          'tsv',
          'json',
          'jsonl',
          'xlsx',
          'xml',
          'parquet',
          'sql',
          'sql-ddl',
          'html',
          'markdown',
        ])
        .makeOptionMandatory(),
    )
    .requiredOption(
      '--out <path>',
      'file to write ("-" for stdout); a folder for several tables without --one-file',
    )
    .option('--gzip', 'compress the output with gzip')
    .option('--zip', 'a file per table inside one ZIP archive (--out is the .zip file)')
    .option(
      '--one-file',
      'several tables into one file (all formats but csv, tsv, jsonl and parquet)',
    )
    .option('--no-header', 'CSV, TSV and Excel: no header row')
    .option('--delimiter <char>', 'CSV delimiter (default ,)', delimiter)
    .option('--null <text>', 'CSV and TSV: text written for NULL (default: an empty field)')
    .option('--pretty', 'JSON: indent each object')
    .option(
      '--rows-per-insert <n>',
      'SQL: rows per INSERT statement (default 100)',
      positiveInteger,
    )
    .option('--drop-table', 'sql-ddl: DROP TABLE IF EXISTS before each CREATE TABLE')
    .addOption(
      new Option(
        '--decimals <as>',
        'xlsx: decimals as exact text, or as numbers where a double holds them exactly',
      ).choices(['text', 'number']),
    )
    .addOption(
      new Option('--codec <codec>', 'parquet: page compression (default snappy)').choices([
        'snappy',
        'zstd',
        'gzip',
        'none',
      ]),
    )
    .option('--bom', 'start with a UTF-8 byte order mark (for Excel)')
    .option('--database <name>', 'database to connect to')
    .addOption(
      yesOption('run a --query that needs confirmation (as query would ask) without asking'),
    )
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
Rows stream from a server-side cursor to the file page by page, so memory stays flat. JSON
keeps bigints and decimals exact and embeds JSON columns; SQL writes multi-row INSERTs (with
the CREATE TABLE, indexes and foreign keys for sql-ddl). Excel writes typed cells (dates as
Excel dates; bigints and decimals as text unless --decimals number); XML writes <export>,
<table name="…"> and a <row> per row; Parquet typed columns (exact decimals, dates, timestamps,
UUIDs) in row groups; HTML a self-contained page; Markdown pipe tables.
Several tables go to <out>/<table> files, into one ZIP archive with --zip, or with --one-file
into one file (a SQL file with foreign keys last, a JSON object keyed by table name, a
worksheet or section per table). A failed or cancelled export removes the partial file.

Examples:
  querybara export prod --table public.orders --format csv --out orders.csv
  querybara export prod --table orders --table items --format sql-ddl --one-file --out shop.sql --gzip
  querybara export prod --table orders --table items --format jsonl --out exports/
  querybara export prod --table orders --table items --format xlsx --one-file --out shop.xlsx
  querybara export prod --table orders --table items --format csv --zip --out shop.zip
  querybara export prod --table events --format parquet --codec zstd --out events.parquet
  querybara export dev --query "select id, email from users where active" --format json --out - | jq .`,
    )
    .action((target: string, options: ExportCliOptions) => {
      schedule((runtime) => exportDataCommand(runtime, target, exportOptions(options)));
    });

  // run-file ---------------------------------------------------------------------------------
  program
    .command('run-file')
    .description('run a .sql file statement by statement with progress and an error log')
    .argument('<target>', 'profile name or id, or connection URI')
    .argument('<file>', 'the SQL file (gzip allowed)')
    .option('--continue', 'keep going after a failed statement (default: stop)')
    .option('--error-log <file>', 'write failed statements and their errors to a file')
    .option('--encoding <name>', 'text encoding (default: detected)')
    .option('--database <name>', 'database to connect to')
    .option('--read-only', 'refuse statements that write')
    .addOption(yesOption('run statements that need confirmation without asking'))
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
The file streams through the statement splitter (DELIMITER, dollar quoting and comments are
handled), so multi-gigabyte dumps run in flat memory; result rows are discarded (use
\`querybara query -f\` to see them). Statements run as the file says, its own BEGIN/COMMIT
included.

Exit codes: 0 every statement ran, 1 some failed with --continue, 2 stopped at a failure,
130 interrupted. Safety as for query: risky statements and, on production profiles, every
write need --yes or a confirmation; read-only targets refuse writes.

Examples:
  querybara run-file dev migrate.sql
  querybara run-file "postgres://app@localhost/app" dump.sql.gz --continue --error-log errors.log`,
    )
    .action((target: string, file: string, options: RunFileCliOptions) => {
      schedule((runtime) =>
        runFileCommand(runtime, target, {
          file,
          continueOnError: options.continue === true,
          yes: options.yes === true,
          ...(options.errorLog !== undefined ? { errorLog: options.errorLog } : {}),
          ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
          ...(options.database !== undefined ? { database: options.database } : {}),
          ...(options.readOnly ? { readOnly: true } : {}),
          ...(options.tls !== undefined ? { tls: options.tls } : {}),
          ...tunnelFlags(options),
        }),
      );
    });

  // transfer ---------------------------------------------------------------------------------
  program
    .command('transfer')
    .description('copy tables, collections or keys from one database to another')
    .argument('<source>', 'profile name or id, or connection URI, to read from')
    .argument('<target>', 'profile name or id, or connection URI, to write to')
    .option(
      '--table <name>',
      'table or collection to transfer (schema.table on PostgreSQL); repeatable',
      collect(String),
    )
    .option('--all', 'every table of the source schema, or collection of the database')
    .option('--pattern <glob>', 'Redis: keys to copy, e.g. "user:*"; repeatable', collect(String))
    .option('--database <name>', 'source database (MongoDB: of the collections)')
    .option('--schema <name>', 'PostgreSQL source schema (default public)')
    .option('--target-database <name>', 'target database')
    .option('--target-schema <name>', 'PostgreSQL target schema (default public)')
    .addOption(
      new Option('--mode <mode>', 'create each table, drop and create it, empty it, or append')
        .choices(DB_TABLE_MODES)
        .default('create'),
    )
    .option('--rename <from=to>', 'target name of a table; repeatable', collect(renameFlag))
    .option('--type <table.column=type>', 'target type of a column; repeatable', collect(typeFlag))
    .option('--skip <table.column>', 'leave a column out; repeatable', collect(skipFlag))
    .option(
      '--shape <collection.field=shape>',
      'MongoDB to SQL: a field as columns, json or a child table; repeatable',
      collect(shapeFlag),
    )
    .option(
      '--embed <parent:child:fk[:field]>',
      'SQL to MongoDB: embed the child rows of each parent (by foreign key); repeatable',
      collect(embedFlag),
    )
    .option('--batch-size <n>', 'rows, documents or keys per batch (default 1000)', positiveInteger)
    .option('--parallel <n>', 'tables transferred at once (default 2)', positiveInteger)
    .addOption(
      new Option('--on-error <action>', 'stop at the first failed row, or log it and go on')
        .choices(['stop', 'skip'])
        .default('stop'),
    )
    .option('--no-transaction', 'no transaction per batch')
    .option(
      '--disable-constraints',
      'foreign key checks (PostgreSQL: and triggers, needs superuser) off during the load',
    )
    .option('--no-defer-constraints', 'create keys, indexes and foreign keys before the data')
    .option('--no-reset-sequences', 'leave sequences and AUTO_INCREMENT counters as they are')
    .option(
      '--sample <n>',
      'MongoDB: documents sampled for the columns (default 1000)',
      positiveInteger,
    )
    .option('--no-id-from-key', 'SQL to MongoDB: do not make the primary key the _id')
    .option('--replace', 'Redis: overwrite keys that exist on the target')
    .option('--no-ttl', 'Redis: copy keys without their time to live')
    .option('--dry-run', 'print the plan (column types, statements) and change nothing')
    .option('--json', 'print the plan or the summary as JSON on stdout')
    .option('--error-log <file>', 'write every failed row and its error to a file')
    .addOption(yesOption('confirm dropping, emptying or overwriting, and production targets'))
    .addOption(tlsOption())
    .addHelpText(
      'after',
      `
Pairs: PostgreSQL, MySQL and MariaDB to any of them; those to MongoDB (typed documents, child
rows embedded with --embed); MongoDB to them (nested fields flattened to columns, arrays as
child tables or JSON, types from a sample); Redis to Redis (DUMP/RESTORE with TTLs, keys by
--pattern, standalone or Cluster). Rows stream in batches with a transaction per batch;
tables run --parallel at once on their own sessions, and primary keys, indexes and foreign
keys follow the data. The type of each column comes from a mapping per engine pair: see it
with --dry-run, change it with --type.

Exit codes: 0 transferred, 1 transferred but rows were skipped, 2 failed or refused, 130
interrupted. Safety: read-only targets refuse; drop-create, truncate, --replace, production
and "confirm writes" profiles need --yes or a confirmation.

Examples:
  querybara transfer pg-dev "mysql://app@localhost/shop" --table orders --table customers
  querybara transfer pg-dev my-dev --all --mode drop-create --yes
  querybara transfer my-dev mongo-dev --table orders --embed orders:items:items_ibfk_1:lines
  querybara transfer mongo-dev pg-dev --table events --shape events.tags=json --dry-run
  querybara transfer redis-a redis-b --pattern "session:*" --replace`,
    )
    .action((source: string, target: string, options: TransferCliOptions) => {
      schedule((runtime) => transferDbCommand(runtime, source, target, transferDbOptions(options)));
    });

  // backup, restore -------------------------------------------------------------------------
  addBackupCommands(program, schedule, { tlsOption, yesOption, tunnelFlags });

  // profiles ---------------------------------------------------------------------------------
  const profiles = program
    .command('profiles')
    .description('manage saved connection profiles (shared with the desktop app)');

  profiles
    .command('list')
    .description('list saved profiles')
    .option('--json', 'print as JSON')
    .action((options: { json?: boolean }) => {
      schedule((runtime) => listProfiles(runtime, { json: options.json === true }));
    });

  profiles
    .command('show')
    .description('show one profile; secrets are never printed, only whether they are saved')
    .argument('<profile>', 'profile name or id')
    .option('--json', 'print as JSON')
    .action((spec: string, options: { json?: boolean }) => {
      schedule((runtime) => showProfile(runtime, spec, { json: options.json === true }));
    });

  const addOptions = (command: Command): Command =>
    command
      .addOption(
        new Option('--environment <env>', 'environment label').choices([
          'dev',
          'test',
          'staging',
          'production',
        ]),
      )
      .option('--folder <path>', 'folder id or path such as Team/Prod (created when missing)')
      .addOption(
        new Option(
          '--password-policy <policy>',
          'save (sealed with QUERYBARA_PASSPHRASE), session or ask. Default: save a password in the URI when QUERYBARA_PASSPHRASE is set, else ask',
        ).choices(['save', 'session', 'ask']),
      )
      .option('--read-only', 'lock the profile read-only: writes are refused')
      .option('--confirm-writes', 'ask before every write')
      .addOption(tlsOption().default(undefined, 'what the URI says, else disable'))
      .addOption(
        new Option('--engine <engine>', 'for mysql:// URIs of MariaDB servers').choices([
          'mysql',
          'mariadb',
        ]),
      )
      .option('--tag <tag>', 'add a tag; repeatable', collect(String))
      .option('--replace', 'replace a profile with the same name');

  addOptions(
    profiles
      .command('add')
      .description('save a profile from a connection URI')
      .argument('<name>', 'profile name')
      .argument(
        '<uri>',
        'connection URI; a password in it is saved only with --password-policy save',
      ),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  QUERYBARA_PASSPHRASE=... querybara profiles add prod "postgres://app:secret@db:5432/app" --environment production\n  querybara profiles add dev "mysql://root@127.0.0.1/app" --folder Local',
    )
    .action((name: string, uri: string, options: AddCliOptions) => {
      schedule((runtime) => addProfile(runtime, uri, addProfileOptions({ ...options, name })));
    });

  addOptions(
    profiles
      .command('import-uri')
      .description('save a profile from a pasted URI, named after its host and database')
      .argument('<uri>', 'connection URI')
      .option('--name <name>', 'profile name (default: host[:port]/database)'),
  ).action((uri: string, options: AddCliOptions) => {
    schedule((runtime) => addProfile(runtime, uri, addProfileOptions(options)));
  });

  profiles
    .command('remove')
    .alias('rm')
    .description('remove a profile with its saved secrets and history')
    .argument('<profile>', 'profile name or id')
    .addOption(yesOption('do not ask for confirmation'))
    .action((spec: string, options: { yes?: boolean }) => {
      schedule((runtime) => removeProfile(runtime, spec, { yes: options.yes === true }));
    });

  profiles
    .command('export')
    .description('export profiles to a passphrase-encrypted file')
    .argument('<file>', 'file to write')
    .option(
      '--profile <profile>',
      'export this profile; repeatable (default: all)',
      collect(String),
    )
    .option('--include-secrets', 'include the saved secrets that are readable here')
    .addHelpText('after', '\nThe passphrase comes from QUERYBARA_EXPORT_PASSPHRASE or a prompt.')
    .action((file: string, options: { profile?: string[]; includeSecrets?: boolean }) => {
      schedule((runtime) =>
        exportCommand(runtime, file, {
          profiles: options.profile ?? [],
          includeSecrets: options.includeSecrets === true,
        }),
      );
    });

  profiles
    .command('import')
    .description('import profiles from a passphrase-encrypted export file')
    .argument('<file>', 'file to read')
    .option('--replace', 'replace profiles that already exist (same id)')
    .addHelpText('after', '\nThe passphrase comes from QUERYBARA_EXPORT_PASSPHRASE or a prompt.')
    .action((file: string, options: { replace?: boolean }) => {
      schedule((runtime) => importCommand(runtime, file, { replace: options.replace === true }));
    });

  for (const command of program.commands) {
    if (TUNNEL_COMMANDS.has(command.name())) addTunnelOptions(command);
  }
  return program;
}

interface QueryCliOptions extends TunnelCliOptions {
  execute?: string;
  file?: string;
  format: OutputFormat;
  param?: (readonly [string, string])[];
  continue?: boolean;
  errorLog?: string;
  rowLimit: number;
  maxColumnWidth?: number;
  database?: string;
  readOnly?: boolean;
  yes?: boolean;
  tls?: TlsMode;
}

function queryOptions(options: QueryCliOptions): Parameters<typeof queryCommand>[2] {
  return {
    format: options.format,
    params: options.param ?? [],
    continueOnError: options.continue === true,
    rowLimit: options.rowLimit,
    yes: options.yes === true,
    ...(options.execute !== undefined ? { execute: options.execute } : {}),
    ...(options.file !== undefined ? { file: options.file } : {}),
    ...(options.errorLog !== undefined ? { errorLog: options.errorLog } : {}),
    ...(options.maxColumnWidth !== undefined ? { maxColumnWidth: options.maxColumnWidth } : {}),
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...tunnelFlags(options),
  };
}

interface ImportCliOptions extends TunnelCliOptions {
  table: string;
  file: string;
  format?: 'csv' | 'tsv' | 'json' | 'jsonl' | 'xlsx' | 'xml' | 'parquet';
  delimiter?: string;
  header: boolean;
  sheet?: string;
  headerRow?: number;
  rowPath?: string;
  encoding?: string;
  null?: string;
  mode: ImportDataOptions['mode'];
  key?: string[];
  create?: boolean;
  batchSize?: number;
  transaction: 'single' | 'per-batch';
  onError: 'stop' | 'skip';
  map?: (readonly [string, string])[];
  disableFkChecks?: boolean;
  errorLog?: string;
  database?: string;
  readOnly?: boolean;
  yes?: boolean;
  tls?: TlsMode;
}

/** The import command's options from its flags. */
export function importOptions(options: ImportCliOptions): ImportDataOptions {
  return {
    table: options.table,
    file: options.file,
    header: options.header !== false,
    mode: options.mode,
    create: options.create === true,
    onError: options.onError,
    transaction: options.transaction,
    disableForeignKeyChecks: options.disableFkChecks === true,
    map: options.map ?? [],
    yes: options.yes === true,
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
    ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
    ...(options.null !== undefined ? { nullMarker: options.null } : {}),
    ...(options.sheet !== undefined ? { sheet: options.sheet } : {}),
    ...(options.headerRow !== undefined ? { headerRow: options.headerRow } : {}),
    ...(options.rowPath !== undefined ? { rowPath: options.rowPath } : {}),
    ...(options.key !== undefined ? { key: options.key } : {}),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.errorLog !== undefined ? { errorLog: options.errorLog } : {}),
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...tunnelFlags(options),
  };
}

interface ExportCliOptions extends TunnelCliOptions {
  table?: string[];
  query?: string;
  format: ExportDataOptions['format'];
  out: string;
  gzip?: boolean;
  zip?: boolean;
  oneFile?: boolean;
  header: boolean;
  delimiter?: string;
  null?: string;
  pretty?: boolean;
  rowsPerInsert?: number;
  dropTable?: boolean;
  decimals?: 'text' | 'number';
  codec?: ParquetCompression;
  bom?: boolean;
  database?: string;
  yes?: boolean;
  tls?: TlsMode;
}

/** The export command's options from its flags. */
export function exportOptions(options: ExportCliOptions): ExportDataOptions {
  return {
    tables: options.table ?? [],
    format: options.format,
    out: options.out,
    gzip: options.gzip === true,
    zip: options.zip === true,
    oneFile: options.oneFile === true,
    header: options.header !== false,
    pretty: options.pretty === true,
    dropTable: options.dropTable === true,
    bom: options.bom === true,
    yes: options.yes === true,
    ...(options.query !== undefined ? { query: options.query } : {}),
    ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
    ...(options.null !== undefined ? { nullMarker: options.null } : {}),
    ...(options.rowsPerInsert !== undefined ? { rowsPerInsert: options.rowsPerInsert } : {}),
    ...(options.decimals !== undefined ? { decimals: options.decimals } : {}),
    ...(options.codec !== undefined ? { codec: options.codec } : {}),
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...tunnelFlags(options),
  };
}

interface TransferCliOptions extends TunnelCliOptions {
  table?: string[];
  all?: boolean;
  pattern?: string[];
  database?: string;
  schema?: string;
  targetDatabase?: string;
  targetSchema?: string;
  mode: DbTableMode;
  rename?: (readonly [string, string])[];
  type?: (readonly [string, string, string])[];
  skip?: (readonly [string, string])[];
  shape?: (readonly [string, string, FieldShape])[];
  embed?: TransferDbOptions['embeds'][number][];
  batchSize?: number;
  parallel?: number;
  onError: 'stop' | 'skip';
  transaction: boolean;
  disableConstraints?: boolean;
  deferConstraints: boolean;
  resetSequences: boolean;
  sample?: number;
  idFromKey: boolean;
  replace?: boolean;
  ttl: boolean;
  dryRun?: boolean;
  json?: boolean;
  errorLog?: string;
  yes?: boolean;
  tls?: TlsMode;
}

/** The transfer command's options from its flags. */
export function transferDbOptions(options: TransferCliOptions): TransferDbOptions {
  return {
    objects: options.table ?? [],
    patterns: options.pattern ?? [],
    all: options.all === true,
    renames: options.rename ?? [],
    types: options.type ?? [],
    skips: options.skip ?? [],
    shapes: options.shape ?? [],
    embeds: options.embed ?? [],
    options: {
      mode: options.mode,
      onError: options.onError,
      transactionPerBatch: options.transaction !== false,
      disableConstraints: options.disableConstraints === true,
      deferConstraints: options.deferConstraints !== false,
      resetSequences: options.resetSequences !== false,
      idFromPrimaryKey: options.idFromKey !== false,
      replace: options.replace === true,
      keepTtl: options.ttl !== false,
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
      ...(options.sample !== undefined ? { sampleSize: options.sample } : {}),
    },
    dryRun: options.dryRun === true,
    json: options.json === true,
    yes: options.yes === true,
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.targetDatabase !== undefined ? { targetDatabase: options.targetDatabase } : {}),
    ...(options.targetSchema !== undefined ? { targetSchema: options.targetSchema } : {}),
    ...(options.errorLog !== undefined ? { errorLog: options.errorLog } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...tunnelFlags(options),
  };
}

interface RunFileCliOptions extends TunnelCliOptions {
  continue?: boolean;
  errorLog?: string;
  encoding?: string;
  database?: string;
  readOnly?: boolean;
  yes?: boolean;
  tls?: TlsMode;
}

interface CompareCliOptions extends TunnelCliOptions {
  schema?: string[];
  ignore?: IgnoreName[];
  defaultIgnores?: boolean;
  rename?: RenameRule[];
  detectRenames?: boolean;
  includeDestructive?: boolean;
  out?: string;
  html?: string;
  json?: boolean;
  apply?: boolean;
  yes?: boolean;
  tls?: TlsMode;
}

interface DataCompareCliOptions extends TunnelCliOptions {
  table: string;
  targetTable?: string;
  key?: string[];
  columns?: string[];
  ignoreColumns?: string[];
  actions?: RowAction[];
  floatTolerance?: number;
  trim?: 'none' | 'trailing' | 'both';
  caseInsensitive?: boolean;
  showRows: number;
  batchSize?: number;
  disableFkChecks?: boolean;
  out?: string;
  json?: boolean;
  apply?: boolean;
  yes?: boolean;
  tls?: TlsMode;
}

interface AddCliOptions {
  name?: string;
  environment?: Environment;
  folder?: string;
  passwordPolicy?: SecretPolicy;
  readOnly?: boolean;
  confirmWrites?: boolean;
  tls?: TlsMode;
  engine?: 'mysql' | 'mariadb';
  tag?: string[];
  replace?: boolean;
}

function addProfileOptions(options: AddCliOptions): AddProfileOptions {
  return {
    tags: options.tag ?? [],
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.folder !== undefined ? { folder: options.folder } : {}),
    ...(options.passwordPolicy !== undefined ? { passwordPolicy: options.passwordPolicy } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.confirmWrites ? { confirmWrites: true } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.replace ? { replace: true } : {}),
  };
}
