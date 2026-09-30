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
  /** Next to the title, outside its accessible name (a badge, an icon). */
  readonly titleAside?: ReactNode;
  /** Tabs at the foot of the header, on its border. */
  readonly tabs?: ReactNode;
  /** The body's size and padding, when it must not follow its content (a tabbed dialog). */
  readonly bodyClassName?: string;
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
          <div className={cx('border-b border-border px-5', props.tabs ? 'pt-3' : 'py-3')}>
            <div className="flex items-center gap-2">
              <RadixDialog.Title className="text-sm font-semibold">{props.title}</RadixDialog.Title>
              {props.titleAside}
            </div>
            {props.description !== undefined && (
              <RadixDialog.Description className="mt-1 text-xs text-muted">
                {props.description}
              </RadixDialog.Description>
            )}
            {props.tabs !== undefined && <div className="mt-2">{props.tabs}</div>}
          </div>
          <div className={cx('min-h-0 overflow-auto', props.bodyClassName ?? 'flex-1 px-5 py-4')}>
            {props.children}
          </div>
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
    | 'moon'
    | 'view-grid'
    | 'view-form'
    | 'view-json'
    | 'view-tree'
    | 'query'
    | 'file-run'
    | 'builder'
    | 'diagram'
    | 'server'
    | 'transfer'
    | 'edit'
    | 'trash'
    | 'design'
    | 'import'
    | 'export'
    | 'wrench'
    | 'table-new'
    | 'compare-rows'
    | 'key'
    | 'chart'
    | 'pulse'
    | 'users'
    | 'gauge'
    | 'archive'
    | 'restore'
    | 'open'
    | 'kebab'
    | 'search'
    | 'filter'
    | 'connection-new'
    | 'folder-new'
    | 'disconnect'
    | 'plug'
    | 'link';
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
    query: (
      <>
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.2" {...wash} />
        <path d="M4.6 6.2 6.7 8.1 4.6 10M8.4 10.2h3" />
      </>
    ),
    'file-run': (
      <>
        <path
          d="M9.2 1.9H4.1A1.1 1.1 0 0 0 3 3v10a1.1 1.1 0 0 0 1.1 1.1h7.8A1.1 1.1 0 0 0 13 13V5.7z"
          {...wash}
        />
        <path d="M9.2 1.9v3.8H13M6.8 8.3v3.5l2.8-1.75z" />
      </>
    ),
    builder: (
      <>
        <rect x="1.9" y="2.3" width="5.2" height="4.4" rx="1" {...wash} />
        <rect x="8.9" y="2.3" width="5.2" height="4.4" rx="1" />
        <rect x="5.4" y="9.3" width="5.2" height="4.4" rx="1" />
      </>
    ),
    diagram: (
      <>
        <rect x="1.8" y="2.3" width="5.4" height="4.6" rx="1" {...wash} />
        <rect x="8.8" y="9.1" width="5.4" height="4.6" rx="1" />
        <path d="M4.5 6.9v4.5h4.3" />
      </>
    ),
    server: (
      <>
        <rect x="2.25" y="2.5" width="11.5" height="4.6" rx="1.1" {...wash} />
        <rect x="2.25" y="8.9" width="11.5" height="4.6" rx="1.1" />
        <path d="M4.8 4.8h.1M4.8 11.2h.1M8 4.8h3M8 11.2h3" />
      </>
    ),
    transfer: <path d="M2.5 5.2h10M10 2.7l2.5 2.5L10 7.7M13.5 10.8h-10M6 8.3l-2.5 2.5L6 13.3" />,
    edit: (
      <>
        <path
          d="M10.6 2.6a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1l-7.5 7.5-3.2.8.8-3.2z"
          {...wash}
        />
        <path d="M9.4 3.8l2.8 2.8" />
      </>
    ),
    trash: (
      <>
        <path d="M3.8 4.6h8.4l-.7 8.3a1.1 1.1 0 0 1-1.1 1H5.6a1.1 1.1 0 0 1-1.1-1z" {...wash} />
        <path d="M2.4 4.6h11.2M6.2 4.6V3a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.6M6.8 7.2v4.2M9.2 7.2v4.2" />
      </>
    ),
    design: (
      <>
        <path d="M2.5 13.5V2.5l11 11z" {...wash} />
        <path d="M5.2 10.8V8.3l2.5 2.5zM2.5 5.5h1.4M2.5 8.5h1.4" />
      </>
    ),
    import: (
      <path d="M2.5 9.8v2.6a1.1 1.1 0 0 0 1.1 1.1h8.8a1.1 1.1 0 0 0 1.1-1.1V9.8M8 2.4v7.4M5.2 7.1 8 9.9l2.8-2.8" />
    ),
    export: (
      <path d="M2.5 9.8v2.6a1.1 1.1 0 0 0 1.1 1.1h8.8a1.1 1.1 0 0 0 1.1-1.1V9.8M8 10V2.6M5.2 5.3 8 2.5l2.8 2.8" />
    ),
    wrench: (
      <path
        d="M13.3 4.6a3.3 3.3 0 0 1-4.4 3.9l-5 5a1.3 1.3 0 0 1-1.8-1.8l5-5A3.3 3.3 0 0 1 11 2.3L9.2 4.1l.4 1.9 1.9.4z"
        {...wash}
      />
    ),
    'table-new': (
      <>
        <path d="M8.5 13.25H3a1.2 1.2 0 0 1-1.2-1.2V3.95A1.2 1.2 0 0 1 3 2.75h10a1.2 1.2 0 0 1 1.2 1.2V8.3" />
        <path
          d="M3 2.75h10a1.2 1.2 0 0 1 1.2 1.2v2.3H1.8v-2.3A1.2 1.2 0 0 1 3 2.75z"
          {...wash}
          stroke="none"
        />
        <path d="M1.8 6.25h12.4M12 9.8v4.2M9.9 11.9h4.2" />
      </>
    ),
    'compare-rows': (
      <>
        <rect x="1.8" y="2.5" width="5.2" height="11" rx="1" {...wash} />
        <rect x="9" y="2.5" width="5.2" height="11" rx="1" />
        <path d="M1.8 6h5.2M1.8 9.5h5.2M9 6h5.2M9 9.5h5.2" />
      </>
    ),
    key: (
      <>
        <circle cx="5.3" cy="10.7" r="2.8" {...wash} />
        <path d="M7.3 8.7 13 3M10.8 5.2l1.6 1.6M12.4 3.6l1.2 1.2" />
      </>
    ),
    chart: (
      <>
        <path d="M2.2 13.5h11.6" />
        <rect x="3.4" y="8" width="2.2" height="5.5" rx=".5" {...wash} />
        <rect x="6.9" y="4.5" width="2.2" height="9" rx=".5" />
        <rect x="10.4" y="6.5" width="2.2" height="7" rx=".5" />
      </>
    ),
    pulse: <path d="M1.8 8.4h2.6l1.6-4.2 3 8.2 1.7-4h3.5" />,
    users: (
      <>
        <circle cx="6" cy="5.4" r="2.4" {...wash} />
        <path d="M1.9 13.2c.4-2.3 2.1-3.7 4.1-3.7s3.7 1.4 4.1 3.7M10.4 3.2a2.3 2.3 0 0 1 0 4.4M12 9.8c1.2.5 2 1.7 2.2 3.4" />
      </>
    ),
    gauge: (
      <>
        <path d="M2.7 12.3a5.6 5.6 0 1 1 10.6 0" />
        <circle cx="8" cy="10.4" r="1.2" {...wash} />
        <path d="M8.8 9.5l2.1-3" />
      </>
    ),
    archive: (
      <>
        <rect x="1.9" y="2.6" width="12.2" height="3.4" rx=".9" {...wash} />
        <path d="M3 6v6.4a1.1 1.1 0 0 0 1.1 1.1h7.8a1.1 1.1 0 0 0 1.1-1.1V6M6.5 8.8h3" />
      </>
    ),
    restore: <path d="M2.9 8a5.1 5.1 0 1 0 1.5-3.6L2.6 6.2M2.6 2.9v3.3h3.3M8 5.4v2.8l1.9 1.2" />,
    open: (
      <path d="M12.8 9.2v3.2a1.1 1.1 0 0 1-1.1 1.1H3.6a1.1 1.1 0 0 1-1.1-1.1V4.3a1.1 1.1 0 0 1 1.1-1.1h3.2M9.6 2.5h3.9v3.9M13.3 2.7 7.6 8.4" />
    ),
    'view-grid': (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1.2" {...wash} />
        <path d="M2 6.2h12M2 9.8h12M6 2.5v11M10 2.5v11" />
      </>
    ),
    'view-form': (
      <>
        <rect x="7" y="2.8" width="7" height="3.6" rx="0.9" {...wash} />
        <rect x="7" y="9.6" width="7" height="3.6" rx="0.9" />
        <path d="M2.2 4.6h2.8M2.2 11.4h2.8" />
      </>
    ),
    'view-json': (
      <>
        <path d="M5.6 2.6c-1.4 0-2 .7-2 1.9v1.7c0 .9-.5 1.5-1.4 1.8.9.3 1.4.9 1.4 1.8v1.7c0 1.2.6 1.9 2 1.9M10.4 2.6c1.4 0 2 .7 2 1.9v1.7c0 .9.5 1.5 1.4 1.8-.9.3-1.4.9-1.4 1.8v1.7c0 1.2-.6 1.9-2 1.9" />
        <circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none" />
      </>
    ),
    'view-tree': (
      <>
        <rect x="2" y="2" width="5.2" height="3.2" rx="0.8" {...wash} />
        <rect x="8.4" y="7" width="5.6" height="3" rx="0.8" />
        <rect x="8.4" y="11" width="5.6" height="3" rx="0.8" />
        <path d="M4.6 5.2v7.3h3.8M4.6 8.5h3.8" />
      </>
    ),
    kebab: (
      <>
        <circle cx="8" cy="3.5" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="8" cy="12.5" r="1.15" fill="currentColor" stroke="none" />
      </>
    ),
    search: (
      <>
        <circle cx="7" cy="7" r="4.4" {...wash} />
        <path d="m10.3 10.3 3.45 3.45" />
      </>
    ),
    // A funnel: narrow what the tree shows.
    filter: <path d="M2.25 3h11.5L9.2 8.6v4.2l-2.4 1.2V8.6z" {...wash} />,
    // The database cylinder with a plus: a new connection.
    'connection-new': (
      <>
        <ellipse cx="7" cy="3.8" rx="4.6" ry="1.75" {...wash} />
        <path d="M2.4 3.8v7.4c0 .9 2 1.7 4.6 1.7M11.6 3.8v3.1M2.4 7.5c0 .9 2 1.7 4.6 1.7" />
        <path d="M12 9.75v4.5M9.75 12h4.5" />
      </>
    ),
    'folder-new': (
      <>
        <path
          d="M8.4 12.8H2.75a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1h3.3l1.6 1.6h5.6a1 1 0 0 1 1 1v2.4"
          {...wash}
        />
        <path d="M12 9.75v4.5M9.75 12h4.5" />
      </>
    ),
    // A plug pulled out of its socket: close connections.
    disconnect: (
      <>
        <path
          d="M5.3 8.3 3.9 9.7a2.3 2.3 0 0 0 0 3.25l-.85-.85a2.3 2.3 0 0 0 3.25 0l1.4-1.4z"
          {...wash}
        />
        <path
          d="M10.7 7.7l1.4-1.4a2.3 2.3 0 0 0 0-3.25l.85.85a2.3 2.3 0 0 0-3.25 0L8.3 5.3z"
          {...wash}
        />
        <path d="M2 14l1.9-1.9M14 2l-1.9 1.9M6.9 5.4 5.6 4.1M5.3 7.1 3.6 6.6M9.1 10.6l1.3 1.3M10.7 8.9l.5 1.7" />
      </>
    ),
    // A plug in its socket: connected.
    link: (
      <>
        <path d="M6.9 9.1a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
        <path d="M9.1 6.9a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
      </>
    ),
    plug: (
      <>
        <path
          d="M6.1 6.6 4.2 8.5a2.5 2.5 0 0 0 0 3.5l-.2-.2a2.5 2.5 0 0 0 3.5 0l1.9-1.9z"
          {...wash}
        />
        <path d="M2 14l2-2M8.2 5.3l2.4-2.4M10.7 7.8l2.4-2.4" />
      </>
    ),
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

export type IconName = Parameters<typeof Icon>[0]['name'];
