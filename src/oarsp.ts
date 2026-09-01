// Data Association 限定の直交可視グラフ修復。
// 現行経路が平行共有するか、同じノードの関連ポートが密集したときだけ走る。
// 全周ポート上の Hanan grid 候補を残し、競合成分を一度に評価する。

import type { EdgeGeom, Geometry, NodeGeom, Pt } from './types.ts';
import { segmentInteriorCrossing, simplifyPoints } from './wire.ts';

const CLEAR = 8;
const PORT_STEM = 20;
const CORNER = 6;
const EPS = 0.01;
const MIN_VISUAL_SEGMENT = 16;
const PORT_CORNER_GAP = 12;
const MIN_PORT_GAP = 12;
const PORT_SAMPLES = 16;
const WORLD_CAP = 4096;
const BEAM_WIDTH = 48;

type Rect = { x1: number; y1: number; x2: number; y2: number };
type Dir = 0 | 1; // 0 = horizontal, 1 = vertical
// 3要素目は世界評価時のポート間隔・順序コスト。
type Cost = [nodes: number, shared: number, routing: number, spine: number, crosses: number, bends: number, length: number];
type Port = { point: Pt; stub: Pt; dir: Dir };

export function improveDataAssociations(geometry: Geometry): Geometry {
  const routed = improveDataAssociationsOnce(geometry);
  return routed === geometry ? geometry : improveCrowdedPorts(routed);
}

function improveCrowdedPorts(geometry: Geometry): Geometry {
  let edges = geometry.edges;
  let changed = false;
  for (const conflict of conflictComponents(edges, geometry.nodes)) {
    const group = [...conflict.ports.keys()].map((id) => edges.find((edge) => edge.id === id)!);
    if (group.length < 3) continue;
    const candidates = group.map((edge) => portCandidates(geometry, edge, conflict.ports.get(edge.id)!));
    if (candidates.some((list) => list.length < 2)) continue;
    const focus = new Set(group.map((edge) => edge.id));
    const candidate = applyChoices(edges, group, candidates, new Array(group.length).fill(1));
    if (compare(worldScore(candidate, geometry, focus), worldScore(edges, geometry, focus)) >= 0) continue;
    edges = candidate;
    changed = true;
  }
  return changed ? { ...geometry, edges } : geometry;
}

function improveDataAssociationsOnce(geometry: Geometry): Geometry {
  let changed = false;
  let edges: EdgeGeom[] = geometry.edges.map((e) => ({
    ...e, points: e.points.map((p) => ({ ...p })), hops: undefined,
  }));
  for (const conflict of conflictComponents(edges, geometry.nodes)) {
    const group = conflict.ids.map((id) => edges.find((e) => e.id === id)!);
    const focus = new Set(conflict.ids);
    const candidates = group.map((edge) => conflict.needsGrid
      ? routeCandidates(geometry, edge, edges.filter((e) => e !== edge))
      : portCandidates(geometry, edge, conflict.ports.get(edge.id) ?? new Map()));
    if (!conflict.needsGrid) {
      if (candidates.some((list) => list.length < 2)) continue;
      const candidate = applyChoices(edges, group, candidates, new Array(group.length).fill(1));
      if (compare(worldScore(candidate, geometry, focus), worldScore(edges, geometry, focus)) < 0) {
        edges = candidate;
        changed = true;
      }
      continue;
    }
    const product = candidates.reduce((n, list) => n * list.length, 1);
    const keep = product <= WORLD_CAP ? product : BEAM_WIDTH;
    let worlds: Array<{ choices: number[]; cost: Cost }> = [{
      choices: new Array(group.length).fill(0), cost: worldScore(edges, geometry, focus),
    }];
    for (let i = 0; i < group.length; i++) {
      const expanded: Array<{ choices: number[]; cost: Cost }> = [];
      for (const world of worlds) for (let choice = 0; choice < candidates[i]!.length; choice++) {
        const choices = world.choices.slice();
        choices[i] = choice;
        expanded.push({ choices, cost: worldScore(applyChoices(edges, group, candidates, choices), geometry, focus) });
      }
      expanded.sort((a, b) => compare(a.cost, b.cost) || choiceKey(a.choices).localeCompare(choiceKey(b.choices)));
      worlds = expanded.slice(0, keep);
    }
    const best = worlds[0];
    const current = worldScore(edges, geometry, focus);
    if (!best || compare(best.cost, current) >= 0) continue;
    edges = applyChoices(edges, group, candidates, best.choices);
    changed = true;
  }
  return changed ? { ...geometry, edges } : geometry;
}

