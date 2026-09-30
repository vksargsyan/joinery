import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { MARKER_SHAPES, MARKER_SIZE } from '../../state/er-diagram/markers';
import type {
  ErDiagram,
  ErEnd,
  ErRelation,
  ErTable,
  ErTableKind,
  KeyLetter,
} from '../../state/er-diagram/model';
import type { EditorState, ErModelEditor } from '../../state/er-diagram/editor';
import type { ErDiagramView } from '../../state/er-diagram/view';
import { openTableData, openTableDesigner } from '../dock';
import { cx } from '../ui';

/** Pieces the ER diagram's canvas, lists and inspector share. */

const ViewContext = createContext<ErDiagramView | undefined>(undefined);

export const ErViewProvider = ViewContext.Provider;

export function useErView(): ErDiagramView {
  const view = useContext(ViewContext);
  if (!view) throw new Error('useErView outside an ER diagram');
  return view;
}

const NO_EDITOR: StoreApi<EditorState | undefined> = createStore<EditorState | undefined>()(
  () => undefined,
);

/** Part of an editor's state, or `fallback` when the diagram is not being edited. */
export function useEditorField<T>(
  editor: ErModelEditor | undefined,
  selector: (state: EditorState) => T,
  fallback: T,
): T {
  return useStore(editor?.store ?? NO_EDITOR, (state) =>
    state === undefined ? fallback : selector(state),
  );
}

/** Can the model change this table? Tables of the edited schema can; views and stubs cannot. */
export function isEditable(table: ErTable): boolean {
  return !table.external && table.kind !== 'view' && table.kind !== 'materialized-view';
}

/** Schema colours for diagrams of several schemas: readable on both themes. */
const SCHEMA_COLORS = [
  '#4f8cff',
  '#a371f7',
  '#2fb3a4',
  '#e3a008',
  '#f06292',
  '#56b6f7',
  '#ff8a4c',
  '#8bc34a',
];

/** The colour of a table's header stripe: the accent, or its schema's colour. */
export function schemaColor(diagram: ErDiagram, table: ErTable): string {
  if (diagram.schemas.length <= 1 && !table.external) return 'var(--accent)';
  const schemas = [...diagram.schemas];
  for (const t of diagram.tables) if (!schemas.includes(t.schema)) schemas.push(t.schema);
  return SCHEMA_COLORS[schemas.indexOf(table.schema) % SCHEMA_COLORS.length] ?? 'var(--accent)';
}

export const KEY_LETTER_CLASSES: Readonly<Record<KeyLetter, string>> = {
  P: 'text-warning',
  F: 'text-accent',
  U: 'text-success',
};

export const KEY_LETTER_NAMES: Readonly<Record<KeyLetter, string>> = {
  P: 'primary key',
  F: 'foreign key',
  U: 'unique',
};

export function KeyLetters(props: { readonly letters: readonly KeyLetter[] }) {
  if (props.letters.length === 0) return null;
  return (
    <span
      className="font-mono text-[10px] leading-none font-bold tracking-[0.08em]"
      title={props.letters.map((letter) => KEY_LETTER_NAMES[letter]).join(', ')}
    >
      {props.letters.map((letter) => (
        <span key={letter} className={KEY_LETTER_CLASSES[letter]}>
          {letter}
        </span>
      ))}
    </span>
  );
}

export const KIND_LABELS: Readonly<Record<ErTableKind, string | undefined>> = {
  table: undefined,
  partitioned: 'partitioned',
  foreign: 'foreign',
  view: 'view',
  'materialized-view': 'mat. view',
};

/** A small glyph for a table or view. */
export function KindGlyph(props: { readonly kind: ErTableKind; readonly className?: string }) {
  const view = props.kind === 'view' || props.kind === 'materialized-view';
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cx('h-3.5 w-3.5 shrink-0', props.className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      {view ? (
        <>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
          <circle cx="8" cy="8" r="2" />
          {props.kind === 'materialized-view' && <path d="M3 14.5h10" />}
        </>
      ) : (
        <>
          <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
          <path d="M2 6.5h12M6.5 6.5v7" />
          {props.kind === 'partitioned' && <path d="M2 10h12" />}
          {props.kind === 'foreign' && <path d="M10 9.5l2 2" />}
        </>
      )}
    </svg>
  );
}

/** A crow's-foot end drawn on its own, for the legend. */
export function EndGlyph(props: { readonly end: ErEnd }) {
  const shape = MARKER_SHAPES[props.end];
  return (
    <svg
      viewBox={`-6 0 ${MARKER_SIZE + 8} ${MARKER_SIZE}`}
      className="h-4 w-8 shrink-0"
      aria-hidden
      fill="none"
      style={{ stroke: 'var(--fg)' }}
      strokeWidth="1.5"
    >
      <path d={`M-6 ${MARKER_SIZE / 2} H0`} />
      {shape.paths.map((d) => (
        <path key={d} d={d} />
      ))}
      {shape.circles.map(([cx_, cy, r]) => (
        <circle key={`${cx_}`} cx={cx_} cy={cy} r={r} style={{ fill: 'var(--panel)' }} />
      ))}
    </svg>
  );
}

export const END_NAMES: Readonly<Record<ErEnd, string>> = {
  one: 'exactly one',
  'zero-or-one': 'zero or one',
  'zero-or-many': 'zero or many',
};

/** "one to many", "one to one", "zero or one to many", …: how a relationship reads. */
export function cardinality(relation: ErRelation): string {
  const parent = relation.parentEnd === 'one' ? 'one' : 'zero or one';
  const child = relation.childEnd === 'zero-or-many' ? 'many' : 'one';
  return `${parent} to ${child}`;
}

/** "1 : N", "1 : 1", "0..1 : N": a compact label for an edge. */
export function shortCardinality(relation: ErRelation): string {
  const parent = relation.parentEnd === 'one' ? '1' : '0..1';
  const child = relation.childEnd === 'zero-or-many' ? 'N' : '1';
  return `${parent} : ${child}`;
}

/** The referential actions worth mentioning ("ON DELETE CASCADE"). */
export function actionsOf(relation: ErRelation): string[] {
  const out: string[] = [];
  if (relation.onDelete !== 'NO ACTION') out.push(`ON DELETE ${relation.onDelete}`);
  if (relation.onUpdate !== 'NO ACTION') out.push(`ON UPDATE ${relation.onUpdate}`);
  return out;
}

export function canDesign(table: ErTable): boolean {
  return table.kind === 'table' || table.kind === 'partitioned';
}

/** Opens a table's (or view's) rows. */
export function openData(view: ErDiagramView, diagram: ErDiagram, table: ErTable): void {
  openTableData({
    profileId: view.target.profileId,
    database: diagram.database,
    schema: table.schema,
    name: table.name,
  });
}

/** Opens a table in the table designer. */
export function openDesign(view: ErDiagramView, diagram: ErDiagram, table: ErTable): void {
  openTableDesigner({
    profileId: view.target.profileId,
    database: diagram.database,
    schema: table.schema,
    name: table.name,
  });
}
