import type { RenameRuleInfo, SyncOperationInfo } from '@querybara/ipc';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { RENAME_OBJECT_KINDS } from '@querybara/ipc';

import { pairWarnings, sideTitle } from '../../state/sync/sides';
import { appProfileLookup } from '../../state/sync/panels';
import {
  STRUCTURE_OPTIONS,
  groupOperations,
  type StructureCompare,
} from '../../state/sync/structure';
import { SelectField, TextField } from '../designer/fields';
import { Button, Icon, cx } from '../ui';
import { StructureApplyDialog } from './ApplyDialogs';
import { Banner, Check, KindBadge, RunningBar, SaveComparison } from './parts';
import { SideFields } from './SideFields';

/**
 * The structure compare panel (spec §13): the two sides and options, then the operations
 * grouped by object kind with create/alter/drop badges and a tick box each, the source and
 * target definitions side by side for the operation in focus, the script for the ticked ones,
 * Apply (with its review), and exports of the script and the HTML report.
 */
export function StructureComparePanel(props: { readonly model: StructureCompare }) {
  const { model } = props;
  const state = useStore(model.store);
  const [setupOpen, setSetupOpen] = useState(true);
  const [applying, setApplying] = useState(false);
  const busy = state.running !== undefined;
  const problem = model.problem();
  const warnings = pairWarnings(state.source, state.target, appProfileLookup);
  const showSetup = setupOpen || !state.result;
  const compare = async (): Promise<void> => {
    await model.compare();
    if (model.state.result && !model.state.error) setSetupOpen(false);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg" data-testid="structure-compare">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5">
        <h2 className="text-sm font-semibold">Structure compare</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {sideTitle(state.source, appProfileLookup)} → {sideTitle(state.target, appProfileLookup)}
        </span>
        {state.result && (
          <Button size="sm" variant="ghost" onClick={() => setSetupOpen(!setupOpen)}>
            {setupOpen ? 'Hide setup' : 'Change setup'}
          </Button>
        )}
        <SaveComparison
          saved={state.saved}
          suggested={`${sideTitle(state.source, appProfileLookup)} → ${sideTitle(state.target, appProfileLookup)}`}
          onSave={(name) => model.save(name)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {showSetup && (
          <section aria-label="Compare setup" className="flex flex-col gap-2">
            <div className="flex items-stretch gap-2">
              <SideFields
                role="source"
                draft={state.source}
                disabled={busy}
                onChange={(patch) => model.setSide('source', patch)}
              />
              <div className="flex items-center">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Swap source and target"
                  title="Swap source and target"
                  onClick={() => model.swapSides()}
                  disabled={busy}
                >
                  ⇄
                </Button>
              </div>
              <SideFields
                role="target"
                draft={state.target}
                disabled={busy}
                onChange={(patch) => model.setSide('target', patch)}
              />
            </div>
            <details className="rounded border border-border p-2" open>
              <summary className="cursor-pointer text-xs font-semibold">Options</summary>
              <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1.5">
                {STRUCTURE_OPTIONS.map((option) => (
                  <Check
                    key={option.key}
                    label={option.label}
                    hint={option.hint}
                    checked={state.options[option.key]}
                    disabled={busy}
                    onChange={(checked) => model.setOption(option.key, checked)}
                  />
                ))}
              </div>
            </details>
            <RenameRules model={model} renames={state.renames} disabled={busy} />
            {warnings.map((warning) => (
              <Banner key={warning} tone="warning">
                {warning}
              </Banner>
            ))}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void compare()}
                disabled={busy || problem !== undefined}
                title={problem}
              >
                <Icon name="refresh" className="h-3.5 w-3.5" />
                {state.result ? 'Compare again' : 'Compare'}
              </Button>
              {problem && <span className="text-xs text-muted">{problem}</span>}
              {state.stale && !busy && (
                <span className="text-xs text-warning">
                  The setup changed: compare again to update the results.
                </span>
              )}
            </div>
          </section>
        )}
        {state.running && (
          <RunningBar running={state.running} onCancel={() => void model.cancel()} />
        )}
        {state.error && (
          <Banner tone="error" testId="sync-error">
            {state.error}
          </Banner>
        )}
        {state.notice && (
          <Banner tone="notice" testId="sync-notice">
            {state.notice}
          </Banner>
        )}
        {state.result && <Results model={model} onApply={() => setApplying(true)} />}
      </div>
      {applying && state.result && (
        <StructureApplyDialog model={model} onClose={() => setApplying(false)} />
      )}
    </div>
  );
}

