// P6: 合法性オラクル(C-80)。回帰とファズの検査面。
// 必要条件であって十分条件ではない(C-00)。「読める」はここでは検査しない。
// 検査は実座標に対して行い、向き(orientation)は幾何から受け取る。
// 「主軸=時間 / 交差軸=レーン」で規定される検査(O-5, O-9, O-10)は向きごとに実軸へ写す。
//
//   O-1 全区間が水平または垂直
//   O-2 端点は図形境界上にあり、最終区間は境界に垂直
//   O-3 辺はどのノードの内部も通らない
//   O-4 ノードは所属レーンの帯に内包される
//   O-5 同一レーン辺のウェイポイントはレーン内に閉じる
//   O-6 異なる辺の平行区間は重ならない(同一始点・同一終点の幹線共有のみ許す)
//   O-7 シーケンスはプールを越えない。メッセージはプール間だけ(C-60)
//   O-8 タスクから出るシーケンスと非シーケンスは同じ境界点を共有しない
//   O-9 ゲートウェイの交差軸プラス側の非本流分岐は交差軸プラス側の頂点から出る
//       (横図=下分岐は south / 縦図=右分岐は east)
//   O-10 隣接プール間メッセージの幹線はプール間回廊を通る(横図=水平走行/縦図=垂直走行)
//   O-11 同じノードのメッセージ入口と出口は同一点を共有しない

import { isAttachedBoundary, isEventKind, isGatewayKind } from './bpmn.ts';
import type { Diagnostic, EdgeGeom, Geometry, NodeGeom, NormGraph, Pt } from './types.ts';

const EPS = 0.5;

