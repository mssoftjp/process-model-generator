// P3 後段: 同じ面に集まる線のスロット分離、同一始点の幹線共有、回廊・溝・チャネルのトラック順。

import { isAttachedBoundary, isEventKind, isGatewayKind } from '../bpmn.ts';
import type {
  EdgePlan, GutterSide, PortSide, SymX, SymY,
} from '../types.ts';
import { rowKey } from './context.ts';
import type { Ctx } from './context.ts';
import { nodeCX, nodeCY } from './symbols.ts';
import { isGw } from './predicates.ts';

/** 同じ図形入口へ収束する非シーケンス線を、辺上の短いスロットへ分ける。 */
export function separateSharedEntries(ctx: Ctx, plans: EdgePlan[], poolGapRunTrack: Map<number, number>): void {
  const edgeById = new Map(ctx.g.edges.map((e) => [e.id, e]));
  /**
   * 同じ面から同じ方向へ回廊を渡る通信同士の順序(梯子形の規則): 回廊で自分に近いトラックで
   * 曲がる線ほど進行方向側のスロットに置く。反対にすると、遠いトラックまで降りる線の縦区間を
   * 近いトラックの水平区間が横切って X 字になる。rank 昇順 = 左→右。
   */
  const ladderRank = (plan: EdgePlan, ownId: string, peerCol: number): number => {
    const pt = plan.points.find((q) => q.y.t === 'poolChannel');
    if (!pt || pt.y.t !== 'poolChannel') return 0;
    const t = poolGapRunTrack.get(pt.y.run) ?? 0;
    const ownPool = ctx.pools.indexOfNode(ownId);
    if (ownPool === undefined) return 0;
    const isUpper = ownPool === pt.y.gap;
    const dir = Math.sign(peerCol - (ctx.p.col.get(ownId) ?? 0));
    const closeness = isUpper ? -t : t;
    return dir * closeness;
  };
  const hasCorridorRun = (plan: EdgePlan) => plan.points.some((q) => q.y.t === 'poolChannel');
  type Slot = { plan: EdgePlan; end: 'from' | 'to' };
  const groups = new Map<string, { axis: 'x' | 'y'; nodeId: string; slots: Slot[] }>();
  const add = (nodeId: string, side: PortSide, axis: 'x' | 'y', slot: Slot) => {
    const key = `${nodeId}:${side}`;
    const group = groups.get(key) ?? { axis, nodeId, slots: [] };
    group.slots.push(slot);
    groups.set(key, group);
  };
  for (const plan of plans) {
    const e = edgeById.get(plan.edgeId);
    if (!e) continue;
    const toKind = ctx.nodeById.get(e.to)?.kind;
    if (e.kind !== 'seq') {
      const boxLike = toKind === 'task' || toKind === 'doc' || toKind === 'store' || toKind === 'note';
      if (boxLike && (plan.toSide === 'top' || plan.toSide === 'bottom')) {
        const a = plan.points.at(-2)?.x, b = plan.points.at(-1)?.x;
        if (a?.t === 'nodeCX' && b?.t === 'nodeCX' && a.id === e.to && b.id === e.to) {
          add(e.to, plan.toSide, 'x', { plan, end: 'to' });
        }
      } else if ((toKind === 'doc' || toKind === 'store' || toKind === 'note') && (plan.toSide === 'left' || plan.toSide === 'right')) {
        const b = plan.points.at(-1)?.y;
        if (plan.points.length >= 3 && b?.t === 'portY' && b.id === e.to && b.side === plan.toSide) {
          add(e.to, plan.toSide, 'y', { plan, end: 'to' });
        }
      }
      if (
        ctx.nodeById.get(e.from)?.kind === 'task' &&
        (plan.fromSide === 'bottom' || plan.fromSide === 'top')
      ) {
        const a = plan.points[0]?.x, b = plan.points[1]?.x;
        if (a?.t === 'nodeCX' && b?.t === 'nodeCX' && a.id === e.from && b.id === e.from) {
          add(e.from, plan.fromSide, 'x', { plan, end: 'from' });
        }
      }
    }
    // ゲートウェイの左右はシーケンスだけ(長さ4以上)。メッセージまでずらすと
    // 本流の出と同じ高さへ落ち、O-6 になる。
    // イベントの上下は線種を問わない。プール発の短い落としとシーケンスが
    // 同じ頂点へ重なるのを避ける。左右は従来どおりシーケンスだけ。
    if (toKind && (isGatewayKind(toKind) || isEventKind(toKind))) {
      if (plan.toSide === 'top' || plan.toSide === 'bottom') {
        const a = plan.points.at(-2)?.x, b = plan.points.at(-1)?.x;
        const stub = a?.t === 'nodeCX' && b?.t === 'nodeCX' && a.id === e.to && b.id === e.to;
        const eventFace = isEventKind(toKind);
        if (stub && (eventFace || (e.kind === 'seq' && plan.points.length >= 4))) {
          add(e.to, plan.toSide, 'x', { plan, end: 'to' });
        }
      } else if (e.kind === 'seq' && plan.points.length >= 4 && (plan.toSide === 'left' || plan.toSide === 'right')) {
        add(e.to, plan.toSide, 'y', { plan, end: 'to' });
      }
    }
  }
  for (const { axis, nodeId, slots: group } of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const ea = edgeById.get(a.plan.edgeId)!, eb = edgeById.get(b.plan.edgeId)!;
      const na = ctx.nodeById.get(a.end === 'to' ? ea.from : ea.to);
      const nb = ctx.nodeById.get(b.end === 'to' ? eb.from : eb.to);
      const ca = na ? (axis === 'x' ? ctx.p.col.get(na.id)! : ctx.globalRow.get(rowKey(na.lane, ctx.p.row.get(na.id)!))!) : ea.declIndex;
      const cb = nb ? (axis === 'x' ? ctx.p.col.get(nb.id)! : ctx.globalRow.get(rowKey(nb.lane, ctx.p.row.get(nb.id)!))!) : eb.declIndex;
      // 回廊を渡る線同士は梯子順が相手列順より優先(相手列順だけでは、近いトラックの線が
      // 進行方向と反対側のスロットに置かれて X 字になる)
      if (axis === 'x' && na && nb && hasCorridorRun(a.plan) && hasCorridorRun(b.plan)) {
        const ra = ladderRank(a.plan, nodeId, ca);
        const rb = ladderRank(b.plan, nodeId, cb);
        if (ra !== rb) return ra - rb;
      }
      if (ca !== cb) return ca - cb;
      return ea.declIndex - eb.declIndex;
    });
    const kind = ctx.nodeById.get(nodeId)?.kind;
    const gw = kind !== undefined && isGatewayKind(kind);
    const limit = gw ? 14 : axis === 'x' ? 10 : 8;
    const stepMax = gw ? 24 : 12;
    const step = Math.min(stepMax, (2 * limit) / (group.length - 1));
    group.forEach(({ plan, end }, i) => {
      const offset = (i - (group.length - 1) / 2) * step;
      if (axis === 'x') {
        const a = end === 'to' ? plan.points.length - 2 : 0;
        plan.points[a]!.x = nodeCX(nodeId, offset);
        plan.points[a + 1]!.x = nodeCX(nodeId, offset);
      } else if (end === 'from') {
        const base = plan.points[0]?.y.t === 'nodeCY' ? (plan.points[0].y.offset ?? 0) : 0;
        plan.points[0]!.y = nodeCY(nodeId, base + offset);
        if (plan.points[1]?.y.t === 'nodeCY') plan.points[1].y = nodeCY(nodeId, base + offset);
      } else {
        plan.points.at(-2)!.y = nodeCY(nodeId, offset);
        plan.points.at(-1)!.y = nodeCY(nodeId, offset);
      }
    });
  }
}

