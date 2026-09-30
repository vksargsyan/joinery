import type {
  ColumnDef,
  ForeignKeyDef,
  ReferentialAction,
  SqlEngineId,
  TableDef,
} from '@joinery/core';
import { typeCatalog } from '@joinery/sync';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { confirm } from '../../state/dialogs';
import { editedSchema, isUnique, type ChangeMark } from '../../state/er-diagram/edit';
import { useEditor, type ErModelEditor } from '../../state/er-diagram/editor';
import type { ModelIssue } from '../../state/er-diagram/forward';
import { useErDiagram } from '../../state/er-diagram/view';
import { Button, Icon, cx } from '../ui';
import { KindGlyph } from './parts';

/**
 * Editing the model beside the canvas (spec §8, forward engineering): the edit bar (add a
 * table, undo, redo, what changed, discard, review), and the side panel for the selected table
 * (name, comment, columns with their type, keys, NOT NULL, identity and default, references
 * with their ON DELETE / ON UPDATE rules) or relationship. Text fields apply on Enter or when
 * they lose the focus, so each edit is one step of the history; Escape puts the field back.
 */

// ---------------------------------------------------------------------------------------------
// The edit bar

export function EditBar(props: { readonly editor: ErModelEditor }) {
  const { editor } = props;
  const changes = useEditor(editor, (s) => s.changes);
  const issues = useEditor(editor, (s) => s.issues);
  const canUndo = useEditor(editor, (s) => s.canUndo);
  const canRedo = useEditor(editor, (s) => s.canRedo);
  const stale = useEditor(editor, (s) => s.stale);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const view = editor.view;
  const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';

  const discard = async (): Promise<void> => {
    if (changes.count > 0) {
      const ok = await confirm({
        title: 'Discard the changes?',
        message: `The model's ${changes.count} ${changes.count === 1 ? 'change' : 'changes'} will be lost; the database is not touched.`,
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    editor.discard();
  };

  const edited = [...changes.tables.entries()];
  return (
    <div
      role="toolbar"
      aria-label="Model editing"
      data-testid="er-edit-bar"
      className="flex flex-wrap items-center gap-2 border-b border-accent/30 bg-accent/8 px-2 py-1.5"
    >
      <span className="flex items-center gap-1.5 pl-1 text-xs font-semibold text-accent">
        <span aria-hidden className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        Editing {editor.context.schema}
      </span>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <Button
        size="sm"
        onClick={() => editor.addTable()}
        title="Add a table (or double-click the canvas)"
      >
        <Icon name="plus" className="h-3.5 w-3.5" />
        Table
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!canUndo}
        onClick={() => editor.undo()}
        title={`Undo (${mod}Z)`}
        aria-label="Undo"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
        >
          <path d="M5.5 3.5 2.5 6.5l3 3" />
          <path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7" />
        </svg>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!canRedo}
        onClick={() => editor.redo()}
        title={`Redo (${mod}⇧Z)`}
        aria-label="Redo"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
        >
          <path d="m10.5 3.5 3 3-3 3" />
          <path d="M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3" />
        </svg>
      </Button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild disabled={changes.count === 0}>
          <button
            type="button"
            data-testid="er-changes"
            className="rounded px-1.5 py-0.5 text-xs text-muted enabled:hover:bg-hover enabled:hover:text-fg"
          >
            {changes.count === 0
              ? 'No changes yet'
              : `${changes.count} ${changes.count === 1 ? 'change' : 'changes'}`}
            {errors > 0 && (
              <span className="ml-1 font-semibold text-danger">
                · {errors} {errors === 1 ? 'problem' : 'problems'}
              </span>
            )}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 max-h-80 min-w-60 overflow-auto rounded-md border border-border bg-panel p-1 text-[13px] text-fg shadow-xl"
          >
            {edited.map(([name, mark]) => (
              <DropdownMenu.Item
                key={name}
                className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-hover"
                onSelect={() => view.focus(view.tableIdOf(name))}
              >
                <MarkDot mark={mark} />
                <span className="flex-1 truncate">{name}</span>
                <span className="text-[11px] text-muted">{mark === 'new' ? 'new' : 'edited'}</span>
              </DropdownMenu.Item>
            ))}
            {changes.dropped.map((name) => (
              <DropdownMenu.Item
                key={`drop-${name}`}
                disabled
                className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-muted outline-none"
              >
                <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
                <span className="flex-1 truncate line-through">{name}</span>
                <span className="text-[11px] text-danger">dropped</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {stale && (
        <span
          className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning"
          title="The script still changes only what the model changes, but it may now fail or overlap what was done on the server."
        >
          <Icon name="warning" className="h-3 w-3" />
          Changed on the server since you started
        </span>
      )}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => void discard()}>
        Discard
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={changes.count === 0}
        onClick={() => editor.review()}
        data-testid="er-review-button"
      >
        Review &amp; apply…
      </Button>
    </div>
  );
}

function MarkDot(props: { readonly mark: ChangeMark | undefined }) {
  if (!props.mark) return <span aria-hidden className="h-2 w-2" />;
  return (
    <span
      aria-hidden
      className={cx(
        'h-2 w-2 shrink-0 rounded-full',
        props.mark === 'new' ? 'bg-success' : 'bg-warning',
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Fields

/** A text field that applies on Enter or blur and puts itself back on Escape or refusal. */
function EditableText(props: {
  readonly value: string;
  readonly onCommit: (value: string) => boolean;
  readonly label: string;
  readonly placeholder?: string;
  readonly className?: string;
  readonly list?: string;
  readonly autoFocus?: boolean;
  readonly mono?: boolean;
  readonly invalid?: boolean;
  readonly testId?: string;
}) {
  const [text, setText] = useState(props.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(props.value), [props.value]);
  useEffect(() => {
    if (props.autoFocus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [props.autoFocus]);
  const commit = (): void => {
    if (text === props.value) return;
    if (!props.onCommit(text)) setText(props.value);
  };
  return (
    <input
      ref={input}
      type="text"
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      data-testid={props.testId}
      placeholder={props.placeholder}
      list={props.list}
      value={text}
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          setText(props.value);
          event.currentTarget.blur();
        }
      }}
      className={cx(
        'h-6 min-w-0 rounded border border-transparent bg-transparent px-1.5 text-xs text-fg',
        'placeholder:text-muted/70 hover:border-border focus:border-accent focus:bg-bg focus:outline-none',
        'aria-[invalid=true]:border-danger/70',
        props.mono && 'font-mono text-[11px]',
        props.className,
      )}
    />
  );
}

function Chip(props: {
  readonly on: boolean;
  readonly label: string;
  readonly title: string;
  readonly onClick: () => void;
  readonly tone?: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      aria-label={props.title}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        'h-5 min-w-6 rounded border px-1 font-mono text-[10px] font-bold tracking-wide',
        'disabled:cursor-not-allowed disabled:opacity-40',
        props.on
          ? cx('border-transparent', props.tone ?? 'bg-accent/20 text-accent')
          : 'border-border text-muted/80 hover:border-muted hover:text-fg',
      )}
    >
      {props.label}
    </button>
  );
}

function Section(props: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="border-b border-border py-2">
      <h3 className="flex items-center gap-1.5 px-3 pb-1.5 text-[10.5px] font-semibold tracking-wide text-muted uppercase">
        {props.title}
        {props.count !== undefined && (
          <span className="rounded-full bg-panel-2 px-1.5 text-[10px] leading-4 font-medium tracking-normal">
            {props.count}
          </span>
        )}
        <span className="flex-1" />
        {props.action}
      </h3>
      {props.children}
    </section>
  );
}

const ACTIONS: readonly ReferentialAction[] = [
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
];

function ActionSelect(props: {
  readonly on: 'delete' | 'update';
  readonly label: string;
  readonly value: ReferentialAction;
  readonly onChange: (value: ReferentialAction) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[10.5px] text-muted">
      {props.label}
      <select
        aria-label={`ON ${props.on.toUpperCase()}`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as ReferentialAction)}
        className={cx(
          'h-6 rounded border border-border bg-panel-2 px-1 text-[11px] focus:border-accent focus:outline-none',
          props.value === 'NO ACTION' ? 'text-muted' : 'font-medium text-fg',
        )}
      >
        {ACTIONS.map((action) => (
          <option key={action} value={action}>
            {action.toLowerCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Types people use most, first in the type suggestions. */
const COMMON_TYPES: Readonly<Record<'postgres' | 'mysql', readonly string[]>> = {
  postgres: [
    'bigint',
    'integer',
    'text',
    'character varying(255)',
    'boolean',
    'numeric(10,2)',
    'timestamp with time zone',
    'date',
    'uuid',
    'jsonb',
    'smallint',
    'double precision',
    'bytea',
  ],
  mysql: [
    'bigint',
    'int',
    'varchar(255)',
    'text',
    'tinyint(1)',
    'decimal(10,2)',
    'datetime',
    'timestamp',
    'date',
    'json',
    'char(36)',
    'smallint',
    'double',
    'blob',
  ],
};

function useTypeSuggestions(editor: ErModelEditor): { id: string; types: readonly string[] } {
  const engine: SqlEngineId = editor.context.engine;
  return useMemo(() => {
    const common = COMMON_TYPES[engine === 'postgres' ? 'postgres' : 'mysql'];
    const catalog = typeCatalog(engine, editor.base.serverVersion, editor.base)
      .filter((entry) => !entry.pseudo && !entry.deprecated)
      .map((entry) => entry.name);
    return {
      id: `er-types-${editor.view.id}`,
      types: [...new Set([...common, ...catalog])],
    };
  }, [editor, engine]);
}

// ---------------------------------------------------------------------------------------------
// The selected table

export function TableEditor(props: { readonly editor: ErModelEditor; readonly name: string }) {
  const { editor, name } = props;
  const model = useEditor(editor, (s) => s.model);
  const changes = useEditor(editor, (s) => s.changes);
  const issues = useEditor(editor, (s) => s.issues);
  const focusColumn = useEditor(editor, (s) => s.focusColumn);
  const suggestions = useTypeSuggestions(editor);
  const schema = editedSchema(model.snapshot, editor.context);
  const table = schema.tables.find((t) => t.name === name);
  useEffect(() => {
    if (focusColumn) editor.focusHandled();
  }, [focusColumn, editor]);
  if (!table) return null;
  const view = editor.view;
  const mark = changes.tables.get(name);
  const columnMarks = changes.columns.get(name);
  const tableIssues = issues.filter((i) => i.table === name);
  const general = tableIssues.filter((i) => i.column === undefined);
  const incoming = schema.tables.flatMap((t) =>
    t.foreignKeys
      .filter(
        (fk) =>
          fk.refTable === name &&
          (editor.context.engine !== 'postgres' ||
            (fk.refSchema ?? editor.context.schema) === editor.context.schema),
      )
      .map((fk) => ({ table: t.name, fk })),
  );
  const others = schema.tables.map((t) => t.name);

  return (
    <aside
      aria-label={`Edit ${name}`}
      data-testid="er-table-editor"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-panel"
    >
      <datalist id={suggestions.id}>
        {suggestions.types.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      <header className="relative border-b border-border px-3 pt-3.5 pb-3">
        <span
          aria-hidden
          className={cx(
            'absolute inset-x-0 top-0 h-[3px]',
            mark === 'new' ? 'bg-success' : mark === 'changed' ? 'bg-warning' : 'bg-accent',
          )}
        />
        <div className="flex items-center gap-1.5">
          <KindGlyph kind={table.kind} className="text-muted" />
          <EditableText
            value={table.name}
            label="Table name"
            testId="er-table-name"
            className="flex-1 text-[13px] font-semibold"
            onCommit={(next) => editor.renameTable(name, next)}
          />
          <button
            type="button"
            aria-label="Close the details"
            className="rounded px-1 text-muted hover:bg-hover hover:text-fg"
            onClick={() => view.select(undefined)}
          >
            ×
          </button>
        </div>
        <p className="mt-0.5 pl-6 text-[11px] text-muted">
          {editor.context.schema}
          {mark && (
            <span className={mark === 'new' ? 'text-success' : 'text-warning'}>
              {' · '}
              {mark === 'new' ? 'new table' : 'edited'}
            </span>
          )}
        </p>
        <EditableText
          value={table.comment ?? ''}
          label="Table comment"
          placeholder="Add a comment…"
          className="mt-1.5 w-full"
          onCommit={(next) => editor.setTableComment(name, next)}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {general.length > 0 && <Problems issues={general} />}
        <Section
          title="Columns"
          count={table.columns.length}
          action={
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1 text-[11px] font-medium tracking-normal text-accent normal-case hover:bg-hover"
              onClick={() => editor.addColumn(name)}
            >
              <Icon name="plus" className="h-3 w-3" />
              Add
            </button>
          }
        >
          <ul className="flex flex-col gap-1 px-1.5" data-testid="er-columns">
            {table.columns.map((column, index) => (
              <ColumnEditor
                key={column.name}
                editor={editor}
                table={table}
                column={column}
                index={index}
                mark={columnMarks?.get(column.name)}
                issues={tableIssues.filter((i) => i.column === column.name)}
                typesList={suggestions.id}
                autoFocus={focusColumn?.table === name && focusColumn.column === column.name}
              />
            ))}
          </ul>
        </Section>
        <Section
          title="References"
          count={table.foreignKeys.length}
          action={<AddReference editor={editor} table={name} options={others} />}
        >
          {table.foreignKeys.length === 0 ? (
            <p className="px-3 text-xs text-muted">
              None. Drag from a column to another table, or add one here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 px-1.5">
              {table.foreignKeys.map((fk) => (
                <ReferenceEditor key={fk.name} editor={editor} child={name} fk={fk} />
              ))}
            </ul>
          )}
        </Section>
        <Section title="Referenced by" count={incoming.length}>
          {incoming.length === 0 ? (
            <p className="px-3 text-xs text-muted">No table references it.</p>
          ) : (
            <ul className="flex flex-col px-1.5">
              {incoming.map(({ table: other, fk }) => (
                <li key={`${other}.${fk.name}`}>
                  <button
                    type="button"
                    className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-hover"
                    onClick={() => view.focus(view.tableIdOf(other))}
                  >
                    <span className="text-xs font-medium">← {other}</span>
                    <span className="font-mono text-[10.5px] text-muted">
                      {fk.columns.join(', ')} → {fk.refColumns.join(', ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <div className="px-3 py-3">
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-danger"
            onClick={() => editor.dropTable(name)}
            data-testid="er-delete-table"
          >
            Delete table
          </Button>
        </div>
      </div>
    </aside>
  );
}

function Problems(props: { readonly issues: readonly ModelIssue[] }) {
  return (
    <ul
      role="alert"
      className="m-2 flex flex-col gap-0.5 rounded border border-danger/40 bg-danger/8 px-2.5 py-1.5 text-[11px]"
    >
      {props.issues.map((issue, i) => (
        <li key={i} className={issue.severity === 'error' ? 'text-danger' : 'text-warning'}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function ColumnEditor(props: {
  readonly editor: ErModelEditor;
  readonly table: TableDef;
  readonly column: ColumnDef;
  readonly index: number;
  readonly mark: ChangeMark | undefined;
  readonly issues: readonly ModelIssue[];
  readonly typesList: string;
  readonly autoFocus: boolean;
}) {
  const { editor, table, column } = props;
  const pg = editor.context.engine === 'postgres';
  const inKey = table.primaryKey?.columns.includes(column.name) === true;
  const unique = isUnique(table, column.name);
  const identity = pg ? column.identity !== undefined : column.autoIncrement === true;
  const referencing = table.foreignKeys.some((fk) => fk.columns.includes(column.name));
  const errors = props.issues.filter((i) => i.severity === 'error');
  return (
    <li
      data-testid="er-column"
      data-column={column.name}
      className={cx(
        'group relative rounded-md border px-1.5 py-1',
        props.mark === 'new'
          ? 'border-success/30 bg-success/5'
          : props.mark === 'changed'
            ? 'border-warning/30 bg-warning/5'
            : 'border-transparent hover:border-border',
      )}
    >
      <div className="flex items-center gap-1">
        <EditableText
          value={column.name}
          label={`Name of column ${column.name}`}
          className="flex-1 font-medium"
          autoFocus={props.autoFocus}
          invalid={errors.length > 0}
          onCommit={(next) => editor.updateColumn(table.name, column.name, { name: next })}
        />
        <EditableText
          value={column.dataType}
          label={`Type of ${column.name}`}
          list={props.typesList}
          mono
          className="w-36 text-muted"
          invalid={errors.some((i) => /type/i.test(i.code))}
          onCommit={(next) => editor.updateColumn(table.name, column.name, { dataType: next })}
        />
      </div>
      <div className="mt-0.5 flex items-center gap-1 pl-1">
        <Chip
          on={inKey}
          label="PK"
          title={inKey ? 'In the primary key' : 'Add to the primary key'}
          tone="bg-warning/20 text-warning"
          onClick={() => editor.togglePrimaryKey(table.name, column.name)}
        />
        <Chip
          on={unique}
          label="UQ"
          title={unique ? 'Unique' : 'Make unique'}
          tone="bg-success/20 text-success"
          disabled={inKey && table.primaryKey?.columns.length === 1}
          onClick={() => editor.toggleUnique(table.name, column.name)}
        />
        <Chip
          on={!column.nullable}
          label="NN"
          title={column.nullable ? 'Allows NULL: make it NOT NULL' : 'NOT NULL'}
          disabled={inKey}
          onClick={() =>
            editor.updateColumn(table.name, column.name, { nullable: !column.nullable })
          }
        />
        <Chip
          on={identity}
          label="AI"
          title={pg ? 'Identity (generated by default)' : 'AUTO_INCREMENT'}
          disabled={referencing}
          onClick={() => editor.updateColumn(table.name, column.name, { autoIncrement: !identity })}
        />
        {referencing && (
          <span
            className="ml-0.5 font-mono text-[10px] font-bold text-accent"
            title="Part of a foreign key"
          >
            FK
          </span>
        )}
        <EditableText
          value={column.default ?? ''}
          label={`Default of ${column.name}`}
          placeholder={identity ? 'generated' : 'no default'}
          mono
          className="ml-auto w-24 text-[10.5px]"
          onCommit={(next) => editor.updateColumn(table.name, column.name, { default: next })}
        />
        <span className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            aria-label={`Move ${column.name} up`}
            disabled={props.index === 0}
            className="rounded px-0.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
            onClick={() => editor.moveColumn(table.name, column.name, props.index - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${column.name} down`}
            disabled={props.index === table.columns.length - 1}
            className="rounded px-0.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
            onClick={() => editor.moveColumn(table.name, column.name, props.index + 1)}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={`Delete column ${column.name}`}
            className="rounded px-1 text-muted hover:bg-danger/15 hover:text-danger"
            onClick={() => editor.dropColumn(table.name, column.name)}
          >
            ×
          </button>
        </span>
      </div>
      {props.issues.length > 0 && (
        <ul className="mt-0.5 pl-1.5 text-[10.5px]">
          {props.issues.map((issue, i) => (
            <li key={i} className={issue.severity === 'error' ? 'text-danger' : 'text-warning'}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function AddReference(props: {
  readonly editor: ErModelEditor;
  readonly table: string;
  readonly options: readonly string[];
}) {
  return (
    <select
      aria-label={`Add a reference from ${props.table}`}
      value=""
      onChange={(event) => {
        const parent = event.target.value;
        if (parent) props.editor.addRelation({ child: props.table, parent });
      }}
      className="h-5 max-w-32 rounded border border-transparent bg-transparent text-[11px] font-medium tracking-normal text-accent normal-case hover:border-border focus:border-accent focus:outline-none"
    >
      <option value="">+ Reference…</option>
      {props.options.map((name) => (
        <option key={name} value={name}>
          {name === props.table ? `${name} (itself)` : name}
        </option>
      ))}
    </select>
  );
}

function ReferenceEditor(props: {
  readonly editor: ErModelEditor;
  readonly child: string;
  readonly fk: ForeignKeyDef;
}) {
  const { editor, child, fk } = props;
  const view = editor.view;
  return (
    <li
      className="group rounded-md border border-transparent px-2 py-1 hover:border-border"
      data-testid="er-reference"
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
          onClick={() => view.focus(view.tableIdOf(fk.refTable))}
        >
          → {fk.refTable}
        </button>
        <button
          type="button"
          aria-label={`Delete the reference ${fk.name}`}
          className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-danger/15 hover:text-danger focus:opacity-100"
          onClick={() => editor.dropRelation(child, fk.name)}
        >
          ×
        </button>
      </div>
      <p className="truncate font-mono text-[10.5px] text-muted" title={fk.name}>
        {fk.columns.join(', ')} → {fk.refColumns.join(', ')}
      </p>
      <div className="mt-1 flex gap-2">
        <ActionSelect
          on="delete"
          label="delete"
          value={fk.onDelete}
          onChange={(onDelete) => editor.updateRelation(child, fk.name, { onDelete })}
        />
        <ActionSelect
          on="update"
          label="update"
          value={fk.onUpdate}
          onChange={(onUpdate) => editor.updateRelation(child, fk.name, { onUpdate })}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// The selected relationship

export function RelationEditor(props: { readonly editor: ErModelEditor; readonly id: string }) {
  const { editor } = props;
  const view = editor.view;
  const diagram = useErDiagram(view, (s) => s.diagram);
  const model = useEditor(editor, (s) => s.model);
  const relation = diagram?.relations.find((r) => r.id === props.id);
  const child = relation && diagram?.tables.find((t) => t.id === relation.child);
  const fk = child
    ? editedSchema(model.snapshot, editor.context)
        .tables.find((t) => t.name === child.name)
        ?.foreignKeys.find((f) => f.name === relation.name)
    : undefined;
  if (!relation || !child || !fk) return null;
  return (
    <aside
      aria-label="Edit the relationship"
      data-testid="er-relation-editor"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-panel"
    >
      <header className="relative border-b border-border px-3 pt-3.5 pb-3">
        <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-accent" />
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">Relationship</h2>
          <button
            type="button"
            aria-label="Close the details"
            className="rounded px-1 text-muted hover:bg-hover hover:text-fg"
            onClick={() => view.selectRelation(undefined)}
          >
            ×
          </button>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={fk.name}>
          {fk.name}
        </p>
      </header>
      <div className="flex flex-col gap-3 px-3 py-3 text-xs">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
          <span className="text-muted">From</span>
          <button
            type="button"
            className="truncate text-left font-medium hover:underline"
            onClick={() => view.focus(relation.child)}
          >
            {child.name}
            <span className="font-mono font-normal text-muted"> ({fk.columns.join(', ')})</span>
          </button>
          <span className="text-muted">To</span>
          <button
            type="button"
            className="truncate text-left font-medium hover:underline"
            onClick={() => view.focus(relation.parent)}
          >
            {fk.refTable}
            <span className="font-mono font-normal text-muted"> ({fk.refColumns.join(', ')})</span>
          </button>
          <span className="text-muted">Reads</span>
          <span>
            {relation.parentEnd === 'one' ? 'exactly one' : 'zero or one'} {fk.refTable} to{' '}
            {relation.childEnd === 'zero-or-many' ? 'many' : 'zero or one'} {child.name}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <ActionSelect
            on="delete"
            label="On delete"
            value={fk.onDelete}
            onChange={(onDelete) => editor.updateRelation(child.name, fk.name, { onDelete })}
          />
          <ActionSelect
            on="update"
            label="On update"
            value={fk.onUpdate}
            onChange={(onUpdate) => editor.updateRelation(child.name, fk.name, { onUpdate })}
          />
        </div>
        <p className="text-[11px] text-muted">
          Whether {fk.refTable} is required follows NOT NULL on{' '}
          <span className="font-mono">{fk.columns.join(', ')}</span>; one to one follows a unique
          key on it.
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          data-testid="er-delete-relation"
          onClick={() => editor.dropRelation(child.name, fk.name)}
        >
          Delete relationship
        </Button>
      </div>
    </aside>
  );
}
