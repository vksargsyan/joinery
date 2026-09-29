import {
  JoineryError,
  isSqlEngine,
  newId,
  type CellValue,
  type ResultChunk,
  type SqlDialect,
} from '@joinery/core';
import type { RpcStream, StoredProfile } from '@joinery/ipc';
import { bindParameters, safetyPolicyFor } from '@joinery/sql-tools';

import { errorInfo, errorMessage } from '../lib/errors';
import { mainApi, type HostClient } from '../lib/main-client';
import { noteStatementsRun, noteTransactionEnd } from './autocomplete';
import { connect } from './connections';
import { profileById, queryClient } from './data';
import { askParameters, confirm, confirmRun } from './dialogs';
import { rememberResultSource } from './result-sources';
import { StatementResult, summarise } from './results';
import { buildRunPlan, parameterValues, type PlannedStatement, type RunMode } from './run-plan';
import {
  addMessage,
  dropBuffers,
  getTab,
  patchResult,
  patchTab,
  removeTab,
  runtimeOf,
  setBuffer,
  type OpenResult,
  type ResultView,
} from './workspace';

/**
 * Runs a query tab's statements against its own session on the connection host (spec §6):
 * safety check and parameters first, then one statement at a time, streaming each result into
 * row buffers up to the tab's row limit. The last statement's stream stays open at the limit so
 * Fetch more / Fetch all keep pulling from the same server-side cursor.
 */

const CANCEL_GRACE_MS = 5_000;

function dialectOf(profile: StoredProfile): SqlDialect {
  if (!isSqlEngine(profile.engine)) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: 'Only SQL connections have query tabs',
    });
  }
  return profile.engine;
}

/** The tab's session, opened on first use and again after its connection was replaced. */
async function ensureSession(tabId: string): Promise<{ host: HostClient; sessionId: string }> {
  const tab = getTab(tabId);
  if (!tab) throw new JoineryError({ code: 'NOT_FOUND', message: 'The tab was closed' });
  const connection = await connect(tab.profileId);
  const runtime = runtimeOf(tabId);
  if (
    runtime.sessionId !== undefined &&
    runtime.host === connection.host &&
    runtime.generation === connection.generation &&
    runtime.host !== undefined
  ) {
    return { host: runtime.host, sessionId: runtime.sessionId };
  }
  const host = connection.host;
  if (!host) throw new JoineryError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
  const { sessionId } = await host.openSession({});
  runtime.host = host;
  runtime.sessionId = sessionId;
  runtime.generation = connection.generation;
  patchTab(tabId, { inTransaction: false });
  return { host, sessionId };
}

/** Forgets a session the server or host has lost, so the next run opens a new one. */
function dropSessionIfBroken(tabId: string, error: unknown): void {
  const code = errorInfo(error).code;
  if (code === 'CONNECTION_FAILED' || code === 'NOT_FOUND') {
    const runtime = runtimeOf(tabId);
    runtime.sessionId = undefined;
    patchTab(tabId, { inTransaction: false });
  }
}

async function refreshTransactionState(tabId: string): Promise<void> {
  const runtime = runtimeOf(tabId);
  if (!runtime.host || !runtime.sessionId) return;
  try {
    const { inTransaction } = await runtime.host.sessionState({ sessionId: runtime.sessionId });
    patchTab(tabId, { inTransaction });
  } catch {
    // The badge keeps its last known state.
  }
}

/** Closes a paused result stream, which closes the server-side cursor. */
async function closeOpenResult(
  tabId: string,
  status: 'success' | 'cancelled' = 'success',
): Promise<void> {
  const runtime = runtimeOf(tabId);
  const open = runtime.open;
  if (!open) return;
  runtime.open = undefined;
  open.record(status);
  await open.stream.return().catch(() => undefined);
  const tab = getTab(tabId);
  for (const result of tab?.results ?? []) {
    if (result.statementIndex === open.statementIndex && result.hasMore) {
      patchResult(tabId, result.id, { hasMore: false, truncated: true });
    }
  }
}

function recordHistory(
  profile: StoredProfile,
  text: string,
  status: 'success' | 'error' | 'cancelled',
  durationMs: number,
  rowCount: number | null,
  error?: string,
): void {
  void mainApi()
    .history.add({
      profileId: profile.id,
      database: profile.options.defaultDatabase ?? null,
      text,
      status,
      durationMs: Math.max(0, durationMs),
      rowCount,
      error: error ?? null,
    })
    .then(() => queryClient.invalidateQueries({ queryKey: ['history'] }))
    .catch(() => undefined);
}