/**
 * 同一始点・同種だけ、分かれた口のあとで幹線を共有する。
 * 出所や線種が違う辺は触らない。ゲートウェイの seq はポート文法の木のまま残す。
 */
export function bundleSameOrigin(ctx: Ctx, plans: EdgePlan[]): void {
  const edgeById = new Map(ctx.g.edges.map((e) => [e.id, e]));
  const groups = new Map<string, EdgePlan[]>();
  for (const plan of plans) {
    const e = edgeById.get(plan.edgeId);
    if (!e || e.kind !== 'assoc') continue;
    const src = ctx.nodeById.get(e.from);
    if (!src || isGw(src)) continue;
    const key = `${e.from}|${e.kind}|${plan.fromSide}`;
    const list = groups.get(key) ?? [];
    list.push(plan);
    groups.set(key, list);
  }
  for (const raw of groups.values()) {
    // 2 点の直線(S-55 の同一行関連)は始点だけをずらすと斜線になるので束ねない
    const group = raw.filter((plan) => plan.points.length >= 3);
    if (group.length < 2) continue;
    if (group[0]?.fromSide !== 'right') continue;
    if (!group.every((plan) => ctx.nodeById.get(edgeById.get(plan.edgeId)!.to)?.kind === 'store')) continue;
    group.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
    offsetOriginStubs(group);
    shareOriginTrunk(group);
  }
}

