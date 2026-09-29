import { useEffect, useMemo, useState } from 'react';

import { formatCount } from '../../lib/format';
import { formatBytes } from '../../state/mongo/indexes';
import {
  GRIDFS_PAGE_SIZE,
  shellText,
  useGridFs,
  type FilePreview,
  type GridFsBrowser,
} from '../../state/mongo/gridfs';
import { Button, Icon, Input, cx } from '../ui';
import { NameDialog, NoticeBanner, RulesBanners } from './parts';

/**
 * The GridFS browser panel (spec §9): a bucket's files a page at a time with a name filter,
 * upload and download with progress, a preview of the selected text or image file, rename and
 * delete.
 */
export function GridFsPanel({ browser }: { readonly browser: GridFsBrowser }) {
  const search = useGridFs(browser, (s) => s.search);
  const page = useGridFs(browser, (s) => s.page);
  const files = useGridFs(browser, (s) => s.files);
  const hasNext = useGridFs(browser, (s) => s.hasNext);
  const loading = useGridFs(browser, (s) => s.loading);
  const error = useGridFs(browser, (s) => s.error);
  const selected = useGridFs(browser, (s) => s.selected);
  const preview = useGridFs(browser, (s) => s.preview);
  const transfer = useGridFs(browser, (s) => s.transfer);
  const notice = useGridFs(browser, (s) => s.notice);
  const rules = useGridFs(browser, (s) => s.rules);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const writable = !rules.readOnlyProfile;
  const file = files.find((f) => f.id === selected);
  const { db, bucket } = browser.target;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-gridfs-panel"
      aria-label={`${db} ${bucket} files`}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="GridFS"
      >
        <Button
          size="sm"
          variant="primary"
          disabled={!writable || transfer !== undefined}
          onClick={() => void browser.upload()}
          data-testid="gridfs-upload"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Upload…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!file || transfer !== undefined}
          onClick={() => file && void browser.download(file.id)}
          data-testid="gridfs-download"
        >
          Download…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!file || !writable}
          onClick={() => file && setRenaming(file.id)}
          data-testid="gridfs-rename"
        >
          Rename…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          disabled={!file || !writable}
          onClick={() => file && void browser.delete(file.id)}
          data-testid="gridfs-delete"
        >
          Delete…
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void browser.load();
          }}
        >
          <Input
            aria-label="Filter by name"
            placeholder="Filter by name"
            value={search}
            onChange={(event) => browser.setSearch(event.target.value)}
            className="h-7 w-56 text-xs"
            data-testid="gridfs-search"
          />
          <Button size="sm" variant="ghost" type="submit">
            Filter
          </Button>
        </form>
        <Button size="sm" variant="ghost" onClick={() => void browser.load()} disabled={loading}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted">
          {db}.{bucket}
        </span>
      </div>
      <RulesBanners rules={rules} what="files" />
      <NoticeBanner notice={notice} onDismiss={() => browser.dismissNotice()} />
      {transfer && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs"
          data-testid="gridfs-transfer"
        >
          {transfer.kind === 'upload' ? 'Uploading' : 'Downloading'} {transfer.name}:{' '}
          {formatBytes(transfer.bytes)}
          {transfer.total !== undefined ? ` of ${formatBytes(transfer.total)}` : ''}
          {transfer.total ? (
            <span className="h-1.5 w-40 overflow-hidden rounded bg-panel-2">
              <span
                className="block h-full bg-accent"
                style={{ width: `${Math.min(100, (transfer.bytes / transfer.total) * 100)}%` }}
              />
            </span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => browser.cancelTransfer()}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-xs" data-testid="gridfs-files">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>
                <th className="border-b border-border px-2 py-1 font-medium">Name</th>
                <th className="border-b border-border px-2 py-1 text-right font-medium">Length</th>
                <th className="border-b border-border px-2 py-1 font-medium">Uploaded</th>
                <th className="border-b border-border px-2 py-1 font-medium">Content type</th>
                <th className="border-b border-border px-2 py-1 font-medium">Metadata</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr
                  key={f.id}
                  data-file={f.filename}
                  aria-selected={f.id === selected}
                  tabIndex={0}
                  className={cx(
                    'cursor-default hover:bg-hover',
                    f.id === selected && 'bg-accent/10',
                  )}
                  onClick={() => void browser.select(f.id)}
                  onDoubleClick={() => void browser.download(f.id)}
                  onKeyDown={(event) => event.key === 'Enter' && void browser.select(f.id)}
                >
                  <td
                    className="border-b border-border px-2 py-1 font-mono"
                    title={shellText(f.id)}
                  >
                    {f.filename}
                  </td>
                  <td className="border-b border-border px-2 py-1 text-right">
                    {formatBytes(f.length)}
                  </td>
                  <td className="border-b border-border px-2 py-1 whitespace-nowrap">
                    {new Date(f.uploadDate).toLocaleString()}
                  </td>
                  <td className="border-b border-border px-2 py-1">{f.contentType ?? ''}</td>
                  <td className="max-w-[240px] truncate border-b border-border px-2 py-1 font-mono text-muted">
                    {f.metadata !== undefined ? shellText(f.metadata) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && files.length === 0 && (
            <p className="p-4 text-sm text-muted">
              {search.trim() === '' ? 'The bucket is empty.' : 'No file matches the filter.'}
            </p>
          )}
          {loading && <p className="px-3 py-2 text-xs text-muted">Loading…</p>}
        </div>
        <aside
          className="flex w-[360px] shrink-0 flex-col gap-2 overflow-auto border-l border-border p-2 text-xs"
          data-testid="gridfs-preview"
        >
          {file ? (
            <>
              <h3 className="font-mono text-[13px] font-semibold break-all">{file.filename}</h3>
              <p className="text-muted">
                {formatBytes(file.length)} · chunks of {formatBytes(file.chunkSize)} · _id{' '}
                <span className="font-mono">{shellText(file.id)}</span>
              </p>
              <Preview preview={preview?.id === file.id ? preview : undefined} />
            </>
          ) : (
            <p className="text-muted">Select a file to preview it.</p>
          )}
        </aside>
      </div>
      <footer className="flex items-center gap-2 border-t border-border bg-panel px-2 py-1 text-xs">
        <Button
          size="sm"
          variant="ghost"
          disabled={page === 0 || loading}
          onClick={() => void browser.goToPage(page - 1)}
          aria-label="Previous page"
        >
          ‹
        </Button>
        <span data-testid="gridfs-page">
          Page {page + 1} · files{' '}
          {formatCount(page * GRIDFS_PAGE_SIZE + (files.length > 0 ? 1 : 0))}–
          {formatCount(page * GRIDFS_PAGE_SIZE + files.length)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasNext || loading}
          onClick={() => void browser.goToPage(page + 1)}
          aria-label="Next page"
        >
          ›
        </Button>
      </footer>
      <NameDialog
        open={renaming !== undefined}
        title="Rename the file"
        label="File name"
        initial={files.find((f) => f.id === renaming)?.filename ?? ''}
        confirmLabel="Rename"
        onClose={() => setRenaming(undefined)}
        onSubmit={(name) => {
          const id = renaming;
          setRenaming(undefined);
          if (id !== undefined) void browser.rename(id, name);
        }}
      />
    </div>
  );
}

function Preview({ preview }: { readonly preview: FilePreview | undefined }) {
  const url = useMemo(() => {
    if (preview?.status !== 'image' || !preview.bytes) return undefined;
    const copy = new Uint8Array(preview.bytes);
    return URL.createObjectURL(new Blob([copy.buffer], { type: preview.mime }));
  }, [preview]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (!preview || preview.status === 'loading') return <p className="text-muted">Loading…</p>;
  if (preview.status === 'image' && url) {
    return <img src={url} alt="Preview" className="max-w-full rounded border border-border" />;
  }
  if (preview.status === 'text') {
    return (
      <>
        <pre
          className="max-h-[60vh] overflow-auto rounded border border-border bg-panel-2 p-2 font-mono whitespace-pre-wrap select-text"
          data-testid="gridfs-preview-text"
        >
          {preview.text}
        </pre>
        {preview.truncated && <p className="text-muted">Only the start of the file is shown.</p>}
      </>
    );
  }
  return (
    <p className={preview.status === 'error' ? 'text-danger' : 'text-muted'}>{preview.message}</p>
  );
}
