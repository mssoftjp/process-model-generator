// External node labels: one geometry contract for rendering, routing and inspection.
import { measureText } from './metrics.ts';
import { OUT_LABEL_FONT, OUT_LABEL_LINE_H } from './measure.ts';
import type { Geometry, NodeGeom, Pt } from './types.ts';

export interface Box { x: number; y: number; w: number; h: number }
export interface ExternalNodeLabel { box: Box; x: number; anchor: 'start' | 'middle' | 'end' }

export function externalNodeLabel(n: NodeGeom): ExternalNodeLabel | undefined {
  if (['task', 'note', 'group'].includes(n.kind) || n.labelLines.length === 0) return undefined;
  const w = Math.max(...n.labelLines.map(line => measureText(line, OUT_LABEL_FONT)));
  const h = n.labelLines.length * OUT_LABEL_LINE_H;
  let x: number, y: number, anchor: ExternalNodeLabel['anchor'];
  if (n.kind === 'xor' || n.kind === 'and') {
    x = n.cx - 8; y = n.y - 6 - h; anchor = 'end';
  } else if (n.kind === 'doc' || n.kind === 'store') {
    x = n.cx + 6; y = n.y + n.h + 4; anchor = 'start';
  } else if (n.labelSide === 'left' || n.labelSide === 'right') {
    x = n.labelSide === 'left' ? n.x - 6 : n.x + n.w + 6;
    y = n.cy + (n.labelShift ?? 0) - h / 2;
    anchor = n.labelSide === 'left' ? 'end' : 'start';
  } else {
    x = n.cx; y = n.labelSide === 'top' ? n.y - 6 - h : n.y + n.h + 6; anchor = 'middle';
  }
  return { x, anchor, box: { x: x - (anchor === 'end' ? w : anchor === 'middle' ? w / 2 : 0), y, w, h } };
}

export function nodeObstacles(n: NodeGeom): Box[] {
  const label = externalNodeLabel(n);
  return [{ x: n.x, y: n.y, w: n.w, h: n.h }, ...(label ? [label.box] : [])];
}

/** Open rectangle intersection; touching the outer boundary is not text penetration. */
export function segmentLabelHit(a: Pt, b: Pt, box: Box): Pt | undefined {
  const loX = Math.max(Math.min(a.x, b.x), box.x), hiX = Math.min(Math.max(a.x, b.x), box.x + box.w);
  const loY = Math.max(Math.min(a.y, b.y), box.y), hiY = Math.min(Math.max(a.y, b.y), box.y + box.h);
  if (a.y === b.y && a.y > box.y && a.y < box.y + box.h && hiX > loX) return { x: (loX + hiX) / 2, y: a.y };
  if (a.x === b.x && a.x > box.x && a.x < box.x + box.w && hiY > loY) return { x: a.x, y: (loY + hiY) / 2 };
  return undefined;
}

export interface NodeLabelRouteHit { edgeId: string; nodeId: string; segment: number; point: Pt }
export function inspectNodeLabelRoutes(g: Pick<Geometry, 'nodes' | 'edges'>): NodeLabelRouteHit[] {
  const labels = g.nodes.flatMap(n => { const label = externalNodeLabel(n); return label ? [{ id: n.id, box: label.box }] : []; });
  const hits: NodeLabelRouteHit[] = [];
  for (const edge of g.edges) for (const label of labels) {
    for (let i = 0; i + 1 < edge.points.length; i++) {
      const point = segmentLabelHit(edge.points[i]!, edge.points[i + 1]!, label.box);
      if (point) { hits.push({ edgeId: edge.id, nodeId: label.id, segment: i, point }); break; }
    }
  }
  return hits;
}
