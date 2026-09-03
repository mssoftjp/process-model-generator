// 交差の原因分類。描画も hops も変えない。compile の採用経路には載せない。
// 内部交差の判定は wire.segmentInteriorCrossing と同一（端点タッチは接続）。

import { inspectEdgeLabels, edgeLabelBox } from './edge-labels.ts';
import { place } from './place.ts';
import { route } from './route.ts';
import type { CompileResult, EdgeGeom, Geometry, Pt, RoutePlan } from './types.ts';
import { segmentInteriorCrossing } from './wire.ts';

const RUN_MIN = 16;
const LABEL_FAR = 160;

export interface CrossingCauseReport {
  rawIntersections: number;
  spineCrossings: number;
  endpointInversions: number;
  trackOrderInversions: number;
  residual: number;
  nonLaminarPairs: number;
  channelDensity: number;
  hops: number;
  differentSourceSharedLength: number;
  labelStolen: number;
  labelAmbiguous: number;
  labelFar: number;
  bends: number;
  // ポート対(出口軸・入口軸)から決まる最小折れ数に対する超過。「無駄な折れ」の代理指標
  excessBends: number;
  // 非戻り辺のうち、始点→終点の正味方向に対してどちらかの軸で逆走する区間を持つ辺(回り込み)
  detourEdges: number;
  length: number;
  area: number;
}

export interface DeclarationOrderSensitivity {
  baseline: number;
  variant: number;
  delta: number;
}

interface Hit {
  a: string;
  b: string;
  x: number;
  y: number;
  spine: boolean;
}

interface Interval {
  edgeId: string;
  start: number;
  end: number;
}

export function recoverSelectedRoute(result: CompileResult): RoutePlan {
  const improved = result.diagnostics.some((d) => d.code === 'N-431');
  return route(result.normalized, place(result.normalized), improved);
}

export function allocatedTrackDensity(plan: RoutePlan): number {
  let max = 0;
  for (const n of plan.channelTracks.values()) max = Math.max(max, n);
  for (const t of plan.gutterTracks.values()) max = Math.max(max, t.exit, t.entry);
  for (const n of plan.poolGapTracks.values()) max = Math.max(max, n);
  return max;
}

export function diagnoseCompiled(result: CompileResult): CrossingCauseReport {
  return diagnoseCrossingCauses(result.geometry, recoverSelectedRoute(result));
}

export function diagnoseCrossingCauses(geometry: Geometry, plan?: RoutePlan): CrossingCauseReport {
  const hits = rawHits(geometry.edges);
  const labels = inspectEdgeLabels(geometry);
  let hops = 0;
  let bends = 0;
  let length = 0;
  let labelFar = 0;
  let excessBends = 0;
  let detourEdges = 0;
  for (const e of geometry.edges) {
    hops += e.hops?.length ?? 0;
    bends += Math.max(0, e.points.length - 2);
    excessBends += Math.max(0, Math.max(0, e.points.length - 2) - minimumBends(e.points));
    if (!e.isReturn && hasDetour(e.points)) detourEdges++;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }
    const box = edgeLabelBox(e);
    if (!box) continue;
    const start = e.points[0]!;
    const dx = box.x + box.w / 2 - start.x;
    const dy = box.y + box.h / 2 - start.y;
    if (Math.abs(dx) + Math.abs(dy) > LABEL_FAR) labelFar++;
  }
  const byId = new Map(geometry.edges.map((e) => [e.id, e]));
  const corridors = corridorIntervals(geometry.edges);
  let spineCrossings = 0;
  let endpointInversions = 0;
  let trackOrderInversions = 0;
  let classified = 0;
  for (const h of hits) {
    const a = byId.get(h.a);
    const b = byId.get(h.b);
    const spine = h.spine;
    const endpoint = !!a && !!b && endpointsInvert(a, b, geometry.orientation);
    const track = !!a && !!b && (() => {
      const ySign = parallelOrder(a, b, true);
      const xSign = parallelOrder(a, b, false);
      return ySign !== 0 && xSign !== 0 && ySign !== xSign;
    })();
    if (spine) spineCrossings++;
    if (endpoint) endpointInversions++;
    if (track) trackOrderInversions++;
    if (spine || endpoint || track) classified++;
  }
  return {
    rawIntersections: hits.length,
    spineCrossings,
    endpointInversions,
    trackOrderInversions,
    residual: hits.length - classified,
    nonLaminarPairs: countNonLaminarPairs(corridors),
    channelDensity: plan ? allocatedTrackDensity(plan) : maxDensity(corridors),
    hops,
    differentSourceSharedLength: differentSourceSharedLength(geometry.edges),
    labelStolen: labels.stolen,
    labelAmbiguous: labels.ambiguous,
    labelFar,
    bends,
    excessBends,
    detourEdges,
    length,
    area: geometry.width * geometry.height,
  };
}

