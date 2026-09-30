import { BISQUE } from '../../lib/kiln';
import { markerId, markerSvg } from './markers';
import {
  BOX,
  anchorY,
  boxSize,
  keyLetters,
  relationColumns,
  tableLabel,
  visibleColumns,
  type DisplayOptions,
  type ErDiagram,
  type ErEnd,
  type KeyLetter,
} from './model';
import { relationRoute, roundedPath } from './route';

/**
 * The ER diagram as a standalone SVG document (spec §8: diagrams export as images): the boxes
 * where the canvas has them, the relationship lines with their crow's-foot ends, and a caption.
 * It is drawn from the model, not captured from the screen, so it is sharp at any size and
 * independent of the window; a PNG is this SVG rasterised. Light colours, for documents. Pure.
 */

export interface SvgPalette {
  readonly background: string;
  readonly box: string;
  readonly header: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly line: string;
  readonly primaryKey: string;
  readonly foreignKey: string;
  readonly unique: string;
}

/** Exported diagrams are set in Kiln Bisque, the light theme: they go into documents. */
export const LIGHT_PALETTE: SvgPalette = {
  background: BISQUE.bg,
  box: BISQUE.bgRaised,
  header: BISQUE.bgDeep,
  border: BISQUE.borderStrong,
  text: BISQUE.fg,
  muted: BISQUE.muted,
  line: BISQUE.punct,
  primaryKey: BISQUE.ochre,
  foreignKey: BISQUE.cobalt,
  unique: BISQUE.celadon,
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Helvetica, Arial, sans-serif";
const MARGIN = 40;
const CAPTION = 28;

export interface SvgInput {
  readonly diagram: ErDiagram;
  /** Top-left corners by table id; tables without one are left out. */
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly display: DisplayOptions;
  /** Tables to leave out (hidden on the canvas). */
  readonly hidden?: ReadonlySet<string>;
  /** A line above the diagram, e.g. "shop · public — 12 tables". */
  readonly caption?: string;
  readonly palette?: SvgPalette;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Cuts text to about `width` pixels at `advance` per character, with an ellipsis. */
function fit(text: string, width: number, advance: number): string {
  const max = Math.max(1, Math.floor(width / advance));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function letterColor(letter: KeyLetter, palette: SvgPalette): string {
  return letter === 'P' ? palette.primaryKey : letter === 'F' ? palette.foreignKey : palette.unique;
}

/** The ER diagram as an SVG document, and its size. */
export function diagramSvg(input: SvgInput): { svg: string; width: number; height: number } {
  const { diagram, display } = input;
  const palette = input.palette ?? LIGHT_PALETTE;
  const related = relationColumns(diagram);
  const boxes = diagram.tables
    .filter((table) => input.positions[table.id] && !input.hidden?.has(table.id))
    .map((table) => {
      const columns = visibleColumns(table, display.columns, related.get(table.id));
      const size = boxSize(diagram, table, columns, display.types);
      return { table, columns, ...size, ...input.positions[table.id]! };
    });
  const byId = new Map(boxes.map((box) => [box.table.id, box]));
  const minX = Math.min(...boxes.map((b) => b.x), 0);
  const minY = Math.min(...boxes.map((b) => b.y), 0);
  const maxX = Math.max(...boxes.map((b) => b.x + b.width), minX + 200);
  const maxY = Math.max(...boxes.map((b) => b.y + b.height), minY + 100);
  const top = input.caption ? CAPTION : 0;
  const width = Math.round(maxX - minX + MARGIN * 2);
  const height = Math.round(maxY - minY + MARGIN * 2 + top);
  const dx = MARGIN - minX;
  const dy = MARGIN + top - minY;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeXml(FONT)}">`,
  );
  const ends: ErEnd[] = ['one', 'zero-or-one', 'zero-or-many'];
  out.push(
    `<defs>${ends.map((end) => markerSvg(end, false, palette.line, palette.background)).join('')}</defs>`,
  );
  out.push(`<rect width="100%" height="100%" fill="${palette.background}"/>`);
  if (input.caption) {
    out.push(
      `<text x="${MARGIN}" y="${MARGIN - 8}" font-size="13" font-weight="600" fill="${palette.text}">${escapeXml(input.caption)}</text>`,
    );
  }

  // Lines first, so boxes cover their ends cleanly.
  out.push(`<g fill="none" stroke="${palette.line}" stroke-width="1.5">`);
  for (const relation of diagram.relations) {
    const child = byId.get(relation.child);
    const parent = byId.get(relation.parent);
    if (!child || !parent) continue;
    const place = (box: typeof child) => ({ ...box, x: box.x + dx, y: box.y + dy });
    const from = place(child);
    const to = child === parent ? from : place(parent);
    const route = relationRoute(
      from,
      from.y + anchorY(child.columns, relation.childColumns[0]),
      to,
      to.y + anchorY(parent.columns, relation.parentColumns[0]),
    );
    out.push(
      `<path d="${roundedPath(route.points)}" marker-start="url(#${markerId(relation.childEnd, false)})" marker-end="url(#${markerId(relation.parentEnd, false)})"/>`,
    );
  }
  out.push('</g>');

  for (const box of boxes) {
    const x = box.x + dx;
    const y = box.y + dy;
    const { table } = box;
    const kind =
      table.kind === 'view'
        ? 'view'
        : table.kind === 'materialized-view'
          ? 'materialized view'
          : table.external
            ? 'other schema'
            : undefined;
    out.push(`<g>`);
    out.push(
      `<rect x="${x}" y="${y}" width="${box.width}" height="${box.height}" rx="6" fill="${palette.box}" stroke="${palette.border}"${table.external ? ' stroke-dasharray="4 3"' : ''}/>`,
    );
    const headerHeight = box.columns.length > 0 ? BOX.header : box.height;
    out.push(
      `<path d="M${x + 0.5} ${y + headerHeight} V${y + 6} Q${x + 0.5} ${y + 0.5} ${x + 6} ${y + 0.5} H${x + box.width - 6} Q${x + box.width - 0.5} ${y + 0.5} ${x + box.width - 0.5} ${y + 6} V${y + headerHeight}${box.columns.length > 0 ? ' Z' : ''}" fill="${palette.header}" stroke="none"/>`,
    );
    if (box.columns.length > 0) {
      out.push(
        `<line x1="${x}" y1="${y + BOX.header}" x2="${x + box.width}" y2="${y + BOX.header}" stroke="${palette.border}"/>`,
      );
    }
    const label = fit(tableLabel(diagram, table), box.width - (kind ? 100 : 24), BOX.char + 0.5);
    out.push(
      `<text x="${x + 12}" y="${y + 20}" font-size="12" font-weight="700" fill="${palette.text}">${escapeXml(label)}</text>`,
    );
    if (kind) {
      out.push(
        `<text x="${x + box.width - 10}" y="${y + 20}" font-size="10" text-anchor="end" fill="${palette.muted}">${kind}</text>`,
      );
    }
    box.columns.forEach((column, i) => {
      const rowY = y + BOX.header + i * BOX.row + BOX.row / 2 + 4;
      const letters = keyLetters(column);
      if (letters.length > 0) {
        const spans = letters
          .map((letter) => `<tspan fill="${letterColor(letter, palette)}">${letter}</tspan>`)
          .join('');
        out.push(
          `<text x="${x + 10}" y="${rowY}" font-size="10" font-weight="700" letter-spacing="1">${spans}</text>`,
        );
      }
      const typeWidth =
        display.types && column.type ? Math.min(column.type.length * 6.2, box.width / 2) : 0;
      const name = fit(column.name, box.width - BOX.badge - typeWidth - 20, BOX.char);
      out.push(
        `<text x="${x + BOX.badge}" y="${rowY}" font-size="12"${column.primaryKey ? ' font-weight="600"' : ''} fill="${palette.text}">${escapeXml(name)}${column.nullable || column.primaryKey ? '' : `<tspan fill="${palette.muted}"> *</tspan>`}</text>`,
      );
      if (display.types && column.type) {
        out.push(
          `<text x="${x + box.width - 10}" y="${rowY}" font-size="11" text-anchor="end" fill="${palette.muted}">${escapeXml(fit(column.type, box.width / 2, 6.2))}</text>`,
        );
      }
    });
    out.push('</g>');
  }
  out.push('</svg>');
  return { svg: out.join(''), width, height };
}
