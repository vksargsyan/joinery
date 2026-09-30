import {
  BSON_TYPES,
  bsonTypeOf,
  containerSummary,
  formatShellInline,
  isBsonDocument,
  type BsonTypeName,
  type BsonValue,
  type DocumentPath,
} from '@joinery/mongo-tools';
import { useMemo, type ReactNode, type UIEvent } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { formatCount } from '../../lib/format';
import {
  crumbsOf,
  drillInto,
  nodeKey,
  tableOf,
  useResults,
  type DocumentResults,
} from '../../state/mongo/results';
import { Button, Icon, cx } from '../ui';

/**
 * The three views of a MongoDB result (spec §9): tree, table and JSON. The collection view
 * passes document actions (edit, clone, delete); the console shows results read-only. Scrolling
 * near the end fetches the next page.
 */

export interface DocumentActions {
  readonly edit?: (index: number) => void;
  readonly clone?: (index: number) => void;
  readonly remove?: (index: number) => void;
}

const TYPE_CLASSES: Partial<Record<BsonTypeName, string>> = {
  objectId: 'text-warning',
  string: 'text-success',
  int: 'text-accent',
  long: 'text-accent',
  double: 'text-accent',
  decimal: 'text-accent',
  date: 'text-env-staging',
  bool: 'text-env-test',
  null: 'text-muted',
};

/** The BSON type of a value as a small badge ("ObjectId", "Int32", "Date"...). */
export function TypeBadge({ type }: { readonly type: BsonTypeName | 'missing' }) {
  const label = type === 'missing' ? 'missing' : BSON_TYPES[type].label;
  return (
    <span
      className="rounded border border-border bg-panel-2 px-1 py-px text-[10px] leading-none text-muted"
      data-bson-type={type}
    >
      {label}
    </span>
  );
}

/** A value's one-line text: containers summarised, strings quoted as the shell shows them. */
function valueText(value: BsonValue): string {
  return containerSummary(value) ?? formatShellInline(value, { maxStringLength: 300 });
}

function onScrollEnd(results: DocumentResults) {
  return (event: UIEvent<HTMLElement>): void => {
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 200) {
      results.onVisibleEnd();
    }
  };
}

function LoadMore({ results }: { readonly results: DocumentResults }) {
  const loading = useResults(results, (s) => s.loading);
  const hasMore = useResults(results, (s) => s.hasMore);
  const count = useResults(results, (s) => s.documents.length);
  const error = useResults(results, (s) => s.error);
  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-xs text-danger" data-testid="mongo-results-error">
        {error}
      </p>
    );
  }
  if (loading) return <p className="px-3 py-2 text-xs text-muted">Loading…</p>;
  if (count === 0) return <p className="px-3 py-2 text-xs text-muted">No documents.</p>;
  if (!hasMore) return null;
  return (
    <div className="px-3 py-2">
      <Button size="sm" variant="ghost" onClick={() => results.onVisibleEnd()}>
        Fetch more
      </Button>
    </div>
  );
}

export function ResultViews(props: {
  readonly results: DocumentResults;
  readonly actions?: DocumentActions;
}) {
  const mode = useResults(props.results, (s) => s.mode);
  if (mode === 'table') return <TableResults {...props} />;
  if (mode === 'json') return <JsonResults results={props.results} />;
  return <TreeResults {...props} />;
}

// ---------------------------------------------------------------------------------------------
// Tree