function offsetOriginStubs(group: EdgePlan[]): void {
  if (group[0]?.fromSide !== 'right') return;
  const n = group.length;
  const step = Math.min(12, 16 / (n - 1));
  group.forEach((plan, i) => {
    const offset = (i - (n - 1) / 2) * step;
    const p0 = plan.points[0];
    const p1 = plan.points[1];
    if (!p0 || p0.y.t !== 'nodeCY') return;
    const base = p0.y.offset ?? 0;
    const id = p0.y.id;
    p0.y = nodeCY(id, base + offset);
    if (p1?.y.t === 'nodeCY' && p1.y.id === id) p1.y = nodeCY(id, base + offset);
  });
}

function shareOriginTrunk(group: EdgePlan[]): void {
  const donor = group.find((plan) => plan.points.some((pt) => pt.x.t === 'gutter' || pt.y.t === 'channel'));
  if (!donor) return;
  const donorGutterPoint = donor.points.find((pt) => pt.x.t === 'gutter' && pt.x.side === 'exit');
  const donorGutter = donorGutterPoint?.x.t === 'gutter' ? donorGutterPoint.x : undefined;
  const donorTrunkY = donor.points.find((pt, i) => i >= 2 && (pt.y.t === 'channel' || pt.y.t === 'rowMid'))?.y;
  if (!donorGutter && !donorTrunkY) return;
  const sameY = (a: (typeof donor.points)[number]['y'], b: (typeof donor.points)[number]['y']) =>
    a.t === b.t && JSON.stringify(a) === JSON.stringify(b);
  for (const plan of group) {
    if (plan === donor) continue;
    if (donorGutter) {
      for (const pt of plan.points) {
        if (pt.x.t === 'gutter' && pt.x.side === 'exit' && pt.x.g === donorGutter.g) pt.x = donorGutter;
      }
    }
    if (!donorTrunkY) continue;
    for (let i = 1; i + 1 < plan.points.length; i++) {
      const a = plan.points[i]!;
      const b = plan.points[i + 1]!;
      if (!sameY(a.y, b.y)) continue;
      if (a.y.t !== 'channel' && a.y.t !== 'rowMid') continue;
      a.y = donorTrunkY;
      b.y = donorTrunkY;
      break;
    }
  }
}

