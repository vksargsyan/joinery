import type { GridSelection } from '@glideapps/glide-data-grid';
import { useState } from 'react';

import { formatCount, formatDuration } from '../../lib/format';
import type { DocumentsView } from '../../state/search/documents';
import { useSearchView } from '../../state/search/view';
import { useTheme } from '../theme';
import { Button, Field, Icon, Input, Modal, Select, cx } from '../ui';
import { DocumentGrid, EMPTY_GRID_SELECTION, selectedDocumentRows } from './DocumentGrid';
import { JsonEditor } from './JsonEditor';
import { NoticeBar } from './parts';

/**
 * The document grid panel (spec §11): the query bar (a Query DSL clause or a Lucene query
 * string, and a sort), the grid of flattened fields that loads pages as it scrolls (a point in
 * time with search_after, or a scroll), the counts and paging mode, and the document actions:
 * create, edit, delete and bulk (delete or set a field on the selected rows, or send NDJSON),
 * with per-item outcomes.
 */

const PAGING_LABELS = { pit: 'point in time', scroll: 'scroll', single: 'one page' } as const;

export function DocumentsPanel({ view }: { readonly view: DocumentsView }) {
  const theme = useTheme();
  const queryText = useSearchView(view, (s) => s.queryText);
  const sortText = useSearchView(view, (s) => s.sortText);
  const issue = useSearchView(view, (s) => s.issue);
  const running = useSearchView(view, (s) => s.running);
  const pageSize = useSearchView(view, (s) => s.pageSize);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_GRID_SELECTION);
  const [dialog, setDialog] = useState<'set-field' | 'bulk' | undefined>(undefined);
  const selected = selectedDocumentRows(selection);
  const readOnly = useSearchView(view, (s) => s.policy?.readOnly ?? false);

  const search = (): void => {
    setSelection(EMPTY_GRID_SELECTION);
    void view.search();
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-documents">
      <form
        className="flex flex-wrap items-end gap-2 border-b border-border bg-panel px-2 py-1.5"
        aria-label="Query"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <label className="flex min-w-64 flex-[3] flex-col gap-0.5 text-[11px] text-muted">
          Query (DSL clause or Lucene syntax)
          <Input
            value={queryText}
            onChange={(event) => view.setQueryText(event.target.value)}
            placeholder='status:paid AND total:>100   or   {"term": {"status": "paid"}}'
            aria-invalid={issue !== undefined}
            className="font-mono"
            data-testid="documents-query"
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-0.5 text-[11px] text-muted">
          Sort (JSON)
          <Input
            value={sortText}
            onChange={(event) => view.setSortText(event.target.value)}
            placeholder='[{"@timestamp": "desc"}]'
            className="font-mono"
            data-testid="documents-sort"
          />
        </label>
        <label className="flex w-24 flex-col gap-0.5 text-[11px] text-muted">
          Page size
          <Select
            value={String(pageSize)}
            onChange={(event) => view.setPageSize(Number(event.target.value))}
            aria-label="Page size"
          >
            {[25, 50, 100, 500, 1000].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" size="md" variant="primary" disabled={running}>
          <Icon name="play" className="h-3.5 w-3.5" />
          Search
        </Button>
      </form>
      {issue && (
        <p
          role="alert"
          className="border-b border-border bg-danger/10 px-3 py-1 text-xs text-danger"
        >
          {issue}
        </p>
      )}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1"
        role="toolbar"
        aria-label="Documents"
      >
        <Button
          size="sm"
          variant="ghost"
          onClick={() => view.openEditor('create')}
          disabled={readOnly}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          New document
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || selected.length !== 1}
          onClick={() => view.openEditor('edit', selected[0])}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          disabled={readOnly || selected.length === 0}
          onClick={() => {
            void view.deleteRows(selected).then(() => setSelection(EMPTY_GRID_SELECTION));
          }}
        >
          Delete{selected.length > 1 ? ` ${formatCount(selected.length)}` : ''}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || selected.length === 0}
          onClick={() => setDialog('set-field')}
        >
          Set field…
        </Button>
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => setDialog('bulk')}>
          Bulk…
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" onClick={search} disabled={running}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <span className="flex-1" />
        <Status view={view} />
      </div>
      <NoticeBar view={view} />
      <div className="min-h-0 flex-1">
        <DocumentGrid
          view={view}
          theme={theme}
          selection={selection}
          onSelectionChange={setSelection}
          onActivate={(row) => view.openEditor('edit', row)}
        />
      </div>
      <LoadMore view={view} />
      <DocumentEditorDialog view={view} theme={theme} />
      {dialog === 'set-field' && (
        <SetFieldDialog
          count={selected.length}
          onClose={() => setDialog(undefined)}
          onApply={(path, value) => {
            setDialog(undefined);
            void view.setFieldOnRows(selected, path, value);
          }}
        />
      )}
      {dialog === 'bulk' && (
        <BulkDialog view={view} theme={theme} onClose={() => setDialog(undefined)} />
      )}
      <BulkResultDialog view={view} />
    </div>
  );
}