/** Brings result views in line with the statement's buffers (new result sets, row counts). */
function syncViews(
  tabId: string,
  runId: string,
  statementIndex: number,
  result: StatementResult,
  hasMore: boolean,
): void {
  patchTab(tabId, (tab) => {
    const views: ResultView[] = [...tab.results];
    for (const set of result.sets) {
      const id = `${runId}:${statementIndex}:${set.resultIndex}`;
      setBuffer(id, set);
      const existing = views.findIndex((view) => view.id === id);
      const view: ResultView = {
        id,
        title:
          set.resultIndex === 0
            ? `Result ${statementIndex + 1}`
            : `Result ${statementIndex + 1}.${set.resultIndex + 1}`,
        statementIndex,
        resultIndex: set.resultIndex,
        columns: set.columns,
        rowCount: set.rowCount,
        hasMore: hasMore && set === result.sets.at(-1),
        truncated: false,
        fetching: false,
        version: result.version,
      };
      if (existing >= 0) views[existing] = { ...views[existing]!, ...view };
      else views.push(view);
    }
    return { results: views };
  });
}

/** Moves the notices a statement has produced so far into the Messages tab. */
function flushNotices(
  tabId: string,
  result: StatementResult,
  statementIndex: number,
  label: string,
): void {
  for (const notice of result.notices.splice(0)) {
    addMessage(tabId, {
      kind: notice.severity === 'warning' ? 'warning' : 'notice',
      text: `${label}${notice.message}`,
      statementIndex,
    });
  }
}

type PumpOutcome = 'done' | 'paused';

/**
 * Reads chunks into `result` until the stream ends or `limit` rows are loaded. At the limit it
 * reads ahead until the next rows chunk (kept in `pending`, not shown) to know whether more rows
 * exist; `paused` means they do.
 */
async function pump(
  stream: RpcStream<ResultChunk>,
  result: StatementResult,
  limit: number,
  pending: ResultChunk[],
  onChunk: () => void,
): Promise<PumpOutcome> {
  while (pending.length > 0 && result.loadedRows < limit) {
    result.consume(pending.shift()!);
    onChunk();
  }
  if (pending.length > 0) return 'paused';
  for (;;) {
    const next = await stream.next();
    if (next.done) return 'done';
    const chunk = next.value;
    if (chunk.type === 'rows' && result.loadedRows >= limit) {
      pending.push(chunk);
      return 'paused';
    }
    result.consume(chunk);
    onChunk();
    if (chunk.type === 'end') return 'done';
  }
}

interface StatementRun {
  readonly tabId: string;
  readonly runId: string;
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
  readonly host: HostClient;
  readonly sessionId: string;
  readonly statement: PlannedStatement;
  readonly answers: ReadonlyMap<string, CellValue>;
  readonly last: boolean;
  readonly many: boolean;
}

