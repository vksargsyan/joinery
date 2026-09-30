import {
  DEFAULT_PAGE_SIZE,
  JoineryError,
  cancelledError,
  capabilitiesFor,
  toColumnChunk,
  type BrowseNode,
  type Capabilities,
  type CellValue,
  type EngineId,
  type ExecOptions,
  type ExplainOptions,
  type ExplainResult,
  type IntrospectScope,
  type LargeValueHandle,
  type NoticeSeverity,
  type PlanNode,
  type ResolvedProfile,
  type ResultChunk,
  type SchemaSnapshot,
  type Session,
} from '@joinery/core';
import {
  SessionGate,
  errorProp,
  positionalParams,
  str,
  type GateLease,
  type Row,
} from '@joinery/driver-sql-base';
import { quoteIdent } from '@joinery/sql-tools';
import { createConnection, type Connection, type ResultSetHeader } from 'mysql2';

import { browseMysql } from './browse';
import {
  buildMysqlConnectionPlan,
  invalidCharset,
  queryTimeoutStatement,
  type MysqlConnectionPlan,
} from './config';
import { commandOf } from './dialect';
import { isFatal, mapMysqlError } from './errors';
import {
  isNotExecutableJsonPlan,
  isNotExecutableTreePlan,
  normaliseMysqlJsonPlan,
  normaliseMysqlTreePlan,
  parseExplainJson,
} from './explain';
import { introspectMysql } from './introspect';
import { ResultStream, type CommandEvents } from './stream';
import { columnMeta } from './types';

type MysqlParam = string | number | boolean | Buffer | null;

/** CellValues as mysql2 binds them: bigint as text, bytes as a Buffer. */
export function toMysqlParams(
  values: readonly Exclude<CellValue, LargeValueHandle>[],
): MysqlParam[] {
  return values.map((value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array)
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return value;
  });
}

/**
 * Prepared statements a session keeps (spec §18: an import runs thousands of batches of one
 * INSERT). Reusing a statement saves a prepare round trip and the parameter definitions the
 * server sends back for every placeholder.
 */
export const PREPARED_STATEMENT_LIMIT = 64;

/** ER_UNKNOWN_STMT_HANDLER, ER_NEED_REPREPARE: the statement must be prepared again. */
const REPREPARE_ERRNOS = new Set([1243, 1615]);

/**
 * The SQL texts this connection has a prepared statement for, least recently used first.
 * mysql2 keeps the statements themselves (keyed by the text, reused by `execute`); this bounds
 * them and closes them on eviction. The server re-prepares a statement by itself when a table
 * it uses changes, but it keeps resolving names in the database current when it was prepared
 * and the parse of the sql_mode and character set of that time: the statements are closed
 * when the database changes and after SET statements.
 */
class PreparedStatements {
  private readonly texts = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly limit: number,
  ) {}

  /** Records a use of `sql` (about to be prepared or reused), closing the least recent beyond the limit. */
  use(sql: string): void {
    this.texts.delete(sql);
    this.texts.add(sql);
    for (const oldest of this.texts) {
      if (this.texts.size <= this.limit) break;
      this.close(oldest);
    }
  }

  /** Closes one statement: after a failed execution, or a one-off one. */
  close(sql: string): void {
    this.texts.delete(sql);
    try {
      this.connection.unprepare(sql);
    } catch {
      // Never prepared (the prepare failed), or the connection is gone and the statement with it.
    }
  }

  closeAll(): void {
    for (const sql of [...this.texts]) this.close(sql);
  }
}

const SERVER_STATUS_IN_TRANS = 1;
/** How long an abandoned result may drain before the server is asked to stop sending it. */
const DRAIN_GRACE_MS = 250;

const SEVERITIES: Readonly<Record<string, NoticeSeverity>> = {
  Note: 'notice',
  Warning: 'warning',
  Error: 'warning',
};

/** mysql2 internals the session relies on (EOF packets carry warning counts and status). */
interface PacketLike {
  isEOF(): boolean;
  eofWarningCount(): number;
  eofStatusFlags(): number;
}
interface PacketHook {
  handlePacket(packet?: PacketLike | null): void;
}

class MysqlExecution {
  cancelRequested = false;
  /** Count EOF warnings for this statement (off during internal queries like SHOW WARNINGS). */
  capturing = false;
  warnings = 0;
  closeReason: JoineryError | undefined;
  finished = false;
  killSent: Promise<void> = Promise.resolve();
  stream: ResultStream | undefined;
  private draining: Promise<void> | undefined;
  private pending: Promise<unknown> | undefined;

