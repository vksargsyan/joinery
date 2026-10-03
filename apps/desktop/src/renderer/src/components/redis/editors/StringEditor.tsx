import {
  bitsView,
  bytesKey,
  detectHyperLogLog,
  setBitOffsets,
  utf8Bytes,
} from '@querybara/redis-tools';
import { useEffect, useState } from 'react';

import { errorMessage } from '../../../lib/errors';
import { formatCount } from '../../../lib/format';
import { WRITE } from '../../../../../shared/redis-safety';
import { redisWrite } from '../../../state/redis/panels';
import {
  STRING_VIEWS,
  decodeString,
  defaultStringView,
  encodeString,
  hexPreview,
  type StringView,
} from '../../../state/redis/value-model';
import { Button, cx } from '../../ui';
import { Notice, Toolbar, usePanelData } from '../common';
import { useValueEditor } from '../ValueEditorPanel';

/**
 * The string editor (spec §10): text (binary-safe escapes), JSON, hex and MessagePack views of
 * the same bytes, plus a bits view for bitmaps and the PFCOUNT of a HyperLogLog. Values larger
 * than the read limit are read by range and shown read-only, a page at a time.
 */

/** Bytes read at a time; larger values are shown by range. */
const RANGE_BYTES = 1024 * 1024;
/** Bits drawn in the bits view. */
const BITS_SHOWN = 4096;

type Mode = StringView | 'bits' | 'hll';

