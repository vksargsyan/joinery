import type { RunStatus, ScheduleKind } from '@querybara/ipc';

import { cx } from '../ui';

/** Pieces the Schedules panel and the schedule editor share. */

export function KindIcon(props: { readonly kind: ScheduleKind; readonly className?: string }) {
  const common = {
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className: cx('h-4 w-4 shrink-0', props.className),
  } as const;
  switch (props.kind) {
    case 'backup':
      return (
        <svg {...common}>
          <ellipse cx="8" cy="3.5" rx="5" ry="2" />
          <path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9" />
          <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
        </svg>
      );
    case 'sql':
      return (
        <svg {...common}>
          <path d="M4 1.5h5.5L13 5v9.5H4Z" />
          <path d="M9.5 1.5V5H13" />
          <path d="M6.5 8.5 5.5 10l1 1.5M9.5 8.5l1 1.5-1 1.5" />
        </svg>
      );
    case 'export':
      return (
        <svg {...common}>
          <path d="M8 2v8M5 7l3 3 3-3" />
          <path d="M2.5 11v2.5h11V11" />
        </svg>
      );
    case 'comparison':
      return (
        <svg {...common}>
          <rect x="1.5" y="3" width="5" height="10" rx="1" />
          <rect x="9.5" y="3" width="5" height="10" rx="1" />
          <path d="M6.5 6h3M6.5 10h3" />
        </svg>
      );
  }
}

export const KIND_LABELS: Readonly<Record<ScheduleKind, string>> = {
  backup: 'Backup',
  sql: 'SQL file',
  export: 'Export',
  comparison: 'Comparison',
};

const STATUS: Readonly<Record<RunStatus, { label: string; tone: string }>> = {
  running: { label: 'Running', tone: 'bg-accent/15 text-accent' },
  success: { label: 'Succeeded', tone: 'bg-success/15 text-success' },
  failed: { label: 'Failed', tone: 'bg-danger/15 text-danger' },
  cancelled: { label: 'Cancelled', tone: 'bg-panel-2 text-muted' },
  skipped: { label: 'Skipped', tone: 'bg-warning/15 text-warning' },
};

export function StatusPill(props: { readonly status: RunStatus; readonly className?: string }) {
  const { label, tone } = STATUS[props.status];
  return (
    <span
      data-status={props.status}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[10.5px] leading-[18px] font-semibold',
        tone,
        props.className,
      )}
    >
      {props.status === 'running' && (
        <span
          aria-hidden
          className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent"
        />
      )}
      {label}
    </span>
  );
}

/** "in 3 h", "in 12 min", "5 min ago", "yesterday", or a date, for a moment near now. */
export function relative(iso: string | null, now = Date.now()): string {
  if (iso === null) return '';
  const diff = Date.parse(iso) - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const future = diff > 0;
  if (minutes < 1) return future ? 'in under a minute' : 'just now';
  const text =
    minutes < 60
      ? `${minutes} min`
      : minutes < 60 * 24
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / 60 / 24)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

export function when(iso: string | null): string {
  if (iso === null) return '';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function duration(start: string, end: string | null): string {
  if (end === null) return '';
  const ms = Date.parse(end) - Date.parse(start);
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
