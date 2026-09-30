import {
  DEFAULT_PAGE_SIZE,
  JoineryError,
  cancelledError,
  capabilitiesFor,
  toColumnChunk,
  type BrowseNode,
  type Capabilities,
  type CellValue,
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
  positionalParams,
  str,
  type GateLease,
  type Row,
} from '@joinery/driver-sql-base';
import { Client, type FieldDef, type QueryResult } from 'pg';
import Cursor from 'pg-cursor';

import { browsePostgres } from './browse';
import { buildPgConnectionPlan, type PgConnectionPlan } from './config';
import { mapPgError } from './errors';
import { normalisePgPlan } from './explain';
import { introspectPostgres } from './introspect';
import {
  columnMeta,
  isBuiltinType,
  kindForCategory,
  type RelationInfo,
  type TypeInfo,
} from './types';

type PgParam = string | number | boolean | Buffer | null;

/** Converts CellValues to what pg sends: bigint as text, bytes as a Buffer (binary format). */
export function toPgValues(values: readonly Exclude<CellValue, LargeValueHandle>[]): PgParam[] {
  return values.map((value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array)
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return value;
  });
}

/** Command tag → command and affected-row count: "INSERT 0 5" → ["INSERT", 5]. */
export function parseCommandTag(tag: string): { command: string; count: number | null } {
  const match = /^(.*?)(?: (\d+))?(?: (\d+))?$/.exec(tag.trim());
  const command = match?.[1] ?? tag;
  const count = match?.[3] ?? match?.[2];
  return { command, count: count === undefined ? null : Number(count) };
}

const DDL_COMMAND = /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|SECURITY LABEL)\b/;

const SEVERITIES: Readonly<Record<string, NoticeSeverity>> = {
  DEBUG: 'debug',
  LOG: 'info',
  INFO: 'info',
  NOTICE: 'notice',
  WARNING: 'warning',
};

/** Per-execution bookkeeping, shared by `execute`, `cancel` and preemption. */
class PgExecution {
  cancelRequested = false;
  closeReason: JoineryError | undefined;
  finished = false;
  cancelSent: Promise<void> = Promise.resolve();
  readonly notices: ResultChunk[] = [];
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
}

interface Page {
  readonly rows: CellValue[][];
  readonly result: QueryResult;
}

function readPage(cursor: Cursor, size: number): Promise<Page> {
  return new Promise((resolve, reject) => {
    cursor.read(size, (error, rows, result) => {
      if (error) reject(error);
      else resolve({ rows: rows as CellValue[][], result });
    });
  });
}

/** Instance hooks on a pg-cursor; pg routes protocol messages to these methods. */
interface CursorHooks {
  handleDataRow?: (msg: { fields: (string | null)[] }) => void;
  handleCommandComplete?: (msg: { text: string }, connection: unknown) => void;
  handleError?: (error: unknown, connection: unknown) => void;
  handleCopyInResponse?: (connection: { sendCopyFail(message: string): void }) => void;
  handleCopyData?: () => void;
}

const LOOKUP_SQL = `SELECT 't' AS k, t.oid::text AS oid, t.typname::text AS name, t.typtype::text AS a,
  t.typcategory::text AS b, coalesce(e.typname::text, '') AS c, coalesce(b.typcategory::text, '') AS d
FROM pg_catalog.pg_type t
LEFT JOIN pg_catalog.pg_type e ON e.oid = t.typelem AND t.typcategory = 'A'
LEFT JOIN pg_catalog.pg_type b ON b.oid = t.typbasetype
WHERE t.oid = ANY($1::oid[])
UNION ALL
SELECT 'r', c.oid::text, c.relname::text, n.nspname::text,
  coalesce((SELECT string_agg(a.attnum::text, ',') FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnotnull AND a.attnum > 0), ''), '', ''
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = ANY($2::oid[])`;

/**
 * One PostgreSQL connection behind the Session contract. Statements stream through pg-cursor
 * portals (the iterator is the cursor); cancel uses pg_cancel_backend from a control
 * connection; `inTransaction` follows the server's ReadyForQuery status, so BEGIN and COMMIT
 * typed as SQL count too. One thing runs at a time: a new operation closes a paused result.
 */