/** Runs one statement; false stops the script (error or cancel). */
async function runStatement(run: StatementRun): Promise<boolean> {
  const { tabId, statement, profile } = run;
  const label = run.many ? `Statement ${statement.index + 1}: ` : '';
  let bound: { text: string; values: CellValue[] };
  try {
    bound = bindParameters(statement.text, run.dialect, parameterValues(statement, run.answers));
  } catch (error) {
    const info = errorInfo(error);
    const at = statement.start + (info.position ?? 0);
    addMessage(tabId, {
      kind: 'error',
      text: `${label}${info.message}`,
      statementIndex: statement.index,
      range: { start: at, end: at + 1 },
    });
    patchTab(tabId, {
      errorMarker: { start: at, end: at + 1, message: info.message },
      activePane: 'messages',
    });
    return false;
  }

  rememberResultSource(run.runId, statement.index, bound.text, bound.values);
  const executionId = newId();
  const controller = new AbortController();
  const runtime = runtimeOf(tabId);
  runtime.execution = { executionId, controller };
  const startedAt = performance.now();
  const stream = run.host.execute(
    {
      sessionId: run.sessionId,
      text: bound.text,
      executionId,
      ...(bound.values.length > 0 ? { params: bound.values } : {}),
    },
    { signal: controller.signal },
  );
  const result = new StatementResult();
  const tab = getTab(tabId);
  const limit = tab?.rowLimit ?? 1000;
  let recorded = false;
  const record = (status: 'success' | 'error' | 'cancelled', error?: string): void => {
    if (recorded) return;
    recorded = true;
    const rows = result.sets.length > 0 ? result.loadedRows : (result.status?.rowsAffected ?? null);
    recordHistory(
      profile,
      statement.text,
      status,
      result.end?.durationMs ?? performance.now() - startedAt,
      rows,
      error,
    );
  };
  const pending: ResultChunk[] = [];
  let firstResult = true;
  const onChunk = (): void => {
    syncViews(tabId, run.runId, statement.index, result, false);
    if (firstResult && result.sets.length > 0) {
      // The run's first result set comes to the front; later ones wait in their tabs.
      firstResult = false;
      const first = `${run.runId}:${statement.index}:${result.sets[0]!.resultIndex}`;
      if (getTab(tabId)?.activePane === 'messages') patchTab(tabId, { activePane: first });
    }
  };
  try {
    const outcome = await pump(stream, result, limit, pending, onChunk);
    runtime.execution = undefined;
    flushNotices(tabId, result, statement.index, label);
    if (outcome === 'paused' && run.last) {
      const open: OpenResult = {
        stream,
        result,
        statementIndex: statement.index,
        executionId,
        startedAt,
        pending,
        record,
      };
      runtime.open = open;
      syncViews(tabId, run.runId, statement.index, result, true);
      addMessage(tabId, {
        kind: 'success',
        text: `${label}${summarise(result, 'paused', performance.now() - startedAt)}`,
        statementIndex: statement.index,
      });
      return true;
    }
    if (outcome === 'paused') {
      await stream.return();
      syncViews(tabId, run.runId, statement.index, result, false);
      for (const view of getTab(tabId)?.results ?? []) {
        if (view.statementIndex === statement.index)
          patchResult(tabId, view.id, { truncated: true });
      }
    }
    record('success');
    addMessage(tabId, {
      kind: 'success',
      text: `${label}${summarise(result, outcome === 'paused' ? 'truncated' : 'done', performance.now() - startedAt)}`,
      statementIndex: statement.index,
    });
    return true;
  } catch (error) {
    runtime.execution = undefined;
    const info = errorInfo(error);
    syncViews(tabId, run.runId, statement.index, result, false);
    if (info.code === 'CANCELLED') {
      record('cancelled');
      addMessage(tabId, {
        kind: 'warning',
        text: `${label}Query cancelled`,
        statementIndex: statement.index,
      });
      patchTab(tabId, { activePane: 'messages' });
      return false;
    }
    record('error', info.message);
    const range =
      info.position !== undefined && bound.text === statement.text
        ? { start: statement.start + info.position, end: statement.start + info.position + 1 }
        : { start: statement.start, end: statement.end };
    addMessage(tabId, {
      kind: 'error',
      text: `${label}${info.message}`,
      ...(info.detail !== undefined || info.hint !== undefined
        ? { detail: [info.detail, info.hint].filter(Boolean).join('\n') }
        : {}),
      statementIndex: statement.index,
      range,
    });
    patchTab(tabId, { errorMarker: { ...range, message: info.message }, activePane: 'messages' });
    dropSessionIfBroken(tabId, error);
    return false;
  }
}

