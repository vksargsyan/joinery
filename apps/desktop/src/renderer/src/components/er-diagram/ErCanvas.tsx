import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useInternalNode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type IsValidConnection,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { ContextMenu } from 'radix-ui';
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import type { ChangeMark, ModelChanges } from '../../state/er-diagram/edit';
import type { ErModelEditor } from '../../state/er-diagram/editor';
import { MARKER_SHAPES, MARKER_SIZE, markerId } from '../../state/er-diagram/markers';
import {
  BOX,
  anchorY,
  boxSize,
  describeRelation,
  keyLetters,
  matchingTables,
  neighbourhood,
  relationColumns,
  tableLabel,
  visibleColumns,
  type ErColumn,
  type ErDiagram,
  type ErEnd,
  type ErRelation,
  type ErTable,
} from '../../state/er-diagram/model';
import { relationRoute, roundedPath } from '../../state/er-diagram/route';
import { useErDiagram, type ErDiagramView } from '../../state/er-diagram/view';
import { cx } from '../ui';
import {
  KIND_LABELS,
  KeyLetters,
  KindGlyph,
  actionsOf,
  canDesign,
  isEditable,
  openData,
  openDesign,
  schemaColor,
  shortCardinality,
  useEditorField,
  useErView,
} from './parts';

/**
 * The ER diagram's canvas (spec §8), on React Flow: a box per table sized by the model (so the
 * layout, the canvas and the exported image agree), and a line per foreign key from the
 * referencing column's row to the referenced column's, with crow's-foot ends. Selecting a table
 * brings out its relationships and neighbours and fades the rest; hovering one previews that;
 * a search rings the tables it matches. Boxes can be dragged; a double click opens the rows; the
 * right-click menu opens, designs, isolates or hides a table.
 *
 * While the model is edited, boxes move by their header; dragging from a column to a column of
 * another table (or onto its box, for its key) adds a relationship, a double click on the empty
 * canvas adds a table, a relationship is selected by a click and Delete removes the selection.
 * New and changed tables and columns are marked, and so are tables with problems.
 */

type TableData = {
  readonly table: ErTable;
  readonly label: string;
  readonly columns: readonly ErColumn[];
  readonly width: number;
  readonly height: number;
  readonly types: boolean;
  readonly tone: 'normal' | 'selected' | 'related' | 'dimmed';
  readonly match: boolean;
  /** Columns a highlighted relationship ends on. */
  readonly highlight: ReadonlySet<string> | undefined;
  readonly color: string;
  /** While editing: can the model change this table, and what changed in it. */
  readonly editable: boolean;
  readonly mark: ChangeMark | undefined;
  readonly columnMarks: ReadonlyMap<string, ChangeMark> | undefined;
  readonly problems: readonly string[];
};

type TableNodeType = Node<TableData, 'table'>;

type RelationData = {
  readonly relation: ErRelation;
  readonly childAnchor: number;
  readonly parentAnchor: number;
  readonly childWidth: number;
  readonly childHeight: number;
  readonly parentWidth: number;
  readonly parentHeight: number;
  readonly active: boolean;
  readonly dimmed: boolean;
  readonly label: string;
  /** Prefix of this canvas's marker ids (several diagrams can be open). */
  readonly markers: string;
};

type RelationEdgeType = Edge<RelationData, 'relation'>;

const NODE_TYPES = { table: memo(TableNode) };
const EDGE_TYPES = { relation: memo(RelationEdge) };
const ENDS: readonly ErEnd[] = ['one', 'zero-or-one', 'zero-or-many'];
const NO_ISSUES: readonly never[] = [];
const NO_MARKS: ModelChanges = { tables: new Map(), columns: new Map(), dropped: [], count: 0 };

/** The column a row handle stands for: `c:<name>`. */
function columnOfHandle(handle: string | null | undefined): string | undefined {
  return handle?.startsWith('c:') ? handle.slice(2) : undefined;
}

