import type { ChangePlan } from '@joinery/table-data';
import { useState } from 'react';

import { useProfiles } from '../../state/data';
import type { ApplyFailure } from '../../state/table/apply-flow';
import type { TableView } from '../../state/table-view';
import { Button, Icon, Modal } from '../ui';

/**
 * Apply (spec §7): the generated SQL first, then one transaction on the server. A failure rolls
 * everything back and says so; a CONFLICT (a row changed or deleted by someone else since it was
 * loaded) offers to reload the rows.
 */
export function ApplyDialog(props: {
  readonly view: TableView;
  readonly plan: ChangePlan;
  readonly onClose: () => void;
}) {
  const { view, plan } = props;
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === view.target.profileId);
  const production = profile?.presentation.environment === 'production';
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<ApplyFailure>();
  const counts = { insert: 0, update: 0, delete: 0 };
  for (const statement of plan.statements) counts[statement.kind]++;
  const summary = [
    counts.update > 0 ? `${counts.update} ${counts.update === 1 ? 'update' : 'updates'}` : '',
    counts.insert > 0 ? `${counts.insert} ${counts.insert === 1 ? 'insert' : 'inserts'}` : '',
    counts.delete > 0 ? `${counts.delete} ${counts.delete === 1 ? 'delete' : 'deletes'}` : '',
  ].filter(Boolean);

  const run = async (): Promise<void> => {
    setRunning(true);
    setFailure(undefined);
    const outcome = await view.apply(plan);
    setRunning(false);
    if (outcome.ok) props.onClose();
    else if (!outcome.cancelled) setFailure(outcome.failure);
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !running && props.onClose()}
      title="Apply changes"
      description={`${summary.join(', ')} in one transaction on ${view.target.schema}.${view.target.name}.`}
      width="w-[760px]"
      footer={
        failure?.conflict ? (
          <>
            <Button variant="ghost" onClick={props.onClose}>
              Keep my changes
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                props.onClose();
                void view.discardAndReload();
              }}
            >
              Discard and reload
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={props.onClose} disabled={running}>
              Cancel
            </Button>
            <Button
              variant={production ? 'danger' : 'primary'}
              onClick={() => void run()}
              disabled={running || plan.statements.length === 0}
            >
              {running ? 'Applying…' : production ? 'Apply on production' : 'Apply'}
            </Button>
          </>
        )
      }
    >
      {production && (
        <p className="mb-2 flex items-center gap-1.5 rounded bg-danger/10 px-2 py-1 text-xs text-danger">
          <Icon name="warning" className="h-3.5 w-3.5" />
          This connection is marked production.
        </p>
      )}
      {failure && (
        <div
          role="alert"
          data-testid="apply-error"
          className="mb-3 rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
        >
          <p className="font-semibold">
            {failure.conflict ? 'Someone else changed these rows. ' : ''}
            {failure.message}
          </p>
          {failure.hint && <p className="mt-1">{failure.hint}</p>}
          {failure.detail && (
            <pre className="mt-1.5 max-h-32 overflow-auto font-mono whitespace-pre-wrap text-fg/80">
              {failure.detail}
            </pre>
          )}
          {!failure.conflict && (
            <p className="mt-1 text-muted">Nothing was saved; the transaction was rolled back.</p>
          )}
        </div>
      )}
      <pre
        data-testid="apply-preview"
        className="max-h-[50vh] overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
      >
        {plan.previewSql}
      </pre>
    </Modal>
  );
}
