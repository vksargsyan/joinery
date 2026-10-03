import { isSqlEngine, type CellValue } from '@querybara/core';
import { bindParameters, safetyPolicyFor } from '@querybara/sql-tools';

import { errorInfo } from '../../lib/errors';
import { useConnections } from '../connections';
import { profileById } from '../data';
import { askParameters, confirm } from '../dialogs';
import { buildRunPlan, parameterValues } from '../run-plan';
import {
  closeOpenResult,
  dropSessionIfBroken,
  ensureSession,
  refreshTransactionState,
} from '../runner';
import { getTab, patchTab, runtimeOf, type ExplainTabState } from '../workspace';
import { ANALYZE_WRITE_WARNING, pickExplainStatement, type ExplainRequest } from './statement';

/**
 * Explain and Explain Analyze from a query tab (spec §6): the statement at the cursor or the
 * selection goes to the tab's own session (its search path, USE and open transaction apply) as
 * EXPLAIN (FORMAT JSON [, ANALYZE, BUFFERS]) on PostgreSQL, EXPLAIN FORMAT=JSON or EXPLAIN
 * ANALYZE on MySQL, ANALYZE FORMAT=JSON on MariaDB, and the plan lands in the tab's Plan pane.
 *
 * ANALYZE executes the statement. The drivers run it inside a transaction (a savepoint in an
 * open one) and roll it back; for a statement that writes, the user confirms first with what
 * rolling back cannot undo, and a read-only profile refuses (the connection host enforces both).
 */

function setExplain(
  tabId: string,
  patch: Partial<ExplainTabState> & Pick<ExplainTabState, 'status'>,
) {
  patchTab(tabId, (tab) => ({
    explain: {
      analyze: false,
      buffers: true,
      statement: '',
      at: new Date().toISOString(),
      ...(tab.explain ?? {}),
      ...patch,
    } as ExplainTabState,
    activePane: 'plan',
  }));
}

function fail(tabId: string, request: ExplainRequest, buffers: boolean, error: string): void {
  patchTab(tabId, {
    explain: {
      status: 'error',
      analyze: request.analyze,
      buffers,
      statement: '',
      error,
      at: new Date().toISOString(),
    },
    activePane: 'plan',
  });
}

/** Explains the statement at the cursor or the selection of a query tab. */
export async function explainQuery(tabId: string, request: ExplainRequest): Promise<void> {
  const tab = getTab(tabId);
  const editor = runtimeOf(tabId).editor;
  if (!tab || !editor || tab.running) return;
  const profile = await profileById(tab.profileId);
  if (!profile || !isSqlEngine(profile.engine)) return;
  const dialect = profile.engine;
  const buffers = request.buffers ?? tab.explain?.buffers ?? true;
  const selection = editor.selection();
  const plan = buildRunPlan({
    text: editor.getText(),
    dialect,
    mode: selection ? 'selection' : 'statement',
    cursor: editor.cursorOffset(),
    ...(selection ? { selection } : {}),
    policy: safetyPolicyFor(profile),
  });
  patchTab(tabId, { errorMarker: undefined });
  const picked = pickExplainStatement(plan);
  if ('error' in picked) {
    fail(tabId, request, buffers, picked.error);
    return;
  }
  if (plan.problem) {
    fail(tabId, request, buffers, plan.problem.message);
    return;
  }
  const { statement } = picked;
  const formats =
    useConnections.getState().byProfile[tab.profileId]?.info?.capabilities.explainFormats;
  if (request.analyze && formats !== undefined && !formats.includes('analyze')) {
    fail(tabId, request, buffers, 'This server version cannot EXPLAIN ANALYZE.');
    return;
  }

  let confirmed = false;
  if (request.analyze && statement.analysis.isWrite) {
    if (profile.presentation.readOnly) {
      fail(
        tabId,
        request,
        buffers,
        'This connection is read-only, and EXPLAIN ANALYZE would run this statement, which writes. Use Explain for the estimated plan.',
      );
      return;
    }
    const ok = await confirm({
      title: 'Run the statement to analyze it?',
      message: ANALYZE_WRITE_WARNING[dialect],
      detail: statement.text,
      confirmLabel: 'Analyze and roll back',
      danger: true,
    });
    if (!ok) return;
    confirmed = true;
  }

  let answers = new Map<string, CellValue>();
  if (plan.parameters.length > 0) {
    const typed = await askParameters(plan.parameters);
    if (!typed) return;
    answers = typed;
  }
  let bound: { text: string; values: CellValue[] };
  try {
    bound = bindParameters(statement.text, dialect, parameterValues(statement, answers));
  } catch (error) {
    fail(tabId, request, buffers, errorInfo(error).message);
    return;
  }

  setExplain(tabId, {
    status: 'running',
    analyze: request.analyze,
    buffers,
    statement: bound.text,
    at: new Date().toISOString(),
    result: undefined,
    error: undefined,
  });
  patchTab(tabId, { running: true, cancelling: false });
  try {
    // A paused result holds the session's cursor; the plan needs the session.
    await closeOpenResult(tabId);
    const { host, sessionId } = await ensureSession(tabId);
    const result = await host.explainPlan({
      sessionId,
      text: bound.text,
      options: {
        analyze: request.analyze,
        ...(dialect === 'postgres' && buffers && request.analyze ? { buffers: true } : {}),
        ...(bound.values.length > 0 ? { params: bound.values } : {}),
      },
      ...(confirmed ? { confirmed: true } : {}),
    });
    setExplain(tabId, { status: 'done', result, at: new Date().toISOString() });
  } catch (error) {
    const info = errorInfo(error);
    setExplain(tabId, { status: 'error', error: info.message, result: undefined });
    if (info.position !== undefined && bound.text === statement.text) {
      const at = statement.start + info.position;
      patchTab(tabId, { errorMarker: { start: at, end: at + 1, message: info.message } });
    }
    dropSessionIfBroken(tabId, error);
  } finally {
    patchTab(tabId, { running: false, cancelling: false });
    await refreshTransactionState(tabId);
  }
}

/** PostgreSQL BUFFERS on or off for the tab's next explain. */
export function setExplainBuffers(tabId: string, buffers: boolean): void {
  patchTab(tabId, (tab) => (tab.explain ? { explain: { ...tab.explain, buffers } } : {}));
}
