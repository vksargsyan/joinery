import '@xyflow/react/dist/style.css';

import { referenceName, type QueryTable } from '@joinery/sql-tools';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { entryOf, type BuilderCatalog } from '../../state/query-builder/catalog';
import { isColumnSelected, isStarSelected } from '../../state/query-builder/edit';
import { layoutBoxes } from '../../state/query-builder/layout';
import { Icon, cx } from '../ui';
import { useBuilder, useBuilderSelector, useReadOnly } from './parts';

/**
 * The builder's canvas (spec §8: drag tables onto a canvas; joins drawn from foreign keys), on
 * React Flow: a box per table with its columns and tick boxes, an edge per join labelled with
 * its type. Dragging from a column to a column of another table joins them; clicking an edge
 * opens it in the Joins panel. Tables come from the list beside the canvas, by click or drag.
 * The layout is elkjs's when asked for (Auto layout, or tables read from SQL), else the
 * user's.
 */

/** The drag payload of a table dragged from the list: `{ schema, name }` as JSON. */
export const TABLE_DRAG_TYPE = 'application/x-joinery-builder-table';

type TableNodeType = Node<{ readonly tableId: string }, 'table'>;

const NODE_TYPES = { table: TableNode };

function useCatalog(): BuilderCatalog | undefined {
  return useBuilderSelector((state) =>
    state.catalog.status === 'ready' ? state.catalog.catalog : undefined,
  );
}

export function Canvas(props: { readonly theme: 'dark' | 'light' }) {
  return (
    <ReactFlowProvider>
      <Flow theme={props.theme} />
    </ReactFlowProvider>
  );
}

/** The handle a join edge attaches to: the column's row, or the table header. */
function handleOf(
  side: 'l' | 'r',
  table: QueryTable,
  column: string | undefined,
  catalog: BuilderCatalog | undefined,
): string {
  const entry = catalog && entryOf(catalog, table);
  return column && entry?.columns.some((c) => c.name === column)
    ? `${side}:${column}`
    : `${side}:*`;
}

function columnOfHandle(handle: string | null | undefined): string | undefined {
  if (!handle || handle.length < 3 || handle.endsWith(':*')) return undefined;
  return handle.slice(2);
}

