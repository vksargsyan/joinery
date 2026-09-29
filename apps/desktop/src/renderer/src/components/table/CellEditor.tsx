import {
  DEFAULT,
  formatCell,
  integerBounds,
  isDefault,
  isLargeValue,
  parseCellInput,
  type ColumnInfo,
  type EditValue,
} from '@joinery/table-data';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import type { LookupOption } from '../../state/table-view';
import { Button, cx } from '../ui';

/**
 * The type-aware cell editor (spec §7): text, numbers with their bounds, a boolean toggle, date
 * and time pickers next to validated text, enum and set pickers, a JSON editor that validates
 * and formats, a hex view for binary values, and a lookup of referenced rows for foreign keys.
 * NULL, an empty string and DEFAULT are separate states with their own buttons. The draft is
 * parsed for the column on every change; only a valid draft can be saved.
 */

export type Draft =
  { readonly ok: true; readonly value: EditValue } | { readonly ok: false; readonly error: string };

type Mode = 'value' | 'null' | 'default';

export interface CellEditorProps {
  readonly column: ColumnInfo;
  /** The cell's current value (full, not a preview). */
  readonly value: EditValue | undefined;
  /** DEFAULT can be written: a staged insert, or a column with a default. */
  readonly canDefault: boolean;
  /** Why the cell cannot be edited here (read-only table or connection). */
  readonly locked?: string;
  /** Referenced rows for a single-column foreign key. */
  readonly lookup?: (search: string) => Promise<LookupOption[]>;
  /** A character typed on the grid that started editing: replaces the text. */
  readonly initialText?: string;
  /** A problem to show with the cell, e.g. why pasted text was not taken. */
  readonly note?: string;
  readonly variant: 'overlay' | 'form';
  /** Every change of the draft (the overlay keeps it for Enter, Tab and a click outside). */
  readonly onDraft?: (draft: Draft) => void;
  readonly onCommit: (value: EditValue) => void;
  readonly onCancel: () => void;
}

function initialMode(value: EditValue | undefined): Mode {
  if (value === null || value === undefined) return 'null';
  return isDefault(value) ? 'default' : 'value';
}

const MULTILINE_KINDS = new Set(['json', 'string', 'unknown', 'array', 'geometry']);

/** A draft for the editor's current state. */
function draftOf(mode: Mode, text: string, column: ColumnInfo, locked?: string): Draft {
  if (mode === 'default') return { ok: true, value: DEFAULT };
  if (locked !== undefined) return { ok: false, error: locked };
  if (mode === 'null') {
    return column.nullable
      ? { ok: true, value: null }
      : { ok: false, error: 'The column cannot be NULL' };
  }
  const parsed = parseCellInput(text, column);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error };
}

function hint(column: ColumnInfo): string {
  const parts = [column.dataType];
  if ((column.kind === 'integer' || column.kind === 'bigint') && !column.booleanLike) {
    const [min, max] = integerBounds(column);
    parts.push(`${min} … ${max}`);
  }
  if (column.kind === 'decimal' && column.precision !== undefined) {
    parts.push(`${column.precision - (column.scale ?? 0)} digits . ${column.scale ?? 0} digits`);
  }
  if (column.length !== undefined && column.kind === 'string')
    parts.push(`up to ${column.length} characters`);
  if (!column.nullable) parts.push('NOT NULL');
  if (column.collation) parts.push(column.collation);
  return parts.join(' · ');
}

/** The native picker type and the conversions between its value and the column's text. */
function pickerFor(column: ColumnInfo):
  | {
      type: 'date' | 'time' | 'datetime-local';
      toPicker(text: string): string;
      fromPicker(value: string): string;
    }
  | undefined {
  switch (column.kind) {
    case 'date':
      return {
        type: 'date',
        toPicker: (text) => (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''),
        fromPicker: (value) => value,
      };
    case 'time':
      return {
        type: 'time',
        toPicker: (text) => /^\d{2}:\d{2}(:\d{2})?/.exec(text)?.[0] ?? '',
        fromPicker: (value) => (value.length === 5 ? `${value}:00` : value),
      };
    case 'datetime':
    case 'timestamp':
      return {
        type: 'datetime-local',
        toPicker: (text) => {
          const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/.exec(text);
          return m ? `${m[1]}T${m[2]}` : '';
        },
        fromPicker: (value) => {
          const [date, time = '00:00'] = value.split('T');
          return `${date} ${time.length === 5 ? `${time}:00` : time}`;
        },
      };
    default:
      return undefined;
  }
}

/** Offset, hex and ASCII columns of the first bytes of a binary value. */
function hexDump(bytes: Uint8Array, limit = 4096): string {
  const lines: string[] = [];
  const shown = bytes.subarray(0, limit);
  for (let offset = 0; offset < shown.length; offset += 16) {
    const chunk = shown.subarray(offset, offset + 16);
    const hexPart = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk]
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > limit) lines.push(`… ${bytes.length - limit} more bytes`);
  return lines.join('\n');
}