/** プール間水平区間は重なる x 区間だけ別トラックにする。 */
export function assignPoolGapTracks(ctx: Ctx) {
  const poolGapTracks = new Map<number, number>();
  const poolGapRunTrack = new Map<number, number>();
  for (const [gap, runs] of ctx.poolGapRuns) {
    type Run = (typeof runs)[number];
    const placed: Array<{ run: Run; t: number }> = [];
    const score = (r: (typeof runs)[number]) => {
      let n = 0;
      for (const other of runs) {
        if (other.runId === r.runId) continue;
        if (r.upperX >= other.a && r.upperX <= other.b) n--;
        if (r.lowerX >= other.a && r.lowerX <= other.b) n++;
      }
      return n;
    };
    // 上端が相手区間内、または相手の下端が自区間内なら、相手(p)は必ず r より上。
    // この関係を DAG として位相順に置く。先に置いた走行しか見ない first-fit では、
    // 後から来た走行を上に置くべき対で順序が破れ、列中心の縦線が帯の中で重なる
    // (Z 形の gapOrderConsistent はこの順序が守られることを前提にしている)。
    const before = (p: Run, r: Run) =>
      p.runId !== r.runId && (
        (p.upperX >= r.a && p.upperX <= r.b) ||
        (r.lowerX >= p.a && r.lowerX <= p.b)
      );
    const preds = new Map<number, Run[]>();
    for (const r of runs) {
      // 相互に before なら順序を決められない(X 字対)。独立として扱う
      preds.set(r.runId, runs.filter((p) => before(p, r) && !before(r, p)));
    }
    const remaining = runs.slice().sort((a, b) => score(a) - score(b) || a.runId - b.runId);
    const done = new Set<number>();
    const place = (r: Run) => {
      let t = Math.max(0, ...(preds.get(r.runId) ?? []).filter((p) => done.has(p.runId)).map((p) => poolGapRunTrack.get(p.runId)! + 1));
      while (placed.some((p) => p.t === t && p.run.a <= r.b && r.a <= p.run.b)) t++;
      placed.push({ run: r, t });
      poolGapRunTrack.set(r.runId, t);
      done.add(r.runId);
      poolGapTracks.set(gap, Math.max(poolGapTracks.get(gap) ?? 0, t + 1));
    };
    while (remaining.length > 0) {
      const i = remaining.findIndex((r) => (preds.get(r.runId) ?? []).every((p) => done.has(p.runId)));
      // 循環(長さ 3 以上)は決定的に先頭を切って置く
      const r = remaining.splice(i >= 0 ? i : 0, 1)[0]!;
      place(r);
    }
  }
  return { poolGapTracks, poolGapRunTrack };
}

/**
 * 列溝の走行の両端に付く水平線(計画済み折れ線から読む)。
 * 縦位置は通し位置 + 行内の細かなずれ(ポートの上下・スタブのオフセット・境界イベントの
 * 辺)を千分の一の桁に足した順位で、同じ行から出る線どうしの上下も比べられる。
 * side は水平線が走行のどちら側(左/右)へ伸びるか。
 */
interface GutterRunEnds {
  lo: number;
  hi: number;
  left: number[];
  right: number[];
}

