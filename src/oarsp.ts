// Data Association と小規模な混在入線・分岐出線の直交経路修復。
// 共有線、密集ポート、外部ラベル貫通、混在入線の交差を起点にする。
// 全周ポート上の Hanan grid 候補を残し、競合成分を一度に評価する。

import { isEventKind, isGatewayKind } from './bpmn.ts';
import type { EdgeGeom, Geometry, NodeGeom, Pt } from './types.ts';
import { segmentInteriorCrossing, simplifyPoints } from './wire.ts';
import { externalNodeLabel, inspectNodeLabelRoutes } from './node-labels.ts';
import { rawHits } from './route-intersections.ts';

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

/** Small connected groups with mixed task inputs or shared gateway exits.
 * Conflict participants and movable participants differ: every input of the task
 * can move, while unrelated crossing edges remain fixed obstacles.
 * The compiler validates and scores each complete candidate against the whole diagram.
 */
export function* connectedRouteCandidates(geometry: Geometry): Generator<Geometry> {
  const eligible = geometry.edges.filter(e => e.kind === 'seq' ||
    (e.kind === 'assoc' && (!e.assocKind || e.assocKind === 'data')));
  const hits = rawHits(geometry.edges);
  const labelHits = new Set(inspectNodeLabelRoutes(geometry).map(h => h.edgeId));
  const groups: Array<{ node: NodeGeom; endpoint: 'from' | 'to'; edges: EdgeGeom[] }> = [];
  for (const node of geometry.nodes) {
    const inputs = eligible.filter(e => e.to === node.id);
    const ids = new Set(inputs.map(e => e.id));
    if (node.kind === 'task' && inputs.length >= 2 && inputs.length <= 4 &&
        inputs.some(e => e.kind === 'seq') && inputs.some(e => e.kind === 'assoc') &&
        (hits.some(h => ids.has(h.a) || ids.has(h.b)) || inputs.some(e => labelHits.has(e.id)))) {
      groups.push({ node, endpoint: 'to', edges: inputs });
    }
    const outputs = eligible.filter(e => e.kind === 'seq' && e.from === node.id);
    if (isGatewayKind(node.kind) && outputs.length === 2 &&
        outputs.some((a, i) => outputs.slice(i + 1).some(b => sharedPair(a, b) > 0))) {
      groups.push({ node, endpoint: 'from', edges: outputs });
    }
  }
  for (const { node, endpoint, edges: group } of groups.slice(0, 3)) {
    const focus = new Set(group.map(e => e.id));
    const fixed = geometry.edges.filter(e => !focus.has(e.id));
    const candidates = group.map(edge => {
      const ports = (['left', 'right', 'top', 'bottom'] as const).map(side => {
        const horizontal = side === 'left' || side === 'right';
        const axis = horizontal ? 'cy' : 'cx';
        const ordered = [...group].sort((a, b) => {
          const peerA = geometry.nodes.find(n => n.id === a[endpoint === 'to' ? 'from' : 'to'])!;
          const peerB = geometry.nodes.find(n => n.id === b[endpoint === 'to' ? 'from' : 'to'])!;
          const other = horizontal ? 'cx' : 'cy';
          const tieDirection = side === 'left' || side === 'top' ? -1 : 1;
          return peerA[axis] - peerB[axis] || tieDirection * (peerA[other] - peerB[other]) || a.id.localeCompare(b.id);
        });
        const span = horizontal ? node.h : node.w;
        const gap = Math.min(16, (span - 2 * CORNER) / (group.length - 1));
        const offset = isGatewayKind(node.kind) ? 0 : (ordered.indexOf(edge) - (group.length - 1) / 2) * gap;
        return sidePort(node, side, (horizontal ? node.cy : node.cx) + offset);
      });
      const paths = endpoint === 'from'
        ? shortPortPaths(geometry, edge, fixed, ports)
        : shortestPaths(geometry, edge, fixed, { targets: ports, limit: 6, local: true });
      return [edge.points, ...paths];
    });
    // Keep diverse combinations, not merely the individually shortest route.
    let worlds: Array<{ choices: number[]; cost: Cost }> = [{ choices: group.map(() => 0), cost: worldScore(geometry.edges, geometry) }];
    for (let i = 0; i < group.length; i++) {
      const next: typeof worlds = [];
      for (const world of worlds) for (let choice = 0; choice < candidates[i]!.length; choice++) {
        const choices = [...world.choices]; choices[i] = choice;
        next.push({ choices, cost: worldScore(applyChoices(geometry.edges, group, candidates, choices), geometry) });
      }
      next.sort((a, b) => compare(a.cost, b.cost) || choiceKey(a.choices).localeCompare(choiceKey(b.choices)));
      worlds = next.slice(0, BEAM_WIDTH);
    }
    for (const world of worlds) {
      const edges = applyChoices(geometry.edges, group, candidates, world.choices)
        .map(e => ({ ...e, hops: undefined }));
      yield { ...geometry, edges };
    }
  }
}