/** Run all, the statement at the cursor, or the selection (spec §6). */
export async function runQuery(tabId: string, mode: RunMode): Promise<void> {
  const tab = getTab(tabId);
  const runtime = runtimeOf(tabId);
  const editor = runtime.editor;
  if (!tab || !editor || tab.running) return;
  const profile = await profileById(tab.profileId);
  if (!profile) {
    addMessage(tabId, { kind: 'error', text: 'The connection of this tab was deleted' });
    return;
  }
  const dialect = dialectOf(profile);
  const text = editor.getText();
  const plan = buildRunPlan({
    text,
    dialect,
    mode,
    cursor: editor.cursorOffset(),
    ...(editor.selection() ? { selection: editor.selection()! } : {}),
    policy: safetyPolicyFor(profile),
  });
  patchTab(tabId, { errorMarker: undefined });
  if (plan.statements.length === 0) {
    addMessage(tabId, { kind: 'info', text: 'Nothing to run' });
    patchTab(tabId, { activePane: 'messages' });
    return;
  }
  if (plan.problem) {
    const at = plan.problem.position ?? plan.statements[0]!.start;
    addMessage(tabId, {
      kind: 'error',
      text: plan.problem.message,
      range: { start: at, end: at + 1 },
    });
    patchTab(tabId, {
      activePane: 'messages',
      errorMarker: { start: at, end: at + 1, message: plan.problem.message },
    });
    return;
  }
  if (plan.refused) {
    const { start, end, index } = plan.refused;
    const message = `This connection is read-only, so statement ${index + 1} was not run: it writes.`;
    addMessage(tabId, { kind: 'error', text: message, range: { start, end } });
    patchTab(tabId, { activePane: 'messages', errorMarker: { start, end, message } });
    return;
  }
  if (plan.confirmations.length > 0) {
    const ok = await confirmRun(
      plan.confirmations.map(({ statement, reasons }) => ({
        index: statement.index,
        line: statement.line,
        text: statement.text,
        reasons,
      })),
      profile.presentation.environment === 'production',
    );
    if (!ok) {
      addMessage(tabId, { kind: 'info', text: 'Run cancelled' });
      patchTab(tabId, { activePane: 'messages' });
      return;
    }
  }
  let answers = new Map<string, CellValue>();
  if (plan.parameters.length > 0) {
    const typed = await askParameters(plan.parameters);
    if (!typed) return;
    answers = typed;
  }

  await closeOpenResult(tabId);
  const previous = getTab(tabId)?.results ?? [];
  dropBuffers(previous.map((r) => r.id));
  patchTab(tabId, {
    running: true,
    cancelling: false,
    results: [],
    messages: [],
    activePane: 'messages',
  });
  const runId = newId();
  const ran: PlannedStatement[] = [];
  try {
    const { host, sessionId } = await ensureSession(tabId);
    if (!getTab(tabId)?.autoCommit && !getTab(tabId)?.inTransaction) {
      await host.begin({ sessionId });
      patchTab(tabId, { inTransaction: true });
    }
    for (const statement of plan.statements) {
      if (getTab(tabId)?.cancelling) break;
      const ok = await runStatement({
        tabId,
        runId,
        profile,
        dialect,
        host,
        sessionId,
        statement,
        answers,
        last: statement.index === plan.statements.length - 1,
        many: plan.statements.length > 1,
      });
      if (!ok) break;
      ran.push(statement);
    }
  } catch (error) {
    if (errorInfo(error).code !== 'CANCELLED') {
      addMessage(tabId, { kind: 'error', text: errorMessage(error) });
    }
    patchTab(tabId, { activePane: 'messages' });
    dropSessionIfBroken(tabId, error);
  } finally {
    runtime.execution = undefined;
    patchTab(tabId, { running: false, cancelling: false });
    await refreshTransactionState(tabId);
    // Autocomplete refreshes after DDL and follows the tab's USE / SET search_path.
    noteStatementsRun(tabId, ran);
  }
}

/** Fetch more (one more page of the row limit) or Fetch all, from the paused stream. */
export async function fetchMore(tabId: string, all: boolean): Promise<void> {
  const runtime = runtimeOf(tabId);
  const open = runtime.open;
  const tab = getTab(tabId);
  if (!open || !tab || tab.running) return;
  const runId = tab.results.find((r) => r.statementIndex === open.statementIndex)?.id.split(':')[0];
  if (runId === undefined) return;
  const limit = all ? Number.POSITIVE_INFINITY : open.result.loadedRows + tab.rowLimit;
  const controller = new AbortController();
  runtime.execution = { executionId: open.executionId, controller };
  patchTab(tabId, { running: true, cancelling: false });
  for (const view of tab.results) {
    if (view.statementIndex === open.statementIndex)
      patchResult(tabId, view.id, { fetching: true });
  }
  let lastSync = 0;
  const onChunk = (): void => {
    const now = performance.now();
    if (now - lastSync < 100) return;
    lastSync = now;
    syncViews(tabId, runId, open.statementIndex, open.result, false);
  };
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new JoineryError({ code: 'CANCELLED', message: 'Cancelled' })),
        { once: true },
      );
    });
    cancelled.catch(() => undefined);
    const outcome = await Promise.race([
      pump(open.stream, open.result, limit, open.pending, onChunk),
      cancelled,
    ]);
    syncViews(tabId, runId, open.statementIndex, open.result, outcome === 'paused');
    flushNotices(tabId, open.result, open.statementIndex, '');
    if (outcome === 'done') {
      runtime.open = undefined;
      open.record('success');
    }
  } catch (error) {
    runtime.open = undefined;
    const info = errorInfo(error);
    open.record(info.code === 'CANCELLED' ? 'cancelled' : 'error', info.message);
    await open.stream.return().catch(() => undefined);
    syncViews(tabId, runId, open.statementIndex, open.result, false);
    addMessage(tabId, {
      kind: info.code === 'CANCELLED' ? 'warning' : 'error',
      text: info.code === 'CANCELLED' ? 'Fetch cancelled' : info.message,
    });
    dropSessionIfBroken(tabId, error);
  } finally {
    runtime.execution = undefined;
    patchTab(tabId, { running: false, cancelling: false });
    for (const view of getTab(tabId)?.results ?? []) {
      if (view.fetching) patchResult(tabId, view.id, { fetching: false });
    }
  }
}

