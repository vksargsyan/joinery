import { newId } from '@joinery/core';
import { utf8Text, type CommandSuggestion } from '@joinery/redis-tools';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { errorInfo, errorMessage } from '../../lib/errors';
import { formatDuration } from '../../lib/format';
import { mainApi } from '../../lib/main-client';
import {
  classifyRedisCommand,
  decideRedisSafety,
  formatCommandLine,
  redisWritePolicy,
} from '../../../../shared/redis-safety';
import { useEditorAutosave } from '../../state/autosave';
import { profileById, queryClient } from '../../state/data';
import { confirm } from '../../state/dialogs';
import { usePanels } from '../../state/panels';
import {
  CliHistory,
  acceptSuggestion,
  cliCompletion,
  cliPrompt,
  parseCliInput,
  renderReply,
  toolForCommand,
  type CliEntry,
  type CliFormat,
} from '../../state/redis/cli';
import {
  onPanelDispose,
  openRedisPanel,
  panelLane,
  type RedisPanelTarget,
} from '../../state/redis/panels';
import { Button, Icon, cx } from '../ui';
import { NodeSelect, Notice, Separator, Toolbar, useConnectionFacts } from './common';

/**
 * The Redis CLI (spec §10): one command line with autocomplete and inline docs from the
 * server's command catalog, ↑/↓ history (kept in the query history), replies in redis-cli
 * format or as raw RESP, the answering node in Cluster mode with a target node for keyless
 * commands, and Cancel (which drops the connection, as redis-cli does). Commands that would take
 * over the connection are refused with a pointer to the tool that does their job.
 */

const MAX_ENTRIES = 500;
const SHOWN_SUGGESTIONS = 12;

