/**
 * How a relationship line runs between two boxes, shared by the canvas and the exported image
 * so both draw the same line: it leaves the referencing column's row and reaches the
 * referenced column's row horizontally, with a straight stretch at each end long enough for
 * the crow's-foot glyphs, and turns at right angles with rounded corners in between. Boxes side
 * by side are joined across the gap between them; boxes above one another are joined around the
 * nearer side; a table referencing itself loops off its right side. Pure.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

export interface Route {
  readonly points: readonly Point[];
  /** Where a label goes: the middle of the line's middle stretch. */
  readonly label: Point;
}

/** The straight stretch at each end: the glyph (20px) and a little air. */
export const STUB = 28;

/**
 * The line from the child box (at `childY`, a canvas y inside it) to the parent box (at
 * `parentY`). The same object on both sides is a self-reference.
 */
export function relationRoute(child: Rect, childY: number, parent: Rect, parentY: number): Route {
  const childRight = child.x + child.width;
  const parentRight = parent.x + parent.width;
  let points: Point[];
  if (child === parent) {
    // A loop needs two distinct rows; with the columns hidden both ends are the header.
    const [from, to] = childY === parentY ? [childY - 6, parentY + 6] : [childY, parentY];
    const out = childRight + STUB + 10;
    points = [
      { x: childRight, y: from },
      { x: out, y: from },
      { x: out, y: to },
      { x: childRight, y: to },
    ];
  } else if (childRight + STUB * 2 <= parent.x) {
    const mid = (childRight + parent.x) / 2;
    points = [
      { x: childRight, y: childY },
      { x: mid, y: childY },
      { x: mid, y: parentY },
      { x: parent.x, y: parentY },
    ];
  } else if (parentRight + STUB * 2 <= child.x) {
    const mid = (parentRight + child.x) / 2;
    points = [
      { x: child.x, y: childY },
      { x: mid, y: childY },
      { x: mid, y: parentY },
      { x: parentRight, y: parentY },
    ];
  } else {
    // The boxes overlap across: go around whichever side is the shorter way.
    const right = Math.max(childRight, parentRight) + STUB;
    const left = Math.min(child.x, parent.x) - STUB;
    const viaRight = right - childRight + (right - parentRight);
    const viaLeft = child.x - left + (parent.x - left);
    points =
      viaRight <= viaLeft
        ? [
            { x: childRight, y: childY },
            { x: right, y: childY },
            { x: right, y: parentY },
            { x: parentRight, y: parentY },
          ]
        : [
            { x: child.x, y: childY },
            { x: left, y: childY },
            { x: left, y: parentY },
            { x: parent.x, y: parentY },
          ];
  }
  const [, a, b] = points as [Point, Point, Point, Point];
  return { points, label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** An SVG path through the points, with the corners rounded to `radius`. */
export function roundedPath(points: readonly Point[], radius = 10): string {
  // Drop repeated points, then points in the middle of a straight stretch.
  const distinct = points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y,
  );
  const pts = distinct.filter((p, i) => {
    const prev = distinct[i - 1];
    const next = distinct[i + 1];
    if (!prev || !next) return true;
    return (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x) !== 0;
  });
  if (pts.length === 0) return '';
  const first = pts[0]!;
  let d = `M${round(first.x)} ${round(first.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const inLength = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLength = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5) {
      d += ` L${round(cur.x)} ${round(cur.y)}`;
      continue;
    }
    const ax = cur.x + ((prev.x - cur.x) / inLength) * r;
    const ay = cur.y + ((prev.y - cur.y) / inLength) * r;
    const bx = cur.x + ((next.x - cur.x) / outLength) * r;
    const by = cur.y + ((next.y - cur.y) / outLength) * r;
    d += ` L${round(ax)} ${round(ay)} Q${round(cur.x)} ${round(cur.y)} ${round(bx)} ${round(by)}`;
  }
  const last = pts[pts.length - 1]!;
  if (pts.length > 1) d += ` L${round(last.x)} ${round(last.y)}`;
  return d;
}