/** 出口区間と入口区間の軸から決まる最小折れ数(同軸で揃っていれば 0、同軸でずれていれば 2、異軸なら 1) */
export function minimumBends(points: Pt[]): number {
  if (points.length < 2) return 0;
  const a = points[0]!;
  const b = points.at(-1)!;
  const exitH = isHorizontal(a, points[1]!);
  const entryH = isHorizontal(points.at(-2)!, b);
  if (exitH !== entryH) return 1;
  const aligned = exitH ? Math.abs(a.y - b.y) < 0.5 : Math.abs(a.x - b.x) < 0.5;
  return aligned ? 0 : 2;
}

/** 始点→終点の正味方向に対して、どちらかの軸で逆走する区間があるか */
export function hasDetour(points: Pt[]): boolean {
  if (points.length < 2) return false;
  const a = points[0]!;
  const b = points.at(-1)!;
  for (const axis of ['x', 'y'] as const) {
    const dir = Math.sign(b[axis] - a[axis]);
    for (let i = 1; i < points.length; i++) {
      const step = points[i]![axis] - points[i - 1]![axis];
      if (dir === 0 ? Math.abs(step) > 0.5 : step * dir < -0.5) return true;
    }
  }
  return false;
}

export function compareDeclarationOrder(
  baseline: CrossingCauseReport,
  variant: CrossingCauseReport,
): DeclarationOrderSensitivity {
  return {
    baseline: baseline.rawIntersections,
    variant: variant.rawIntersections,
    delta: variant.rawIntersections - baseline.rawIntersections,
  };
}

function rawHits(edges: EdgeGeom[]): Hit[] {
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

function endpointsInvert(a: EdgeGeom, b: EdgeGeom, orientation: Geometry['orientation']): boolean {
  if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) return false;
  const a0 = a.points[0]!;
  const b0 = b.points[0]!;
  const a1 = a.points.at(-1)!;
  const b1 = b.points.at(-1)!;
  const forward = orientation === 'vertical'
    ? a1.y > a0.y && b1.y > b0.y
    : a1.x > a0.x && b1.x > b0.x;
  if (!forward) return false;
  const axis = orientation === 'vertical' ? (p: Pt) => p.x : (p: Pt) => p.y;
  const start = Math.sign(axis(a0) - axis(b0));
  const end = Math.sign(axis(a1) - axis(b1));
  return start !== 0 && end !== 0 && start !== end;
}

