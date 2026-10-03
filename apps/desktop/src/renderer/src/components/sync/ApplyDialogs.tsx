import type { DataScriptPreview, StructureScript } from '@querybara/ipc';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { formatCount } from '../../lib/format';
import { cachedProfile } from '../../state/data';
import type { DataCompare } from '../../state/sync/data';
import { appProfileLookup } from '../../state/sync/panels';
import type { StructureCompare } from '../../state/sync/structure';
import { Button, EnvironmentBadge, Modal } from '../ui';
import { Banner, Check } from './parts';

/**
 * The reviews before applying (spec §13, §4): the script that will run, what it destroys, the
 * warnings (MySQL and MariaDB DDL is not transactional: back up first), and the target's write
 * rules. A read-only target cannot apply; a production target, or one that confirms every
 * write, needs the explicit confirmation ticked. Main and the job runner check the same rules.
 */

function TargetLine(props: { readonly profileId: string; readonly database: string }) {
  const profile = cachedProfile(props.profileId);
  return (
    <p className="flex items-center gap-1.5 text-xs">
      Target: <span className="font-semibold">{profile?.name ?? 'the target'}</span>
      <span className="text-muted">({props.database})</span>
      {profile && <EnvironmentBadge environment={profile.presentation.environment} />}
    </p>
  );
}