function routeCandidates(geometry: Geometry, edge: EdgeGeom, others: EdgeGeom[]): Pt[][] {
  const out = [edge.points];
  const seen = new Set([pathKey(edge.points)]);
  const path = shortestPaths(geometry, edge, others)[0];
  if (path) addCandidate(out, seen, path);
  return out;
}

function portCandidates(
  geometry: Geometry, edge: EdgeGeom, ports: ReadonlyMap<'from' | 'to', Pt>,
): Pt[][] {
  const out = [edge.points];
  const from = geometry.nodes.find((n) => n.id === edge.from);
  const to = geometry.nodes.find((n) => n.id === edge.to);
  if (!from || !to || edge.points.length < 2) return out;
  const sourceSide = portSide(from, edge.points[0]!);
  const targetSide = portSide(to, edge.points.at(-1)!);
  if (!sourceSide || !targetSide) return out;
  const points = edge.points.map((p) => ({ ...p }));
  if (ports.has('from') && !moveEndpoint(points, from, sourceSide, ports.get('from')!, true)) return out;
  if (ports.has('to') && !moveEndpoint(points, to, targetSide, ports.get('to')!, false)) return out;
  out.push(simplifyPoints(points));
  return out;
}

function moveEndpoint(points: Pt[], node: NodeGeom, side: PortSide, point: Pt, source: boolean): boolean {
  const endpoint = source ? 0 : points.length - 1;
  const adjacent = source ? 1 : points.length - 2;
  const a = points[endpoint]!, b = points[adjacent]!;
  const previousAdjacent = { ...b };
  const horizontal = side === 'left' || side === 'right';
  if (horizontal ? Math.abs(a.y - b.y) >= EPS : Math.abs(a.x - b.x) >= EPS) return false;
  points[endpoint] = { ...point };
  if (horizontal) {
    b.y = point.y;
    b.x = side === 'right'
      ? Math.max(b.x, node.x + node.w + PORT_STEM)
      : Math.min(b.x, node.x - PORT_STEM);
  } else {
    b.x = point.x;
    b.y = side === 'bottom'
      ? Math.max(b.y, node.y + node.h + PORT_STEM)
      : Math.min(b.y, node.y - PORT_STEM);
  }
  const continuation = points[source ? adjacent + 1 : adjacent - 1];
  if (continuation) {
    if (horizontal && Math.abs(previousAdjacent.x - continuation.x) < EPS) {
      continuation.x = b.x;
    } else if (!horizontal && Math.abs(previousAdjacent.y - continuation.y) < EPS) {
      continuation.y = b.y;
    }
  }
  return points.every((p, i) => i === 0 || Math.abs(p.x - points[i - 1]!.x) < EPS || Math.abs(p.y - points[i - 1]!.y) < EPS);
}

function addCandidate(out: Pt[][], seen: Set<string>, path: Pt[]): void {
  const key = pathKey(path);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(path);
}

