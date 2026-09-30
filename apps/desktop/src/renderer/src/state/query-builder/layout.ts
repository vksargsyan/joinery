import type { ELK } from 'elkjs/lib/elk-api';

/**
 * Auto-layout of the query builder's canvas with elkjs (spec §8: React Flow with elkjs
 * auto-layout), shared in shape with the other visual designers: tables as boxes, joins as
 * edges, laid out left to right in layers so joined tables sit side by side. The bundled build
 * runs in the page without a worker (a canvas holds tens of tables, which lay out in a few
 * milliseconds) and loads on the first layout, so it costs nothing at start-up.
 */

export interface LayoutBox {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

let elk: Promise<ELK> | undefined;

function loadElk(): Promise<ELK> {
  elk ??= import('elkjs/lib/elk.bundled.js').then(({ default: Elk }) => new Elk());
  return elk;
}

/** Top-left positions for every box; edges to boxes not in the list are ignored. */
export async function layoutBoxes(
  boxes: readonly LayoutBox[],
  edges: readonly LayoutEdge[],
): Promise<Record<string, Point>> {
  if (boxes.length === 0) return {};
  const ids = new Set(boxes.map((box) => box.id));
  const graph = await (
    await loadElk()
  ).layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.componentComponent': '60',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: boxes.map((box) => ({ id: box.id, width: box.width, height: box.height })),
    edges: edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const out: Record<string, Point> = {};
  for (const child of graph.children ?? []) {
    out[child.id] = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) };
  }
  return out;
}

/**
 * Where a table added by hand goes before any layout: right of the rightmost box, level with
 * the top one, so it never covers what is there.
 */
export function placeNext(existing: readonly (Point & { readonly width?: number })[]): Point {
  if (existing.length === 0) return { x: 40, y: 40 };
  const right = Math.max(...existing.map((p) => p.x + (p.width ?? 240)));
  const top = Math.min(...existing.map((p) => p.y));
  return { x: right + 80, y: top };
}