/**
 * Cancels the running statement through the host's control connection (KILL QUERY,
 * pg_cancel_backend). If the server does not stop it in a few seconds, the stream is aborted.
 */
export async function cancelQuery(tabId: string): Promise<void> {
  const runtime = runtimeOf(tabId);
  const execution = runtime.execution;
  const tab = getTab(tabId);
  if (!tab?.running) return;
  patchTab(tabId, { cancelling: true });
  if (!execution) return;
  // Abort the stream only if the server has not stopped the statement by then.
  setTimeout(() => {
    if (runtime.execution === execution) execution.controller.abort();
  }, CANCEL_GRACE_MS);
  try {
    if (runtime.host && runtime.sessionId) {
      await runtime.host.cancel({
        sessionId: runtime.sessionId,
        executionId: execution.executionId,
      });
    } else {
      execution.controller.abort();
    }
  } catch {
    execution.controller.abort();
  }
}

async function transaction(tabId: string, action: 'commit' | 'rollback'): Promise<void> {
  const runtime = runtimeOf(tabId);
  const tab = getTab(tabId);
  if (!tab || tab.running || !runtime.host || !runtime.sessionId) return;
  await closeOpenResult(tabId);
  try {
    await runtime.host[action]({ sessionId: runtime.sessionId });
    noteTransactionEnd(tabId, action === 'commit');
    addMessage(tabId, { kind: 'success', text: action === 'commit' ? 'Committed' : 'Rolled back' });
  } catch (error) {
    addMessage(tabId, { kind: 'error', text: errorMessage(error) });
    patchTab(tabId, { activePane: 'messages' });
  } finally {
    await refreshTransactionState(tabId);
  }
}

export function commit(tabId: string): Promise<void> {
  return transaction(tabId, 'commit');
}

export function rollback(tabId: string): Promise<void> {
  return transaction(tabId, 'rollback');
}

/**
 * Turns auto-commit on or off. Turning it back on with a transaction open asks whether to commit
 * it first.
 */
export async function setAutoCommit(tabId: string, on: boolean): Promise<void> {
  const tab = getTab(tabId);
  if (!tab || tab.running) return;
  if (on && tab.inTransaction) {
    const ok = await confirm({
      title: 'Commit the open transaction?',
      message: 'Auto-commit ends the open transaction. Commit it now?',
      confirmLabel: 'Commit',
    });
    if (!ok) return;
    await commit(tabId);
  }
  patchTab(tabId, { autoCommit: on });
}

/**
 * Closes a tab, asking first when it has an open transaction (spec §6). `force` skips the
 * question, for a panel the dock already removed.
 */
export async function closeTab(
  tabId: string,
  options: { readonly force?: boolean } = {},
): Promise<boolean> {
  const tab = getTab(tabId);
  if (!tab) return true;
  await refreshTransactionState(tabId);
  if (!options.force && getTab(tabId)?.inTransaction) {
    const ok = await confirm({
      title: 'Close with an open transaction?',
      message: `"${tab.title}" has uncommitted changes. Closing the tab rolls them back.`,
      confirmLabel: 'Roll back and close',
      danger: true,
    });
    if (!ok) return false;
  }
  const runtime = runtimeOf(tabId);
  runtime.execution?.controller.abort();
  await closeOpenResult(tabId, 'cancelled');
  if (runtime.host && runtime.sessionId) {
    await runtime.host.closeSession({ sessionId: runtime.sessionId }).catch(() => undefined);
  }
  removeTab(tabId);
  return true;
}