export function checkOracle(g: NormGraph, geo: Geometry): Diagnostic[] {
  const out: Diagnostic[] = [];
  const vertical = geo.orientation === 'vertical';
  const nodeById = new Map(geo.nodes.map((n) => [n.id, n]));
  const laneById = new Map(geo.lanes.map((l) => [l.id, l]));
  const normNode = new Map(g.nodes.map((n) => [n.id, n]));
  const blackboxLaneByPool = new Map(g.lanes.filter((l) => l.blackbox).map((l) => [l.pool!, l.id]));

  // 黒箱プール帯の縁: 帯の交差軸方向の2辺(横図=上下縁 / 縦図=左右縁)
  const laneEdgeOk = (poolId: string, pt: Pt): boolean => {
    const lane = laneById.get(blackboxLaneByPool.get(poolId) ?? poolId);
    if (!lane) return false;
    return vertical
      ? Math.abs(pt.x - lane.x) < EPS || Math.abs(pt.x - lane.x - lane.w) < EPS
      : Math.abs(pt.y - lane.y) < EPS || Math.abs(pt.y - lane.y - lane.h) < EPS;
  };
  for (const e of geo.edges) {
    // O-1
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) {
        out.push(viol('O-1', `辺 ${e.id} の区間 ${i} が斜め (${fmt(a)} -> ${fmt(b)})`));
      }
    }
    // O-2(プール参照の端点は帯の縁で検査する。C-51)
    if (e.fromPool) {
      if (!laneEdgeOk(e.fromPool, e.points[0]!)) out.push(viol('O-2', `辺 ${e.id} の始点がプール帯 ${e.fromPool} の縁にない`));
    } else {
      checkEndpoint(out, e, e.points[0]!, e.points[1] ?? e.points[0]!, nodeById.get(e.from)!, '始点');
    }
    if (e.toPool) {
      if (!laneEdgeOk(e.toPool, e.points[e.points.length - 1]!)) out.push(viol('O-2', `辺 ${e.id} の終点がプール帯 ${e.toPool} の縁にない`));
    } else {
      checkEndpoint(out, e, e.points[e.points.length - 1]!, e.points[e.points.length - 2] ?? e.points[0]!, nodeById.get(e.to)!, '終点');
    }
    // O-3
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      for (const n of geo.nodes) {
        if (i === 0 && !e.fromPool && n.id === e.from) continue;
        if (i === e.points.length - 2 && !e.toPool && n.id === e.to) continue;
        const fromN = nodeById.get(e.from);
        const toN = nodeById.get(e.to);
        // 境界イベントは対象 Activity の辺に乗る。ホストから出る辺は境界円を横切ることがある。
        if (fromN && isAttachedBoundary(fromN) && n.id === fromN.attachedTo) continue;
        if (toN && isAttachedBoundary(toN) && n.id === toN.attachedTo) continue;
        if (n.kind === 'boundary' && n.attachedTo && (e.from === n.attachedTo || e.to === n.attachedTo)) continue;
        if (segIntersectsRect(a, b, n.x + 2, n.y + 2, n.w - 4, n.h - 4)) {
          out.push(viol('O-3', `辺 ${e.id} の区間 ${i} がノード ${n.id} の内部を通過`));
        }
      }
    }
    // O-5(プール参照辺は対象外)。レーン帯が拘束するのは交差軸のみ
    if (e.fromPool || e.toPool) continue;
    const uLane = normNode.get(e.from)!.lane;
    const vLane = normNode.get(e.to)!.lane;
    if (uLane === vLane) {
      const lane = laneById.get(uLane)!;
      for (const p of e.points) {
        const [lo, hi, v] = vertical ? [lane.x, lane.x + lane.w, p.x] : [lane.y, lane.y + lane.h, p.y];
        if (v < lo - EPS || v > hi + EPS) {
          out.push(viol('O-5', `同一レーン辺 ${e.id} がレーン ${uLane} の帯を出た (${vertical ? 'x' : 'y'}=${v})`));
        }
      }
    }
  }

  // O-7
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const poolGeom = new Map(geo.pools.map((pl) => [pl.id, pl]));
  const poolOfNode = (id: string) => {
    const n = normNode.get(id);
    return n ? poolOfLane.get(n.lane) : id; // プール参照は id 自身がプール
  };
  for (const e of geo.edges) {
    if (e.kind === 'msg' && poolOfNode(e.from) === poolOfNode(e.to)) {
      out.push(viol('O-7', `メッセージ ${e.id} が同一プール内を流れている`));
    }
    if (e.kind === 'seq' && poolOfNode(e.from) !== poolOfNode(e.to)) {
      out.push(viol('O-7', `シーケンス ${e.id} がプールを越えている`));
    }
  }

  // O-10: 長い点線を参加者内部へ押し込まず、参加者間の専用余白で束ねる。
  for (const e of geo.edges) {
    if (e.kind !== 'msg' || e.fromPool || e.toPool) continue;
    const up = poolOfNode(e.from);
    const vp = poolOfNode(e.to);
    const ui = poolIndex.get(up!);
    const vi = poolIndex.get(vp!);
    if (ui === undefined || vi === undefined) continue;
    if (Math.abs(ui - vi) > 1) {
      const lo = Math.min(ui, vi);
      const hi = Math.max(ui, vi);
      for (let pi = lo + 1; pi < hi; pi++) {
        const middle = poolGeom.get(g.pools[pi]!.id)!;
        const crossesInterior = e.points.some((p, i) => {
          const q = e.points[i + 1];
          return !!q && segIntersectsRect(p, q, middle.x, middle.y, middle.w, middle.h);
        });
        if (crossesInterior) {
          out.push(viol('O-10', `非隣接プール間メッセージ ${e.id} が中間プール ${g.pools[pi]!.id} の内部を通過`));
        }
      }
      continue;
    }
    // 論理で前のプール(横図=上/縦図=左)と後のプールの間の回廊に幹線走行があるか
    const firstId = ui < vi ? up! : vp!;
    const secondId = ui < vi ? vp! : up!;
    const first = poolGeom.get(firstId)!;
    const second = poolGeom.get(secondId)!;
    // 同列の一直線(2 点)は幹線を持たず、参加者内部に水平成分も置かない。
    if (e.points.length === 2) continue;
    if (vertical) {
      const x0 = first.x + first.w;
      const x1 = second.x;
      const hasGapRun = e.points.some((p, i) => {
        const q = e.points[i + 1];
        return !!q && Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) > EPS && p.x > x0 + EPS && p.x < x1 - EPS;
      });
      if (!hasGapRun) out.push(viol('O-10', `隣接プール間メッセージ ${e.id} にプール間垂直走行がない`));
    } else {
      const y0 = first.y + first.h;
      const y1 = second.y;
      const hasGapRun = e.points.some((p, i) => {
        const q = e.points[i + 1];
        return !!q && Math.abs(p.y - q.y) < EPS && Math.abs(p.x - q.x) > EPS && p.y > y0 + EPS && p.y < y1 - EPS;
      });
      if (!hasGapRun) out.push(viol('O-10', `隣接プール間メッセージ ${e.id} にプール間水平走行がない`));
    }
  }

  // O-11: 往復通信の送受信を同一点へ重ねると、入口と出口の区別が消える。
  for (const n of geo.nodes) {
    const outgoing = geo.edges.filter((e) => e.kind === 'msg' && !e.fromPool && e.from === n.id);
    const incoming = geo.edges.filter((e) => e.kind === 'msg' && !e.toPool && e.to === n.id);
    for (const outEdge of outgoing) {
      for (const inEdge of incoming) {
        if (samePoint(outEdge.points[0]!, inEdge.points.at(-1)!)) {
          out.push(viol('O-11', `ノード ${n.id} のメッセージ入口 ${inEdge.id} と出口 ${outEdge.id} が同一点を共有`));
        }
      }
    }
  }

  // O-4(帯は完全な矩形になったので両軸で内包を検査する)
  for (const n of geo.nodes) {
    const lane = laneById.get(n.lane)!;
    if (
      n.x < lane.x - EPS || n.x + n.w > lane.x + lane.w + EPS ||
      n.y < lane.y - EPS || n.y + n.h > lane.y + lane.h + EPS
    ) {
      out.push(viol('O-4', `ノード ${n.id} がレーン ${n.lane} の帯からはみ出す`));
    }
  }

  // O-8: タスクの主経路と非シーケンスを同じ出口へ重ねると、二種類の流れを判別できない。
  // 黒箱プール端点・データ関連も対象。同種同士は S-32 の幹線共有としてここでは見ない。
  for (let i = 0; i < geo.edges.length; i++) {
    for (let j = i + 1; j < geo.edges.length; j++) {
      const e1 = geo.edges[i]!;
      const e2 = geo.edges[j]!;
      if (e1.from !== e2.from || normNode.get(e1.from)?.kind !== 'task') continue;
      const mixed = (e1.kind === 'seq') !== (e2.kind === 'seq');
      if (!mixed) continue;
      if (samePoint(e1.points[0]!, e2.points[0]!)) {
        const seq = e1.kind === 'seq' ? e1 : e2;
        const other = e1.kind === 'seq' ? e2 : e1;
        out.push(viol('O-8', `タスク ${e1.from} の同一出口をシーケンス ${seq.id} と ${other.kind} ${other.id} が共有`));
      }
    }
  }

  // O-9: 本流の出口と交差軸プラス側の分岐を分け、yes/no を同じ角から出さない。
  // 横図: 本流 east / 下降分岐 south。縦図: 本流 south / 右方向分岐 east。
  for (const e of geo.edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to || (from.kind !== 'xor' && from.kind !== 'and')) continue;
    if (e.kind !== 'seq' || e.onSpine || e.isReturn) continue;
    if (vertical) {
      if (to.cx <= from.cx) continue;
      if (!samePoint(e.points[0]!, { x: from.x + from.w, y: from.cy })) {
        out.push(viol('O-9', `ゲートウェイ ${from.id} の右方向分岐 ${e.id} が east 頂点から出ていない`));
      }
    } else {
      if (to.cy <= from.cy) continue;
      if (!samePoint(e.points[0]!, { x: from.cx, y: from.y + from.h })) {
        out.push(viol('O-9', `ゲートウェイ ${from.id} の下降分岐 ${e.id} が south 頂点から出ていない`));
      }
    }
  }

  // O-6
  for (let i = 0; i < geo.edges.length; i++) {
    for (let j = i + 1; j < geo.edges.length; j++) {
      const e1 = geo.edges[i]!;
      const e2 = geo.edges[j]!;
      if (e1.from === e2.from || e1.to === e2.to) continue; // 幹線共有・頂点収束は許す
      const seg = findOverlap(e1, e2);
      if (seg) out.push(viol('O-6', `辺 ${e1.id} と ${e2.id} の区間が重なる (${seg})`));
    }
  }

  return out;
}

