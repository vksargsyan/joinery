import type { PendingEntry, StreamEntry, StreamGroup } from '@joinery/driver-redis';
import { bytesKey, displayBytes, parseDisplayBytes, utf8Bytes } from '@joinery/redis-tools';
import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import { WRITE, destructive } from '../../../../../shared/redis-safety';
import { redisWrite } from '../../../state/redis/panels';
import {
  parseStreamBound,
  parseStreamId,
  streamFields,
  streamIdTime,
} from '../../../state/redis/value-model';
import { Button, cx, Input, TAB } from '../../ui';
import { EmptyState, Notice, Toolbar } from '../common';
import { useValueEditor } from '../ValueEditorPanel';

/**
 * The stream editor (spec §10): entries by ID range (XRANGE / XREVRANGE), adding an entry
 * (XADD), consumer groups with their consumers, and the pending entries of a group (XPENDING)
 * with acknowledge (XACK) and claim (XCLAIM).
 */

const PAGE = 100;

function word(text: string): Uint8Array {
  return utf8Bytes(text);
}

export function StreamEditor() {
  const [tab, setTab] = useState<'entries' | 'groups'>('entries');
  return (
    <div className="flex h-full flex-col" data-testid="stream-editor">
      <div role="tablist" className="flex gap-0.5 border-b border-border bg-panel px-1">
        {(['entries', 'groups'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={TAB}
            onClick={() => setTab(t)}
          >
            {t === 'entries' ? 'Entries' : 'Consumer groups'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{tab === 'entries' ? <Entries /> : <Groups />}</div>
    </div>
  );
}

function Entries() {
  const editor = useValueEditor();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reverse, setReverse] = useState(true);
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    async (after?: string): Promise<void> => {
      setError(undefined);
      try {
        const low = parseStreamBound(start, '-');
        const high = parseStreamBound(end, '+');
        // Continue after the last entry shown, exclusive ("(" id, Redis 6.2+).
        const options = reverse
          ? { start: low, end: after ? `(${after}` : high, reverse: true, count: PAGE }
          : { start: after ? `(${after}` : low, end: high, count: PAGE };
        const page = await editor.run((host, sessionId) =>
          host.redis.stream.range({ sessionId, key: editor.key, options }),
        );
        setEntries((current) => (after ? [...current, ...page] : page));
        setMore(page.length === PAGE);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [editor, start, end, reverse],
  );
  useEffect(() => {
    void load();
    // Reload when the key or the order changes; the range applies on "Load".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytesKey(editor.key), reverse]);

  const remove = async (entry: StreamEntry): Promise<void> => {
    try {
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: destructive('removes the entry'),
        title: 'Delete the entry?',
        commands: [[word('XDEL'), editor.key, word(entry.id)]],
        confirmLabel: 'Delete',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.stream.delete({ sessionId, key: editor.key, ids: [entry.id], confirmed }),
          ),
      });
      if (!done) return;
      setEntries((current) => current.filter((e) => e.id !== entry.id));
      editor.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar label="Entries">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <Input
            aria-label="From id"
            placeholder="From id (-)"
            className="h-7 w-40 font-mono text-xs"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Input
            aria-label="To id"
            placeholder="To id (+)"
            className="h-7 w-40 font-mono text-xs"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <Button size="sm" type="submit">
            Load
          </Button>
        </form>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
          Newest first
        </label>
        <span className="flex-1" />
        <span className="text-xs text-muted">{formatCount(entries.length)} entries loaded</span>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add entry
        </Button>
      </Toolbar>
      {error && <Notice kind="error">{error}</Notice>}
      {adding && (
        <AddEntry
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto" role="grid" aria-label="Stream entries">
        {entries.length === 0 && <EmptyState>No entries in this range.</EmptyState>}
        {entries.map((entry) => (
          <div
            key={entry.id}
            role="row"
            data-testid="stream-entry"
            className="group flex items-start gap-3 border-b border-border/50 px-2 py-1 text-xs hover:bg-hover"
          >
            <span className="w-44 shrink-0 font-mono" title={streamIdTime(entry.id)}>
              {entry.id}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5 font-mono select-text">
              {entry.fields.map(([field, value], i) => (
                <span key={i}>
                  <span className="text-muted">{displayBytes(field)}</span>={displayBytes(value)}
                </span>
              ))}
            </span>
            <button
              type="button"
              aria-label={`Delete ${entry.id}`}
              className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
              onClick={() => void remove(entry)}
            >
              Delete
            </button>
          </div>
        ))}
        {more && (
          <div className="p-2 text-center">
            <Button size="sm" onClick={() => void load(entries.at(-1)?.id)}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddEntry(props: { readonly onClose: () => void; readonly onAdded: () => void }) {
  const editor = useValueEditor();
  const [id, setId] = useState('*');
  const [rows, setRows] = useState([{ field: '', value: '' }]);
  const [error, setError] = useState<string>();
  const add = async (): Promise<void> => {
    setError(undefined);
    try {
      const entryId = parseStreamId(id);
      const fields = streamFields(rows);
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: WRITE,
        title: 'Add the entry?',
        commands: [[word('XADD'), editor.key, word(entryId), ...fields.flat()]],
        confirmLabel: 'Add',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.stream.add({
              sessionId,
              key: editor.key,
              fields,
              options: { id: entryId },
              confirmed,
            }),
          ),
      });
      if (!done) return;
      editor.changed();
      props.onAdded();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div
      className="flex flex-col gap-2 border-b border-border bg-accent/5 p-2 text-xs"
      data-testid="add-entry"
    >
      <label className="flex items-center gap-2">
        ID
        <Input
          aria-label="Entry id"
          className="h-7 w-48 font-mono text-xs"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`Field ${i + 1}`}
            placeholder="field"
            className="h-7 w-48 font-mono text-xs"
            value={row.field}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))
            }
          />
          <Input
            aria-label={`Value ${i + 1}`}
            placeholder="value"
            className="h-7 flex-1 font-mono text-xs"
            value={row.value}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
            }
          />
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setRows([...rows, { field: '', value: '' }])}>
          + Field
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => void add()}>
          Add
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Groups() {
  const editor = useValueEditor();
  const [groups, setGroups] = useState<StreamGroup[]>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState('');
  const [startId, setStartId] = useState('$');

  const load = useCallback(async (): Promise<void> => {
    try {
      const loaded = await editor.run((host, sessionId) =>
        host.redis.stream.groups({ sessionId, key: editor.key }),
      );
      setGroups(loaded);
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [editor]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytesKey(editor.key)]);

  const create = async (): Promise<void> => {
    setError(undefined);
    try {
      if (name.trim() === '') throw new Error('Enter a group name');
      const group = parseDisplayBytes(name);
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: WRITE,
        title: 'Create the consumer group?',
        commands: [[word('XGROUP'), word('CREATE'), editor.key, group, word(startId || '$')]],
        confirmLabel: 'Create',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.stream.groupCreate({
              sessionId,
              key: editor.key,
              group,
              id: startId || '$',
              confirmed,
            }),
          ),
      });
      if (!done) return;
      setName('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const destroy = async (group: string): Promise<void> => {
    try {
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: destructive('removes the consumer group and its pending entries'),
        title: 'Destroy the consumer group?',
        commands: [[word('XGROUP'), word('DESTROY'), editor.key, word(group)]],
        confirmLabel: 'Destroy',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.stream.groupDestroy({ sessionId, key: editor.key, group, confirmed }),
          ),
      });
      if (!done) return;
      if (selected === group) setSelected(undefined);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar label="Consumer groups">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            aria-label="Group name"
            placeholder="New group"
            className="h-7 w-40 text-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            aria-label="Start id"
            title="$ = new entries only, 0 = from the start"
            className="h-7 w-24 font-mono text-xs"
            value={startId}
            onChange={(e) => setStartId(e.target.value)}
          />
          <Button size="sm" type="submit">
            Create group
          </Button>
        </form>
        <span className="flex-1" />
        <Button size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </Toolbar>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr]">
        <table className="w-full text-xs">
          <thead className="bg-panel text-left text-[11px] text-muted uppercase">
            <tr>
              <th className="px-2 py-1">Group</th>
              <th className="px-2 py-1 text-right">Consumers</th>
              <th className="px-2 py-1 text-right">Pending</th>
              <th className="px-2 py-1">Last delivered</th>
              <th className="px-2 py-1 text-right">Lag</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(groups ?? []).map((group) => (
              <tr
                key={group.name}
                className={cx(
                  'cursor-default border-b border-border/50 hover:bg-hover',
                  selected === group.name && 'bg-accent/10',
                )}
                onClick={() => setSelected(group.name)}
              >
                <td className="px-2 py-1 font-mono">{group.name}</td>
                <td className="px-2 py-1 text-right">{group.consumers}</td>
                <td className="px-2 py-1 text-right">{group.pending}</td>
                <td className="px-2 py-1 font-mono">{group.lastDeliveredId}</td>
                <td className="px-2 py-1 text-right">{group.lag ?? '—'}</td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    className="text-muted hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void destroy(group.name);
                    }}
                  >
                    Destroy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {groups?.length === 0 && <EmptyState>The stream has no consumer groups.</EmptyState>}
        {selected !== undefined && <Pending group={selected} onChanged={() => void load()} />}
      </div>
    </div>
  );
}

