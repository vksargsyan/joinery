import type { KeyInfo } from '@querybara/driver-redis';
import { bytesKey, displayBytes, utf8Bytes } from '@querybara/redis-tools';
import { createContext, useContext, useMemo, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import type { HostClient } from '../../lib/main-client';
import { WRITE, destructive } from '../../../../shared/redis-safety';
import {
  emitKeyChange,
  openRedisPanel,
  panelLane,
  redisWrite,
  retargetPanel,
  type RedisConnectionFacts,
  type RedisPanelTarget,
} from '../../state/redis/panels';
import {
  EditError,
  editCommands,
  formatBytes,
  formatTtl,
  type ValueEdit,
} from '../../state/redis/value-model';
import { Button, Icon } from '../ui';
import { Notice, Separator, Toolbar, TypeBadge, useConnectionFacts, usePanelData } from './common';
import { HashEditor, ListEditor, SetEditor, ZSetEditor } from './editors/CollectionEditors';
import { JsonEditor } from './editors/JsonEditor';
import { StreamEditor } from './editors/StreamEditor';
import { StringEditor } from './editors/StringEditor';
import { CopyDialog, RenameDialog, TtlDialog } from './KeyDialogs';

/**
 * A key's value editor (spec §10): the key's type, TTL, length, encoding and memory, the
 * editor for its type, and the key actions (TTL / persist, rename, copy, delete). Edits apply
 * one at a time under the write rules; everything is binary-safe.
 */

export interface ValueEditorContext {
  readonly panelId: string;
  readonly profileId: string;
  readonly key: Uint8Array;
  readonly database: number | undefined;
  readonly facts: RedisConnectionFacts | undefined;
  /** Runs a task on the panel's session. */
  run<T>(task: (host: HostClient, sessionId: string) => Promise<T>): Promise<T>;
  /**
   * Applies edits under the write rules (one confirmation for all of them when needed); false
   * when the user declined. `removal` marks edits that remove data (always confirmed).
   */
  apply(edits: readonly ValueEdit[], options?: { readonly removal?: string }): Promise<boolean>;
  /** The value changed: refresh the header and tell the other panels. */
  changed(): void;
}

const EditorContext = createContext<ValueEditorContext | undefined>(undefined);

export function useValueEditor(): ValueEditorContext {
  const context = useContext(EditorContext);
  if (!context) throw new Error('useValueEditor outside a value editor');
  return context;
}

/** Sends one edit; renames that would collide are refused by the server's answer. */
async function sendEdit(
  host: HostClient,
  sessionId: string,
  key: Uint8Array,
  edit: ValueEdit,
  confirmed: boolean,
): Promise<void> {
  const redis = host.redis;
  switch (edit.op) {
    case 'hset':
      await redis.hash.set({
        sessionId,
        key,
        entries: edit.entries.map(([field, value]): [Uint8Array, Uint8Array] => [field, value]),
        confirmed,
      });
      return;
    case 'hdel':
      await redis.hash.delete({ sessionId, key, fields: [...edit.fields], confirmed });
      return;
    case 'sadd': {
      const { added } = await redis.set.add({
        sessionId,
        key,
        members: [...edit.members],
        confirmed,
      });
      if (added === 0) throw new EditError('It is already a member; nothing changed');
      return;
    }
    case 'srem':
      await redis.set.remove({ sessionId, key, members: [...edit.members], confirmed });
      return;
    case 'zadd': {
      const { added } = await redis.zset.add({
        sessionId,
        key,
        entries: edit.entries.map(([member, score]) => [member, score] as [Uint8Array, string]),
        confirmed,
        ...(edit.condition ? { condition: edit.condition } : {}),
      });
      if (edit.condition === 'nx' && added === 0) {
        throw new EditError('It is already a member; nothing changed');
      }
      return;
    }
    case 'zrem':
      await redis.zset.remove({ sessionId, key, members: [...edit.members], confirmed });
      return;
    case 'lset':
      await redis.list.set({ sessionId, key, index: edit.index, value: edit.value, confirmed });
      return;
    case 'lrem-at': {
      const { removed } = await redis.list.removeAt({
        sessionId,
        key,
        index: edit.index,
        expected: edit.expected,
        confirmed,
      });
      if (!removed) throw new EditError('The list changed meanwhile; refresh and try again');
      return;
    }
    case 'push':
      await redis.list.push({
        sessionId,
        key,
        values: [...edit.values],
        side: edit.side,
        confirmed,
      });
      return;
  }
}

export function ValueEditorPanel(props: {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}) {
  const { panelId, target } = props;
  const key = target.key ?? new Uint8Array(0);
  const { facts } = useConnectionFacts(target.profileId);
  const [dialog, setDialog] = useState<'ttl' | 'rename' | 'copy'>();
  const [actionError, setActionError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const cluster = facts?.info.server.clusterMode === true;
  const database = cluster ? undefined : (target.database ?? 0);
  const info = usePanelData(
    panelId,
    async (host, sessionId): Promise<{ info: KeyInfo | undefined; memory: number | null }> => {
      const [[keyInfo], [memory]] = await Promise.all([
        host.redis.keyInfo({ sessionId, keys: [key] }),
        host.redis.memoryUsage({ sessionId, keys: [key] }).catch(() => [null]),
      ]);
      return { info: keyInfo, memory: memory ?? null };
    },
    [bytesKey(key)],
  );
  const keyInfo = info.data?.info;
  const scope = { panelId, profileId: target.profileId, database };

  const reloadInfo = info.reload;
  const keyId = bytesKey(key);
  const context = useMemo((): ValueEditorContext => {
    const changed = (): void => {
      void reloadInfo();
      emitKeyChange({ profileId: target.profileId, database, kind: 'changed', key });
    };
    return {
      panelId,
      profileId: target.profileId,
      key,
      database,
      facts,
      run: (task) => panelLane(panelId).run(task),
      apply: async (edits, options = {}) => {
        if (edits.length === 0) return true;
        const done = await redisWrite({
          profileId: target.profileId,
          operation: options.removal !== undefined ? destructive(options.removal) : WRITE,
          title: options.removal !== undefined ? 'Remove from the value?' : 'Change the value?',
          commands: edits.flatMap((edit) => editCommands(key, edit)),
          confirmLabel: options.removal !== undefined ? 'Remove' : 'Save',
          run: async (confirmed) => {
            await panelLane(panelId).run(async (host, sessionId) => {
              for (const edit of edits) await sendEdit(host, sessionId, key, edit, confirmed);
            });
            return true;
          },
        });
        if (done) changed();
        return done === true;
      },
      changed,
    };
    // `keyId` stands for the key's bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, target.profileId, keyId, database, facts, reloadInfo]);

  const remove = async (): Promise<void> => {
    setActionError(undefined);
    try {
      const done = await redisWrite({
        profileId: target.profileId,
        operation: destructive('deletes the key'),
        title: 'Delete key?',
        commands: [[utf8Bytes('UNLINK'), key]],
        confirmLabel: 'Delete',
        run: (confirmed) =>
          panelLane(panelId).run((host, sessionId) =>
            host.redis.key.delete({ sessionId, keys: [key], confirmed }),
          ),
      });
      if (!done) return;
      emitKeyChange({ profileId: target.profileId, database, kind: 'deleted', key });
      void info.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const gone = keyInfo?.kind === 'none';
  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-full flex-col bg-bg" data-testid="value-editor">
        <Toolbar label="Key">
          <span
            className="max-w-[40%] truncate font-mono text-[13px] select-text"
            data-testid="value-key"
          >
            {displayBytes(key)}
          </span>
          {keyInfo && <TypeBadge type={keyInfo.type} />}
          {keyInfo && !gone && (
            <span className="text-xs text-muted" data-testid="value-meta">
              TTL <span data-testid="value-ttl">{formatTtl(keyInfo.ttlMs)}</span>
              {keyInfo.length !== null &&
                ` · ${keyInfo.length.toLocaleString('en-US')} ${keyInfo.kind === 'string' ? 'bytes' : 'items'}`}
              {keyInfo.encoding && ` · ${keyInfo.encoding}`}
              {` · ${formatBytes(info.data?.memory)}`}
              {database !== undefined && database !== 0 && ` · db${database}`}
            </span>
          )}
          <span className="flex-1" />
          <Button
            size="sm"
            onClick={() => {
              void info.reload();
              setGeneration((g) => g + 1);
            }}
          >
            <Icon name="refresh" className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Separator />
          <Button size="sm" disabled={!keyInfo || gone} onClick={() => setDialog('ttl')}>
            TTL…
          </Button>
          <Button size="sm" disabled={!keyInfo || gone} onClick={() => setDialog('rename')}>
            Rename…
          </Button>
          <Button size="sm" disabled={!keyInfo || gone} onClick={() => setDialog('copy')}>
            Copy…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!keyInfo || gone}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        </Toolbar>
        {(info.error ?? actionError) && (
          <Notice kind="error" onClose={() => setActionError(undefined)}>
            {info.error ?? actionError}
          </Notice>
        )}
        {keyInfo?.error && <Notice kind="error">{keyInfo.error}</Notice>}
        <div className="min-h-0 flex-1" key={generation}>
          {gone ? (
            <p className="p-4 text-sm text-muted" data-testid="key-gone">
              This key does not exist (it was deleted, renamed or expired).
            </p>
          ) : keyInfo ? (
            <EditorFor kind={keyInfo.kind} type={keyInfo.type} />
          ) : (
            <p className="p-4 text-sm text-muted">{info.loading ? 'Loading…' : ''}</p>
          )}
        </div>
      </div>
      {dialog === 'ttl' && keyInfo && (
        <TtlDialog
          scope={scope}
          keyBytes={key}
          ttlMs={keyInfo.ttlMs}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            void info.reload();
          }}
        />
      )}
      {dialog === 'rename' && (
        <RenameDialog
          scope={scope}
          keyBytes={key}
          onClose={() => setDialog(undefined)}
          onRenamed={(newKey) => {
            setDialog(undefined);
            retargetPanel(panelId, { key: newKey });
          }}
        />
      )}
      {dialog === 'copy' && (
        <CopyDialog
          scope={scope}
          keyBytes={key}
          databases={facts?.info.server.databases ?? 16}
          clusterMode={cluster}
          onClose={() => setDialog(undefined)}
          onCopied={(destination, db) => {
            setDialog(undefined);
            openRedisPanel({
              profileId: target.profileId,
              profileName: target.profileName,
              tool: 'value',
              key: destination,
              ...(db !== undefined ? { database: db } : {}),
            });
          }}
        />
      )}
    </EditorContext.Provider>
  );
}

function EditorFor(props: { readonly kind: KeyInfo['kind']; readonly type: string }) {
  switch (props.kind) {
    case 'string':
      return <StringEditor />;
    case 'hash':
      return <HashEditor />;
    case 'list':
      return <ListEditor />;
    case 'set':
      return <SetEditor />;
    case 'zset':
      return <ZSetEditor />;
    case 'stream':
      return <StreamEditor />;
    case 'json':
      return <JsonEditor />;
    default:
      return (
        <p className="p-4 text-sm text-muted">
          Keys of type {props.type || 'unknown'} have no editor; use the CLI.
        </p>
      );
  }
}
