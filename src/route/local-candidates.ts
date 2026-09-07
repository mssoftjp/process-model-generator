import type { EdgeGeom, Geometry, Pt } from '../types.ts';
import { simplifyPoints } from '../wire.ts';

const direction = (a: Pt, b: Pt): string => `${Math.sign(b.x - a.x)},${Math.sign(b.y - a.y)}`;

/** Fixed-node candidates. The caller must validate the entire diagram before adopting. */
export function* localSequenceCandidates(g: Geometry): Generator<Geometry> {
  const replace = (changes: Map<string, Pt[]>): Geometry => ({
    ...g, edges: g.edges.map(e => ({ ...e, points: changes.get(e.id) ?? e.points, hops: undefined })),
  });
  const sequences = g.edges.filter(e => e.kind === 'seq');
  // Exchange occupied ports, retaining each route's upstream corridor. Only parallel
  // terminal approaches on the same face qualify; no new boundary points are invented.
  for (let i = 0; i < sequences.length; i++) {
    const a = sequences[i]!;
    for (const b of sequences.slice(i + 1)) {
      if (a.to !== b.to || a.points.length < 3 || b.points.length < 3) continue;
      const ap = a.points.at(-1)!, bp = b.points.at(-1)!;
      const aq = a.points.at(-2)!, bq = b.points.at(-2)!;
      if (direction(aq, ap) !== direction(bq, bp)) continue;
      const horizontal = aq.y === ap.y;
      if (horizontal ? ap.x !== bp.x : ap.y !== bp.y) continue;
      const tail = (e: EdgeGeom, port: Pt): Pt[] => {
        const p = e.points.slice(0, -2);
        const q = e.points.at(-2)!;
        return [...p, horizontal ? { x: q.x, y: port.y } : { x: port.x, y: q.y }, { ...port }];
      };
      yield replace(new Map([[a.id, tail(a, bp)], [b.id, tail(b, ap)]]));
    }
  }
  // Generate short orthogonal paths using existing corridor coordinates, preserving
  // the direction of both port stems. Geometry and business flags remain unchanged.
  for (const e of sequences) {
    const p = e.points;
    if (p.length < 5) continue;
    const a = p[0]!, b = p.at(-1)!;
    const paths: Pt[][] = [];
    for (const x of new Set(p.map(q => q.x))) paths.push([a, { x, y: a.y }, { x, y: b.y }, b]);
    for (const y of new Set(p.map(q => q.y))) paths.push([a, { x: a.x, y }, { x: b.x, y }, b]);
    for (const path of paths) {
      const q = simplifyPoints(path);
      if (q.length < 2 || q.length >= p.length ||
          direction(q[0]!, q[1]!) !== direction(p[0]!, p[1]!) ||
          direction(q.at(-2)!, q.at(-1)!) !== direction(p.at(-2)!, p.at(-1)!)) continue;
      yield replace(new Map([[e.id, q]]));
    }
  }
}