/** Cheap alternatives for a two-way gateway: no full visibility-grid search. */
function shortPortPaths(geometry: Geometry, edge: EdgeGeom, fixed: EdgeGeom[], sources: Port[]): Pt[][] {
  const target = geometry.nodes.find(n => n.id === edge.to);
  if (!target) return [];
  const options: Array<{ path: Pt[]; cost: Cost; face: string }> = [];
  const seen = new Set<string>();
  for (const source of sources) for (const end of boundaryRayPorts(target)) {
    for (const elbow of [{ x: source.stub.x, y: end.stub.y }, { x: end.stub.x, y: source.stub.y }]) {
      const path = simplifyPoints([source.point, source.stub, elbow, end.stub, end.point]);
      if (path.length < 2 || seen.has(pathKey(path))) continue;
      seen.add(pathKey(path));
      const cost = score(path, edge, fixed, geometry.nodes);
      cost[0] += inspectNodeLabelRoutes({ ...geometry, edges: [{ ...edge, points: path }] }).length;
      const sourceDir = { x: source.stub.x - source.point.x, y: source.stub.y - source.point.y };
      const first = path[1]!;
      if ((first.x - source.point.x) * sourceDir.x + (first.y - source.point.y) * sourceDir.y <= 0) continue;
      options.push({ path, cost, face: `${source.dir}:${sourceDir.x > 0}:${sourceDir.y > 0}` });
    }
  }
  options.sort((a, b) => compare(a.cost, b.cost) || pathKey(a.path).localeCompare(pathKey(b.path)));
  const faces = new Map<string, number>();
  return options.filter(o => {
    const count = faces.get(o.face) ?? 0;
    if (count >= 2 || o.cost[0] > 0) return false;
    faces.set(o.face, count + 1); return true;
  }).slice(0, 8).map(o => o.path);
}

