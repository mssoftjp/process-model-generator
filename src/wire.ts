// P5: 詳細配線。P3 の記号折れ線を P4 の座標で数値化する相。
// 図形種別ごとの解析的な境界クリップも、記号ポートを実座標へ写す処理に含む。
// ここで新しい経路判断はしない(判断が要る設計は P3 の予約漏れ)。
// 例外はホップ(交差の飛び越し)の検出だが、これは幾何を変えない描画糖衣であり、
// BPMN DI のウェイポイントには現れない(C-43)。
//
// 縦図: 記号解決とクリップは論理座標(主軸=x)で行い、最後に転置して実座標へ写す。
// 円・菱形のクリップは軸対称なので論理側で行っても実境界に一致する。
// ラベル位置だけは転置後の実座標で決める(テキストは回転しないため)。

import { isEventKind, isGatewayKind } from './bpmn.ts';
import { EDGE_FONT_SIZE, measureText } from './metrics.ts';
import type { Coords } from './coords.ts';
import type { EdgeGeom, NodeGeom, NormGraph, Orientation, PortSide, Pt, RoutePlan, SymPt } from './types.ts';

export function wire(
  g: NormGraph,
  rp: RoutePlan,
  co: Coords,
  orientation: Orientation = 'horizontal',
  titleShift = 0,
): EdgeGeom[] {
  const vertical = orientation === 'vertical';
  const edgeById = new Map(g.edges.map((e) => [e.id, e]));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  // 同一出口から出るラベル付き辺は縦に積んで重ねない(宣言順)
  const siblingIndex = new Map<string, number>();
  const siblingCount = new Map<string, number>();
  for (const plan of rp.plans) {
    const e = edgeById.get(plan.edgeId)!;
    if (!e.label) continue;
    const key = `${e.from}:${plan.fromSide}`;
    siblingIndex.set(e.id, siblingCount.get(key) ?? 0);
    siblingCount.set(key, (siblingCount.get(key) ?? 0) + 1);
  }
  const out: EdgeGeom[] = [];
  for (const plan of rp.plans) {
    const e = edgeById.get(plan.edgeId)!;
    const resolved = plan.points.map((sp) => resolve(sp, co, rp));
    // オフセット付きの左右ポートは外接矩形ではなく、実際の円・菱形へ着地させる。
    // P3 の直交方向は保ったまま、端点だけを実境界までクリップする。
    if (!e.fromPool && resolved.length > 1) {
      resolved[0] = clipToShape(resolved[0]!, co.nodeGeom.get(e.from)!, plan.fromSide);
    }
    if (!e.toPool && resolved.length > 1) {
      const last = resolved.length - 1;
      resolved[last] = clipToShape(resolved[last]!, co.nodeGeom.get(e.to)!, plan.toSide);
    }
    const logical = simplify(resolved);
    const pts = vertical ? logical.map((p) => ({ x: p.y, y: p.x + titleShift })) : logical;
    out.push({
      id: e.id, kind: e.kind, from: e.from, to: e.to, label: e.label,
      fromPool: e.fromPool, toPool: e.toPool,
      points: pts,
      labelPos: e.label ? labelPos(
        pts, e.label, e.isReturn, siblingIndex.get(e.id) ?? 0,
        isGatewayKind(nodeById.get(e.from)?.kind ?? 'task') && !e.onSpine,
        vertical, e.kind === 'msg',
      ) : undefined,
      onSpine: e.onSpine, isReturn: e.isReturn, provisional: e.provisional,
      mainHint: e.mainHint, returnHint: e.returnHint, isDefault: e.isDefault, isConditional: e.isConditional, assocKind: e.assocKind,
    });
  }
  // ホップは呼び出し側(compile)が全辺の数値化後に computeHops で付ける
  return out;
}