  constructor(
    readonly id: string,
    readonly lease: GateLease,
  ) {}

  async track<T>(work: Promise<T>): Promise<T> {
    this.pending = work;
    try {
      return await work;
    } finally {
      this.pending = undefined;
    }
  }

  get inFlight(): boolean {
    return this.pending !== undefined;
  }

  async idle(): Promise<void> {
    if (this.pending) await this.pending.catch(() => undefined);
  }

  /** Lets an unfinished command run out, killing it if it does not end quickly. */
  finishStream(kill: () => Promise<void>): Promise<void> {
    const stream = this.stream;
    if (!stream || stream.ended) return Promise.resolve();
    this.draining ??= (async () => {
      const drained = stream.discardRest();
      const timer = new Promise<'slow'>((resolve) =>
        setTimeout(() => resolve('slow'), DRAIN_GRACE_MS).unref(),
      );
      if ((await Promise.race([drained, timer])) === 'slow') await kill().catch(() => undefined);
      await drained;
    })();
    return this.draining;
  }
}

/**
 * One MySQL or MariaDB connection behind the Session contract. Results stream from the text
 * protocol (or the binary protocol when there are parameters, through prepared statements the
 * session keeps for reuse) with socket back-pressure; cancel sends KILL QUERY from a control
 * connection; `inTransaction` follows the server status flags of every OK and EOF packet. One
 * thing runs at a time: a new operation closes a paused result, draining it or killing it if it
 * does not end quickly.
 */
export class MysqlSession implements Session {
  private readonly gate = new SessionGate();
  private active: MysqlExecution | null = null;
  private broken: JoineryError | null = null;
  private closed = false;
  private serverStatus = 0;
  private readonly statements: PreparedStatements;

  private constructor(
    readonly engine: EngineId,
    private readonly flavor: 'mysql' | 'mariadb',
    private readonly resolved: ResolvedProfile,
    private readonly plan: MysqlConnectionPlan,
    private readonly connection: Connection,
    readonly serverVersion: string,
    private database: string | null,
  ) {
    this.statements = new PreparedStatements(connection, PREPARED_STATEMENT_LIMIT);
    connection.on('error', (error: unknown) => {
      this.broken = mapMysqlError(error, { where: plan.where });
      this.active?.stream?.fail(this.broken);
    });
    connection.on('end', () => {
      this.broken ??= new JoineryError({
        code: 'CONNECTION_FAILED',
        message: 'The connection to the server was closed',
      });
      this.active?.stream?.fail(this.broken);
    });
    // EOF packets end every result set and carry the warning count and transaction status.
    const hook = connection as unknown as PacketHook;
    const handlePacket = hook.handlePacket.bind(connection);
    hook.handlePacket = (packet) => {
      if (packet && packet.isEOF()) {
        this.serverStatus = packet.eofStatusFlags();
        const exec = this.active;
        if (exec?.capturing) exec.warnings = Math.max(exec.warnings, packet.eofWarningCount());
      }
      handlePacket(packet);
    };
  }

  /** Connects, detects MySQL or MariaDB from the version banner and runs the session setup. */
  static async open(resolved: ResolvedProfile, engine: 'mysql' | 'mariadb'): Promise<MysqlSession> {
    const plan = buildMysqlConnectionPlan(resolved);
    let connection: Connection;
    try {
      connection = createConnection(plan.options);
    } catch (error) {
      const charset = resolved.profile.options.charset;
      if (charset !== undefined && /charset/i.test(String(error)))
        throw invalidCharset(charset, error);
      throw mapMysqlError(error, { where: plan.where, connecting: true });
    }
    connection.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        connection.connect((error: unknown) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      connection.destroy();
      throw mapMysqlError(error, { where: plan.where, connecting: true });
    }
    const run = (sql: string): Promise<Row[]> =>
      new Promise((resolve, reject) => {
        connection.query({ sql, rowsAsArray: false }, (error: unknown, result: unknown) => {
          if (error) reject(error);
          else resolve(Array.isArray(result) ? (result as Row[]) : []);
        });
      });
    try {
      const [info] = await run('SELECT VERSION() AS version, DATABASE() AS db');
      const version = str(info ?? {}, 'version');
      const flavor = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
      if (plan.queryTimeoutMs !== undefined)
        await run(queryTimeoutStatement(flavor === 'mariadb', plan.queryTimeoutMs));
      for (const statement of plan.setup) await run(statement);
      const db = info?.['db'];
      return new MysqlSession(
        engine,
        flavor,
        resolved,
        plan,
        connection,
        version,
        typeof db === 'string' ? db : null,
      );
    } catch (error) {
      connection.destroy();
      throw mapMysqlError(error, { where: plan.where, connecting: true });
    }
  }