export class PostgresSession implements Session {
  readonly engine = 'postgres' as const;
  private readonly gate = new SessionGate();
  private active: PgExecution | null = null;
  private broken: JoineryError | null = null;
  private closed = false;
  private readonly types = new Map<number, TypeInfo>();
  private readonly relations = new Map<number, RelationInfo>();

  private constructor(
    private readonly resolved: ResolvedProfile,
    private readonly plan: PgConnectionPlan,
    private readonly client: Client,
    readonly serverVersion: string,
    private readonly backendPid: number,
    private readonly database: string,
  ) {
    client.on('error', (error) => {
      this.broken = mapPgError(error, { where: plan.where });
    });
    client.on('notice', (msg) => {
      const severity = SEVERITIES[msg.severity ?? 'NOTICE'] ?? 'notice';
      const text = [
        msg.message ?? '',
        msg.detail ? `DETAIL: ${msg.detail}` : '',
        msg.hint ? `HINT: ${msg.hint}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.active?.notices.push({
        type: 'notice',
        severity,
        message: text,
        ...(msg.code ? { code: msg.code } : {}),
      });
    });
    client.on('notification', (msg) => {
      this.active?.notices.push({
        type: 'notice',
        severity: 'info',
        message: `Asynchronous notification "${msg.channel}"${msg.payload ? ` with payload "${msg.payload}"` : ''} received from server process with PID ${msg.processId}.`,
      });
    });
  }

  /** Connects, reads the server version and backend PID, and runs the session setup SQL. */
  static async open(resolved: ResolvedProfile): Promise<PostgresSession> {
    const plan = buildPgConnectionPlan(resolved);
    const client = new Client(plan.config);
    // Errors while connecting reject connect(); this keeps a late socket error from crashing.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      throw mapPgError(error, { where: plan.where, connecting: true });
    }
    try {
      const info = await client.query<Row>(
        `SELECT current_setting('server_version') AS version, pg_backend_pid() AS pid, current_database() AS db`,
      );
      const row = info.rows[0]!;
      for (const statement of plan.setup) await client.query(statement);
      return new PostgresSession(
        resolved,
        plan,
        client,
        str(row, 'version'),
        Number(row['pid']),
        str(row, 'db'),
      );
    } catch (error) {
      await client.end().catch(() => undefined);
      throw mapPgError(error, { where: plan.where, connecting: true });
    }
  }

  get inTransaction(): boolean {
    const status = this.client.getTransactionStatus();
    return status === 'T' || status === 'E';
  }

  capabilities(): Capabilities {
    return capabilitiesFor('postgres', this.serverVersion);
  }

  private assertUsable(): void {
    if (this.closed)
      throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'The session is closed' });
    if (this.broken) throw this.broken;
  }

  /** Runs an internal (non-streamed) query. Callers hold the gate. */
  private async query(text: string, values: unknown[] = []): Promise<Row[]> {
    this.assertUsable();
    try {
      const result = await this.client.query<Row>(text, values);
      return result.rows;
    } catch (error) {
      throw mapPgError(error, { where: this.plan.where, statement: text });
    }
  }

  execute(text: string, opts: ExecOptions): AsyncIterable<ResultChunk> {
    return this.run(text, opts);
  }

  private async *run(text: string, opts: ExecOptions): AsyncGenerator<ResultChunk> {
    const started = performance.now();
    const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE));
    const values = toPgValues(positionalParams(opts.params));
    if (opts.signal?.aborted) throw cancelledError();

    const lease = await this.gate.acquire();
    const exec = new PgExecution(opts.executionId, lease);
    let cursor: Cursor | undefined;
    let cursorState: 'open' | 'closed' | 'dead' = 'open';
    const closeCursor = async (): Promise<void> => {
      if (cursor === undefined || cursorState !== 'open') return;
      cursorState = 'closed';
      await cursor.close().catch(() => undefined);
    };
    lease.setPreemptHandler(async () => {
      exec.closeReason ??= new JoineryError({
        code: 'CANCELLED',
        message: 'The result was closed because another statement ran on this session',
      });
      await exec.idle();
      await closeCursor();
      if (this.active === exec) this.active = null;
    });
    this.active = exec;
    const onAbort = (): void => void this.cancel(opts.executionId).catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      this.assertUsable();
      if (opts.signal?.aborted) throw cancelledError();
      const state: { tag: string | null } = { tag: null };
      const current = new Cursor(text, values, { rowMode: 'array' });
      cursor = current;
      const hooks = current as unknown as CursorHooks;
      const original = (Cursor.prototype as unknown as Required<CursorHooks>).handleCommandComplete;
      hooks.handleCommandComplete = (msg, connection) => {
        state.tag = msg.text;
        original.call(current, msg, connection);
      };
      let copyRefused = false;
      hooks.handleCopyInResponse = (connection) => {
        copyRefused = true;
        connection.sendCopyFail('COPY FROM STDIN is not supported here');
      };
      let copyNotice = false;
      hooks.handleCopyData = () => {
        if (copyNotice) return;
        copyNotice = true;
        exec.notices.push({
          type: 'notice',
          severity: 'info',
          message: 'COPY TO STDOUT output is not shown; use the export tools',
        });
      };
      this.client.query(current);

      let rowCount = 0;
      let columnCount = 0;
      let first = true;
      for (;;) {
        if (exec.closeReason) throw exec.closeReason;
        let page: Page;
        try {
          page = await exec.track(readPage(current, pageSize));
        } catch (error) {
          cursorState = 'dead';
          if (copyRefused) {
            throw new JoineryError({
              code: 'NOT_SUPPORTED',
              message: 'COPY FROM STDIN cannot run in the SQL editor',
              hint: 'Use the import tools, or COPY FROM a server-side file',
            });
          }
          throw mapPgError(error, {
            where: this.plan.where,
            statement: text,
            cancelRequested: exec.cancelRequested,
          });
        }
        if (exec.cancelRequested) {
          await exec.cancelSent;
          await closeCursor();
          throw cancelledError('Query cancelled');
        }
        const done = page.result.command !== null || page.rows.length === 0;
        if (done) cursorState = 'closed';
        yield* exec.notices.splice(0);
        if (first) {
          first = false;
          const fields = page.result.fields;
          if (fields.length > 0) {
            // The notices above were a yield: the result may have been closed meanwhile.
            if (exec.closeReason) throw exec.closeReason;
            await this.resolveColumnMetadata(fields, current, done, exec, () => {
              cursorState = 'dead';
            });
            columnCount = fields.length;
            yield {
              type: 'columns',
              resultIndex: 0,
              columns: fields.map((field) => columnMeta(field, this.types, this.relations)),
            };
          }
        }
        if (page.rows.length > 0) {
          rowCount += page.rows.length;
          yield toColumnChunk(0, columnCount, page.rows);
        }
        if (done) break;
      }

      yield* exec.notices.splice(0);
      if (state.tag !== null) {
        const { command, count } = parseCommandTag(state.tag);
        if (DDL_COMMAND.test(command)) this.relations.clear();
        yield {
          type: 'status',
          command,
          rowsAffected: columnCount > 0 && command === 'SELECT' ? null : count,
        };
      }
      yield { type: 'end', durationMs: Math.round(performance.now() - started), rowCount };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      exec.finished = true;
      if (this.active === exec) this.active = null;
      await exec.idle();
      await closeCursor();
      lease.release();
    }
  }

  /**
   * Looks up names for non-built-in types and source tables of a result's columns. While the
   * cursor's portal is still open the lookup runs on the same connection, inside the portal's
   * implicit transaction (an unnamed statement next to the named portal); once the result is
   * complete it is an ordinary query. Results are cached for the session.
   */
  private async resolveColumnMetadata(
    fields: readonly FieldDef[],
    cursor: Cursor,
    cursorDone: boolean,
    exec: PgExecution,
    markDead: () => void,
  ): Promise<void> {
    const typeOids = [
      ...new Set(
        fields
          .map((f) => f.dataTypeID)
          .filter((oid) => !isBuiltinType(oid) && !this.types.has(oid)),
      ),
    ];
    const relOids = [
      ...new Set(fields.map((f) => f.tableID).filter((oid) => oid > 0 && !this.relations.has(oid))),
    ];
    if (typeOids.length === 0 && relOids.length === 0) return;
    const params = [`{${typeOids.join(',')}}`, `{${relOids.join(',')}}`];
    let rows: (string | null)[][];
    try {
      rows = await exec.track(
        cursorDone
          ? this.client
              .query<(string | null)[]>({ text: LOOKUP_SQL, values: params, rowMode: 'array' })
              .then((r) => r.rows)
          : this.interleavedQuery(cursor, LOOKUP_SQL, params, markDead),
      );
    } catch (error) {
      throw mapPgError(error, {
        where: this.plan.where,
        cancelRequested: exec.cancelRequested,
      });
    }
    for (const row of rows) {
      const [k, oid, name, a, b, c, d] = row.map((v) => v ?? '');
      if (k === 't') {
        if (b === 'A') {
          this.types.set(Number(oid), { name: `${c}[]`, kind: 'array' });
        } else {
          const category = a === 'd' && d ? d : b!;
          this.types.set(Number(oid), { name: name!, kind: kindForCategory(category, a!, name!) });
        }
      } else {
        const notNull = new Set((b ?? '').split(',').filter(Boolean).map(Number));
        this.relations.set(Number(oid), { table: name!, schema: a!, notNull });
      }
    }
  }

  /**
   * Runs a small query while a pg-cursor portal is suspended: Parse/Bind/Execute on the unnamed
   * statement and portal, without Sync, so the cursor's portal and implicit transaction stay
   * open. pg routes the replies to the active query (the cursor), so its handlers are swapped
   * for the duration.
   */
  private interleavedQuery(
    cursor: Cursor,
    text: string,
    values: string[],
    markDead: () => void,
  ): Promise<(string | null)[][]> {
    const connection = this.client.connection;
    const hooks = cursor as unknown as CursorHooks & Record<string, unknown>;
    const saved = {
      handleDataRow: Object.getOwnPropertyDescriptor(hooks, 'handleDataRow'),
      handleCommandComplete: Object.getOwnPropertyDescriptor(hooks, 'handleCommandComplete'),
      handleError: Object.getOwnPropertyDescriptor(hooks, 'handleError'),
    };
    const restore = (): void => {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(hooks, key, descriptor);
        else Reflect.deleteProperty(hooks, key);
      }
    };
    return new Promise((resolve, reject) => {
      const rows: (string | null)[][] = [];
      hooks.handleDataRow = (msg) => rows.push(msg.fields);
      hooks.handleCommandComplete = () => {
        restore();
        resolve(rows);
      };
      hooks.handleError = (error) => {
        restore();
        // The implicit transaction is aborted: sync to get the connection back, the portal is gone.
        markDead();
        connection.sync();
        reject(error);
      };
      connection.parse({ name: '', text, types: [] }, true);
      connection.bind({ values }, true);
      // Unnamed portal, no row limit.
      connection.execute({}, true);
      connection.flush();
    });
  }

  async cancel(executionId: string): Promise<void> {
    const exec = this.active;
    if (!exec || exec.id !== executionId || exec.finished || exec.cancelRequested) return;
    exec.cancelRequested = true;
    if (exec.inFlight) {
      const sent = this.cancelBackend();
      exec.cancelSent = sent.catch(() => undefined);
      await sent;
    } else {
      // Paused between pages: nothing runs on the server, so close the result right here.
      exec.closeReason = cancelledError('Query cancelled');
      exec.lease.requestPreempt();
    }
  }

  /** pg_cancel_backend over a short-lived control connection (spec §6). */
  private async cancelBackend(): Promise<void> {
    const plan = buildPgConnectionPlan(this.resolved, { control: true });
    const control = new Client(plan.config);
    control.on('error', () => undefined);
    try {
      await control.connect();
      await control.query('SELECT pg_catalog.pg_cancel_backend($1)', [this.backendPid]);
    } catch (error) {
      throw mapPgError(error, { where: plan.where, connecting: true });
    } finally {
      await control.end().catch(() => undefined);
    }
  }

  async introspect(scope: IntrospectScope = {}): Promise<SchemaSnapshot> {
    if (scope.database !== undefined && scope.database !== this.database) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `This session is connected to "${this.database}"; PostgreSQL needs a new connection to introspect "${scope.database}"`,
      });
    }
    return this.gate.run(() =>
      this.inReadOnlySnapshot(() =>
        introspectPostgres((text, values) => this.query(text, values), scope, this.serverVersion),
      ),
    );
  }

  /**
   * Runs catalog reads in one REPEATABLE READ snapshot with an empty search_path, so every
   * definition PostgreSQL prints (defaults, views, triggers, types) is schema-qualified and
   * independent of the session's own search_path. Inside a user transaction a savepoint scopes
   * the setting instead.
   */
  private async inReadOnlySnapshot<T>(work: () => Promise<T>): Promise<T> {
    const nested = this.inTransaction;
    await this.query(
      nested ? 'SAVEPOINT joinery_introspect' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    try {
      await this.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
      return await work();
    } finally {
      if (nested) {
        await this.query('ROLLBACK TO SAVEPOINT joinery_introspect').catch(() => undefined);
        await this.query('RELEASE SAVEPOINT joinery_introspect').catch(() => undefined);
      } else {
        await this.query('ROLLBACK').catch(() => undefined);
      }
    }
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    return this.gate.run(() =>
      browsePostgres((text, values) => this.query(text, values), this.database, path),
    );
  }

  /**
   * EXPLAIN (FORMAT JSON[, ANALYZE][, BUFFERS]), normalised to a PlanNode tree (the `format`
   * option does not apply: the tree is always built from JSON). ANALYZE runs the statement in
   * a transaction (or savepoint) that is rolled back.
   */
  async explain(text: string, opts: ExplainOptions = {}): Promise<PlanNode> {
    return (await this.explainPlan(text, opts)).plan;
  }

  async explainPlan(text: string, opts: ExplainOptions = {}): Promise<ExplainResult> {
    const options = ['FORMAT JSON'];
    if (opts.analyze) options.push('ANALYZE');
    if (opts.buffers) options.push('BUFFERS');
    const prefix = `EXPLAIN (${options.join(', ')}) `;
    const values = toPgValues(positionalParams(opts.params));
    return this.gate.run(async () => {
      this.assertUsable();
      const run = async (): Promise<ExplainResult> => {
        let cell: unknown;
        try {
          const result = await this.client.query<CellValue[]>({
            text: prefix + text,
            values,
            rowMode: 'array',
          });
          cell = result.rows[0]?.[0];
        } catch (error) {
          const mapped = mapPgError(error, { where: this.plan.where, statement: prefix + text });
          if (mapped.position === undefined) throw mapped;
          throw new JoineryError({
            ...mapped.toJSON(),
            position: Math.max(0, mapped.position - prefix.length),
          });
        }
        const parsed: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
        return {
          plan: normalisePgPlan(parsed),
          raw: typeof cell === 'string' ? cell : JSON.stringify(parsed, null, 2),
          rawFormat: 'json',
          rolledBack: opts.analyze === true,
        };
      };
      if (!opts.analyze) return run();
      // EXPLAIN ANALYZE executes the statement: keep its effects out of the database.
      const nested = this.inTransaction;
      await this.query(nested ? 'SAVEPOINT joinery_explain' : 'BEGIN');
      try {
        return await run();
      } finally {
        if (nested) {
          await this.query('ROLLBACK TO SAVEPOINT joinery_explain').catch(() => undefined);
          await this.query('RELEASE SAVEPOINT joinery_explain').catch(() => undefined);
        } else {
          await this.query('ROLLBACK').catch(() => undefined);
        }
      }
    });
  }

  async begin(): Promise<void> {
    await this.gate.run(() => this.query('BEGIN'));
  }

  async commit(): Promise<void> {
    await this.gate.run(() => this.query('COMMIT'));
  }

  async rollback(): Promise<void> {
    await this.gate.run(() => this.query('ROLLBACK'));
  }

  /**
   * PostgreSQL cannot switch databases on a connection (that needs a new session), so this
   * sets `search_path` to the given schema instead.
   */
  async useDatabase(name: string): Promise<void> {
    await this.gate.run(() =>
      this.query(`SELECT pg_catalog.set_config('search_path', pg_catalog.quote_ident($1), false)`, [
        name,
      ]),
    );
  }

  async ping(): Promise<void> {
    this.assertUsable();
    // A paused result proves the connection is alive, and pinging would have to close it.
    if (this.gate.holdsOpenResult) return;
    await this.gate.run(() => this.query('SELECT 1'));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ended = this.client.end().catch(() => undefined);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 2000).unref(),
    );
    if ((await Promise.race([ended, timeout])) === 'timeout')
      this.client.connection.stream.destroy();
  }
}
