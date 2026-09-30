import type { Environment } from '@joinery/core';
import { Dialog as RadixDialog } from 'radix-ui';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/** Small building blocks shared by the app: buttons, fields, badges and the dialog frame. */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 border-transparent',
  secondary: 'bg-panel-2 text-fg hover:bg-hover border-border',
  ghost: 'bg-transparent text-fg hover:bg-hover border-transparent',
  danger: 'bg-danger text-white hover:brightness-110 border-transparent',
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
        'inline-flex items-center justify-center gap-1.5 rounded border font-medium whitespace-nowrap',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-[13px]',
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
          'h-8 w-full rounded border border-border bg-panel-2 px-2 text-[13px] text-fg',
          'placeholder:text-muted focus:border-accent focus:outline-none',
          'aria-[invalid=true]:border-danger',
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
          'h-8 w-full rounded border border-border bg-panel-2 px-2 text-[13px] text-fg',
          'focus:border-accent focus:outline-none',
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
        'rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase',
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
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <RadixDialog.Content
          role={props.role ?? 'dialog'}
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-lg border border-border bg-panel text-fg shadow-2xl',
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
    | 'check';
  readonly className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    play: <path d="M5 3.5v9l8-4.5z" fill="currentColor" />,
    'play-all': (
      <>
        <path d="M2.5 3.5v9l6-4.5z" fill="currentColor" />
        <path d="M8.5 3.5v9l6-4.5z" fill="currentColor" />
      </>
    ),
    stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />,
    plus: <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" />,
    refresh: (
      <path
        d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    ),
    'chevron-right': <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />,
    'chevron-down': <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />,
    more: (
      <>
        <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
        <circle cx="8" cy="8" r="1.2" fill="currentColor" />
        <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
      </>
    ),
    database: (
      <>
        <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" fill="none" strokeWidth="1.2" />
        <path
          d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"
          stroke="currentColor"
          fill="none"
          strokeWidth="1.2"
        />
      </>
    ),
    table: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1" stroke="currentColor" fill="none" />
        <path d="M2.5 6.5h11M6.5 6.5V13" stroke="currentColor" />
      </>
    ),
    folder: (
      <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" stroke="currentColor" fill="none" strokeWidth="1.2" />
    ),
    close: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" />,
    history: (
      <>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" fill="none" strokeWidth="1.2" />
        <path d="M8 5v3l2 1.5" stroke="currentColor" fill="none" strokeWidth="1.2" />
      </>
    ),
    format: <path d="M3 4h10M3 7h7M3 10h10M3 13h6" stroke="currentColor" strokeWidth="1.3" />,
    warning: (
      <>
        <path d="M8 2l6.5 11.5h-13z" stroke="currentColor" fill="none" strokeWidth="1.2" />
        <path d="M8 6.5v3.5M8 11.5v.5" stroke="currentColor" strokeWidth="1.4" />
      </>
    ),
    download: (
      <path
        d="M8 2.5v7.5M4.5 7l3.5 3.5L11.5 7M3 13.5h10"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.4"
      />
    ),
    copy: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" fill="none" />
        <path
          d="M10.5 5.5V3.7c0-.7-.5-1.2-1.2-1.2H3.7c-.7 0-1.2.5-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2h1.8"
          stroke="currentColor"
          fill="none"
        />
      </>
    ),
    check: <path d="M3 8.5l3 3 7-7" stroke="currentColor" fill="none" strokeWidth="1.6" />,
  };
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cx('h-4 w-4 shrink-0', className)}>
      {paths[name]}
    </svg>
  );
}
