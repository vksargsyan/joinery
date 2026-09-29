import type { Environment, SecretPolicy, TlsMode } from '@joinery/core';
import type { RenameRule, RowAction } from '@joinery/sync';
import { Command, CommanderError, Option } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
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
  from the profile's saved secret, JOINERY_PASSWORD_<PROFILE> or JOINERY_PASSWORD, or a
  hidden prompt. TLS defaults to verify-full unless the URI says otherwise (?sslmode=...)
  or --tls is given.

SSH tunnels and proxies:
  A saved profile connects through its own SSH tunnel and proxy. A URI target takes them
  from --ssh user@host[:port] (repeat it for jump hosts, in the order to connect), with
  --ssh-key <path>, --ssh-agent or an SSH password (--ssh-password-env <VAR>, else
  ${SSH_PASSWORD_ENV}, else a hidden prompt), and --proxy socks5://host:port or
  http://host:port. Host keys are checked against the desktop app's known_hosts (next to
  the store; --known-hosts to use another file): a new key is asked about in a terminal
  and refused otherwise unless --ssh-accept-new is given; a changed key is always refused.

Environment:
  JOINERY_STORE              local store file (default: the desktop app's joinery.db)
  JOINERY_PASSWORD           password for targets without one
  JOINERY_PASSWORD_<NAME>    password for one profile (name upper-cased, other chars as _)
  JOINERY_SSH_PASSWORD       SSH password for --ssh hops and profiles that ask for it
  JOINERY_SSH_KEY_PASSPHRASE passphrase of an encrypted SSH key
  JOINERY_PROXY_PASSWORD     proxy password (a --proxy URL may carry it too)
  JOINERY_PASSPHRASE         seals passwords the CLI saves (the OS keychain is app-only)
  JOINERY_EXPORT_PASSPHRASE  passphrase for profiles export/import files
  NO_COLOR                   turn colours off

Exit codes:
  0 success / no differences, 1 differences found or a failed connection test,
  2 error, 130 interrupted (Ctrl+C).
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
  reporter.debug(`joinery ${VERSION}; store ${location.path} (${location.source})`);
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
const TUNNEL_COMMANDS = new Set(['test', 'query', 'compare', 'data-compare', 'ddl']);

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
  const program = new Command('joinery')
    .description(
      "Test connections, run SQL, and compare or sync the structure and data of databases.\nThe Joinery desktop engine on the command line; shares the app's saved connections.",
    )
    .version(VERSION, '-V, --version', 'print the version')
    .helpOption('-h, --help', 'show help for a command')
    .option(
      '--store <path>',
      'local store file (env JOINERY_STORE; default: the desktop app store)',
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
      '\nExit code 0 when every step passes, 1 when one fails (with a fix hint), 2 on errors.\n\nExamples:\n  joinery test prod-db\n  joinery test "postgres://app@db.internal:5432/app?sslmode=verify-full"\n  joinery test "postgres://app@10.0.3.7/app" --ssh ops@bastion.example.com --ssh-agent',
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
  joinery query prod -e "select * from users where id = :id" --param id=42
  joinery query "postgres://app@localhost/app" -f migrate.sql --continue --error-log errors.log
  joinery query dev -f dump.sql --yes --quiet
  cat report.sql | joinery query dev --format csv > report.csv
  joinery query "mysql://app@db.internal/app" --ssh ops@jump:22 --ssh ops@bastion --ssh-key ~/.ssh/id_ed25519 -e "select 1"`,
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
  joinery compare staging prod --out deploy.sql --html report.html
  joinery compare dev "postgres://app@localhost/app_test" --schema public --json
  joinery compare model-db test-db --include-destructive --apply --yes`,
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
  joinery data-compare prod staging --table public.plans
  joinery data-compare prod staging --table plans --actions insert,update --out sync.sql
  joinery data-compare seed test --table countries --apply --yes`,
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
          'save (sealed with JOINERY_PASSPHRASE), session or ask. Default: save a password in the URI when JOINERY_PASSPHRASE is set, else ask',
        ).choices(['save', 'session', 'ask']),
      )
      .option('--read-only', 'lock the profile read-only: writes are refused')
      .option('--confirm-writes', 'ask before every write')
      .addOption(tlsOption().default(undefined, 'what the URI says, else verify-full'))
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
      '\nExamples:\n  JOINERY_PASSPHRASE=... joinery profiles add prod "postgres://app:secret@db:5432/app" --environment production\n  joinery profiles add dev "mysql://root@127.0.0.1/app" --folder Local',
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
    .addHelpText('after', '\nThe passphrase comes from JOINERY_EXPORT_PASSPHRASE or a prompt.')
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
    .addHelpText('after', '\nThe passphrase comes from JOINERY_EXPORT_PASSPHRASE or a prompt.')
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
