import type { ErrorData } from '@joinery/core';
import type {
  ConfigApplyResult,
  ConfigNodeOutcome,
  ConfigSnapshot,
  ConfigTarget,
} from '@joinery/driver-redis';
import {
  CONFIG_SECRET_MASK,
  buildConfigRows,
  configSetCommands,
  friendlyConfigValue,
  type ConfigRow,
} from '@joinery/redis-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorInfo, errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import {
  CONFIG_RESETSTAT,
  CONFIG_REWRITE,
  configSetOperation,
} from '../../../../../shared/redis-safety';
import {
  CONFIG_FILTERS,
  applyOutcome,
  draftsAfterApply,
  editorKind,
  editorValue,
  groupConfigRows,
  pendingChanges,
  previewCommands,
  selectChoices,
  targetChoices,
  targetOf,
  updateDrafts,
  type ConfigDrafts,
  type ConfigFilter,
  type PendingChange,
} from '../../../state/redis/config-editor';
import { panelLane, redisWrite, type RedisPanelTarget } from '../../../state/redis/panels';
import { Button, Input, cx } from '../../ui';
import { EmptyState, Notice, Toolbar, useConnectionFacts, usePanelData } from '../common';

/**
 * The configuration editor (spec §15, "CONFIG GET and SET"): every parameter from CONFIG GET *,
 * grouped and searchable, its current value beside the default, a typed editor per parameter,
 * and the pending changes with the exact CONFIG SET they send before Apply. In Cluster mode it
 * reads every primary (differences between nodes are shown) or one node; in Sentinel mode the
 * master or a replica. Secrets are never shown: they can only be replaced through a password
 * field. When the server refuses CONFIG, the panel says why.
 */

interface ToolProps {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}