function Status({ view }: { readonly view: DocumentsView }) {
  const loaded = useSearchView(view, (s) => s.hits.length);
  const total = useSearchView(view, (s) => s.total);
  const exact = useSearchView(view, (s) => s.exactCount);
  const paging = useSearchView(view, (s) => s.paging);
  const took = useSearchView(view, (s) => s.tookMs);
  const running = useSearchView(view, (s) => s.running);
  return (
    <span className="flex items-center gap-2 text-[11px] text-muted" aria-live="polite">
      <span data-testid="documents-loaded">{formatCount(loaded)} loaded</span>
      {exact !== undefined ? (
        <span data-testid="documents-total">· {formatCount(exact)} matching</span>
      ) : (
        total && (
          <span data-testid="documents-total">
            · {formatCount(total.value)}
            {total.relation === 'gte' ? '+' : ''} matching
          </span>
        )
      )}
      {total?.relation === 'gte' && exact === undefined && (
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => void view.countExactly()}
        >
          Count exactly
        </button>
      )}
      {paging && <span data-testid="documents-paging">· {PAGING_LABELS[paging]}</span>}
      {took !== undefined && !running && <span>· {formatDuration(took)}</span>}
    </span>
  );
}

function LoadMore({ view }: { readonly view: DocumentsView }) {
  const error = useSearchView(view, (s) => s.error);
  const hasMore = useSearchView(view, (s) => s.hasMore);
  const loading = useSearchView(view, (s) => s.loadingMore || s.running);
  const count = useSearchView(view, (s) => s.hits.length);
  if (error) {
    return (
      <p
        role="alert"
        className="border-t border-border px-3 py-1 text-xs text-danger"
        data-testid="documents-error"
      >
        {error}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 border-t border-border bg-panel px-3 py-0.5 text-[11px] text-muted">
      {loading ? (
        <span>Loading…</span>
      ) : count === 0 ? (
        <span>No documents match.</span>
      ) : hasMore ? (
        <>
          <span>More load as you scroll.</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void view.loadMore()}
          >
            Load more
          </button>
        </>
      ) : (
        <span>All matching documents are loaded.</span>
      )}
    </div>
  );
}

