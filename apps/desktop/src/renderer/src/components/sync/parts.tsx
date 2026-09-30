import type { OperationKind } from '@joinery/sync';
import { useState, type ReactNode } from 'react';

import type { RunningJob } from '../../state/sync/structure';
import { TextField } from '../designer/fields';
import { Button, Icon, cx } from '../ui';

/** Small pieces both compare panels use: banners, badges, the running job bar, saving. */

const KIND_CLASSES: Readonly<Record<OperationKind, string>> = {
  create: 'bg-success/15 text-success',
  alter: 'bg-warning/15 text-warning',
  drop: 'bg-danger/15 text-danger',
  rename: 'bg-accent/15 text-accent',
};

/** A create / alter / drop / rename badge, with a count when given. */
export function KindBadge(props: { readonly kind: OperationKind; readonly count?: number }) {
  return (
    <span
      className={cx(
        'rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase',
        KIND_CLASSES[props.kind],
      )}
    >
      {props.count !== undefined ? `${props.count} ` : ''}
      {props.kind}
    </span>
  );
}

export function Banner(props: {
  readonly tone: 'error' | 'notice' | 'warning';
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <p
      role={props.tone === 'error' ? 'alert' : 'status'}
      data-testid={props.testId}
      className={cx(
        'flex items-start gap-1.5 rounded border px-2 py-1 text-xs',
        props.tone === 'error' && 'border-danger/50 bg-danger/10 text-danger',
        props.tone === 'warning' && 'border-warning/50 bg-warning/10 text-warning',
        props.tone === 'notice' && 'border-success/40 bg-success/10 text-fg',
      )}
    >
      {props.tone !== 'notice' && <Icon name="warning" className="mt-px h-3.5 w-3.5" />}
      <span className="min-w-0 flex-1 break-words">{props.children}</span>
    </p>
  );
}

/** The running compare or apply: its phase and a Cancel button. */
export function RunningBar(props: { readonly running: RunningJob; readonly onCancel: () => void }) {
  const { running } = props;
  return (
    <div
      className="flex items-center gap-2 rounded border border-border bg-panel-2 px-2 py-1 text-xs"
      data-testid="sync-running"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      <span className="font-medium">{running.kind === 'compare' ? 'Comparing' : 'Applying'}</span>
      <span className="min-w-0 flex-1 truncate text-muted" role="status">
        {running.cancelling ? 'Cancelling…' : running.phase}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={props.onCancel}
        disabled={running.jobId === undefined || running.cancelling}
      >
        Cancel
      </Button>
    </div>
  );
}

/** "Save…" → a name field → Save; the saved comparison's name once it has one. */
export function SaveComparison(props: {
  readonly saved: { readonly name: string } | undefined;
  readonly suggested: string;
  readonly onSave: (name: string) => Promise<boolean>;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const save = async (): Promise<void> => {
    if (name.trim() === '') return;
    if (await props.onSave(name.trim())) setNaming(false);
  };
  if (naming) {
    return (
      <span className="flex items-center gap-1">
        <span className="w-48">
          <TextField
            aria-label="Comparison name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') setNaming(false);
            }}
          />
        </span>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!name.trim()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        setName(props.saved?.name ?? props.suggested);
        setNaming(true);
      }}
    >
      {props.saved ? 'Save' : 'Save comparison…'}
    </Button>
  );
}

/** A labelled checkbox. */
export function Check(props: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: string | undefined;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-1.5 text-xs" title={props.hint}>
      <input
        type="checkbox"
        className="mt-0.5"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>
        {props.label}
        {props.hint && <span className="block text-[10px] text-muted">{props.hint}</span>}
      </span>
    </label>
  );
}
