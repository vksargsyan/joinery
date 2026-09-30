import type { TransferPreview } from '@joinery/ipc';
import { useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { confirm } from '../../state/dialogs';
import { startJob } from '../../state/jobs';
import type { RunSqlFileTarget } from '../../state/transfer-dialogs';
import { Button, Modal } from '../ui';
import { formatBytes } from './shared';

/**
 * Run SQL File (spec §6): a .sql file (gzip allowed) streams through the statement splitter in
 * the job runner, with progress, stop-on-error or continue, and an error log in the job list.
 * The safety check applies once up front: production and "confirm every write" profiles ask
 * before the run; on a read-only profile the job runner refuses the first statement that
 * writes.
 */
export function RunSqlFileDialog(props: {
  readonly target: RunSqlFileTarget;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const [path, setPath] = useState<string>();
  const [preview, setPreview] = useState<TransferPreview>();
  const [onError, setOnError] = useState<'stop' | 'continue'>('stop');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const choose = async (): Promise<void> => {
    setError(undefined);
    const picked = (
      await mainApi().dialogs.openFile({
        title: 'Run SQL file',
        filters: [
          { name: 'SQL scripts', extensions: ['sql', 'gz'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
    ).path;
    if (picked === null) return;
    setPath(picked);
    setPreview(undefined);
    try {
      setPreview(
        await mainApi().transfer.preview({
          path: picked,
          format: 'sql',
          dialect: target.dialect,
          sampleRows: 5,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const run = async (): Promise<void> => {
    if (!path) return;
    let confirmed = false;
    if (target.confirmWrites) {
      const ok = await confirm({
        title: target.production
          ? 'Run a SQL file on a production connection?'
          : 'Run this SQL file?',
        message: `Every statement in the file runs on "${target.profileName}"${
          target.database ? ` (${target.database})` : ''
        }, and any of them may write.`,
        confirmLabel: 'Run the file',
        danger: target.production,
      });
      if (!ok) return;
      confirmed = true;
    }
    setBusy(true);
    setError(undefined);
    try {
      const jobId = await startJob({
        kind: 'run-sql-file',
        profileId: target.profileId,
        ...(target.database !== undefined ? { database: target.database } : {}),
        path,
        onError,
        ...(preview ? { encoding: preview.encoding } : {}),
        ...(confirmed ? { confirmed: true } : {}),
      });
      if (jobId) props.onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Run SQL file"
      description={`${target.profileName}${target.database ? ` · ${target.database}` : ''}`}
      width="w-[640px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={error ? 'alert' : undefined}
          >
            {error ?? ''}
          </span>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={!path || busy}>
            Run
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-start gap-3 text-xs" data-testid="run-sql-file">
        <p className="text-muted">
          The file streams through the statement splitter in the job runner, so large dumps run in
          flat memory. Progress and failed statements show in the Jobs panel.
        </p>
        {target.readOnly && (
          <p className="text-warning">
            This connection is read-only: the run stops at the first statement that writes.
          </p>
        )}
        <Button onClick={() => void choose()}>Choose file…</Button>
        {path && (
          <p className="font-mono break-all">
            {path}
            {preview ? ` · ${formatBytes(preview.size)}` : ''}
          </p>
        )}
        {preview?.statements && preview.statements.length > 0 && (
          <pre className="max-h-40 w-full overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {preview.statements.map((statement) => `${statement.slice(0, 400)};`).join('\n')}
            {preview.complete ? '' : '\n…'}
          </pre>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted">
            When a statement fails
          </legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="sql-file-errors"
              checked={onError === 'stop'}
              onChange={() => setOnError('stop')}
            />
            Stop
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="sql-file-errors"
              checked={onError === 'continue'}
              onChange={() => setOnError('continue')}
            />
            Log it and continue
          </label>
        </fieldset>
      </div>
    </Modal>
  );
}
