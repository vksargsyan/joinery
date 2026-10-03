import type { RdbReport, RdbReportKey } from '@querybara/ipc';
import { useEffect, useState, type ReactNode } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { formatCount, formatDuration } from '../../lib/format';
import {
  cancelDumpAnalysis,
  chooseDumpFile,
  saveDumpReport,
  setDelimiter,
  useDump,
  type DumpState,
} from '../../state/redis/dump';
import { formatBytes } from '../../state/redis/value-model';
import { Button, Icon, Input, cx } from '../ui';
import { Notice, Separator, Stat, Toolbar, TypeBadge } from './common';

/**
 * The dump analysis panel (ADR 0022): pick a Redis or Valkey RDB file, watch it stream through
 * the job runner, then read what fills it — types and encodings, expiry, databases, key
 * patterns and the largest keys — without connecting to anything.
 */
export function DumpAnalysisPanel() {
  const state = useDump();
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string }>();

  const save = async (): Promise<void> => {
    try {
      const path = await saveDumpReport();
      if (path) setNotice({ kind: 'info', text: `Saved the analysis to ${path}` });
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) });
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="dump-analysis">
      <Toolbar label="Dump analysis">
        <span className="flex items-center gap-1.5 px-1 text-xs font-semibold text-fg">
          <Icon name="database" className="h-3.5 w-3.5 text-accent" />
          Dump analysis
        </span>
        <Separator />
        {state.status === 'running' ? (
          <Button size="sm" variant="danger" onClick={() => cancelDumpAnalysis()}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant={state.report ? 'ghost' : 'primary'}
            onClick={() => void chooseDumpFile()}
          >
            <Icon name="folder" className="h-3.5 w-3.5" />
            {state.report ? 'Analyse another file…' : 'Choose RDB file…'}
          </Button>
        )}
        <label
          className="ml-1 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted"
          title="Key names split on this for patterns (user:*:profile)"
        >
          Pattern delimiter
          <span className="w-12">
            <Input
              aria-label="Pattern delimiter"
              className="h-7 text-center font-mono text-xs"
              value={state.delimiter}
              maxLength={8}
              disabled={state.status === 'running'}
              onChange={(e) => setDelimiter(e.target.value)}
            />
          </span>
        </label>
        {state.report && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void save()}>
            <Icon name="download" className="h-3.5 w-3.5" />
            Save report…
          </Button>
        )}
      </Toolbar>
      {notice && (
        <Notice kind={notice.kind} onClose={() => setNotice(undefined)}>
          {notice.text}
        </Notice>
      )}
      {state.status === 'error' && state.error && <Notice kind="error">{state.error}</Notice>}
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === 'running' ? (
          <Progress state={state} />
        ) : state.report ? (
          <Report report={state.report} />
        ) : (
          <Welcome />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Welcome() {
  const sources: readonly {
    readonly what: string;
    readonly text: string;
    readonly code: boolean;
  }[] = [
    {
      what: 'redis-cli --rdb dump.rdb',
      text: 'copies a running server’s data to a file',
      code: true,
    },
    { what: 'BGSAVE', text: 'then take dump.rdb from the server’s dir', code: true },
    { what: 'Backups', text: 'from ElastiCache, Memorystore or Redis Cloud', code: false },
  ];
  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="w-full max-w-xl text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Icon name="database" className="h-7 w-7" />
        </span>
        <h2 className="mt-4 text-base font-semibold text-fg">See what fills a Redis server</h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
          Pick an RDB file and Querybara reads it offline: keys by type, encoding, expiry, database
          and pattern, and the largest ones. Files of any size stream through; nothing connects to a
          server.
        </p>
        <Button variant="primary" className="mt-5" onClick={() => void chooseDumpFile()}>
          <Icon name="folder" className="h-3.5 w-3.5" />
          Choose RDB file…
        </Button>
        <div className="mt-8 rounded-lg border border-border bg-panel p-4 text-left">
          <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Where to get one
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {sources.map((source) => (
              <li key={source.what} className="flex items-baseline gap-2 text-xs">
                {source.code ? (
                  <code className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-fg">
                    {source.what}
                  </code>
                ) : (
                  <span className="shrink-0 font-medium text-fg">{source.what}</span>
                )}
                <span className="text-muted">{source.text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-muted">
            Reads Redis 2 to 8.6 and Valkey 7 to 9, module types (JSON, time series, Bloom filters)
            included.
          </p>
        </div>
      </div>
    </div>
  );
}

function Progress({ state }: { readonly state: DumpState }) {
  const progress = state.progress;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const file = state.path?.split(/[\\/]/).pop() ?? '';
  const total = progress?.total ?? 0;
  const bytes = progress?.bytes ?? 0;
  const share = total > 0 ? Math.min(1, bytes / total) : 0;
  const elapsed = progress ? now - progress.startedAt : 0;
  const rate = elapsed > 500 ? bytes / (elapsed / 1000) : 0;
  const left = rate > 0 && total > bytes ? ((total - bytes) / rate) * 1000 : undefined;
  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-panel p-5"
        data-testid="dump-progress"
      >
        <div className="flex items-center gap-2">
          <Icon name="database" className="h-4 w-4 text-accent" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg"
            title={state.path}
          >
            {file}
          </span>
          <span className="text-xs text-muted tabular-nums">{Math.round(share * 100)}%</span>
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-panel-2"
          role="progressbar"
          aria-label="Reading the dump"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted tabular-nums">
          <span>
            {formatBytes(bytes)}
            {total > 0 && ` of ${formatBytes(total)}`}
            {rate > 0 && ` · ${formatBytes(rate)}/s`}
          </span>
          <span>
            {left !== undefined ? `about ${formatDuration(left)} left` : formatDuration(elapsed)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The report

const CORE_TYPES = new Set(['string', 'list', 'set', 'zset', 'hash', 'stream']);

/** Module types by what they are, for the ones Redis ships (Redis Stack, Redis 8). */
const MODULE_TYPES: Readonly<Record<string, string>> = {
  'ReJSON-RL': 'JSON',
  'TSDB-TYPE': 'Time series',
  'MBbloom--': 'Bloom filter',
  MBbloomCF: 'Cuckoo filter',
  'CMSk-TYPE': 'Count-min sketch',
  'TopK-TYPE': 'Top-K',
  'TDIS-TYPE': 't-digest',
  graphdata: 'Graph',
};

/** A type as a badge; a module's type by what it is, with its registered name. */
function TypeLabel({ type }: { readonly type: string }) {
  if (CORE_TYPES.has(type)) return <TypeBadge type={type} />;
  const known = MODULE_TYPES[type];
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={`Module type ${type}`}>
      {type === 'ReJSON-RL' ? (
        <TypeBadge type={type} />
      ) : (
        <span className="inline-block min-w-11 rounded bg-panel-2 px-1 text-center text-[10px] font-semibold tracking-wide text-muted">
          MODULE
        </span>
      )}
      <span className="text-fg">{known ?? type}</span>
      {known !== undefined && <span className="font-mono text-[10px] text-muted">{type}</span>}
    </span>
  );
}

/** Bar colours per type, matching the type badges. */
function typeTone(type: string): string {
  switch (type) {
    case 'string':
      return 'bg-accent';
    case 'hash':
      return 'bg-success';
    case 'list':
      return 'bg-warning';
    case 'set':
      return 'bg-env-staging';
    case 'zset':
      return 'bg-danger';
    case 'stream':
      return 'bg-env-test';
    case 'ReJSON-RL':
      return 'bg-env-dev';
    default:
      return 'bg-muted';
  }
}

const percent = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '0%';

function Section(props: {
  readonly title: string;
  readonly detail?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      aria-label={props.title}
      className={cx('rounded-lg border border-border bg-panel', props.className)}
    >
      <header className="flex items-baseline gap-2 border-b border-border px-3 py-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          {props.title}
        </h3>
        {props.detail !== undefined && (
          <span className="text-[11px] text-muted">{props.detail}</span>
        )}
      </header>
      {props.children}
    </section>
  );
}

function Table(props: {
  readonly label: string;
  readonly head: readonly (string | { readonly text: string; readonly right?: boolean })[];
  readonly children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" aria-label={props.label}>
        <thead className="text-left text-[11px] text-muted uppercase">
          <tr className="border-b border-border">
            {props.head.map((h) => {
              const head = typeof h === 'string' ? { text: h } : h;
              return (
                <th
                  key={head.text}
                  className={cx('px-3 py-1.5 font-semibold', head.right === true && 'text-right')}
                >
                  {head.text}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="tabular-nums [&_td]:whitespace-nowrap">{props.children}</tbody>
      </table>
    </div>
  );
}

function ShareBar(props: { readonly share: number; readonly tone?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-panel-2">
        <span
          className={cx('block h-full rounded-full', props.tone ?? 'bg-accent')}
          style={{ width: `${Math.max(props.share > 0 ? 2 : 0, Math.round(props.share * 100))}%` }}
        />
      </span>
      <span className="w-11 text-right text-muted">{(props.share * 100).toFixed(1)}%</span>
    </span>
  );
}

function Report({ report }: { readonly report: RdbReport }) {
  const server = report.aux['redis-ver'] ?? report.aux['valkey-ver'];
  const product = report.aux['valkey-ver'] !== undefined ? 'Valkey' : 'Redis';
  const usedMem = Number(report.aux['used-mem']);
  const totalBytes = report.keyBytes;
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="dump-report">
      {report.stopped && (
        <div
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          Reading stopped at byte {formatCount(report.stopped.offset)} of {formatCount(report.size)}
          : {report.stopped.message}. The figures cover the keys before it.
        </div>
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <h2 className="font-mono text-base font-semibold text-fg" data-testid="dump-file">
          {report.file}
        </h2>
        <p className="text-xs text-muted">
          {[
            server !== undefined ? `${product} ${server}` : undefined,
            `RDB ${report.version}`,
            report.createdAt !== null
              ? `saved ${new Date(report.createdAt).toLocaleString()}`
              : undefined,
            formatBytes(report.size),
            report.checksum !== null ? `CRC ${report.checksum}` : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(' · ')}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat
          label="Keys"
          value={formatCount(report.keys)}
          detail={`${formatCount(report.databases.length)} database${report.databases.length === 1 ? '' : 's'}`}
        />
        <Stat
          label="In the dump"
          value={formatBytes(totalBytes)}
          detail="keys and values, encoded"
        />
        <Stat
          label="Expiring"
          value={formatCount(report.expiring)}
          detail={`${percent(report.expiring, report.keys)} of keys have a TTL`}
        />
        {Number.isFinite(usedMem) && usedMem > 0 && (
          <Stat label="Memory when saved" value={formatBytes(usedMem)} detail="used_memory" />
        )}
        <Stat
          label="Read in"
          value={formatDuration(report.durationMs)}
          detail={
            report.durationMs > 0
              ? `${formatBytes(report.bytes / (report.durationMs / 1000))}/s`
              : undefined
          }
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
        <Types report={report} />
        <Expiry report={report} />
      </div>

      <Patterns report={report} />

      <div className="grid gap-3 xl:grid-cols-2">
        <KeyList
          title="Largest keys"
          detail="by bytes in the dump"
          keys={report.biggest}
          testId="dump-biggest"
        />
        <KeyList
          title="Most elements"
          detail="fields, items or members"
          keys={report.longest}
          testId="dump-longest"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Databases report={report} />
        <Details report={report} />
      </div>
    </div>
  );
}

function Types({ report }: { readonly report: RdbReport }) {
  const total = report.keyBytes;
  return (
    <Section title="By type" detail="share of the dump">
      <div className="px-3 pt-3">
        <div className="flex h-3 overflow-hidden rounded-full bg-panel-2" aria-hidden>
          {report.types.map((type) => (
            <span
              key={type.name}
              className={cx('h-full', typeTone(type.name))}
              style={{ width: `${total > 0 ? (type.bytes / total) * 100 : 0}%` }}
              title={`${type.name}: ${formatBytes(type.bytes)}`}
            />
          ))}
        </div>
      </div>
      <Table
        label="Types"
        head={[
          'Type',
          { text: 'Keys', right: true },
          { text: 'Size', right: true },
          'Share',
          { text: 'Elements', right: true },
          'Encodings',
        ]}
      >
        {report.types.map((type) => (
          <tr
            key={type.name}
            className="border-b border-border/50 last:border-0"
            data-testid="dump-type"
          >
            <td className="px-3 py-1.5">
              <TypeLabel type={type.name} />
            </td>
            <td className="px-3 py-1.5 text-right">{formatCount(type.keys)}</td>
            <td className="px-3 py-1.5 text-right">{formatBytes(type.bytes)}</td>
            <td className="px-3 py-1.5">
              <ShareBar share={total > 0 ? type.bytes / total : 0} tone={typeTone(type.name)} />
            </td>
            <td className="px-3 py-1.5 text-right" title="Over the keys whose count is known">
              {!CORE_TYPES.has(type.name)
                ? '—'
                : type.name === 'string'
                  ? formatBytes(type.elements)
                  : formatCount(type.elements)}
            </td>
            <td className="px-3 py-1.5">
              <span className="flex flex-wrap gap-1">
                {type.encodings.map((encoding) => (
                  <span
                    key={encoding.name}
                    className="rounded bg-panel-2 px-1.5 py-px font-mono text-[10px] text-muted"
                    title={`${formatCount(encoding.keys)} keys, ${formatBytes(encoding.bytes)}`}
                  >
                    {encoding.name} {formatCount(encoding.keys)}
                  </span>
                ))}
              </span>
            </td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

function Expiry({ report }: { readonly report: RdbReport }) {
  const most = Math.max(1, ...report.expiry.map((bucket) => bucket.keys));
  return (
    <Section
      title="Expiry"
      detail={report.createdAt !== null ? 'from when the dump was saved' : 'from now'}
    >
      <ul className="flex flex-col gap-2 p-3">
        {report.expiry.map((bucket) => (
          <li key={bucket.name} className="text-xs" data-testid="dump-expiry">
            <div className="flex justify-between gap-2">
              <span className="text-fg">{bucket.name}</span>
              <span className="text-muted tabular-nums">
                {formatCount(bucket.keys)} · {formatBytes(bucket.bytes)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div
                className={cx(
                  'h-full rounded-full',
                  bucket.name === 'No expiry'
                    ? 'bg-muted'
                    : bucket.name === 'Already expired'
                      ? 'bg-danger'
                      : 'bg-accent',
                )}
                style={{ width: `${(bucket.keys / most) * 100}%` }}
              />
            </div>
          </li>
        ))}
        {report.fieldsWithTtl > 0 && (
          <li className="text-xs text-muted">
            Also {formatCount(report.fieldsWithTtl)} hash field
            {report.fieldsWithTtl === 1 ? '' : 's'} with their own expiry.
          </li>
        )}
      </ul>
    </Section>
  );
}

function Patterns({ report }: { readonly report: RdbReport }) {
  const [all, setAll] = useState(false);
  const rows = all ? report.patterns : report.patterns.slice(0, 50);
  return (
    <Section title="By pattern" detail="numbers and ids in key names become *">
      <Table
        label="Patterns"
        head={[
          'Pattern',
          { text: 'Keys', right: true },
          { text: 'Size', right: true },
          'Share',
          { text: 'Average', right: true },
          { text: 'With TTL', right: true },
          'Largest',
          'Types',
        ]}
      >
        {rows.map((p) => (
          <tr
            key={p.pattern}
            className="border-b border-border/50 last:border-0"
            data-testid="dump-pattern"
          >
            <td className="max-w-80 truncate px-3 py-1.5 font-mono text-fg" title={p.pattern}>
              {p.pattern}
            </td>
            <td className="px-3 py-1.5 text-right">{formatCount(p.count)}</td>
            <td className="px-3 py-1.5 text-right">{formatBytes(p.totalBytes)}</td>
            <td className="px-3 py-1.5">
              <ShareBar share={p.share} />
            </td>
            <td className="px-3 py-1.5 text-right">{formatBytes(p.avgBytes)}</td>
            <td className="px-3 py-1.5 text-right">{percent(p.withTtl, p.count)}</td>
            <td
              className="max-w-60 truncate px-3 py-1.5 font-mono text-muted"
              title={p.largestKey ?? ''}
            >
              {p.largestKey ?? ''}
            </td>
            <td className="px-3 py-1.5">
              <span className="flex flex-wrap gap-1">
                {Object.entries(p.types).map(([type, n]) => (
                  <span key={type} className="inline-flex items-center gap-1">
                    {CORE_TYPES.has(type) ? <TypeBadge type={type} /> : <TypeLabel type={type} />}
                    {Object.keys(p.types).length > 1 && (
                      <span className="text-muted">{formatCount(n)}</span>
                    )}
                  </span>
                ))}
              </span>
            </td>
          </tr>
        ))}
      </Table>
      {report.patterns.length > 50 && (
        <div className="border-t border-border px-3 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
            {all ? 'Show the first 50' : `Show all ${formatCount(report.patterns.length)} patterns`}
          </Button>
        </div>
      )}
    </Section>
  );
}

function expiryText(expiresAt: number | null, from: number): string {
  if (expiresAt === null) return '—';
  const left = expiresAt - from;
  if (left <= 0) return 'expired';
  return `in ${formatDuration(left)}`;
}

function KeyList(props: {
  readonly title: string;
  readonly detail: string;
  readonly keys: readonly RdbReportKey[];
  readonly testId: string;
}) {
  const [copied, setCopied] = useState<string>();
  const from = useDump((s) => s.report?.createdAt ?? null) ?? Date.now();
  return (
    <Section title={props.title} detail={props.detail}>
      {props.keys.length === 0 ? (
        <p className="p-3 text-xs text-muted">No keys.</p>
      ) : (
        <Table
          label={props.title}
          head={[
            'Key',
            { text: 'DB', right: true },
            'Type',
            { text: 'Size', right: true },
            { text: 'Elements', right: true },
            'Expires',
          ]}
        >
          {props.keys.map((key, i) => (
            <tr
              key={`${key.db}:${key.key}:${i}`}
              className="group border-b border-border/50 last:border-0 hover:bg-hover"
              data-testid={props.testId}
            >
              <td className="max-w-72 px-3 py-1.5">
                <span className="flex items-center gap-1">
                  <span className="truncate font-mono text-fg" title={key.key}>
                    {key.key}
                    {key.keyLength > 4096 && '…'}
                  </span>
                  <button
                    type="button"
                    aria-label={`Copy ${key.key}`}
                    className="shrink-0 rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-panel-2 hover:text-fg"
                    onClick={() => {
                      copyToClipboard(key.key);
                      setCopied(key.key);
                      setTimeout(() => setCopied(undefined), 1200);
                    }}
                  >
                    <Icon name={copied === key.key ? 'check' : 'copy'} className="h-3 w-3" />
                  </button>
                </span>
              </td>
              <td className="px-3 py-1.5 text-right text-muted">{key.db}</td>
              <td className="px-3 py-1.5">
                {CORE_TYPES.has(key.type) ? (
                  <span className="flex items-center gap-1.5" title={key.encoding}>
                    <TypeBadge type={key.type} />
                    <span className="font-mono text-[10px] text-muted">{key.encoding}</span>
                  </span>
                ) : (
                  <TypeLabel type={key.type} />
                )}
              </td>
              <td className="px-3 py-1.5 text-right">{formatBytes(key.bytes)}</td>
              <td className="px-3 py-1.5 text-right">
                {key.elements === null
                  ? '—'
                  : key.type === 'string'
                    ? formatBytes(key.elements)
                    : formatCount(key.elements)}
              </td>
              <td className="px-3 py-1.5 text-muted">{expiryText(key.expiresAt, from)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function Databases({ report }: { readonly report: RdbReport }) {
  return (
    <Section title="Databases">
      <Table
        label="Databases"
        head={[
          'Database',
          { text: 'Keys', right: true },
          { text: 'Size', right: true },
          { text: 'Expiring', right: true },
        ]}
      >
        {report.databases.map((db) => (
          <tr key={db.db} className="border-b border-border/50 last:border-0">
            <td className="px-3 py-1.5 font-mono">db{db.db}</td>
            <td className="px-3 py-1.5 text-right">{formatCount(db.keys)}</td>
            <td className="px-3 py-1.5 text-right">{formatBytes(db.bytes)}</td>
            <td className="px-3 py-1.5 text-right">{formatCount(db.expiring)}</td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

function Details({ report }: { readonly report: RdbReport }) {
  const entries = Object.entries(report.aux);
  return (
    <Section title="Saved with it" detail="the dump’s AUX fields">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 p-3 text-xs">
        {entries.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="font-mono text-muted">{name}</dt>
            <dd className="truncate font-mono text-fg" title={value}>
              {name === 'ctime' && /^\d+$/.test(value)
                ? `${value} (${new Date(Number(value) * 1000).toLocaleString()})`
                : name === 'used-mem' && /^\d+$/.test(value)
                  ? `${value} (${formatBytes(Number(value))})`
                  : value}
            </dd>
          </div>
        ))}
        {report.functions > 0 && (
          <div className="contents">
            <dt className="text-muted">Functions</dt>
            <dd className="text-fg">
              {formatCount(report.functions)} librar{report.functions === 1 ? 'y' : 'ies'}
            </dd>
          </div>
        )}
        {report.moduleAux.map((module) => (
          <div key={module.name} className="contents">
            <dt className="text-muted">Module data</dt>
            <dd className="font-mono text-fg">
              {module.name} ({formatBytes(module.bytes)})
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