  get inTransaction(): boolean {
    return (this.serverStatus & SERVER_STATUS_IN_TRANS) !== 0;
  }

  /** Capabilities of the server actually connected (MariaDB is detected from its banner). */
  capabilities(): Capabilities {
    return capabilitiesFor(this.flavor, this.serverVersion);
  }

  private assertUsable(): void {
    if (this.closed)
      throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
    if (this.broken) throw this.broken;
  }

  private noteFatal(error: unknown): void {
    if (isFatal(error)) this.broken ??= mapMysqlError(error, { where: this.plan.where });
  }

  /** Runs an internal query with object rows. Callers hold the gate. */
  private query(sql: string, values: unknown[] = []): Promise<Row[]> {
    this.assertUsable();
    return new Promise((resolve, reject) => {
      this.connection.query(
        { sql, values, rowsAsArray: false },
        (error: unknown, result: unknown) => {
          if (error) {
            this.noteFatal(error);
            reject(mapMysqlError(error, { where: this.plan.where, statement: sql }));
            return;
          }
          if (Array.isArray(result)) {
            resolve(result as Row[]);
          } else {
            const header = result as ResultSetHeader;
            if (typeof header.serverStatus === 'number') this.serverStatus = header.serverStatus;
            resolve([]);
          }
        },
      );
    });
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    return this.run(text, opts);
  }

