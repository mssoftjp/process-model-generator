// Cycle B/C: ノードは固定したまま、交差する競合群だけ経路の順序と溝面を入れ替える。
// 宣言順ではなく辺 ID で決定する。layoutScore は最終採用の門であり、ここでは使わない。

import type { Coords } from './coords.ts';
import { inspectEdgeLabels, placeEdgeLabels } from './edge-labels.ts';
import type { EdgeLabelReport } from './edge-labels.ts';
import { checkOracle } from './oracle.ts';
import { differentSourceSharedLength } from './crossing-causes.ts';
import { route } from './route.ts';
import type {
  EdgeGeom, EdgePlan, Geometry, NormGraph, Placement, RoutePlan, SymPt,
} from './types.ts';
import { computeHops, segmentInteriorCrossing, wire } from './wire.ts';

const SIFT_PASSES = 2;
const SIFT_CAP = 16;
const FLIP_CAP = 5;
const SIFT_MIN_HOPS = 4;
const FLIP_MIN_HOPS = 6;

export interface MaterializedRoute {
  plan: RoutePlan;
  geometry: Geometry;
  coords: Coords;
  titleShift: number;
  labelReport: EdgeLabelReport;
}

type Score = [oracle: number, spine: number, ownership: number, shared: number, hops: number, raw: number];

export function improveRouting(
  g: NormGraph,
  placement: Placement,
  optimizeReadability: boolean,
  materialize: (plan: RoutePlan) => MaterializedRoute,
  start: MaterializedRoute,
): MaterializedRoute {
  let current = siftConflictOrder(g, start);
  const hops = hopCount(current.geometry.edges);
  const hasGap = current.plan.plans.some((p) => p.points.some((pt) => pt.y.t === 'poolChannel'));
  if (hops < FLIP_MIN_HOPS || !hasGap || current.geometry.pools.length < 2) return current;

  const flips = new Set<string>();
  const tried = new Set<string>();
  let best = scoreOf(g, current.geometry);
  for (let i = 0; i < FLIP_CAP; i++) {
    const id = nextGapFlip(current, tried);
    if (id === undefined) break;
    tried.add(id);
    flips.add(id);
    const cand = materialize(route(g, placement, optimizeReadability, { gapDestFlip: flips }));
    const next = scoreOf(g, cand.geometry);
    if (better(next, best)) {
      current = siftConflictOrder(g, cand);
      best = scoreOf(g, current.geometry);
    } else {
      flips.delete(id);
    }
  }
  return current;
}

export function siftConflictOrder(g: NormGraph, current: MaterializedRoute): MaterializedRoute {
  if (hopCount(current.geometry.edges) < SIFT_MIN_HOPS) return current;
  let bestPlan = current.plan;
  let bestGeom = current.geometry;
  let bestLabelReport = current.labelReport;
  let best = scoreOf(g, bestGeom);
  let cheap = cheapScore(bestGeom.edges);
  let tries = 0;
  for (let pass = 0; pass < SIFT_PASSES; pass++) {
    const pairs = crossingPairs(bestGeom.edges);
    let improved = false;
    for (const [a, b] of pairs) {
      if (tries >= SIFT_CAP) return pack(current, bestPlan, bestGeom, bestLabelReport);
      const cand = trySharedSwap(bestPlan, a, b);
      if (!cand) continue;
      tries++;
      const geom = rewire(g, cand, current);
      const cheapNext = cheapScore(geom.edges);
      if (!cheapBetter(cheapNext, cheap)) continue;
      const labelReport = placeEdgeLabels(geom);
      const next = scoreOf(g, geom);
      if (!better(next, best)) continue;
      bestPlan = cand;
      bestGeom = geom;
      bestLabelReport = labelReport;
      best = next;
      cheap = cheapNext;
      improved = true;
    }
    if (!improved) break;
  }
  return pack(current, bestPlan, bestGeom, bestLabelReport);
}

function pack(
  origin: MaterializedRoute, plan: RoutePlan, geometry: Geometry, labelReport = origin.labelReport,
): MaterializedRoute {
  return { plan, geometry, coords: origin.coords, titleShift: origin.titleShift, labelReport };
}