function DocumentEditorDialog(props: {
  readonly view: DocumentsView;
  readonly theme: 'dark' | 'light';
}) {
  const { view } = props;
  const editor = useSearchView(view, (s) => s.editor);
  if (!editor) return null;
  const saving = editor.status === 'saving';
  const conflict = editor.status === 'conflict';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && view.closeEditor()}
      title={editor.mode === 'edit' ? `Edit ${editor.id}` : 'New document'}
      description={
        editor.mode === 'edit'
          ? `In ${editor.index}${editor.version ? ` · saved only over version ${editor.version.seqNo}/${editor.version.primaryTerm}` : ''}`
          : `Into ${editor.index}; an id that exists is refused`
      }
      width="w-[760px]"
      footer={
        conflict ? (
          <>
            <Button variant="ghost" onClick={() => view.closeEditor()}>
              Cancel
            </Button>
            <Button onClick={() => view.reloadEditor()} data-testid="document-reload">
              Reload their version
            </Button>
            <Button
              variant="danger"
              onClick={() => void view.overwriteEditor()}
              data-testid="document-overwrite"
            >
              Overwrite with mine…
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => view.closeEditor()} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void view.saveEditor()}
              disabled={saving || editor.issue !== undefined}
              data-testid="document-save"
            >
              {saving ? 'Saving…' : editor.mode === 'edit' ? 'Save' : 'Create'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2" data-testid="document-editor">
        {editor.mode === 'create' && (
          <Field label="Id (empty: generated)" htmlFor="document-id">
            <Input
              id="document-id"
              value={editor.id}
              onChange={(event) => view.setEditorId(event.target.value)}
              className="font-mono"
            />
          </Field>
        )}
        {conflict && editor.current && (
          <div
            role="alert"
            data-testid="document-conflict"
            className="rounded border border-warning/50 bg-warning/10 p-2 text-xs text-warning"
          >
            <p className="font-semibold">
              Someone changed this document after you opened it; it was not saved.
            </p>
            <p className="mt-1 text-fg">
              Their version
              {editor.current.version
                ? ` (${editor.current.version.seqNo}/${editor.current.version.primaryTerm})`
                : ''}
              :
            </p>
            <pre
              className="mt-1 max-h-40 overflow-auto rounded bg-panel-2 p-2 font-mono text-[11px] text-fg"
              data-testid="document-current"
            >
              {editor.current.text}
            </pre>
          </div>
        )}
        <JsonEditor
          value={editor.text}
          onChange={(text) => view.setEditorText(text)}
          theme={props.theme}
          issue={editor.issue}
          onRun={() => void view.saveEditor()}
          ariaLabel="Document source"
          testId="document-source"
          className="h-80 min-h-0 rounded border border-border"
        />
        {editor.issue && <p className="text-xs text-danger">{editor.issue.message}</p>}
        {editor.error && !conflict && (
          <p role="alert" className="text-xs text-danger" data-testid="document-error">
            {editor.error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function SetFieldDialog(props: {
  readonly count: number;
  readonly onClose: () => void;
  readonly onApply: (path: string, value: string) => void;
}) {
  const [path, setPath] = useState('');
  const [value, setValue] = useState('');
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title={`Set a field on ${formatCount(props.count)} ${props.count === 1 ? 'document' : 'documents'}`}
      description="A partial update through _bulk; each document is written only over the version shown."
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={path.trim() === ''}
            onClick={() => props.onApply(path, value)}
          >
            Set field
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Field (dotted path)" htmlFor="set-field-path">
          <Input
            id="set-field-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field
          label="Value (JSON, or text)"
          htmlFor="set-field-value"
          hint='42, true, null, ["a"], or plain text for a string'
        >
          <Input
            id="set-field-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}

function BulkDialog(props: {
  readonly view: DocumentsView;
  readonly theme: 'dark' | 'light';
  readonly onClose: () => void;
}) {
  const [text, setText] = useState('{ "index": {} }\n{ "field": "value" }\n');
  const [sending, setSending] = useState(false);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !sending && props.onClose()}
      title="Bulk request"
      description={`NDJSON action and source lines, sent to ${props.view.target.target}/_bulk (the default index).`}
      width="w-[760px]"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={sending || text.trim() === ''}
            onClick={() => {
              setSending(true);
              void props.view.sendBulk(text).then((ok) => {
                setSending(false);
                if (ok) props.onClose();
              });
            }}
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </>
      }
    >
      <JsonEditor
        value={text}
        onChange={setText}
        theme={props.theme}
        ariaLabel="Bulk NDJSON"
        testId="bulk-text"
        className="h-72 min-h-0 rounded border border-border"
      />
    </Modal>
  );
}

function BulkResultDialog({ view }: { readonly view: DocumentsView }) {
  const bulk = useSearchView(view, (s) => s.bulk);
  if (!bulk || bulk.failed === 0) return null;
  const failed = bulk.items.filter((i) => i.error !== undefined);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && view.closeBulk()}
      title={`${bulk.title}: ${formatCount(bulk.failed)} of ${formatCount(bulk.items.length)} failed`}
      width="w-[760px]"
      footer={
        <Button variant="primary" onClick={() => view.closeBulk()}>
          Close
        </Button>
      }
    >
      <table className="w-full border-collapse text-xs" data-testid="bulk-results">
        <thead>
          <tr className="text-left text-muted">
            <th className="px-2 py-1">Action</th>
            <th className="px-2 py-1">Index</th>
            <th className="px-2 py-1">Id</th>
            <th className="px-2 py-1">Status</th>
            <th className="px-2 py-1">Error</th>
          </tr>
        </thead>
        <tbody>
          {failed.map((item, i) => (
            <tr key={i} className={cx('border-t border-border', item.error && 'text-danger')}>
              <td className="px-2 py-1">{item.action}</td>
              <td className="px-2 py-1 font-mono">{item.index}</td>
              <td className="px-2 py-1 font-mono">{item.id ?? ''}</td>
              <td className="px-2 py-1">{item.status}</td>
              <td className="px-2 py-1">
                {item.error ? `${item.error.type}: ${item.error.reason}` : item.result}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