function Flow(props: { readonly theme: 'dark' | 'light' }) {
  const builder = useBuilder();
  const tables = useBuilderSelector((state) => state.model.tables);
  const joins = useBuilderSelector((state) => state.model.joins);
  const positions = useBuilderSelector((state) => state.positions);
  const selectedJoin = useBuilderSelector((state) => state.selectedJoin);
  const layoutRequest = useBuilderSelector((state) => state.layoutRequest);
  const catalog = useCatalog();
  const readOnly = useReadOnly();
  const flow = useReactFlow();
  const initialized = useNodesInitialized();
  const [nodes, setNodes] = useState<TableNodeType[]>([]);
  const laidOut = useRef(0);

  useEffect(() => {
    setNodes((current) =>
      tables.map((table) => {
        const old = current.find((node) => node.id === table.id);
        const position = positions[table.id] ?? old?.position ?? { x: 0, y: 0 };
        return old
          ? { ...old, position }
          : { id: table.id, type: 'table', position, data: { tableId: table.id } };
      }),
    );
  }, [tables, positions]);

  const edges = useMemo<Edge[]>(
    () =>
      joins.flatMap((join) => {
        const left = tables.find((t) => t.id === join.left);
        const right = tables.find((t) => t.id === join.right);
        if (!left || !right) return [];
        const first = join.conditions[0];
        const a = positions[join.left];
        const b = positions[join.right];
        const forward = !a || !b || a.x <= b.x;
        const [source, target, sourceColumn, targetColumn] = forward
          ? [left, right, first?.left, first?.right]
          : [right, left, first?.right, first?.left];
        const selected = join.id === selectedJoin;
        const type = `${join.type.toUpperCase()} JOIN`;
        return [
          {
            id: join.id,
            source: source.id,
            target: target.id,
            sourceHandle: handleOf('r', source, sourceColumn, catalog),
            targetHandle: handleOf('l', target, targetColumn, catalog),
            type: 'smoothstep',
            label: join.conditions.length > 1 ? `${type} (${join.conditions.length})` : type,
            ariaLabel: `${referenceName(left)} ${type} ${referenceName(right)}`,
            selected,
            interactionWidth: 16,
            labelStyle: { fill: 'var(--fg)', fontSize: 10, fontWeight: 600 },
            labelBgStyle: {
              fill: selected ? 'var(--accent)' : 'var(--panel-2)',
              fillOpacity: selected ? 0.35 : 1,
            },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 3,
            style: {
              stroke: selected ? 'var(--accent)' : 'var(--muted)',
              strokeWidth: selected ? 2 : 1.5,
            },
            className: 'builder-join-edge',
          },
        ];
      }),
    [joins, tables, positions, selectedJoin, catalog],
  );

  // A table added to the canvas comes into view.
  const shown = useRef(0);
  useEffect(() => {
    if (!initialized) return;
    if (nodes.length > shown.current) {
      requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 150 }));
    }
    shown.current = nodes.length;
  }, [initialized, nodes.length, flow]);

  // Auto-layout once every table has been measured.
  useEffect(() => {
    if (layoutRequest === laidOut.current || !initialized) return;
    laidOut.current = layoutRequest;
    const boxes = flow.getNodes().map((node) => ({
      id: node.id,
      width: node.measured?.width ?? 240,
      height: node.measured?.height ?? 160,
    }));
    const links = joins.map((join) => ({ id: join.id, source: join.left, target: join.right }));
    void layoutBoxes(boxes, links).then((placed) => {
      builder.movePositions(placed);
      requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 150 }));
    });
  }, [layoutRequest, initialized, flow, joins, builder]);

  const isValidConnection: IsValidConnection = (connection) =>
    connection.source !== connection.target &&
    columnOfHandle(connection.sourceHandle) !== undefined &&
    columnOfHandle(connection.targetHandle) !== undefined;

  const onConnect = (connection: Connection): void => {
    const from = columnOfHandle(connection.sourceHandle);
    const to = columnOfHandle(connection.targetHandle);
    if (!from || !to || connection.source === connection.target) return;
    builder.connectColumns(
      { table: connection.source, column: from },
      { table: connection.target, column: to },
    );
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(TABLE_DRAG_TYPE) || readOnly) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const payload = event.dataTransfer.getData(TABLE_DRAG_TYPE);
    if (!payload || !catalog) return;
    event.preventDefault();
    try {
      const { schema, name } = JSON.parse(payload) as { schema?: unknown; name?: unknown };
      const entry = catalog.entries.find((e) => e.schema === schema && e.name === name);
      if (entry)
        builder.addTable(entry, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    } catch {
      // Not a table from the list.
    }
  };

  return (
    <div
      className="relative h-full w-full"
      data-testid="builder-canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow<TableNodeType, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode={props.theme}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={!readOnly}
        isValidConnection={isValidConnection}
        onNodesChange={(changes) =>
          setNodes((current) =>
            applyNodeChanges(
              changes.filter((change) => change.type !== 'remove'),
              current,
            ),
          )
        }
        onNodeDragStop={(_event, _node, dragged) =>
          builder.movePositions(Object.fromEntries(dragged.map((node) => [node.id, node.position])))
        }
        onConnect={onConnect}
        onEdgeClick={(_event, edge) => builder.selectJoin(edge.id)}
        onNodesDelete={(deleted) => deleted.forEach((node) => builder.removeTable(node.id))}
        onEdgesDelete={(deleted) => deleted.forEach((edge) => builder.removeJoin(edge.id))}
        deleteKeyCode={readOnly ? null : 'Delete'}
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Delete to remove the table.' }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {tables.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
          Add tables from the list, or drag them here.
        </p>
      )}
    </div>
  );
}

