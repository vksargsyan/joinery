import { BSON_TYPES, type BsonTypeName } from '@querybara/mongo-tools';
import { useEffect, useMemo, useState } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { formatCount, formatDuration } from '../../lib/format';
import {
  fieldAt,
  schemaRows,
  typeMix,
  useSchemaPanel,
  type SchemaPanelState,
  type TypeShare,
} from '../../state/mongo/schema';
import { Button, Icon, cx } from '../ui';
import { CommandPreview, NoticeBanner, RulesBanners, ShellInput, SmallSelect } from './parts';

/**
 * The schema analysis panel (spec §9): sample size and filter, the run with its elapsed time
 * and a cancel button, the fields as a tree table with type mix bars and the share of documents
 * that have each field, the selected field's top values, and the exports: JSON Schema and
 * `$jsonSchema` validator to a file or the clipboard, or applied as the collection's validator.
 */

const TYPE_COLOURS: Partial<Record<BsonTypeName, string>> = {
  string: 'bg-success',
  int: 'bg-accent',
  long: 'bg-accent/70',
  double: 'bg-accent/50',
  decimal: 'bg-accent/40',
  objectId: 'bg-warning',
  date: 'bg-env-staging',
  bool: 'bg-env-test',
  null: 'bg-muted',
  object: 'bg-env-dev',
  array: 'bg-env-production',
};

function percent(share: number): string {
  const value = share * 100;
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}