export function CellEditor(props: CellEditorProps) {
  const { column, value, locked } = props;
  const [mode, setMode] = useState<Mode>(() =>
    props.initialText !== undefined ? 'value' : initialMode(value),
  );
  const [text, setText] = useState(() =>
    props.initialText !== undefined ? props.initialText : formatCell(value),
  );
  const draft = useMemo(() => draftOf(mode, text, column, locked), [mode, text, column, locked]);
  const onDraft = props.onDraft;
  useEffect(() => onDraft?.(draft), [draft, onDraft]);
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = focusRef.current;
    if (!element) return;
    element.focus();
    if (props.initialText !== undefined && element instanceof HTMLInputElement) {
      const end = element.value.length;
      element.setSelectionRange(end, end);
    }
    // Focus once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const textual = column.kind === 'string' || column.kind === 'unknown';
  const multiline =
    MULTILINE_KINDS.has(column.kind) &&
    (column.kind === 'json' || text.includes('\n') || text.length > 60 || props.variant === 'form');
  const commit = (next: Draft = draft): void => {
    if (next.ok) props.onCommit(next.value);
  };
  const setValueText = (next: string): void => {
    setMode('value');
    setText(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    const inTextarea = target.tagName === 'TEXTAREA';
    if (event.key === 'Escape') {
      if (props.variant === 'form') {
        event.stopPropagation();
        props.onCancel();
      }
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    const submit = !inTextarea || event.ctrlKey || event.metaKey;
    if (!submit) {
      // A line break inside the text, not the end of the edit.
      event.stopPropagation();
      return;
    }
    if (!draft.ok) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (props.variant === 'form') {
      event.preventDefault();
      commit();
    }
    // The overlay saves the draft itself on Enter.
  };

  const stateLabel =
    mode === 'null'
      ? 'NULL'
      : mode === 'default'
        ? 'DEFAULT'
        : text === '' && textual
          ? 'Empty string'
          : null;

  // NULL and DEFAULT show as the field's placeholder; typing turns the cell into a value.
  const shown = mode === 'value' ? text : '';
  const placeholder = mode === 'null' ? 'NULL' : mode === 'default' ? 'DEFAULT' : undefined;
  let input: ReactNode;
  if (locked !== undefined && mode !== 'default') {
    input = (
      <pre className="max-h-64 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text">
        {value === null || value === undefined
          ? 'NULL'
          : isDefault(value)
            ? 'DEFAULT'
            : formatCell(value)}
      </pre>
    );
  } else if (column.kind === 'boolean') {
    const current = parseCellInput(shown, column);
    const on = current.ok && (current.value === true || current.value === 1);
    input = (
      <label className="flex h-8 items-center gap-2 text-[13px]">
        <input
          ref={(element) => {
            focusRef.current = element;
          }}
          type="checkbox"
          aria-label={`${column.name} is true`}
          checked={on}
          onChange={(event) => setValueText(event.target.checked ? 'true' : 'false')}
        />
        {on ? 'true' : 'false'}
      </label>
    );
  } else if (column.kind === 'enum' && column.enumValues && !column.multiple) {
    input = (
      <select
        ref={(element) => {
          focusRef.current = element;
        }}
        aria-label={column.name}
        className="h-8 w-full rounded border border-border bg-panel-2 px-2 text-[13px]"
        value={column.enumValues.includes(shown) ? shown : ''}
        onChange={(event) => setValueText(event.target.value)}
      >
        {!column.enumValues.includes(shown) && <option value="">{placeholder ?? 'Choose…'}</option>}
        {column.enumValues.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </select>
    );
  } else if (column.kind === 'enum' && column.enumValues && column.multiple) {
    const chosen = new Set(shown.split(',').filter(Boolean));
    input = (
      <div
        className="flex max-h-40 flex-col gap-1 overflow-auto"
        role="group"
        aria-label={column.name}
      >
        {column.enumValues.map((label, i) => (
          <label key={label} className="flex items-center gap-2 text-[13px]">
            <input
              ref={
                i === 0
                  ? (element) => {
                      focusRef.current = element;
                    }
                  : undefined
              }
              type="checkbox"
              checked={chosen.has(label)}
              onChange={(event) => {
                const next = new Set(chosen);
                if (event.target.checked) next.add(label);
                else next.delete(label);
                setValueText(column.enumValues!.filter((l) => next.has(l)).join(','));
              }}
            />
            {label}
          </label>
        ))}
      </div>
    );
  } else {
    const picker = pickerFor(column);
    const field = multiline ? (
      <textarea
        ref={(element) => {
          focusRef.current = element;
        }}
        aria-label={column.name}
        spellCheck={false}
        rows={column.kind === 'json' ? 10 : props.variant === 'form' ? 3 : 5}
        className="w-full resize-y rounded border border-border bg-panel-2 p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
        placeholder={placeholder}
        value={shown}
        onChange={(event) => setValueText(event.target.value)}
      />
    ) : (
      <input
        ref={(element) => {
          focusRef.current = element;
        }}
        aria-label={column.name}
        spellCheck={false}
        inputMode={
          ['integer', 'bigint', 'decimal', 'float'].includes(column.kind) ? 'decimal' : undefined
        }
        className="h-8 w-full min-w-0 rounded border border-border bg-panel-2 px-2 font-mono text-xs text-fg focus:border-accent focus:outline-none aria-[invalid=true]:border-danger"
        aria-invalid={!draft.ok}
        placeholder={placeholder}
        value={shown}
        onChange={(event) => setValueText(event.target.value)}
      />
    );
    input = (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-1.5">
          {field}
          {picker && (
            <input
              type={picker.type}
              step={picker.type === 'date' ? undefined : 1}
              aria-label={`Pick ${column.name}`}
              className="h-8 shrink-0 rounded border border-border bg-panel-2 px-1 text-xs text-fg"
              value={picker.toPicker(shown)}
              onChange={(event) => {
                if (event.target.value !== '') setValueText(picker.fromPicker(event.target.value));
              }}
            />
          )}
        </div>
        {column.kind === 'json' && (
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={!draft.ok}
              onClick={() => {
                try {
                  setValueText(JSON.stringify(JSON.parse(shown), null, 2));
                } catch {
                  // The draft shows the parse error already.
                }
              }}
            >
              Format JSON
            </Button>
          </div>
        )}
        {column.kind === 'binary' && draft.ok && draft.value instanceof Uint8Array && (
          <pre
            aria-label="Hex view"
            className="max-h-48 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-[11px] leading-4 select-text"
          >
            {draft.value.length === 0 ? '(no bytes)' : hexDump(draft.value)}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div
      className={cx(
        'flex flex-col gap-2 text-fg',
        props.variant === 'overlay' &&
          'w-[400px] max-w-full rounded border border-border bg-panel p-2.5 shadow-xl',
      )}
      data-testid="cell-editor"
      role="group"
      aria-label={`Edit ${column.name}`}
      onKeyDown={onKeyDown}
    >
      {props.variant === 'overlay' && (
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs font-semibold">{column.name}</span>
          <span className="truncate text-[11px] text-muted">{hint(column)}</span>
        </div>
      )}
      {input}
      {props.note !== undefined && <p className="text-[11px] text-danger">{props.note}</p>}
      {isLargeValue(value) && (
        <p className="text-[11px] text-warning">Only a preview of this value is loaded.</p>
      )}
      {props.lookup && locked === undefined && (
        <Lookup
          lookup={props.lookup}
          onPick={(picked) => {
            setValueText(formatCell(picked));
            commit({ ok: true, value: picked });
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {stateLabel && (
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted uppercase">
            {stateLabel}
          </span>
        )}
        {!draft.ok && (
          <span role="alert" className="text-[11px] text-danger">
            {draft.error}
          </span>
        )}
        <span className="flex-1" />
        {locked === undefined && column.nullable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMode('null');
              commit({ ok: true, value: null });
            }}
          >
            Set NULL
          </Button>
        )}
        {locked === undefined && textual && (
          <Button size="sm" variant="ghost" onClick={() => setValueText('')}>
            Empty
          </Button>
        )}
        {props.canDefault && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMode('default');
              commit({ ok: true, value: DEFAULT });
            }}
          >
            Set DEFAULT
          </Button>
        )}
        {locked === undefined && (
          <>
            <Button size="sm" variant="ghost" onClick={props.onCancel}>
              {props.variant === 'form' ? 'Revert' : 'Cancel'}
            </Button>
            <Button size="sm" variant="primary" disabled={!draft.ok} onClick={() => commit()}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Search the referenced table and pick a row's key (foreign key cells). */
function Lookup(props: {
  readonly lookup: (search: string) => Promise<LookupOption[]>;
  readonly onPick: (value: EditValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<LookupOption[]>();
  const [error, setError] = useState<string>();
  const { lookup } = props;
  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = setTimeout(() => {
      lookup(search).then(
        (found) => {
          if (current) {
            setOptions(found);
            setError(undefined);
          }
        },
        (e: unknown) => {
          if (current) setError(errorMessage(e));
        },
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, search, lookup]);
  if (!open) {
    return (
      <button
        type="button"
        className="self-start text-xs text-accent hover:underline"
        onClick={() => setOpen(true)}
      >
        Look up a referenced row…
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded border border-border p-1.5">
      <input
        autoFocus
        aria-label="Search referenced rows"
        placeholder="Search by key or name"
        className="h-7 rounded border border-border bg-panel-2 px-2 text-xs"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <ul role="listbox" aria-label="Referenced rows" className="max-h-44 overflow-auto text-xs">
        {options === undefined && <li className="px-1 py-0.5 text-muted">Loading…</li>}
        {options?.length === 0 && <li className="px-1 py-0.5 text-muted">No rows match</li>}
        {options?.map((option, i) => (
          <li key={i} role="option" aria-selected={false}>
            <button
              type="button"
              className="flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-hover"
              onClick={() => props.onPick(option.values[0] ?? null)}
            >
              <span className="font-mono">
                {option.values.map((v) => formatCell(v) || 'NULL').join(', ')}
              </span>
              {option.label !== null && <span className="truncate text-muted">{option.label}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
