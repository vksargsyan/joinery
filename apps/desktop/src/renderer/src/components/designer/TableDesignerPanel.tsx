import type { TableDesign, ValidationIssue } from '@querybara/sync';
import { Tabs } from 'radix-ui';
import { useMemo, useState } from 'react';

import { issuesAt, renameTable } from '../../state/designer/form';
import {
  getDesigner,
  useDesignerState,
  type DesignerTab,
  type TableDesigner,
} from '../../state/designer';
import { openTableData } from '../dock';
import { Button, cx, Icon, TAB } from '../ui';
import { ColumnsTab } from './ColumnsTab';
import {
  ChecksTab,
  ForeignKeysTab,
  IndexesTab,
  PartitionsTab,
  TriggersTab,
  UniquesTab,
} from './ConstraintTabs';
import { Issues, TextField } from './fields';
import { CommentTab, OptionsTab } from './OptionsTab';
import { SaveReviewDialog } from './ReviewDialogs';

/**
 * The table designer panel (spec §8): the table's name, tabs for columns, indexes, foreign keys,
 * unique and check constraints, triggers, partitions (where the server has them), options and
 * comment, plus the SQL a save would run. Validation issues show next to their fields as the
 * design changes; Save opens the review with the script and its risks.
 */
export function TableDesignerPanel(props: { readonly panelId: string }) {
  const designer = getDesigner(props.panelId);
  if (!designer) return <p className="p-4 text-sm text-muted">This designer was closed.</p>;
  return <Designer designer={designer} />;
}

const TAB_LABELS: Readonly<Record<DesignerTab, string>> = {
  columns: 'Columns',
  indexes: 'Indexes',
  'foreign-keys': 'Foreign keys',
  uniques: 'Unique',
  checks: 'Checks',
  triggers: 'Triggers',
  partitions: 'Partitions',
  options: 'Options',
  comment: 'Comment',
  sql: 'SQL preview',
};

/** Which tab an issue path belongs to, for the counts on the tabs. */
function tabOf(path: string): DesignerTab | undefined {
  if (path.startsWith('columns')) return 'columns';
  if (path.startsWith('indexes')) return 'indexes';
  if (path.startsWith('foreignKeys')) return 'foreign-keys';
  if (path.startsWith('uniques') || path.startsWith('primaryKey')) return 'uniques';
  if (path.startsWith('checks')) return 'checks';
  if (path.startsWith('triggers')) return 'triggers';
  if (path.startsWith('partitioning')) return 'partitions';
  if (path.startsWith('options')) return 'options';
  if (path.startsWith('comment')) return 'comment';
  return undefined;
}