export function SchemaPanel({ panel }: { readonly panel: SchemaPanelState }) {
  const sampleSize = useSchemaPanel(panel, (s) => s.sampleSize);
  const filter = useSchemaPanel(panel, (s) => s.filter);
  const filterIssue = useSchemaPanel(panel, (s) => s.filterIssue);
  const running = useSchemaPanel(panel, (s) => s.running);
  const startedAt = useSchemaPanel(panel, (s) => s.startedAt);
  const durationMs = useSchemaPanel(panel, (s) => s.durationMs);
  const result = useSchemaPanel(panel, (s) => s.result);
  const error = useSchemaPanel(panel, (s) => s.error);
  const expanded = useSchemaPanel(panel, (s) => s.expanded);
  const selected = useSchemaPanel(panel, (s) => s.selected);
  const notice = useSchemaPanel(panel, (s) => s.notice);
  const rules = useSchemaPanel(panel, (s) => s.rules);
  const rows = useMemo(() => (result ? schemaRows(result, expanded) : []), [result, expanded]);
  const { db, collection } = panel.target;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-schema-panel"
      aria-label={`${db}.${collection} schema`}
    >
      <div
        className="flex flex-wrap items-end gap-2 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Schema analysis"
      >
        <label className="flex flex-col gap-0.5 text-[11px] font-medium text-muted">
          Sample size
          <input
            type="number"
            min={1}
            max={100000}
            value={sampleSize}
            onChange={(event) => panel.setSampleSize(Number(event.target.value))}
            className="h-7 w-24 rounded border border-border bg-panel-2 px-2 text-xs text-fg"
            data-testid="schema-sample-size"
          />
        </label>
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <label htmlFor={`${panel.id}-filter`} className="text-[11px] font-medium text-muted">
            Filter (optional)
          </label>
          <ShellInput
            id={`${panel.id}-filter`}
            value={filter}
            onChange={(text) => panel.setFilter(text)}
            placeholder="{ status: 'open' }"
            onKeyDown={(event) => event.key === 'Enter' && void panel.run()}
            issue={
              filterIssue ? `${filterIssue.message} (column ${filterIssue.column})` : undefined
            }
            data-testid="schema-filter"
          />
        </div>
        {running ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => panel.cancel()}
            data-testid="schema-cancel"
          >
            <Icon name="stop" className="h-3.5 w-3.5" />
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void panel.run()}
            data-testid="schema-run"
          >
            <Icon name="play" className="h-3.5 w-3.5" />
            Analyse
          </Button>
        )}
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
      </div>
      <RulesBanners rules={rules} what="validators" />
      <NoticeBanner notice={notice} onDismiss={() => panel.dismissNotice()} />
      <Progress running={running} startedAt={startedAt} sampleSize={sampleSize} />
      {error && (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-[3] overflow-auto">
          {result && (
            <>
              <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
                <span data-testid="schema-summary">
                  {formatCount(result.documentCount)} documents sampled ·{' '}
                  {formatCount(result.fields.length)} top-level fields
                  {durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : ''}
                </span>
                {result.truncated && (
                  <span className="text-warning">Field limit reached: some paths are missing</span>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => panel.expandAll(true)}>
                  Expand all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => panel.expandAll(false)}>
                  Collapse all
                </Button>
              </div>
              <table className="w-full border-collapse text-xs" data-testid="schema-fields">
                <thead className="sticky top-0 bg-panel text-left text-muted">
                  <tr>
                    <th className="border-b border-border px-2 py-1 font-medium">Field</th>
                    <th className="w-[34%] border-b border-border px-2 py-1 font-medium">Types</th>
                    <th className="w-[18%] border-b border-border px-2 py-1 font-medium">
                      In documents
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.key}
                      data-field={row.key}
                      aria-selected={selected === row.key}
                      className={cx(
                        'cursor-default hover:bg-hover',
                        selected === row.key && 'bg-accent/10',
                      )}
                      onClick={() => panel.select(row.key)}
                    >
                      <td className="border-b border-border px-2 py-1 font-mono">
                        <span
                          className="flex items-center gap-1"
                          style={{ paddingLeft: row.depth * 14 }}
                        >
                          {row.expandable ? (
                            <button
                              type="button"
                              aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.key}`}
                              className="rounded hover:bg-hover"
                              onClick={(event) => {
                                event.stopPropagation();
                                panel.toggle(row.key);
                              }}
                            >
                              <Icon
                                name={row.expanded ? 'chevron-down' : 'chevron-right'}
                                className="h-3 w-3"
                              />
                            </button>
                          ) : (
                            <span className="w-3" />
                          )}
                          {row.field.name}
                        </span>
                      </td>
                      <td className="border-b border-border px-2 py-1">
                        <TypeBar types={row.types} />
                      </td>
                      <td className="border-b border-border px-2 py-1">
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-16 overflow-hidden rounded bg-panel-2">
                            <span
                              className="block h-full bg-accent"
                              style={{ width: `${Math.round(row.field.share * 100)}%` }}
                            />
                          </span>
                          <span data-testid="schema-share">{percent(row.field.share)}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!result && !running && !error && (
            <p className="p-4 text-sm text-muted">Analyse a sample to see the fields.</p>
          )}
        </div>
        <aside className="flex w-[340px] shrink-0 flex-col gap-3 overflow-auto border-l border-border p-2 text-xs">
          <FieldDetail panel={panel} path={selected} />
          {result && <Exports panel={panel} />}
        </aside>
      </div>
    </div>
  );
}

function Progress(props: {
  readonly running: boolean;
  readonly startedAt: number | undefined;
  readonly sampleSize: number;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!props.running) return undefined;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [props.running]);
  if (!props.running) return null;
  const elapsed = props.startedAt === undefined ? 0 : Math.max(0, now - props.startedAt);
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs"
      data-testid="schema-progress"
    >
      <span className="h-1 w-24 overflow-hidden rounded bg-panel-2">
        <span className="block h-full w-1/3 animate-pulse bg-accent" />
      </span>
      Sampling {formatCount(props.sampleSize)} documents and analysing them…{' '}
      {formatDuration(elapsed)}
    </div>
  );
}

function TypeBar(props: { readonly types: readonly TypeShare[] }) {
  return (
    <span className="flex items-center gap-1.5" data-testid="schema-types">
      <span className="flex h-2 w-24 shrink-0 overflow-hidden rounded bg-panel-2">
        {props.types.map((t) => (
          <span
            key={t.type}
            className={cx('h-full', TYPE_COLOURS[t.type] ?? 'bg-fg/40')}
            style={{ width: `${t.share * 100}%` }}
            title={`${BSON_TYPES[t.type].label}: ${percent(t.share)}`}
          />
        ))}
      </span>
      <span className="truncate text-[11px]">
        {props.types.map((t) => `${BSON_TYPES[t.type].label} ${percent(t.share)}`).join(', ')}
      </span>
    </span>
  );
}

function FieldDetail(props: {
  readonly panel: SchemaPanelState;
  readonly path: string | undefined;
}) {
  const result = useSchemaPanel(props.panel, (s) => s.result);
  const field = result && props.path !== undefined ? fieldAt(result, props.path) : undefined;
  if (!field) return <p className="text-muted">Select a field to see its values.</p>;
  return (
    <section className="flex flex-col gap-1.5" data-testid="schema-field-detail">
      <h3 className="font-mono text-[13px] font-semibold">{field.path}</h3>
      <p className="text-muted">
        Query path <span className="font-mono text-fg">{field.queryPath}</span> · in{' '}
        {formatCount(field.documents)} of {formatCount(result!.documentCount)} documents (
        {percent(field.share)}) · {formatCount(field.count)} values
      </p>
      {field.arrayLengths && (
        <p className="text-muted">
          Array lengths {field.arrayLengths.min}–{field.arrayLengths.max}, average{' '}
          {field.arrayLengths.average.toFixed(1)}
        </p>
      )}
      <TypeBar types={typeMix(field)} />
      <h4 className="mt-1 text-[11px] font-medium text-muted">
        Top values{field.topValuesExact ? '' : ' (approximate)'}
        {field.distinctValues !== undefined
          ? ` · ${formatCount(field.distinctValues)} distinct`
          : ''}
      </h4>
      {field.topValues.length === 0 ? (
        <p className="text-muted">No scalar values to count.</p>
      ) : (
        <ol className="flex flex-col gap-0.5" data-testid="schema-top-values">
          {field.topValues.map((value) => (
            <li key={value.value} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono" title={value.display}>
                {value.display}
              </span>
              <span className="text-muted">{formatCount(value.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Exports({ panel }: { readonly panel: SchemaPanelState }) {
  const threshold = useSchemaPanel(panel, (s) => s.requiredThreshold);
  const level = useSchemaPanel(panel, (s) => s.validationLevel);
  const action = useSchemaPanel(panel, (s) => s.validationAction);
  const rules = useSchemaPanel(panel, (s) => s.rules);
  useSchemaPanel(panel, (s) => s.result);
  const copy = (kind: 'json-schema' | 'validator'): void => {
    const text = panel.exportText(kind);
    if (text !== undefined && copyToClipboard(text)) {
      panel.noteCopied(kind === 'json-schema' ? 'JSON Schema' : 'Validator');
    }
  };
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-2" aria-label="Export">
      <h3 className="text-[11px] font-medium text-muted">Export</h3>
      <label className="flex items-center gap-2">
        Required when in
        <SmallSelect
          value={String(threshold)}
          onChange={(event) => panel.setRequiredThreshold(Number(event.target.value))}
          className="w-28"
          aria-label="Required threshold"
        >
          <option value="1">all documents</option>
          <option value="0.99">99%</option>
          <option value="0.9">90%</option>
          <option value="0.5">half</option>
        </SmallSelect>
      </label>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => void panel.saveExport('json-schema')}>
          Save JSON Schema…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copy('json-schema')}>
          Copy
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => void panel.saveExport('validator')}>
          Save $jsonSchema validator…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copy('validator')}>
          Copy
        </Button>
      </div>
      <h3 className="mt-2 text-[11px] font-medium text-muted">Apply as validator</h3>
      <div className="flex gap-2">
        <SmallSelect
          value={level}
          aria-label="Validation level"
          onChange={(event) =>
            panel.setValidation({ level: event.target.value as 'strict' | 'moderate' | 'off' })
          }
          className="w-full"
        >
          <option value="strict">strict</option>
          <option value="moderate">moderate</option>
          <option value="off">off</option>
        </SmallSelect>
        <SmallSelect
          value={action}
          aria-label="Validation action"
          onChange={(event) =>
            panel.setValidation({ action: event.target.value as 'error' | 'warn' | 'errorAndLog' })
          }
          className="w-full"
        >
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="errorAndLog">errorAndLog</option>
        </SmallSelect>
      </div>
      <CommandPreview command={panel.applyCommand()} testId="schema-apply-command" />
      <Button
        size="sm"
        variant="primary"
        disabled={rules.readOnlyProfile || panel.target.kind === 'view'}
        onClick={() => void panel.applyValidator()}
        data-testid="schema-apply"
      >
        Apply as validator…
      </Button>
    </section>
  );
}
