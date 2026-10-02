import {
  aggregationTable,
  aggregationTree,
  type AggregationNode,
  type AggregationTable,
} from '@joinery/search-tools';
import { useMemo, useState } from 'react';

import { formatCount } from '../../lib/format';
import { Icon, cx } from '../ui';

/**
 * Aggregation results two ways (spec §11): a tree of aggregations, buckets (with their
 * document counts) and metrics, and a flattened table with one row per innermost bucket. Used
 * by the console's response pane, the SQL editor's translated DSL and the documents view.
 */
export function AggregationView(props: { readonly aggregations: string }) {
  const [mode, setMode] = useState<'tree' | 'table'>('tree');
  const parsed = useMemo(():
    | {
        tree: AggregationNode[];
        table: AggregationTable;
      }
    | undefined => {
    try {
      return {
        tree: aggregationTree(props.aggregations),
        table: aggregationTable(props.aggregations),
      };
    } catch {
      return undefined;
    }
  }, [props.aggregations]);
  if (!parsed)
    return <p className="p-3 text-xs text-danger">The aggregations are not valid JSON.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="search-aggregations">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs">
        <div
          className="flex rounded border border-border"
          role="radiogroup"
          aria-label="Aggregations view"
        >
          {(['tree', 'table'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={cx('px-2 py-0.5', mode === option ? 'bg-badge text-fg' : 'hover:bg-hover')}
              onClick={() => setMode(option)}
            >
              {option === 'tree' ? 'Tree' : 'Table'}
            </button>
          ))}
        </div>
        <span className="text-muted">
          {mode === 'table'
            ? `${formatCount(parsed.table.rows.length)} rows`
            : `${formatCount(parsed.tree.length)} ${parsed.tree.length === 1 ? 'aggregation' : 'aggregations'}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === 'tree' ? (
          <AggregationTree nodes={parsed.tree} />
        ) : (
          <FlatTable table={parsed.table} />
        )}
      </div>
    </div>
  );
}

function AggregationTree({ nodes }: { readonly nodes: readonly AggregationNode[] }) {
  return (
    <ul
      role="tree"
      aria-label="Aggregations"
      className="py-1 font-mono text-xs select-text"
      data-testid="aggregation-tree"
    >
      {nodes.map((node, i) => (
        <TreeNode key={`${node.label}-${i}`} node={node} depth={0} />
      ))}
    </ul>
  );
}

function TreeNode(props: { readonly node: AggregationNode; readonly depth: number }) {
  const { node, depth } = props;
  const [open, setOpen] = useState(depth < 2);
  const expandable = node.children.length > 0;
  return (
    <li role="treeitem" aria-expanded={expandable ? open : undefined} aria-selected={false}>
      <div
        className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-hover"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <span className="w-3">
          {expandable && (
            <button
              type="button"
              aria-label={`${open ? 'Collapse' : 'Expand'} ${node.label}`}
              onClick={() => setOpen(!open)}
            >
              <Icon name={open ? 'chevron-down' : 'chevron-right'} className="h-3 w-3 text-muted" />
            </button>
          )}
        </span>
        <span className={cx(node.type === 'bucket' ? 'text-success' : 'font-semibold')}>
          {node.label}
        </span>
        {node.docCount !== undefined && (
          <span className="rounded bg-panel-2 px-1 text-[10px] text-muted">
            {formatCount(node.docCount)} docs
          </span>
        )}
        {node.value !== undefined && <span className="text-accent">{node.value}</span>}
        {node.type === 'aggregation' && node.kind && (
          <span className="text-[10px] text-muted">{node.kind.replace('-', ' ')}</span>
        )}
      </div>
      {expandable && open && (
        <ul role="group">
          {node.children.map((child, i) => (
            <TreeNode key={`${child.label}-${i}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A plain table of text cells (aggregations flattened, SQL rows). */
export function FlatTable(props: {
  readonly table: {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly string[])[];
  };
  readonly testId?: string;
}) {
  const { table } = props;
  if (table.columns.length === 0) return <p className="p-3 text-xs text-muted">No rows.</p>;
  return (
    <table
      className="min-w-full border-collapse font-mono text-xs select-text"
      data-testid={props.testId ?? 'aggregation-table'}
    >
      <thead className="sticky top-0 z-10 bg-panel">
        <tr>
          {table.columns.map((column) => (
            <th
              key={column}
              scope="col"
              className="border-r border-b border-border px-2 py-1 text-left font-semibold whitespace-nowrap"
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r} className="hover:bg-hover">
            {row.map((cell, c) => (
              <td
                key={c}
                className="max-w-80 truncate border-r border-b border-border/60 px-2 py-0.5 whitespace-nowrap"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