/** CONFIG GET * of the target, keeping the error's code and hint for the explanations. */
function useSnapshot(
  panelId: string,
  target: ConfigTarget,
): {
  readonly snapshot: ConfigSnapshot | undefined;
  readonly error: ErrorData | undefined;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
} {
  const [state, setState] = useState<{
    snapshot?: ConfigSnapshot;
    error?: ErrorData;
    loading: boolean;
  }>({ loading: true });
  const latest = useRef(0);
  const current = useRef(target);
  current.current = target;
  const key = JSON.stringify(target);
  const reload = useCallback(async (): Promise<void> => {
    const call = ++latest.current;
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const snapshot = await panelLane(panelId).run((host, sessionId) =>
        host.redis.config.get({ sessionId, ...current.current }),
      );
      if (call === latest.current) setState({ snapshot, loading: false });
    } catch (e) {
      if (call === latest.current) setState({ error: errorInfo(e), loading: false });
    }
    // `key` stands for the target: a new target reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, key]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { snapshot: state.snapshot, error: state.error, loading: state.loading, reload };
}

function Badge(props: {
  readonly tone: 'muted' | 'accent' | 'warning';
  readonly children: string;
}) {
  return (
    <span
      className={cx(
        'rounded px-1 text-[10px] font-semibold tracking-wide uppercase',
        props.tone === 'muted' && 'bg-panel-2 text-muted',
        props.tone === 'accent' && 'bg-accent/15 text-accent',
        props.tone === 'warning' && 'bg-warning/15 text-warning',
      )}
    >
      {props.children}
    </span>
  );
}

const selectClass = 'h-7 w-full rounded border border-border bg-panel-2 px-1 text-xs text-fg';

function ValueEditor(props: {
  readonly row: ConfigRow;
  readonly redisVersion: string;
  readonly drafts: ConfigDrafts;
  readonly error: string | undefined;
  readonly onChange: (typed: string) => void;
}) {
  const { row, drafts, error } = props;
  const kind = editorKind(row, props.redisVersion);
  const value = editorValue(row, drafts);
  const unit = row.meta?.unit && row.meta.unit !== 'count' ? row.meta.unit : undefined;
  const friendly =
    kind === 'text' && value !== '' ? friendlyConfigValue(row.name, value) : undefined;
  let editor;
  switch (kind) {
    case 'readonly':
      editor = (
        <span className="flex items-center gap-1.5">
          <span className="font-mono break-all select-text">
            {row.value ?? '(differs between nodes)'}
          </span>
          <span title="CONFIG SET cannot change it on this server: it is read at startup">
            <Badge tone="muted">startup only</Badge>
          </span>
        </span>
      );
      break;
    case 'secret':
      editor = (
        <span className="flex flex-col gap-1">
          <span className="text-muted" data-testid="secret-state">
            {row.secretSet
              ? `${CONFIG_SECRET_MASK} (set)`
              : row.differs
                ? 'Set on some nodes only'
                : '(not set)'}
          </span>
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={row.name}
            placeholder="New value"
            className="h-7 text-xs"
            value={value}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </span>
      );
      break;
    case 'select':
      editor = (
        <select
          aria-label={row.name}
          className={cx(selectClass, drafts[row.name] !== undefined && 'border-accent')}
          value={value}
          onChange={(e) => props.onChange(e.target.value)}
        >
          {value === '' && <option value="">(differs between nodes)</option>}
          {selectChoices(row).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      );
      break;
    case 'text':
      editor = (
        <span className="flex items-center gap-1.5">
          <Input
            aria-label={row.name}
            aria-invalid={error !== undefined}
            placeholder={row.value === undefined ? '(differs between nodes)' : undefined}
            className={cx(
              'h-7 font-mono text-xs',
              drafts[row.name] !== undefined && error === undefined && 'border-accent',
            )}
            spellCheck={false}
            value={value}
            onChange={(e) => props.onChange(e.target.value)}
          />
          {unit && <span className="shrink-0 text-muted">{unit}</span>}
        </span>
      );
      break;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {editor}
      {friendly && <span className="text-[11px] text-muted">= {friendly}</span>}
      {error && (
        <span className="text-[11px] text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function RowView(props: {
  readonly row: ConfigRow;
  readonly redisVersion: string;
  readonly drafts: ConfigDrafts;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly onChange: (typed: string) => void;
}) {
  const { row, pending } = props;
  const meta = row.meta;
  return (
    <tr
      className={cx('border-b border-border/50 align-top', pending && 'bg-accent/5')}
      data-testid="config-row"
      data-name={row.name}
    >
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-fg select-text">{row.name}</span>
          {row.isDefault === false && <Badge tone="accent">changed</Badge>}
          {row.differs && <Badge tone="warning">differs</Badge>}
          {pending && <Badge tone="accent">pending</Badge>}
          {meta?.disruptive && <Badge tone="warning">asks first</Badge>}
        </div>
        {meta && <p className="mt-0.5 text-[11px] text-muted">{meta.description}</p>}
        {row.aliases.length > 0 && (
          <p className="text-[11px] text-muted">Also listed as {row.aliases.join(', ')}</p>
        )}
        {meta?.protected && (
          <p className="text-[11px] text-muted">
            Protected: Redis 7+ changes it only when enable-protected-configs allows it.
          </p>
        )}
        {row.differs && !row.secret && (
          <ul className="mt-1 text-[11px]" aria-label={`${row.name} per node`}>
            {row.byNode.map((n) => (
              <li key={n.node} className="font-mono">
                <span className="text-muted">{n.node}:</span> {n.value === '' ? '""' : n.value}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="w-[36%] px-2 py-1.5">
        <ValueEditor {...props} />
      </td>
      <td className="w-[16%] px-2 py-1.5 font-mono break-all text-muted">
        {meta?.default === undefined ? '—' : meta.default === '' ? '""' : meta.default}
      </td>
    </tr>
  );
}

function PendingList(props: {
  readonly pending: readonly PendingChange[];
  readonly preview: readonly string[];
  readonly multiSet: boolean;
  readonly busy: boolean;
  readonly targetLabel: string;
  readonly onDiscard: (name: string | undefined) => void;
  readonly onApply: () => void;
}) {
  const invalid = props.pending.some((p) => p.error !== undefined);
  return (
    <section
      aria-label="Pending changes"
      data-testid="config-pending"
      className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-auto border-t border-border bg-panel p-3 text-xs"
    >
      <h3 className="font-semibold">Pending changes ({props.pending.length})</h3>
      <ul className="flex flex-col gap-1">
        {props.pending.map((p) => (
          <li
            key={p.name}
            className="flex items-center gap-2"
            data-testid="pending-change"
            data-name={p.name}
          >
            <span className="font-mono">{p.name}</span>
            <span className="font-mono text-muted">
              {p.secret ? '' : `${p.current === undefined ? '(differs)' : p.current || '""'} → `}
            </span>
            <span className="font-mono break-all">
              {p.secret ? CONFIG_SECRET_MASK : p.value === '' ? '""' : p.value}
            </span>
            {p.error && <span className="text-danger">{p.error}</span>}
            <span className="flex-1" />
            <button
              type="button"
              className="rounded px-1 text-muted hover:bg-hover hover:text-fg"
              aria-label={`Discard the change of ${p.name}`}
              onClick={() => props.onDiscard(p.name)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {props.preview.length > 0 && (
        <div>
          <span className="text-muted">Runs exactly, on {props.targetLabel}:</span>
          <pre
            className="mt-1 rounded border border-border bg-panel-2 p-2 font-mono whitespace-pre-wrap select-text"
            data-testid="config-command"
          >
            {props.preview.join('\n')}
          </pre>
          <p className="mt-1 text-muted">
            {props.multiSet
              ? 'The server applies these changes all or none.'
              : 'This server takes one parameter at a time: some changes may apply while others fail.'}
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={props.busy || invalid || props.preview.length === 0}
          onClick={props.onApply}
        >
          Apply
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDiscard(undefined)}>
          Discard all
        </Button>
        {invalid && <span className="self-center text-danger">Fix the values marked in red.</span>}
      </div>
    </section>
  );
}

type LastAction =
  | { readonly kind: 'apply'; readonly result: ConfigApplyResult }
  | { readonly kind: 'rewrite' | 'resetStat'; readonly outcomes: readonly ConfigNodeOutcome[] };

function ActionResult(props: { readonly action: LastAction; readonly onClose: () => void }) {
  const { action } = props;
  if (action.kind === 'apply') {
    const { applied, failed } = applyOutcome(action.result);
    const nodes = action.result.nodes.length;
    return (
      <Notice kind={failed.length > 0 ? 'error' : 'info'} onClose={props.onClose}>
        <span data-testid="config-result">
          {applied.length > 0 &&
            `Applied ${applied.join(', ')}${nodes > 1 ? ` on ${nodes} nodes` : ''}.`}
          {failed.map((f) => (
            <span key={`${f.node}-${f.name}`} className="block">
              {f.name}
              {nodes > 1 ? ` on ${f.node}` : ''}: {f.error}
            </span>
          ))}
        </span>
      </Notice>
    );
  }
  const failed = action.outcomes.filter((o) => !o.ok);
  const what =
    action.kind === 'rewrite' ? 'Rewrote the configuration file' : 'Reset the statistics';
  return (
    <Notice kind={failed.length > 0 ? 'error' : 'info'} onClose={props.onClose}>
      <span data-testid="config-result">
        {failed.length < action.outcomes.length &&
          `${what}${action.outcomes.length > 1 ? ` on ${action.outcomes.length - failed.length} nodes` : ''}.`}
        {failed.map((f) => (
          <span key={f.node} className="block">
            {action.outcomes.length > 1 ? `${f.node}: ` : ''}
            {f.error}
          </span>
        ))}
      </span>
    </Notice>
  );
}

function Unavailable(props: { readonly error: ErrorData }) {
  const permission = props.error.engineCode === 'NOPERM';
  return (
    <div className="flex flex-col gap-2 p-6 text-sm" data-testid="config-unavailable" role="alert">
      <h3 className="font-semibold">
        {permission ? 'Not allowed to read the configuration' : 'Configuration unavailable'}
      </h3>
      <p>{props.error.message}.</p>
      {props.error.hint && <p className="text-muted">{props.error.hint}.</p>}
    </div>
  );
}

export function ConfigPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [choice, setChoice] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ConfigFilter>('all');
  const [drafts, setDrafts] = useState<ConfigDrafts>({});
  const [action, setAction] = useState<LastAction>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const configTarget = useMemo(() => targetOf(choice), [choice]);
  const nodes = usePanelData(
    panelId,
    (host, sessionId) => host.redis.config.nodes({ sessionId }),
    [],
  );
  const { snapshot, error: loadError, loading, reload } = useSnapshot(panelId, configTarget);
  const rows = useMemo(() => (snapshot ? buildConfigRows(snapshot.nodes) : []), [snapshot]);
  const groups = useMemo(
    () => groupConfigRows(rows, { search, filter, drafts }),
    [rows, search, filter, drafts],
  );
  const pending = useMemo(() => pendingChanges(rows, drafts), [rows, drafts]);
  const multiSet = snapshot?.multiSet ?? false;
  const valid = pending.filter((p) => p.error === undefined);
  const preview = pending.some((p) => p.error !== undefined)
    ? []
    : previewCommands(valid, multiSet);
  const errors = new Map(pending.flatMap((p) => (p.error ? [[p.name, p.error] as const] : [])));
  const pendingNames = new Set(pending.map((p) => p.name));
  const redisVersion = facts?.info.server.redisVersion ?? '0';
  const topology = facts?.info.server.topology ?? 'standalone';
  const choices = targetChoices(nodes.data ?? [], topology);
  const targetLabel =
    snapshot && snapshot.nodes.length > 1
      ? `${snapshot.nodes.length} nodes`
      : (snapshot?.nodes[0]?.node ?? 'the server');
  const changed = rows.filter((r) => r.isDefault === false).length;
  const differing = rows.filter((r) => r.differs).length;

  const apply = async (): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      const changes = valid.map(({ name, value }) => ({ name, value }));
      const result = await redisWrite({
        profileId: target.profileId,
        operation: configSetOperation(changes.map((c) => c.name)),
        title: `Change ${changes.length === 1 ? 'this parameter' : `${changes.length} parameters`} on ${targetLabel}?`,
        commands: configSetCommands(changes, { multi: multiSet, mask: true }),
        confirmLabel: 'Apply',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.config.set({ sessionId, changes, confirmed, ...configTarget }),
          ),
      });
      if (result === undefined) return;
      setDrafts((current) => draftsAfterApply(current, result));
      setAction({ kind: 'apply', result });
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onEachNode = async (kind: 'rewrite' | 'resetStat'): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      const rewrite = kind === 'rewrite';
      const outcomes = await redisWrite({
        profileId: target.profileId,
        operation: rewrite ? CONFIG_REWRITE : CONFIG_RESETSTAT,
        title: `${rewrite ? 'Rewrite the configuration file' : 'Reset the statistics'} on ${targetLabel}?`,
        commands: [['CONFIG', rewrite ? 'REWRITE' : 'RESETSTAT']],
        confirmLabel: rewrite ? 'Rewrite' : 'Reset',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            rewrite
              ? host.redis.config.rewrite({ sessionId, confirmed, ...configTarget })
              : host.redis.config.resetStat({ sessionId, confirmed, ...configTarget }),
          ),
      });
      if (outcomes !== undefined) setAction({ kind, outcomes });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const unavailable = loadError?.code === 'NOT_SUPPORTED' ? loadError : undefined;
  return (
    <div className="flex h-full flex-col bg-bg text-xs" data-testid="redis-config">
      <Toolbar label="Configuration">
        {choices.length > 1 && (
          <label className="flex items-center gap-1 text-muted">
            Node
            <select
              aria-label="Configuration target"
              className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {!unavailable && (
          <>
            <span className="w-56">
              <Input
                aria-label="Search parameters"
                placeholder="Search parameters"
                className="h-7 text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </span>
            <select
              aria-label="Show"
              className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
              value={filter}
              onChange={(e) => setFilter(e.target.value as ConfigFilter)}
            >
              {CONFIG_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </>
        )}
        <Button size="sm" onClick={() => void reload()} disabled={loading}>
          Refresh
        </Button>
        <span className="flex-1" />
        {snapshot && (
          <span className="text-muted" data-testid="config-summary">
            {formatCount(rows.length)} parameters · {formatCount(changed)} changed
            {snapshot.nodes.length > 1 && ` · ${formatCount(differing)} differ`}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !snapshot}
          onClick={() => void onEachNode('rewrite')}
        >
          Rewrite config file…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !snapshot}
          onClick={() => void onEachNode('resetStat')}
        >
          Reset statistics…
        </Button>
      </Toolbar>
      {error && (
        <Notice kind="error" onClose={() => setError(undefined)}>
          {error}
        </Notice>
      )}
      {loadError && !unavailable && <Notice kind="error">{errorMessage(loadError)}</Notice>}
      {nodes.error && !unavailable && <Notice kind="warning">{nodes.error}</Notice>}
      {action && <ActionResult action={action} onClose={() => setAction(undefined)} />}
      {unavailable ? (
        <Unavailable error={unavailable} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full" aria-label="Configuration parameters">
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] text-muted uppercase">
              <tr>
                <th className="px-2 py-1 font-semibold">Parameter</th>
                <th className="px-2 py-1 font-semibold">Value</th>
                <th className="px-2 py-1 font-semibold">Default</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.id} aria-label={group.title} data-testid="config-group">
                <tr>
                  <th
                    colSpan={3}
                    scope="colgroup"
                    className="bg-panel-2 px-2 py-1 text-left text-[11px] font-semibold tracking-wide text-muted uppercase"
                  >
                    {group.title} ({group.rows.length})
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <RowView
                    key={row.name}
                    row={row}
                    redisVersion={redisVersion}
                    drafts={drafts}
                    pending={pendingNames.has(row.name)}
                    error={errors.get(row.name)}
                    onChange={(typed) => setDrafts((current) => updateDrafts(current, row, typed))}
                  />
                ))}
              </tbody>
            ))}
          </table>
          {snapshot && groups.length === 0 && <EmptyState>No parameter matches.</EmptyState>}
          {!snapshot && loading && <EmptyState>Reading the configuration…</EmptyState>}
        </div>
      )}
      {pending.length > 0 && !unavailable && (
        <PendingList
          pending={pending}
          preview={preview}
          multiSet={multiSet}
          busy={busy}
          targetLabel={targetLabel}
          onDiscard={(name) =>
            setDrafts((current) =>
              name === undefined
                ? {}
                : Object.fromEntries(Object.entries(current).filter(([n]) => n !== name)),
            )
          }
          onApply={() => void apply()}
        />
      )}
    </div>
  );
}