function shortestPaths(geometry: Geometry, edge: EdgeGeom, others: EdgeGeom[]): Pt[][] {
  const from = geometry.nodes.find((n) => n.id === edge.from);
  const to = geometry.nodes.find((n) => n.id === edge.to);
  if (!from || !to || from.id === to.id) return [];
  const rects = geometry.nodes.map(expanded);
  const sources = boundaryRayPorts(from);
  const targets = boundaryRayPorts(to);
  const lane = from.lane === to.lane ? geometry.lanes.find((l) => l.id === from.lane) : undefined;
  const inLane = (p: Pt) => !lane || (geometry.orientation === 'vertical'
    ? p.x >= lane.x - EPS && p.x <= lane.x + lane.w + EPS
    : p.y >= lane.y - EPS && p.y <= lane.y + lane.h + EPS);
  const usableSources = sources.filter((p) => inLane(p.stub));
  const usableTargets = targets.filter((p) => inLane(p.stub));
  if (usableSources.length === 0 || usableTargets.length === 0) return [];

  const xs = unique([
    ...rects.flatMap((r) => [r.x1, r.x2]),
    ...usableSources.map((p) => p.stub.x), ...usableTargets.map((p) => p.stub.x),
  ]);
  const ys = unique([
    ...rects.flatMap((r) => [r.y1, r.y2]),
    ...usableSources.map((p) => p.stub.y), ...usableTargets.map((p) => p.stub.y),
  ]);
  const points: Pt[] = [];
  const byKey = new Map<string, number>();
  for (const y of ys) for (const x of xs) {
    const p = { x, y };
    if (!inLane(p) || rects.some((r) => inside(p, r))) continue;
    byKey.set(key(p), points.length);
    points.push(p);
  }
  const adjacent: Array<Array<{ to: number; dir: Dir }>> = points.map(() => []);
  connectLines(points, adjacent, rects, true);
  connectLines(points, adjacent, rects, false);

  const stateCount = points.length * 2;
  const dist: Array<Cost | undefined> = new Array(stateCount);
  const prev = new Int32Array(stateCount).fill(-1);
  const root = new Int32Array(stateCount).fill(-1);
  const heap = new MinHeap();
  usableSources.forEach((port, i) => {
    const v = byKey.get(key(port.stub));
    if (v === undefined) return;
    const state = v * 2 + port.dir;
    const initial = segmentCost(port.point, port.stub, edge, others);
    if (portSide(from, port.point) !== preferredSide(from, to)) initial[2] += 10_000;
    if (!dist[state] || compare(initial, dist[state]!) < 0) {
      dist[state] = initial;
      root[state] = i;
      heap.push(state, initial);
    }
  });
  while (heap.length > 0) {
    const item = heap.pop()!;
    if (dist[item.state] !== item.cost) continue;
    const v = Math.floor(item.state / 2);
    const dir = (item.state % 2) as Dir;
    for (const next of adjacent[v]!) {
      const seg = segmentCost(points[v]!, points[next.to]!, edge, others);
      if (dir !== next.dir) seg[5]++;
      const cost = add(item.cost, seg);
      const state = next.to * 2 + next.dir;
      if (dist[state] && compare(cost, dist[state]!) >= 0) continue;
      dist[state] = cost;
      prev[state] = item.state;
      root[state] = root[item.state]!;
      heap.push(state, cost);
    }
  }

  const finishes: Array<{ state: number; target: Port; cost: Cost }> = [];
  for (const target of usableTargets) {
    const v = byKey.get(key(target.stub));
    if (v === undefined) continue;
    for (const dir of [0, 1] as const) {
      const state = v * 2 + dir;
      const base = dist[state];
      if (!base) continue;
      const tail = segmentCost(target.stub, target.point, edge, others);
      if (portSide(to, target.point) !== preferredSide(to, from)) tail[2] += 10_000;
      if (dir !== target.dir) tail[5]++;
      const cost = add(base, tail);
      finishes.push({ state, target, cost });
    }
  }
  finishes.sort((a, b) => compare(a.cost, b.cost) || key(a.target.point).localeCompare(key(b.target.point)) || a.state - b.state);
  const out: Pt[][] = [], seen = new Set<string>();
  for (const finish of finishes) {
    if (root[finish.state]! < 0) continue;
    const grid: Pt[] = [];
    for (let state = finish.state; state >= 0; state = prev[state]!) {
      grid.push(points[Math.floor(state / 2)]!);
      if (prev[state]! < 0) break;
    }
    grid.reverse();
    const path = simplifyPoints([usableSources[root[finish.state]!]!.point, ...grid, finish.target.point]);
    const pathId = pathKey(path);
    if (seen.has(pathId)) continue;
    seen.add(pathId);
    out.push(path);
    break;
  }
  return out;
}

