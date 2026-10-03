import { formatShellInline, fromEjson } from '@querybara/mongo-tools';

import { formatCount } from '../../lib/format';
import { useCollectionState, type CollectionView } from '../../state/mongo/collection-view';
import { Button, Modal } from '../ui';
import { ShellEditor } from './ShellEditor';

/**
 * The collection view's dialogs (spec §9): the document editor (edit, insert, clone) with the
 * conflict and validator feedback, and bulk update / delete by the current filter, which count
 * their matches first.
 */

const TITLES = { edit: 'Edit document', insert: 'Insert document', clone: 'Clone document' };

export function DocumentEditorDialog(props: {
  readonly view: CollectionView;
  readonly theme: 'dark' | 'light';
}) {
  const { view } = props;
  const editor = useCollectionState(view, (s) => s.editor);
  if (!editor) return null;
  const saving = editor.status === 'saving';
  const conflict = editor.status === 'conflict';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && view.closeEditor()}
      title={TITLES[editor.mode]}
      description={
        editor.mode === 'clone'
          ? 'A copy without its _id: the server gives the new document its own.'
          : 'mongosh syntax: ObjectId(), ISODate(), NumberDecimal(), NumberLong(), UUID(), BinData()…'
      }
      width="w-[760px]"
      footer={
        conflict ? (
          <>
            <Button variant="ghost" onClick={() => view.closeEditor()}>
              Cancel
            </Button>
            <Button onClick={() => view.reloadEditor()} data-testid="editor-reload">
              Reload their version
            </Button>
            <Button
              variant="danger"
              onClick={() => void view.overwriteEditor()}
              data-testid="editor-overwrite"
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
              data-testid="editor-save"
            >
              {saving ? 'Saving…' : editor.mode === 'edit' ? 'Save' : 'Insert'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2" data-testid="document-editor">
        {conflict && editor.current && (
          <div
            role="alert"
            data-testid="editor-conflict"
            className="rounded border border-warning/50 bg-warning/10 p-2 text-xs text-warning"
          >
            <p className="font-semibold">
              Someone changed this document after you opened it; it was not saved.
            </p>
            <p className="mt-1 text-fg">Their current version:</p>
            <pre
              className="mt-1 max-h-40 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-fg select-text"
              data-testid="editor-current"
            >
              {editor.current.text}
            </pre>
          </div>
        )}
        {editor.error && !conflict && (
          <div
            role="alert"
            data-testid="editor-error"
            className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
          >
            <p>{editor.error.message}</p>
            {editor.error.lines.length > 0 && (
              <ul className="mt-1 list-disc pl-5 font-mono" data-testid="editor-validation">
                {editor.error.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="h-[380px] rounded border border-border">
          <ShellEditor
            value={editor.text}
            onChange={(text) => view.setEditorText(text)}
            theme={props.theme}
            issue={editor.issue}
            onRun={() => void view.saveEditor()}
            ariaLabel="Document"
            testId="document-editor-text"
          />
        </div>
        {editor.issue && (
          <p role="alert" className="text-xs text-danger" data-testid="editor-issue">
            {editor.issue.message} (line {editor.issue.line}, column {editor.issue.column})
          </p>
        )}
      </div>
    </Modal>
  );
}

export function BulkDialog(props: {
  readonly view: CollectionView;
  readonly theme: 'dark' | 'light';
}) {
  const { view } = props;
  const bulk = useCollectionState(view, (s) => s.bulk);
  if (!bulk) return null;
  const update = bulk.kind === 'update';
  const busy = bulk.step === 'counting' || bulk.step === 'running';
  const filterText = formatShellInline(fromEjson(bulk.filter));
  const matched = bulk.matched;
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && !busy && view.closeBulk()}
      title={update ? 'Bulk update' : 'Bulk delete'}
      description={`Every document matching the current filter of ${view.target.db}.${view.target.collection}.`}
      width="w-[680px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => view.closeBulk()} disabled={busy}>
            {bulk.step === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {update && bulk.step !== 'done' && (
            <Button
              onClick={() => void view.countBulk()}
              disabled={busy || bulk.issue !== undefined}
              data-testid="bulk-count"
            >
              {bulk.step === 'counting' ? 'Counting…' : 'Count matches'}
            </Button>
          )}
          {bulk.step !== 'done' && (
            <Button
              variant="danger"
              onClick={() => void view.runBulk()}
              disabled={bulk.step !== 'counted' || matched === undefined || matched === 0}
              data-testid="bulk-run"
            >
              {matched === undefined
                ? update
                  ? 'Update…'
                  : 'Delete…'
                : `${update ? 'Update' : 'Delete'} ${formatCount(matched)} ${matched === 1 ? 'document' : 'documents'}…`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs" data-testid="bulk-dialog">
        <p className="text-muted">Filter</p>
        <pre className="rounded border border-border bg-panel-2 p-2 font-mono select-text">
          {filterText}
        </pre>
        {update && (
          <>
            <p className="text-muted">
              Update: operators such as{' '}
              <span className="font-mono">{'{ $set: { status: "shipped" } }'}</span> or a pipeline
            </p>
            <div className="h-40 rounded border border-border">
              <ShellEditor
                value={bulk.updateText}
                onChange={(text) => view.setBulkUpdateText(text)}
                theme={props.theme}
                issue={bulk.issue}
                onRun={() => void view.countBulk()}
                ariaLabel="Update"
                testId="bulk-update-text"
              />
            </div>
            {bulk.issue && (
              <p role="alert" className="text-danger">
                {bulk.issue.message} (line {bulk.issue.line}, column {bulk.issue.column})
              </p>
            )}
          </>
        )}
        {bulk.step === 'counting' && <p className="text-muted">Counting the matching documents…</p>}
        {matched !== undefined && bulk.step !== 'done' && (
          <p role="status" data-testid="bulk-matched" className="font-semibold">
            {formatCount(matched)} {matched === 1 ? 'document matches' : 'documents match'} (dry
            run: nothing changed yet)
          </p>
        )}
        {bulk.step === 'done' && bulk.result && (
          <p role="status" data-testid="bulk-done" className="font-semibold text-success">
            {update
              ? `Updated ${formatCount(bulk.result.modifiedCount)} of ${formatCount(bulk.result.matchedCount)} documents`
              : `Deleted ${formatCount(bulk.result.deletedCount)} documents`}
          </p>
        )}
        {bulk.error && (
          <p role="alert" className="text-danger">
            {bulk.error}
          </p>
        )}
      </div>
    </Modal>
  );
}
