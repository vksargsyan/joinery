import { useEffect, useState } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { useEditor, type ErModelEditor } from '../../state/er-diagram/editor';
import { openQueryTab } from '../dock';
import { Button, Icon, Modal, cx } from '../ui';
import { SqlText } from './SqlText';

/**
 * Review & apply (spec §8, forward engineering): what the model changes, counted by kind; the
 * changes that lose data, which must be acknowledged before Apply; the problems that block it;
 * the engine's warnings; and the script itself, to copy, save, open in a SQL tab or run. MySQL
 * and MariaDB are told their DDL commits statement by statement.
 */
export function ReviewDialog(props: { readonly editor: ErModelEditor }) {
  const { editor } = props;
  const script = useEditor(editor, (s) => s.review);
  const issues = useEditor(editor, (s) => s.issues);
  const applying = useEditor(editor, (s) => s.applying);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
    setCopied(false);
  }, [script]);
  if (!script) return null;

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const { summary, destructive } = script;
  const view = editor.view;
  const database = view.state.diagram?.database;
  const blocked = errors.length > 0 || (destructive.length > 0 && !acknowledged);
  const counts = [
    { label: 'create', n: summary.create, tone: 'text-success bg-success/12' },
    { label: 'alter', n: summary.alter, tone: 'text-warning bg-warning/12' },
    { label: 'rename', n: summary.rename, tone: 'text-accent bg-accent/12' },
    { label: 'drop', n: summary.drop, tone: 'text-danger bg-danger/12' },
  ].filter((c) => c.n > 0);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !applying && editor.closeReview()}
      title={`Apply ${summary.total} ${summary.total === 1 ? 'change' : 'changes'} to ${editor.context.schema}`}
      description={
        database === undefined
          ? undefined
          : `On ${database}${
              script.transactional
                ? ', in one transaction: if a statement fails, nothing is applied.'
                : '. MySQL and MariaDB commit each DDL statement: if one fails, the ones before it stay applied.'
            }`
      }
      width="w-[760px]"
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCopied(copyToClipboard(script.text))}
            title="Copy the script"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void editor.saveScript()}>
            Save as .sql…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Open the script in a new SQL tab, to edit or run it there"
            onClick={() => {
              openQueryTab({
                profileId: view.target.profileId,
                title: `${editor.context.schema} changes`,
                text: script.text,
                ...(database === undefined ? {} : { database }),
              });
              editor.closeReview();
            }}
          >
            Open in SQL editor
          </Button>
          <span className="flex-1" />
          <Button size="sm" onClick={() => editor.closeReview()} disabled={applying}>
            Back to the model
          </Button>
          <Button
            size="sm"
            variant={destructive.length > 0 ? 'danger' : 'primary'}
            disabled={blocked || applying}
            data-testid="er-apply"
            title={
              errors.length > 0
                ? 'Fix the problems first'
                : destructive.length > 0 && !acknowledged
                  ? 'Confirm the changes that lose data first'
                  : undefined
            }
            onClick={() => void editor.apply()}
          >
            {applying ? 'Applying…' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="er-review">
        <div className="flex flex-wrap items-center gap-1.5">
          {counts.map((c) => (
            <span
              key={c.label}
              className={cx('rounded-full px-2 py-0.5 text-[11px] font-semibold', c.tone)}
            >
              {c.n} {c.label}
            </span>
          ))}
          <span className="text-muted">
            · {script.statements.length}{' '}
            {script.statements.length === 1 ? 'statement' : 'statements'}
          </span>
        </div>

        {errors.length > 0 && (
          <section
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2 text-danger"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <Icon name="warning" className="h-3.5 w-3.5" />
              {errors.length === 1 ? 'A problem blocks' : `${errors.length} problems block`} the
              apply
            </p>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((issue, i) => (
                <li key={i}>
                  <strong>{issue.column ? `${issue.table}.${issue.column}` : issue.table}</strong>:{' '}
                  {issue.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        {destructive.length > 0 && (
          <section className="rounded-md border border-danger/40 bg-danger/8 px-3 py-2">
            <p className="font-semibold text-danger">
              {destructive.length === 1
                ? 'This change loses data'
                : `${destructive.length} changes lose data`}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-fg">
              {destructive.map((op) => (
                <li key={op.id} className="flex gap-2">
                  <span className="font-mono text-danger">{op.kind.toUpperCase()}</span>
                  <span className="font-mono">{op.qualifiedName}</span>
                  {op.changes.length > 0 && (
                    <span className="truncate text-muted">{op.changes.join('; ')}</span>
                  )}
                </li>
              ))}
            </ul>
            <label className="mt-2 flex items-center gap-2 font-medium text-fg">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="accent-[var(--danger)]"
              />
              I understand the data in these objects will be lost
            </label>
          </section>
        )}

        {(script.warnings.length > 0 || warnings.length > 0) && (
          <section className="rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-warning">
            <ul className="flex flex-col gap-0.5">
              {warnings.map((issue, i) => (
                <li key={`i${i}`}>
                  {issue.column ? `${issue.table}.${issue.column}` : issue.table}: {issue.message}
                </li>
              ))}
              {script.warnings.map((warning, i) => (
                <li key={`w${i}`}>{warning.message}</li>
              ))}
            </ul>
          </section>
        )}

        <SqlText
          sql={script.text}
          dialect={view.target.dialect}
          testId="er-script"
          className="max-h-[46vh] rounded-md border border-border bg-bg px-3 py-2.5"
        />
      </div>
    </Modal>
  );
}
