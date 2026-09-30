import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';
import { useCallback, useMemo, useState } from 'react';

import { useSearchView } from '../../state/search/view';
import type { DocumentsView } from '../../state/search/documents';
import { BISQUE, TENMOKU } from '../../lib/kiln';
import { DARK, LIGHT } from '../ResultGrid';

/**
 * The document grid (spec §11) in Glide Data Grid: `_id` (and `_index` when several indices
 * answer), then one column per flattened field. Cells read straight from the view's flattened
 * records, so thousands of loaded hits scroll at full speed; scrolling near the end loads the
 * next page. A field a document lacks is blank; `null` is drawn muted. Rows are selected with
 * their markers; Enter or a double click opens the document editor.
 */

export const EMPTY_GRID_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/** The rows a selection covers: whole rows, or the rows of a cell range. */
export function selectedDocumentRows(selection: GridSelection): number[] {
  const rows = selection.rows.toArray();
  if (rows.length > 0) return rows;
  const range = selection.current?.range;
  if (!range) return [];
  return Array.from({ length: range.height }, (_, i) => range.y + i);
}

const MUTED_DARK: Partial<Theme> = { textDark: TENMOKU.faint };
const MUTED_LIGHT: Partial<Theme> = { textDark: BISQUE.faint };

/** Initial widths: ids and short fields narrow, everything else 160 px. */
export const ID_WIDTH = 180;
export const INDEX_WIDTH = 160;
export const FIELD_WIDTH = 160;

export function DocumentGrid(props: {
  readonly view: DocumentsView;
  readonly theme: 'dark' | 'light';
  readonly selection: GridSelection;
  readonly onSelectionChange: (selection: GridSelection) => void;
  readonly onActivate: (row: number) => void;
}) {
  const { view } = props;
  const version = useSearchView(view, (s) => s.version);
  const rowCount = useSearchView(view, (s) => s.hits.length);
  const fieldColumns = useSearchView(view, (s) => s.columns);
  const showIndex = view.showsIndex;
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  const keys = useMemo(
    () => ['_id', ...(showIndex ? ['_index'] : []), ...fieldColumns],
    [showIndex, fieldColumns],
  );
  const columns = useMemo<GridColumn[]>(
    () =>
      keys.map((key) => ({
        id: key,
        title: key,
        width:
          widths[key] ?? (key === '_id' ? ID_WIDTH : key === '_index' ? INDEX_WIDTH : FIELD_WIDTH),
      })),
    [keys, widths],
  );
  const muted = props.theme === 'dark' ? MUTED_DARK : MUTED_LIGHT;
  const getCellContent = useCallback(
    ([column, row]: Item): GridCell => {
      const key = keys[column];
      const hit = view.state.hits[row];
      let text = '';
      let dim = false;
      if (key === '_id') text = hit?.id ?? '';
      else if (key === '_index') text = hit?.index ?? '';
      else if (key !== undefined) {
        const field = view.cell(row, key);
        text = field?.text ?? '';
        dim = field === undefined || field.kind === 'null';
      }
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        allowOverlay: true,
        readonly: true,
        ...(dim ? { themeOverride: muted } : {}),
      };
    },
    // `version` changes whenever hits are loaded, edited or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, version, keys, muted],
  );
  return (
    <div className="h-full w-full" data-testid="search-document-grid">
      <DataEditor
        width="100%"
        height="100%"
        columns={columns}
        rows={rowCount}
        getCellContent={getCellContent}
        getCellsForSelection
        rowMarkers="clickable-number"
        smoothScrollX
        smoothScrollY
        theme={props.theme === 'dark' ? DARK : LIGHT}
        rowHeight={26}
        headerHeight={28}
        freezeColumns={1}
        gridSelection={props.selection}
        onGridSelectionChange={props.onSelectionChange}
        onCellActivated={([, row]) => props.onActivate(row)}
        onColumnResize={(column, width) => {
          if (column.id !== undefined) setWidths((w) => ({ ...w, [column.id!]: width }));
        }}
        onVisibleRegionChanged={(range) => view.onVisibleRows(range.y + range.height)}
      />
    </div>
  );
}
