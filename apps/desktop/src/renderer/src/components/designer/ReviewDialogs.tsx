import type { CellValue } from '@joinery/core';
import type { TableDesign } from '@joinery/sync';
import { formatCell } from '@joinery/table-data';
import { useEffect, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { useProfiles } from '../../state/data';
import { countFrom, hasRisks, reviewGroups, type ReviewItem } from '../../state/designer/review';
import {
  designTableDrop,
  dropTable,
  queryForTable,
  type DesignerTarget,
  type ScriptOutcome,
} from '../../state/designer';
import type { QueryResult } from '../../state/session-lane';
import { Button, Icon, Modal, cx } from '../ui';

/**
 * The designer's save review (spec §8: the ALTER script first, data-loss warnings for risky
 * changes): the script, the warnings grouped by severity with a Check that counts the rows each
 * risk touches (and lists them on demand), then Run. MySQL and MariaDB are told their DDL is
 * not transactional. The drop-table review works the same way, and its dependency errors block
 * the drop.
 */

const SEVERITY_CLASSES = {
  'data-loss': 'border-danger/50 bg-danger/5 text-danger',
  'may-fail': 'border-warning/50 bg-warning/5 text-warning',
  info: 'border-border bg-panel-2 text-fg',
} as const;

function CheckResult(props: {
  readonly item: ReviewItem;
  readonly run: (sql: string) => Promise<QueryResult>;
}) {
  const { item } = props;
  const [count, setCount] = useState<number | null | 'running'>();
  const [rows, setRows] = useState<QueryResult | 'running'>();
  const [error, setError] = useState<string>();
  const check = async (): Promise<void> => {
    if (!item.checkQuery) return;
    setCount('running');
    setError(undefined);
    try {
      setCount(countFrom((await props.run(item.checkQuery)).rows));
    } catch (e) {
      setCount(undefined);
      setError(errorMessage(e));
    }
  };
  const find = async (): Promise<void> => {
    if (!item.findQuery) return;
    setRows('running');
    setError(undefined);
    try {
      setRows(await props.run(item.findQuery));
    } catch (e) {
      setRows(undefined);
      setError(errorMessage(e));
    }
  };
  return (
    <div className="mt-1 flex flex-col gap-1 text-fg">
      <div className="flex flex-wrap items-center gap-2">
        {item.checkQuery && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void check()}
            disabled={count === 'running'}
          >
            {count === 'running' ? 'Checking…' : 'Check'}
          </Button>
        )}
        {typeof count === 'number' && (
          <span data-testid="check-count" className={count > 0 ? 'font-semibold' : 'text-muted'}>
            {count === 0
              ? 'No rows affected'
              : `${formatCount(count)} ${count === 1 ? 'row' : 'rows'} affected`}
          </span>
        )}
        {count === null && <span className="text-muted">The check returned no count</span>}
        {item.findQuery && typeof count === 'number' && count > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void find()}
            disabled={rows === 'running'}
          >
            {rows === 'running' ? 'Loading…' : 'Show rows'}
          </Button>
        )}
      </div>
      {error && <p className="text-danger">{error}</p>}
      {rows && rows !== 'running' && <RowsTable result={rows} />}
    </div>
  );
}

