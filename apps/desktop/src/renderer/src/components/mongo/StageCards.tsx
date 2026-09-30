import { formatShellInline, fromEjson, stageInfo } from '@joinery/mongo-tools';
import { useState, type DragEvent, type KeyboardEvent } from 'react';

import { formatCount } from '../../lib/format';
import type { StagePreviewState } from '../../state/mongo/aggregation';
import { operatorChoices, type PipelineStage, type StageCheck } from '../../state/mongo/stage-list';
import { Button, Icon, cx } from '../ui';
import { ShellEditor } from './ShellEditor';

/**
 * The aggregation stage cards (spec §9): per stage the operator picker with the stage's docs
 * line, its body in mongosh syntax (checked as typed, the error marked where it is), an on/off
 * switch, reordering by drag and drop or from the keyboard (Alt+↑/↓ on the handle, or the move
 * buttons), and optionally the stage's preview on a sample. The aggregation editor and the
 * create view dialog both use them.
 */

export interface StageActions {
  readonly add: (afterIndex: number) => void;
  readonly remove: (id: string) => void;
  readonly move: (from: number, to: number) => void;
  readonly toggle: (id: string) => void;
  readonly setOperator: (id: string, operator: string) => void;
  readonly setBody: (id: string, body: string) => void;
  readonly preview?: (index: number) => void;
}

const DRAG_TYPE = 'application/x-joinery-stage';

/** Editor height for a body: its lines, between 3 and 14. */
function editorHeight(body: string): number {
  const lines = Math.min(14, Math.max(3, body.split('\n').length + 1));
  return lines * 19 + 8;
}

export function StageCards(props: {
  readonly stages: readonly PipelineStage[];
  readonly checks: Readonly<Record<string, StageCheck>>;
  readonly actions: StageActions;
  readonly theme: 'dark' | 'light';
  readonly previews?: Readonly<Record<string, StagePreviewState>>;
  readonly sampleSize?: number;
  readonly readOnly?: boolean;
}) {
  const { stages, actions } = props;
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const [over, setOver] = useState<number | undefined>(undefined);

  const onDrop = (event: DragEvent, index: number): void => {
    event.preventDefault();
    const from = Number(event.dataTransfer.getData(DRAG_TYPE));
    setDragging(undefined);
    setOver(undefined);
    if (Number.isInteger(from) && from !== index) actions.move(from, index);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="stage-cards">
      <ol className="flex flex-col gap-2" aria-label="Pipeline stages">
        {stages.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            index={index}
            count={stages.length}
            check={props.checks[stage.id]}
            preview={props.previews?.[stage.id]}
            showPreview={props.previews !== undefined}
            sampleSize={props.sampleSize}
            actions={actions}
            theme={props.theme}
            dragging={dragging === index}
            dropTarget={over === index && dragging !== undefined && dragging !== index}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, String(index));
              event.dataTransfer.effectAllowed = 'move';
              setDragging(index);
            }}
            onDragEnd={() => {
              setDragging(undefined);
              setOver(undefined);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setOver(index);
            }}
            onDrop={(event) => onDrop(event, index)}
          />
        ))}
      </ol>
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => actions.add(stages.length - 1)}
          disabled={props.readOnly}
          data-testid="stage-add"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add stage
        </Button>
      </div>
    </div>
  );
}