function TreeResults(props: {
  readonly results: DocumentResults;
  readonly actions?: DocumentActions;
}) {
  const { results } = props;
  const version = useResults(results, (s) => s.version);
  const expanded = useResults(results, (s) => s.expanded);
  const values = useMemo(
    () => results.values(),
    // Parsed again only when the documents change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, version],
  );
  return (
    <div
      className="h-full overflow-auto font-mono text-xs select-text"
      data-testid="mongo-tree"
      role="tree"
      aria-label="Documents"
      onScroll={onScrollEnd(results)}
    >
      {values.map((value, index) => {
        const key = nodeKey(index, []);
        const open = expanded[key] === true;
        const id = isBsonDocument(value) ? value['_id'] : undefined;
        return (
          <div
            key={index}
            role="treeitem"
            aria-expanded={open}
            aria-selected={false}
            data-document={index}
          >
            <div className="group flex items-center gap-1.5 border-b border-border/60 px-2 py-1 hover:bg-hover">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => results.toggleNode(key)}
                aria-label={`Document ${index + 1}`}
              >
                <Icon
                  name={open ? 'chevron-down' : 'chevron-right'}
                  className="h-3 w-3 text-muted"
                />
                <span className="text-muted">{index + 1}</span>
                {id !== undefined && (
                  <span className="truncate">
                    <span className="text-muted">_id: </span>
                    {valueText(id)}
                  </span>
                )}
                <span className="truncate text-muted">{valueText(value)}</span>
              </button>
              <DocumentButtons index={index} actions={props.actions} />
            </div>
            {open && (
              <TreeChildren results={results} document={index} value={value} path={[]} depth={1} />
            )}
          </div>
        );
      })}
      <LoadMore results={results} />
    </div>
  );
}

function DocumentButtons(props: {
  readonly index: number;
  readonly actions: DocumentActions | undefined;
}) {
  const { actions, index } = props;
  if (!actions) return null;
  return (
    <span className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
      {actions.edit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => actions.edit!(index)}
          aria-label={`Edit document ${index + 1}`}
        >
          Edit
        </Button>
      )}
      {actions.clone && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => actions.clone!(index)}
          aria-label={`Clone document ${index + 1}`}
        >
          Clone
        </Button>
      )}
      {actions.remove && (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          onClick={() => actions.remove!(index)}
          aria-label={`Delete document ${index + 1}`}
        >
          Delete
        </Button>
      )}
    </span>
  );
}