function gutterRunEnds(ctx: Ctx): Map<number, GutterRunEnds> {
  const rowPosOf = (id: string): number => {
    const n = ctx.nodeById.get(id);
    const host = n && isAttachedBoundary(n) && n.attachedTo ? ctx.nodeById.get(n.attachedTo) ?? n : n;
    if (!host) return 0;
    return ctx.globalRow.get(rowKey(host.lane, ctx.p.row.get(host.id) ?? 0)) ?? 0;
  };
  const rank = (y: SymY): number => {
    switch (y.t) {
      case 'rowMid': return ctx.globalRow.get(rowKey(y.lane, y.row)) ?? 0;
      case 'nodeCY': return rowPosOf(y.id) + (y.offset ?? 0) / 1000;
      case 'portY': {
        const n = ctx.nodeById.get(y.id);
        const edge = n && isAttachedBoundary(n) ? (n.boundarySide === 'top' ? -0.1 : 0.1) : 0;
        const face = y.side === 'top' ? -0.05 : y.side === 'bottom' ? 0.05 : 0;
        return rowPosOf(y.id) + edge + face;
      }
      case 'portStubY': return rowPosOf(y.id) + (y.side === 'top' ? -1 : 1) * (0.05 + y.offset / 1000);
      case 'channel': return ctx.globalChannel.get(rowKey(y.lane, y.row)) ?? 0;
      case 'poolChannel': return ctx.globalPoolGap.get(y.gap) ?? 0;
      case 'laneEdge': return (ctx.globalRow.get(rowKey(y.lane, 0)) ?? 0) + (y.edge === 'top' ? -0.5 : 0.5);
    }
  };
  const colOf = (id: string): number => {
    const n = ctx.nodeById.get(id);
    const host = n && isAttachedBoundary(n) && n.attachedTo ? n.attachedTo : id;
    return ctx.p.col.get(host) ?? 0;
  };
  // 溝 g は列 g の左。列 c は c >= g なら溝の右。同じ溝の出ブロックは入りブロックの左
  const sideOf = (x: SymX, g: number, side: GutterSide): 'left' | 'right' | 'same' => {
    if (x.t === 'gutter') {
      if (x.g !== g) return x.g < g ? 'left' : 'right';
      if (x.side === side) return 'same';
      return x.side === 'exit' ? 'left' : 'right';
    }
    return colOf(x.id) < g ? 'left' : 'right';
  };
  const out = new Map<number, GutterRunEnds>();
  for (const plan of ctx.planned.values()) {
    const pts = plan.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const x0 = pts[i]!.x;
      const x1 = pts[i + 1]!.x;
      if (x0.t !== 'gutter' || x1.t !== 'gutter' || x0.run !== x1.run) continue;
      const y0 = rank(pts[i]!.y);
      const y1 = rank(pts[i + 1]!.y);
      const ends: GutterRunEnds = { lo: Math.min(y0, y1), hi: Math.max(y0, y1), left: [], right: [] };
      const prev = pts[i - 1];
      const next = pts[i + 2];
      if (prev) {
        const s = sideOf(prev.x, x0.g, x0.side);
        if (s !== 'same') ends[s].push(y0);
      }
      if (next) {
        const s = sideOf(next.x, x0.g, x0.side);
        if (s !== 'same') ends[s].push(y1);
      }
      out.set(x0.run, ends);
    }
  }
  return out;
}

/**
 * 列溝トラックの割当。側(出/入り)ごとに、トラック番号が小さいほど左(gutterX)。
 * 走行は両端の水平線を持つ階段なので、走行 P を Q の左に置いたときの交差は
 *   [Q の左へ伸びる水平が P の縦区間の内側] + [P の右へ伸びる水平が Q の縦区間の内側]
 * で数えられる。互い違いの区間(a1 < a2 < b1 < b2 の同方向の 2 本)は、遅く始まる方を
 * 左に置くと交差 0、短い方を左に置くと交差 2 になる(L30)。各走行の得点 = 他の走行と
 * 対にしたときの「左に置いた交差 − 右に置いた交差」の総和とし、得点の低い順に
 * first-fit で置く。同点は短い区間ほど左(局所の縦線をポート際に)、次に runId。
 */