function rewire(
  g: NormGraph, plan: RoutePlan, origin: MaterializedRoute,
): Geometry {
  const edges = wire(g, plan, origin.coords, origin.geometry.orientation, origin.titleShift);
  computeHops(edges);
  return { ...origin.geometry, edges };
}

function scoreOf(g: NormGraph, geometry: Geometry): Score {
  const labels = inspectEdgeLabels(geometry);
  const oracle = checkOracle(g, geometry).filter((d) => d.level === 'error').length;
  let hops = 0;
  let raw = 0;
  let spine = 0;
  for (const e of geometry.edges) hops += e.hops?.length ?? 0;
  for (const hit of rawHits(geometry.edges)) {
    raw++;
    if (hit.spine) spine++;
  }
  return [oracle, spine, labels.stolen + labels.ambiguous, differentSourceSharedLength(geometry.edges), hops, raw];
}

function better(a: Score, b: Score): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

function hopCount(edges: EdgeGeom[]): number {
  return edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0);
}

function cheapScore(edges: EdgeGeom[]): { spine: number; hops: number; raw: number } {
  let hops = 0;
  let raw = 0;
  let spine = 0;
  for (const e of edges) hops += e.hops?.length ?? 0;
  for (const hit of rawHits(edges)) {
    raw++;
    if (hit.spine) spine++;
  }
  return { spine, hops, raw };
}

function cheapBetter(
  a: { spine: number; hops: number; raw: number },
  b: { spine: number; hops: number; raw: number },
): boolean {
  if (a.spine !== b.spine) return a.spine < b.spine;
  if (a.hops !== b.hops) return a.hops < b.hops;
  return a.raw < b.raw;
}

function nextGapFlip(current: MaterializedRoute, tried: ReadonlySet<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const [a, b] of crossingPairs(current.geometry.edges)) {
    counts.set(a, (counts.get(a) ?? 0) + 1);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const gapIds = new Set(
    current.plan.plans.filter((p) => p.points.some((pt) => pt.y.t === 'poolChannel')).map((p) => p.edgeId),
  );
  let best: { id: string; n: number } | undefined;
  for (const id of gapIds) {
    if (tried.has(id)) continue;
    const n = counts.get(id) ?? 0;
    if (n === 0) continue;
    if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, n };
  }
  return best?.id;
}

function crossingPairs(edges: EdgeGeom[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const hit of rawHits(edges)) {
    const [a, b] = hit.a < hit.b ? [hit.a, hit.b] : [hit.b, hit.a];
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  pairs.sort((p, q) => p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0);
  return pairs;
}

function rawHits(edges: EdgeGeom[]): Array<{ a: string; b: string; spine: boolean }> {
  const hits: Array<{ a: string; b: string; spine: boolean }> = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]!;
      const e2 = edges[j]!;
      for (let s1 = 0; s1 + 1 < e1.points.length; s1++) {
        for (let s2 = 0; s2 + 1 < e2.points.length; s2++) {
          if (!segmentInteriorCrossing(
            e1.points[s1]!, e1.points[s1 + 1]!,
            e2.points[s2]!, e2.points[s2 + 1]!,
          )) continue;
          hits.push({ a: e1.id, b: e2.id, spine: e1.onSpine || e2.onSpine });
        }
      }
    }
  }
  return hits;
}

function trySharedSwap(plan: RoutePlan, aId: string, bId: string): RoutePlan | undefined {
  const next = clonePlan(plan);
  const pa = next.plans.find((p) => p.edgeId === aId);
  const pb = next.plans.find((p) => p.edgeId === bId);
  if (!pa || !pb) return undefined;
  let swapped = false;
  swapped = swapTracks(next.gutterRunTrack, gutterRuns(pa), gutterRuns(pb)) || swapped;
  swapped = swapTracks(next.channelRunTrack, channelRuns(pa), channelRuns(pb)) || swapped;
  swapped = swapTracks(next.poolGapRunTrack, poolRuns(pa), poolRuns(pb)) || swapped;
  swapped = swapPortOffsets(pa, pb) || swapped;
  return swapped ? next : undefined;
}

