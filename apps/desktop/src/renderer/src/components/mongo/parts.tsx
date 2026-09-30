import {
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

import type { Notice } from '../../state/mongo/collection-view';
import type { WriteRules } from '../../state/mongo/write-rules';
import { Button, Icon, Input, Modal, cx } from '../ui';

/**
 * Small pieces the MongoDB panels share: banners for the write rules and notices, the command
 * preview every change shows before it runs, a segmented switch and a one-field name dialog.
 */

export function Banner(props: {
  readonly kind: 'info' | 'warning' | 'error' | 'success';
  readonly children: ReactNode;
  readonly testId?: string;
  readonly onDismiss?: () => void;
}) {
  return (
    <div
      role={props.kind === 'error' ? 'alert' : 'status'}
      data-testid={props.testId}
      className={cx(
        'flex items-center gap-2 border-b px-3 py-1 text-xs',
        props.kind === 'error' && 'border-danger/40 bg-danger/10 text-danger',
        props.kind === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
        props.kind === 'success' && 'border-success/30 bg-success/10 text-success',
        props.kind === 'info' && 'border-border bg-panel-2 text-fg',
      )}
    >
      {(props.kind === 'error' || props.kind === 'warning') && (
        <Icon name="warning" className="h-3.5 w-3.5" />
      )}
      <span className="flex flex-1 flex-wrap items-center gap-2">{props.children}</span>
      {props.onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          className="rounded p-0.5 hover:bg-hover"
          onClick={props.onDismiss}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** The read-only and production banners of a panel that can write. */
export function RulesBanners(props: { readonly rules: WriteRules; readonly what: string }) {
  if (props.rules.readOnlyProfile) {
    return (
      <Banner kind="info">
        This connection is read-only: {props.what} can be viewed, not changed.
      </Banner>
    );
  }
  if (props.rules.production) {
    return <Banner kind="warning">Production connection: every change asks before it runs.</Banner>;
  }
  return null;
}

/** A panel's notice, dismissable. */
export function NoticeBanner(props: {
  readonly notice: Notice | undefined;
  readonly onDismiss: () => void;
}) {
  if (!props.notice) return null;
  return (
    <Banner
      kind={
        props.notice.kind === 'error'
          ? 'error'
          : props.notice.kind === 'success'
            ? 'success'
            : 'info'
      }
      testId="mongo-notice"
      onDismiss={props.onDismiss}
    >
      {props.notice.text}
    </Banner>
  );
}

/** The exact command a form runs, shown as it is typed. */
export function CommandPreview(props: {
  readonly command: string | undefined;
  readonly label?: string;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">{props.label ?? 'Runs'}</span>
      <pre
        data-testid={props.testId ?? 'mongo-command'}
        className="max-h-48 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text [overflow-wrap:anywhere]"
      >
        {props.command ?? '—'}
      </pre>
    </div>
  );
}

/** A small segmented switch (radio group). */
export function Segmented<T extends string>(props: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  return (
    <div className="flex rounded border border-border" role="radiogroup" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          disabled={props.disabled}
          className={cx(
            'px-2 py-0.5 text-xs disabled:opacity-50',
            props.value === option.value ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover',
          )}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A dialog asking for one name (save as, rename). */
export function NameDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly label: string;
  readonly initial: string;
  readonly confirmLabel: string;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(props.initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.open) setName(props.initial);
  }, [props.open, props.initial]);
  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={props.title}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === ''}
            onClick={() => props.onSubmit(name.trim())}
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') props.onSubmit(name.trim());
        }}
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          {props.label}
          <Input
            ref={input}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="name-dialog-input"
          />
        </label>
      </form>
    </Modal>
  );
}

/** A label above a control. */
export function Labelled(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-0.5', props.className)}>
      <label htmlFor={props.htmlFor} className="text-[11px] font-medium text-muted">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p role="alert" className="text-[11px] text-danger">
          {props.error}
        </p>
      ) : props.hint ? (
        <p className="text-[11px] text-muted">{props.hint}</p>
      ) : null}
    </div>
  );
}

const SMALL_CONTROL =
  'h-7 rounded border border-border bg-panel-2 px-1.5 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50';

/** A compact select whose width the caller sets (the shared Select is full width). */
export function SmallSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select {...rest} className={cx(SMALL_CONTROL, className)} />;
}

/**
 * A one-line field for mongosh text (a filter, a collation, custom data), in the monospace
 * style of the collection view's query bar; `issue` marks it invalid and shows the parser's
 * message under it.
 */
export function ShellInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
    readonly value: string;
    readonly onChange: (text: string) => void;
    readonly issue?: string | undefined;
  },
) {
  const { value, onChange, issue, className, ...rest } = props;
  return (
    <>
      <input
        {...rest}
        value={value}
        spellCheck={false}
        aria-invalid={issue !== undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          SMALL_CONTROL,
          'w-full px-2 font-mono placeholder:text-muted/60 aria-[invalid=true]:border-danger',
          className,
        )}
      />
      {issue !== undefined && (
        <span role="alert" className="text-[11px] text-danger">
          {issue}
        </span>
      )}
    </>
  );
}