function RowsTable({ result }: { readonly result: QueryResult }) {
  const cell = (value: CellValue): string => (value === null ? 'NULL' : formatCell(value));
  return (
    <div className="max-h-48 overflow-auto rounded border border-border">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-panel text-left text-muted">
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} className="px-1.5 py-0.5 font-medium">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {result.rows.map((row, r) => (
            <tr key={r} className="border-t border-border/60">
              {row.map((value, c) => (
                <td key={c} className="max-w-60 truncate px-1.5 py-0.5">
                  {cell(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScriptReview(props: {
  readonly design: TableDesign;
  readonly run: (sql: string) => Promise<QueryResult>;
  readonly engine: string | undefined;
}) {
  const { design } = props;
  const groups = reviewGroups(design);
  const errors = design.issues.filter((i) => i.severity === 'error');
  return (
    <div className="flex flex-col gap-3">
      {!design.transactional && (
        <p
          className="flex items-center gap-1.5 rounded border border-warning/50 bg-warning/10 px-2 py-1 text-xs text-warning"
          data-testid="non-transactional"
        >
          <Icon name="warning" className="h-3.5 w-3.5" />
          {props.engine === 'mariadb' ? 'MariaDB' : 'MySQL'} commits each DDL statement at once: if
          one fails, the ones before it stay applied.
        </p>
      )}
      {errors.length > 0 && (
        <ul
          role="alert"
          className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
        >
          {errors.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}
      {groups.map((group) => (
        <section
          key={group.severity}
          aria-label={group.title}
          data-testid={`review-${group.severity}`}
        >
          <h3 className="mb-1 text-xs font-semibold">{group.title}</h3>
          <ul className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <li
                key={item.id}
                className={cx('rounded border p-2 text-xs', SEVERITY_CLASSES[group.severity])}
              >
                <p>{item.message}</p>
                {(item.checkQuery || item.findQuery) && <CheckResult item={item} run={props.run} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section aria-label="Script">
        <h3 className="mb-1 text-xs font-semibold">
          Script{design.transactional ? ' (one transaction)' : ''}
        </h3>
        <pre
          data-testid="design-script"
          className="max-h-[40vh] overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
        >
          {design.script}
        </pre>
      </section>
    </div>
  );
}

export function SaveReviewDialog(props: {
  readonly design: TableDesign;
  readonly profileId: string;
  readonly engine: string | undefined;
  readonly run: (sql: string) => Promise<QueryResult>;
  readonly save: () => Promise<ScriptOutcome>;
  readonly onClose: () => void;
}) {
  const profiles = useProfiles();
  const production =
    profiles.data?.find((p) => p.id === props.profileId)?.presentation.environment === 'production';
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const risky = hasRisks(props.design);
  const run = async (): Promise<void> => {
    setRunning(true);
    setError(undefined);
    const outcome = await props.save();
    setRunning(false);
    if (outcome.ok) props.onClose();
    else if (!outcome.cancelled) setError(outcome.message);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !running && props.onClose()}
      title="Review and save"
      description={`${props.design.statements.length} ${props.design.statements.length === 1 ? 'statement' : 'statements'} will run.`}
      width="w-[820px]"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={running}>
            Back to the designer
          </Button>
          <Button
            variant={risky || production ? 'danger' : 'primary'}
            onClick={() => void run()}
            disabled={running || !props.design.valid}
          >
            {running ? 'Running…' : production ? 'Run on production' : 'Run script'}
          </Button>
        </>
      }
    >
      {error && (
        <p
          role="alert"
          data-testid="save-error"
          className="mb-3 rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
        >
          {error}
        </p>
      )}
      <ScriptReview design={props.design} run={props.run} engine={props.engine} />
    </Modal>
  );
}

/** "Drop table…" from the explorer: the script, what depends on the table, then Drop. */
export function DropTableDialog(props: {
  readonly target: DesignerTarget & { readonly name: string };
  readonly onClose: () => void;
  readonly onDropped: () => void;
}) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof designTableDrop>>>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const { target } = props;
  useEffect(() => {
    let current = true;
    designTableDrop(target).then(
      (result) => current && setLoaded(result),
      (e: unknown) => current && setError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [target]);
  const run = async (): Promise<void> => {
    if (!loaded) return;
    setRunning(true);
    setError(undefined);
    const outcome = await dropTable(target, loaded.design, loaded.profile, loaded.engine);
    setRunning(false);
    if (outcome.ok) {
      props.onDropped();
      props.onClose();
    } else if (!outcome.cancelled) setError(outcome.message);
  };
  const blocked = loaded !== undefined && !loaded.design.valid;
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && !running && props.onClose()}
      title={`Drop table ${target.name}?`}
      description="The table and all its rows are deleted."
      width="w-[720px]"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={running}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void run()}
            disabled={!loaded || blocked || running}
          >
            {running ? 'Dropping…' : 'Drop table'}
          </Button>
        </>
      }
    >
      {error && (
        <p
          role="alert"
          className="mb-3 rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
        >
          {error}
        </p>
      )}
      {!loaded && !error && (
        <p className="text-xs text-muted">Checking what depends on the table…</p>
      )}
      {loaded && (
        <>
          {loaded.design.issues.filter((i) => i.severity === 'warning').length > 0 && (
            <ul className="mb-3 rounded border border-warning/50 bg-warning/10 p-2 text-xs text-warning">
              {loaded.design.issues
                .filter((i) => i.severity === 'warning')
                .map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
            </ul>
          )}
          <ScriptReview
            design={loaded.design}
            engine={loaded.engine}
            run={(sql) => queryForTable(target, sql)}
          />
        </>
      )}
    </Modal>
  );
}
