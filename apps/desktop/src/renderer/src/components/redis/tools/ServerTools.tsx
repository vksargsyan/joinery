import type { BigKeyReport, MonitorEvent, RedisTopologyView } from '@joinery/driver-redis';
import {
  CLUSTER_SLOTS,
  displayBytes,
  utf8Bytes,
  type AclUser,
  type LatencySample,
} from '@joinery/redis-tools';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import { WRITE, destructive, formatCommandLine } from '../../../../../shared/redis-safety';
import { appendBounded, parseNameList } from '../../../state/redis/cli';
import { openDumpAnalysis } from '../../../state/redis/dump';
import {
  laneSession,
  onPanelDispose,
  openRedisPanel,
  panelLane,
  redisWrite,
  type RedisPanelTarget,
} from '../../../state/redis/panels';
import { formatBytes, formatTtl } from '../../../state/redis/value-model';
import { Button, Input, cx } from '../../ui';
import {
  EmptyState,
  NodeSelect,
  Notice,
  Stat,
  Toolbar,
  TypeBadge,
  timeText,
  useConnectionFacts,
  usePanelData,
} from '../common';
import { Sparkline } from './DashboardPanel';

/**
 * Server tools (spec §10, §15): slow log with reset, CLIENT LIST with kill, the latency
 * monitor (latest, history, doctor), MONITOR behind a performance warning, the big-key report,
 * the ACL users editor and the Sentinel / Cluster topology with the slot map. Every change
 * shows the command it runs before it runs.
 */

interface ToolProps {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}

function word(text: string): Uint8Array {
  return utf8Bytes(text);
}

function nodeOption(node: string | undefined): { node?: string } {
  return node === undefined ? {} : { node };
}