/** 中心からの放射線と外接矩形の交点を境界候補にする。 */
export function boundaryRayPorts(node: NodeGeom): Port[] {
  const out: Port[] = [];
  for (let i = 0; i < PORT_SAMPLES; i++) {
    const angle = i * 2 * Math.PI / PORT_SAMPLES;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const tx = (node.w / 2) / Math.max(Math.abs(dx), EPS);
    const ty = (node.h / 2) / Math.max(Math.abs(dy), EPS);
    if (tx <= ty) out.push(sidePort(node, dx >= 0 ? 'right' : 'left', clamp(node.cy + dy * tx, node.y + CORNER, node.y + node.h - CORNER)));
    else out.push(sidePort(node, dy >= 0 ? 'bottom' : 'top', clamp(node.cx + dx * ty, node.x + CORNER, node.x + node.w - CORNER)));
  }
  return uniquePorts(out);
}

function sidePort(node: NodeGeom, side: 'left' | 'right' | 'top' | 'bottom', at: number): Port {
  at = Math.round(at * 100) / 100;
  if (side === 'left') return { point: { x: node.x, y: at }, stub: { x: node.x - PORT_STEM, y: at }, dir: 0 };
  if (side === 'right') return { point: { x: node.x + node.w, y: at }, stub: { x: node.x + node.w + PORT_STEM, y: at }, dir: 0 };
  if (side === 'top') return { point: { x: at, y: node.y }, stub: { x: at, y: node.y - PORT_STEM }, dir: 1 };
  return { point: { x: at, y: node.y + node.h }, stub: { x: at, y: node.y + node.h + PORT_STEM }, dir: 1 };
}