function viol(code: string, message: string): Diagnostic {
  return { level: 'error', code, message: `[oracle] ${message}` };
}

const fmt = (p: Pt) => `(${Math.round(p.x)},${Math.round(p.y)})`;
const samePoint = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

function checkEndpoint(out: Diagnostic[], e: EdgeGeom, end: Pt, prev: Pt, n: NodeGeom, which: string): void {
  if (isEventKind(n.kind)) {
    const metric = Math.hypot((end.x - n.cx) / (n.w / 2), (end.y - n.cy) / (n.h / 2));
    if (Math.abs(metric - 1) > EPS / Math.min(n.w / 2, n.h / 2)) {
      out.push(viol('O-2', `辺 ${e.id} の${which}が円 ${n.id} の境界上にない ${fmt(end)}`));
      return;
    }
    checkApproach(out, e, end, prev, n, which);
    return;
  }
  if (isGatewayKind(n.kind)) {
    const metric = Math.abs(end.x - n.cx) / (n.w / 2) + Math.abs(end.y - n.cy) / (n.h / 2);
    if (Math.abs(metric - 1) > EPS / Math.min(n.w / 2, n.h / 2)) {
      out.push(viol('O-2', `辺 ${e.id} の${which}が菱形 ${n.id} の境界上にない ${fmt(end)}`));
      return;
    }
    checkApproach(out, e, end, prev, n, which);
    return;
  }
  const onV = (Math.abs(end.x - n.x) < EPS || Math.abs(end.x - n.x - n.w) < EPS) && end.y > n.y - EPS && end.y < n.y + n.h + EPS;
  const onH = (Math.abs(end.y - n.y) < EPS || Math.abs(end.y - n.y - n.h) < EPS) && end.x > n.x - EPS && end.x < n.x + n.w + EPS;
  if (!onV && !onH) {
    out.push(viol('O-2', `辺 ${e.id} の${which}が ${n.id} の境界上にない ${fmt(end)}`));
    return;
  }
  const segH = Math.abs(end.y - prev.y) < EPS;
  if (onV && !segH) out.push(viol('O-2', `辺 ${e.id} の${which}区間が ${n.id} の縦境界に垂直でない`));
  if (onH && !onV && segH) out.push(viol('O-2', `辺 ${e.id} の${which}区間が ${n.id} の横境界に垂直でない`));
}

