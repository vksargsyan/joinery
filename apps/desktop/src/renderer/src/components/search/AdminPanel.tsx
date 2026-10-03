import { formatJson } from '@querybara/search-tools';
import { useMemo, useState } from 'react';

import { RESOURCE_LABELS, type AdminTab, type AdminView } from '../../state/search/admin';
import { useSearchView } from '../../state/search/view';
import { useTheme } from '../theme';
import { Button, Field, Input, Select, cx } from '../ui';
import { JsonEditor } from './JsonEditor';
import { NoticeBar, Tabs, Toolbar } from './parts';

/**
 * Templates, lifecycle policies, pipelines and aliases (spec §11): one tab each, shown only
 * where the cluster has the feature (ILM outside the OSS distribution, composable templates
 * from Elasticsearch 7.8). Resources are edited as the JSON their PUT takes; an
 * ingest pipeline's edit can be simulated on sample documents before it is saved.
 */

function tabLabel(tab: AdminTab): string {
  if (tab === 'aliases') return 'Aliases';
  if (tab === 'lifecycle-policy') return 'ILM policies';
  return RESOURCE_LABELS[tab].many;
}

export function AdminPanel({ view }: { readonly view: AdminView }) {
  const tab = useSearchView(view, (s) => s.tab);
  const loading = useSearchView(view, (s) => s.loading);
  // Re-render when the capability flags arrive.
  useSearchView(view, (s) => s.info);
  const tabs = view.tabs.map((id) => ({ id, label: tabLabel(id) }));
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-admin">
      <Tabs
        tabs={tabs}
        active={tab}
        onSelect={(id) => void view.setTab(id)}
        label="Templates and pipelines"
      />
      <Toolbar label="Resources" onRefresh={() => void view.reload()} loading={loading} />
      <NoticeBar view={view} />
      <div className="min-h-0 flex-1">
        {tab === 'aliases' ? <Aliases view={view} /> : <Resources view={view} />}
      </div>
    </div>
  );
}