function RenameRules(props: {
  readonly model: StructureCompare;
  readonly renames: readonly RenameRuleInfo[];
  readonly disabled: boolean;
}) {
  const { model, renames } = props;
  return (
    <details className="rounded border border-border p-2" open={renames.length > 0}>
      <summary className="cursor-pointer text-xs font-semibold">
        Rename mapping{renames.length > 0 ? ` (${renames.length})` : ''}
      </summary>
      <p className="mt-1 text-[11px] text-muted">
        A table, column, index, constraint or view renamed in the source: the target is renamed
        instead of dropped and created again.
      </p>
      {renames.length > 0 && (
        <table className="mt-1 w-full text-xs" aria-label="Rename mapping">
          <thead className="text-left text-[11px] text-muted">
            <tr>
              <th className="font-medium">Object</th>
              <th className="font-medium">Table (columns, indexes)</th>
              <th className="font-medium">Name in the target</th>
              <th className="font-medium">Name in the source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {renames.map((rule, index) => (
              <tr key={index}>
                <td className="pr-1">
                  <SelectField
                    aria-label="Object kind"
                    value={rule.objectKind}
                    disabled={props.disabled}
                    onChange={(event) =>
                      model.updateRename(index, {
                        objectKind: event.target.value as RenameRuleInfo['objectKind'],
                      })
                    }
                  >
                    {RENAME_OBJECT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </SelectField>
                </td>
                <td className="pr-1">
                  <TextField
                    aria-label="Table"
                    value={rule.table ?? ''}
                    disabled={
                      props.disabled || rule.objectKind === 'table' || rule.objectKind === 'view'
                    }
                    onChange={(event) => model.updateRename(index, { table: event.target.value })}
                  />
                </td>
                <td className="pr-1">
                  <TextField
                    aria-label="Name in the target"
                    value={rule.from}
                    disabled={props.disabled}
                    onChange={(event) => model.updateRename(index, { from: event.target.value })}
                  />
                </td>
                <td className="pr-1">
                  <TextField
                    aria-label="Name in the source"
                    value={rule.to}
                    disabled={props.disabled}
                    onChange={(event) => model.updateRename(index, { to: event.target.value })}
                  />
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Remove rename"
                    disabled={props.disabled}
                    onClick={() => model.removeRename(index)}
                  >
                    <Icon name="close" className="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="mt-1"
        disabled={props.disabled}
        onClick={() => model.addRename({ objectKind: 'table', from: '', to: '' })}
      >
        <Icon name="plus" className="h-3 w-3" />
        Add a rename
      </Button>
    </details>
  );
}

function Results(props: { readonly model: StructureCompare; readonly onApply: () => void }) {
  const { model } = props;
  const state = useStore(model.store);
  const result = state.result!;
  const selected = useMemo(() => new Set(state.selected), [state.selected]);
  const groups = useMemo(
    () => groupOperations(result.diff.operations, selected),
    [result.diff.operations, selected],
  );
  const missing = model.missing();
  const [tab, setTab] = useState<'definitions' | 'script'>('definitions');
  const byId = useMemo(
    () => new Map(result.diff.operations.map((op) => [op.id, op])),
    [result.diff.operations],
  );
  const focused = state.focused !== undefined ? byId.get(state.focused) : undefined;
  const summary = result.summary;
  const busy = state.running !== undefined;
  const destructiveTicked = result.diff.operations.filter(
    (op) => op.destructive && selected.has(op.id),
  ).length;
  if (result.diff.operations.length === 0) {
    return (
      <section aria-label="Comparison" className="flex flex-col gap-2" data-testid="sync-results">
        <p className="rounded border border-border bg-panel p-4 text-center text-sm" role="status">
          No differences: {result.target.profileName} ({result.target.database}) matches{' '}
          {result.source.profileName} ({result.source.database}).
        </p>
        <Exports model={model} disabled={busy} empty />
      </section>
    );
  }
  return (
    <section
      aria-label="Comparison"
      className="flex min-h-[28rem] flex-1 flex-col gap-2"
      data-testid="sync-results"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="sync-summary">
        <span className="font-semibold">
          {summary.total} {summary.total === 1 ? 'difference' : 'differences'}
        </span>
        {(['create', 'alter', 'drop', 'rename'] as const).map((kind) =>
          summary[kind] > 0 ? <KindBadge key={kind} kind={kind} count={summary[kind]} /> : null,
        )}
        {summary.destructive > 0 && (
          <span className="text-danger">{summary.destructive} destructive</span>
        )}
        <span className="text-muted">
          · {state.selected.length} of {summary.total} selected
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => model.setAll(true, (op) => !op.destructive)}
        >
          Select safe
        </Button>
        <Button size="sm" variant="ghost" onClick={() => model.setAll(true)}>
          Select all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => model.setAll(false)}>
          Select none
        </Button>
      </div>
      {result.diff.warnings.map((warning, index) => (
        <Banner key={index} tone="warning">
          {warning.message}
        </Banner>
      ))}
      {missing.length > 0 && (
        <Banner tone="warning" testId="missing-dependencies">
          {missing.length === 1
            ? 'A ticked operation needs'
            : `${missing.length} ticked operations need`}{' '}
          operations that are not ticked:{' '}
          {missing
            .map(
              (m) =>
                `${byId.get(m.operationId)?.qualifiedName ?? m.operationId} needs ${m.missing.map((id) => byId.get(id)?.qualifiedName ?? id).join(', ')}`,
            )
            .join('; ')}
        </Banner>
      )}
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          className="w-[26rem] shrink-0 overflow-auto rounded border border-border bg-panel"
          aria-label="Differences"
          role="region"
        >
          {groups.map((group) => (
            <section key={group.objectKind} aria-label={group.label}>
              <h3 className="sticky top-0 flex items-center gap-1.5 border-b border-border bg-panel-2 px-2 py-1 text-xs font-semibold">
                <span className="flex-1">
                  {group.label} ({group.operations.length})
                </span>
                {(['create', 'alter', 'drop', 'rename'] as const).map((kind) =>
                  group.counts[kind] > 0 ? (
                    <KindBadge key={kind} kind={kind} count={group.counts[kind]} />
                  ) : null,
                )}
              </h3>
              <ul>
                {group.operations.map((op) => (
                  <OperationRow
                    key={op.id}
                    op={op}
                    checked={selected.has(op.id)}
                    focused={state.focused === op.id}
                    disabled={busy}
                    onCheck={(checked) => model.toggle(op.id, checked)}
                    onFocus={() => model.focus(op.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col rounded border border-border bg-panel">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1" role="tablist">
            {(['definitions', 'script'] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                className={cx(
                  'rounded px-2 py-0.5 text-xs',
                  tab === name ? 'bg-badge text-fg' : 'text-muted hover:bg-hover',
                )}
                onClick={() => setTab(name)}
              >
                {name === 'definitions' ? 'Source and target' : 'Script'}
              </button>
            ))}
            {tab === 'script' && !model.scriptCurrent() && (
              <span className="ml-2 text-[11px] text-muted">Updating the script…</span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2" role="tabpanel">
            {tab === 'definitions' ? (
              focused ? (
                <SideBySide
                  op={focused}
                  source={`${result.source.profileName} (${result.source.database})`}
                  target={`${result.target.profileName} (${result.target.database})`}
                />
              ) : (
                <p className="text-xs text-muted">Choose a difference to see both definitions.</p>
              )
            ) : (
              <pre
                data-testid="sync-script"
                className="font-mono text-xs whitespace-pre-wrap select-text"
              >
                {state.script?.text ?? ''}
              </pre>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Exports model={model} disabled={busy} />
        <span className="flex-1" />
        {destructiveTicked > 0 && (
          <span className="text-xs text-danger">
            {destructiveTicked} destructive {destructiveTicked === 1 ? 'operation' : 'operations'}{' '}
            ticked
          </span>
        )}
        <Button
          variant="primary"
          onClick={props.onApply}
          disabled={busy || state.selected.length === 0}
        >
          Apply…
        </Button>
      </div>
    </section>
  );
}

function Exports(props: {
  readonly model: StructureCompare;
  readonly disabled: boolean;
  readonly empty?: boolean;
}) {
  return (
    <span className="flex items-center gap-1">
      {!props.empty && (
        <Button size="sm" onClick={() => void props.model.export('sql')} disabled={props.disabled}>
          Export script…
        </Button>
      )}
      <Button size="sm" onClick={() => void props.model.export('html')} disabled={props.disabled}>
        Export report…
      </Button>
    </span>
  );
}

function OperationRow(props: {
  readonly op: SyncOperationInfo;
  readonly checked: boolean;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly onFocus: () => void;
}) {
  const { op } = props;
  return (
    <li
      aria-current={props.focused ? 'true' : undefined}
      data-testid="sync-operation"
      data-operation-id={op.id}
      className={cx(
        'flex items-start gap-1.5 border-b border-border/50 px-2 py-1 text-xs',
        props.focused ? 'bg-hover' : 'hover:bg-hover',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        aria-label={`Apply ${op.kind} ${op.objectKind.replace(/-/g, ' ')} ${op.qualifiedName}`}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onCheck(event.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <KindBadge kind={op.kind} />
          <button
            type="button"
            className="min-w-0 truncate text-left font-mono"
            onClick={props.onFocus}
          >
            {op.qualifiedName}
          </button>
          {op.destructive && <span className="text-[10px] text-danger">destructive</span>}
        </span>
        {op.changes.length > 0 && (
          <span className="block truncate text-[11px] text-muted" title={op.changes.join('\n')}>
            {op.changes.join('; ')}
          </span>
        )}
        {op.warnings
          .filter((w) => w.code !== 'rebuild')
          .map((warning, index) => (
            <span key={index} className="block text-[11px] text-warning">
              {warning.message}
            </span>
          ))}
      </span>
    </li>
  );
}

function SideBySide(props: {
  readonly op: SyncOperationInfo;
  readonly source: string;
  readonly target: string;
}) {
  const { op } = props;
  const pane = (title: string, ddl: string | undefined, testId: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <h3 className="text-[11px] font-semibold text-muted">{title}</h3>
      <pre
        data-testid={testId}
        className="min-h-24 flex-1 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
      >
        {ddl ?? <span className="text-muted">(absent)</span>}
      </pre>
    </div>
  );
  return (
    <div className="flex h-full flex-col gap-2">
      <p className="text-xs">
        <KindBadge kind={op.kind} /> <span className="font-mono">{op.qualifiedName}</span>
        {op.reason && <span className="ml-2 text-muted">{op.reason}</span>}
      </p>
      <div className="flex min-h-0 flex-1 gap-2">
        {pane(`Source · ${props.source}`, op.sourceDdl, 'source-ddl')}
        {pane(`Target · ${props.target}`, op.targetDdl, 'target-ddl')}
      </div>
      {op.statements.length > 0 && (
        <div>
          <h3 className="text-[11px] font-semibold text-muted">Statements</h3>
          <pre className="rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text">
            {op.statements.map((s) => `${s};`).join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
}
