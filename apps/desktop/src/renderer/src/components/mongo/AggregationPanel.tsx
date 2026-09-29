import { useState } from 'react';

import { formatCount } from '../../lib/format';
import {
  useAggregation,
  type AggregationEditor,
  type AggregationTab,
} from '../../state/mongo/aggregation';
import { useResults } from '../../state/mongo/results';
import { useTheme } from '../theme';
import { Button, Icon } from '../ui';
import { ExplainView } from './ExplainView';
import { NameDialog, NoticeBanner, RulesBanners, Segmented, SmallSelect } from './parts';
import { ResultViews } from './ResultViews';
import { ShellEditor } from './ShellEditor';
import { StageCards } from './StageCards';

/**
 * The aggregation editor panel (spec §9): stage cards with their previews on a sample (or the
 * pipeline as one text), the sample settings, saved pipelines, and below them the full run in
 * the tree, table and JSON views, or the explain view.
 */
export function AggregationPanel({ editor }: { readonly editor: AggregationEditor }) {
  const theme = useTheme();
  const mode = useAggregation(editor, (s) => s.mode);
  const stages = useAggregation(editor, (s) => s.stages);
  const checks = useAggregation(editor, (s) => s.checks);
  const previews = useAggregation(editor, (s) => s.previews);
  const text = useAggregation(editor, (s) => s.text);
  const textIssue = useAggregation(editor, (s) => s.textIssue);
  const sampleSize = useAggregation(editor, (s) => s.sampleSize);
  const sampling = useAggregation(editor, (s) => s.sampling);
  const autoPreview = useAggregation(editor, (s) => s.autoPreview);
  const running = useAggregation(editor, (s) => s.running);
  const tab = useAggregation(editor, (s) => s.tab);
  const explain = useAggregation(editor, (s) => s.explain);
  const notice = useAggregation(editor, (s) => s.notice);
  const rules = useAggregation(editor, (s) => s.rules);
  const saved = useAggregation(editor, (s) => s.saved);
  const current = useAggregation(editor, (s) => s.current);
  const [naming, setNaming] = useState(false);
  const { db, collection } = editor.target;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-aggregation-panel"
      aria-label={`${db}.${collection} aggregation`}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Aggregation"
      >
        <Button
          size="sm"
          variant="primary"
          onClick={() => void editor.run()}
          disabled={running}
          title="Run the enabled stages"
          data-testid="aggregation-run"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Run
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void editor.explain('executionStats')}>
          Explain
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void editor.explain('queryPlanner')}>
          Plan only
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Segmented
          label="Edit as"
          value={mode}
          options={[
            { value: 'stages', label: 'Stages' },
            { value: 'text', label: 'Text' },
          ]}
          onChange={(value) => editor.setMode(value)}
        />
        <span className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1 text-xs text-muted">
          Sample
          <input
            type="number"
            min={1}
            max={100000}
            value={sampleSize}
            onChange={(event) => editor.setSampleSize(Number(event.target.value))}
            className="h-6 w-20 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
            aria-label="Preview sample size"
            data-testid="aggregation-sample-size"
          />
        </label>
        <select
          aria-label="Sampling"
          value={sampling}
          onChange={(event) => editor.setSampling(event.target.value as 'limit' | 'sample')}
          className="h-6 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
          data-testid="aggregation-sampling"
        >
          <option value="limit">first documents ($limit)</option>
          <option value="sample">random ($sample)</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            checked={autoPreview}
            onChange={(event) => editor.setAutoPreview(event.target.checked)}
          />
          Auto preview
        </label>
        <Button size="sm" variant="ghost" onClick={() => void editor.previewAll()}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Preview all
        </Button>
        <span className="flex-1" />
        <SmallSelect
          aria-label="Saved pipelines"
          value={current?.id ?? ''}
          onChange={(event) => event.target.value && editor.load(event.target.value)}
          className="w-44"
          data-testid="aggregation-saved"
        >
          <option value="">{saved.length === 0 ? 'No saved pipelines' : 'Open saved…'}</option>
          {saved.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </SmallSelect>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (current ? void editor.save() : setNaming(true))}
          title={current ? `Save over "${current.name}"` : 'Save the pipeline under a name'}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
          Save as…
        </Button>
        {current && (
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => void editor.deleteSaved(current.id)}
          >
            Delete
          </Button>
        )}
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
      </div>
      <RulesBanners rules={rules} what="$out and $merge results" />
      <NoticeBanner notice={notice} onDismiss={() => editor.dismissNotice()} />
      <div className="min-h-0 flex-[3] overflow-auto p-2" data-testid="aggregation-stages">
        {mode === 'stages' ? (
          <StageCards
            stages={stages}
            checks={checks}
            previews={previews}
            sampleSize={sampleSize}
            theme={theme}
            actions={{
              add: (after) => editor.addStage(after),
              remove: (id) => editor.removeStage(id),
              move: (from, to) => editor.moveStage(from, to),
              toggle: (id) => editor.toggleStage(id),
              setOperator: (id, op) => editor.setOperator(id, op),
              setBody: (id, body) => editor.setBody(id, body),
              preview: (index) => void editor.previewStage(index),
            }}
          />
        ) : (
          <div className="flex h-full min-h-[240px] flex-col gap-1">
            <p className="text-[11px] text-muted">
              The whole pipeline in mongosh syntax. Stages commented out with // are disabled
              stages; the cards follow the text while it parses.
            </p>
            <div className="min-h-0 flex-1 rounded border border-border">
              <ShellEditor
                value={text}
                onChange={(value) => editor.setText(value)}
                theme={theme}
                issue={textIssue}
                onRun={() => void editor.run()}
                ariaLabel="Pipeline text"
                testId="aggregation-text"
              />
            </div>
            {textIssue && (
              <p
                role="alert"
                className="text-[11px] text-danger"
                data-testid="aggregation-text-issue"
              >
                {textIssue.message} (line {textIssue.line}, column {textIssue.column})
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-[2] flex-col border-t border-border">
        <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1">
          <Segmented<AggregationTab>
            label="Result view"
            value={tab}
            options={[
              { value: 'tree', label: 'Tree' },
              { value: 'table', label: 'Table' },
              { value: 'json', label: 'JSON' },
              { value: 'explain', label: 'Explain' },
            ]}
            onChange={(value) => editor.setTab(value)}
          />
          <RunSummary editor={editor} />
        </div>
        <div className="min-h-0 flex-1">
          {tab === 'explain' ? <ExplainView explain={explain} /> : <RunResults editor={editor} />}
        </div>
      </div>
      <NameDialog
        open={naming}
        title="Save the pipeline"
        label="Name"
        initial={current?.name ?? ''}
        confirmLabel="Save"
        onClose={() => setNaming(false)}
        onSubmit={(name) => {
          setNaming(false);
          void editor.save(name);
        }}
      />
    </div>
  );
}

function RunResults({ editor }: { readonly editor: AggregationEditor }) {
  const ran = useAggregation(editor, (s) => s.ran);
  if (!ran) {
    return (
      <p className="p-4 text-sm text-muted">
        Run the pipeline to see all of its results here; each stage shows a preview above.
      </p>
    );
  }
  return <ResultViews results={editor.results} />;
}

function RunSummary({ editor }: { readonly editor: AggregationEditor }) {
  const loaded = useResults(editor.results, (s) => s.documents.length);
  const hasMore = useResults(editor.results, (s) => s.hasMore);
  const durationMs = useAggregation(editor, (s) => s.durationMs);
  const ran = useAggregation(editor, (s) => s.ran);
  const running = useAggregation(editor, (s) => s.running);
  if (!ran) return null;
  return (
    <span className="text-xs text-muted" data-testid="aggregation-count" aria-live="polite">
      {running
        ? 'Running…'
        : `${formatCount(loaded)} ${loaded === 1 ? 'document' : 'documents'}${hasMore ? ' (more on scroll)' : ''}${durationMs !== undefined ? ` · first page in ${durationMs} ms` : ''}`}
    </span>
  );
}