function Pending(props: { readonly group: string; readonly onChanged: () => void }) {
  const editor = useValueEditor();
  const [entries, setEntries] = useState<PendingEntry[]>([]);
  const [consumers, setConsumers] = useState<string[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [claimant, setClaimant] = useState('');
  const [minIdle, setMinIdle] = useState('0');
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const [pending, list] = await editor.run((host, sessionId) =>
        Promise.all([
          host.redis.stream.pendingRange({
            sessionId,
            key: editor.key,
            group: props.group,
            options: { start: '-', end: '+', count: 500 },
          }),
          host.redis.stream.consumers({ sessionId, key: editor.key, group: props.group }),
        ]),
      );
      setEntries(pending);
      setConsumers(list.map((c) => c.name));
      setChosen(new Set());
      setError(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [editor, props.group]);
  useEffect(() => {
    void load();
  }, [load]);

  const ids = [...chosen];
  const ack = async (): Promise<void> => {
    try {
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: WRITE,
        title: 'Acknowledge the entries?',
        commands: [[word('XACK'), editor.key, word(props.group), ...ids.map(word)]],
        confirmLabel: 'Acknowledge',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.stream.ack({
              sessionId,
              key: editor.key,
              group: props.group,
              ids,
              confirmed,
            }),
          ),
      });
      if (!done) return;
      await load();
      props.onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const claim = async (): Promise<void> => {
    try {
      if (claimant.trim() === '') throw new Error('Enter the consumer to claim for');
      const idle = Math.max(0, Number(minIdle) || 0);
      const consumer = parseDisplayBytes(claimant);
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: WRITE,
        title: 'Claim the entries?',
        commands: [
          [
            word('XCLAIM'),
            editor.key,
            word(props.group),
            consumer,
            word(String(idle)),
            ...ids.map(word),
            word('JUSTID'),
          ],
        ],
        confirmLabel: 'Claim',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.stream.claim({
              sessionId,
              key: editor.key,
              group: props.group,
              consumer,
              minIdleMs: idle,
              ids,
              options: { justId: true },
              confirmed,
            }),
          ),
      });
      if (!done) return;
      await load();
      props.onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-col border-t border-border" data-testid="pending-entries">
      <Toolbar label="Pending entries">
        <span className="text-xs font-semibold">Pending in {props.group}</span>
        <span className="text-xs text-muted">
          {entries.length} entries · consumers: {consumers.join(', ') || 'none'}
        </span>
        <span className="flex-1" />
        <Button size="sm" disabled={ids.length === 0} onClick={() => void ack()}>
          Acknowledge ({ids.length})
        </Button>
        <Input
          aria-label="Claim for consumer"
          placeholder="Consumer"
          className="h-7 w-32 text-xs"
          value={claimant}
          onChange={(e) => setClaimant(e.target.value)}
        />
        <Input
          aria-label="Minimum idle ms"
          title="Only entries idle at least this long (ms)"
          className="h-7 w-20 text-xs"
          value={minIdle}
          onChange={(e) => setMinIdle(e.target.value)}
        />
        <Button size="sm" disabled={ids.length === 0} onClick={() => void claim()}>
          Claim
        </Button>
      </Toolbar>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-panel text-left text-[11px] text-muted uppercase">
            <tr>
              <th className="w-8 px-2 py-1" />
              <th className="px-2 py-1">ID</th>
              <th className="px-2 py-1">Consumer</th>
              <th className="px-2 py-1 text-right">Idle</th>
              <th className="px-2 py-1 text-right">Deliveries</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-border/50">
                <td className="px-2 py-1">
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.id}`}
                    checked={chosen.has(entry.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(entry.id);
                      else next.delete(entry.id);
                      setChosen(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1 font-mono">{entry.id}</td>
                <td className="px-2 py-1">{entry.consumer}</td>
                <td className="px-2 py-1 text-right">{formatCount(entry.idleMs)} ms</td>
                <td className="px-2 py-1 text-right">{entry.deliveries}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <EmptyState>No pending entries.</EmptyState>}
      </div>
    </div>
  );
}