function swapTracks(
  map: Map<number, number>,
  aRuns: Map<string, number>,
  bRuns: Map<string, number>,
): boolean {
  let swapped = false;
  for (const [key, runA] of aRuns) {
    const runB = bRuns.get(key);
    if (runB === undefined) continue;
    const ta = map.get(runA) ?? 0;
    const tb = map.get(runB) ?? 0;
    if (ta === tb) continue;
    map.set(runA, tb);
    map.set(runB, ta);
    swapped = true;
  }
  return swapped;
}

function gutterRuns(p: EdgePlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const pt of p.points) {
    if (pt.x.t === 'gutter') out.set(`${pt.x.g}:${pt.x.side}`, pt.x.run);
  }
  return out;
}

function channelRuns(p: EdgePlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const pt of p.points) {
    if (pt.y.t === 'channel') out.set(`${pt.y.lane}:${pt.y.row}`, pt.y.run);
  }
  return out;
}

function poolRuns(p: EdgePlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const pt of p.points) {
    if (pt.y.t === 'poolChannel') out.set(String(pt.y.gap), pt.y.run);
  }
  return out;
}

function swapPortOffsets(a: EdgePlan, b: EdgePlan): boolean {
  let swapped = false;
  swapped = swapStubAxis(a, b, 0, 0, 'x') || swapped;
  swapped = swapStubAxis(a, b, 0, 0, 'y') || swapped;
  swapped = swapStubAxis(a, b, a.points.length - 2, b.points.length - 2, 'x') || swapped;
  swapped = swapStubAxis(a, b, a.points.length - 2, b.points.length - 2, 'y') || swapped;
  return swapped;
}

function swapStubAxis(
  a: EdgePlan, b: EdgePlan, ia: number, ib: number, axis: 'x' | 'y',
): boolean {
  const a0 = a.points[ia];
  const a1 = a.points[ia + 1];
  const b0 = b.points[ib];
  const b1 = b.points[ib + 1];
  if (!a0 || !a1 || !b0 || !b1) return false;
  const sa = a0[axis];
  const sb = b0[axis];
  if (sa.t !== 'nodeCX' && sa.t !== 'nodeCY') return false;
  if (sb.t !== sa.t) return false;
  if (!sameStub(a0[axis], a1[axis]) || !sameStub(b0[axis], b1[axis])) return false;
  if (sa.t === 'nodeCX' && sb.t === 'nodeCX' && sa.id !== sb.id) return false;
  if (sa.t === 'nodeCY' && sb.t === 'nodeCY' && sa.id !== sb.id) return false;
  const oa = 'offset' in sa ? sa.offset ?? 0 : 0;
  const ob = 'offset' in sb ? sb.offset ?? 0 : 0;
  if (oa === ob) return false;
  setOffset(a0, axis, ob);
  setOffset(a1, axis, ob);
  setOffset(b0, axis, oa);
  setOffset(b1, axis, oa);
  return true;
}

function sameStub(a: SymPt['x'] | SymPt['y'], b: SymPt['x'] | SymPt['y']): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 'nodeCX' && b.t === 'nodeCX') return a.id === b.id && (a.offset ?? 0) === (b.offset ?? 0);
  if (a.t === 'nodeCY' && b.t === 'nodeCY') return a.id === b.id && (a.offset ?? 0) === (b.offset ?? 0);
  return false;
}

function setOffset(pt: SymPt, axis: 'x' | 'y', offset: number): void {
  if (axis === 'x' && pt.x.t === 'nodeCX') pt.x = { t: 'nodeCX', id: pt.x.id, offset };
  if (axis === 'y' && pt.y.t === 'nodeCY') pt.y = { t: 'nodeCY', id: pt.y.id, offset };
}

function clonePlan(rp: RoutePlan): RoutePlan {
  return {
    ...rp,
    plans: rp.plans.map((p) => ({
      ...p,
      points: p.points.map((pt) => ({ x: { ...pt.x }, y: { ...pt.y } })),
    })),
    gutterRunTrack: new Map(rp.gutterRunTrack),
    channelRunTrack: new Map(rp.channelRunTrack),
    poolGapRunTrack: new Map(rp.poolGapRunTrack),
    gutterTracks: new Map(rp.gutterTracks),
    channelTracks: new Map(rp.channelTracks),
    poolGapTracks: new Map(rp.poolGapTracks),
    gutterLabelNeed: new Map(rp.gutterLabelNeed),
  };
}
