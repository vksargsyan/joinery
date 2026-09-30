import { newId, type MissedRunPolicy, type ScheduleRule } from '@joinery/core';
import type {
  BackupJob,
  ExportJob,
  RunSqlFileJob,
  SavedComparison,
  ScheduleInfo,
  ScheduleNotify,
  ScheduleRunInfo,
  ScheduleSaveInput,
  ScheduleTask,
} from '@joinery/ipc';
import { create } from 'zustand';

import { currentDock } from '../components/dock';
import { errorMessage } from '../lib/errors';
import { mainApi } from '../lib/main-client';
import { keys, queryClient } from './data';
import { panelWithKey, registerPanel, unregisterPanel } from './panels';

/**
 * Schedules in the page (spec: scheduler and automation): the list main keeps, reloaded on each
 * of its events; the selected schedule's runs; the Schedules panel; and the schedule editor,
 * which opens on a draft built from a wizard (a backup, an export, a SQL file, a saved
 * comparison) or from a schedule to edit.
 */

export interface ScheduleDraft {
  /** Present when editing a saved schedule. */
  readonly id?: string;
  readonly version?: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly profileId: string | null;
  readonly comparisonId: string | null;
  readonly task: ScheduleTask;
  readonly rule: ScheduleRule;
  readonly missed: MissedRunPolicy;
  readonly notify: ScheduleNotify;
  /** What the schedule runs, in words, for the editor's header. */
  readonly what: string;
  /** An encrypted backup's passphrase, from the backup dialog (never stored in the page). */
  readonly passphrase?: string;
}

interface SchedulesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | undefined;
  readonly schedules: readonly ScheduleInfo[];
  readonly selected: string | undefined;
  readonly runs: Readonly<Record<string, readonly ScheduleRunInfo[]>>;
  /** The editor dialog's draft, while it is open. */
  readonly editing: ScheduleDraft | undefined;
}

export const useSchedules = create<SchedulesState>()(() => ({
  status: 'idle',
  error: undefined,
  schedules: [],
  selected: undefined,
  runs: {},
  editing: undefined,
}));

export const DEFAULT_RULE: ScheduleRule = {
  kind: 'weekly',
  days: [0, 1, 2, 3, 4, 5, 6],
  times: ['02:00'],
};

const PANEL_KEY = 'schedules';

// ---------------------------------------------------------------------------------------------
// Loading

export async function loadSchedules(): Promise<void> {
  if (useSchedules.getState().status === 'idle') useSchedules.setState({ status: 'loading' });
  try {
    const schedules = await mainApi().schedules.list();
    const selected = useSchedules.getState().selected;
    useSchedules.setState({
      status: 'ready',
      error: undefined,
      schedules,
      selected:
        selected !== undefined && schedules.some((s) => s.id === selected)
          ? selected
          : schedules[0]?.id,
    });
    const now = useSchedules.getState().selected;
    if (now !== undefined) await loadRuns(now);
  } catch (error) {
    useSchedules.setState({ status: 'error', error: errorMessage(error) });
  }
}

export async function loadRuns(id: string): Promise<void> {
  try {
    const runs = await mainApi().schedules.runs({ id, limit: 50 });
    useSchedules.setState((state) => ({ runs: { ...state.runs, [id]: runs } }));
  } catch {
    // A schedule deleted meanwhile: the list reload says so.
  }
}

let watching = false;