function StageCard(props: {
  readonly stage: PipelineStage;
  readonly index: number;
  readonly count: number;
  readonly check: StageCheck | undefined;
  readonly preview: StagePreviewState | undefined;
  readonly showPreview: boolean;
  readonly sampleSize: number | undefined;
  readonly actions: StageActions;
  readonly theme: 'dark' | 'light';
  readonly dragging: boolean;
  readonly dropTarget: boolean;
  readonly onDragStart: (event: DragEvent) => void;
  readonly onDragEnd: () => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDrop: (event: DragEvent) => void;
}) {
  const { stage, index, actions, check } = props;
  const info = stageInfo(stage.operator);
  const number = index + 1;
  const onHandleKey = (event: KeyboardEvent): void => {
    if (!event.altKey) return;
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      actions.move(index, index - 1);
    } else if (event.key === 'ArrowDown' && index < props.count - 1) {
      event.preventDefault();
      actions.move(index, index + 1);
    }
  };
  return (
    <li
      data-testid="stage-card"
      data-stage-index={index}
      data-operator={stage.operator}
      data-enabled={stage.enabled}
      aria-label={`Stage ${number}: ${stage.operator}${stage.enabled ? '' : ' (disabled)'}`}
      className={cx(
        'rounded border bg-panel',
        props.dropTarget ? 'border-accent ring-1 ring-accent' : 'border-border',
        props.dragging && 'opacity-50',
        !stage.enabled && 'opacity-70',
      )}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <button
          type="button"
          draggable
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onKeyDown={onHandleKey}
          aria-label={`Reorder stage ${number} (drag, or Alt+Up / Alt+Down)`}
          title="Drag to reorder, or Alt+Up / Alt+Down"
          className="cursor-grab rounded px-1 font-mono text-muted hover:bg-hover active:cursor-grabbing"
          data-testid="stage-handle"
        >
          ⠿
        </button>
        <span className="text-xs font-semibold text-muted">{number}</span>
        <select
          aria-label={`Stage ${number} operator`}
          value={stage.operator}
          onChange={(event) => actions.setOperator(stage.id, event.target.value)}
          className="h-6 rounded border border-border bg-panel-2 px-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
          data-testid="stage-operator"
        >
          {operatorChoices(stage.operator).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            checked={stage.enabled}
            onChange={() => actions.toggle(stage.id)}
            aria-label={`Stage ${number} enabled`}
            data-testid="stage-enabled"
          />
          Enabled
        </label>
        <span className="flex-1 truncate px-1 text-[11px] text-muted" data-testid="stage-docs">
          {info?.description ?? 'Not in the stage list'}
          {info?.position === 'first' ? ' · must be first' : ''}
          {info?.position === 'last' ? ' · must be last' : ''}
          {info?.writes ? ' · writes' : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move stage ${number} up`}
          disabled={index === 0}
          onClick={() => actions.move(index, index - 1)}
        >
          ↑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move stage ${number} down`}
          disabled={index === props.count - 1}
          onClick={() => actions.move(index, index + 1)}
        >
          ↓
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Add a stage after stage ${number}`}
          onClick={() => actions.add(index)}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove stage ${number}`}
          onClick={() => actions.remove(stage.id)}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className={cx('flex gap-2 p-2', !props.showPreview && 'flex-col')}>
        <div className={cx('flex min-w-0 flex-col gap-1', props.showPreview ? 'w-1/2' : 'w-full')}>
          <div
            className="rounded border border-border"
            style={{ height: editorHeight(stage.body) }}
          >
            <ShellEditor
              value={stage.body}
              onChange={(text) => actions.setBody(stage.id, text)}
              theme={props.theme}
              issue={check?.issue}
              ariaLabel={`Stage ${number} ${stage.operator} body`}
              testId="stage-body"
            />
          </div>
          {check?.issue && (
            <p role="alert" className="text-[11px] text-danger" data-testid="stage-issue">
              {check.issue.message} (line {check.issue.line}, column {check.issue.column})
            </p>
          )}
          {!check?.issue && check?.warning && (
            <p className="text-[11px] text-warning" data-testid="stage-warning">
              {check.warning}
            </p>
          )}
        </div>
        {props.showPreview && (
          <StagePreview
            preview={props.preview}
            sampleSize={props.sampleSize}
            onPreview={actions.preview ? () => actions.preview!(index) : undefined}
          />
        )}
      </div>
    </li>
  );
}

function StagePreview(props: {
  readonly preview: StagePreviewState | undefined;
  readonly sampleSize: number | undefined;
  readonly onPreview: (() => void) | undefined;
}) {
  const { preview } = props;
  return (
    <div
      className="flex w-1/2 min-w-0 flex-col gap-1 rounded border border-border bg-panel-2 p-1.5"
      data-testid="stage-preview"
      data-status={preview?.status ?? 'idle'}
    >
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="flex-1" data-testid="stage-preview-summary">
          {preview === undefined || preview.status === 'idle'
            ? 'No preview yet'
            : preview.status === 'loading'
              ? 'Previewing…'
              : preview.status === 'done'
                ? `${formatCount(preview.documents.length)} ${preview.documents.length === 1 ? 'document' : 'documents'} from a sample of ${formatCount(props.sampleSize ?? 0)}${preview.durationMs !== undefined ? ` · ${preview.durationMs} ms` : ''}`
                : preview.status === 'skipped'
                  ? 'Not previewed'
                  : 'Preview failed'}
        </span>
        {props.onPreview && (
          <Button size="sm" variant="ghost" onClick={props.onPreview} className="h-5 px-1.5">
            <Icon name="refresh" className="h-3 w-3" />
            Preview
          </Button>
        )}
      </div>
      {preview?.message && (
        <p
          className={cx('text-[11px]', preview.status === 'error' ? 'text-danger' : 'text-muted')}
          role={preview.status === 'error' ? 'alert' : undefined}
        >
          {preview.message}
        </p>
      )}
      {preview !== undefined && preview.documents.length > 0 && (
        <ol
          className="max-h-44 overflow-auto font-mono text-[11px] select-text"
          aria-label="Preview documents"
        >
          {preview.documents.map((doc, i) => (
            <li
              key={i}
              className="truncate border-b border-border/60 py-0.5 last:border-b-0"
              title={docText(doc)}
              data-testid="stage-preview-document"
            >
              {docText(doc)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function docText(ejson: string): string {
  try {
    return formatShellInline(fromEjson(ejson, 'document'), { maxStringLength: 80 });
  } catch {
    return ejson;
  }
}