function countOf(count: number, word: string): string {
  return `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** What the write rules ask of this apply. */
function rulesFor(profileId: string) {
  const profile = appProfileLookup(profileId);
  return {
    readOnly: profile?.readOnly ?? false,
    production: profile?.production ?? false,
    mustConfirm: profile?.confirmWrites ?? false,
  };
}

export function StructureApplyDialog(props: {
  readonly model: StructureCompare;
  readonly onClose: () => void;
}) {
  const { model } = props;
  const state = useStore(model.store);
  const result = state.result!;
  const [script, setScript] = useState<StructureScript>();
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    void model.refreshScript().then((current) => setScript(current));
  }, [model]);
  const rules = rulesFor(result.target.profileId);
  const selected = new Set(state.selected);
  const destructive = result.diff.operations.filter((op) => op.destructive && selected.has(op.id));
  const missing = model.missing();
  const needsTick = rules.mustConfirm || script?.backupRecommended === true;
  const apply = async (): Promise<void> => {
    if (!script) return;
    setRunning(true);
    props.onClose();
    await model.apply(script, confirmed);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !running && props.onClose()}
      title="Review and apply"
      description={`${state.selected.length} ${state.selected.length === 1 ? 'operation' : 'operations'}${script ? `, ${script.statementCount} ${script.statementCount === 1 ? 'statement' : 'statements'}` : ''} will run on the target.`}
      width="w-[820px]"
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Back to the comparison
          </Button>
          <Button
            variant={rules.production || destructive.length > 0 ? 'danger' : 'primary'}
            onClick={() => void apply()}
            disabled={
              !script ||
              script.statementCount === 0 ||
              rules.readOnly ||
              (needsTick && !confirmed) ||
              running
            }
          >
            {rules.production ? 'Apply to production' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" data-testid="structure-apply-review">
        <TargetLine profileId={result.target.profileId} database={result.target.database} />
        {rules.readOnly && (
          <Banner tone="error">
            This connection is read-only, so nothing can be applied to it.
          </Banner>
        )}
        {script?.transactional && (
          <p className="text-xs text-muted">
            The script runs in one transaction: if a statement fails, nothing is changed.
          </p>
        )}
        {script?.backupRecommended && (
          <Banner tone="warning" testId="non-transactional">
            {result.target.engine === 'mariadb' ? 'MariaDB' : 'MySQL'} runs DDL outside
            transactions: if a statement fails, the ones before it stay applied. Back up the target
            first.
          </Banner>
        )}
        {destructive.length > 0 && (
          <Banner tone="error">
            {destructive.length} destructive {destructive.length === 1 ? 'operation' : 'operations'}{' '}
            (data or code is lost): {destructive.map((op) => op.qualifiedName).join(', ')}
          </Banner>
        )}
        {missing.length > 0 && (
          <Banner tone="warning">
            {missing.length} ticked{' '}
            {missing.length === 1 ? 'operation depends' : 'operations depend'} on unticked ones; the
            script may fail.
          </Banner>
        )}
        <section aria-label="Script">
          <h3 className="mb-1 text-xs font-semibold">Script</h3>
          <pre
            data-testid="apply-script"
            className="max-h-[45vh] overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
          >
            {script?.text ?? 'Generating the script…'}
          </pre>
        </section>
        {needsTick && !rules.readOnly && (
          <Check
            label={
              rules.production
                ? 'I reviewed this script and want to run it on production'
                : 'I reviewed this script and want to run it'
            }
            checked={confirmed}
            onChange={setConfirmed}
          />
        )}
      </div>
    </Modal>
  );
}

export function DataApplyDialog(props: {
  readonly model: DataCompare;
  readonly onClose: () => void;
}) {
  const { model } = props;
  const state = useStore(model.store);
  const result = state.result!;
  const [preview, setPreview] = useState<DataScriptPreview>();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    void model.preview().then((loaded) => setPreview(loaded));
  }, [model]);
  const rules = rulesFor(result.target.profileId);
  const tables = result.tables.filter((t) => state.checked.includes(t.index));
  const { actions } = state.options;
  const sum = (pick: (t: (typeof tables)[number]) => number): number =>
    tables.reduce((total, t) => total + pick(t), 0);
  const counts = {
    insert: actions.insert ? sum((t) => t.counts.inserts) : 0,
    update: actions.update ? sum((t) => t.counts.updates) : 0,
    delete: actions.delete ? sum((t) => t.counts.deletes) : 0,
  };
  const needsTick = rules.mustConfirm || counts.delete > 0;
  const apply = async (): Promise<void> => {
    props.onClose();
    await model.apply(confirmed);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Review and apply the data changes"
      description={`${countOf(counts.insert, 'insert')}, ${countOf(counts.update, 'update')} and ${countOf(counts.delete, 'delete')} in ${countOf(tables.length, 'table')}.`}
      width="w-[820px]"
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Back to the comparison
          </Button>
          <Button
            variant={rules.production || counts.delete > 0 ? 'danger' : 'primary'}
            onClick={() => void apply()}
            disabled={
              !preview || preview.total === 0 || rules.readOnly || (needsTick && !confirmed)
            }
          >
            {rules.production ? 'Apply to production' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" data-testid="data-apply-review">
        <TargetLine profileId={result.target.profileId} database={result.target.database} />
        {rules.readOnly && (
          <Banner tone="error">
            This connection is read-only, so nothing can be applied to it.
          </Banner>
        )}
        <p className="text-xs text-muted">
          Each table’s changes run in their own transaction, deletes first (child tables before
          their parents), then updates and inserts (parents first). A failing statement rolls its
          table back and stops; tables before it stay changed.
          {state.options.disableForeignKeyChecks
            ? ' Foreign key checks are off while applying.'
            : ''}
        </p>
        <section aria-label="Sync script">
          <h3 className="mb-1 text-xs font-semibold">
            Script
            {preview?.truncated
              ? ` (the first ${preview.statements.length} of ${formatCount(preview.total)} statements)`
              : ''}
          </h3>
          <pre
            data-testid="data-apply-script"
            className="max-h-[45vh] overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
          >
            {preview ? preview.statements.map((s) => `${s};`).join('\n') : 'Generating the script…'}
          </pre>
        </section>
        {needsTick && !rules.readOnly && (
          <Check
            label={
              rules.production
                ? 'I reviewed these changes and want to apply them to production'
                : counts.delete > 0
                  ? `I want to delete ${formatCount(counts.delete)} ${counts.delete === 1 ? 'row' : 'rows'} from the target`
                  : 'I reviewed these changes and want to apply them'
            }
            checked={confirmed}
            onChange={setConfirmed}
          />
        )}
      </div>
    </Modal>
  );
}