/** Follows main's schedule events for the life of the page. */
export async function watchSchedules(): Promise<void> {
  if (watching) return;
  watching = true;
  for (;;) {
    try {
      for await (const _event of mainApi().schedules.events()) await loadSchedules();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function selectSchedule(id: string | undefined): void {
  useSchedules.setState({ selected: id });
  if (id !== undefined) void loadRuns(id);
}

// ---------------------------------------------------------------------------------------------
// The panel

/** Opens the Schedules panel, or brings it forward. */
export function openSchedulesPanel(select?: string): void {
  if (select !== undefined) selectSchedule(select);
  const open = panelWithKey(PANEL_KEY);
  if (open) {
    currentDock()?.getPanel(open.id)?.api.setActive();
    return;
  }
  const id = newId();
  registerPanel({ id, kind: 'schedules', profileId: '', title: 'Schedules', key: PANEL_KEY });
  void loadSchedules();
  void watchSchedules();
  currentDock()?.addPanel({
    id,
    component: 'schedules',
    tabComponent: 'panelTab',
    title: 'Schedules',
    params: { panelId: id },
  });
}

export function disposeSchedulesPanel(panelId: string): void {
  unregisterPanel(panelId);
}

// ---------------------------------------------------------------------------------------------
// Editing

export function editSchedule(draft: ScheduleDraft): void {
  useSchedules.setState({ editing: draft });
}

export function closeScheduleEditor(): void {
  useSchedules.setState({ editing: undefined });
}

/** Saves the editor's schedule; returns the saved one, or throws what main refused. */
export async function saveSchedule(
  draft: ScheduleDraft,
  changes: Partial<ScheduleDraft> & { readonly passphrase?: string },
): Promise<ScheduleInfo> {
  const next = { ...draft, ...changes };
  const input: ScheduleSaveInput = {
    ...(next.id !== undefined ? { id: next.id } : {}),
    ...(next.version !== undefined ? { expectedVersion: next.version } : {}),
    name: next.name,
    enabled: next.enabled,
    profileId: next.profileId,
    comparisonId: next.comparisonId,
    task: next.task,
    rule: next.rule,
    missed: next.missed,
    notify: next.notify,
    ...(next.passphrase !== undefined && next.passphrase !== ''
      ? { passphrase: next.passphrase }
      : {}),
  };
  const saved = await mainApi().schedules.save(input);
  await loadSchedules();
  return saved;
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
  await mainApi().schedules.setEnabled({ id, enabled });
  await loadSchedules();
}

export async function runScheduleNow(id: string): Promise<void> {
  await mainApi().schedules.runNow({ id });
  await loadSchedules();
}

export async function deleteSchedule(id: string): Promise<void> {
  await mainApi().schedules.delete({ id });
  useSchedules.setState((state) => {
    const { [id]: _gone, ...runs } = state.runs;
    return { runs, ...(state.selected === id ? { selected: undefined } : {}) };
  });
  await loadSchedules();
}

// ---------------------------------------------------------------------------------------------
// Drafts from the wizards

const base = {
  enabled: true,
  rule: DEFAULT_RULE,
  missed: 'run-once' as const,
  notify: 'failures' as const,
};

/** A draft of a saved schedule, to edit. */
export function draftOf(schedule: ScheduleInfo): ScheduleDraft {
  return {
    id: schedule.id,
    version: schedule.version,
    name: schedule.name,
    enabled: schedule.enabled,
    profileId: schedule.profileId,
    comparisonId: schedule.comparisonId,
    task: schedule.task,
    rule: schedule.rule,
    missed: schedule.missed,
    notify: schedule.notify,
    what: whatOf(schedule.task, schedule.target),
  };
}

const BACKUP_FORMATS: Readonly<Record<string, string>> = {
  jbak: 'a Joinery archive',
  sql: 'a SQL script',
  'sql-gz': 'a gzipped SQL script',
  custom: 'a pg_dump archive',
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  jbak: '.jbak',
  sql: '.sql',
  'sql-gz': '.sql.gz',
  custom: '.dump',
};

/** An export format's name in a sentence: CSV, JSONL, Parquet, SQL with DDL. */
function formatName(format: string): string {
  if (format === 'parquet') return 'Parquet';
  if (format === 'sql-ddl') return 'SQL with DDL';
  return format.toUpperCase();
}

/** What a task does, in words. */
export function whatOf(task: ScheduleTask, target: string): string {
  switch (task.kind) {
    case 'backup':
      return `Back up ${target} as ${BACKUP_FORMATS[task.job.format] ?? task.job.format}${task.encrypted ? ', encrypted' : ''}`;
    case 'sql':
      return `Run ${task.job.path.split(/[\\/]/).pop() ?? task.job.path} on ${target}`;
    case 'export':
      return task.job.source.kind === 'query'
        ? `Export a query on ${target} as ${formatName(task.job.format)}`
        : `Export ${task.job.source.tables.length === 1 ? task.job.source.tables[0] : `${task.job.source.tables.length} tables`} of ${target} as ${formatName(task.job.format)}`;
    case 'comparison':
      return `Run the comparison ${target}`;
  }
}

export function backupDraft(
  job: BackupJob,
  target: { readonly profileName: string; readonly database?: string | undefined },
  passphrase: string | undefined,
  folder = '',
): ScheduleDraft {
  const { output: _output, encryption, ...rest } = job;
  const place = [target.profileName, target.database].filter(Boolean).join(' · ');
  const task: ScheduleTask = {
    kind: 'backup',
    job: rest,
    encrypted: encryption !== undefined,
    output: {
      folder,
      fileName: `{name}-{date}-{time}${EXTENSIONS[job.format] ?? ''}`,
      keep: 14,
    },
  };
  return {
    ...base,
    name: `Back up ${target.database ?? target.profileName}`,
    profileId: job.profileId,
    comparisonId: null,
    task,
    what: whatOf(task, place),
    ...(passphrase !== undefined ? { passphrase } : {}),
  };
}

export function exportDraft(
  job: ExportJob,
  target: { readonly profileName: string },
  name: string,
  folder = '',
): ScheduleDraft {
  const { output, ...rest } = job;
  const source =
    rest.source.kind === 'query' ? { kind: 'query' as const, text: rest.source.text } : rest.source;
  const extension = output.kind === 'directory' ? '' : fileExtension(output.path);
  const task: ScheduleTask = {
    kind: 'export',
    job: { ...rest, source },
    outputKind: output.kind,
    output: { folder, fileName: `{name}-{date}-{time}${extension}`, keep: 14 },
  };
  return {
    ...base,
    name,
    profileId: job.profileId,
    comparisonId: null,
    task,
    what: whatOf(task, target.profileName),
  };
}

function fileExtension(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? '';
  const match = /(\.[a-z0-9]+(?:\.gz)?)$/i.exec(file);
  return match?.[1] ?? '';
}

export function sqlDraft(
  job: RunSqlFileJob,
  target: { readonly profileName: string },
): ScheduleDraft {
  const task: ScheduleTask = { kind: 'sql', job };
  const file = job.path.split(/[\\/]/).pop() ?? 'SQL file';
  return {
    ...base,
    name: `Run ${file}`,
    profileId: job.profileId,
    comparisonId: null,
    task,
    what: whatOf(task, target.profileName),
  };
}

export function comparisonDraft(comparison: SavedComparison, folder = ''): ScheduleDraft {
  const task: ScheduleTask = {
    kind: 'comparison',
    output: {
      folder,
      fileName: `{name}-{date}-{time}${comparison.kind === 'structure' ? '.html' : '.sql'}`,
      keep: 30,
    },
  };
  return {
    ...base,
    rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['07:00'] },
    notify: 'failures',
    name: comparison.name,
    profileId: null,
    comparisonId: comparison.id,
    task,
    what: whatOf(task, comparison.name),
  };
}

/** Whether closing Joinery asks first while schedules are on (they run only while it is open). */
export async function setConfirmClose(on: boolean): Promise<void> {
  await mainApi().settings.set({ schedules: { confirmClose: on } });
  await queryClient.invalidateQueries({ queryKey: keys.settings });
}