function checkApproach(out: Diagnostic[], e: EdgeGeom, end: Pt, prev: Pt, n: NodeGeom, which: string): void {
  const segH = Math.abs(end.y - prev.y) < EPS;
  const segV = Math.abs(end.x - prev.x) < EPS;
  if (!segH && !segV) return; // O-1 が斜線として報告する
  if (segH) {
    const side = end.x < n.cx ? -1 : 1;
    if ((prev.x - end.x) * side < -EPS) {
      out.push(viol('O-2', `辺 ${e.id} の${which}区間が ${n.id} の内部側から接続している`));
    }
  } else {
    const side = end.y < n.cy ? -1 : 1;
    if ((prev.y - end.y) * side < -EPS) {
      out.push(viol('O-2', `辺 ${e.id} の${which}区間が ${n.id} の内部側から接続している`));
    }
  }
}

function segIntersectsRect(a: Pt, b: Pt, rx: number, ry: number, rw: number, rh: number): boolean {
  if (rw <= 0 || rh <= 0) return false;
  const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
  const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
  return x0 < rx + rw - EPS && x1 > rx + EPS && y0 < ry + rh - EPS && y1 > ry + EPS;
}

function findOverlap(e1: EdgeGeom, e2: EdgeGeom): string | null {
  for (let i = 0; i + 1 < e1.points.length; i++) {
    for (let j = 0; j + 1 < e2.points.length; j++) {
      const a1 = e1.points[i]!;
      const b1 = e1.points[i + 1]!;
      const a2 = e2.points[j]!;
      const b2 = e2.points[j + 1]!;
      const h1 = Math.abs(a1.y - b1.y) < EPS;
      const h2 = Math.abs(a2.y - b2.y) < EPS;
      if (h1 !== h2) continue;
      if (h1) {
        if (Math.abs(a1.y - a2.y) > 1) continue;
        const [l1, r1] = a1.x < b1.x ? [a1.x, b1.x] : [b1.x, a1.x];
        const [l2, r2] = a2.x < b2.x ? [a2.x, b2.x] : [b2.x, a2.x];
        if (Math.min(r1, r2) - Math.max(l1, l2) > 1) return `y=${Math.round(a1.y)}`;
      } else {
        if (Math.abs(a1.x - a2.x) > 1) continue;
        const [t1, b1y] = a1.y < b1.y ? [a1.y, b1.y] : [b1.y, a1.y];
        const [t2, b2y] = a2.y < b2.y ? [a2.y, b2.y] : [b2.y, a2.y];
        if (Math.min(b1y, b2y) - Math.max(t1, t2) > 1) return `x=${Math.round(a1.x)}`;
      }
    }
  }
  return null;
}
