import type {
  ActionResult,
  EngineId,
  ServerAction,
  ServerNotice,
  ServerToolsInfo,
  ToolColumn,
  ToolTable,
} from '@querybara/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import type { HostClient } from '../../lib/main-client';
import { runServerAction } from '../../state/server-tools/actions';
import { formatCell, isNumericUnit } from '../../state/server-tools/format';
import { panelState, serverToolsInfo, serverToolsLane } from '../../state/server-tools/panels';
import { Notice } from '../redis/common';
import { cx } from '../ui';

/** Building blocks shared by the server tools tabs: data hooks, tables, notices, results. */

export interface TabProps {
  readonly panelId: string;
  readonly info: ServerToolsInfo;
}

/** The connection's server tools info (engine, version, what each tab can do). */
export function useServerToolsInfo(panelId: string): {
  readonly info: ServerToolsInfo | undefined;
  readonly error: string | undefined;
} {
  const [info, setInfo] = useState<ServerToolsInfo>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    serverToolsInfo(panelId).then(
      (loaded) => live && setInfo(loaded),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [panelId]);
  return { info, error };
}

/**
 * Loads data on one of the panel's sessions (in `database`, or the connection's default) and
 * keeps it with its error and loading state; `reload` runs it again. The latest call wins.
 */
export function useToolData<T>(
  panelId: string,
  database: string | undefined,
  load: (host: HostClient, sessionId: string) => Promise<T>,
  deps: readonly unknown[],
): {
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async (): Promise<void> => {
    const call = ++latest.current;
    setLoading(true);
    try {
      const value = await serverToolsLane(panelId, database).run((host, sessionId) =>
        loadRef.current(host, sessionId),
      );
      if (call !== latest.current) return;
      setData(value);
      setError(undefined);
    } catch (e) {
      if (call === latest.current) setError(errorMessage(e));
    } finally {
      if (call === latest.current) setLoading(false);
    }
  }, [panelId, database]);
  useEffect(() => {
    void reload();
    // `deps` are the caller's inputs to `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);
  return { data, error, loading, reload };
}

/**
 * Runs an action with its preview and confirmation (see runServerAction); resolves the
 * result, or undefined when the user declined. Errors are left to the caller.
 */
export function runAction(
  panelId: string,
  action: ServerAction,
  options: { readonly database?: string; readonly confirmLabel?: string } = {},
): Promise<ActionResult | undefined> {
  const state = panelState(panelId);
  return runServerAction({
    profileId: state.profileId,
    engine: state.engine,
    lane: serverToolsLane(panelId, options.database),
    action,
    ...(options.confirmLabel !== undefined ? { confirmLabel: options.confirmLabel } : {}),
  });
}

export function NoticeList(props: { readonly notices: readonly ServerNotice[] }) {
  return (
    <>
      {props.notices.map((notice, i) => (
        <Notice
          key={`${i}:${notice.message}`}
          kind={notice.level === 'info' ? 'info' : notice.level === 'error' ? 'error' : 'warning'}
        >
          {notice.message}
          {notice.hint ? ` — ${notice.hint}` : ''}
        </Notice>
      ))}
    </>
  );
}

export function SectionTitle(props: { readonly children: ReactNode }) {
  return (
    <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
      {props.children}
    </h3>
  );
}

/** A server tools table: header, formatted cells (numbers right-aligned), an empty message. */
export function ToolTableView(props: {
  readonly table: ToolTable;
  readonly label: string;
  readonly empty?: string | undefined;
  readonly testId?: string;
}) {
  const { table } = props;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" aria-label={props.label} data-testid={props.testId}>
          <thead className="text-left text-[11px] text-muted uppercase">
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  className={cx(
                    'px-2 py-1 font-semibold whitespace-nowrap',
                    isNumericUnit(column.unit) && 'text-right',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-t border-border/50">
                {table.columns.map((column) => (
                  <Cell key={column.key} column={column} value={row[column.key]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length === 0 && props.empty && (
        <p className="px-2 py-1 text-xs text-muted">{props.empty}</p>
      )}
    </>
  );
}

export function Cell(props: {
  readonly column: ToolColumn;
  readonly value: ToolTable['rows'][number][string] | undefined;
}) {
  const text = formatCell(props.value, props.column.unit);
  return (
    <td
      className={cx(
        'px-2 py-1 align-top',
        isNumericUnit(props.column.unit)
          ? 'text-right tabular-nums whitespace-nowrap'
          : 'break-words',
      )}
      title={
        typeof props.value === 'string' && props.value.length > 80
          ? props.value.slice(0, 2000)
          : undefined
      }
    >
      {text}
    </td>
  );
}

/** What an action did: its messages and any tabular output. */
export function ActionOutcome(props: {
  readonly result: ActionResult;
  readonly engine: EngineId;
  readonly onClose: () => void;
}) {
  const { result } = props;
  return (
    <section
      className="border-b border-border bg-panel-2/40 px-3 py-2"
      aria-label="Result"
      data-testid="action-result"
    >
      <div className="flex items-center gap-2">
        <SectionTitle>Result</SectionTitle>
        <span className="text-xs text-muted">{result.durationMs} ms</span>
        <span className="flex-1" />
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={props.onClose}>
          Dismiss
        </button>
      </div>
      <pre className="mb-1 max-h-24 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted select-text">
        {result.statements.join(props.engine === 'mongodb' ? '\n' : ';\n')}
      </pre>
      <ul className="max-h-40 overflow-auto text-xs" data-testid="action-messages">
        {result.messages.map((message, i) => (
          <li
            key={i}
            className={cx(
              'font-mono whitespace-pre-wrap select-text',
              message.level === 'error' && 'text-danger',
              message.level === 'warning' && 'text-warning',
            )}
          >
            {message.message}
            {message.hint ? ` — ${message.hint}` : ''}
          </li>
        ))}
      </ul>
      {result.table && (
        <div className="mt-1 max-h-48 overflow-auto">
          <ToolTableView table={result.table} label="Output" />
        </div>
      )}
    </section>
  );
}

/** A labelled select for the toolbars. */
export function ToolSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted">
      {props.label}
      <select
        aria-label={props.label}
        className="h-7 max-w-56 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Check(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly title?: string;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted" title={props.title}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}

/** The engine's own database picker label: schema on PostgreSQL, database elsewhere. */
export function containerLabel(engine: EngineId): string {
  return engine === 'postgres' ? 'Schema' : 'Database';
}
