import {
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type HeaderClickedEventArgs,
  type Item,
  type Rectangle,
  type Theme,
} from '@glideapps/glide-data-grid';
import { useCallback, useMemo, useState } from 'react';

import {
  displayColumns,
  moveColumn,
  reconcileLayout,
  setWidth,
  type ColumnLayout,
} from '../state/grid-layout';
import { cellText, suggestColumnWidths } from '../state/results';
import { bufferOf, type ResultView } from '../state/workspace';
import { HeaderMenu, type HeaderMenuAt } from './table/ColumnMenus';

/**
 * A result set in Glide Data Grid (spec §7): canvas-rendered, reading cells straight from the
 * column-oriented buffer, so tens of thousands of rows scroll at full speed. Read-only; NULL is
 * drawn muted so it stays distinct from an empty string. Columns can be hidden, dragged into
 * another order, pinned at the left and resized; grid positions map to buffer columns through
 * the layout, one array lookup per cell.
 */

export const DARK: Partial<Theme> = {
  accentColor: '#4f8cff',
  accentLight: 'rgba(79, 140, 255, 0.18)',
  textDark: '#e6e8ec',
  textMedium: '#b4bcc8',
  textLight: '#8a93a3',
  textBubble: '#e6e8ec',
  bgIconHeader: '#98a2b3',
  fgIconHeader: '#101216',
  textHeader: '#c8ced8',
  textHeaderSelected: '#ffffff',
  bgCell: '#101216',
  bgCellMedium: '#161a20',
  bgHeader: '#161a20',
  bgHeaderHasFocus: '#1d222a',
  bgHeaderHovered: '#1d222a',
  bgBubble: '#1d222a',
  bgBubbleSelected: '#2b313c',
  bgSearchResult: '#4a3f10',
  borderColor: 'rgba(255, 255, 255, 0.08)',
  horizontalBorderColor: 'rgba(255, 255, 255, 0.05)',
  drilldownBorder: 'rgba(255, 255, 255, 0.2)',
  linkColor: '#7aa7ff',
  headerFontStyle: '600 12px',
  baseFontStyle: '12px',
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
};

export const LIGHT: Partial<Theme> = {
  accentColor: '#2f6fec',
  accentLight: 'rgba(47, 111, 236, 0.14)',
  headerFontStyle: '600 12px',
  baseFontStyle: '12px',
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
};

const NULL_THEME_DARK: Partial<Theme> = { textDark: '#6b7485' };
const NULL_THEME_LIGHT: Partial<Theme> = { textDark: '#9aa2ae' };

/** Layout keys of a result's columns: their positions (a result can repeat a column name). */
export function resultColumnKeys(view: ResultView): string[] {
  return view.columns.map((_column, index) => String(index));
}

export function ResultGrid(props: {
  readonly view: ResultView;
  readonly theme: 'dark' | 'light';
  /** Hide, reorder, pin and resize (spec §7); the query tab keeps the layout per result. */
  readonly onLayoutChange?: (layout: ColumnLayout) => void;
}) {
  const { view, onLayoutChange } = props;
  const hasRows = view.rowCount > 0;
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuAt>();
  const keys = useMemo(() => view.columns.map((_column, index) => String(index)), [view.columns]);
  const layout = useMemo(() => reconcileLayout(view.layout, keys), [view.layout, keys]);
  const display = useMemo(() => displayColumns(layout, keys), [layout, keys]);
  // Widths come from the first rows once they arrive; the user can resize from there.
  const suggested = useMemo(() => {
    const buffer = bufferOf(view.id);
    return buffer ? suggestColumnWidths(buffer) : view.columns.map(() => 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, view.columns, hasRows]);
  const columns = useMemo<GridColumn[]>(
    () =>
      display.order.map((index, at) => ({
        id: String(index),
        title: view.columns[index]?.name ?? '',
        width: display.widths[at] ?? suggested[index] ?? 120,
        ...(onLayoutChange ? { hasMenu: true } : {}),
      })),
    [view.columns, display, suggested, onLayoutChange],
  );
  const nullTheme = props.theme === 'dark' ? NULL_THEME_DARK : NULL_THEME_LIGHT;
  // Stable while only widths change, so a resize does not rebuild the cell callback.
  const orderKey = display.order.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => display.order, [orderKey]);
  const getCellContent = useCallback(
    ([column, row]: Item): GridCell => {
      const index = order[column];
      const value = index === undefined ? null : (bufferOf(view.id)?.cell(index, row) ?? null);
      const text = cellText(value);
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        allowOverlay: true,
        readonly: true,
        ...(value === null ? { themeOverride: nullTheme } : {}),
      };
    },
    // `version` changes whenever rows are appended to the buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.id, view.version, nullTheme, order],
  );
  const openMenu = (col: number, x: number, y: number): void => {
    const index = order[col];
    if (index !== undefined) setHeaderMenu({ x, y, key: String(index) });
  };

  return (
    <div className="h-full w-full" data-testid="result-grid">
      <DataEditor
        width="100%"
        height="100%"
        columns={columns}
        rows={view.rowCount}
        getCellContent={getCellContent}
        getCellsForSelection
        rowMarkers="number"
        smoothScrollX
        smoothScrollY
        theme={props.theme === 'dark' ? DARK : LIGHT}
        rowHeight={26}
        headerHeight={28}
        freezeColumns={display.frozen}
        {...(onLayoutChange
          ? {
              onColumnResize: (column: GridColumn, width: number) => {
                if (column.id !== undefined) onLayoutChange(setWidth(layout, column.id, width));
              },
              onColumnMoved: (from: number, to: number) =>
                onLayoutChange(moveColumn(layout, from, to)),
              onHeaderMenuClick: (col: number, bounds: Rectangle) =>
                openMenu(col, bounds.x, bounds.y + bounds.height),
              onHeaderContextMenu: (col: number, event: HeaderClickedEventArgs) => {
                event.preventDefault();
                openMenu(
                  col,
                  event.bounds.x + event.localEventX,
                  event.bounds.y + event.localEventY,
                );
              },
            }
          : {})}
      />
      {headerMenu && onLayoutChange && (
        <HeaderMenu
          at={headerMenu}
          layout={layout}
          label={view.columns[Number(headerMenu.key)]?.name ?? ''}
          onChange={onLayoutChange}
          onClose={() => setHeaderMenu(undefined)}
        />
      )}
    </div>
  );
}