function clipToShape(p: Pt, n: NodeGeom, side: PortSide): Pt {
  const dx = p.x - n.cx;
  const dy = p.y - n.cy;
  if (isEventKind(n.kind)) {
    const rx = n.w / 2;
    const ry = n.h / 2;
    if (side === 'left' || side === 'right') {
      const x = rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry)));
      return { x: n.cx + (side === 'right' ? x : -x), y: p.y };
    }
    const y = ry * Math.sqrt(Math.max(0, 1 - (dx * dx) / (rx * rx)));
    return { x: p.x, y: n.cy + (side === 'bottom' ? y : -y) };
  }
  if (isGatewayKind(n.kind)) {
    const hw = n.w / 2;
    const hh = n.h / 2;
    if (side === 'left' || side === 'right') {
      const x = hw * Math.max(0, 1 - Math.abs(dy) / hh);
      return { x: n.cx + (side === 'right' ? x : -x), y: p.y };
    }
    const y = hh * Math.max(0, 1 - Math.abs(dx) / hw);
    return { x: p.x, y: n.cy + (side === 'bottom' ? y : -y) };
  }
  return p;
}

export { computeHops, simplify as simplifyPoints, segCross as segmentInteriorCrossing };

function resolve(sp: SymPt, co: Coords, rp: RoutePlan): Pt {
  const laneG = (id: string) => co.lanes.find((l) => l.id === id)!;
  let x: number;
  switch (sp.x.t) {
    case 'portX': x = co.portPt(sp.x.id, sp.x.side).x; break;
    case 'gutter': x = co.gutterX(sp.x.g, sp.x.side, rp.gutterRunTrack.get(sp.x.run) ?? 0); break;
    case 'nodeCX': x = co.nodeGeom.get(sp.x.id)!.cx + (sp.x.offset ?? 0); break;
  }
  let y: number;
  switch (sp.y.t) {
    case 'portY': y = co.portPt(sp.y.id, sp.y.side).y; break;
    case 'nodeCY': y = co.nodeGeom.get(sp.y.id)!.cy + (sp.y.offset ?? 0); break;
    case 'portStubY': {
      const py = co.portPt(sp.y.id, sp.y.side).y;
      y = py + (sp.y.side === 'bottom' ? sp.y.offset : -sp.y.offset);
      break;
    }
    case 'channel': y = co.channelY(sp.y.lane, sp.y.row, rp.channelRunTrack.get(sp.y.run) ?? 0); break;
    case 'poolChannel': y = co.poolChannelY(sp.y.gap, rp.poolGapRunTrack.get(sp.y.run) ?? 0); break;
    case 'rowMid': y = co.rowMid.get(`${sp.y.lane}:${sp.y.row}`)!; break;
    case 'laneEdge': {
      const lg = laneG(sp.y.lane);
      y = sp.y.edge === 'top' ? lg.y : lg.y + lg.h;
      break;
    }
  }
  return { x, y };
}

/** 連続重複と一直線上の中間点を除く */
function simplify(pts: Pt[]): Pt[] {
  const dedup: Pt[] = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    dedup.push(p);
  }
  const out: Pt[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const a = out[out.length - 1];
    const b = dedup[i]!;
    const c = dedup[i + 1];
    if (a && c && ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))) continue;
    out.push(b);
  }
  return out;
}

// ---- ホップ(C-43) ----
// 直角交差の各点で、描画線の片方だけが半円で飛び越す。規則:
//   1. 本流は決して飛ばない(直線を守る)。束に本流がいれば反対側の束が飛ぶ
//   2. どちらも本流でない(または両方本流)なら、水平側の束が飛ぶ
//   3. ポート接続点から 12px 以内は接続であり飛ばない。折れ肘は交差
// ホッパー判定は交差点単位。マージンはホッパー自身の区間端にだけ掛ける。

const HOP_MARGIN = 12;
const CROSS_EPS = 4;

type HopHit = { e: EdgeGeom; seg: number; horizontal: boolean; a: Pt; b: Pt; x: number; y: number };

