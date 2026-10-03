import type { ActionResult, MaintenanceOperation } from '@querybara/core';
import { useEffect, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCell, isNumericUnit } from '../../state/server-tools/format';
import { useServerToolsPanels } from '../../state/server-tools/panels';
import { Notice, Toolbar } from '../redis/common';
import { Button, Input, cx } from '../ui';
import {
  ActionOutcome,
  Check,
  NoticeList,
  ToolSelect,
  containerLabel,
  runAction,
  useToolData,
  type TabProps,
} from './common';

/**
 * Maintenance (spec §15): VACUUM, ANALYZE, REINDEX and CLUSTER; ANALYZE, OPTIMIZE, CHECK and
 * REPAIR TABLE; compact and validate. Pick tables or collections (with their sizes, dead rows
 * or free space to decide), the command and its options; the exact statement is shown before
 * it runs, and the server's output after.
 */

export function MaintenanceTab({ panelId, info }: TabProps) {
  const focus = useServerToolsPanels((state) => state.panels[panelId]?.focus);
  const focusId = useServerToolsPanels((state) => state.panels[panelId]?.focusId);
  const perDatabase = info.perDatabaseSessions;
  const [database, setDatabase] = useState<string | undefined>(
    perDatabase ? (focus?.database ?? info.database ?? undefined) : undefined,
  );
  const [container, setContainer] = useState<string | undefined>(focus?.container);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set(focus?.name !== undefined ? [focus.name] : []),
  );
  const [operation, setOperation] = useState<MaintenanceOperation>(
    info.maintenance[0]?.id ?? 'analyze',
  );
  const [options, setOptions] = useState<ReadonlySet<string>>(new Set());
  const [index, setIndex] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ActionResult>();

  // A table picked in the explorer while the panel was open.
  useEffect(() => {
    if (!focus) return;
    if (perDatabase && focus.database !== undefined) setDatabase(focus.database);
    if (focus.container !== undefined) setContainer(focus.container);
    if (focus.name !== undefined) setSelected(new Set([focus.name]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const targets = useToolData(
    panelId,
    database,
    (host, sessionId) =>
      host.serverTools.maintenanceTargets({
        sessionId,
        ...(container !== undefined ? { container } : {}),
      }),
    [container],
  );
  const data = targets.data;
  const op = info.maintenance.find((m) => m.id === operation);
  const needle = filter.trim().toLowerCase();
  const visible = (data?.targets ?? []).filter(
    (t) => needle === '' || t.name.toLowerCase().includes(needle),
  );
  const chosen = (data?.targets ?? []).filter((t) => selected.has(t.name));
  const indexes = chosen.length === 1 ? chosen[0]!.indexes : [];

  const toggle = (name: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) next.add(name);
    else next.delete(name);
    setSelected(next);
  };
  const run = async (): Promise<void> => {
    if (!data?.container || chosen.length === 0) return;
    setError(undefined);
    try {
      const done = await runAction(
        panelId,
        {
          kind: 'maintenance',
          operation,
          targets: chosen.map((t) => ({ container: t.container, name: t.name })),
          options: [...options],
          ...(op?.usesIndex && index !== '' ? { index } : {}),
        },
        { ...(database !== undefined ? { database } : {}), confirmLabel: 'Run' },
      );
      if (done) {
        setResult(done);
        await targets.reload();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="server-maintenance">
      <Toolbar label="Maintenance">
        {perDatabase && (
          <ToolSelect
            label="Database"
            value={database ?? ''}
            onChange={(v) => {
              setDatabase(v);
              setContainer(undefined);
              setSelected(new Set());
            }}
            options={info.databases.map((d) => ({ value: d, label: d }))}
          />
        )}
        <ToolSelect
          label={containerLabel(info.engine)}
          value={data?.container ?? ''}
          onChange={(v) => {
            setContainer(v);
            setSelected(new Set());
          }}
          options={(data?.containers ?? []).map((c) => ({ value: c, label: c }))}
        />
        <Input
          aria-label="Filter tables"
          placeholder="Filter"
          className="h-7 w-40 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button size="sm" onClick={() => void targets.reload()} disabled={targets.loading}>
          Refresh
        </Button>
      </Toolbar>
      <Toolbar label="Maintenance command">
        <ToolSelect
          label="Command"
          value={operation}
          onChange={(v) => {
            setOperation(v as MaintenanceOperation);
            setOptions(new Set());
            setIndex('');
          }}
          options={info.maintenance.map((m) => ({ value: m.id, label: m.label }))}
        />
        {op?.options.map((option) => (
          <Check
            key={option.id}
            label={option.label}
            title={option.description}
            checked={options.has(option.id)}
            onChange={(on) => {
              const next = new Set(options);
              if (on) next.add(option.id);
              else next.delete(option.id);
              setOptions(next);
            }}
          />
        ))}
        {op?.usesIndex && (
          <ToolSelect
            label="Using index"
            value={index}
            onChange={setIndex}
            disabled={indexes.length === 0}
            options={[
              {
                value: '',
                label: chosen.length === 1 ? '(the clustered one)' : '(pick one table)',
              },
              ...indexes.map((i) => ({ value: i, label: i })),
            ]}
          />
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted">{chosen.length} selected</span>
        <Button
          size="sm"
          variant="primary"
          disabled={chosen.length === 0}
          onClick={() => void run()}
        >
          Run {op?.label ?? ''}…
        </Button>
      </Toolbar>
      {op && (
        <p className="border-b border-border px-3 py-1 text-xs text-muted">{op.description}</p>
      )}
      {(error ?? targets.error) && <Notice kind="error">{error ?? targets.error}</Notice>}
      <NoticeList notices={data?.notices ?? []} />
      {result && (
        <ActionOutcome result={result} engine={info.engine} onClose={() => setResult(undefined)} />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs" aria-label="Tables" data-testid="maintenance-targets">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted uppercase">
            <tr>
              <th className="w-8 px-2 py-1">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={visible.length > 0 && visible.every((t) => selected.has(t.name))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(visible.map((t) => t.name)) : new Set())
                  }
                />
              </th>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Type</th>
              {(data?.detailColumns ?? []).map((column) => (
                <th
                  key={column.key}
                  className={cx(
                    'px-2 py-1 whitespace-nowrap',
                    isNumericUnit(column.unit) && 'text-right',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((target) => (
              <tr
                key={target.name}
                className="border-b border-border/50"
                data-testid="maintenance-target"
              >
                <td className="px-2 py-1">
                  <input
                    type="checkbox"
                    aria-label={`Select ${target.name}`}
                    checked={selected.has(target.name)}
                    onChange={(e) => toggle(target.name, e.target.checked)}
                  />
                </td>
                <td className="px-2 py-1 font-mono">{target.name}</td>
                <td className="px-2 py-1 text-muted">{target.type}</td>
                {(data?.detailColumns ?? []).map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      'px-2 py-1 whitespace-nowrap',
                      isNumericUnit(column.unit) && 'text-right tabular-nums',
                    )}
                  >
                    {formatCell(target.detail[column.key], column.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data && visible.length === 0 && (
          <p className="p-4 text-center text-xs text-muted">Nothing to maintain here.</p>
        )}
      </div>
    </div>
  );
}