function uniquePorts(ports: Port[]): Port[] {
  const seen = new Set<string>();
  return ports.filter((port) => {
    const id = `${key(port.point)}:${port.dir}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function connectLines(
  points: Pt[], adjacent: Array<Array<{ to: number; dir: Dir }>>, rects: Rect[], horizontal: boolean,
): void {
  const groups = new Map<number, number[]>();
  points.forEach((p, i) => {
    const k = horizontal ? p.y : p.x;
    const list = groups.get(k) ?? [];
    list.push(i);
    groups.set(k, list);
  });
  for (const group of groups.values()) {
    group.sort((a, b) => horizontal ? points[a]!.x - points[b]!.x : points[a]!.y - points[b]!.y);
    for (let i = 0; i + 1 < group.length; i++) {
      const a = group[i]!, b = group[i + 1]!;
      if (rects.some((r) => blocked(points[a]!, points[b]!, r))) continue;
      const dir = horizontal ? 0 : 1;
      adjacent[a]!.push({ to: b, dir });
      adjacent[b]!.push({ to: a, dir });
    }
  }
}

function conflictComponents(edges: EdgeGeom[], nodes: NodeGeom[]): Array<{
  ids: string[]; needsGrid: boolean; ports: Map<string, Map<'from' | 'to', Pt>>;
}> {
  const eligible = edges.filter((e) => e.kind === 'assoc' && (!e.assocKind || e.assocKind === 'data'));
  const active = new Set<string>();
  const gridEdges = new Set<string>();
  const assignedPorts = new Map<string, Map<'from' | 'to', Pt>>();
  const links = new Map(eligible.map((e) => [e.id, new Set<string>()]));
  const link = (a: EdgeGeom, b: EdgeGeom, needsGrid = false) => {
    active.add(a.id); active.add(b.id);
    if (needsGrid) { gridEdges.add(a.id); gridEdges.add(b.id); }
    links.get(a.id)!.add(b.id); links.get(b.id)!.add(a.id);
  };
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i]!, b = eligible[j]!;
    if (a.from !== b.from && a.to !== b.to && sharedPair(a, b) > 0) link(a, b, true);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const portGroups = new Map<string, Array<{
    edge: EdgeGeom; endpoint: 'from' | 'to'; at: number; side: PortSide; stem: [Pt, Pt];
  }>>();
  const addPort = (edge: EdgeGeom, endpoint: 'from' | 'to', nodeId: string, point: Pt, next: Pt) => {
    const node = nodeById.get(nodeId), side = node && portSide(node, point);
    if (!node || !side) return;
    const key = `${endpoint}:${nodeId}:${side}`;
    const list = portGroups.get(key) ?? [];
    list.push({ edge, endpoint, at: side === 'left' || side === 'right' ? point.y : point.x, side, stem: [point, next] });
    portGroups.set(key, list);
  };
  for (const edge of eligible) {
    addPort(edge, 'from', edge.from, edge.points[0]!, edge.points[1] ?? edge.points[0]!);
    addPort(edge, 'to', edge.to, edge.points.at(-1)!, edge.points.at(-2) ?? edge.points.at(-1)!);
  }
  for (const uses of portGroups.values()) {
    if (uses.length < 3) continue;
    const crowded = uses.some((a, i) => uses.slice(i + 1).some((b) =>
      Math.abs(a.at - b.at) < MIN_PORT_GAP && projectedStemOverlap(a.stem, b.stem, a.side) > 0));
    if (!crowded) continue;
    const nodeId = uses[0]!.edge[uses[0]!.endpoint];
    const node = nodeById.get(nodeId)!;
    const side = uses[0]!.side;
    let candidates = boundaryRayPorts(node)
      .filter((port) => portSide(node, port.point) === side)
      .map((port) => ({ point: port.point, at: side === 'left' || side === 'right' ? port.point.y : port.point.x }))
      .sort((a, b) => a.at - b.at);
    const candidateGap = Math.min(...candidates.slice(1).map((candidate, i) => candidate.at - candidates[i]!.at));
    if (candidates.length < uses.length || candidateGap < MIN_PORT_GAP) {
      const lo = (side === 'left' || side === 'right' ? node.y : node.x) + CORNER;
      const hi = (side === 'left' || side === 'right' ? node.y + node.h : node.x + node.w) - CORNER;
      const span = MIN_PORT_GAP * (uses.length - 1);
      if (hi - lo < span) continue;
      const mean = uses.reduce((sum, use) => sum + use.at, 0) / uses.length;
      const start = clamp(mean - span / 2, lo, hi - span);
      candidates = Array.from({ length: uses.length }, (_, i) => {
        const port = sidePort(node, side, start + i * MIN_PORT_GAP);
        return { point: port.point, at: start + i * MIN_PORT_GAP };
      });
    }
    if (candidates.length < uses.length) continue;
    const ordered = [...uses].sort((a, b) => a.at - b.at || a.edge.id.localeCompare(b.edge.id));
    let best = candidates.slice(0, ordered.length);
    let bestDistance = Infinity;
    for (let start = 0; start + ordered.length <= candidates.length; start++) {
      const window = candidates.slice(start, start + ordered.length);
      const distance = window.reduce((sum, candidate, i) => sum + Math.abs(candidate.at - ordered[i]!.at), 0);
      if (distance < bestDistance) { best = window; bestDistance = distance; }
    }
    for (let i = 0; i < ordered.length; i++) {
      const use = ordered[i]!;
      const ports = assignedPorts.get(use.edge.id) ?? new Map<'from' | 'to', Pt>();
      ports.set(use.endpoint, best[i]!.point);
      assignedPorts.set(use.edge.id, ports);
    }
    for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
      link(uses[i]!.edge, uses[j]!.edge);
    }
  }
  const out: Array<{ ids: string[]; needsGrid: boolean; ports: Map<string, Map<'from' | 'to', Pt>> }> = [];
  const unseen = new Set(active);
  while (unseen.size > 0) {
    const first = [...unseen].sort()[0]!;
    const stack = [first];
    const component: string[] = [];
    unseen.delete(first);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const next of [...(links.get(id) ?? [])].sort().reverse()) {
        if (!unseen.delete(next)) continue;
        stack.push(next);
      }
    }
    out.push({
      ids: component.sort(),
      needsGrid: component.some((id) => gridEdges.has(id)),
      ports: new Map(component.flatMap((id) => assignedPorts.has(id) ? [[id, assignedPorts.get(id)!]] : [])),
    });
  }
  return out;
}

function applyChoices(
  edges: EdgeGeom[], group: EdgeGeom[], candidates: Pt[][][], choices: number[],
): EdgeGeom[] {
  const picked = new Map(group.map((edge, i) => [edge.id, candidates[i]![choices[i]!]!]));
  return edges.map((edge) => {
    const points = picked.get(edge.id);
    return points ? { ...edge, points, labelPos: undefined, hops: undefined } : edge;
  });
}

function worldScore(edges: EdgeGeom[], geometry: Geometry, focus?: ReadonlySet<string>): Cost {
  const total: Cost = [0, 0, 0, 0, 0, 0, 0];
  for (const edge of edges) {
    if (focus && !focus.has(edge.id)) continue;
    const part = score(edge.points, edge, edges.filter((e) => e !== edge), geometry.nodes);
    for (let i = 0; i < total.length; i++) total[i] = total[i]! + part[i]!;
  }
  total[2] = portOrderPenalty(edges, geometry.nodes);
  total[5] = visualAppearancePenalty({ ...geometry, edges }) * 1000 + total[5];
  return total;
}

/** 短いガタつき、時間軸の逆走、角に寄りすぎた関連ポートを数値化する。 */
export function visualAppearancePenalty(geometry: Geometry): number {
  const nodes = new Map(geometry.nodes.map((n) => [n.id, n]));
  let penalty = 0;
  for (const edge of geometry.edges) {
    let length = 0;
    for (let i = 1; i + 2 < edge.points.length; i++) {
      const a = edge.points[i]!, b = edge.points[i + 1]!;
      penalty += Math.max(0, MIN_VISUAL_SEGMENT - Math.abs(a.x - b.x) - Math.abs(a.y - b.y));
    }
    for (let i = 0; i + 1 < edge.points.length; i++) {
      length += Math.abs(edge.points[i + 1]!.x - edge.points[i]!.x) + Math.abs(edge.points[i + 1]!.y - edge.points[i]!.y);
    }
    const first = edge.points[0]!, last = edge.points.at(-1)!;
    penalty += length - Math.abs(last.x - first.x) - Math.abs(last.y - first.y);
    if (!edge.isReturn) {
      const axis = geometry.orientation === 'horizontal' ? 'x' : 'y';
      const direction = Math.sign(last[axis] - first[axis]);
      if (direction !== 0) for (let i = 0; i + 1 < edge.points.length; i++) {
        const step = (edge.points[i + 1]![axis] - edge.points[i]![axis]) * direction;
        if (step < 0) penalty -= step;
      }
    }
    if (edge.kind !== 'assoc') continue;
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (from) penalty += cornerPortPenalty(from, edge.points[0]!);
    if (to) penalty += cornerPortPenalty(to, edge.points.at(-1)!);
  }
  return penalty;
}

function cornerPortPenalty(node: NodeGeom, point: Pt): number {
  const side = portSide(node, point);
  if (!side) return 0;
  const at = side === 'left' || side === 'right' ? point.y - node.y : point.x - node.x;
  const span = side === 'left' || side === 'right' ? node.h : node.w;
  return Math.max(0, PORT_CORNER_GAP - Math.min(at, span - at));
}

function portOrderPenalty(edges: EdgeGeom[], nodes: NodeGeom[]): number {
  type Use = { at: number; toward: number; misaligned: boolean; side: PortSide; stem: [Pt, Pt] };
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const groups = new Map<string, Use[]>();
  const add = (node: NodeGeom, peer: NodeGeom, point: Pt, next: Pt) => {
    const side = portSide(node, point);
    if (!side) return;
    const verticalSide = side === 'left' || side === 'right';
    const key = `${node.id}:${side}`;
    const list = groups.get(key) ?? [];
    list.push({
      at: verticalSide ? point.y : point.x,
      toward: verticalSide ? peer.cy : peer.cx,
      misaligned: side !== preferredSide(node, peer),
      side,
      stem: [point, next],
    });
    groups.set(key, list);
  };
  for (const edge of edges) {
    if (edge.kind !== 'assoc') continue;
    const from = nodeById.get(edge.from), to = nodeById.get(edge.to);
    if (!from || !to) continue;
    add(from, to, edge.points[0]!, edge.points[1] ?? edge.points[0]!);
    add(to, from, edge.points.at(-1)!, edge.points.at(-2) ?? edge.points.at(-1)!);
  }
  let misaligned = 0, proximity = 0, inversions = 0;
  for (const uses of groups.values()) misaligned += uses.filter((use) => use.misaligned).length;
  for (const uses of groups.values()) for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
    const a = uses[i]!, b = uses[j]!;
    const gap = Math.abs(a.at - b.at);
    if (gap < MIN_PORT_GAP && projectedStemOverlap(a.stem, b.stem, a.side) > 0) {
      proximity += MIN_PORT_GAP - gap;
    }
    else if ((a.at - b.at) * (a.toward - b.toward) < 0) inversions++;
  }
  return misaligned * 10_000 + proximity * 100 + inversions;
}

type PortSide = 'left' | 'right' | 'top' | 'bottom';

function projectedStemOverlap(a: [Pt, Pt], b: [Pt, Pt], side: PortSide): number {
  const axis = side === 'left' || side === 'right' ? 'x' : 'y';
  return Math.max(0,
    Math.min(Math.max(a[0][axis], a[1][axis]), Math.max(b[0][axis], b[1][axis])) -
    Math.max(Math.min(a[0][axis], a[1][axis]), Math.min(b[0][axis], b[1][axis])));
}

function preferredSide(node: NodeGeom, peer: NodeGeom): PortSide {
  const dx = peer.cx - node.cx, dy = peer.cy - node.cy;
  return Math.abs(dx) >= Math.abs(dy)
    ? (dx >= 0 ? 'right' : 'left')
    : (dy >= 0 ? 'bottom' : 'top');
}

function portSide(node: NodeGeom, p: Pt): PortSide | undefined {
  if (Math.abs(p.x - node.x) < 1) return 'left';
  if (Math.abs(p.x - node.x - node.w) < 1) return 'right';
  if (Math.abs(p.y - node.y) < 1) return 'top';
  if (Math.abs(p.y - node.y - node.h) < 1) return 'bottom';
  return undefined;
}

function score(points: Pt[], edge: EdgeGeom, others: EdgeGeom[], nodes: NodeGeom[]): Cost {
  const out: Cost = [0, 0, 0, 0, 0, Math.max(0, points.length - 2), 0];
  for (let i = 0; i + 1 < points.length; i++) {
    const seg = segmentCost(points[i]!, points[i + 1]!, edge, others);
    out[1] += seg[1]; out[3] += seg[3]; out[4] += seg[4]; out[6] += seg[6];
    for (const n of nodes) {
      if ((i === 0 && n.id === edge.from) || (i === points.length - 2 && n.id === edge.to)) continue;
      if (blocked(points[i]!, points[i + 1]!, { x1: n.x + 2, y1: n.y + 2, x2: n.x + n.w - 2, y2: n.y + n.h - 2 })) out[0]++;
    }
  }
  return out;
}

function segmentCost(a: Pt, b: Pt, edge: EdgeGeom, others: EdgeGeom[]): Cost {
  const out: Cost = [0, 0, 0, 0, 0, 0,
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y)];
  for (const other of others) for (let i = 0; i + 1 < other.points.length; i++) {
    const c = other.points[i]!, d = other.points[i + 1]!;
    out[1] += overlap(a, b, c, d);
    if (segmentInteriorCrossing(a, b, c, d)) {
      out[4]++;
      if (other.onSpine) out[3]++;
    }
  }
  return out;
}

function sharedPair(a: EdgeGeom, b: EdgeGeom): number {
  let n = 0;
  for (let i = 0; i + 1 < a.points.length; i++) for (let j = 0; j + 1 < b.points.length; j++) {
    n += overlap(a.points[i]!, a.points[i + 1]!, b.points[j]!, b.points[j + 1]!);
  }
  return n;
}

function overlap(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ah = Math.abs(a.y - b.y) < EPS, ch = Math.abs(c.y - d.y) < EPS;
  if (ah !== ch) return 0;
  if (ah) {
    if (Math.abs(a.y - c.y) > 1) return 0;
    return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
  }
  if (Math.abs(a.x - c.x) > 1) return 0;
  return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
}

function expanded(n: NodeGeom): Rect {
  return { x1: n.x - CLEAR, y1: n.y - CLEAR, x2: n.x + n.w + CLEAR, y2: n.y + n.h + CLEAR };
}
function inside(p: Pt, r: Rect): boolean {
  return p.x > r.x1 + EPS && p.x < r.x2 - EPS && p.y > r.y1 + EPS && p.y < r.y2 - EPS;
}
function blocked(a: Pt, b: Pt, r: Rect): boolean {
  if (Math.abs(a.y - b.y) < EPS) {
    return a.y > r.y1 + EPS && a.y < r.y2 - EPS && Math.max(a.x, b.x) > r.x1 + EPS && Math.min(a.x, b.x) < r.x2 - EPS;
  }
  return a.x > r.x1 + EPS && a.x < r.x2 - EPS && Math.max(a.y, b.y) > r.y1 + EPS && Math.min(a.y, b.y) < r.y2 - EPS;
}
function unique(values: number[]): number[] {
  return [...new Set(values.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b);
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function key(p: Pt): string { return `${p.x},${p.y}`; }
function pathKey(points: Pt[]): string { return points.map(key).join('|'); }
function choiceKey(choices: number[]): string { return choices.join(','); }
function add(a: Cost, b: Cost): Cost { return a.map((n, i) => n + b[i]!) as Cost; }
function compare(a: Cost, b: Cost): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

class MinHeap {
  private items: Array<{ state: number; cost: Cost }> = [];
  get length(): number { return this.items.length; }
  push(state: number, cost: Cost): void {
    this.items.push({ state, cost });
    for (let i = this.items.length - 1; i > 0;) {
      const p = Math.floor((i - 1) / 2);
      if (compare(this.items[p]!.cost, cost) <= 0) break;
      this.items[i] = this.items[p]!; i = p;
      this.items[i] = { state, cost };
    }
  }
  pop(): { state: number; cost: Cost } | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    this.items[0] = last;
    for (let i = 0;;) {
      const l = i * 2 + 1, r = l + 1;
      let best = i;
      if (l < this.items.length && compare(this.items[l]!.cost, this.items[best]!.cost) < 0) best = l;
      if (r < this.items.length && compare(this.items[r]!.cost, this.items[best]!.cost) < 0) best = r;
      if (best === i) break;
      [this.items[i], this.items[best]] = [this.items[best]!, this.items[i]!];
      i = best;
    }
    return first;
  }
}