export function CliPanel(props: { readonly panelId: string; readonly target: RedisPanelTarget }) {
  const { panelId, target } = props;
  const { facts, error: factsError } = useConnectionFacts(target.profileId);
  const catalog = facts?.catalog;
  const [entries, setEntries] = useState<CliEntry[]>([]);
  const [line, setLine] = useState(target.line ?? '');
  const [cursor, setCursor] = useState(target.line?.length ?? 0);
  const [format, setFormat] = useState<CliFormat>('cli');
  const [database, setDatabase] = useState(target.database ?? 0);
  const [multi, setMulti] = useState(false);
  const [node, setNode] = useState<string>();
  const [running, setRunning] = useState(false);
  const [popup, setPopup] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState(false);
  const history = useMemo(() => new CliHistory(), []);
  const input = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the new line has rendered (after a completion or a history
  // step). Placed before the next keystroke can arrive: a later frame could land mid-typing
  // and move the caret back into what was typed.
  const caret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (caret.current === undefined) return;
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  const log = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | undefined>(undefined);
  const title = usePanels((s) => s.panels[panelId]?.title ?? '');
  // The command line being typed autosaves with its logical database (spec §18).
  useEditorAutosave(panelId, {
    kind: 'redis-cli',
    profileId: target.profileId,
    database: target.database !== undefined || database !== 0 ? String(database) : null,
    title,
    text: line,
    cursor,
  });

  useEffect(() => {
    let live = true;
    mainApi()
      .history.list({ profileId: target.profileId, limit: 200 })
      .then((page) => {
        if (!live) return;
        for (const entry of [...page.entries].reverse()) history.push(entry.text);
      })
      .catch(() => undefined);
    const stop = onPanelDispose(panelId, () => abort.current?.abort());
    return () => {
      live = false;
      stop();
    };
  }, [history, panelId, target.profileId]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [entries]);

  // The dock focuses the new tab after mounting the panel: take the focus back.
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const completion = useMemo(() => cliCompletion(catalog, line, cursor), [catalog, line, cursor]);
  const items = completion.items.slice(0, SHOWN_SUGGESTIONS);
  const showPopup = popup && items.length > 0;
  const address =
    node ?? facts?.info.targetNode ?? facts?.info.nodes[0]?.address ?? target.profileName;

  const update = (id: string, patch: Partial<CliEntry>): void =>
    setEntries((current) => current.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const record = (
    text: string,
    status: 'success' | 'error' | 'cancelled',
    ms: number,
    error?: string,
  ): void => {
    void mainApi()
      .history.add({
        profileId: target.profileId,
        database: `db${database}`,
        text,
        status,
        durationMs: Math.max(0, ms),
        rowCount: null,
        error: error ?? null,
      })
      .then(() => queryClient.invalidateQueries({ queryKey: ['history'] }))
      .catch(() => undefined);
  };

  const runOne = async (args: Uint8Array[], signal: AbortSignal): Promise<boolean> => {
    const words = args.map(utf8Text);
    const text = formatCommandLine(args, 4096);
    const id = newId();
    const entry: CliEntry = { id, line: text, at: Date.now(), database, running: true };
    setEntries((current) => [...current, entry].slice(-MAX_ENTRIES));
    const started = performance.now();
    try {
      const profile = await profileById(target.profileId);
      const decision = profile
        ? decideRedisSafety(classifyRedisCommand(words, catalog), redisWritePolicy(profile))
        : ({ action: 'run' } as const);
      if (decision.action === 'refuse') {
        update(id, { running: false, error: decision.reason });
        record(text, 'error', 0, decision.reason);
        return false;
      }
      let confirmed = false;
      if (decision.action === 'confirm') {
        confirmed = await confirm({
          title: `Run ${words[0]?.toUpperCase() ?? 'the command'}?`,
          message: decision.destructive
            ? `This command ${decision.reason}.`
            : `${decision.reason}.`,
          detail: formatCommandLine(args),
          confirmLabel: 'Run',
          danger: true,
        });
        if (!confirmed) {
          update(id, { running: false, cancelled: true, error: 'Not run' });
          return false;
        }
      }
      const result = await panelLane(panelId).run((host, sessionId) =>
        host.redis.command(
          { sessionId, args, confirmed, ...(node !== undefined ? { node } : {}) },
          { signal },
        ),
      );
      setDatabase(result.database);
      setMulti(result.inTransaction);
      update(id, {
        running: false,
        reply: result.reply,
        durationMs: result.durationMs,
        ...(result.node !== undefined ? { node: result.node } : {}),
      });
      const reply = result.reply;
      if (reply.type === 'error') record(text, 'error', result.durationMs, reply.value);
      else record(text, 'success', result.durationMs);
      return true;
    } catch (error) {
      const info = errorInfo(error);
      const cancelled = info.code === 'CANCELLED';
      update(id, {
        running: false,
        error: cancelled
          ? 'Cancelled: the connection was reset (an open MULTI was discarded)'
          : info.message,
        ...(info.hint !== undefined ? { hint: info.hint } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      });
      if (cancelled) setMulti(false);
      record(text, cancelled ? 'cancelled' : 'error', performance.now() - started, info.message);
      return false;
    }
  };

  const run = async (): Promise<void> => {
    const text = line.trim();
    if (text === '' || running) return;
    let commands: Uint8Array[][];
    try {
      commands = parseCliInput(line);
    } catch (e) {
      setEntries((current) => [
        ...current,
        { id: newId(), line: text, at: Date.now(), database, error: errorMessage(e) },
      ]);
      return;
    }
    if (text.toLowerCase() === 'clear') {
      setEntries([]);
      setLine('');
      return;
    }
    history.push(text);
    setLine('');
    setCursor(0);
    setPopup(false);
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    try {
      for (const args of commands) {
        if (controller.signal.aborted || !(await runOne(args, controller.signal))) break;
      }
    } finally {
      setRunning(false);
      abort.current = undefined;
      input.current?.focus();
    }
  };

  const accept = (suggestion: CommandSuggestion): void => {
    const next = acceptSuggestion(line, completion, suggestion);
    setLine(next.line);
    setCursor(next.cursor);
    setHighlight(0);
    setPicked(false);
    caret.current = next.cursor;
  };

  const setFromHistory = (text: string | undefined): void => {
    if (text === undefined) return;
    setLine(text);
    setCursor(text.length);
    setPopup(false);
    caret.current = text.length;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Tab' && items.length > 0) {
      event.preventDefault();
      accept(items[showPopup ? highlight : 0]!);
      return;
    }
    if (event.key === ' ' && event.ctrlKey) {
      event.preventDefault();
      setPopup(true);
      return;
    }
    if (event.key === 'Escape') {
      setPopup(false);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (showPopup && (picked || line.trim() !== '')) {
        event.preventDefault();
        setPicked(true);
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        setHighlight((h) => (h + delta + items.length) % items.length);
        return;
      }
      if (!line.includes('\n')) {
        event.preventDefault();
        setFromHistory(event.key === 'ArrowUp' ? history.up(line) : history.down());
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (showPopup && picked) accept(items[highlight]!);
      else void run();
    }
  };

  const openTool = (tool: 'pubsub' | 'monitor'): void => {
    openRedisPanel({ profileId: target.profileId, profileName: target.profileName, tool });
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="redis-cli">
      <Toolbar label="Redis CLI">
        <div className="flex rounded border border-border" role="radiogroup" aria-label="Output">
          {(['cli', 'resp'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              className={cx(
                'h-7 px-2 text-xs',
                format === f ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => setFormat(f)}
            >
              {f === 'cli' ? 'redis-cli' : 'Raw RESP'}
            </button>
          ))}
        </div>
        <NodeSelect
          facts={facts}
          value={node}
          label="Keyless commands on"
          onChange={(next) => {
            setNode(next);
            void panelLane(panelId)
              .run((host, sessionId) =>
                host.redis.setTargetNode({
                  sessionId,
                  ...(next !== undefined ? { node: next } : {}),
                }),
              )
              .catch(() => undefined);
          }}
        />
        <Separator />
        <Button
          size="sm"
          variant={running ? 'danger' : 'secondary'}
          disabled={!running}
          onClick={() => abort.current?.abort()}
          title="Cancel the running command (resets the connection)"
        >
          <Icon name="stop" className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEntries([])}>
          Clear
        </Button>
        <span className="flex-1" />
        {multi && (
          <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
            MULTI
          </span>
        )}
        <span className="text-xs text-muted" data-testid="cli-database">
          db{database}
        </span>
      </Toolbar>
      {factsError && <Notice kind="error">{factsError}</Notice>}
      {facts && !catalog && (
        <Notice kind="info">
          The server refused COMMAND DOCS and COMMAND INFO: no autocomplete for this connection.
        </Notice>
      )}
      <div
        ref={log}
        className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[12.5px]"
        data-testid="cli-output"
        aria-live="polite"
        onClick={() => input.current?.focus()}
      >
        {entries.map((entry) => (
          <div key={entry.id} className="mb-1.5" data-testid="cli-entry">
            <div className="flex gap-2 text-muted">
              <span className="text-accent">{cliPrompt(address, entry.database)}</span>
              <span className="text-fg whitespace-pre-wrap select-text">{entry.line}</span>
              <span className="flex-1" />
              {entry.node && <span title="Answered by">{entry.node}</span>}
              {entry.durationMs !== undefined && <span>{formatDuration(entry.durationMs)}</span>}
            </div>
            {entry.running && <div className="text-muted">running…</div>}
            {entry.reply && (
              <pre
                className={cx(
                  'whitespace-pre-wrap select-text',
                  entry.reply.type === 'error' && 'text-danger',
                )}
                data-testid="cli-reply"
              >
                {renderReply(entry.reply, format)}
              </pre>
            )}
            {entry.error && (
              <div
                className={cx(entry.cancelled ? 'text-warning' : 'text-danger')}
                data-testid="cli-error"
              >
                (error) {entry.error}
                {entry.hint && <span className="text-muted"> — {entry.hint}</span>}
                {(() => {
                  const tool = toolForCommand(entry.line.split(' '));
                  return tool && !entry.cancelled ? (
                    <Button size="sm" className="ml-2" onClick={() => openTool(tool)}>
                      Open {tool === 'pubsub' ? 'Pub/Sub' : 'Monitor'}
                    </Button>
                  ) : null;
                })()}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="relative border-t border-border bg-panel p-2">
        {showPopup && (
          <ul
            role="listbox"
            aria-label="Suggestions"
            data-testid="cli-suggestions"
            className="absolute bottom-full left-2 z-20 mb-1 max-h-72 w-[520px] overflow-auto rounded border border-border bg-panel py-1 text-xs shadow-xl"
          >
            {items.map((item, i) => (
              <li
                key={`${item.kind}:${item.text}`}
                role="option"
                aria-selected={i === highlight}
                className={cx(
                  'flex cursor-default gap-2 px-2 py-0.5',
                  i === highlight ? 'bg-accent text-accent-fg' : 'hover:bg-hover',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(item);
                }}
              >
                <span className="font-mono font-semibold">{item.text}</span>
                {item.optional && <span className="opacity-70">optional</span>}
                <span className="truncate opacity-70">{item.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-start gap-2">
          <span className="pt-1 font-mono text-[12.5px] text-accent">
            {cliPrompt(address, database)}
          </span>
          <textarea
            ref={input}
            aria-label="Redis command"
            data-testid="cli-input"
            rows={Math.min(6, line.split('\n').length)}
            spellCheck={false}
            autoFocus
            className="min-h-7 flex-1 resize-none rounded border border-border bg-panel-2 px-2 py-1 font-mono text-[12.5px] text-fg focus:border-accent focus:outline-none"
            placeholder="Type a command; Tab completes, ↑/↓ recall history"
            value={line}
            onChange={(event) => {
              setLine(event.target.value);
              setCursor(event.target.selectionStart);
              setPopup(true);
              setHighlight(0);
              setPicked(false);
            }}
            onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onBlur={() => setPopup(false)}
          />
          <Button size="sm" variant="primary" onClick={() => void run()} disabled={running}>
            <Icon name="play" className="h-3.5 w-3.5" />
            Run
          </Button>
        </div>
        <InlineDocs completion={completion} />
      </div>
    </div>
  );
}

function InlineDocs(props: { readonly completion: ReturnType<typeof cliCompletion> }) {
  const { command, syntax, nextArguments, currentArguments, unknownCommand, complete } =
    props.completion;
  if (unknownCommand) {
    return <p className="mt-1 text-xs text-warning">Unknown command</p>;
  }
  if (!command || !syntax) return null;
  return (
    <div className="mt-1 text-xs" data-testid="cli-docs">
      <p className="font-mono">
        <span className="text-fg">{syntax}</span>
      </p>
      <p className="text-muted">
        {command.summary}
        {command.since && ` · since ${command.since}`}
        {command.complexity && ` · ${command.complexity}`}
      </p>
      {currentArguments.length > 0 && (
        <p className="text-muted" data-testid="cli-current-arg">
          Typing: <span className="font-mono">{currentArguments.join(' or ')}</span>
        </p>
      )}
      {nextArguments.length > 0 && (
        <p className="text-muted" data-testid="cli-next-args">
          Next: <span className="font-mono">{nextArguments.join(' ')}</span>
          {complete && ' (or run it now)'}
        </p>
      )}
    </div>
  );
}
