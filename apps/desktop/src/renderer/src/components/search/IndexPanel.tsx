import { indexNameProblem } from '@joinery/search-tools';
import { useState } from 'react';

import { formatCount, formatDuration } from '../../lib/format';
import type { IndexAction, IndexTab, IndexView } from '../../state/search/index-view';
import { taskProgress } from '../../state/search/reindex-run';
import { useSearchView } from '../../state/search/view';
import { useTheme } from '../theme';
import { Button, Field, Input, Modal, Select, cx } from '../ui';
import { JsonEditor } from './JsonEditor';
import { openSearchConsole, openSearchTool } from './open';
import { Facts, NoticeBar, Tabs, Toolbar, formatBytes } from './parts';
import { HealthBadge } from './SearchTree';

/**
 * One index (spec §11): an overview with its health, documents, size and shards and the index
 * operations (open, close, refresh, flush, force merge, clone, shrink, delete); the mapping
 * editor, which applies new fields in place and offers a reindex plan for changes to existing
 * ones (run as a server task with live progress and cancel); the settings; and its aliases.
 */

const TABS: readonly { id: IndexTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'mappings', label: 'Mappings' },
  { id: 'settings', label: 'Settings' },
  { id: 'aliases', label: 'Aliases' },
];

export function IndexPanel({ view }: { readonly view: IndexView }) {
  const tab = useSearchView(view, (s) => s.tab);
  const loading = useSearchView(view, (s) => s.loading);
  const run = useSearchView(view, (s) => s.run);
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-index">
      <Tabs
        tabs={TABS}
        active={tab}
        onSelect={(id) => view.setTab(id)}
        label={`Index ${view.index}`}
        end={
          <span className="pb-1 text-[11px] text-muted">{loading ? 'Loading…' : view.index}</span>
        }
      />
      <NoticeBar view={view} />
      {run && <ReindexProgress view={view} />}
      <div className="min-h-0 flex-1">
        {tab === 'overview' && <Overview view={view} />}
        {tab === 'mappings' && <Mappings view={view} />}
        {tab === 'settings' && <Settings view={view} />}
        {tab === 'aliases' && <Aliases view={view} />}
      </div>
      <ReindexDialog view={view} />
    </div>
  );
}

function Overview({ view }: { readonly view: IndexView }) {
  const summary = useSearchView(view, (s) => s.summary);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  const info = useSearchView(view, (s) => s.info);
  const [resize, setResize] = useState<'clone' | 'shrink' | undefined>(undefined);
  const closed = summary?.status === 'close';
  const action = (name: IndexAction): void => void view.act(name);
  return (
    <div className="flex h-full flex-col overflow-auto">
      <Toolbar label="Index operations" onRefresh={() => void view.reload()}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            openSearchTool({
              tool: 'documents',
              target: { profileId: view.profileId, target: view.index, kind: 'index' },
            })
          }
        >
          Browse documents
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        {closed ? (
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => action('open')}>
            Open
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => action('close')}>
            Close…
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || closed}
          onClick={() => action('refresh')}
        >
          Refresh index
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || closed}
          onClick={() => action('flush')}
        >
          Flush
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || closed}
          onClick={() => action('forceMerge')}
        >
          Force merge…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || closed || info?.capabilities.cloneIndex === false}
          title={
            info?.capabilities.cloneIndex === false
              ? 'This cluster cannot clone indices'
              : undefined
          }
          onClick={() => setResize('clone')}
        >
          Clone…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || closed}
          onClick={() => setResize('shrink')}
        >
          Shrink…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || closed}
          onClick={() => view.openReindex()}
        >
          Reindex…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          disabled={readOnly}
          onClick={() => action('delete')}
        >
          Delete…
        </Button>
      </Toolbar>
      <div className="p-4">
        {summary ? (
          <Facts
            testId="index-facts"
            items={[
              [
                'Health',
                <span key="health" className="flex items-center gap-1.5">
                  <HealthBadge health={closed ? 'closed' : (summary.health ?? 'red')} />
                  {closed ? 'closed' : (summary.health ?? 'unknown')}
                </span>,
              ],
              ['Status', summary.status === 'close' ? 'closed' : 'open'],
              ['Documents', summary.docsCount === null ? '—' : formatCount(summary.docsCount)],
              [
                'Deleted documents',
                summary.docsDeleted === null ? '—' : formatCount(summary.docsDeleted),
              ],
              ['Size', summary.storeSizeBytes === null ? '—' : formatBytes(summary.storeSizeBytes)],
              [
                'Primary size',
                summary.primaryStoreSizeBytes === null
                  ? '—'
                  : formatBytes(summary.primaryStoreSizeBytes),
              ],
              ['Shards', `${summary.primaries} primary × ${summary.replicas + 1} copies`],
              ['Created', summary.createdAt ?? '—'],
              ['UUID', summary.uuid ?? '—'],
            ]}
          />
        ) : (
          <p className="text-xs text-muted">Loading…</p>
        )}
      </div>
      {resize && (
        <ResizeDialog
          view={view}
          kind={resize}
          primaries={summary?.primaries ?? 1}
          onClose={() => setResize(undefined)}
        />
      )}
    </div>
  );
}