function Resources({ view }: { readonly view: AdminView }) {
  const theme = useTheme();
  const tab = useSearchView(view, (s) => s.tab);
  const resources = useSearchView(view, (s) => s.resources);
  const selected = useSearchView(view, (s) => s.selected);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  if (tab === 'aliases') return null;
  const label = RESOURCE_LABELS[tab];
  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label={label.many}
        className="flex w-80 shrink-0 flex-col border-r border-border"
      >
        <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-1">
          <span className="text-[11px] text-muted">
            {resources.length} {label.many.toLowerCase()}
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => view.startNew()}>
            New
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-auto text-xs" data-testid="admin-resources">
          {resources.map((resource) => (
            <li key={resource.name}>
              <button
                type="button"
                className={cx(
                  'block w-full border-b border-border/60 px-2 py-1 text-left hover:bg-hover',
                  selected?.name === resource.name && !selected.isNew && 'bg-accent/10',
                )}
                onClick={() => view.select(resource.name)}
              >
                <span className="block truncate font-mono">{resource.name}</span>
                {resource.summary.map((fact) => (
                  <span key={fact.label} className="block truncate text-[11px] text-muted">
                    {fact.label}: {fact.value}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={`${label.one} editor`} className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <p className="p-4 text-xs text-muted">Pick a {label.one}, or create a new one.</p>
        ) : (
          <>
            <div className="flex items-end gap-2 border-b border-border bg-panel px-2 py-1.5">
              {selected.isNew ? (
                <Field label="Name" htmlFor="resource-name" className="w-72">
                  <Input
                    id="resource-name"
                    value={selected.name}
                    onChange={(e) => view.setName(e.target.value)}
                    className="font-mono"
                  />
                </Field>
              ) : (
                <span className="py-1 font-mono text-sm">{selected.name}</span>
              )}
              <span className="flex-1" />
              <Button
                size="sm"
                variant="primary"
                disabled={readOnly}
                onClick={() => void view.save()}
              >
                Save…
              </Button>
              {!selected.isNew && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={readOnly}
                  onClick={() => void view.remove(selected.name)}
                >
                  Delete…
                </Button>
              )}
            </div>
            <div className={cx('min-h-0', tab === 'ingest-pipeline' ? 'h-1/2' : 'flex-1')}>
              <JsonEditor
                value={selected.text}
                onChange={(text) => view.setText(text)}
                theme={theme}
                ariaLabel={`${label.one} definition`}
                testId="resource-editor"
                onRun={() => void view.save()}
              />
            </div>
            {tab === 'ingest-pipeline' && <Simulator view={view} />}
          </>
        )}
      </section>
    </div>
  );
}

function Simulator({ view }: { readonly view: AdminView }) {
  const theme = useTheme();
  const docs = useSearchView(view, (s) => s.simulateDocs);
  const simulating = useSearchView(view, (s) => s.simulating);
  const simulation = useSearchView(view, (s) => s.simulation);
  const error = useSearchView(view, (s) => s.simulateError);
  return (
    <div className="flex min-h-0 flex-1 border-t border-border" data-testid="pipeline-simulator">
      <section
        aria-label="Sample documents"
        className="flex min-w-0 flex-1 flex-col border-r border-border"
      >
        <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-[11px] text-muted">
          Sample documents (a JSON array of sources)
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            disabled={simulating}
            onClick={() => void view.simulate()}
          >
            {simulating ? 'Simulating…' : 'Simulate'}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <JsonEditor
            value={docs}
            onChange={(text) => view.setSimulateDocs(text)}
            theme={theme}
            ariaLabel="Sample documents"
            onRun={() => void view.simulate()}
          />
        </div>
      </section>
      <section
        aria-label="Simulation"
        className="min-w-0 flex-1 overflow-auto p-2 text-xs"
        data-testid="pipeline-results"
      >
        {error && <p className="text-danger">{error}</p>}
        {!error && !simulation && (
          <p className="text-muted">Simulate to see each document after each processor.</p>
        )}
        {simulation?.map((doc, i) => (
          <div key={i} className="mb-3 rounded border border-border">
            <p
              className={cx(
                'border-b border-border px-2 py-1 font-semibold',
                doc.error ? 'text-danger' : doc.dropped ? 'text-warning' : 'text-success',
              )}
            >
              Document {i + 1}:{' '}
              {doc.error ? `failed: ${doc.error}` : doc.dropped ? 'dropped' : 'passed'}
            </p>
            {doc.processors.length > 0 && (
              <ol className="px-2 py-1">
                {doc.processors.map((p, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="w-6 text-muted">{j + 1}.</span>
                    <span className="font-mono">
                      {p.processor}
                      {p.tag ? ` (${p.tag})` : ''}
                    </span>
                    <span
                      className={cx(
                        p.status === 'error'
                          ? 'text-danger'
                          : p.status === 'success'
                            ? 'text-success'
                            : 'text-muted',
                      )}
                    >
                      {p.status}
                    </span>
                    {p.error && <span className="text-danger">{p.error}</span>}
                  </li>
                ))}
              </ol>
            )}
            {doc.source !== undefined && (
              <pre className="max-h-40 overflow-auto bg-panel-2 px-2 py-1 font-mono text-[11px]">
                {safeFormat(doc.source)}
              </pre>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function safeFormat(text: string): string {
  try {
    return formatJson(text);
  } catch {
    return text;
  }
}

function Aliases({ view }: { readonly view: AdminView }) {
  const aliases = useSearchView(view, (s) => s.aliases);
  const indexNames = useSearchView(view, (s) => s.indexNames);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);
  const names = useMemo(() => [...new Set(aliases.map((a) => a.alias))], [aliases]);
  const [alias, setAlias] = useState('');
  const [indices, setIndices] = useState('');
  const [writeIndex, setWriteIndex] = useState(false);
  const [filter, setFilter] = useState('');
  const [swapAlias, setSwapAlias] = useState('');
  const [swapTo, setSwapTo] = useState('');
  const swapFrom = aliases.filter((a) => a.alias === swapAlias).map((a) => a.index);
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-3">
      <table className="w-full border-collapse text-xs" data-testid="admin-aliases">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left text-muted">
            <th className="px-2 py-1">Alias</th>
            <th className="px-2 py-1">Index</th>
            <th className="px-2 py-1">Write index</th>
            <th className="px-2 py-1">Filtered</th>
            <th className="px-2 py-1">Routing</th>
            <th className="px-2 py-1" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {aliases.length === 0 && (
            <tr>
              <td colSpan={6} className="px-2 py-2 text-muted">
                No aliases.
              </td>
            </tr>
          )}
          {aliases.map((a) => (
            <tr
              key={`${a.alias}\u0000${a.index}`}
              className="border-t border-border"
              data-alias={a.alias}
            >
              <td className="px-2 py-1 font-mono">{a.alias}</td>
              <td className="px-2 py-1 font-mono">{a.index}</td>
              <td className="px-2 py-1">
                {a.isWriteIndex === null ? '—' : a.isWriteIndex ? 'yes' : 'no'}
              </td>
              <td className="px-2 py-1">{a.filtered ? 'yes' : 'no'}</td>
              <td className="px-2 py-1">{a.indexRouting ?? a.searchRouting ?? ''}</td>
              <td className="px-2 py-1 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={readOnly}
                  onClick={() => void view.removeAlias(a.alias, a.index)}
                >
                  Remove…
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid gap-4 md:grid-cols-2">
        <form
          className="flex flex-col gap-2 rounded border border-border p-3"
          aria-label="Add an alias"
          onSubmit={(event) => {
            event.preventDefault();
            void view
              .addAlias({
                alias,
                indices: indices
                  .split(',')
                  .map((i) => i.trim())
                  .filter((i) => i !== ''),
                isWriteIndex: writeIndex,
                filter,
              })
              .then((ok) => {
                if (ok) {
                  setAlias('');
                  setIndices('');
                  setFilter('');
                }
              });
          }}
        >
          <h3 className="text-xs font-semibold">Add an alias</h3>
          <Field label="Alias" htmlFor="admin-alias-name">
            <Input
              id="admin-alias-name"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Indices (comma-separated)" htmlFor="admin-alias-indices">
            <Input
              id="admin-alias-indices"
              value={indices}
              onChange={(e) => setIndices(e.target.value)}
              className="font-mono"
              list="admin-index-names"
            />
          </Field>
          <datalist id="admin-index-names">
            {indexNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <Field label="Filter (a query, JSON; optional)" htmlFor="admin-alias-filter">
            <Input
              id="admin-alias-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="font-mono"
              placeholder='{"term": {"tenant": "a"}}'
            />
          </Field>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={writeIndex}
              onChange={(e) => setWriteIndex(e.target.checked)}
            />
            The first index is the write index
          </label>
          <Button type="submit" disabled={readOnly || alias.trim() === '' || indices.trim() === ''}>
            Add…
          </Button>
        </form>
        <form
          className="flex flex-col gap-2 rounded border border-border p-3"
          aria-label="Swap an alias"
          onSubmit={(event) => {
            event.preventDefault();
            void view.swapAlias(swapAlias, swapTo);
          }}
        >
          <h3 className="text-xs font-semibold">Swap an alias (one atomic step)</h3>
          <Field label="Alias" htmlFor="admin-swap-alias">
            <Select
              id="admin-swap-alias"
              value={swapAlias}
              onChange={(e) => setSwapAlias(e.target.value)}
            >
              <option value="">Choose an alias</option>
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          {swapAlias !== '' && (
            <p className="text-[11px] text-muted">Now on: {swapFrom.join(', ')}</p>
          )}
          <Field label="Move it to" htmlFor="admin-swap-to">
            <Select id="admin-swap-to" value={swapTo} onChange={(e) => setSwapTo(e.target.value)}>
              <option value="">Choose an index</option>
              {indexNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="submit"
            disabled={
              readOnly ||
              swapAlias === '' ||
              swapTo === '' ||
              (swapFrom.length === 1 && swapFrom[0] === swapTo)
            }
          >
            Swap…
          </Button>
        </form>
      </div>
    </div>
  );
}
