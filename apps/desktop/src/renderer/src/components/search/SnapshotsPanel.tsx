import { useState } from 'react';

import { formatDuration } from '../../lib/format';
import { repositoryBody, type SnapshotsView } from '../../state/search/snapshots';
import { useSearchView } from '../../state/search/view';
import { Button, Field, Input, Modal, Select, cx } from '../ui';
import { NoticeBar, Toolbar } from './parts';

/**
 * Snapshot repositories and snapshots (spec §11): register (a shared file system path the
 * nodes allow in `path.repo`, or a read-only URL), verify and unregister repositories; create a
 * snapshot of chosen indices, restore one under new names (a rename pattern), and delete one.
 */

export function SnapshotsPanel({ view }: { readonly view: SnapshotsView }) {
  const repositories = useSearchView(view, (s) => s.repositories);
  const repository = useSearchView(view, (s) => s.repository);
  const loading = useSearchView(view, (s) => s.loading || s.loadingSnapshots);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  const [dialog, setDialog] = useState<'repository' | 'snapshot' | undefined>(undefined);
  const [restore, setRestore] = useState<string | undefined>(undefined);
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-snapshots">
      <Toolbar label="Snapshots" onRefresh={() => void view.reload()} loading={loading}>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly}
          onClick={() => setDialog('repository')}
        >
          Register repository…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || repository === undefined}
          onClick={() => setDialog('snapshot')}
        >
          New snapshot…
        </Button>
      </Toolbar>
      <NoticeBar view={view} />
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Repositories"
          className="flex w-72 shrink-0 flex-col border-r border-border"
        >
          <p className="border-b border-border bg-panel px-2 py-1 text-[11px] text-muted">
            Repositories
          </p>
          <ul className="min-h-0 flex-1 overflow-auto text-xs" data-testid="snapshot-repositories">
            {repositories.length === 0 && (
              <li className="p-2 text-muted">
                No repositories. Register one: a file system repository needs its path in the
                nodes&rsquo; path.repo setting.
              </li>
            )}
            {repositories.map((repo) => (
              <li
                key={repo.name}
                className={cx(
                  'border-b border-border/60',
                  repo.name === repository && 'bg-accent/10',
                )}
              >
                <button
                  type="button"
                  className="block w-full px-2 py-1 text-left hover:bg-hover"
                  onClick={() => void view.selectRepository(repo.name)}
                >
                  <span className="block font-mono">{repo.name}</span>
                  {repo.summary.map((fact) => (
                    <span key={fact.label} className="block truncate text-[11px] text-muted">
                      {fact.label}: {fact.value}
                    </span>
                  ))}
                </button>
                {repo.name === repository && (
                  <div className="flex gap-1 px-2 pb-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readOnly}
                      onClick={() => void view.verifyRepository(repo.name)}
                    >
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      disabled={readOnly}
                      onClick={() => void view.deleteRepository(repo.name)}
                    >
                      Unregister…
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Snapshots" className="min-w-0 flex-1 overflow-auto">
          <SnapshotList view={view} onRestore={setRestore} />
        </section>
      </div>
      {dialog === 'repository' && (
        <RepositoryDialog view={view} onClose={() => setDialog(undefined)} />
      )}
      {dialog === 'snapshot' && <SnapshotDialog view={view} onClose={() => setDialog(undefined)} />}
      {restore !== undefined && (
        <RestoreDialog view={view} snapshot={restore} onClose={() => setRestore(undefined)} />
      )}
    </div>
  );
}

function SnapshotList(props: {
  readonly view: SnapshotsView;
  readonly onRestore: (name: string) => void;
}) {
  const { view } = props;
  const snapshots = useSearchView(view, (s) => s.snapshots);
  const repository = useSearchView(view, (s) => s.repository);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  if (repository === undefined) return <p className="p-4 text-xs text-muted">Pick a repository.</p>;
  return (
    <table className="w-full border-collapse text-xs" data-testid="snapshot-list">
      <thead className="sticky top-0 bg-panel">
        <tr className="text-left text-muted">
          <th className="px-2 py-1">Snapshot</th>
          <th className="px-2 py-1">State</th>
          <th className="px-2 py-1">Indices</th>
          <th className="px-2 py-1">Started</th>
          <th className="px-2 py-1">Took</th>
          <th className="px-2 py-1">Shards</th>
          <th className="px-2 py-1" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {snapshots.length === 0 && (
          <tr>
            <td colSpan={7} className="px-2 py-2 text-muted">
              No snapshots in {repository}.
            </td>
          </tr>
        )}
        {snapshots.map((snapshot) => (
          <tr
            key={snapshot.snapshot}
            className="border-t border-border"
            data-snapshot={snapshot.snapshot}
          >
            <td className="px-2 py-1 font-mono">{snapshot.snapshot}</td>
            <td
              className={cx(
                'px-2 py-1',
                snapshot.state === 'SUCCESS' && 'text-success',
                (snapshot.state === 'FAILED' || snapshot.state === 'PARTIAL') && 'text-danger',
                snapshot.state === 'IN_PROGRESS' && 'text-warning',
              )}
            >
              {snapshot.state.toLowerCase().replace('_', ' ')}
            </td>
            <td
              className="max-w-80 truncate px-2 py-1 font-mono"
              title={snapshot.indices.join(', ')}
            >
              {snapshot.indices.join(', ')}
            </td>
            <td className="px-2 py-1">
              {snapshot.startedAt?.replace('T', ' ').slice(0, 19) ?? '—'}
            </td>
            <td className="px-2 py-1">
              {snapshot.durationMs === undefined ? '—' : formatDuration(snapshot.durationMs)}
            </td>
            <td className="px-2 py-1">
              {snapshot.shardsTotal - snapshot.shardsFailed}/{snapshot.shardsTotal}
            </td>
            <td className="px-2 py-1 text-right whitespace-nowrap">
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || snapshot.state === 'IN_PROGRESS'}
                onClick={() => props.onRestore(snapshot.snapshot)}
              >
                Restore…
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                disabled={readOnly}
                onClick={() => void view.deleteSnapshot(snapshot.snapshot)}
              >
                Delete…
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RepositoryDialog(props: { readonly view: SnapshotsView; readonly onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'fs' | 'url'>('fs');
  const [location, setLocation] = useState('');
  const [readonly, setReadonly] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Register a snapshot repository"
      description="A shared file system repository must be under a path every node lists in path.repo."
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === '' || location.trim() === ''}
            onClick={() =>
              void props.view
                .createRepository(name.trim(), repositoryBody(type, location.trim(), readonly))
                .then((ok) => ok && props.onClose())
            }
          >
            Register…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="repo-name">
          <Input
            id="repo-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="Type" htmlFor="repo-type">
          <Select
            id="repo-type"
            value={type}
            onChange={(e) => setType(e.target.value as 'fs' | 'url')}
          >
            <option value="fs">Shared file system (fs)</option>
            <option value="url">Read-only URL (url)</option>
          </Select>
        </Field>
        <Field
          label={type === 'fs' ? 'Location (a path under path.repo)' : 'URL'}
          htmlFor="repo-location"
        >
          <Input
            id="repo-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="font-mono"
          />
        </Field>
        {type === 'fs' && (
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={readonly}
              onChange={(e) => setReadonly(e.target.checked)}
            />
            Read-only (another cluster writes to it)
          </label>
        )}
      </div>
    </Modal>
  );
}

function SnapshotDialog(props: { readonly view: SnapshotsView; readonly onClose: () => void }) {
  const indexNames = useSearchView(props.view, (s) => s.indexNames);
  const [name, setName] = useState(`snapshot-${new Date().toISOString().slice(0, 10)}`);
  const [indices, setIndices] = useState('');
  const [global, setGlobal] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="New snapshot"
      description="It runs on the server; the list shows its progress."
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === ''}
            onClick={() =>
              void props.view
                .createSnapshot({
                  name: name.trim(),
                  indices: indices
                    .split(',')
                    .map((i) => i.trim())
                    .filter((i) => i !== ''),
                  includeGlobalState: global,
                })
                .then((ok) => ok && props.onClose())
            }
          >
            Create…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name (lower case)" htmlFor="snapshot-name">
          <Input
            id="snapshot-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field
          label="Indices (comma-separated, patterns allowed; empty for all)"
          htmlFor="snapshot-indices"
        >
          <Input
            id="snapshot-indices"
            value={indices}
            onChange={(e) => setIndices(e.target.value)}
            className="font-mono"
            list="snapshot-index-names"
          />
        </Field>
        <datalist id="snapshot-index-names">
          {indexNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} />
          Include the cluster state (templates, pipelines, persistent settings)
        </label>
      </div>
    </Modal>
  );
}

function RestoreDialog(props: {
  readonly view: SnapshotsView;
  readonly snapshot: string;
  readonly onClose: () => void;
}) {
  const snapshots = useSearchView(props.view, (s) => s.snapshots);
  const snapshot = snapshots.find((s) => s.snapshot === props.snapshot);
  const all = snapshot?.indices ?? [];
  const [indices, setIndices] = useState(all.filter((i) => !i.startsWith('.')).join(', '));
  const [pattern, setPattern] = useState('(.+)');
  const [replacement, setReplacement] = useState('restored-$1');
  const [aliases, setAliases] = useState(false);
  const chosen = indices
    .split(',')
    .map((i) => i.trim())
    .filter((i) => i !== '');
  const options = {
    indices: chosen,
    ...(pattern !== '' ? { renamePattern: pattern, renameReplacement: replacement } : {}),
    includeAliases: aliases,
  };
  const preview = props.view.preview(chosen, options);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={`Restore ${props.snapshot}`}
      description="Restored indices must not clash with open ones: rename them, or close or delete the originals first."
      width="w-[640px]"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={preview === undefined || chosen.length === 0}
            onClick={() =>
              void props.view
                .restoreSnapshot(props.snapshot, options)
                .then((ok) => ok && props.onClose())
            }
          >
            Restore…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Indices (comma-separated)"
          htmlFor="restore-indices"
          hint={`In the snapshot: ${all.join(', ')}`}
        >
          <Input
            id="restore-indices"
            value={indices}
            onChange={(e) => setIndices(e.target.value)}
            className="font-mono"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Rename pattern (regular expression; empty keeps names)"
            htmlFor="restore-pattern"
          >
            <Input
              id="restore-pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Replacement ($1 for the first group)" htmlFor="restore-replacement">
            <Input
              id="restore-replacement"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={aliases} onChange={(e) => setAliases(e.target.checked)} />
          Restore their aliases too
        </label>
        <div className="rounded bg-panel-2 p-2 text-xs" data-testid="restore-preview">
          {preview === undefined ? (
            <span className="text-danger">
              The rename pattern is not a valid regular expression.
            </span>
          ) : (
            chosen.map((index, i) => (
              <p key={index} className="font-mono">
                {index} → {preview[i]}
              </p>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
