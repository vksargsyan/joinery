import { useState, type ReactNode } from 'react';

import { errorMessage } from '../../../lib/errors';
import { Button, Icon, cx } from '../../ui';

/**
 * The value editors' grid (spec §10: hash, list, set and sorted set in grids with inline add,
 * edit and remove): rows of display cells; a row turns into inputs to edit it, an add row sits
 * on top. Saving runs the caller's edit, which throws with a message the row shows.
 */

export interface GridColumn {
  readonly label: string;
  /** Tailwind width, e.g. "w-32"; the rest share the space. */
  readonly width?: string;
  /** The column can be edited (otherwise it is shown only). */
  readonly editable?: boolean;
  readonly align?: 'right';
}

export interface GridRow {
  readonly id: string;
  /** Display text per column (bytes already in display form). */
  readonly cells: readonly string[];
}

export function EditGrid(props: {
  readonly label: string;
  readonly columns: readonly GridColumn[];
  readonly rows: readonly GridRow[];
  readonly onSave?: (row: GridRow, values: readonly string[]) => Promise<void>;
  readonly onRemove?: (row: GridRow) => Promise<void>;
  /** Adds an entry from the add row's values (the editable columns). */
  readonly onAdd?: (values: readonly string[]) => Promise<void>;
  readonly addLabel?: string;
  /** Extra buttons in the add row (e.g. "Push left"). */
  readonly addActions?: (values: readonly string[], reset: () => void) => ReactNode;
  readonly empty?: string;
}) {
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<string[]>([]);
  const [error, setError] = useState<{ readonly row: string; readonly message: string }>();
  const [busy, setBusy] = useState(false);
  const template = `${props.columns.map((c) => (c.width ? 'auto' : 'minmax(0,1fr)')).join(' ')} 112px`;

  const run = async (row: string, work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      return true;
    } catch (e) {
      setError({ row, message: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const startEdit = (row: GridRow): void => {
    setEditing(row.id);
    setDraft([...row.cells]);
    setError(undefined);
  };
  const save = async (row: GridRow): Promise<void> => {
    if (!props.onSave) return;
    if (await run(row.id, () => props.onSave!(row, draft))) setEditing(undefined);
  };
  const add = async (): Promise<void> => {
    if (!props.onAdd) return;
    if (await run('+', () => props.onAdd!(addDraft))) {
      setAddDraft([]);
      setAdding(false);
    }
  };
  const editableIndexes = props.columns.flatMap((c, i) => (c.editable ? [i] : []));

  const cellInput = (
    values: string[],
    set: (next: string[]) => void,
    index: number,
    onEnter: () => void,
    onEscape: () => void,
    autoFocus: boolean,
  ): ReactNode => (
    <input
      aria-label={props.columns[index]!.label}
      autoFocus={autoFocus}
      className="h-6 w-full rounded border border-accent bg-panel-2 px-1 font-mono text-xs text-fg"
      value={values[index] ?? ''}
      onChange={(e) => {
        const next = [...values];
        next[index] = e.target.value;
        set(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter();
        if (e.key === 'Escape') onEscape();
      }}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div
        className="grid shrink-0 gap-2 border-b border-border bg-panel px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase"
        style={{ gridTemplateColumns: template }}
      >
        {props.columns.map((c) => (
          <span key={c.label} className={cx(c.width, c.align === 'right' && 'text-right')}>
            {c.label}
          </span>
        ))}
        <span className="text-right">
          {props.onAdd && (
            <button
              type="button"
              className="rounded px-1 text-accent normal-case hover:bg-hover"
              onClick={() => {
                setAdding(true);
                setAddDraft([]);
              }}
            >
              + {props.addLabel ?? 'Add'}
            </button>
          )}
        </span>
      </div>
      <div role="grid" aria-label={props.label} className="min-h-0 flex-1 overflow-auto">
        {adding && (
          <div
            role="row"
            data-testid="grid-add-row"
            className="grid items-center gap-2 border-b border-border bg-accent/5 px-2 py-1"
            style={{ gridTemplateColumns: template }}
          >
            {props.columns.map((c, i) => (
              <span key={c.label} className={c.width}>
                {c.editable
                  ? cellInput(
                      addDraft,
                      setAddDraft,
                      i,
                      () => void add(),
                      () => setAdding(false),
                      i === editableIndexes[0],
                    )
                  : null}
              </span>
            ))}
            <span className="flex justify-end gap-1">
              {props.addActions ? (
                props.addActions(addDraft, () => {
                  setAddDraft([]);
                  setAdding(false);
                })
              ) : (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>
                  Add
                </Button>
              )}
            </span>
            {error?.row === '+' && (
              <p role="alert" className="col-span-full text-xs text-danger">
                {error.message}
              </p>
            )}
          </div>
        )}
        {props.rows.length === 0 && !adding && (
          <p className="p-4 text-center text-xs text-muted">{props.empty ?? 'Empty'}</p>
        )}
        {props.rows.map((row) => {
          const isEditing = editing === row.id;
          return (
            <div
              key={row.id}
              role="row"
              data-testid="grid-row"
              data-key={row.cells[0]}
              className={cx(
                'group grid items-center gap-2 border-b border-border/50 px-2 py-0.5 text-[13px]',
                isEditing ? 'bg-accent/5' : 'hover:bg-hover',
              )}
              style={{ gridTemplateColumns: template }}
              onDoubleClick={() => props.onSave && !isEditing && startEdit(row)}
            >
              {props.columns.map((c, i) => (
                <span
                  key={c.label}
                  role="gridcell"
                  className={cx(
                    'min-w-0 truncate font-mono text-xs select-text',
                    c.width,
                    c.align === 'right' && 'text-right',
                  )}
                  title={row.cells[i]}
                >
                  {isEditing && c.editable
                    ? cellInput(
                        draft,
                        setDraft,
                        i,
                        () => void save(row),
                        () => setEditing(undefined),
                        i === editableIndexes[0],
                      )
                    : row.cells[i]}
                </span>
              ))}
              <span className="flex justify-end gap-0.5">
                {isEditing ? (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void save(row)}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    {props.onSave && (
                      <button
                        type="button"
                        aria-label="Edit"
                        className="rounded px-1 text-xs text-muted opacity-0 group-hover:opacity-100 hover:text-fg focus:opacity-100"
                        onClick={() => startEdit(row)}
                      >
                        Edit
                      </button>
                    )}
                    {props.onRemove && (
                      <button
                        type="button"
                        aria-label="Remove"
                        className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                        onClick={() => void run(row.id, () => props.onRemove!(row))}
                      >
                        <Icon name="close" className="h-3 w-3" />
                      </button>
                    )}
                  </>
                )}
              </span>
              {error?.row === row.id && (
                <p role="alert" className="col-span-full text-xs text-danger">
                  {error.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
