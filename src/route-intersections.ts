// Geometric intersections shared by candidate selection and diagnostic reports.
import type { EdgeGeom } from './types.ts';
import { segmentInteriorCrossing } from './wire.ts';

export interface Hit {
  a: string;
  b: string;
  x: number;
  y: number;
  spine: boolean;
}

export function rawHits(edges: EdgeGeom[]): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]!;
      const e2 = edges[j]!;
      for (let s1 = 0; s1 + 1 < e1.points.length; s1++) {
        for (let s2 = 0; s2 + 1 < e2.points.length; s2++) {
          const cross = segmentInteriorCrossing(
            e1.points[s1]!, e1.points[s1 + 1]!,
            e2.points[s2]!, e2.points[s2 + 1]!,
          );
          if (!cross) continue;
          const [a, b] = e1.id < e2.id ? [e1.id, e2.id] : [e2.id, e1.id];
          const key = `${a}|${b}|${cross.x}|${cross.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ a, b, x: cross.x, y: cross.y, spine: e1.onSpine || e2.onSpine });
        }
      }
    }
  }
  return hits;
}
