import type { ValidationIssue } from '@joinery/sync';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { cx } from '../ui';

/** Compact form controls for the designer's tables, marked invalid when an issue names them. */

const BASE =
  'h-7 w-full min-w-0 rounded border bg-panel-2 px-1.5 text-xs text-fg focus:border-accent focus:outline-none';

export function TextField(
  props: InputHTMLAttributes<HTMLInputElement> & {
    readonly invalid?: boolean;
    readonly mono?: boolean;
  },
) {
  const { invalid, mono, className, ...rest } = props;
  return (
    <input
      spellCheck={false}
      aria-invalid={invalid || undefined}
      className={cx(
        BASE,
        invalid ? 'border-danger' : 'border-border',
        mono && 'font-mono',
        className,
      )}
      {...rest}
    />
  );
}

export function SelectField(
  props: SelectHTMLAttributes<HTMLSelectElement> & { readonly invalid?: boolean },
) {
  const { invalid, className, ...rest } = props;
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cx(BASE, 'px-1', invalid ? 'border-danger' : 'border-border', className)}
      {...rest}
    />
  );
}

export function TextArea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & { readonly invalid?: boolean },
) {
  const { invalid, className, ...rest } = props;
  return (
    <textarea
      spellCheck={false}
      aria-invalid={invalid || undefined}
      className={cx(
        'w-full rounded border bg-panel-2 p-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none',
        invalid ? 'border-danger' : 'border-border',
        className,
      )}
      {...rest}
    />
  );
}

/** The issues for one place, shown under it: errors red, warnings amber. */
export function Issues(props: {
  readonly issues: readonly ValidationIssue[];
  readonly className?: string;
}) {
  if (props.issues.length === 0) return null;
  return (
    <ul
      className={cx('flex flex-col gap-0.5 text-[11px]', props.className)}
      data-testid="design-issues"
    >
      {props.issues.map((issue, i) => (
        <li
          key={`${issue.code}:${i}`}
          role={issue.severity === 'error' ? 'alert' : undefined}
          className={issue.severity === 'error' ? 'text-danger' : 'text-warning'}
        >
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** A labelled control in the details panes. */
export function Labeled(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly hint?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-0.5 text-[11px] text-muted', props.className)}>
      {props.label}
      {props.children}
      {props.hint && <span className="text-[10px]">{props.hint}</span>}
    </label>
  );
}

/**
 * Splits a comma-separated list at the top level: commas inside parentheses or quotes belong
 * to the item (index expressions, quoted names).
 */
export function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      if (current.trim() !== '') items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

/** A plain list of names as typed ("a, b"). */
export function namesOf(text: string): string[] {
  return splitTopLevel(text);
}
