import type { NewKeyValue } from '@querybara/driver-redis';
import { displayBytes, parseDisplayBytes, utf8Bytes } from '@querybara/redis-tools';
import { useRef, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import {
  decideRedisSafety,
  destructive,
  redisWritePolicy,
  WRITE,
} from '../../../../shared/redis-safety';
import { cachedProfile } from '../../state/data';
import {
  describeBulkDelete,
  initialBulkDelete,
  runBulkDelete,
  type BulkDeleteState,
} from '../../state/redis/bulk-delete';
import { emitKeyChange, panelLane, redisWrite } from '../../state/redis/panels';
import {
  EditError,
  createCommands,
  parseScore,
  parseTtl,
  type TtlUnit,
} from '../../state/redis/value-model';
import { Button, Field, Input, Modal, Select } from '../ui';

/**
 * The key dialogs (spec §10): new key, set TTL / persist, rename, copy (to another database
 * too) and bulk delete by pattern. Each shows the exact commands before a write that needs
 * confirmation (see `redisWrite`).
 */

interface KeyScope {
  readonly panelId: string;
  readonly profileId: string;
  readonly database: number | undefined;
}

function ErrorLine(props: { readonly error: string | undefined }) {
  if (!props.error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {props.error}
    </p>
  );
}

const NEW_KEY_TYPES = [
  { type: 'string', label: 'String' },
  { type: 'hash', label: 'Hash' },
  { type: 'list', label: 'List' },
  { type: 'set', label: 'Set' },
  { type: 'zset', label: 'Sorted set' },
  { type: 'stream', label: 'Stream' },
  { type: 'json', label: 'JSON (RedisJSON)' },
] as const;

type NewKeyType = (typeof NEW_KEY_TYPES)[number]['type'];

/** The value a new key starts with, from the dialog's fields. */
export function newKeyValue(
  type: NewKeyType,
  fields: { readonly first: string; readonly second: string },
): NewKeyValue {
  const first = parseDisplayBytes(fields.first);
  const second = parseDisplayBytes(fields.second);
  switch (type) {
    case 'string':
      return { type, value: first };
    case 'hash':
      return { type, entries: [[first, second]] };
    case 'list':
      return { type, items: [first] };
    case 'set':
      return { type, members: [first] };
    case 'zset':
      return { type, entries: [[first, parseScore(fields.second || '0')]] };
    case 'stream':
      return { type, fields: [[first, second]] };
    case 'json':
      JSON.parse(fields.first);
      return { type, json: fields.first };
  }
}

export function NewKeyDialog(props: {
  readonly scope: KeyScope;
  readonly jsonModule: boolean;
  readonly onClose: () => void;
  readonly onCreated: (key: Uint8Array) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<NewKeyType>('string');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const labels: Record<NewKeyType, [string, string | undefined]> = {
    string: ['Value', undefined],
    hash: ['Field', 'Value'],
    list: ['First element', undefined],
    set: ['First member', undefined],
    zset: ['First member', 'Score'],
    stream: ['Field', 'Value'],
    json: ['JSON document', undefined],
  };
  const [firstLabel, secondLabel] = labels[type];
  const submit = async (): Promise<void> => {
    setError(undefined);
    try {
      if (name === '') throw new EditError('Enter a key name');
      const key = parseDisplayBytes(name);
      const value = newKeyValue(type, { first, second });
      const ttlMs = ttl.trim() === '' ? undefined : parseTtl(ttl, 's');
      setBusy(true);
      const created = await redisWrite({
        profileId: props.scope.profileId,
        operation: WRITE,
        title: 'Create key?',
        commands: createCommands(key, value, ttlMs),
        run: (confirmed) =>
          panelLane(props.scope.panelId).run(async (host, sessionId) => {
            await host.redis.key.create({
              sessionId,
              key,
              value,
              confirmed,
              ...(ttlMs !== undefined ? { ttlMs } : {}),
            });
            return true;
          }),
      });
      if (!created) return;
      emitKeyChange({ ...props.scope, kind: 'created', key });
      props.onCreated(key);
    } catch (e) {
      setError(e instanceof SyntaxError ? `Invalid JSON: ${e.message}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="New key"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Key name" htmlFor="new-key-name" hint="\xNN escapes enter any byte.">
          <Input
            id="new-key-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Type" htmlFor="new-key-type">
          <Select
            id="new-key-type"
            value={type}
            onChange={(e) => setType(e.target.value as NewKeyType)}
          >
            {NEW_KEY_TYPES.filter((t) => t.type !== 'json' || props.jsonModule).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={firstLabel} htmlFor="new-key-first">
          {type === 'json' || type === 'string' ? (
            <textarea
              id="new-key-first"
              className="h-24 w-full rounded border border-border bg-panel-2 p-2 font-mono text-xs"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          ) : (
            <Input id="new-key-first" value={first} onChange={(e) => setFirst(e.target.value)} />
          )}
        </Field>
        {secondLabel !== undefined && (
          <Field label={secondLabel} htmlFor="new-key-second">
            <Input id="new-key-second" value={second} onChange={(e) => setSecond(e.target.value)} />
          </Field>
        )}
        <Field label="TTL in seconds (optional)" htmlFor="new-key-ttl">
          <Input
            id="new-key-ttl"
            inputMode="numeric"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
        </Field>
        <ErrorLine error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

export function TtlDialog(props: {
  readonly scope: KeyScope;
  readonly keyBytes: Uint8Array;
  readonly ttlMs: number;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(
    props.ttlMs > 0 ? String(Math.max(1, Math.round(props.ttlMs / 1000))) : '',
  );
  const [unit, setUnit] = useState<TtlUnit>('s');
  const [error, setError] = useState<string>();
  const apply = async (persist: boolean): Promise<void> => {
    setError(undefined);
    try {
      const ttlMs = persist ? null : parseTtl(value, unit);
      const done = await redisWrite({
        profileId: props.scope.profileId,
        operation: WRITE,
        title: persist ? 'Remove the expiry?' : 'Set the time to live?',
        commands: [
          persist
            ? [utf8Bytes('PERSIST'), props.keyBytes]
            : [utf8Bytes('PEXPIRE'), props.keyBytes, utf8Bytes(String(ttlMs))],
        ],
        run: (confirmed) =>
          panelLane(props.scope.panelId).run((host, sessionId) =>
            host.redis.key.expire({ sessionId, key: props.keyBytes, ttlMs, confirmed }),
          ),
      });
      if (!done) return;
      emitKeyChange({ ...props.scope, kind: 'changed', key: props.keyBytes });
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Time to live"
      description={displayBytes(props.keyBytes)}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={() => void apply(true)} disabled={props.ttlMs < 0}>
            Persist (no expiry)
          </Button>
          <Button variant="primary" onClick={() => void apply(false)}>
            Set TTL
          </Button>
        </>
      }
    >
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void apply(false);
        }}
      >
        <Field label="Expire in" htmlFor="ttl-value" className="flex-1">
          <Input
            id="ttl-value"
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field label="Unit" htmlFor="ttl-unit">
          <Select id="ttl-unit" value={unit} onChange={(e) => setUnit(e.target.value as TtlUnit)}>
            <option value="ms">milliseconds</option>
            <option value="s">seconds</option>
            <option value="min">minutes</option>
            <option value="h">hours</option>
            <option value="d">days</option>
          </Select>
        </Field>
        <button type="submit" hidden />
      </form>
      <ErrorLine error={error} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

export function RenameDialog(props: {
  readonly scope: KeyScope;
  readonly keyBytes: Uint8Array;
  readonly onClose: () => void;
  readonly onRenamed: (newKey: Uint8Array) => void;
}) {
  const [name, setName] = useState(displayBytes(props.keyBytes));
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string>();
  const rename = async (): Promise<void> => {
    setError(undefined);
    try {
      const newKey = parseDisplayBytes(name);
      if (name === '') throw new EditError('Enter the new name');
      const lane = panelLane(props.scope.panelId);
      const taken = await lane.run(
        async (host, sessionId) =>
          (await host.redis.exists({ sessionId, keys: [newKey] })).count > 0,
      );
      if (taken && !overwrite) {
        throw new EditError(`"${name}" exists; tick "Replace it" to overwrite it`);
      }
      const result = await redisWrite({
        profileId: props.scope.profileId,
        operation: taken ? destructive('replaces an existing key') : WRITE,
        title: 'Rename key?',
        commands: [[utf8Bytes(taken ? 'RENAME' : 'RENAMENX'), props.keyBytes, newKey]],
        confirmLabel: 'Rename',
        run: (confirmed) =>
          lane.run((host, sessionId) =>
            host.redis.key.rename({
              sessionId,
              key: props.keyBytes,
              newKey,
              onlyIfNew: !taken,
              confirmed,
            }),
          ),
      });
      if (!result) return;
      if (!result.renamed) throw new EditError(`"${name}" was created meanwhile; nothing renamed`);
      emitKeyChange({ ...props.scope, kind: 'renamed', key: props.keyBytes, newKey });
      props.onRenamed(newKey);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Rename key"
      description={displayBytes(props.keyBytes)}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void rename()}>
            Rename
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <Field label="New name" htmlFor="rename-key">
          <Input id="rename-key" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          Replace it if a key with that name exists
        </label>
        <ErrorLine error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

export function CopyDialog(props: {
  readonly scope: KeyScope;
  readonly keyBytes: Uint8Array;
  readonly databases: number;
  readonly clusterMode: boolean;
  readonly onClose: () => void;
  readonly onCopied: (destination: Uint8Array, database: number | undefined) => void;
}) {
  const [name, setName] = useState(`${displayBytes(props.keyBytes)}:copy`);
  const [database, setDatabase] = useState(props.scope.database ?? 0);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string>();
  const copy = async (): Promise<void> => {
    setError(undefined);
    try {
      if (name === '') throw new EditError('Enter the name of the copy');
      const destination = parseDisplayBytes(name);
      const otherDb = !props.clusterMode && database !== (props.scope.database ?? 0);
      const result = await redisWrite({
        profileId: props.scope.profileId,
        operation: replace ? destructive('replaces the destination key if it exists') : WRITE,
        title: 'Copy key?',
        commands: [
          [
            utf8Bytes('COPY'),
            props.keyBytes,
            destination,
            ...(otherDb ? [utf8Bytes('DB'), utf8Bytes(String(database))] : []),
            ...(replace ? [utf8Bytes('REPLACE')] : []),
          ],
        ],
        confirmLabel: 'Copy',
        run: (confirmed) =>
          panelLane(props.scope.panelId).run((host, sessionId) =>
            host.redis.key.copy({
              sessionId,
              key: props.keyBytes,
              destination,
              confirmed,
              ...(otherDb ? { db: database } : {}),
              ...(replace ? { replace } : {}),
            }),
          ),
      });
      if (!result) return;
      if (!result.copied)
        throw new EditError(`"${name}" exists; tick "Replace it" to overwrite it`);
      const target = props.clusterMode ? undefined : database;
      emitKeyChange({ ...props.scope, database: target, kind: 'created', key: destination });
      props.onCopied(destination, target);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Copy key"
      description={displayBytes(props.keyBytes)}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void copy()}>
            Copy
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void copy();
        }}
      >
        <Field label="Copy to key" htmlFor="copy-key">
          <Input id="copy-key" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!props.clusterMode && (
          <Field label="Database" htmlFor="copy-db">
            <Select
              id="copy-db"
              value={database}
              onChange={(e) => setDatabase(Number(e.target.value))}
            >
              {Array.from({ length: Math.min(props.databases, 256) }, (_, db) => (
                <option key={db} value={db}>
                  db{db}
                  {db === (props.scope.database ?? 0) ? ' (this one)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace it if a key with that name exists
        </label>
        <ErrorLine error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

export function BulkDeleteDialog(props: {
  readonly scope: KeyScope;
  readonly pattern: string;
  readonly type: string;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const [pattern, setPattern] = useState(props.pattern);
  const [state, setState] = useState<BulkDeleteState>(initialBulkDelete(props.pattern, props.type));
  const controller = useRef<AbortController | undefined>(undefined);
  const answer = useRef<((ok: boolean) => void) | undefined>(undefined);
  const profile = cachedProfile(props.scope.profileId);
  const refused =
    profile &&
    decideRedisSafety(destructive('deletes keys'), redisWritePolicy(profile)).action === 'refuse';
  const running = state.phase === 'counting' || state.phase === 'deleting';

  const start = async (): Promise<void> => {
    const abort = new AbortController();
    controller.current = abort;
    const final = await runBulkDelete({
      pattern,
      type: props.type,
      signal: abort.signal,
      onState: setState,
      confirm: () => new Promise<boolean>((resolve) => (answer.current = resolve)),
      call: (request, onProgress, signal) =>
        panelLane(props.scope.panelId).run((host, sessionId) =>
          host.redis.bulkDelete(
            {
              sessionId,
              match: request.match,
              dryRun: request.dryRun,
              confirmed: !request.dryRun,
              ...(request.type !== undefined ? { type: request.type } : {}),
            },
            { signal, onProgress },
          ),
        ),
    });
    if (final.progress.deleted > 0) props.onDeleted();
  };
  const settle = (ok: boolean): void => {
    answer.current?.(ok);
    answer.current = undefined;
  };
  const close = (): void => {
    controller.current?.abort();
    settle(false);
    props.onClose();
  };
  const counted = state.counted ?? 0;
  const done = state.phase === 'done' || state.phase === 'cancelled' || state.phase === 'failed';
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && close()}
      title="Delete keys by pattern"
      description="SCAN finds the keys and UNLINK deletes them in batches, never KEYS."
      width="w-[600px]"
      footer={
        <>
          {running ? (
            <Button variant="ghost" onClick={() => controller.current?.abort()}>
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" onClick={close}>
              {done ? 'Close' : 'Cancel'}
            </Button>
          )}
          {state.phase === 'confirming' ? (
            <Button variant="danger" onClick={() => settle(true)} disabled={refused}>
              Delete {formatCount(counted)} keys
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={running || pattern.trim() === ''}
            >
              {done ? 'Count again' : 'Count matching keys'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="bulk-delete">
        <Field
          label="Pattern"
          htmlFor="bulk-pattern"
          hint={props.type ? `Only ${props.type} keys` : undefined}
        >
          <Input
            id="bulk-pattern"
            autoFocus
            value={pattern}
            disabled={running || state.phase === 'confirming'}
            onChange={(e) => setPattern(e.target.value)}
          />
        </Field>
        {refused && (
          <p className="text-xs text-warning">
            This connection is read-only: you can count the keys, but not delete them.
          </p>
        )}
        <p className="text-[13px]" data-testid="bulk-delete-status" aria-live="polite">
          {describeBulkDelete(state)}
        </p>
        {state.phase === 'deleting' && counted > 0 && (
          <progress
            className="h-2 w-full"
            max={counted}
            value={Math.min(counted, state.progress.deleted)}
            aria-label="Deleted"
          />
        )}
        {state.phase === 'confirming' && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted">
              For example (keys written after the count are deleted too when they match):
            </p>
            <ul className="max-h-40 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs">
              {state.sample.map((key, i) => (
                <li key={i}>{displayBytes(key)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