export function assignGutterTracks(ctx: Ctx) {
  const gutterTracks = new Map<number, { exit: number; entry: number }>();
  const gutterRunTrack = new Map<number, number>();
  const ends = gutterRunEnds(ctx);
  const inside = (y: number, r: GutterRunEnds) => y > r.lo && y < r.hi;
  const crossLeftOf = (p: number, q: number): number => {
    const P = ends.get(p);
    const Q = ends.get(q);
    if (!P || !Q) return 0;
    let n = 0;
    for (const y of Q.left) if (inside(y, P)) n++;
    for (const y of P.right) if (inside(y, Q)) n++;
    return n;
  };
  for (const [key, runs] of ctx.gutterRuns) {
    const i = key.lastIndexOf(':');
    const gi = Number(key.slice(0, i));
    const side = key.slice(i + 1) as GutterSide;
    const score = new Map<number, number>();
    for (const r of runs) {
      let s = 0;
      for (const o of runs) {
        if (o.runId === r.runId) continue;
        s += crossLeftOf(r.runId, o.runId) - crossLeftOf(o.runId, r.runId);
      }
      score.set(r.runId, s);
    }
    const sorted = runs.slice().sort((x, y) =>
      score.get(x.runId)! - score.get(y.runId)! || x.b - x.a - (y.b - y.a) || x.runId - y.runId);
    const placed: Array<{ a: number; b: number; t: number }> = [];
    let count = 0;
    for (const r of sorted) {
      let t = 0;
      while (placed.some((p) => p.t === t && p.a <= r.b && r.a <= p.b)) t++;
      placed.push({ a: r.a, b: r.b, t });
      gutterRunTrack.set(r.runId, t);
      count = Math.max(count, t + 1);
    }
    const cur = gutterTracks.get(gi) ?? { exit: 0, entry: 0 };
    cur[side] = Math.max(cur[side], count);
    gutterTracks.set(gi, cur);
  }
  return { gutterTracks, gutterRunTrack };
}

/**
 * チャネル内トラックの入れ子順割当。
 * 各走行の入り口垂直線は「ポート側(上入りなら上、下入りなら下)にある自分より外の
 * トラック」を通ってから自トラックに達する。だから **自分の区間に他の走行の入り口を
 * 含まない走行ほどポート側** に置けば、垂直線が他の走行を横切らない(入れ子)。
 * ソートキーは「区間に含む他走行の入り口数」の昇順。合流(右端共有)では入り口 x 降順、
 * 戻り(左端共有)では昇順にこのキーが自然一致する。
 * 同一溝・同区間のタイは深さで破る(上入りは浅いほど先、下入りは深いほど先。
 * 溝トラックの「短いほどポート寄り」と噛み合う向き)。残る交差はホップが描き分ける。
 */
export function assignChannelTracks(ctx: Ctx) {
  const channelTracks = new Map<string, number>();
  const channelRunTrack = new Map<number, number>();
  for (const [key, runs] of ctx.channelRuns) {
    type Run = (typeof runs)[number];
    const contains = (list: Run[]) => (r: Run) =>
      list.filter((o) => o.runId !== r.runId && o.entryX > r.a && o.entryX < r.b).length;
    const aboveList = runs.filter((r) => r.side === 'above');
    const belowList = runs.filter((r) => r.side === 'below');
    const cAbove = contains(aboveList);
    const cBelow = contains(belowList);
    const above = aboveList
      .sort((x, y) => cAbove(x) - cAbove(y) || x.depth - y.depth || x.runId - y.runId);
    const below = belowList
      .sort((x, y) => cBelow(x) - cBelow(y) || y.depth - x.depth || x.runId - y.runId);
    const firstFit = (list: typeof runs): Map<number, number> => {
      const placed: Array<{ a: number; b: number; t: number }> = [];
      const out = new Map<number, number>();
      for (const r of list) {
        let t = 0;
        while (placed.some((p) => p.t === t && p.a <= r.b && r.a <= p.b)) t++;
        placed.push({ a: r.a, b: r.b, t });
        out.set(r.runId, t);
      }
      return out;
    };
    const aboveT = firstFit(above);
    const belowT = firstFit(below);
    const topCount = Math.max(0, ...[...aboveT.values()].map((t) => t + 1));
    const bottomCount = Math.max(0, ...[...belowT.values()].map((t) => t + 1));
    const total = topCount + bottomCount;
    for (const [runId, t] of aboveT) channelRunTrack.set(runId, t);
    for (const [runId, t] of belowT) channelRunTrack.set(runId, total - 1 - t);
    channelTracks.set(key, total);
  }
  return { channelTracks, channelRunTrack };
}

// ---- 占有・予約の照会 ----