function computeHops(edges: EdgeGeom[]): void {
  const hits: HopHit[] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]!;
      const e2 = edges[j]!;
      for (let s1 = 0; s1 + 1 < e1.points.length; s1++) {
        for (let s2 = 0; s2 + 1 < e2.points.length; s2++) {
          const cross = segCross(e1.points[s1]!, e1.points[s1 + 1]!, e2.points[s2]!, e2.points[s2 + 1]!);
          if (!cross) continue;
          const h1 = Math.abs(e1.points[s1]!.y - e1.points[s1 + 1]!.y) < 0.01;
          hits.push({ e: e1, seg: s1, horizontal: h1, a: e1.points[s1]!, b: e1.points[s1 + 1]!, x: cross.x, y: cross.y });
          hits.push({ e: e2, seg: s2, horizontal: !h1, a: e2.points[s2]!, b: e2.points[s2 + 1]!, x: cross.x, y: cross.y });
        }
      }
    }
  }
  const byPoint = new Map<string, HopHit[]>();
  for (const hit of hits) {
    const key = `${hit.x},${hit.y}`;
    const list = byPoint.get(key) ?? [];
    list.push(hit);
    byPoint.set(key, list);
  }
  for (const group of byPoint.values()) {
    const x = group[0]!.x;
    const y = group[0]!.y;
    const bundles = new Map<string, HopHit[]>();
    for (const hit of group) {
      const bkey = `${hit.horizontal ? 'h' : 'v'}:${hit.horizontal ? hit.a.y : hit.a.x}`;
      const list = bundles.get(bkey) ?? [];
      if (!list.some((h) => h.e === hit.e && h.seg === hit.seg)) list.push(hit);
      bundles.set(bkey, list);
    }
    const all = [...bundles.values()];
    const hasSpine = (b: HopHit[]) => b.some((h) => h.e.onSpine);
    const canHop = (b: HopHit[]) => b.some((h) => !h.e.onSpine && hopEndClear(h, x, y));
    let hoppers: HopHit[][];
    if (all.some(hasSpine)) hoppers = all.filter((b) => !hasSpine(b));
    else {
      const horiz = all.filter((b) => b[0]!.horizontal);
      hoppers = horiz.length > 0 ? horiz : all;
    }
    if (!hoppers.some(canHop)) {
      const other = all.filter((b) => !hoppers.includes(b));
      if (other.some(canHop)) hoppers = other;
      else continue;
    }
    const seen = new Set<string>();
    for (const bundle of hoppers) {
      for (const hit of bundle) {
        if (hit.e.onSpine || !hopEndClear(hit, x, y)) continue;
        const id = `${hit.e.id}:${hit.seg}:${x}:${y}`;
        if (seen.has(id)) continue;
        seen.add(id);
        (hit.e.hops ??= []).push({ seg: hit.seg, x, y });
      }
    }
  }
}

function hopEndClear(hit: HopHit, x: number, y: number): boolean {
  const dist = hit.horizontal
    ? Math.min(Math.abs(x - hit.a.x), Math.abs(x - hit.b.x))
    : Math.min(Math.abs(y - hit.a.y), Math.abs(y - hit.b.y));
  return dist >= HOP_MARGIN;
}

/** 直交 2 区間の内部交差点。端点一致・矢頭タッチ(ε 未満)は接続であり null */
function segCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const aH = Math.abs(a1.y - a2.y) < 0.01;
  const bH = Math.abs(b1.y - b2.y) < 0.01;
  if (aH === bH) return null;
  const [h1, h2, v1, v2] = aH ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
  const x = v1.x;
  const y = h1.y;
  const [hx0, hx1] = h1.x < h2.x ? [h1.x, h2.x] : [h2.x, h1.x];
  const [vy0, vy1] = v1.y < v2.y ? [v1.y, v2.y] : [v2.y, v1.y];
  if (x < hx0 + CROSS_EPS || x > hx1 - CROSS_EPS) return null;
  if (y < vy0 + CROSS_EPS || y > vy1 - CROSS_EPS) return null;
  return { x, y };
}

/**
 * ラベルは出口の近くに置く(人手の習慣: 条件は分岐のそば)。実座標で決める。
 * 横図:
 * - 垂直に出る辺(drop): 線の右脇、出口寄り
 * - 水平に出る辺: 最初の水平区間の上、始点寄り。同一出口の 2 本目以降は下側に積む
 * - 戻り辺: 逆走する長い水平区間(の出発側)に置く
 * 縦図(規則を軸で鏡映しつつ、テキストは水平のまま):
 * - 垂直に出る辺(本流の下降): 線の右脇、出口寄り
 * - ゲートウェイ分岐(横に出る): 最初の固有な横区間の上・中央
 * - 戻り辺: 逆走する長い垂直区間の右脇(出発側)
 */
