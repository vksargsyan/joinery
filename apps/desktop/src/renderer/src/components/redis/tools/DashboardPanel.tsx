import type { InfoSections } from '@querybara/redis-tools';
import { useRef, useState } from 'react';

import { errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import {
  DEFAULT_POLL_MS,
  POLL_CHOICES_MS,
  deriveDashboard,
  formatUptime,
  pushSample,
  sampleFrom,
  sparklinePath,
  type DashboardSample,
} from '../../../state/redis/dashboard';
import { panelLane, type RedisPanelTarget } from '../../../state/redis/panels';
import { formatBytes } from '../../../state/redis/value-model';
import { Button } from '../../ui';
import { NodeSelect, Notice, Stat, Toolbar, useConnectionFacts, usePolling } from '../common';

/**
 * The INFO dashboard (spec §10, §15): memory, ops per second, clients, hit ratio, keyspace and
 * replication from INFO, polled at the chosen interval (5 s by default) with the history kept
 * for the session as sparklines. In Cluster mode it sums every primary, or shows one node.
 */

function percent(ratio: number | undefined): string {
  return ratio === undefined ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

export function Sparkline(props: {
  readonly values: readonly number[];
  readonly label: string;
  readonly width?: number;
  readonly height?: number;
}) {
  const width = props.width ?? 220;
  const height = props.height ?? 36;
  const path = sparklinePath(props.values, width, height - 2);
  return (
    <svg
      role="img"
      aria-label={`${props.label} over time`}
      viewBox={`0 -1 ${width} ${height}`}
      className="h-9 w-full text-accent"
      preserveAspectRatio="none"
    >
      {path && (
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export function DashboardPanel(props: {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}) {
  const { panelId, target } = props;
  const { facts } = useConnectionFacts(target.profileId);
  const [interval, setPollInterval] = useState(DEFAULT_POLL_MS);
  const [paused, setPaused] = useState(false);
  const [node, setNode] = useState<string>();
  const [samples, setSamples] = useState<DashboardSample[]>([]);
  const [error, setError] = useState<string>();
  const [doctor, setDoctor] = useState<string>();
  const busy = useRef(false);
  const cluster = facts?.info.server.clusterMode === true;

  usePolling(
    () => {
      if (busy.current || !facts) return;
      busy.current = true;
      panelLane(panelId)
        .run(async (host, sessionId): Promise<InfoSections[]> => {
          if (cluster && node === undefined) {
            return (await host.redis.infoAll({ sessionId })).map((n) => n.info);
          }
          return [await host.redis.info({ sessionId, ...(node !== undefined ? { node } : {}) })];
        })
        .then(
          (infos) => {
            setSamples((current) => pushSample(current, sampleFrom(Date.now(), infos)));
            setError(undefined);
          },
          (e: unknown) => setError(errorMessage(e)),
        )
        .finally(() => {
          busy.current = false;
        });
    },
    interval,
    paused || !facts,
  );

  const view = deriveDashboard(samples);
  const runDoctor = async (): Promise<void> => {
    try {
      const { text } = await panelLane(panelId).run((host, sessionId) =>
        host.redis.memoryDoctor({ sessionId, ...(node !== undefined ? { node } : {}) }),
      );
      setDoctor(text);
    } catch (e) {
      setDoctor(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="info-dashboard">
      <Toolbar label="Dashboard">
        <label className="flex items-center gap-1 text-xs text-muted">
          Refresh every
          <select
            aria-label="Refresh interval"
            className="h-7 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
            value={interval}
            onChange={(e) => setPollInterval(Number(e.target.value))}
          >
            {POLL_CHOICES_MS.map((ms) => (
              <option key={ms} value={ms}>
                {ms / 1000} s
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" onClick={() => setPaused(!paused)} aria-pressed={paused}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <NodeSelect
          facts={facts}
          value={node}
          onChange={(next) => {
            setNode(next);
            setSamples([]);
          }}
        />
        <span className="flex-1" />
        {view.server && (
          <span className="text-xs text-muted">
            {view.server.flavor === 'valkey' ? 'Valkey' : 'Redis'} {view.server.version}
            {view.server.mode && ` · ${view.server.mode}`}
            {view.uptimeSeconds !== undefined && ` · up ${formatUptime(view.uptimeSeconds)}`}
            {samples.at(-1) && samples.at(-1)!.nodes > 1 && ` · ${samples.at(-1)!.nodes} primaries`}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void runDoctor()}>
          Memory doctor
        </Button>
      </Toolbar>
      {error && <Notice kind="error">{error}</Notice>}
      {doctor && (
        <Notice kind="info" onClose={() => setDoctor(undefined)}>
          {doctor}
        </Notice>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="flex flex-wrap gap-3">
          <Stat
            label="Memory"
            value={formatBytes(view.memory.used)}
            detail={`${view.memory.max ? `of ${formatBytes(view.memory.max)} (${percent(view.memory.usedShare)}) · ` : ''}peak ${formatBytes(view.memory.peak)} · RSS ${formatBytes(view.memory.rss)}${view.memory.fragmentation !== undefined ? ` · fragmentation ${view.memory.fragmentation.toFixed(2)}` : ''}`}
          >
            <Sparkline values={view.series.memory} label="Memory" />
          </Stat>
          <Stat
            label="Ops/sec"
            value={view.opsPerSec === undefined ? '—' : formatCount(view.opsPerSec)}
          >
            <Sparkline values={view.series.opsPerSec} label="Operations per second" />
          </Stat>
          <Stat
            label="Clients"
            value={view.clients.connected === undefined ? '—' : formatCount(view.clients.connected)}
            detail={`${formatCount(view.clients.blocked ?? 0)} blocked`}
          >
            <Sparkline values={view.series.clients} label="Clients" />
          </Stat>
          <Stat
            label="Hit ratio"
            value={percent(view.recentHitRatio ?? view.hitRatio)}
            detail={`since the stats reset: ${percent(view.hitRatio)}`}
          >
            <Sparkline values={view.series.hitRatio} label="Hit ratio" />
          </Stat>
          <Stat
            label="Keys"
            value={formatCount(view.keys.total)}
            detail={`${formatCount(view.keys.withExpiry)} with a TTL · ${formatCount(view.expiredKeys ?? 0)} expired · ${formatCount(view.evictedKeys ?? 0)} evicted`}
          />
          <Stat
            label="Network"
            value={`${(view.network.inputKbps ?? 0).toFixed(1)} / ${(view.network.outputKbps ?? 0).toFixed(1)}`}
            detail="KB/s in / out"
          />
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <section>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Keyspace
            </h3>
            <table className="w-full text-xs" data-testid="keyspace">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-0.5">Database</th>
                  <th className="text-right">Keys</th>
                  <th className="text-right">With TTL</th>
                  <th className="text-right">Average TTL</th>
                </tr>
              </thead>
              <tbody>
                {view.keyspace.map((k) => (
                  <tr key={k.db} className="border-t border-border/50">
                    <td className="py-0.5 font-mono">db{k.db}</td>
                    <td className="text-right">{formatCount(k.keys)}</td>
                    <td className="text-right">{formatCount(k.expires)}</td>
                    <td className="text-right">
                      {k.avgTtlMs ? `${Math.round(k.avgTtlMs / 1000)} s` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.keyspace.length === 0 && <p className="text-xs text-muted">No keys.</p>}
          </section>
          <section>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Replication
            </h3>
            <p className="text-xs" data-testid="replication-role">
              Role: <strong>{view.replication.isReplica ? 'replica' : 'primary'}</strong>
              {view.replication.master &&
                ` of ${view.replication.master.host}:${view.replication.master.port} (link ${view.replication.master.linkStatus})`}
              {!view.replication.isReplica &&
                ` · ${view.replication.connectedReplicas} connected replicas`}
            </p>
            <ul className="mt-1 text-xs">
              {view.replication.replicas.map((r) => (
                <li key={`${r.ip}:${r.port}`} className="font-mono">
                  {r.ip}:{r.port} · {r.state} · offset {formatCount(r.offset)} · lag {r.lag} s
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