function parallelOrder(a: EdgeGeom, b: EdgeGeom, horizontal: boolean): number {
  let sign = 0;
  for (let i = 0; i + 1 < a.points.length; i++) {
    const a1 = a.points[i]!;
    const a2 = a.points[i + 1]!;
    if (isHorizontal(a1, a2) !== horizontal) continue;
    if (span(a1, a2, horizontal) < RUN_MIN) continue;
    for (let j = 0; j + 1 < b.points.length; j++) {
      const b1 = b.points[j]!;
      const b2 = b.points[j + 1]!;
      if (isHorizontal(b1, b2) !== horizontal) continue;
      if (span(b1, b2, horizontal) < RUN_MIN) continue;
      if (!overlap1d(along(a1, a2, horizontal), along(b1, b2, horizontal))) continue;
      const next = Math.sign(crossCoord(a1, horizontal) - crossCoord(b1, horizontal));
      if (next === 0) continue;
      if (sign !== 0 && sign !== next) return 0;
      sign = next;
    }
  }
  return sign;
}

function corridorIntervals(edges: EdgeGeom[]): Map<string, Interval[]> {
  const out = new Map<string, Interval[]>();
  for (const e of edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      const horizontal = isHorizontal(a, b);
      if (span(a, b, horizontal) < RUN_MIN) continue;
      const key = horizontal ? `h:${a.y}` : `v:${a.x}`;
      const [start, end] = along(a, b, horizontal);
      const list = out.get(key) ?? [];
      list.push({ edgeId: e.id, start, end });
      out.set(key, list);
    }
  }
  return out;
}

function countNonLaminarPairs(corridors: Map<string, Interval[]>): number {
  let n = 0;
  for (const runs of corridors.values()) {
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]!;
        const b = runs[j]!;
        if (a.edgeId === b.edgeId) continue;
        if (!overlap1d([a.start, a.end], [b.start, b.end])) continue;
        const nested = contains(a, b) || contains(b, a);
        if (!nested) n++;
      }
    }
  }
  return n;
}

function maxDensity(corridors: Map<string, Interval[]>): number {
  let max = 0;
  for (const runs of corridors.values()) {
    const events: Array<{ at: number; d: number }> = [];
    for (const run of runs) {
      events.push({ at: run.start, d: 1 }, { at: run.end, d: -1 });
    }
    events.sort((a, b) => a.at - b.at || a.d - b.d);
    let active = 0;
    for (const ev of events) {
      active += ev.d;
      if (active > max) max = active;
    }
  }
  return max;
}

export function differentSourceSharedLength(edges: EdgeGeom[]): number {
  let shared = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let s1 = 0; s1 + 1 < edges[i]!.points.length; s1++) {
      const a1 = edges[i]!.points[s1]!;
      const a2 = edges[i]!.points[s1 + 1]!;
      const aH = isHorizontal(a1, a2);
      for (let j = i + 1; j < edges.length; j++) {
        if (edges[i]!.from === edges[j]!.from) continue;
        for (let s2 = 0; s2 + 1 < edges[j]!.points.length; s2++) {
          const b1 = edges[j]!.points[s2]!;
          const b2 = edges[j]!.points[s2 + 1]!;
          if (isHorizontal(b1, b2) !== aH) continue;
          if (aH) {
            if (a1.y !== b1.y) continue;
            shared += overlapLen(a1.x, a2.x, b1.x, b2.x);
          } else {
            if (a1.x !== b1.x) continue;
            shared += overlapLen(a1.y, a2.y, b1.y, b2.y);
          }
        }
      }
    }
  }
  return shared;
}

function isHorizontal(a: Pt, b: Pt): boolean {
  return Math.abs(a.y - b.y) < 0.01;
}

function span(a: Pt, b: Pt, horizontal: boolean): number {
  return horizontal ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y);
}

function along(a: Pt, b: Pt, horizontal: boolean): [number, number] {
  const u = horizontal ? a.x : a.y;
  const v = horizontal ? b.x : b.y;
  return u < v ? [u, v] : [v, u];
}

function crossCoord(a: Pt, horizontal: boolean): number {
  return horizontal ? a.y : a.x;
}

function overlap1d(a: [number, number], b: [number, number]): boolean {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0;
}

function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function overlapLen(a1: number, a2: number, b1: number, b2: number): number {
  const left = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const right = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, right - left);
}
