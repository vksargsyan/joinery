import type { ErEnd } from './model';

/**
 * The crow's-foot ends of a relationship line, as data both the canvas (SVG markers in React)
 * and the exported image (SVG text) draw from, so the two look the same. Each glyph is drawn
 * for a line arriving from the left at a box edge at x = 20: bars mean one, a circle zero, the
 * three-pronged foot many. SVG orients the marker along the line at either end.
 */

export interface MarkerShape {
  readonly paths: readonly string[];
  /** Circles as [cx, cy, r]. */
  readonly circles: readonly (readonly [number, number, number])[];
}

export const MARKER_SIZE = 20;

export const MARKER_SHAPES: Readonly<Record<ErEnd, MarkerShape>> = {
  one: { paths: ['M0 10 H20', 'M12 4 V16', 'M16 4 V16'], circles: [] },
  'zero-or-one': { paths: ['M0 10 H4', 'M11 10 H20', 'M15 4 V16'], circles: [[7.5, 10, 3.5]] },
  'zero-or-many': {
    paths: ['M0 10 H4', 'M11 10 H20', 'M13 10 L20 3', 'M13 10 L20 17'],
    circles: [[7.5, 10, 3.5]],
  },
};

/** The id of an end's marker; `active` ones are drawn in the accent colour. */
export function markerId(end: ErEnd, active: boolean): string {
  return `er-${end}${active ? '-active' : ''}`;
}

/** An end's marker as SVG text, for the exported image. */
export function markerSvg(end: ErEnd, active: boolean, stroke: string, fill: string): string {
  const shape = MARKER_SHAPES[end];
  const parts = [
    ...shape.paths.map((d) => `<path d="${d}"/>`),
    ...shape.circles.map(
      ([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`,
    ),
  ].join('');
  return `<marker id="${markerId(end, active)}" viewBox="0 0 ${MARKER_SIZE} ${MARKER_SIZE}" refX="${MARKER_SIZE}" refY="${MARKER_SIZE / 2}" markerWidth="${MARKER_SIZE}" markerHeight="${MARKER_SIZE}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><g fill="none" stroke="${stroke}" stroke-width="1.5">${parts}</g></marker>`;
}