function TreeChildren(props: {
  readonly results: DocumentResults;
  readonly document: number;
  readonly value: BsonValue;
  readonly path: DocumentPath;
  readonly depth: number;
}) {
  const { results, document, value, path, depth } = props;
  const expanded = useResults(results, (s) => s.expanded);
  const entries: [string | number, BsonValue][] = Array.isArray(value)
    ? value.map((item, i) => [i, item])
    : isBsonDocument(value)
      ? Object.keys(value).map((key) => [key, value[key]!])
      : [];
  return (
    <div role="group">
      {entries.map(([key, child]) => {
        const childPath = [...path, key];
        const container = Array.isArray(child) || isBsonDocument(child);
        const nodeId = nodeKey(document, childPath);
        const open = expanded[nodeId] === true;
        return (
          <div
            key={String(key)}
            role="treeitem"
            aria-expanded={container ? open : undefined}
            aria-selected={false}
          >
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-hover"
              style={{ paddingLeft: 8 + depth * 16 }}
              data-field={String(key)}
            >
              <span className="w-3">
                {container && (
                  <button
                    type="button"
                    aria-label={`Expand ${String(key)}`}
                    onClick={() => results.toggleNode(nodeId)}
                  >
                    <Icon
                      name={open ? 'chevron-down' : 'chevron-right'}
                      className="h-3 w-3 text-muted"
                    />
                  </button>
                )}
              </span>
              <span
                className={cx('shrink-0', typeof key === 'number' ? 'text-muted' : 'font-semibold')}
              >
                {typeof key === 'number' ? `[${key}]` : key}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className={cx(TYPE_CLASSES[bsonTypeOf(child)])}>{valueText(child)}</span>
              </span>
              <TypeBadge type={bsonTypeOf(child)} />
            </div>
            {container && open && (
              <TreeChildren
                results={results}
                document={document}
                value={child}
                path={childPath}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Table

function TableResults(props: {
  readonly results: DocumentResults;
  readonly actions?: DocumentActions;
}) {
  const { results } = props;
  const version = useResults(results, (s) => s.version);
  const drill = useResults(results, (s) => s.drill);
  const flatten = useResults(results, (s) => s.flatten);
  const columnOrder = useResults(results, (s) => s.columnOrder);
  const view = useMemo(
    () => tableOf(results.values(), drill, flatten, columnOrder),
    // Rebuilt when the documents, the drill, the flattening or the column order change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, version, drill, flatten, columnOrder],
  );
  const crumbs = crumbsOf(drill);
  const actions = drill ? undefined : props.actions;
  return (
    <div className="flex h-full flex-col" data-testid="mongo-table">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs">
        <nav
          aria-label="Drill-down"
          className="flex min-w-0 flex-1 items-center gap-1"
          data-testid="mongo-breadcrumb"
        >
          {crumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted">›</span>}
              {i === crumbs.length - 1 ? (
                <span className="font-semibold" aria-current="location">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => results.setDrill(crumb.drill)}
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <label
          className="flex items-center gap-1 text-muted"
          title="Show sub-document fields as columns"
        >
          <input
            type="checkbox"
            checked={flatten}
            onChange={(event) => results.setFlatten(event.target.checked)}
          />
          Nested fields as columns
        </label>
        {view.truncatedColumns && <span className="text-warning">Some columns are not shown</span>}
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto"
        onScroll={drill ? undefined : onScrollEnd(results)}
      >
        <table className="min-w-full border-collapse font-mono text-xs select-text" role="grid">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              <th className="border-r border-b border-border px-2 py-1 text-left text-muted">#</th>
              {view.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="border-r border-b border-border px-2 py-1 text-left font-semibold whitespace-nowrap"
                  data-column={column.key}
                >
                  <span className="mr-1.5">{column.key === '' ? 'value' : column.key}</span>
                  {column.types[0] && <TypeBadge type={column.types[0]} />}
                </th>
              ))}
              {actions && <th className="border-b border-border" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, r) => (
              <tr key={r} className="group hover:bg-hover" data-row={r}>
                <td className="border-r border-b border-border/60 px-2 py-0.5 text-muted">
                  {drill ? pathTail(row.path) : r + 1}
                </td>
                {row.cells.map((cell, c) => (
                  <td
                    key={c}
                    className="max-w-80 border-r border-b border-border/60 px-2 py-0.5 whitespace-nowrap"
                    data-bson-type={cell.type}
                  >
                    {cell.drill ? (
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        title="Show as a table"
                        onClick={() => results.setDrill(drillInto(drill, row, cell))}
                      >
                        {cell.text}
                      </button>
                    ) : (
                      <span
                        className={cx(
                          'block truncate',
                          cell.type !== 'missing' && TYPE_CLASSES[cell.type],
                        )}
                      >
                        {cell.text}
                      </span>
                    )}
                  </td>
                ))}
                {actions && (
                  <td className="border-b border-border/60 px-1">
                    <DocumentButtons index={row.document} actions={actions} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!drill && <LoadMore results={results} />}
      </div>
    </div>
  );
}

/** The last step of a row's path in a drilled table: "[2]" or the field name. */
function pathTail(path: DocumentPath): ReactNode {
  const last = path.at(-1);
  return last === undefined ? '' : typeof last === 'number' ? `[${last}]` : last;
}

// ---------------------------------------------------------------------------------------------
// JSON

function JsonResults({ results }: { readonly results: DocumentResults }) {
  const version = useResults(results, (s) => s.version);
  const style = useResults(results, (s) => s.jsonStyle);
  const count = useResults(results, (s) => s.documents.length);
  const text = useMemo(
    () => results.json(),
    // Printed again when the documents or the style change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, version, style],
  );
  return (
    <div className="flex h-full flex-col" data-testid="mongo-json">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs text-muted">
        <span>
          {formatCount(count)} {count === 1 ? 'document' : 'documents'}
        </span>
        <div
          className="flex rounded border border-border"
          role="radiogroup"
          aria-label="JSON style"
        >
          {(['shell', 'ejson'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={style === option}
              className={cx(
                'px-2 py-0.5',
                style === option ? 'bg-accent text-accent-fg' : 'hover:bg-hover',
              )}
              onClick={() => results.setJsonStyle(option)}
            >
              {option === 'shell' ? 'mongosh' : 'Relaxed EJSON'}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => copyToClipboard(text)}>
          <Icon name="format" className="h-3 w-3" />
          Copy
        </Button>
      </div>
      <pre
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs select-text"
        data-testid="mongo-json-text"
        onScroll={onScrollEnd(results)}
      >
        {text}
      </pre>
      <LoadMore results={results} />
    </div>
  );
}