  private async *run(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    const started = performance.now();
    const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE));
    const params = toMysqlParams(positionalParams(opts.params));
    if (opts.signal?.aborted) throw cancelledError();

    const lease = await this.gate.acquire();
    const exec = new MysqlExecution(opts.executionId, lease);
    const kill = (): Promise<void> => this.killQuery();
    lease.setPreemptHandler(async () => {
      exec.closeReason ??= new JoineryError({
        code: 'CANCELLED',
        message: 'The result was closed because another statement ran on this session',
      });
      await exec.idle();
      await exec.finishStream(kill);
      if (this.active === exec) this.active = null;
    });
    this.active = exec;
    const onAbort = (): void => void this.cancel(opts.executionId).catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const prepared = params.length > 0;
    const tag = commandOf(text);
    let failed = false;

    try {
      this.assertUsable();
      if (opts.signal?.aborted) throw cancelledError();
      exec.capturing = true;
      const start = (): ResultStream => {
        if (prepared) this.statements.use(text);
        const command = (prepared
          ? this.connection.execute(text, params)
          : this.connection.query(text)) as unknown as CommandEvents;
        return (exec.stream = new ResultStream(this.connection, command, pageSize));
      };
      let stream = start();
      let reprepared = false;
      let resultIndex = -1;
      let columnCount = 0;
      let rowCount = 0;
      let sawHeader = false;

      for (;;) {
        if (exec.closeReason) throw exec.closeReason;
        let chunk: Awaited<ReturnType<ResultStream['next']>>;
        try {
          chunk = await exec.track(stream.next());
        } catch (error) {
          this.noteFatal(error);
          if (exec.cancelRequested) {
            await exec.killSent;
            throw cancelledError('Query cancelled');
          }
          const errno = Number(errorProp(error, 'errno'));
          if (
            prepared &&
            !reprepared &&
            resultIndex < 0 &&
            !sawHeader &&
            REPREPARE_ERRNOS.has(errno)
          ) {
            // The kept statement is unusable (lost, or it cannot be re-prepared in place):
            // nothing ran, so prepare it again and retry once.
            reprepared = true;
            this.statements.close(text);
            stream = start();
            continue;
          }
          throw mapMysqlError(error, { where: this.plan.where, statement: text });
        }
        if (exec.cancelRequested) {
          await exec.killSent;
          await exec.finishStream(kill);
          throw cancelledError('Query cancelled');
        }
        if (chunk === null) break;
        if (chunk.kind === 'fields') {
          resultIndex += 1;
          columnCount = chunk.fields.length;
          yield { type: 'columns', resultIndex, columns: chunk.fields.map(columnMeta) };
        } else if (chunk.kind === 'rows') {
          rowCount += chunk.rows.length;
          yield toColumnChunk(Math.max(resultIndex, 0), columnCount, chunk.rows);
        } else {
          sawHeader = true;
          const header = chunk.header;
          this.serverStatus = header.serverStatus;
          exec.warnings = Math.max(exec.warnings, header.warningStatus);
          yield {
            type: 'status',
            command: tag,
            rowsAffected: header.affectedRows,
            ...(header.insertId > 0 ? { lastInsertId: String(header.insertId) } : {}),
          };
        }
      }
      exec.capturing = false;
      if (!sawHeader) yield { type: 'status', command: tag, rowsAffected: null };
      // Only while the session is still ours: a paused consumer may have been preempted.
      if (exec.warnings > 0 && !exec.closeReason) yield* await this.showWarnings();
      yield { type: 'end', durationMs: Math.round(performance.now() - started), rowCount };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      exec.capturing = false;
      opts.signal?.removeEventListener('abort', onAbort);
      exec.finished = true;
      if (this.active === exec) this.active = null;
      await exec.idle();
      await exec.finishStream(kill);
      // A failed or cancelled execution may leave its statement half-used: prepare it afresh.
      if (prepared && failed) this.statements.close(text);
      if (tag === 'USE' || tag === 'SET') this.statements.closeAll();
      lease.release();
    }
  }

  private async showWarnings(): Promise<ResultChunk[]> {
    const rows = await this.query('SHOW WARNINGS').catch(() => [] as Row[]);
    return rows.map((row) => ({
      type: 'notice',
      severity: SEVERITIES[str(row, 'Level')] ?? 'warning',
      message: str(row, 'Message'),
      code: str(row, 'Code'),
    }));
  }

  async cancel(executionId: string): Promise<void> {
    const exec = this.active;
    if (!exec || exec.id !== executionId || exec.finished || exec.cancelRequested) return;
    exec.cancelRequested = true;
    const wasInFlight = exec.inFlight;
    if (exec.stream && !exec.stream.ended) {
      const sent = this.killQuery();
      exec.killSent = sent.catch(() => undefined);
      await sent;
    }
    if (!wasInFlight && !exec.inFlight) {
      // Paused between pages: close the result here, the consumer may never pull again.
      exec.closeReason = cancelledError('Query cancelled');
      exec.lease.requestPreempt();
    }
  }

  /** KILL QUERY over a short-lived control connection (spec §6). */
  private async killQuery(): Promise<void> {
    const plan = buildMysqlConnectionPlan(this.resolved, { control: true });
    const control = createConnection(plan.options);
    control.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        control.query(`KILL QUERY ${Number(this.connection.threadId)}`, (error: unknown) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      throw mapMysqlError(error, { where: plan.where, connecting: true });
    } finally {
      control.destroy();
    }
  }

  async introspect(scope: IntrospectScope = {}): Promise<SchemaSnapshot> {
    const database = scope.database ?? this.database;
    if (!database) {
      throw new JoineryError({
        code: 'VALIDATION_FAILED',
        message: 'No database selected to introspect',
        hint: 'Pass a database, or set a default database in the profile',
      });
    }
    return this.gate.run(async () => {
      let restoreExpiry: string | undefined;
      if (this.flavor === 'mysql') {
        // MySQL 8 caches information_schema statistics (AUTO_INCREMENT...) for a day by default.
        const [row] = await this.query(
          'SELECT @@SESSION.information_schema_stats_expiry AS expiry',
        ).catch(() => [] as Row[]);
        if (row) {
          restoreExpiry = str(row, 'expiry');
          await this.query('SET SESSION information_schema_stats_expiry = 0');
        }
      }
      try {
        return await introspectMysql(
          (sql, values) => this.query(sql, values),
          {
            database,
            mariadb: this.flavor === 'mariadb',
            engine: this.engine,
            serverVersion: this.serverVersion,
          },
          scope,
        );
      } finally {
        if (restoreExpiry !== undefined) {
          await this.query(
            `SET SESSION information_schema_stats_expiry = ${Number(restoreExpiry)}`,
          ).catch(() => undefined);
        }
      }
    });
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    return this.gate.run(() =>
      browseMysql(
        (sql, values) => this.query(sql, values),
        this.flavor === 'mariadb',
        this.serverVersion,
        path,
      ),
    );
  }

  /**
   * EXPLAIN FORMAT=JSON normalised to a PlanNode tree. With `analyze`, MySQL runs EXPLAIN
   * ANALYZE (tree text) and MariaDB ANALYZE FORMAT=JSON, inside a transaction (or savepoint)
   * that is rolled back.
   */
  async explain(text: string, opts: ExplainOptions = {}): Promise<PlanNode> {
    return (await this.explainPlan(text, opts)).plan;
  }

  async explainPlan(text: string, opts: ExplainOptions = {}): Promise<ExplainResult> {
    const mariadb = this.flavor === 'mariadb';
    const analyze = opts.analyze === true;
    const estimate = 'EXPLAIN FORMAT=JSON ';
    const prefix = analyze ? (mariadb ? 'ANALYZE FORMAT=JSON ' : 'EXPLAIN ANALYZE ') : estimate;
    const params = toMysqlParams(positionalParams(opts.params));
    // One-off statements: closed afterwards rather than kept (see PreparedStatements).
    const prepared = new Set<string>();
    return this.gate.run(async () => {
      this.assertUsable();
      const run = (head: string): Promise<string> =>
        new Promise((resolve, reject) => {
          const callback = (error: unknown, result: unknown): void => {
            if (error) {
              this.noteFatal(error);
              const mapped = mapMysqlError(error, {
                where: this.plan.where,
                statement: head + text,
              });
              reject(
                mapped.position === undefined
                  ? mapped
                  : new JoineryError({
                      ...mapped.toJSON(),
                      position: Math.max(0, mapped.position - head.length),
                    }),
              );
              return;
            }
            const first = Array.isArray(result) ? (result[0] as unknown) : undefined;
            const output = Array.isArray(first) ? (first[0] as unknown) : undefined;
            resolve(typeof output === 'string' ? output : String(output ?? ''));
          };
          if (params.length > 0) {
            prepared.add(head + text);
            this.connection.execute(head + text, params, callback);
          } else this.connection.query({ sql: head + text, rowsAsArray: true }, callback);
        });
      const fromJson = (raw: string, rolledBack: boolean): ExplainResult => ({
        plan: normaliseMysqlJsonPlan(parseExplainJson(raw)),
        raw,
        rawFormat: 'json',
        rolledBack,
      });
      // The estimated plan as JSON. MySQL 9's default JSON version 2 has no plan for
      // single-table UPDATE and DELETE; version 1 does, so ask for it for those alone.
      const estimated = async (rolledBack: boolean): Promise<ExplainResult> => {
        const raw = await run(estimate);
        if (mariadb || !isNotExecutableJsonPlan(parseExplainJson(raw))) {
          return fromJson(raw, rolledBack);
        }
        const [setting] = await this.query('SELECT @@SESSION.explain_json_format_version AS v');
        await this.query('SET SESSION explain_json_format_version = 1');
        try {
          return fromJson(await run(estimate), rolledBack);
        } finally {
          await this.query('SET SESSION explain_json_format_version = ?', [
            Number(setting?.['v'] ?? 2),
          ]);
        }
      };
      try {
        if (!analyze) return await estimated(false);
        // ANALYZE executes the statement: keep its effects out of the database.
        const nested = this.inTransaction;
        await this.query(nested ? 'SAVEPOINT joinery_explain' : 'START TRANSACTION');
        try {
          const output = await run(prefix);
          if (mariadb) return fromJson(output, true);
          if (!isNotExecutableTreePlan(output)) {
            return {
              plan: normaliseMysqlTreePlan(output),
              raw: output,
              rawFormat: 'text',
              rolledBack: true,
            };
          }
          // MySQL cannot EXPLAIN ANALYZE some statements (single-table UPDATE and DELETE):
          // return the estimated plan and say so, rather than a plan with no rows or timings.
          const result = await estimated(true);
          const detail = { ...result.plan.detail, analyze_unavailable: true };
          return { ...result, plan: { ...result.plan, detail } };
        } finally {
          await this.query(nested ? 'ROLLBACK TO SAVEPOINT joinery_explain' : 'ROLLBACK').catch(
            () => undefined,
          );
        }
      } finally {
        for (const sql of prepared) this.statements.close(sql);
      }
    });
  }

  async begin(): Promise<void> {
    await this.gate.run(() => this.query('START TRANSACTION'));
  }

  async commit(): Promise<void> {
    await this.gate.run(() => this.query('COMMIT'));
  }

  async rollback(): Promise<void> {
    await this.gate.run(() => this.query('ROLLBACK'));
  }

  async useDatabase(name: string): Promise<void> {
    await this.gate.run(async () => {
      try {
        await this.query(`USE ${quoteIdent(name, this.flavor)}`);
        this.database = name;
      } finally {
        this.statements.closeAll();
      }
    });
  }

  async ping(): Promise<void> {
    this.assertUsable();
    if (this.gate.holdsOpenResult) return;
    await this.gate.run(() => this.query('SELECT 1'));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ended = new Promise<void>((resolve) => this.connection.end(() => resolve()));
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 2000).unref(),
    );
    if ((await Promise.race([ended, timeout])) === 'timeout') this.connection.destroy();
  }
}
