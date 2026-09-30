import type { PubSubMessage } from '@joinery/driver-redis';
import { displayBytes, parseDisplayBytes, utf8Bytes } from '@joinery/redis-tools';
import { useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import { WRITE } from '../../../../../shared/redis-safety';
import { appendBounded, parseNameList } from '../../../state/redis/cli';
import {
  laneSession,
  onPanelDispose,
  panelLane,
  redisWrite,
  type RedisPanelTarget,
} from '../../../state/redis/panels';
import { Button, Input } from '../../ui';
import { EmptyState, Notice, Separator, Toolbar } from '../common';

/**
 * Pub/Sub (spec §10): subscribe to channels and patterns on a connection of its own (the host
 * streams the messages), publish, and a message log of the latest messages. Stopping the
 * subscription (or closing the panel) unsubscribes.
 */

const MAX_MESSAGES = 1_000;

interface LoggedMessage extends PubSubMessage {
  readonly id: number;
}

export function PubSubPanel(props: {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}) {
  const { panelId, target } = props;
  const [channels, setChannels] = useState('');
  const [patterns, setPatterns] = useState('');
  const [active, setActive] = useState<{ channels: string[]; patterns: string[] }>();
  const [messages, setMessages] = useState<LoggedMessage[]>([]);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string>();
  const [channel, setChannel] = useState('');
  const [message, setMessage] = useState('');
  const [published, setPublished] = useState<string>();
  const [live, setLive] = useState<string[]>();
  const stream = useRef<{ return(): Promise<unknown> } | undefined>(undefined);
  const counter = useRef(0);

  const stop = (): void => {
    void stream.current?.return().catch(() => undefined);
    stream.current = undefined;
    setActive(undefined);
  };
  useEffect(() => onPanelDispose(panelId, stop), [panelId]);
  useEffect(() => () => stop(), []);

  const subscribe = async (): Promise<void> => {
    setError(undefined);
    let channelList: Uint8Array[];
    let patternList: Uint8Array[];
    try {
      channelList = parseNameList(channels);
      patternList = parseNameList(patterns);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (channelList.length === 0 && patternList.length === 0) {
      setError('Enter at least one channel or pattern');
      return;
    }
    stop();
    try {
      const { host, sessionId } = await laneSession(panelLane(panelId));
      const running = host.redis.subscribe({
        sessionId,
        ...(channelList.length > 0 ? { channels: channelList } : {}),
        ...(patternList.length > 0 ? { patterns: patternList } : {}),
      });
      stream.current = running;
      setActive({
        channels: channelList.map(displayBytes),
        patterns: patternList.map(displayBytes),
      });
      void (async () => {
        try {
          for await (const received of running) {
            counter.current += 1;
            const entry = { ...received, id: counter.current };
            if (received.dropped > 0) setDropped((d) => d + received.dropped);
            setMessages((log) => appendBounded(log, [entry], MAX_MESSAGES));
          }
        } catch (e) {
          if (stream.current === running) setError(errorMessage(e));
        } finally {
          if (stream.current === running) {
            stream.current = undefined;
            setActive(undefined);
          }
        }
      })();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const publish = async (): Promise<void> => {
    setError(undefined);
    setPublished(undefined);
    try {
      if (channel === '') throw new Error('Enter the channel to publish to');
      const name = parseDisplayBytes(channel);
      const body = parseDisplayBytes(message);
      const result = await redisWrite({
        profileId: target.profileId,
        operation: WRITE,
        title: 'Publish the message?',
        commands: [[utf8Bytes('PUBLISH'), name, body]],
        confirmLabel: 'Publish',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.publish({ sessionId, channel: name, message: body, confirmed }),
          ),
      });
      if (result) {
        setPublished(`Delivered to ${formatCount(result.receivers)} subscribers`);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const refreshChannels = async (): Promise<void> => {
    try {
      const list = await panelLane(panelId).run((host, sessionId) =>
        host.redis.channels({ sessionId }),
      );
      setLive(list.map(displayBytes).sort());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="pubsub">
      <Toolbar label="Subscribe">
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void subscribe();
          }}
        >
          <Input
            aria-label="Channels"
            placeholder="Channels, e.g. news orders"
            className="h-7 w-56 font-mono text-xs"
            value={channels}
            onChange={(e) => setChannels(e.target.value)}
          />
          <Input
            aria-label="Patterns"
            placeholder="Patterns, e.g. news.*"
            className="h-7 w-48 font-mono text-xs"
            value={patterns}
            onChange={(e) => setPatterns(e.target.value)}
          />
          <Button size="sm" variant="primary" type="submit">
            {active ? 'Resubscribe' : 'Subscribe'}
          </Button>
        </form>
        {active && (
          <Button size="sm" onClick={stop}>
            Unsubscribe
          </Button>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void refreshChannels()}>
          Active channels
        </Button>
      </Toolbar>
      <Toolbar label="Publish">
        <form
          className="flex flex-1 flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void publish();
          }}
        >
          <Input
            aria-label="Publish channel"
            placeholder="Channel"
            className="h-7 w-48 font-mono text-xs"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
          <Input
            aria-label="Message"
            placeholder="Message"
            className="h-7 min-w-48 flex-1 font-mono text-xs"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <Button size="sm" type="submit">
            Publish
          </Button>
        </form>
        {published && (
          <span className="text-xs text-muted" data-testid="published">
            {published}
          </span>
        )}
      </Toolbar>
      {error && (
        <Notice kind="error" onClose={() => setError(undefined)}>
          {error}
        </Notice>
      )}
      {live && (
        <Notice kind="info" onClose={() => setLive(undefined)}>
          Active channels: {live.length > 0 ? live.join(', ') : 'none'}
        </Notice>
      )}
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs">
        <span data-testid="subscription-state">
          {active
            ? `Subscribed to ${[...active.channels, ...active.patterns.map((p) => `${p} (pattern)`)].join(', ')}`
            : 'Not subscribed'}
        </span>
        <Separator />
        <span className="text-muted">
          {formatCount(messages.length)} messages
          {dropped > 0 && ` · ${formatCount(dropped)} dropped`}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setMessages([])}>
          Clear
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" role="log" aria-label="Message log">
        {messages.length === 0 && <EmptyState>Messages appear here as they arrive.</EmptyState>}
        {[...messages].reverse().map((m) => (
          <div
            key={m.id}
            data-testid="pubsub-message"
            className="flex gap-3 border-b border-border/50 px-2 py-0.5 font-mono text-xs"
          >
            <span className="w-24 shrink-0 text-muted">
              {new Date(m.receivedAt).toLocaleTimeString()}
            </span>
            <span
              className="w-48 shrink-0 truncate text-accent"
              title={m.pattern ? `via ${displayBytes(m.pattern)}` : undefined}
            >
              {displayBytes(m.channel)}
            </span>
            <span className="min-w-0 flex-1 break-all whitespace-pre-wrap select-text">
              {displayBytes(m.message)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