export function StringEditor() {
  const editor = useValueEditor();
  const [offset, setOffset] = useState(0);
  const value = usePanelData(
    editor.panelId,
    (host, sessionId) =>
      host.redis.string.get({ sessionId, key: editor.key, offset, maxBytes: RANGE_BYTES }),
    [bytesKey(editor.key), offset],
  );
  const loaded = value.data ?? undefined;
  const bytes = loaded?.bytes;
  const [mode, setMode] = useState<Mode>();
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const hll = bytes && offset === 0 ? detectHyperLogLog(bytes) : undefined;
  const view: Mode = mode ?? (hll ? 'hll' : bytes ? defaultStringView(bytes) : 'text');
  const decoded =
    bytes && view !== 'bits' && view !== 'hll'
      ? loaded?.truncated
        ? { text: hexPreview(bytes, loaded.offset) }
        : decodeString(bytes, view)
      : undefined;

  useEffect(() => {
    if (decoded && !dirty) setText(decoded.text);
    // Reset the text when the value or the view changes, not while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, view]);

  const readOnly = loaded?.truncated === true;
  const save = async (): Promise<void> => {
    if (!bytes || view === 'bits' || view === 'hll') return;
    setError(undefined);
    let next: Uint8Array;
    try {
      next = encodeString(text, view, bytes);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    setSaving(true);
    try {
      const done = await redisWrite({
        profileId: editor.profileId,
        operation: WRITE,
        title: 'Save the value?',
        commands: [[utf8Bytes('SET'), editor.key, next, utf8Bytes('KEEPTTL')]],
        confirmLabel: 'Save',
        run: (confirmed) =>
          editor.run((host, sessionId) =>
            host.redis.string.set({
              sessionId,
              key: editor.key,
              value: next,
              options: { keepTtl: true },
              confirmed,
            }),
          ),
      });
      if (!done) return;
      setDirty(false);
      editor.changed();
      await value.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const modes: { readonly mode: Mode; readonly label: string }[] = [
    ...(hll ? [{ mode: 'hll' as const, label: 'HyperLogLog' }] : []),
    ...STRING_VIEWS.map((v) => ({ mode: v.view, label: v.label })),
    { mode: 'bits', label: 'Bits' },
  ];

  return (
    <div className="flex h-full flex-col" data-testid="string-editor">
      <Toolbar label="String view">
        <div className="flex rounded border border-border" role="radiogroup" aria-label="View as">
          {modes.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={view === m.mode}
              className={cx(
                'h-7 px-2 text-xs',
                view === m.mode ? 'bg-badge text-fg' : 'text-muted hover:bg-hover',
              )}
              onClick={() => {
                setMode(m.mode);
                setDirty(false);
                setError(undefined);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        {loaded && (
          <span className="text-xs text-muted">
            {loaded.truncated
              ? `Bytes ${formatCount(loaded.offset)}–${formatCount(loaded.offset + loaded.bytes.length - 1)} of ${formatCount(loaded.size)}`
              : `${formatCount(loaded.size)} bytes`}
          </span>
        )}
        {loaded?.truncated && (
          <>
            <Button
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - RANGE_BYTES))}
            >
              Previous range
            </Button>
            <Button
              size="sm"
              disabled={loaded.offset + loaded.bytes.length >= loaded.size}
              onClick={() => setOffset(offset + RANGE_BYTES)}
            >
              Next range
            </Button>
          </>
        )}
        <span className="flex-1" />
        {view !== 'bits' && view !== 'hll' && !readOnly && (
          <>
            <Button
              size="sm"
              disabled={!dirty}
              onClick={() => {
                setText(decoded?.text ?? '');
                setDirty(false);
              }}
            >
              Revert
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        )}
      </Toolbar>
      {readOnly && (
        <Notice kind="info">
          The value is larger than {formatCount(RANGE_BYTES)} bytes: it is shown by range, as a
          read-only hex dump. Use SETRANGE in the CLI to change part of it.
        </Notice>
      )}
      {(decoded?.error ?? error ?? value.error) && (
        <Notice kind={error || value.error ? 'error' : 'warning'}>
          {error ?? value.error ?? decoded?.error}
        </Notice>
      )}
      <div className="min-h-0 flex-1">
        {value.data === null ? (
          <p className="p-4 text-sm text-muted">The key is gone.</p>
        ) : view === 'bits' && bytes ? (
          <BitsView bytes={bytes} baseByte={loaded?.offset ?? 0} />
        ) : view === 'hll' && bytes ? (
          <HyperLogLogView bytes={bytes} />
        ) : (
          <textarea
            aria-label="Value"
            data-testid="string-value"
            spellCheck={false}
            readOnly={readOnly || !!decoded?.error}
            className="h-full w-full resize-none bg-bg p-3 font-mono text-[13px] text-fg focus:outline-none"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                void save();
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function BitsView(props: { readonly bytes: Uint8Array; readonly baseByte: number }) {
  const editor = useValueEditor();
  const count = usePanelData(
    editor.panelId,
    (host, sessionId) => host.redis.bitmap.count({ sessionId, key: editor.key }),
    [bytesKey(editor.key)],
  );
  const shown = bitsView(props.bytes, 0, Math.min(BITS_SHOWN, props.bytes.length * 8));
  const offsets = setBitOffsets(props.bytes, 200, props.baseByte);
  return (
    <div className="h-full overflow-auto p-3 text-xs" data-testid="bits-view">
      <p className="mb-2">
        BITCOUNT: <strong>{count.data ? formatCount(count.data.count) : '…'}</strong> bits set ·
        first set offsets: {offsets.length > 0 ? offsets.join(', ') : 'none'}
      </p>
      <div className="grid grid-cols-[repeat(64,minmax(0,1fr))] gap-px font-mono">
        {shown.map((bit, i) => (
          <span
            key={i}
            title={`bit ${props.baseByte * 8 + i}`}
            className={cx('h-3 w-3 rounded-[1px]', bit ? 'bg-accent' : 'bg-panel-2')}
          />
        ))}
      </div>
      {props.bytes.length * 8 > BITS_SHOWN && (
        <p className="mt-2 text-muted">The first {formatCount(BITS_SHOWN)} bits are drawn.</p>
      )}
    </div>
  );
}

function HyperLogLogView(props: { readonly bytes: Uint8Array }) {
  const editor = useValueEditor();
  const header = detectHyperLogLog(props.bytes);
  const count = usePanelData(
    editor.panelId,
    (host, sessionId) => host.redis.hll.count({ sessionId, keys: [editor.key] }),
    [bytesKey(editor.key)],
  );
  return (
    <div className="p-4 text-[13px]" data-testid="hll-view">
      <p>
        HyperLogLog, {header?.encoding} encoding. PFCOUNT estimates{' '}
        <strong data-testid="hll-count">{count.data ? formatCount(count.data.count) : '…'}</strong>{' '}
        distinct elements.
      </p>
      <p className="mt-2 text-xs text-muted">
        Add elements with PFADD in the CLI; the raw registers are shown in the Hex view.
      </p>
    </div>
  );
}
