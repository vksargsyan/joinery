import {
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';
import { useCallback, useMemo, useState } from 'react';

import { cellText, suggestColumnWidths } from '../state/results';
import { bufferOf, type ResultView } from '../state/workspace';

/**
 * A result set in Glide Data Grid (spec §7): canvas-rendered, reading cells straight from the
 * column-oriented buffer, so tens of thousands of rows scroll at full speed. Read-only for now;
 * NULL is drawn muted so it stays distinct from an empty string.
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

export function ResultGrid(props: { readonly view: ResultView; readonly theme: 'dark' | 'light' }) {
  const { view } = props;
  const hasRows = view.rowCount > 0;
  const [resized, setResized] = useState<Readonly<Record<string, number>>>({});
  // Widths come from the first rows once they arrive; the user can resize from there.
  const suggested = useMemo(() => {
    const buffer = bufferOf(view.id);
    return buffer ? suggestColumnWidths(buffer) : view.columns.map(() => 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, view.columns, hasRows]);
  const columns = useMemo<GridColumn[]>(
    () =>
      view.columns.map((column, index) => ({
        id: `${index}`,
        title: column.name,
        width: resized[`${index}`] ?? suggested[index] ?? 120,
      })),
    [view.columns, suggested, resized],
  );
  const nullTheme = props.theme === 'dark' ? NULL_THEME_DARK : NULL_THEME_LIGHT;
  const getCellContent = useCallback(
    ([column, row]: Item): GridCell => {
      const value = bufferOf(view.id)?.cell(column, row) ?? null;
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
    [view.id, view.version, nullTheme],
  );

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
        onColumnResize={(column, width) => {
          const id = column.id;
          if (id !== undefined) setResized((current) => ({ ...current, [id]: width }));
        }}
      />
    </div>
  );
}
