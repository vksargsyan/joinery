import type { Environment } from '@joinery/core';
import { Dialog as RadixDialog } from 'radix-ui';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/**
 * Small building blocks shared by the app: buttons, fields, badges and the dialog frame, in the
 * Kiln design system's VS Code geometry (26px controls, 2px corners). Rust is the only fill: one
 * primary per view; a destructive action is a secondary button with red text, never a red fill.
 */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Kiln's panel titles, for every tab strip inside a panel: muted until hovered, the active one
 * `fg` with a rust underline. Works for `role="tab"` buttons (aria-selected) and Radix triggers
 * (data-state). The strip itself carries the bottom border.
 */
export const TAB =
  '-mb-px inline-flex items-center gap-1.5 border-b border-transparent px-2.5 py-1.5 text-xs whitespace-nowrap text-muted hover:text-fg aria-selected:border-accent aria-selected:text-fg data-[state=active]:border-accent data-[state=active]:text-fg';

type Variant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
  secondary: 'bg-hover text-fg hover:bg-pressed border-transparent',
  ghost: 'bg-transparent text-fg hover:bg-hover active:bg-pressed border-transparent',
  /** Chrome (the title bar): muted until hovered. */
  quiet:
    'bg-transparent text-muted hover:bg-hover hover:text-fg active:bg-pressed border-transparent',
  danger: 'bg-hover text-danger hover:bg-pressed border-transparent',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }
>(function Button({ variant = 'secondary', size = 'md', className, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-sm border whitespace-nowrap',
        'focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-40',
        size === 'sm' ? 'h-[22px] px-2 text-xs' : 'h-[26px] px-[13px] text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'h-[26px] w-full rounded-sm border border-border bg-deep px-1.5 text-[13px] text-fg',
          'placeholder:text-faint focus:border-focus focus:outline-none',
          'aria-[invalid=true]:border-danger disabled:opacity-40',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cx(
          'h-[26px] w-full rounded-sm border border-border bg-deep px-1 text-[13px] text-fg',
          'focus:border-focus focus:outline-none disabled:opacity-40',
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-1', props.className)}>
      <label htmlFor={props.htmlFor} className="text-xs font-medium text-muted">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p role="alert" className="text-xs text-danger">
          {props.error}
        </p>
      ) : props.hint ? (
        <p className="text-xs text-muted">{props.hint}</p>
      ) : null}
    </div>
  );
}

export const ENVIRONMENT_LABELS: Readonly<Record<Environment, string>> = {
  dev: 'Dev',
  test: 'Test',
  staging: 'Staging',
  production: 'Production',
};

const ENVIRONMENT_CLASSES: Readonly<Record<Environment, string>> = {
  dev: 'bg-env-dev/15 text-env-dev',
  test: 'bg-env-test/15 text-env-test',
  staging: 'bg-env-staging/15 text-env-staging',
  production: 'bg-env-production/20 text-env-production',
};

export function EnvironmentBadge({ environment }: { readonly environment: Environment }) {
  return (
    <span
      className={cx(
        'rounded-sm px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase',
        ENVIRONMENT_CLASSES[environment],
      )}
    >
      {ENVIRONMENT_LABELS[environment]}
    </span>
  );
}