function Table(props: {
  readonly head: readonly string[];
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <table className="w-full text-xs" aria-label={props.label}>
      <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted uppercase">
        <tr>
          {props.head.map((h) => (
            <th key={h} className="px-2 py-1 font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{props.children}</tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------

export function SlowLogPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [node, setNode] = useState<string>();
  const [count, setCount] = useState(128);
  const [error, setError] = useState<string>();
  const log = usePanelData(
    panelId,
    (host, sessionId) => host.redis.slowlog.get({ sessionId, count, ...nodeOption(node) }),
    [node, count],
  );
  const reset = async (): Promise<void> => {
    try {
      const done = await redisWrite({
        profileId: target.profileId,
        operation: destructive('clears the slow log'),
        title: 'Reset the slow log?',
        commands: [[word('SLOWLOG'), word('RESET')]],
        confirmLabel: 'Reset',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.slowlog.reset({ sessionId, confirmed, ...nodeOption(node) }),
          ),
      });
      if (done !== undefined) await log.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="slowlog">
      <Toolbar label="Slow log">
        <NodeSelect facts={facts} value={node} onChange={setNode} allowAll={false} />
        <label className="flex items-center gap-1 text-xs text-muted">
          Entries
          <select
            aria-label="Entries"
            className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          >
            {[32, 128, 512, 1024].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" onClick={() => void log.reload()}>
          Refresh
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void reset()}>
          Reset…
        </Button>
      </Toolbar>
      {(error ?? log.error) && <Notice kind="error">{error ?? log.error}</Notice>}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table label="Slow log entries" head={['ID', 'Time', 'Duration', 'Command', 'Client']}>
          {(log.data ?? []).map((entry) => (
            <tr key={entry.id} className="border-b border-border/50" data-testid="slowlog-entry">
              <td className="px-2 py-1">{entry.id}</td>
              <td className="px-2 py-1 whitespace-nowrap">{timeText(entry.timestamp)}</td>
              <td className="px-2 py-1 text-right tabular-nums">
                {formatCount(entry.durationMicros)} µs
              </td>
              <td className="px-2 py-1 font-mono break-all select-text">
                {formatCommandLine(entry.args)}
              </td>
              <td className="px-2 py-1 whitespace-nowrap">
                {entry.client}
                {entry.clientName ? ` (${entry.clientName})` : ''}
              </td>
            </tr>
          ))}
        </Table>
        {log.data?.length === 0 && <EmptyState>The slow log is empty.</EmptyState>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ClientsPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [node, setNode] = useState<string>();
  const [type, setType] = useState('');
  const [error, setError] = useState<string>();
  const clients = usePanelData(
    panelId,
    (host, sessionId) =>
      host.redis.clients.list({ sessionId, ...nodeOption(node), ...(type ? { type } : {}) }),
    [node, type],
  );
  const kill = async (id: number): Promise<void> => {
    try {
      const done = await redisWrite({
        profileId: target.profileId,
        operation: destructive('disconnects the client'),
        title: 'Kill the client?',
        commands: [[word('CLIENT'), word('KILL'), word('ID'), word(String(id))]],
        confirmLabel: 'Kill',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.clients.kill({ sessionId, id, confirmed, ...nodeOption(node) }),
          ),
      });
      if (done !== undefined) await clients.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="clients">
      <Toolbar label="Clients">
        <NodeSelect facts={facts} value={node} onChange={setNode} allowAll={false} />
        <select
          aria-label="Client type"
          className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All clients</option>
          <option value="normal">Normal</option>
          <option value="pubsub">Pub/Sub</option>
          <option value="replica">Replicas</option>
          <option value="master">Master</option>
        </select>
        <Button size="sm" onClick={() => void clients.reload()}>
          Refresh
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-muted">{formatCount(clients.data?.length ?? 0)} clients</span>
      </Toolbar>
      {(error ?? clients.error) && <Notice kind="error">{error ?? clients.error}</Notice>}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table
          label="Clients"
          head={['ID', 'Address', 'Name', 'User', 'DB', 'Age', 'Idle', 'Last command', 'Flags', '']}
        >
          {(clients.data ?? []).map((c) => (
            <tr key={c.id} className="border-b border-border/50" data-testid="client-row">
              <td className="px-2 py-1">{c.id}</td>
              <td className="px-2 py-1 font-mono">{c.addr}</td>
              <td className="px-2 py-1">{c.name}</td>
              <td className="px-2 py-1">{c.user}</td>
              <td className="px-2 py-1">{c.db}</td>
              <td className="px-2 py-1">{formatTtl(c.ageSeconds * 1000)}</td>
              <td className="px-2 py-1">{formatTtl(c.idleSeconds * 1000)}</td>
              <td className="px-2 py-1 font-mono">{c.cmd}</td>
              <td className="px-2 py-1 font-mono">{c.flags}</td>
              <td className="px-2 py-1 text-right">
                <button
                  type="button"
                  className="text-muted hover:text-danger"
                  onClick={() => void kill(c.id)}
                >
                  Kill
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function LatencyPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [node, setNode] = useState<string>();
  const [event, setEvent] = useState<string>();
  const [history, setHistory] = useState<LatencySample[]>([]);
  const [doctor, setDoctor] = useState<string>();
  const [threshold, setThreshold] = useState('');
  const [error, setError] = useState<string>();
  const latest = usePanelData(
    panelId,
    async (host, sessionId) => {
      const [events, limit] = await Promise.all([
        host.redis.latency.latest({ sessionId, ...nodeOption(node) }),
        host.redis.latency.threshold({ sessionId, ...nodeOption(node) }),
      ]);
      return { events, threshold: limit.ms };
    },
    [node],
  );
  useEffect(() => {
    if (latest.data?.threshold !== null && latest.data?.threshold !== undefined) {
      setThreshold(String(latest.data.threshold));
    }
  }, [latest.data?.threshold]);
  useEffect(() => {
    if (event === undefined) return;
    panelLane(panelId)
      .run((host, sessionId) =>
        host.redis.latency.history({ sessionId, event, ...nodeOption(node) }),
      )
      .then(setHistory, (e: unknown) => setError(errorMessage(e)));
  }, [panelId, event, node]);

  const run = async (what: 'doctor' | 'threshold' | 'reset'): Promise<void> => {
    setError(undefined);
    try {
      if (what === 'doctor') {
        const { text } = await panelLane(panelId).run((host, sessionId) =>
          host.redis.latency.doctor({ sessionId, ...nodeOption(node) }),
        );
        setDoctor(text);
        return;
      }
      if (what === 'threshold') {
        const ms = Number(threshold);
        if (!Number.isInteger(ms) || ms < 0)
          throw new Error('Enter a threshold in whole milliseconds');
        await redisWrite({
          profileId: target.profileId,
          operation: WRITE,
          title: 'Change the latency threshold?',
          commands: [
            [word('CONFIG'), word('SET'), word('latency-monitor-threshold'), word(String(ms))],
          ],
          run: (confirmed) =>
            panelLane(panelId).run((host, sessionId) =>
              host.redis.latency.setThreshold({ sessionId, ms, confirmed, ...nodeOption(node) }),
            ),
        });
      } else {
        await redisWrite({
          profileId: target.profileId,
          operation: destructive('clears the latency history'),
          title: 'Reset the latency history?',
          commands: [[word('LATENCY'), word('RESET')]],
          confirmLabel: 'Reset',
          run: (confirmed) =>
            panelLane(panelId).run((host, sessionId) =>
              host.redis.latency.reset({ sessionId, confirmed, ...nodeOption(node) }),
            ),
        });
      }
      await latest.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="latency">
      <Toolbar label="Latency">
        <NodeSelect facts={facts} value={node} onChange={setNode} allowAll={false} />
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run('threshold');
          }}
        >
          <label className="flex items-center gap-1 text-xs text-muted">
            Threshold (ms, 0 = off)
            <Input
              aria-label="Latency threshold"
              className="h-7 w-20 text-xs"
              value={threshold}
              disabled={latest.data?.threshold === null}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          <Button size="sm" type="submit" disabled={latest.data?.threshold === null}>
            Set
          </Button>
        </form>
        <Button size="sm" onClick={() => void latest.reload()}>
          Refresh
        </Button>
        <Button size="sm" onClick={() => void run('doctor')}>
          Doctor
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void run('reset')}>
          Reset…
        </Button>
      </Toolbar>
      {(error ?? latest.error) && <Notice kind="error">{error ?? latest.error}</Notice>}
      {latest.data?.threshold === 0 && (
        <Notice kind="info">
          The latency monitor is off (latency-monitor-threshold is 0): set a threshold to record
          spikes.
        </Notice>
      )}
      {doctor && (
        <Notice kind="info" onClose={() => setDoctor(undefined)}>
          {doctor}
        </Notice>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table label="Latency events" head={['Event', 'Latest spike', 'Latest', 'All-time max']}>
          {(latest.data?.events ?? []).map((e) => (
            <tr
              key={e.event}
              className={cx(
                'cursor-default border-b border-border/50 hover:bg-hover',
                event === e.event && 'bg-accent/10',
              )}
              onClick={() => setEvent(e.event)}
            >
              <td className="px-2 py-1 font-mono">{e.event}</td>
              <td className="px-2 py-1">{timeText(e.timestamp)}</td>
              <td className="px-2 py-1">{e.latestMs} ms</td>
              <td className="px-2 py-1">{e.maxMs} ms</td>
            </tr>
          ))}
        </Table>
        {latest.data?.events.length === 0 && <EmptyState>No latency spikes recorded.</EmptyState>}
        {event !== undefined && (
          <section className="p-3">
            <h3 className="text-xs font-semibold">History of {event}</h3>
            <Sparkline values={history.map((s) => s.latencyMs)} label={`${event} latency`} />
            <p className="text-xs text-muted">
              {history.length} samples
              {history.length > 0 && `, max ${Math.max(...history.map((s) => s.latencyMs))} ms`}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const MAX_MONITOR_EVENTS = 2_000;

export function MonitorPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [node, setNode] = useState<string>();
  const [events, setEvents] = useState<(MonitorEvent & { readonly id: number })[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const stream = useRef<{ return(): Promise<unknown> } | undefined>(undefined);
  const counter = useRef(0);
  const stop = (): void => {
    void stream.current?.return().catch(() => undefined);
    stream.current = undefined;
    setRunning(false);
  };
  useEffect(() => onPanelDispose(panelId, stop), [panelId]);
  useEffect(() => () => stop(), []);
  const start = async (): Promise<void> => {
    setError(undefined);
    try {
      const { host, sessionId } = await laneSession(panelLane(panelId));
      const running = host.redis.monitor({ sessionId, ...nodeOption(node) });
      stream.current = running;
      setRunning(true);
      void (async () => {
        try {
          for await (const event of running) {
            counter.current += 1;
            const entry = { ...event, id: counter.current };
            setEvents((log) => appendBounded(log, [entry], MAX_MONITOR_EVENTS));
          }
        } catch (e) {
          if (stream.current === running) setError(errorMessage(e));
        } finally {
          if (stream.current === running) {
            stream.current = undefined;
            setRunning(false);
          }
        }
      })();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="monitor">
      <Toolbar label="Monitor">
        <NodeSelect facts={facts} value={node} onChange={setNode} />
        {running ? (
          <Button size="sm" variant="danger" onClick={stop}>
            Stop MONITOR
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void start()}>
            Start MONITOR
          </Button>
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted">{formatCount(events.length)} commands</span>
        <Button size="sm" variant="ghost" onClick={() => setEvents([])}>
          Clear
        </Button>
      </Toolbar>
      <Notice kind="warning">
        MONITOR streams every command the server runs to Joinery. It can cut a busy server’s
        throughput by half or more: run it briefly, and not on production servers under load.
      </Notice>
      {error && <Notice kind="error">{error}</Notice>}
      <div
        className="min-h-0 flex-1 overflow-auto font-mono text-xs"
        role="log"
        aria-label="Commands"
      >
        {events.map((e) => (
          <div key={e.id} className="flex gap-3 border-b border-border/50 px-2 py-0.5">
            <span className="w-28 shrink-0 text-muted">
              {new Date(e.timestamp * 1000).toLocaleTimeString()}
            </span>
            <span className="w-10 shrink-0 text-muted">db{e.db}</span>
            <span className="w-40 shrink-0 truncate text-muted">{e.source}</span>
            {e.node && facts?.info.server.clusterMode && (
              <span className="w-32 shrink-0 truncate text-muted">{e.node}</span>
            )}
            <span className="min-w-0 flex-1 break-all select-text">
              {formatCommandLine(e.args)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function BigKeysPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [node, setNode] = useState<string>();
  const [sampleSize, setSampleSize] = useState('5000');
  const [pattern, setPattern] = useState('');
  const [report, setReport] = useState<BigKeyReport>();
  const [progress, setProgress] = useState<{ sampled: number; scanCalls: number }>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => onPanelDispose(panelId, () => abort.current?.abort()), [panelId]);
  const cluster = facts?.info.server.clusterMode === true;

  const run = async (): Promise<void> => {
    setError(undefined);
    setReport(undefined);
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ sampled: 0, scanCalls: 0 });
    try {
      const size = Math.max(1, Math.min(1_000_000, Number(sampleSize) || 5000));
      const result = await panelLane(panelId).run((host, sessionId) =>
        host.redis.bigKeys(
          {
            sessionId,
            sampleSize: size,
            top: 50,
            ...(pattern.trim() !== '' ? { match: pattern.trim() } : {}),
            ...nodeOption(node),
          },
          { signal: controller.signal, onProgress: setProgress },
        ),
      );
      setReport(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(undefined);
      abort.current = undefined;
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="bigkeys">
      <Toolbar label="Big keys">
        <NodeSelect facts={facts} value={node} onChange={setNode} />
        <label className="flex items-center gap-1 text-xs text-muted">
          Sample
          <Input
            aria-label="Sample size"
            className="h-7 w-24 text-xs"
            value={sampleSize}
            onChange={(e) => setSampleSize(e.target.value)}
          />
          keys
        </label>
        <Input
          aria-label="Big keys pattern"
          placeholder="Pattern (optional)"
          className="h-7 w-48 font-mono text-xs"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        {progress ? (
          <Button size="sm" variant="danger" onClick={() => abort.current?.abort()}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void run()}>
            Analyse
          </Button>
        )}
        {progress && (
          <span className="text-xs text-muted" aria-live="polite">
            Sampled {formatCount(progress.sampled)} keys ({formatCount(progress.scanCalls)} SCAN
            calls)…
          </span>
        )}
      </Toolbar>
      {error && <Notice kind="error">{error}</Notice>}
      {report?.memoryDenied && (
        <Notice kind="warning">MEMORY USAGE was refused, so sizes are unknown.</Notice>
      )}
      {report?.cancelled && (
        <Notice kind="info">Cancelled: the figures cover the keys sampled so far.</Notice>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!report && !progress && (
          <EmptyState>
            Samples keys with SCAN and sizes them with MEMORY USAGE, grouped by key pattern (numbers
            and ids become *).{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => openDumpAnalysis()}
            >
              Analyse a dump file instead
            </button>{' '}
            to see every key without touching the server.
          </EmptyState>
        )}
        {report && (
          <>
            <div className="flex flex-wrap gap-3">
              <Stat
                label="Sampled"
                value={formatCount(report.sampled)}
                detail={`of ${formatCount(report.totalKeys)} keys${report.complete ? ' (all)' : ''}`}
              />
              <Stat label="Sampled memory" value={formatBytes(report.sampledBytes)} />
              <Stat
                label="Estimated total"
                value={formatBytes(report.estimatedTotalBytes)}
                detail="scaled to every key"
              />
              <Stat label="Time" value={`${(report.durationMs / 1000).toFixed(1)} s`} />
            </div>
            <h3 className="mt-4 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              By pattern
            </h3>
            <Table
              label="Patterns"
              head={['Pattern', 'Keys', 'Memory', 'Share', 'Average', 'Largest', 'Types']}
            >
              {report.patterns.map((p) => (
                <tr key={p.pattern} className="border-b border-border/50" data-testid="pattern-row">
                  <td className="px-2 py-1 font-mono">{p.pattern}</td>
                  <td className="px-2 py-1">{formatCount(p.count)}</td>
                  <td className="px-2 py-1">{formatBytes(p.totalBytes)}</td>
                  <td className="px-2 py-1">
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block h-1.5 w-16 rounded bg-panel-2">
                        <span
                          className="block h-1.5 rounded bg-accent"
                          style={{ width: `${Math.round(p.share * 100)}%` }}
                        />
                      </span>
                      {(p.share * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-2 py-1">{formatBytes(p.avgBytes)}</td>
                  <td className="px-2 py-1 font-mono">
                    {p.largestKey ? displayBytes(p.largestKey) : ''}
                  </td>
                  <td className="px-2 py-1">
                    {Object.entries(p.types)
                      .map(([t, n]) => `${t} ${n}`)
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </Table>
            <h3 className="mt-4 mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Largest keys
            </h3>
            <Table label="Largest keys" head={['Key', 'Type', 'Memory', 'Length', 'TTL']}>
              {report.largest.map((k, i) => (
                <tr
                  key={i}
                  className="cursor-default border-b border-border/50 hover:bg-hover"
                  onClick={() =>
                    openRedisPanel({
                      profileId: target.profileId,
                      profileName: target.profileName,
                      tool: 'value',
                      key: k.key,
                      ...(cluster ? {} : { database: 0 }),
                    })
                  }
                >
                  <td className="px-2 py-1 font-mono">{displayBytes(k.key)}</td>
                  <td className="px-2 py-1">
                    <TypeBadge type={k.type} />
                  </td>
                  <td className="px-2 py-1">{formatBytes(k.bytes)}</td>
                  <td className="px-2 py-1">{k.length === null ? '—' : formatCount(k.length)}</td>
                  <td className="px-2 py-1">{formatTtl(k.ttlMs)}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** The rules of a user as ACL SETUSER takes them, starting from a clean slate ("reset"). */
export function aclRulesOf(user: AclUser): string {
  const parts = ['reset', ...user.flags.filter((f) => f === 'on' || f === 'off' || f === 'nopass')];
  parts.push(...user.passwordHashes.map((h) => `#${h}`));
  if (user.keys) parts.push(...user.keys.split(' ').filter(Boolean));
  if (user.channels) parts.push(...user.channels.split(' ').filter(Boolean));
  if (user.commands) parts.push(...user.commands.split(' ').filter(Boolean));
  for (const s of user.selectors) {
    parts.push(`(${[s.keys, s.channels, s.commands].filter(Boolean).join(' ')})`);
  }
  return parts.join(' ');
}

export function AclPanel({ panelId, target }: ToolProps) {
  const users = usePanelData(
    panelId,
    async (host, sessionId) => {
      const [names, me] = await Promise.all([
        host.redis.acl.users({ sessionId }),
        host.redis.acl.whoAmI({ sessionId }).catch(() => ({ user: '' })),
      ]);
      return { names, me: me.user };
    },
    [],
  );
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [rules, setRules] = useState('');
  const [error, setError] = useState<string>();
  const detail = usePanelData(
    panelId,
    (host, sessionId) =>
      selected === undefined
        ? Promise.resolve(null)
        : host.redis.acl.getUser({ sessionId, name: selected }),
    [selected],
  );
  useEffect(() => {
    if (selected !== undefined && detail.data) {
      setName(selected);
      setRules(aclRulesOf(detail.data));
    }
  }, [selected, detail.data]);

  let ruleList: string[] = [];
  let ruleError: string | undefined;
  try {
    ruleList = parseNameList(rules).map((r) => new TextDecoder().decode(r));
  } catch (e) {
    ruleError = errorMessage(e);
  }
  const command = [word('ACL'), word('SETUSER'), word(name || '<name>'), ...ruleList.map(word)];

  const save = async (): Promise<void> => {
    setError(undefined);
    try {
      if (name.trim() === '') throw new Error('Enter the user name');
      if (ruleError) throw new Error(ruleError);
      const done = await redisWrite({
        profileId: target.profileId,
        operation: destructive('changes access control'),
        title: selected === name ? `Change user ${name}?` : `Create user ${name}?`,
        commands: [command],
        confirmLabel: 'Apply',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.acl.setUser({ sessionId, name, rules: ruleList, confirmed }),
          ),
      });
      if (done === undefined) return;
      setSelected(name);
      await users.reload();
      await detail.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async (user: string): Promise<void> => {
    setError(undefined);
    try {
      const done = await redisWrite({
        profileId: target.profileId,
        operation: destructive('deletes the ACL user'),
        title: `Delete user ${user}?`,
        commands: [[word('ACL'), word('DELUSER'), word(user)]],
        confirmLabel: 'Delete',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.acl.delUser({ sessionId, names: [user], confirmed }),
          ),
      });
      if (done === undefined) return;
      setSelected(undefined);
      setName('');
      setRules('');
      await users.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="acl">
      <Toolbar label="ACL users">
        <span className="text-xs text-muted">
          Signed in as <strong className="text-fg">{users.data?.me || '?'}</strong>
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          onClick={() => {
            setSelected(undefined);
            setName('');
            setRules('on >password ~app:* +@read');
          }}
        >
          New user
        </Button>
        <Button size="sm" onClick={() => void users.reload()}>
          Refresh
        </Button>
      </Toolbar>
      {(error ?? users.error ?? detail.error) && (
        <Notice kind="error">{error ?? users.error ?? detail.error}</Notice>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr]">
        <ul className="overflow-auto border-r border-border" aria-label="Users">
          {(users.data?.names ?? []).map((user) => (
            <li key={user}>
              <button
                type="button"
                className={cx(
                  'w-full px-3 py-1 text-left font-mono text-xs hover:bg-hover',
                  selected === user && 'bg-accent/10',
                )}
                onClick={() => setSelected(user)}
              >
                {user}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3 text-xs">
          {detail.data && (
            <dl className="grid grid-cols-[120px_1fr] gap-1" data-testid="acl-user">
              <dt className="text-muted">Flags</dt>
              <dd className="font-mono">{detail.data.flags.join(' ')}</dd>
              <dt className="text-muted">Passwords</dt>
              <dd>{detail.data.passwordHashes.length} (stored as SHA-256 hashes)</dd>
              <dt className="text-muted">Commands</dt>
              <dd className="font-mono">{detail.data.commands}</dd>
              <dt className="text-muted">Keys</dt>
              <dd className="font-mono">{detail.data.keys || '(none)'}</dd>
              <dt className="text-muted">Channels</dt>
              <dd className="font-mono">{detail.data.channels || '(none)'}</dd>
              {detail.data.selectors.length > 0 && (
                <>
                  <dt className="text-muted">Selectors</dt>
                  <dd className="font-mono">
                    {detail.data.selectors.map((s, i) => (
                      <div key={i}>
                        ({s.keys} {s.channels} {s.commands})
                      </div>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-muted">User name</span>
            <Input
              aria-label="ACL user name"
              className="h-7 font-mono text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">
              Rules (e.g. on &gt;secret ~app:* +@read -@dangerous); starting with reset replaces
              every rule
            </span>
            <textarea
              aria-label="ACL rules"
              className="h-24 rounded border border-border bg-panel-2 p-2 font-mono text-xs"
              value={rules}
              onChange={(e) => setRules(e.target.value)}
            />
          </label>
          <div>
            <span className="text-muted">Runs exactly:</span>
            <pre
              className="mt-1 rounded border border-border bg-panel-2 p-2 font-mono whitespace-pre-wrap"
              data-testid="acl-command"
            >
              {formatCommandLine(command, 4096)}
            </pre>
            {ruleError && <p className="text-danger">{ruleError}</p>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void save()}>
              {selected !== undefined && selected === name ? 'Apply changes' : 'Create user'}
            </Button>
            {selected !== undefined && (
              <Button size="sm" variant="ghost" onClick={() => void remove(selected)}>
                Delete user
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** Theme colours for the primaries' slot ranges (they repeat past six primaries). */
const SLOT_COLORS = [
  'var(--accent)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  'var(--focus)',
  'var(--muted)',
];

/** Slot ranges per primary as SVG segments of a 16,384-slot bar. */
export function slotSegments(view: RedisTopologyView): {
  readonly start: number;
  readonly end: number;
  readonly owner: string;
  readonly color: string;
}[] {
  const primaries = view.nodes.filter((n) => n.role === 'primary');
  return primaries.flatMap((node, i) =>
    node.slots.map(([start, end]) => ({
      start,
      end,
      owner: node.address,
      color: SLOT_COLORS[i % SLOT_COLORS.length]!,
    })),
  );
}

export function TopologyPanel({ panelId }: ToolProps) {
  const topology = usePanelData(
    panelId,
    (host, sessionId) => host.redis.topology({ sessionId }),
    [],
  );
  const view = topology.data;
  const segments = view ? slotSegments(view) : [];
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="topology">
      <Toolbar label="Topology">
        <span className="text-xs">
          {view ? (
            <>
              Mode: <strong data-testid="topology-mode">{view.topology}</strong> ·{' '}
              {view.nodes.length} nodes
            </>
          ) : (
            'Loading…'
          )}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => void topology.reload()}>
          Refresh
        </Button>
      </Toolbar>
      {topology.error && <Notice kind="error">{topology.error}</Notice>}
      {view && view.uncoveredSlots.length > 0 && (
        <Notice kind="warning">
          {view.uncoveredSlots.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')}: no
          primary serves these slots, so their keys cannot be read or written.
        </Notice>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {view?.topology === 'cluster' && (
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Slot map ({formatCount(CLUSTER_SLOTS)} slots)
            </h3>
            <svg
              viewBox={`0 0 ${CLUSTER_SLOTS} 10`}
              preserveAspectRatio="none"
              className="h-6 w-full rounded bg-panel-2"
              role="img"
              aria-label="Slot map"
              data-testid="slot-map"
            >
              {segments.map((s) => (
                <rect
                  key={`${s.owner}-${s.start}`}
                  x={s.start}
                  y={0}
                  width={s.end - s.start + 1}
                  height={10}
                  fill={s.color}
                >
                  <title>{`${s.start}-${s.end} on ${s.owner}`}</title>
                </rect>
              ))}
            </svg>
            <ul className="mt-1 flex flex-wrap gap-3 text-xs">
              {view.nodes
                .filter((n) => n.role === 'primary')
                .map((n, i) => (
                  <li key={n.address} className="flex items-center gap-1">
                    <span
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{ background: SLOT_COLORS[i % SLOT_COLORS.length] }}
                    />
                    <span className="font-mono">{n.address}</span>
                    <span className="text-muted">
                      {n.slots.map(([a, b]) => `${a}-${b}`).join(', ')}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        )}
        {view?.sentinel && (
          <section className="mb-4 text-xs" data-testid="sentinel">
            <h3 className="mb-1 font-semibold tracking-wide text-muted uppercase">Sentinel</h3>
            <p>
              Master <strong>{view.sentinel.masterName}</strong>
              {view.sentinel.master &&
                ` at ${view.sentinel.master.host}:${view.sentinel.master.port} (${view.sentinel.master.flags}) · ${view.sentinel.master.replicas} replicas · ${view.sentinel.master.sentinels} sentinels · quorum ${view.sentinel.master.quorum}`}
            </p>
            <p className="mt-1 text-muted">
              Sentinels: {view.sentinel.sentinels.map((s) => `${s.host}:${s.port}`).join(', ')}
            </p>
          </section>
        )}
        <Table
          label="Nodes"
          head={['Address', 'Role', 'Primary', 'State', 'Slots', 'Replication offset', 'Flags']}
        >
          {(view?.nodes ?? []).map((n) => (
            <tr
              key={n.id || n.address}
              className="border-b border-border/50"
              data-testid="topology-node"
            >
              <td className="px-2 py-1 font-mono">
                {n.address}
                {n.myself && <span className="ml-1 text-muted">(this one)</span>}
              </td>
              <td className="px-2 py-1">{n.role}</td>
              <td className="px-2 py-1 font-mono">
                {n.primaryId
                  ? (view?.nodes.find((p) => p.id === n.primaryId)?.address ??
                    n.primaryId.slice(0, 8))
                  : ''}
              </td>
              <td className={cx('px-2 py-1', n.failing && 'text-danger')}>{n.state}</td>
              <td className="px-2 py-1">
                {formatCount(n.slots.reduce((sum, [a, b]) => sum + b - a + 1, 0))}
              </td>
              <td className="px-2 py-1">
                {n.replicationOffset === undefined ? '' : formatCount(n.replicationOffset)}
              </td>
              <td className="px-2 py-1 font-mono">{n.flags.join(',')}</td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}