function routeCandidates(geometry: Geometry, edge: EdgeGeom, others: EdgeGeom[]): Pt[][] {
  const out = [edge.points];
  const seen = new Set([pathKey(edge.points)]);
  for (const endpoint of ['from', 'to'] as const) {
    const node = geometry.nodes.find(n => n.id === edge[endpoint]);
    if (!node) continue;
    const original = edge.points[endpoint === 'from' ? 0 : edge.points.length - 1]!;
    const side = portSide(node, original);
    for (const port of boundaryRayPorts(node).filter(p => portSide(node, p.point) === side)) {
      for (const path of portCandidates(geometry, edge, new Map([[endpoint, port.point]]))) addCandidate(out, seen, path);
    }
  }
  // Most own-text collisions need only a safe port shift. Keep grid search for
  // conflicts which those cheap candidates cannot resolve.
  if (inspectNodeLabelRoutes({ ...geometry, edges: [edge] }).length > 0) {
    const originalCost = score(edge.points, edge, others, geometry.nodes);
    const safe = out.slice(1).map(path => ({ path, cost: score(path, edge, others, geometry.nodes) }))
      .filter(c => c.cost[0] === 0 && c.cost[1] <= originalCost[1] &&
        inspectNodeLabelRoutes({ ...geometry, edges: [{ ...edge, points: c.path }] }).length === 0)
      .sort((a, b) => compare(a.cost, b.cost));
    if (safe.length) return [edge.points, ...safe.slice(0, 3).map(c => c.path)];
  }
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

function shortestPaths(geometry: Geometry, edge: EdgeGeom, others: EdgeGeom[], options: {
  sources?: Port[]; targets?: Port[]; limit?: number; local?: boolean;
} = {}): Pt[][] {
  const from = geometry.nodes.find((n) => n.id === edge.from);
  const to = geometry.nodes.find((n) => n.id === edge.to);
  if (!from || !to || from.id === to.id) return [];
  const labelRects = geometry.nodes.flatMap(n => {
    const label = externalNodeLabel(n);
    return label ? [{ x1: label.box.x - 2, y1: label.box.y - 2, x2: label.box.x + label.box.w + 2, y2: label.box.y + label.box.h + 2 }] : [];
  });
  const rects = [...geometry.nodes.map(expanded), ...labelRects];
  const sources = options.sources ?? boundaryRayPorts(from);
  const targets = options.targets ?? boundaryRayPorts(to);
  const margin = Math.max(80, from.w, from.h, to.w, to.h);
  const bounds = { x1: Math.min(from.x, to.x) - margin, x2: Math.max(from.x + from.w, to.x + to.w) + margin,
    y1: Math.min(from.y, to.y) - margin, y2: Math.max(from.y + from.h, to.y + to.h) + margin };
  const lane = from.lane === to.lane ? geometry.lanes.find((l) => l.id === from.lane) : undefined;
  const inLane = (p: Pt) => !lane || (geometry.orientation === 'vertical'
    ? p.x >= lane.x - EPS && p.x <= lane.x + lane.w + EPS
    : p.y >= lane.y - EPS && p.y <= lane.y + lane.h + EPS);
  const usableSources = sources.filter((p) => inLane(p.stub) && !labelRects.some(r => blocked(p.point, p.stub, r)));
  const usableTargets = targets.filter((p) => inLane(p.stub) && !labelRects.some(r => blocked(p.point, p.stub, r)));
  if (usableSources.length === 0 || usableTargets.length === 0) return [];

  const xs = unique([
    ...rects.flatMap((r) => [r.x1, r.x2]),
    ...usableSources.map((p) => p.stub.x), ...usableTargets.map((p) => p.stub.x),
  ]).filter(x => !options.local || (x >= bounds.x1 && x <= bounds.x2));
  const ys = unique([
    ...rects.flatMap((r) => [r.y1, r.y2]),
    ...usableSources.map((p) => p.stub.y), ...usableTargets.map((p) => p.stub.y),
  ]).filter(y => !options.local || (y >= bounds.y1 && y <= bounds.y2));
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
      if (prev[item.state] === -1 && root[item.state]! >= 0) {
        const source = usableSources[root[item.state]!]!;
        const dx = source.stub.x - source.point.x, dy = source.stub.y - source.point.y;
        if ((points[next.to]!.x - points[v]!.x) * dx + (points[next.to]!.y - points[v]!.y) * dy < -EPS) continue;
      }
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
  const faces = new Set<string>();
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
    const face = `${portSide(from, path[0]!)}:${portSide(to, path.at(-1)!)}`;
    if ((options.limit ?? 1) > 1 && faces.has(face)) continue;
    faces.add(face);
    seen.add(pathId);
    out.push(path);
    if (out.length >= (options.limit ?? 1)) break;
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
  // イベントは円: 中心線から外れたポートは外接矩形の辺ではなく円周に置く(O-2)。
  // 接近区間は辺と同じ向き(水平/垂直)のまま、端点だけ円周へ寄せる
  const r = isEventKind(node.kind) ? node.w / 2 : 0;
  const inset = (off: number) => isGatewayKind(node.kind) ? Math.abs(off)
    : (r > 0 ? r - Math.sqrt(Math.max(0, r * r - off * off)) : 0);
  if (side === 'left') {
    const x = node.x + inset(at - node.cy);
    return { point: { x, y: at }, stub: { x: node.x - PORT_STEM, y: at }, dir: 0 };
  }
  if (side === 'right') {
    const x = node.x + node.w - inset(at - node.cy);
    return { point: { x, y: at }, stub: { x: node.x + node.w + PORT_STEM, y: at }, dir: 0 };
  }
  if (side === 'top') {
    const y = node.y + inset(at - node.cx);
    return { point: { x: at, y }, stub: { x: at, y: node.y - PORT_STEM }, dir: 1 };
  }
  const y = node.y + node.h - inset(at - node.cx);
  return { point: { x: at, y }, stub: { x: at, y: node.y + node.h + PORT_STEM }, dir: 1 };
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
  for (const hit of inspectNodeLabelRoutes({ nodes, edges: eligible })) {
    active.add(hit.edgeId); gridEdges.add(hit.edgeId);
  }
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
    return points ? { ...edge, points, labelPos: edge.labelPos && { ...edge.labelPos }, hops: undefined } : edge;
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
  total[0] += inspectNodeLabelRoutes({ ...geometry, edges }).length;
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
  if (isEventKind(node.kind) || isGatewayKind(node.kind)) {
    // 円周上の点は矩形の辺に乗らないので、中心から見た方角で面を決める
    const dx = p.x - node.cx, dy = p.y - node.cy;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return undefined;
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
  }
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

export function sharedPair(a: EdgeGeom, b: EdgeGeom): number {
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