function Designer({ designer }: { readonly designer: TableDesigner }) {
  const status = useDesignerState(designer, (s) => s.status);
  const error = useDesignerState(designer, (s) => s.error);
  const form = useDesignerState(designer, (s) => s.form);
  const live = useDesignerState(designer, (s) => s.live);
  const tab = useDesignerState(designer, (s) => s.tab);
  const design = useDesignerState(designer, (s) => s.design);
  const syntaxIssues = useDesignerState(designer, (s) => s.syntaxIssues);
  const saving = useDesignerState(designer, (s) => s.saving);
  const notice = useDesignerState(designer, (s) => s.notice);
  const engine = useDesignerState(designer, (s) => s.engine);
  const partitionsSupported = useDesignerState(designer, (s) => s.partitionsSupported);
  const initial = useDesignerState(designer, (s) => s.initial);
  const [review, setReview] = useState<TableDesign>();
  const [showIssues, setShowIssues] = useState(true);

  const issues = useMemo<ValidationIssue[]>(
    () => [...(design?.issues ?? []), ...syntaxIssues],
    [design, syntaxIssues],
  );
  const errors = issues.filter((i) => i.severity === 'error').length;

  if (status === 'loading' || (status === 'ready' && !form)) {
    return <p className="p-4 text-sm text-muted">Loading the table…</p>;
  }
  if (status === 'error' || !form) {
    return (
      <div className="p-4 text-sm" role="alert">
        <p className="text-danger">{error}</p>
        <Button className="mt-3" onClick={() => void designer.init()}>
          Try again
        </Button>
      </div>
    );
  }

  const tabs: DesignerTab[] = [
    'columns',
    'indexes',
    'foreign-keys',
    'uniques',
    'checks',
    'triggers',
    ...(partitionsSupported || form.partitioning ? (['partitions'] as const) : []),
    'options',
    'comment',
    'sql',
  ];
  const counts = new Map<DesignerTab, number>();
  for (const issue of issues) {
    const t = tabOf(issue.path);
    if (t && issue.severity === 'error') counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const dirty = initial !== undefined && (live === null || design?.unchanged === false);

  const save = (): void => {
    const now = designer.designNow();
    if (!now) return;
    if (!now.valid) {
      setShowIssues(true);
      return;
    }
    if (now.unchanged) {
      designer.store.setState({
        notice: { kind: 'success', text: 'Nothing to save: the table is unchanged' },
      });
      return;
    }
    setReview(now);
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="table-designer">
      <div
        className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Table designer"
      >
        <span className="text-xs text-muted">{designer.target.schema}.</span>
        <div className="w-56">
          <TextField
            mono
            aria-label="Table name"
            value={form.name}
            invalid={issuesAt(issues, 'name', { exact: true }).length > 0}
            onChange={(event) => designer.setForm(renameTable(form, event.target.value))}
          />
        </div>
        {live && form.name !== live.name && (
          <span className="text-[11px] text-muted">renamed from {live.name}</span>
        )}
        {!live && (
          <span className="rounded bg-success/15 px-1.5 py-0.5 text-[11px] text-success">
            new table
          </span>
        )}
        <span className="flex-1" />
        {live && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              openTableData({
                profileId: designer.target.profileId,
                database: designer.target.database,
                schema: designer.target.schema,
                name: live.name,
              })
            }
          >
            <Icon name="table" className="h-3.5 w-3.5" />
            Open data
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void designer.reload()}
          disabled={saving}
          title="Load the table from the server again"
        >
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Reload
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => designer.revert()}
          disabled={!dirty || saving}
        >
          Revert
        </Button>
        <Button size="sm" variant="primary" onClick={save} disabled={saving || errors > 0}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-testid="designer-notice"
          className={cx(
            'flex items-center gap-2 border-b px-3 py-1 text-xs',
            notice.kind === 'error'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-border bg-panel-2',
          )}
        >
          <span className="flex-1">{notice.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="rounded p-0.5 hover:bg-hover"
            onClick={() => designer.store.setState({ notice: undefined })}
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        </div>
      )}
      <Issues issues={issuesAt(issues, 'name', { exact: true })} className="px-3 pt-1" />
      <Tabs.Root
        value={tab}
        onValueChange={(value) => designer.setTab(value as DesignerTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          aria-label="Designer sections"
          className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-panel px-1"
        >
          {tabs.map((t) => (
            <Tabs.Trigger key={t} value={t} className={TAB}>
              {TAB_LABELS[t]}
              {(counts.get(t) ?? 0) > 0 && (
                <span className="ml-1 rounded bg-danger/20 px-1 text-danger">{counts.get(t)}</span>
              )}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="columns" className="min-h-0 flex-1">
          <ColumnsTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="indexes" className="min-h-0 flex-1">
          <IndexesTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="foreign-keys" className="min-h-0 flex-1">
          <ForeignKeysTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="uniques" className="min-h-0 flex-1">
          <UniquesTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="checks" className="min-h-0 flex-1">
          <ChecksTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="triggers" className="min-h-0 flex-1">
          <TriggersTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="partitions" className="min-h-0 flex-1 overflow-auto">
          <PartitionsTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="options" className="min-h-0 flex-1 overflow-auto">
          <OptionsTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="comment" className="min-h-0 flex-1 overflow-auto">
          <CommentTab designer={designer} form={form} issues={issues} />
        </Tabs.Content>
        <Tabs.Content value="sql" className="min-h-0 flex-1 overflow-auto p-3">
          {design?.unchanged ? (
            <p className="text-xs text-muted">No changes to save.</p>
          ) : (
            <>
              {design && !design.transactional && (
                <p className="mb-2 text-xs text-warning">
                  {engine === 'mariadb' ? 'MariaDB' : 'MySQL'} does not run DDL in a transaction.
                </p>
              )}
              <pre
                data-testid="design-preview"
                className="font-mono text-xs whitespace-pre-wrap select-text"
              >
                {design?.script ?? ''}
              </pre>
            </>
          )}
        </Tabs.Content>
      </Tabs.Root>
      {issues.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-border bg-panel px-3 py-1 text-xs">
          <button
            type="button"
            className="flex items-center gap-1 font-semibold"
            onClick={() => setShowIssues(!showIssues)}
          >
            <Icon name={showIssues ? 'chevron-down' : 'chevron-right'} className="h-3 w-3" />
            {errors > 0
              ? `${errors} ${errors === 1 ? 'problem' : 'problems'} to fix before saving`
              : 'Notes'}
            {issues.length - errors > 0 && (
              <span className="font-normal text-muted"> · {issues.length - errors} warnings</span>
            )}
          </button>
          {showIssues && (
            <ul className="mt-1 flex flex-col gap-0.5" data-testid="designer-issues">
              {issues.map((issue, i) => {
                const target = tabOf(issue.path);
                return (
                  <li key={`${issue.path}:${issue.code}:${i}`}>
                    <button
                      type="button"
                      className={cx(
                        'text-left hover:underline',
                        issue.severity === 'error' ? 'text-danger' : 'text-warning',
                      )}
                      onClick={() => target && designer.setTab(target)}
                    >
                      {issue.path !== '' && (
                        <span className="mr-1 font-mono text-muted">{issue.path}</span>
                      )}
                      {issue.message}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {review && (
        <SaveReviewDialog
          design={review}
          profileId={designer.target.profileId}
          engine={engine}
          run={(sql) => designer.query(sql)}
          save={() => designer.save(review)}
          onClose={() => setReview(undefined)}
        />
      )}
    </div>
  );
}
