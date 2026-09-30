import { newId } from '@joinery/core';
import type { RdbAnalyzeProgress, RdbReport } from '@joinery/ipc';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { panelWithKey, patchPanel, registerPanel, unregisterPanel } from '../panels';

/**
 * The dump analysis panel (ADR 0022): a Redis or Valkey RDB file picked in a dialog, read to
 * its end by the job runner, and its report — keys by type, encoding, expiry, database and
 * pattern, the largest keys. It needs no connection: a dump copied from any server, a backup,
 * or an export from a managed service works the same. One panel; analysing another file
 * replaces the report, and closing the panel cancels a running analysis.
 */

export interface DumpState {
  readonly status: 'idle' | 'running' | 'done' | 'error';
  readonly path: string | undefined;
  readonly progress: (RdbAnalyzeProgress & { readonly startedAt: number }) | undefined;
  readonly report: RdbReport | undefined;
  readonly error: string | undefined;
  /** The delimiter key patterns split on. */
  readonly delimiter: string;
}

const INITIAL: DumpState = {
  status: 'idle',
  path: undefined,
  progress: undefined,
  report: undefined,
  error: undefined,
  delimiter: ':',
};

export const useDump = create<DumpState>(() => INITIAL);

const PANEL_KEY = 'redis-dump';
let controller: AbortController | undefined;
let panel: string | undefined;

export function openDumpAnalysis(): void {
  const open = panelWithKey(PANEL_KEY);
  if (open) {
    currentDock()?.getPanel(open.id)?.api.setActive();
    return;
  }
  const id = newId();
  panel = id;
  registerPanel({ id, kind: 'redis-dump', profileId: '', title: 'Dump analysis', key: PANEL_KEY });
  currentDock()?.addPanel({
    id,
    component: 'redisDump',
    tabComponent: 'panelTab',
    title: 'Dump analysis',
    params: { panelId: id },
  });
}

export function disposeDumpAnalysis(panelId: string): void {
  if (panelId !== panel) return;
  controller?.abort();
  controller = undefined;
  panel = undefined;
  unregisterPanel(panelId);
  useDump.setState(INITIAL);
}

export function setDelimiter(delimiter: string): void {
  useDump.setState({ delimiter });
}

/** Asks for an RDB file, then analyses it. */
export async function chooseDumpFile(): Promise<void> {
  const { path } = await mainApi().dialogs.openFile({
    title: 'Choose a Redis dump (RDB) file',
    filters: [
      { name: 'Redis dumps', extensions: ['rdb'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (path !== null) await analyzeDump(path);
}

/** Analyses the file at `path` (picked in this window's dialog). */
export async function analyzeDump(path: string): Promise<void> {
  controller?.abort();
  const run = new AbortController();
  controller = run;
  const delimiter = useDump.getState().delimiter.trim() || ':';
  useDump.setState({
    status: 'running',
    path,
    progress: { bytes: 0, total: 0, startedAt: Date.now() },
    report: undefined,
    error: undefined,
  });
  if (panel) patchPanel(panel, { busy: true });
  try {
    const report = await mainApi().redisDump.analyze(
      { path, delimiter },
      {
        signal: run.signal,
        onProgress: (progress) =>
          useDump.setState((state) => ({
            progress: { ...progress, startedAt: state.progress?.startedAt ?? Date.now() },
          })),
      },
    );
    if (controller !== run) return;
    useDump.setState({ status: 'done', report, progress: undefined });
  } catch (error) {
    if (controller !== run) return;
    const cancelled = run.signal.aborted;
    useDump.setState({
      status: cancelled ? 'idle' : 'error',
      progress: undefined,
      error: cancelled ? undefined : errorMessage(error),
    });
  } finally {
    if (controller === run) controller = undefined;
    if (panel) patchPanel(panel, { busy: false });
  }
}

export function cancelDumpAnalysis(): void {
  controller?.abort();
}

/** Saves the report as JSON where the user chooses. */
export async function saveDumpReport(): Promise<string | undefined> {
  const report = useDump.getState().report;
  if (!report) return undefined;
  const base = report.file.replace(/\.rdb$/i, '') || 'dump';
  const { path } = await mainApi().dialogs.saveFile({
    title: 'Save the analysis',
    defaultName: `${base}-analysis.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (path === null) return undefined;
  await mainApi().dialogs.writeFile({ path, text: `${JSON.stringify(report, null, 2)}\n` });
  return path;
}