function labelPos(
  pts: Pt[], label: string, isReturn: boolean, sibling: number, preferBranchSeg: boolean,
  vertical = false, sourceFirst = false,
): Pt {
  const w = measureText(label, EDGE_FONT_SIZE);
  const a = pts[0]!;
  const b = pts[1] ?? a;
  const stack = (base: Pt): Pt =>
    sibling === 0 ? base : { x: base.x, y: base.y + (EDGE_FONT_SIZE + 11) + (sibling - 1) * (EDGE_FONT_SIZE + 5) };
  const isV = (p: Pt, q: Pt) => Math.abs(p.x - q.x) < 0.01;
  const isH = (p: Pt, q: Pt) => Math.abs(p.y - q.y) < 0.01;

  if (vertical) {
    // 出口直後の垂直区間(本流・直進)の右脇
    if (!isReturn && isV(a, b) && Math.abs(b.y - a.y) >= 24) {
      return stack({ x: a.x + 8, y: a.y + (b.y > a.y ? 10 : -10 - EDGE_FONT_SIZE) });
    }
    // ゲートウェイの非本流条件は最初の固有な横区間の上・始点寄り(縦図の分岐は横に出る)
    if (!isReturn && preferBranchSeg) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i]!;
        const q = pts[i + 1]!;
        if (isH(p, q) && Math.abs(q.x - p.x) >= 16) {
          const x = q.x > p.x ? p.x + 6 : p.x - 6 - w;
          return { x, y: p.y - 6 - EDGE_FONT_SIZE };
        }
      }
    }
    // 縦図のプール間通信は横へ出ることがある。後段の縦区間より送信側を優先する。
    if (!isReturn && sourceFirst && isH(a, b) && Math.abs(b.x - a.x) >= w + 12) {
      const x = b.x > a.x ? a.x + 6 : a.x - 6 - w;
      return stack({ x, y: a.y - 6 - EDGE_FONT_SIZE });
    }
    // 長い垂直区間(戻り辺の逆走・プール間縦幹線)の右脇、出発側
    const minDy = isReturn ? 36 : 24;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      if (isV(p, q) && Math.abs(q.y - p.y) >= minDy) {
        return stack({ x: p.x + 8, y: p.y + (q.y > p.y ? 6 : -6 - EDGE_FONT_SIZE) });
      }
    }
    // 横区間(プール間の短い出入りなど)の上
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      if (isH(p, q) && Math.abs(q.x - p.x) >= 16) {
        const x = q.x > p.x ? p.x + 6 : p.x - 6 - w;
        return stack({ x, y: p.y - 6 - EDGE_FONT_SIZE });
      }
    }
    return stack({ x: a.x + 6, y: Math.min(a.y, b.y) - 6 - EDGE_FONT_SIZE });
  }

  if (!isReturn && isV(a, b) && Math.abs(b.y - a.y) >= 24) {
    return stack({ x: a.x + 8, y: a.y + (b.y > a.y ? 10 : -10 - EDGE_FONT_SIZE) });
  }
  // ゲートウェイの非本流条件は、共有された出口スタブではなく最初の固有な縦区間に付ける。
  // yes/no が同じ水平線の上下に並び、どちらの枝か曖昧になるのを防ぐ。
  if (!isReturn && preferBranchSeg) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      if (isV(p, q) && Math.abs(q.y - p.y) >= 16) {
        // 固有区間の始点寄り。主経路のラベルと視覚的に分離する。
        return { x: p.x + 8, y: p.y + Math.sign(q.y - p.y) * 10 - EDGE_FONT_SIZE / 2 };
      }
    }
  }
  const minDx = isReturn ? 36 : 16;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    if (isH(p, q) && Math.abs(q.x - p.x) >= minDx) {
      const x = q.x > p.x ? p.x + 6 : p.x - 6 - w;
      return stack({ x, y: p.y - 6 - EDGE_FONT_SIZE });
    }
  }
  return stack({ x: Math.min(a.x, b.x) + 6, y: a.y - 6 - EDGE_FONT_SIZE });
}