/** A modal dialog frame on Radix Dialog: focus trap, Escape to close, labelled title. */
export function Modal(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly width?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly role?: 'dialog' | 'alertdialog';
}) {
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          role={props.role ?? 'dialog'}
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-md border border-border bg-raised text-fg shadow-widget',
            props.width ?? 'w-[520px]',
          )}
          {...(props.description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <div className="border-b border-border px-5 py-3">
            <RadixDialog.Title className="text-sm font-semibold">{props.title}</RadixDialog.Title>
            {props.description !== undefined && (
              <RadixDialog.Description className="mt-1 text-xs text-muted">
                {props.description}
              </RadixDialog.Description>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{props.children}</div>
          {props.footer !== undefined && (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              {props.footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Tiny inline icons (no icon font: nothing is fetched). */
export function Icon({
  name,
  className,
}: {
  readonly name:
    | 'play'
    | 'play-all'
    | 'stop'
    | 'plus'
    | 'refresh'
    | 'chevron-right'
    | 'chevron-down'
    | 'more'
    | 'database'
    | 'table'
    | 'folder'
    | 'close'
    | 'history'
    | 'format'
    | 'warning'
    | 'download'
    | 'copy'
    | 'check'
    | 'compare'
    | 'schedule'
    | 'jobs'
    | 'sun'
    | 'moon';
  readonly className?: string;
}) {
  // Kiln Glyphs' drawing: a 16px grid, 1.3 strokes with round caps and joins, closed shapes
  // washed at 16% in their own colour (currentColor, so an icon follows its text).
  const wash = { fill: 'currentColor', fillOpacity: 0.16 };
  const paths: Record<string, ReactNode> = {
    play: <path d="M5 3.4v9.2l7.6-4.6z" fill="currentColor" />,
    'play-all': (
      <>
        <path d="M2.4 3.6v8.8l5.8-4.4z" fill="currentColor" />
        <path d="M8.4 3.6v8.8l5.8-4.4z" fill="currentColor" />
      </>
    ),
    stop: <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />,
    plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
    refresh: <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.9v2.85h-2.85" />,
    'chevron-right': <path d="M6.2 4.2 10 8l-3.8 3.8" />,
    'chevron-down': <path d="M4.2 6.2 8 10l3.8-3.8" />,
    more: (
      <>
        <circle cx="3.5" cy="8" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1.15" fill="currentColor" stroke="none" />
      </>
    ),
    database: (
      <>
        <ellipse cx="8" cy="3.8" rx="5.2" ry="1.9" {...wash} />
        <path d="M2.8 3.8v8.4c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9V3.8M2.8 8c0 1 2.3 1.9 5.2 1.9s5.2-.9 5.2-1.9" />
      </>
    ),
    table: (
      <>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.2" />
        <path d="M1.75 6.25h12.5" />
        <path
          d="M2.95 2.75h10.1a1.2 1.2 0 0 1 1.2 1.2v2.3H1.75v-2.3a1.2 1.2 0 0 1 1.2-1.2z"
          {...wash}
          stroke="none"
        />
        <path d="M6.25 6.25v7" />
      </>
    ),
    folder: (
      <path
        d="M1.75 4.2a1 1 0 0 1 1-1h3.3l1.6 1.6h5.6a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"
        {...wash}
      />
    ),
    close: <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" />,
    history: (
      <>
        <circle cx="8" cy="8" r="5.6" />
        <path d="M8 5v3.2l2.1 1.4" />
      </>
    ),
    format: <path d="M2.75 4h10.5M2.75 7h7M2.75 10h10.5M2.75 13h5.5" />,
    warning: (
      <>
        <path
          d="M7.13 2.5a1 1 0 0 1 1.74 0l5.6 9.9a1 1 0 0 1-.87 1.5H2.4a1 1 0 0 1-.87-1.5z"
          {...wash}
        />
        <path d="M8 6.4v3.1M8 11.6v.1" />
      </>
    ),
    download: <path d="M8 2.5v7.5M4.6 6.8 8 10.2l3.4-3.4M3 13.5h10" />,
    copy: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" {...wash} />
        <path d="M10.5 5.5V3.7c0-.7-.5-1.2-1.2-1.2H3.7c-.7 0-1.2.5-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2h1.8" />
      </>
    ),
    check: <path d="M3.2 8.4l3 3 6.6-6.8" />,
    // Two versions side by side, the right one differing.
    compare: (
      <>
        <rect x="1.75" y="2.75" width="5.5" height="10.5" rx="1" {...wash} />
        <rect x="8.75" y="2.75" width="5.5" height="10.5" rx="1" />
        <path d="M3.4 5.75h2.2M3.4 8h2.2M10.4 5.75h2.2M10.4 8h2.2M10.4 10.25h1.2" />
      </>
    ),
    schedule: (
      <>
        <rect x="1.75" y="3" width="12.5" height="10.75" rx="1.2" />
        <path
          d="M2.95 3h10.1a1.2 1.2 0 0 1 1.2 1.2v2.05H1.75V4.2A1.2 1.2 0 0 1 2.95 3z"
          {...wash}
          stroke="none"
        />
        <path d="M1.75 6.25h12.5M5 1.75v2.5M11 1.75v2.5M5.25 9h1M9.75 9h1M5.25 11.25h1" />
      </>
    ),
    // A list of runs, each with its status dot.
    jobs: (
      <>
        <circle cx="3.6" cy="4" r="1.35" {...wash} />
        <circle cx="3.6" cy="8" r="1.35" {...wash} />
        <circle cx="3.6" cy="12" r="1.35" {...wash} />
        <path d="M6.75 4h6.5M6.75 8h6.5M6.75 12h4" />
      </>
    ),
    sun: (
      <>
        <circle cx="8" cy="8" r="2.75" {...wash} />
        <path d="M8 1.75v1.3M8 12.95v1.3M1.75 8h1.3M12.95 8h1.3M3.58 3.58l.92.92M11.5 11.5l.92.92M3.58 12.42l.92-.92M11.5 4.5l.92-.92" />
      </>
    ),
    moon: <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z" {...wash} />,
  };
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('h-4 w-4 shrink-0', className)}
    >
      {paths[name]}
    </svg>
  );
}
