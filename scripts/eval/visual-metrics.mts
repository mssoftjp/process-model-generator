// Diagnostic proxies, not a perceptual score. Measure the rendered waypoints in every version.
import type { Geometry, Pt } from '../../src/types.ts';
export function routeShape(points: Pt[]) {
  const a = points[0], b = points.at(-1);
  if (!a || !b) return { length: 0, ratio: null, excursion: 0, bends: 0 };
  const direct = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  let length = 0, excursion = 0, bends = 0;
  let previous: Pt | undefined;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const outsideX = Math.max(0, Math.min(a.x, b.x) - p.x, p.x - Math.max(a.x, b.x));
    const outsideY = Math.max(0, Math.min(a.y, b.y) - p.y, p.y - Math.max(a.y, b.y));
    excursion = Math.max(excursion, outsideX, outsideY);
    if (!i) continue;
    const q = points[i - 1]!;
    const dx = p.x - q.x, dy = p.y - q.y;
    const size = Math.hypot(dx, dy);
    length += Math.abs(dx) + Math.abs(dy);
    if (!size) continue;
    const direction = { x: dx / size, y: dy / size };
    if (previous && (Math.abs(previous.x - direction.x) > 1e-6 || Math.abs(previous.y - direction.y) > 1e-6)) bends++;
    previous = direction;
  }
  return { length, ratio: direct ? length / direct : null, excursion, bends };
}
export function visualMetrics(g: Geometry) {
  const edges = g.edges.map(e => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, isReturn: e.isReturn, ...routeShape(e.points) }));
  const groups = Object.fromEntries(['seq', 'msg', 'assoc', 'return'].map(kind => {
    const selected = edges.filter(e => kind === 'return' ? e.isReturn : !e.isReturn && e.kind === kind);
    const ratios = selected.flatMap(e => e.ratio === null ? [] : [e.ratio]).sort((a,b) => a-b);
    return [kind, { count: selected.length, ratioMean: ratios.length ? ratios.reduce((a,b) => a+b, 0) / ratios.length : null, ratioMax: ratios.at(-1) ?? null, excursionMax: Math.max(0, ...selected.map(e => e.excursion)), bends: selected.reduce((a,e) => a+e.bends, 0) }];
  }));
  return { groups, edges };
}