function isKeyColumn(table: ErTable, column: string): boolean {
  const def = table.columns.find((c) => c.name === column);
  return def !== undefined && (def.primaryKey || def.unique);
}

export function ErCanvas(props: {
  readonly view: ErDiagramView;
  readonly theme: 'dark' | 'light';
}) {
  return (
    <ReactFlowProvider>
      <Flow view={props.view} theme={props.theme} />
    </ReactFlowProvider>
  );
}

function Flow(props: { readonly view: ErDiagramView; readonly theme: 'dark' | 'light' }) {
  const { view } = props;
  const diagram = useErDiagram(view, (s) => s.diagram);
  const positions = useErDiagram(view, (s) => s.positions);
  const hidden = useErDiagram(view, (s) => s.hidden);
  const display = useErDiagram(view, (s) => s.display);
  const selected = useErDiagram(view, (s) => s.selected);
  const selectedRelation = useErDiagram(view, (s) => s.selectedRelation);
  const search = useErDiagram(view, (s) => s.search);
  const fit = useErDiagram(view, (s) => s.fit);
  const editor = useErDiagram(view, (s) => s.editor);
  const changes = useEditorField(editor, (s) => s.changes, NO_MARKS);
  const issues = useEditorField(editor, (s) => s.issues, NO_ISSUES);
  const editing = editor !== undefined;
  const flow = useReactFlow<TableNodeType, RelationEdgeType>();
  const markers = `er${useId().replace(/[^\w-]/g, '')}`;
  const [hovered, setHovered] = useState<string | undefined>();
  const [hoveredEdge, setHoveredEdge] = useState<string | undefined>();
  const [nodes, setNodes] = useState<TableNodeType[]>([]);
  const connected = useRef(false);

  const geometry = useMemo(() => {
    const out = new Map<string, { columns: readonly ErColumn[]; width: number; height: number }>();
    if (!diagram) return out;
    const related = relationColumns(diagram);
    for (const table of diagram.tables) {
      const columns = visibleColumns(table, display.columns, related.get(table.id));
      out.set(table.id, { columns, ...boxSize(diagram, table, columns, display.types) });
    }
    return out;
  }, [diagram, display]);

  const matches = useMemo(
    () => (diagram ? matchingTables(diagram, search) : new Set<string>()),
    [diagram, search],
  );
  const picked = diagram?.relations.find((r) => r.id === selectedRelation);
  const focus = selected ?? hovered;
  const near = useMemo(() => {
    if (!diagram) return undefined;
    if (picked) {
      return { relations: new Set([picked.id]), tables: new Set([picked.child, picked.parent]) };
    }
    return focus !== undefined ? neighbourhood(diagram, focus) : undefined;
  }, [diagram, focus, picked]);
  const highlights = useMemo(() => {
    const out = new Map<string, Set<string>>();
    if (!diagram || !near) return out;
    const add = (table: string, columns: readonly string[]): void => {
      const set = out.get(table) ?? new Set<string>();
      columns.forEach((c) => set.add(c));
      out.set(table, set);
    };
    for (const relation of diagram.relations) {
      if (!near.relations.has(relation.id) && relation.id !== hoveredEdge) continue;
      add(relation.child, relation.childColumns);
      add(relation.parent, relation.parentColumns);
    }
    return out;
  }, [diagram, near, hoveredEdge]);
  const problems = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const issue of issues) {
      if (issue.severity !== 'error') continue;
      out.set(issue.table, [...(out.get(issue.table) ?? []), issue.message]);
    }
    return out;
  }, [issues]);

  const searching = search.trim() !== '';
  const anyPicked = selected !== undefined || picked !== undefined;

  useEffect(() => {
    if (!diagram) {
      setNodes([]);
      return;
    }
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return diagram.tables.flatMap((table): TableNodeType[] => {
        const position = positions[table.id];
        const box = geometry.get(table.id);
        if (hidden.has(table.id) || !position || !box) return [];
        const tone: TableData['tone'] = !anyPicked
          ? searching && !matches.has(table.id)
            ? 'dimmed'
            : 'normal'
          : table.id === selected
            ? 'selected'
            : near?.tables.has(table.id)
              ? 'related'
              : 'dimmed';
        const editable = editing && isEditable(table);
        const data: TableData = {
          table,
          label: tableLabel(diagram, table),
          columns: box.columns,
          width: box.width,
          height: box.height,
          types: display.types,
          tone,
          match: matches.has(table.id),
          highlight: highlights.get(table.id),
          color: schemaColor(diagram, table),
          editable,
          mark: editable ? changes.tables.get(table.name) : undefined,
          columnMarks: editable ? changes.columns.get(table.name) : undefined,
          problems: editable ? (problems.get(table.name) ?? NO_ISSUES) : NO_ISSUES,
        };
        const old = byId.get(table.id);
        const base = old ?? { id: table.id, type: 'table' as const };
        return [
          {
            ...base,
            position: old?.dragging ? old.position : position,
            data,
            width: box.width,
            height: box.height,
            selected: table.id === selected,
            // While editing, rows start relationships: the header moves the box.
            dragHandle: editing ? '.er-drag' : undefined,
          },
        ];
      });
    });
  }, [
    diagram,
    positions,
    hidden,
    geometry,
    selected,
    anyPicked,
    near,
    matches,
    searching,
    highlights,
    display.types,
    editing,
    changes,
    problems,
  ]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    if (!diagram) return [];
    const visible = (id: string): boolean => !hidden.has(id) && positions[id] !== undefined;
    return diagram.relations.flatMap((relation): RelationEdgeType[] => {
      const child = geometry.get(relation.child);
      const parent = geometry.get(relation.parent);
      if (!child || !parent || !visible(relation.child) || !visible(relation.parent)) return [];
      const active = near?.relations.has(relation.id) === true || relation.id === hoveredEdge;
      const dimmed = anyPicked
        ? !active
        : searching && !matches.has(relation.child) && !matches.has(relation.parent);
      // The columns it joins light up in the boxes; the label says how many and what cascades.
      const parts = [
        shortCardinality(relation),
        ...actionsOf(relation).map((a) => a.replace('ON ', '')),
      ];
      return [
        {
          id: relation.id,
          type: 'relation',
          source: relation.child,
          target: relation.parent,
          sourceHandle: 's',
          targetHandle: 't',
          selectable: false,
          ariaLabel: describeRelation(diagram, relation),
          data: {
            relation,
            childAnchor: anchorY(child.columns, relation.childColumns[0]),
            parentAnchor: anchorY(parent.columns, relation.parentColumns[0]),
            childWidth: child.width,
            childHeight: child.height,
            parentWidth: parent.width,
            parentHeight: parent.height,
            active,
            dimmed,
            label: parts.join(' · '),
            markers,
          },
        },
      ];
    });
  }, [
    diagram,
    geometry,
    hidden,
    positions,
    near,
    hoveredEdge,
    anyPicked,
    searching,
    matches,
    markers,
  ]);

  // Fit the diagram after a layout, or a table when one is focused.
  useEffect(() => {
    if (fit.seq === 0) return;
    const frame = requestAnimationFrame(() => {
      void flow.fitView(
        fit.table
          ? { nodes: [{ id: fit.table }], padding: 0.8, maxZoom: 1.1, duration: 280 }
          : { padding: 0.08, maxZoom: 1, duration: 280 },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [fit, flow]);

  const onNodesChange = (changes: NodeChange<TableNodeType>[]): void => {
    for (const change of changes) {
      if (change.type === 'select' && change.selected) view.select(change.id);
    }
    setNodes((current) =>
      applyNodeChanges(
        changes.filter((change) => change.type === 'position' || change.type === 'dimensions'),
        current,
      ),
    );
  };

  // ---------------------------------------------------------------------------------------------
  // Editing

  const tableOf = (id: string | null | undefined): ErTable | undefined =>
    id ? diagram?.tables.find((t) => t.id === id) : undefined;

  /** Adds the relationship a drag from one table to another describes. */
  const relate = (
    editorNow: ErModelEditor,
    from: ErTable,
    fromColumn: string | undefined,
    to: ErTable,
    toColumn: string | undefined,
  ): void => {
    // Dragged from a key to a plain column: the other way round was meant.
    const reversed =
      fromColumn !== undefined &&
      toColumn !== undefined &&
      isKeyColumn(from, fromColumn) &&
      !isKeyColumn(to, toColumn);
    const [child, childColumn, parent, parentColumn] = reversed
      ? [to, toColumn, from, fromColumn]
      : [from, fromColumn, to, toColumn];
    editorNow.addRelation({
      child: child.name,
      ...(childColumn === undefined ? {} : { childColumns: [childColumn] }),
      parent: parent.name,
      ...(parentColumn === undefined ? {} : { parentColumns: [parentColumn] }),
    });
  };

  const isValidConnection: IsValidConnection<RelationEdgeType> = (connection) => {
    const from = tableOf(connection.source);
    const to = tableOf(connection.target);
    if (!from || !to || !isEditable(from) || !isEditable(to)) return false;
    return (
      connection.source !== connection.target || connection.sourceHandle !== connection.targetHandle
    );
  };

  const onConnect = (connection: Connection): void => {
    connected.current = true;
    const from = tableOf(connection.source);
    const to = tableOf(connection.target);
    if (!editor || !from || !to) return;
    relate(
      editor,
      from,
      columnOfHandle(connection.sourceHandle),
      to,
      columnOfHandle(connection.targetHandle),
    );
  };

  /** A drag that ends on a box, not on a row, references that table's key. */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState): void => {
    // React Flow reports the end of every drag; one that ended on a row has connected already.
    if (connected.current) return;
    if (!editor || state.toHandle || !state.fromNode) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!point) return;
    const element = document.elementFromPoint(point.clientX, point.clientY);
    const id = element?.closest('.react-flow__node')?.getAttribute('data-id');
    const from = tableOf(state.fromNode.id);
    const to = tableOf(id);
    if (!from || !to || !isEditable(to)) return;
    relate(editor, from, columnOfHandle(state.fromHandle?.id), to, undefined);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!editor) return;
    const target = event.target as HTMLElement;
    if (!target.closest('.react-flow__pane') || target.closest('.react-flow__node')) return;
    editor.addTable(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!editor || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (picked) {
      const child = tableOf(picked.child);
      if (child && isEditable(child)) editor.dropRelation(child.name, picked.name);
    } else if (selected !== undefined) {
      const table = tableOf(selected);
      if (table && isEditable(table)) editor.dropTable(table.name);
    } else return;
    event.preventDefault();
  };

  const large = nodes.length > 12;
  return (
    <div
      className={cx('er-canvas relative h-full w-full', editing && 'er-editing')}
      data-testid="er-canvas"
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <MarkerDefs prefix={markers} />
      <ReactFlow<TableNodeType, RelationEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        colorMode={props.theme}
        nodesConnectable={editing}
        connectionMode={ConnectionMode.Loose}
        connectOnClick={false}
        connectionRadius={24}
        isValidConnection={isValidConnection}
        onConnectStart={() => {
          connected.current = false;
        }}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 1.8, strokeDasharray: '5 4' }}
        edgesFocusable
        onNodesChange={onNodesChange}
        onNodeDragStop={(_event, _node, dragged) =>
          view.move(Object.fromEntries(dragged.map((node) => [node.id, node.position])))
        }
        onNodeClick={(_event, node) => view.select(node.id)}
        onNodeDoubleClick={(_event, node) => {
          if (editing) view.select(node.id);
          else if (diagram) openData(view, diagram, node.data.table);
        }}
        onNodeMouseEnter={(_event, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(undefined)}
        onEdgeMouseEnter={(_event, edge) => setHoveredEdge(edge.id)}
        onEdgeMouseLeave={() => setHoveredEdge(undefined)}
        onEdgeClick={(_event, edge) =>
          editing ? view.selectRelation(edge.id) : view.select(edge.source)
        }
        onPaneClick={() => view.select(undefined)}
        zoomOnDoubleClick={!editing}
        // Labels of the selected table's relationships read over its box.
        elevateNodesOnSelect={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        onlyRenderVisibleElements={large}
        minZoom={0.08}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{
          'node.a11yDescription.default': editing
            ? 'Press Enter to select the table and edit it beside the canvas.'
            : 'Press Enter to select the table and bring out its relationships.',
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        <Controls showInteractive={false} position="bottom-right" />
        {large && (
          <MiniMap<TableNodeType>
            position="top-right"
            pannable
            zoomable
            ariaLabel="Overview of the diagram"
            nodeBorderRadius={4}
            nodeColor={(node) =>
              node.data.tone === 'selected'
                ? 'var(--accent)'
                : node.data.mark === 'new'
                  ? 'var(--success)'
                  : node.data.mark === 'changed' || node.data.match
                    ? 'var(--warning)'
                    : 'var(--hover)'
            }
          />
        )}
      </ReactFlow>
      {editing && diagram && <EditHint diagram={diagram} />}
    </div>
  );
}

/** How to start, while the edited schema has no table. */
function EditHint(props: { readonly diagram: ErDiagram }) {
  if (props.diagram.tables.some(isEditable)) return null;
  return (
    <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-muted">
      Double-click anywhere to add a table, or use + Table above.
    </p>
  );
}

/** The crow's-foot glyphs, in the line's colour and the highlight colour. */
function MarkerDefs(props: { readonly prefix: string }) {
  return (
    <svg width="0" height="0" className="pointer-events-none absolute" aria-hidden>
      <defs>
        {ENDS.flatMap((end) =>
          [false, true].map((active) => {
            const shape = MARKER_SHAPES[end];
            return (
              <marker
                key={`${end}-${active}`}
                id={`${props.prefix}-${markerId(end, active)}`}
                viewBox={`0 0 ${MARKER_SIZE} ${MARKER_SIZE}`}
                refX={MARKER_SIZE}
                refY={MARKER_SIZE / 2}
                markerWidth={MARKER_SIZE}
                markerHeight={MARKER_SIZE}
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <g
                  fill="none"
                  strokeWidth={active ? 1.8 : 1.5}
                  strokeLinecap="round"
                  style={{ stroke: active ? 'var(--accent)' : 'var(--er-line)' }}
                >
                  {shape.paths.map((d) => (
                    <path key={d} d={d} />
                  ))}
                  {shape.circles.map(([x, y, r]) => (
                    <circle key={`${x}`} cx={x} cy={y} r={r} style={{ fill: 'var(--bg)' }} />
                  ))}
                </g>
              </marker>
            );
          }),
        )}
      </defs>
    </svg>
  );
}

function RelationEdge(props: EdgeProps<RelationEdgeType>) {
  const child = useInternalNode<TableNodeType>(props.source);
  const parent = useInternalNode<TableNodeType>(props.target);
  const data = props.data;
  if (!child || !parent || !data) return null;
  const from = {
    ...child.internals.positionAbsolute,
    width: data.childWidth,
    height: data.childHeight,
  };
  const to =
    props.source === props.target
      ? from
      : {
          ...parent.internals.positionAbsolute,
          width: data.parentWidth,
          height: data.parentHeight,
        };
  const route = relationRoute(from, from.y + data.childAnchor, to, to.y + data.parentAnchor);
  const { relation, active, dimmed } = data;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={roundedPath(route.points)}
        markerStart={`url(#${data.markers}-${markerId(relation.childEnd, active)})`}
        markerEnd={`url(#${data.markers}-${markerId(relation.parentEnd, active)})`}
        interactionWidth={14}
        className="er-edge"
        style={{
          stroke: active ? 'var(--accent)' : 'var(--er-line)',
          strokeWidth: active ? 1.8 : 1.5,
          opacity: dimmed ? 0.14 : 1,
        }}
      />
      {active && (
        <EdgeLabelRenderer>
          <div
            className="er-edge-label pointer-events-none absolute rounded-full border border-accent/40 bg-raised px-2 py-0.5 font-mono text-[10px] whitespace-nowrap text-fg shadow-widget"
            style={{
              transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const MARK_LABELS: Readonly<Record<ChangeMark, string>> = { new: 'new', changed: 'edited' };

function TableNode(props: NodeProps<TableNodeType>) {
  const { data } = props;
  const { table, columns } = data;
  const kind = table.external ? 'other schema' : KIND_LABELS[table.kind];
  return (
    <TableMenu table={table} editable={data.editable} isNew={data.mark === 'new'}>
      <div
        role="group"
        aria-label={`${kind ?? 'table'} ${data.label}`}
        data-testid="er-table"
        data-table={data.label}
        data-tone={data.tone}
        data-match={data.match || undefined}
        data-mark={data.mark}
        title={table.comment}
        style={{ width: data.width, height: data.height }}
        className={cx(
          'er-table relative flex flex-col overflow-hidden rounded-lg border bg-panel text-xs text-fg',
          'transition-[opacity,box-shadow,border-color] duration-150',
          table.external && 'border-dashed',
          data.tone === 'selected'
            ? 'border-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_28%,transparent),0_12px_32px_-12px_rgba(0,0,0,.55)]'
            : data.problems.length > 0
              ? 'border-danger/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_18%,transparent)]'
              : data.match
                ? 'border-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_25%,transparent)]'
                : data.mark === 'new'
                  ? 'border-success/70 shadow-[0_8px_24px_-14px_rgba(0,0,0,.6)]'
                  : data.tone === 'related'
                    ? 'border-accent/60 shadow-[0_8px_24px_-14px_rgba(0,0,0,.6)]'
                    : 'border-border shadow-[0_1px_2px_rgba(0,0,0,.18),0_8px_24px_-16px_rgba(0,0,0,.5)]',
          data.tone === 'dimmed' && 'opacity-30',
        )}
      >
        <Handle
          type="source"
          position={Position.Right}
          id="s"
          isConnectable={false}
          className="er-handle"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="t"
          isConnectable={false}
          className="er-handle"
        />
        <header
          style={{ height: BOX.header }}
          className={cx(
            'er-drag relative flex shrink-0 items-center gap-2 bg-panel-2 pr-2.5 pl-3',
            columns.length > 0 && 'border-b border-border',
            table.external && 'bg-transparent',
            data.editable && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-[3px]"
            style={{
              background:
                data.mark === 'new'
                  ? 'var(--success)'
                  : data.mark === 'changed'
                    ? 'var(--warning)'
                    : data.color,
            }}
          />
          <KindGlyph kind={table.kind} className="text-muted" />
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em]"
            title={data.label}
          >
            {data.label}
          </span>
          {data.problems.length > 0 && (
            <span
              className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[9.5px] font-bold text-white"
              title={data.problems.join('\n')}
              aria-label={`${data.problems.length} ${data.problems.length === 1 ? 'problem' : 'problems'}`}
            >
              {data.problems.length}
            </span>
          )}
          {data.mark ? (
            <span
              className={cx(
                'shrink-0 rounded-full px-1.5 text-[9.5px] leading-4 font-semibold',
                data.mark === 'new' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
              )}
            >
              {MARK_LABELS[data.mark]}
            </span>
          ) : (
            kind && (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[9.5px] leading-4 text-muted">
                {kind}
              </span>
            )
          )}
        </header>
        {columns.length > 0 && (
          <ul>
            {columns.map((column) => (
              <ColumnRow
                key={column.name}
                column={column}
                types={data.types}
                lit={data.highlight?.has(column.name) === true}
                editable={data.editable}
                mark={data.columnMarks?.get(column.name)}
              />
            ))}
          </ul>
        )}
      </div>
    </TableMenu>
  );
}

function ColumnRow(props: {
  readonly column: ErColumn;
  readonly types: boolean;
  readonly lit: boolean;
  readonly editable: boolean;
  readonly mark: ChangeMark | undefined;
}) {
  const { column, mark } = props;
  const notNull = !column.nullable && !column.primaryKey;
  return (
    <li
      style={{ height: BOX.row }}
      data-column={column.name}
      data-mark={mark}
      className={cx(
        'er-row relative flex items-center gap-2 pr-2.5',
        props.lit && 'bg-accent/12',
        !props.lit && mark === 'new' && 'bg-success/8',
      )}
      title={[column.name, column.type, column.nullable ? undefined : 'NOT NULL']
        .filter(Boolean)
        .join(' ')}
    >
      {props.editable && (
        <Handle
          type="source"
          position={Position.Right}
          id={`c:${column.name}`}
          className="er-row-handle"
          title={`Drag from ${column.name} to another table to add a relationship`}
        />
      )}
      {mark && (
        <span
          aria-hidden
          className={cx(
            'absolute top-1 bottom-1 left-0 w-[3px] rounded-r',
            mark === 'new' ? 'bg-success' : 'bg-warning',
          )}
        />
      )}
      <span className="flex shrink-0 justify-start pl-2.5" style={{ width: BOX.badge - 8 }}>
        <KeyLetters letters={keyLetters(column)} />
      </span>
      <span
        className={cx(
          'min-w-0 flex-1 truncate',
          column.primaryKey && 'font-semibold',
          props.lit && 'text-accent',
        )}
      >
        {column.name}
        {notNull && (
          <span className="text-muted" aria-label="not null">
            {' *'}
          </span>
        )}
      </span>
      {props.types && column.type && (
        <span className="max-w-[55%] shrink-0 truncate font-mono text-[10.5px] text-muted">
          {column.type}
        </span>
      )}
    </li>
  );
}

const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-list-active';

/** The right-click menu of a table on the canvas. */
function TableMenu(props: {
  readonly table: ErTable;
  readonly editable: boolean;
  /** A table the model adds: nothing on the server to open yet. */
  readonly isNew: boolean;
  readonly children: ReactNode;
}) {
  const view = useErView();
  const { table } = props;
  const editor = useErDiagram(view, (s) => s.editor);
  return (
    <ContextMenu.Root onOpenChange={(open) => open && view.select(table.id)}>
      <ContextMenu.Trigger asChild>{props.children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-52 rounded-md border border-border bg-raised p-1 text-fg shadow-widget">
          {props.editable && editor && (
            <>
              <ContextMenu.Item className={MENU_ITEM} onSelect={() => editor.addColumn(table.name)}>
                Add column
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cx(MENU_ITEM, 'text-danger')}
                onSelect={() => editor.dropTable(table.name)}
              >
                Delete table
              </ContextMenu.Item>
              <ContextMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <ContextMenu.Item
            className={MENU_ITEM}
            disabled={props.isNew}
            onSelect={() => {
              const diagram = view.state.diagram;
              if (diagram) openData(view, diagram, table);
            }}
          >
            Open data
          </ContextMenu.Item>
          <ContextMenu.Item
            className={MENU_ITEM}
            disabled={!canDesign(table) || props.isNew || editor !== undefined}
            onSelect={() => {
              const diagram = view.state.diagram;
              if (diagram) openDesign(view, diagram, table);
            }}
          >
            Design table
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => view.isolate(table.id)}>
            Show only related tables
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => view.setHidden(table.id, true)}>
            Hide from the diagram
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={() => copyToClipboard(table.name)}>
            Copy name
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