function TableNode(props: NodeProps<TableNodeType>) {
  const builder = useBuilder();
  const id = props.id;
  const table = useBuilderSelector((state) => state.model.tables.find((t) => t.id === id));
  const model = useBuilderSelector((state) => state.model);
  const catalogStatus = useBuilderSelector((state) => state.catalog.status);
  const catalog = useCatalog();
  const readOnly = useReadOnly();
  if (!table) return null;
  const entry = catalog && entryOf(catalog, table);
  const ref = referenceName(table);
  const handle = cx('!h-2 !w-2 !border-border !bg-panel-2', readOnly && '!opacity-0');
  return (
    <div
      role="group"
      aria-label={`Table ${ref}`}
      data-testid="builder-table"
      data-table={ref}
      className={cx(
        'w-60 rounded border bg-raised text-xs text-fg shadow-widget',
        props.selected ? 'border-accent' : 'border-border',
      )}
    >
      <div className="relative flex items-center gap-1.5 rounded-t border-b border-border bg-panel-2 px-2 py-1.5">
        <Handle
          type="target"
          position={Position.Left}
          id="l:*"
          isConnectable={false}
          className="!opacity-0"
        />
        <Icon name="table" className="h-3.5 w-3.5 text-muted" />
        <span
          className="min-w-0 flex-1 truncate font-semibold"
          title={[table.schema, table.name].filter(Boolean).join('.')}
        >
          {ref}
        </span>
        {table.alias && <span className="max-w-24 truncate text-muted">{table.name}</span>}
        {entry?.kind === 'view' && (
          <span className="rounded bg-panel px-1 text-[10px] text-muted">view</span>
        )}
        <button
          type="button"
          className="nodrag rounded px-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
          aria-label={`Remove table ${ref}`}
          title={`Remove ${ref} from the query`}
          disabled={readOnly}
          onClick={() => builder.removeTable(id)}
        >
          ×
        </button>
        <Handle
          type="source"
          position={Position.Right}
          id="r:*"
          isConnectable={false}
          className="!opacity-0"
        />
      </div>
      <label className="nodrag flex h-6 items-center gap-1.5 border-b border-border/60 px-2 text-muted">
        <input
          type="checkbox"
          aria-label={`${ref}.* (all columns)`}
          checked={isStarSelected(model, id)}
          disabled={readOnly}
          onChange={(event) => builder.toggleStar(id, event.target.checked)}
        />
        * (all columns)
      </label>
      {entry ? (
        entry.columns.map((column) => (
          <div
            key={column.name}
            className="relative flex h-6 items-center gap-1.5 px-2 hover:bg-hover"
          >
            <Handle
              type="target"
              position={Position.Left}
              id={`l:${column.name}`}
              isConnectable={!readOnly}
              className={handle}
            />
            <input
              type="checkbox"
              className="nodrag"
              aria-label={`${ref}.${column.name}`}
              checked={isColumnSelected(model, id, column.name)}
              disabled={readOnly}
              onChange={(event) => builder.toggleColumn(id, column.name, event.target.checked)}
            />
            <span className={cx('min-w-0 flex-1 truncate', column.primaryKey && 'font-semibold')}>
              {column.name}
              {column.primaryKey && <span className="sr-only"> (primary key)</span>}
            </span>
            {column.dataType && (
              <span className="max-w-24 truncate text-[10px] text-muted">{column.dataType}</span>
            )}
            <Handle
              type="source"
              position={Position.Right}
              id={`r:${column.name}`}
              isConnectable={!readOnly}
              className={handle}
            />
          </div>
        ))
      ) : (
        <p className="px-2 py-1.5 text-muted">
          {catalogStatus === 'loading'
            ? 'Loading columns…'
            : 'Not in the metadata of this database.'}
        </p>
      )}
    </div>
  );
}