/** Shard counts a shrink can go to: the factors of the current count, below it. */
function shrinkTargets(primaries: number): number[] {
  const out: number[] = [];
  for (let n = 1; n < primaries; n++) if (primaries % n === 0) out.push(n);
  return out;
}

function ResizeDialog(props: {
  readonly view: IndexView;
  readonly kind: 'clone' | 'shrink';
  readonly primaries: number;
  readonly onClose: () => void;
}) {
  const { view, kind } = props;
  const names = useSearchView(view, (s) => s.indexNames);
  const [target, setTarget] = useState(`${view.index}-${kind === 'clone' ? 'copy' : 'shrunk'}`);
  const targets = shrinkTargets(props.primaries);
  const [shards, setShards] = useState(targets.at(-1) ?? 1);
  const [unblock, setUnblock] = useState(true);
  const problem =
    indexNameProblem(target) ?? (names.includes(target) ? `${target} exists already` : undefined);
  const impossible = kind === 'shrink' && targets.length === 0;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={kind === 'clone' ? `Clone ${view.index}` : `Shrink ${view.index}`}
      description={
        kind === 'clone'
          ? 'A new index with the same shards, settings and documents. Writes to the source are blocked while it is copied.'
          : 'A new index with fewer primary shards. Writes to the source are blocked while it is copied, and every primary must sit on one node.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={problem !== undefined || impossible}
            onClick={() => {
              void view
                .resize({
                  kind,
                  target,
                  ...(kind === 'shrink' ? { shards } : {}),
                  unblockSource: unblock,
                })
                .then((ok) => ok && props.onClose());
            }}
          >
            {kind === 'clone' ? 'Clone…' : 'Shrink…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="New index" htmlFor="resize-target" error={problem}>
          <Input
            id="resize-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="font-mono"
          />
        </Field>
        {kind === 'shrink' &&
          (impossible ? (
            <p className="text-xs text-warning">An index with one primary shard cannot shrink.</p>
          ) : (
            <Field
              label="Primary shards"
              htmlFor="resize-shards"
              hint={`A factor of the current ${props.primaries}`}
            >
              <Select
                id="resize-shards"
                value={String(shards)}
                onChange={(e) => setShards(Number(e.target.value))}
              >
                {targets.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={unblock} onChange={(e) => setUnblock(e.target.checked)} />
          Allow writes to {view.index} again afterwards
        </label>
      </div>
    </Modal>
  );
}

function Mappings({ view }: { readonly view: IndexView }) {
  const theme = useTheme();
  const fields = useSearchView(view, (s) => s.fields);
  const proposed = useSearchView(view, (s) => s.proposedText);
  const plan = useSearchView(view, (s) => s.plan);
  const planError = useSearchView(view, (s) => s.planError);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Fields" className="flex w-72 shrink-0 flex-col border-r border-border">
        <p className="border-b border-border bg-panel px-2 py-1 text-[11px] text-muted">
          {formatCount(fields.length)} fields
        </p>
        <ul className="min-h-0 flex-1 overflow-auto font-mono text-xs" data-testid="mapping-fields">
          {fields.map((field) => (
            <li
              key={field.path}
              className={cx(
                'flex justify-between gap-2 border-b border-border/50 px-2 py-0.5',
                field.multiField && 'text-muted',
              )}
              title={field.definition}
            >
              <span className="truncate">{field.path}</span>
              <span className="shrink-0 text-accent">{field.type}</span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Mapping editor" className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border bg-panel px-3 py-1.5 text-[11px] text-muted">
          New fields and multi-fields, and a few parameters (ignore_above, search_analyzer, meta…),
          can be added to an existing index. A field&rsquo;s type and most of its parameters cannot
          change: for those, the data moves to a new index with the mapping (a reindex), and the
          aliases move to it in one step.
        </div>
        <Toolbar label="Mapping">
          <Button size="sm" variant="ghost" onClick={() => view.check()}>
            Check changes
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={readOnly}
            onClick={() => void view.applyMapping()}
          >
            Apply in place
          </Button>
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => view.openReindex()}>
            Reindex with this mapping…
          </Button>
        </Toolbar>
        <div className="min-h-0 flex-1">
          <JsonEditor
            value={proposed}
            onChange={(text) => view.setProposed(text)}
            theme={theme}
            ariaLabel="Proposed mapping"
            testId="mapping-editor"
          />
        </div>
        {(plan || planError) && (
          <div
            className="max-h-48 overflow-auto border-t border-border p-2 text-xs"
            data-testid="mapping-plan"
            aria-live="polite"
          >
            {planError && <p className="text-danger">{planError}</p>}
            {plan && plan.changes.length === 0 && <p className="text-muted">No changes.</p>}
            {plan && plan.changes.length > 0 && (
              <>
                <p
                  className={cx(
                    'mb-1 font-semibold',
                    plan.inPlace ? 'text-success' : 'text-warning',
                  )}
                >
                  {plan.inPlace
                    ? 'These changes apply in place.'
                    : 'Existing field mappings cannot change: this needs a reindex into a new index.'}
                </p>
                <ul>
                  {plan.changes.map((change) => (
                    <li key={`${change.path}-${change.reason}`} className="flex gap-2">
                      <span
                        className={cx(
                          'w-16 shrink-0',
                          change.kind === 'added' || change.kind === 'updated'
                            ? 'text-success'
                            : 'text-warning',
                        )}
                      >
                        {change.kind}
                      </span>
                      <span className="font-mono">{change.path}</span>
                      <span className="text-muted">{change.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ReindexDialog({ view }: { readonly view: IndexView }) {
  const reindex = useSearchView(view, (s) => s.reindex);
  const aliases = useSearchView(view, (s) => s.aliases);
  if (!reindex) return null;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && view.closeReindex()}
      title={`Reindex ${view.index}`}
      description="A new index with the mapping, the documents copied by a server task, then clients pointed at it."
      width="w-[760px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => view.closeReindex()}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={!reindex.plan}
            onClick={() => {
              if (!reindex.plan) return;
              openSearchConsole({
                profileId: view.profileId,
                title: `${view.index} reindex`,
                text: reindex.plan.consoleText,
              });
              view.closeReindex();
            }}
          >
            Open in console
          </Button>
          <Button
            variant="primary"
            disabled={!reindex.plan}
            onClick={() => void view.runReindex()}
            data-testid="reindex-run"
          >
            Run the plan…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="New index" htmlFor="reindex-target" error={reindex.error}>
          <Input
            id="reindex-target"
            value={reindex.target}
            onChange={(e) => view.setReindexTarget(e.target.value)}
            className="font-mono"
          />
        </Field>
        <fieldset className="flex flex-col gap-1 text-xs">
          <legend className="mb-1 font-medium text-muted">Afterwards</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cutover"
              checked={reindex.cutover === 'aliases'}
              disabled={aliases.length === 0}
              onChange={() => view.setReindexCutover('aliases')}
            />
            Move{' '}
            {aliases.length > 0
              ? aliases.map((a) => a.alias).join(', ')
              : 'its aliases (it has none)'}{' '}
            to the new index in one step
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cutover"
              checked={reindex.cutover === 'replace'}
              onChange={() => view.setReindexCutover('replace')}
            />
            Delete {view.index} and give its name to the new index as an alias (clients keep the
            name)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="cutover"
              checked={reindex.cutover === 'none'}
              onChange={() => view.setReindexCutover('none')}
            />
            Leave {view.index} as it is
          </label>
        </fieldset>
        {reindex.plan && (
          <ol className="flex flex-col gap-1 text-xs" data-testid="reindex-plan">
            {reindex.plan.steps.map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted">{i + 1}.</span>
                <span className={cx(step.destructive && 'text-danger')}>{step.title}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

function ReindexProgress({ view }: { readonly view: IndexView }) {
  const run = useSearchView(view, (s) => s.run);
  if (!run) return null;
  const share = taskProgress(run.task);
  const progress = run.task?.progress;
  const stepTitle = run.plan.steps[Math.min(run.step, run.plan.steps.length - 1)]?.title ?? '';
  return (
    <div
      className="border-b border-border bg-panel-2 px-3 py-2 text-xs"
      data-testid="reindex-progress"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold">
          {run.status === 'running'
            ? `Step ${run.step + 1} of ${run.plan.steps.length}: ${stepTitle}`
            : run.status === 'done'
              ? 'Reindex finished'
              : run.status === 'cancelled'
                ? 'Reindex cancelled'
                : 'Reindex failed'}
        </span>
        {run.taskId && <span className="font-mono text-muted">task {run.taskId}</span>}
        <span className="flex-1" />
        {run.status === 'running' && run.taskId && !run.task?.completed && (
          <Button size="sm" variant="danger" onClick={() => void view.cancelReindex()}>
            Cancel
          </Button>
        )}
        {run.status !== 'running' && (
          <Button size="sm" variant="ghost" onClick={() => view.dismissRun()}>
            Dismiss
          </Button>
        )}
      </div>
      {progress && (
        <div className="mt-1 flex items-center gap-2">
          <div
            className="h-1.5 flex-1 rounded bg-bg"
            role="progressbar"
            aria-label="Documents copied"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share === undefined ? undefined : Math.round(share * 100)}
          >
            <div
              className="h-1.5 rounded bg-accent"
              style={{ width: `${Math.round((share ?? 0) * 100)}%` }}
            />
          </div>
          <span data-testid="reindex-counts">
            {formatCount(progress.created + progress.updated)} of {formatCount(progress.total)}{' '}
            copied
            {progress.versionConflicts > 0
              ? ` · ${formatCount(progress.versionConflicts)} conflicts`
              : ''}
            {run.task?.runningTimeMs !== undefined
              ? ` · ${formatDuration(run.task.runningTimeMs)}`
              : ''}
          </span>
        </div>
      )}
      {run.error && <p className="mt-1 text-danger">{run.error}</p>}
    </div>
  );
}

function Settings({ view }: { readonly view: IndexView }) {
  const theme = useTheme();
  const settings = useSearchView(view, (s) => s.settingsText);
  const draft = useSearchView(view, (s) => s.settingsDraft);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="Current settings"
        className="flex min-w-0 flex-1 flex-col border-r border-border"
      >
        <p className="border-b border-border bg-panel px-2 py-1 text-[11px] text-muted">
          Current settings
        </p>
        <div className="min-h-0 flex-1">
          <JsonEditor value={settings ?? ''} theme={theme} readOnly ariaLabel="Current settings" />
        </div>
      </section>
      <section aria-label="Change settings" className="flex min-w-0 flex-1 flex-col">
        <Toolbar label="Change settings">
          <span className="text-[11px] text-muted">
            Dynamic settings only (replicas, refresh interval, blocks…)
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            disabled={readOnly}
            onClick={() => void view.putSettings(draft)}
          >
            Apply…
          </Button>
        </Toolbar>
        <div className="min-h-0 flex-1">
          <JsonEditor
            value={draft}
            onChange={(text) => view.setSettingsDraft(text)}
            theme={theme}
            ariaLabel="Settings to change"
          />
        </div>
      </section>
    </div>
  );
}

function Aliases({ view }: { readonly view: IndexView }) {
  const aliases = useSearchView(view, (s) => s.aliases);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  const [alias, setAlias] = useState('');
  const [writeIndex, setWriteIndex] = useState(false);
  const problem = alias === '' ? undefined : indexNameProblem(alias)?.replace(/index/gi, 'alias');
  return (
    <div className="flex h-full flex-col overflow-auto p-3">
      <table className="w-full max-w-2xl border-collapse text-xs" data-testid="index-aliases">
        <thead>
          <tr className="text-left text-muted">
            <th className="px-2 py-1">Alias</th>
            <th className="px-2 py-1">Write index</th>
            <th className="px-2 py-1">Filtered</th>
            <th className="px-2 py-1" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {aliases.length === 0 && (
            <tr>
              <td colSpan={4} className="px-2 py-1 text-muted">
                No aliases point at {view.index}.
              </td>
            </tr>
          )}
          {aliases.map((a) => (
            <tr key={a.alias} className="border-t border-border">
              <td className="px-2 py-1 font-mono">{a.alias}</td>
              <td className="px-2 py-1">
                {a.isWriteIndex === null ? '—' : a.isWriteIndex ? 'yes' : 'no'}
              </td>
              <td className="px-2 py-1">{a.filtered ? 'yes' : 'no'}</td>
              <td className="px-2 py-1 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={readOnly}
                  onClick={() => void view.removeAlias(a.alias)}
                >
                  Remove…
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="mt-4 flex max-w-2xl items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (alias !== '' && !problem)
            void view.addAlias(alias, writeIndex).then(() => setAlias(''));
        }}
      >
        <Field label="Add an alias" htmlFor="index-alias" error={problem} className="flex-1">
          <Input
            id="index-alias"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            className="font-mono"
          />
        </Field>
        <label className="mb-2 flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={writeIndex}
            onChange={(e) => setWriteIndex(e.target.checked)}
          />
          Write index
        </label>
        <Button type="submit" disabled={readOnly || alias === '' || problem !== undefined}>
          Add…
        </Button>
      </form>
      <p className="mt-3 max-w-2xl text-[11px] text-muted">
        To move an alias here from other indices in one atomic step, use Swap in Templates and
        pipelines › Aliases; a reindex plan moves this index&rsquo;s aliases to the new index for
        you.
      </p>
    </div>
  );
}
