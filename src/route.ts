// P3: 経路計画。各辺に回廊(行チャネル・列溝)の列とポート辺を割り当てる。
// 座標は使わない。回廊の混雑はここで組合せとして数え、P4 が幅に反映する。
// 環を一方向に伸ばし、戻り辺を明示する。
//
// 経路パターン(距離に依存しない決定的規則):
//   direct           同一行で間にノードが無い: 基線上を直進
//   row-column       行先行 L: 自行の基線を対象列まで直進し、対象列中心を縦走して上/下頂点に入る
//                    (合流ゲートウェイへの行違い入り・文書→工程の関連。予約が成立するときだけ)
//   drop             ゲートウェイの下方向分岐で自列が空いている: 真下へ進み対象行で曲がって左から入る
//   rise             drop の鏡像(上方向分岐、改善候補のみ): 真上へ昇り対象行で曲がって左から入る
//   row-approach     出口右の溝を垂直移動して対象行の基線に乗り、左から入る
//   channel-approach 対象行の上チャネルを経由する完全迂回(常に合法な最終手段)。
//                    対象がゲートウェイなら上頂点に入る
//   return           戻り辺: 外周候補を優先し、不採用時は対象上チャネルを逆走
//
// Port grammar (docs/architecture/style-spec.md, S-5x):
//   本流は右、上側分岐は上、下側分岐は下。入は左を基本とし、空きが静的に
//   証明できる gateway は上下入りも使う。データ関連(S-55)は非 doc へ必ず上入り。
//   同一始点の辺は線分を共有してよい(幹線)。同一終点の収束も許すが、矩形タスクへ入る
//   複数の非シーケンス線は、途中発生に見えないよう辺上の別スロットへ分ける。
//
// 交差の構造的最小化:
//   - チャネル走行は入れ子順(assignChannelTracks)
//   - 列溝の縦走行も側内で入れ子順(assignGutterTracks): 短い区間ほどポート寄り。
//     出スタブが長距離の通過縦線を横切らなくなる
//   - 基線の水平走行は rowRuns に登録する(S-36)。かつては「必ずノードで終わる」両端保護に
//     頼っていたが、列中心で終わる行先行 L を安全に置くため明示予約へ移した。
//     溝で終わる長いスタブは予約しても可読性で劣るため導入しない

import { isAttachedBoundary, isEventKind, isGatewayKind } from './bpmn.ts';
import { crossMinusLabelEvents } from './message-labels.ts';
import { isDocLike } from './types.ts';
import type {
  EdgePlan, GutterSide, NormEdge, NormGraph, NormNode, Placement, PortSide, RoutePlan, SymX, SymY,
} from './types.ts';
import { EDGE_FONT_SIZE, measureText } from './metrics.ts';

interface Ctx {
  g: NormGraph;
  p: Placement;
  nodeById: Map<string, NormNode>;
  occupied: Map<string, string>; // `${lane}:${row}:${col}` -> nodeId
  globalRow: Map<string, number>; // `${lane}:${row}` -> 通し縦位置(行)
  globalChannel: Map<string, number>; // `${lane}:${row}` -> 通し縦位置(行 r の上チャネル)
  globalPoolGap: Map<number, number>; // 上から gap 番目のプール間回廊の通し位置
  laneRows: Map<string, number>;
  gutterRuns: Map<string, Array<{ a: number; b: number; runId: number }>>; // `${g}:${side}` 縦区間
  channelRuns: Map<string, Array<{
    a: number; b: number; side: 'above' | 'below'; depth: number; entryX: number; runId: number;
  }>>;
  poolGapRuns: Map<number, Array<{ a: number; b: number; upperX: number; lowerX: number; runId: number }>>;
  runSeq: { n: number };
  gutterLabelNeed: Map<number, number>;
  // 列中心の縦走行(drop・メッセージの縦出し)。チャネルで終わる縦線は端点ノードの
  // 相互保護が効かないため、明示レジストリで重なりを断つ。
  // 同一始点は幹線共有、同一終点は O-6 と同じ収束共有（タスク入口は後段で分離）。
  // exclusive: 2 点の一直線など、後段のスロット分離を受けない走行。面共有の対象外。
  // gap: プール間回廊で終わる縦走行の回廊区間(列スケール)と、上側/下側の端点 x。
  //      反対側から同じ列に着く走行との重なりは、回廊トラックの入れ子順(assignPoolGapTracks)
  //      が一貫して並べられるときだけ安全なので、その判定に使う。
  colRuns: Map<number, Array<{
    a: number; b: number; from: string; to: string; exclusive?: boolean;
    gap?: { a: number; b: number; upperX: number; lowerX: number; upperSide: boolean };
  }>>;
  // 行基線の水平走行(direct・drop・row/channel-approach の基線区間)。列スケール
  // (列 c = c、溝 g = g - 0.5)。S-36 の「ノードで終わる」相互保護を明示予約に置き換え、
  // 列中心で終わる水平(行先行 L)も同じ規則で安全に扱う。共有規則は colRuns と同じ。
  rowRuns: Map<string, Array<{ a: number; b: number; from: string; to: string }>>;
  labelCrossMinus: ReadonlySet<string>; // ラベルを交差軸マイナス側へ逃がしたイベント(P1 と同じ集合)
  planned: Map<string, EdgePlan>; // 宣言順で先に計画した辺(入口面の静的参照に使う)
  optimizeReadability: boolean;
  poolExteriorGutter?: number;
  gapDestFlip: ReadonlySet<string>;
}

export interface RouteOptions {
  /** Cycle C: 隣接プール間メッセージの対象側溝を反対面へ。辺 ID の集合。 */
  gapDestFlip?: ReadonlySet<string>;
}

export function route(
  g: NormGraph, p: Placement, optimizeReadability = false, options?: RouteOptions,
): RoutePlan {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const occupied = new Map<string, string>();
  for (const n of g.nodes) {
    if (isAttachedBoundary(n)) continue; // 対象 Activity がセルを占有する
    occupied.set(`${n.lane}:${p.row.get(n.id)}:${p.col.get(n.id)}`, n.id);
  }
  const globalRow = new Map<string, number>();
  const globalChannel = new Map<string, number>();
  const globalPoolGap = new Map<number, number>();
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  let pos = 0;
  let prevPool: string | undefined | null = null;
  for (const lane of g.lanes) {
    if (prevPool !== null && lane.pool !== prevPool) {
      const pi = poolIndex.get(prevPool!);
      if (pi !== undefined) globalPoolGap.set(pi, pos++);
    }
    prevPool = lane.pool;
    const rows = p.laneRows.get(lane.id) ?? 1;
    for (let r = 0; r < rows; r++) {
      globalChannel.set(`${lane.id}:${r}`, pos++);
      globalRow.set(`${lane.id}:${r}`, pos++);
    }
    if (optimizeReadability) globalChannel.set(`${lane.id}:${rows}`, pos++);
  }
  const ctx: Ctx = {
    g, p, nodeById, occupied, globalRow, globalChannel, globalPoolGap, laneRows: p.laneRows,
    gutterRuns: new Map(), channelRuns: new Map(), runSeq: { n: 0 }, gutterLabelNeed: new Map(),
    poolGapRuns: new Map(),
    colRuns: new Map(),
    rowRuns: new Map(),
    labelCrossMinus: crossMinusLabelEvents(g),
    planned: new Map(),
    optimizeReadability,
    gapDestFlip: options?.gapDestFlip ?? new Set(),
  };

  const plans: EdgePlan[] = [];
  for (const e of g.edges.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    const plan = e.fromPool || e.toPool
      ? planPoolMsg(ctx, e)
      : e.isReturn ? planReturn(ctx, e) : planForward(ctx, e);
    plans.push(plan);
    ctx.planned.set(e.id, plan);
  }
  separateSharedEntries(ctx, plans);
  bundleSameOrigin(ctx, plans);

  const { gutterTracks, gutterRunTrack } = assignGutterTracks(ctx);
  const { channelTracks, channelRunTrack } = assignChannelTracks(ctx);
  const { poolGapTracks, poolGapRunTrack } = assignPoolGapTracks(ctx);
  return {
    plans, gutterTracks, channelTracks, channelRunTrack, gutterRunTrack,
    poolGapTracks, poolGapRunTrack, gutterLabelNeed: ctx.gutterLabelNeed,
    poolExteriorGutter: ctx.poolExteriorGutter,
  };
}

/** 同じ図形入口へ収束する非シーケンス線を、辺上の短いスロットへ分ける。 */
function separateSharedEntries(ctx: Ctx, plans: EdgePlan[]): void {
  const edgeById = new Map(ctx.g.edges.map((e) => [e.id, e]));
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
      return ca - cb || ea.declIndex - eb.declIndex;
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
function bundleSameOrigin(ctx: Ctx, plans: EdgePlan[]): void {
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
  for (const group of groups.values()) {
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
function assignPoolGapTracks(ctx: Ctx) {
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
    for (const r of runs.slice().sort((a, b) => score(a) - score(b) || a.runId - b.runId)) {
      // 上端が相手区間内、または相手の下端が自区間内なら、相手を必ず上へ置く。
      const before = (p: Run) =>
        (p.upperX >= r.a && p.upperX <= r.b) ||
        (r.lowerX >= p.a && r.lowerX <= p.b);
      let t = Math.max(0, ...placed.filter((p) => before(p.run)).map((p) => p.t + 1));
      while (placed.some((p) => p.t === t && p.run.a <= r.b && r.a <= p.run.b)) t++;
      placed.push({ run: r, t });
      poolGapRunTrack.set(r.runId, t);
      poolGapTracks.set(gap, Math.max(poolGapTracks.get(gap) ?? 0, t + 1));
    }
  }
  return { poolGapTracks, poolGapRunTrack };
}

/**
 * 列溝トラックの入れ子順割当。側(出/入り)ごとに「短い区間ほどポート寄り」。
 * 出ブロックは左からポート寄り、入りブロックは右からポート寄り。
 * 短い(局所の)縦線がポート際に来るので、出スタブが長距離の通過縦線を横切らない。
 */
function assignGutterTracks(ctx: Ctx) {
  const gutterTracks = new Map<number, { exit: number; entry: number }>();
  const gutterRunTrack = new Map<number, number>();
  for (const [key, runs] of ctx.gutterRuns) {
    const i = key.lastIndexOf(':');
    const gi = Number(key.slice(0, i));
    const side = key.slice(i + 1) as GutterSide;
    const sorted = runs.slice().sort((x, y) => x.b - x.a - (y.b - y.a) || x.runId - y.runId);
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
function assignChannelTracks(ctx: Ctx) {
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

const rowKey = (lane: string, row: number) => `${lane}:${row}`;

function nodeBetweenOnRow(ctx: Ctx, lane: string, row: number, c0: number, c1: number): boolean {
  for (let c = c0; c <= c1; c++) if (ctx.occupied.has(`${lane}:${row}:${c}`)) return true;
  return false;
}

/** 列 col の中心 +28px のレールを a..b の間で通れるか: 途中のセルが空か幅の狭い doc だけ */
function railClear(ctx: Ctx, col: number, a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const [key, gr] of ctx.globalRow) {
    if (gr <= lo || gr >= hi) continue;
    const i = key.lastIndexOf(':');
    const occ = ctx.occupied.get(`${key.slice(0, i)}:${key.slice(i + 1)}:${col}`);
    if (occ !== undefined && ctx.nodeById.get(occ)?.kind !== 'doc') return false;
  }
  return true;
}

/** 列 col の中心線を、通し縦位置 a..b の間(両端は含まない)で垂直に通れるか */
function columnClear(ctx: Ctx, col: number, a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const [key, gr] of ctx.globalRow) {
    if (gr <= lo || gr >= hi) continue;
    const i = key.lastIndexOf(':');
    if (ctx.occupied.has(`${key.slice(0, i)}:${key.slice(i + 1)}:${col}`)) return false;
  }
  return true;
}

function colRunEnd(e: NormEdge, side: 'from' | 'to'): string {
  if (side === 'from') return e.fromPool ? `#pool:${e.fromPool}` : e.from;
  return e.toPool ? `#pool:${e.toPool}` : e.to;
}

/**
 * 列中心の縦走行の予約。ノード占有(columnClear)に加えて、
 * 既予約の縦走行との重なりを検査する。
 * 同一始点は幹線、同一終点は収束として共有可(O-6 / S-32)。
 * 成立すれば予約して true、だめなら呼び出し側は溝経由へフォールバック。
 */
function reserveColRun(
  ctx: Ctx, col: number, a: number, b: number, e: NormEdge, from = colRunEnd(e, 'from'),
  shareFace?: string,
): boolean {
  const to = colRunEnd(e, 'to');
  if (!canReserveColRun(ctx, col, a, b, from, to, shareFace)) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runs = ctx.colRuns.get(col) ?? [];
  runs.push({ a: lo, b: hi, from, to });
  ctx.colRuns.set(col, runs);
  return true;
}

/**
 * shareFace: このノードの上下面に着く/発つ走行とは重なってよい。後段の
 * separateSharedEntries が同じ面の非 seq 線をスロットへ分けるので、実座標では
 * 平行線として離れる(往復メッセージ対の型)。タスクとイベントだけに使う。
 */
function canReserveColRun(
  ctx: Ctx, col: number, a: number, b: number, from: string, to: string, shareFace?: string,
): boolean {
  if (!columnClear(ctx, col, a, b)) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return !(ctx.colRuns.get(col) ?? []).some(
    (r) =>
      r.from !== from && r.to !== to && r.a < hi && lo < r.b &&
      !(shareFace !== undefined && !r.exclusive && (r.from === shareFace || r.to === shareFace)),
  );
}

/** 直前に予約した列走行を排他にする(2 点の一直線はスロット分離されないため面共有できない)。 */
function markExclusiveColRun(ctx: Ctx, col: number): void {
  const runs = ctx.colRuns.get(col);
  const last = runs?.at(-1);
  if (last) last.exclusive = true;
}

/** 行基線の水平区間を予約できるか(列スケール。同一始点・同一終点は共有可)。 */
function canReserveRowRun(
  ctx: Ctx, lane: string, row: number, a: number, b: number, from: string, to: string,
): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return !(ctx.rowRuns.get(rowKey(lane, row)) ?? []).some(
    (r) => r.from !== from && r.to !== to && r.a < hi && lo < r.b,
  );
}

/** 行基線の水平区間を登録する。検査済み・または構築上安全な区間に使う。 */
function noteRowRun(ctx: Ctx, lane: string, row: number, a: number, b: number, e: NormEdge): void {
  const key = rowKey(lane, row);
  const runs = ctx.rowRuns.get(key) ?? [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  runs.push({ a: lo, b: hi, from: colRunEnd(e, 'from'), to: colRunEnd(e, 'to') });
  ctx.rowRuns.set(key, runs);
}

function reserveRowRun(ctx: Ctx, lane: string, row: number, a: number, b: number, e: NormEdge): boolean {
  if (!canReserveRowRun(ctx, lane, row, a, b, colRunEnd(e, 'from'), colRunEnd(e, 'to'))) return false;
  noteRowRun(ctx, lane, row, a, b, e);
  return true;
}

/** 溝 g の列スケール位置 */
const gutterScale = (g: number) => g - 0.5;

// ---- 走行の登録 ----

function allocGutter(ctx: Ctx, gi: number, side: GutterSide, a: number, b: number): number {
  const key = `${gi}:${side}`;
  const runs = ctx.gutterRuns.get(key) ?? [];
  ctx.gutterRuns.set(key, runs);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runId = ctx.runSeq.n++;
  runs.push({ a: lo, b: hi, runId });
  return runId;
}

/**
 * チャネル走行の登録。cA/cB は列スケール(溝 g は g - 0.5)。
 * side = 入り口の垂直線がチャネルの上から来るか下から来るか。
 * depth = 入り口の縦位置(通しスケール)。入れ子順の主キー。
 */
function allocChannel(
  ctx: Ctx, lane: string, row: number, cA: number, cB: number,
  side: 'above' | 'below', depth: number, entryX: number,
): number {
  const key = rowKey(lane, row);
  const runs = ctx.channelRuns.get(key) ?? [];
  ctx.channelRuns.set(key, runs);
  const [lo, hi] = cA < cB ? [cA, cB] : [cB, cA];
  const runId = ctx.runSeq.n++;
  runs.push({ a: lo, b: hi, side, depth, entryX, runId });
  return runId;
}

function allocPoolGap(ctx: Ctx, gap: number, upperX: number, lowerX: number): number {
  const runs = ctx.poolGapRuns.get(gap) ?? [];
  ctx.poolGapRuns.set(gap, runs);
  const [a, b] = upperX < lowerX ? [upperX, lowerX] : [lowerX, upperX];
  const runId = ctx.runSeq.n++;
  runs.push({ a, b, upperX, lowerX, runId });
  return runId;
}

// ---- 記号座標のヘルパ ----

const portX = (id: string, side: PortSide): SymX => ({ t: 'portX', id, side });
const portY = (id: string, side: PortSide): SymY => ({ t: 'portY', id, side });
const portStubY = (id: string, side: 'top' | 'bottom', offset = 16): SymY => ({ t: 'portStubY', id, side, offset });
const gutterX = (gi: number, side: GutterSide, run: number): SymX => ({ t: 'gutter', g: gi, side, run });
const nodeCX = (id: string, offset = 0): SymX => ({ t: 'nodeCX', id, offset });
const nodeCY = (id: string, offset = 0): SymY => ({ t: 'nodeCY', id, offset });
const channelY = (lane: string, row: number, run: number): SymY => ({ t: 'channel', lane, row, run });
const poolChannelY = (gap: number, run: number): SymY => ({ t: 'poolChannel', gap, run });
const rowMidY = (lane: string, row: number): SymY => ({ t: 'rowMid', lane, row });

interface Cell {
  lane: string;
  row: number;
  col: number;
  node: NormNode;
}

function cellOf(ctx: Ctx, id: string): Cell {
  const n = ctx.nodeById.get(id)!;
  return { lane: n.lane, row: ctx.p.row.get(id)!, col: ctx.p.col.get(id)!, node: n };
}

const isGw = (n: NormNode) => isGatewayKind(n.kind);
const hasSequenceOut = (ctx: Ctx, id: string) =>
  ctx.g.edges.some((e) => e.from === id && e.kind === 'seq');
const needsBottomMessagePort = (ctx: Ctx, id: string) =>
  hasSequenceOut(ctx, id) && ctx.g.edges.some((e) => e.from === id && e.kind === 'msg' && !e.toPool);
const blackboxLane = (ctx: Ctx, pool: string) =>
  ctx.g.lanes.find((lane) => lane.pool === pool && lane.blackbox)?.id;

/** 下ポートを使ってよいか: 下置きラベルのあるイベント類は不可(ラベル動線と衝突。C-65) */
const bottomFree = (n: NormNode) =>
  !(isEventKind(n.kind) && n.label !== '');

/** 交差軸プラス側のプールから着くメッセージは、ラベルを反対側へ逃すので下ポートが空く。 */
function poolMessageFacesBottom(ctx: Ctx, nodeId: string): boolean {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const node = ctx.nodeById.get(nodeId);
  if (!node) return false;
  const ni = poolIndex.get(lanePool.get(node.lane)!);
  if (ni === undefined) return false;
  return ctx.g.edges.some((e) => {
    if (e.kind !== 'msg' || e.to !== nodeId || !e.fromPool) return false;
    const fi = poolIndex.get(e.fromPool);
    return fi !== undefined && fi > ni;
  });
}

/** P1 と同じ規則(message-labels.ts)でラベルが交差軸マイナス側へ逃げたイベントか。下ポートが空く。 */
function eventLabelMovedUp(ctx: Ctx, nodeId: string): boolean {
  return ctx.labelCrossMinus.has(nodeId);
}

function eventHasBottomOut(ctx: Ctx, id: string): boolean {
  return ctx.g.edges.some((e) =>
    e.from === id && (e.kind === 'assoc' || (e.kind === 'msg' && !e.toPool)));
}

function eventBottomOpen(ctx: Ctx, n: NormNode): boolean {
  if (eventHasBottomOut(ctx, n.id)) return false;
  return bottomFree(n) || poolMessageFacesBottom(ctx, n.id);
}

/**
 * u の上ポートが入りとして使われないことが静的に分かるか(S-56。メッセージの top 出し用)。
 * 上を使う入り = 戻り辺・非シーケンス辺・プール発・(ゲートウェイなら行違いのシーケンス)。
 */
function topFree(ctx: Ctx, u: Cell): boolean {
  for (const e2 of ctx.g.edges) {
    if (e2.to !== u.node.id) continue;
    if (e2.isReturn || e2.kind !== 'seq' || e2.fromPool) return false;
    if (isGw(u.node)) {
      const s = ctx.nodeById.get(e2.from);
      if (!s) return false;
      if (s.lane !== u.lane || ctx.p.row.get(s.id) !== u.row) return false;
    }
  }
  return true;
}

/**
 * 列 col の回廊帯に反対側から着く既存走行と、入れ子順(assignPoolGapTracks の before 関係)が
 * 矛盾なく並ぶか。上側から着く走行 P と下側から着く走行 Q が同じ x を端点に持つとき、
 * P は必ず Q の上に置かれる(P.upperX が Q の区間内)。逆向きの関係も成立すると順序が循環し、
 * 帯の中で縦線が重なり得る(fuzz seed 72 の X 字対)。
 */
function gapOrderConsistent(
  ctx: Ctx, col: number, mine: { a: number; b: number; upperX: number; lowerX: number; upperSide: boolean },
): boolean {
  for (const r of ctx.colRuns.get(col) ?? []) {
    if (!r.gap || r.gap.upperSide === mine.upperSide) continue;
    const P = mine.upperSide ? mine : r.gap;
    const Q = mine.upperSide ? r.gap : mine;
    const reverse = (Q.upperX >= P.a && Q.upperX <= P.b) || (P.lowerX >= Q.a && P.lowerX <= Q.b);
    if (reverse) return false;
  }
  return true;
}

/** ゲートウェイ v の西頂点が空いているか: 同一行からの seq 入りが無く、行違いの seq 入りが e だけ。 */
function westFree(ctx: Ctx, v: Cell, e: NormEdge): boolean {
  let crossRow = 0;
  for (const o of ctx.g.edges) {
    if (o.to !== v.node.id || o.kind !== 'seq' || o.isReturn || o.fromPool) continue;
    if (sameRowSource(ctx, o, v)) return false;
    crossRow++;
  }
  return crossRow === 1 && ctx.g.edges.some((o) => o.id === e.id && o.kind === 'seq');
}

/** ノードの上下面を使い得る他の辺(非 seq の出入り・戻り・プール発)が無いか。 */
function faceQuiet(ctx: Ctx, nodeId: string, e: NormEdge): boolean {
  return !ctx.g.edges.some((o) =>
    o.id !== e.id && (
      (o.to === nodeId && (o.kind !== 'seq' || o.isReturn || !!o.fromPool)) ||
      (o.from === nodeId && o.kind !== 'seq')
    ));
}

/** u の上面を使う入りが全て非 seq(スロット分離の対象)か。戻り seq や行違いゲートウェイ入りがあれば false。 */
function topUsersSlottable(ctx: Ctx, u: Cell): boolean {
  for (const e2 of ctx.g.edges) {
    if (e2.to !== u.node.id) continue;
    if (e2.kind === 'seq' && (e2.isReturn || (isGw(u.node) && !sameRowSource(ctx, e2, u)))) return false;
  }
  return true;
}

function sameRowSource(ctx: Ctx, e2: NormEdge, u: Cell): boolean {
  const s = ctx.nodeById.get(e2.from);
  return !!s && s.lane === u.lane && ctx.p.row.get(s.id) === u.row;
}

function noteLabelNeed(ctx: Ctx, e: NormEdge, gi: number): void {
  if (!e.label) return;
  const w = measureText(e.label, EDGE_FONT_SIZE) + 12;
  ctx.gutterLabelNeed.set(gi, Math.max(ctx.gutterLabelNeed.get(gi) ?? 0, w));
}

// ---- 前向き辺 ----

function planForward(ctx: Ctx, e: NormEdge): EdgePlan {
  const u = cellOf(ctx, e.from);
  const v = cellOf(ctx, e.to);
  const sameRow = u.lane === v.lane && u.row === v.row;
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row))!;
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  const rowFree = !nodeBetweenOnRow(ctx, v.lane, v.row, u.col + 1, v.col - 1);
  // row-approach は出発列のセルも空である必要がある(そのセルの出スタブと基線上で衝突するため)
  const rowFreeWide = rowFree && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`);

  if (e.kind === 'assoc') {
    // 同列の直落とし(帳票フローの型): 書類は工程の真下に落ち、真下の工程に真上から読まれる
    if (u.col === v.col && gV > gU && reserveColRun(ctx, u.col, gU, gV, e)) {
      markExclusiveColRun(ctx, u.col);
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'drop',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.to), y: portY(e.to, 'top') },
        ],
      };
    }
    // 直下の文書を上の工程が読む: top → bottom の一直線(帳票フローの型の鏡像)。
    // 2 点形はスロット分離を受けないので、工程の下面に他の非 seq の出入りが無いときだけ。
    if (
      u.col === v.col && gV < gU && isDocLike(u.node.kind) && !isDocLike(v.node.kind) &&
      faceQuiet(ctx, v.node.id, e) && bottomOutFree(ctx, v, gV) &&
      (bottomFree(v.node) || eventBottomOpen(ctx, v.node)) &&
      // 文書の上辺は行違いの書き手(drop / チャネル降下)が使い得る。計画済みなら入口面で判定し、
      // 未計画なら同一行の書き手(左入り)だけを許す
      !ctx.g.edges.some((o) => {
        if (o.id === e.id || o.kind !== 'assoc' || o.to !== u.node.id) return false;
        const done = ctx.planned.get(o.id);
        if (done) return done.toSide === 'top';
        const w = ctx.nodeById.get(o.from);
        return !w || w.lane !== u.lane || ctx.p.row.get(w.id) !== u.row;
      }) &&
      reserveColRun(ctx, u.col, gV, gU, e)
    ) {
      markExclusiveColRun(ctx, u.col);
      return {
        edgeId: e.id, fromSide: 'top', toSide: 'bottom', pattern: 'drop',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'top') },
          { x: nodeCX(e.to), y: portY(e.to, 'bottom') },
        ],
      };
    }
    // 文書類以外に入る辺は必ず上頂点へ(左ポートはシーケンス入りの領分。S-51)
    if (!isDocLike(v.node.kind)) {
      return planRowThenColumn(ctx, e, u, v, gU, gV) ?? planIntoTop(ctx, e, u, v, gU);
    }
    // 文書類へ落とす辺: 生産タスクの真下方向にあれば drop(下ポートは出専用)。
    // 別列は、同じノードに他の関連があるときだけ(下辺の入出力スロット)。
    // シーケンスと共存する単独の右出関連は cy+10 のまま残す。
    const otherAssoc = ctx.g.edges.some((o) =>
      o.kind === 'assoc' && o.id !== e.id && o.to === e.from
    );
    if (
      gV > gU &&
      (u.col === v.col || otherAssoc) &&
      !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
      rowFree &&
      reserveColRun(ctx, u.col, gU, gV, e)
    ) {
      noteRowRun(ctx, v.lane, v.row, u.col, v.col, e);
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'left', pattern: 'drop',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.from), y: rowMidY(v.lane, v.row) },
          { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
        ],
      };
    }
    // 同じ列の遠い書類は中心線が手前の書類で塞がる。次列の XOR 溝ではなく、
    // 書き手の直後を通って右から入れる。長いスタブの競合は OARSP が実座標で解く。
    // レールは列中心 +28px を予約なしで縦走するので、途中のセルが幅の狭い文書だけで、
    // 書き手がタスク(下面のスロット分離を受ける)であり、下面に他の入りが無いときに限る。
    if (
      v.node.kind === 'doc' && u.col === v.col && gV > gU && u.node.kind === 'task' &&
      railClear(ctx, u.col, gU, gV) &&
      !ctx.g.edges.some((o) => o.id !== e.id && o.to === u.node.id && o.kind !== 'seq')
    ) {
      const rail = nodeCX(e.from, 28);
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'right', pattern: 'row-approach',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.from), y: portStubY(e.from, 'bottom') },
          { x: rail, y: portStubY(e.from, 'bottom') },
          { x: rail, y: portY(e.to, 'right') },
          { x: portX(e.to, 'right'), y: portY(e.to, 'right') },
        ],
      };
    }
    // 前の列の共著者: 時間軸を先に進めてから書類へ。隣接列の4点溝は奪わない。
    const coWriterHere = ctx.g.edges.some((other) =>
      other.kind === 'assoc' && other.to === e.to && other.from !== e.from &&
      ctx.p.col.get(other.from) === v.col
    );
    const adjacentPeer = ctx.occupied.get(`${v.lane}:${v.row}:${u.col}`);
    const adjacentFour =
      v.col === u.col + 1 && adjacentPeer !== undefined &&
      ctx.g.edges.some((other) => other.from === adjacentPeer && other.to === e.to);
    if (
      v.node.kind === 'doc' && gV > gU && u.lane === v.lane &&
      u.col < v.col && v.col - u.col <= 2 && coWriterHere && !adjacentFour
    ) {
      // 対象より少し後の時間を通る。縦図では書類の上ではなく下を横切り、XOR 列までは落とさない。
      const rail = nodeCX(e.to, 48);
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'right', pattern: 'row-approach',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.from), y: portStubY(e.from, 'bottom') },
          { x: rail, y: portStubY(e.from, 'bottom') },
          { x: rail, y: portY(e.to, 'right') },
          { x: portX(e.to, 'right'), y: portY(e.to, 'right') },
        ],
      };
    }
    // 行違いの文書類へは、専用形が無ければ行先行 L で上/下辺から入る(S-55 の西入りは同一行の形)。
    if (!sameRow) {
      const l = planRowThenColumn(ctx, e, u, v, gU, gV);
      if (l) return l;
    }
  }

  if (e.kind === 'msg') {
    const poolPair = poolPairIndices(ctx, u, v);
    if (poolPair && Math.abs(poolPair[0] - poolPair[1]) > 1) {
      return planAcrossPoolExterior(ctx, e, u, v, poolPair[0], poolPair[1]);
    }
    const poolGap = adjacentPoolGap(ctx, u, v);
    if (poolGap !== undefined) return planAcrossPoolGap(ctx, e, u, v, poolGap);
    // メッセージ: 種類の異なる出は出口を分ける。
    // シーケンスは右から出るので、メッセージは縦(bottom/top)から出す — 右出しに重ねると
    // ノードが分岐しているように見える(ユーザー指摘)。
    // 下向き: bottom から出て対象行の上チャネルへ降り、対象の上頂点に入る。
    //   同列で列が空いていれば bottom→top の一直線(手描きの型)。
    // 上向き: 上ポートが入りとして使われないことが静的に分かるノード(topFree)なら
    //   top から出す(S-56 条件付きポート開放)。
    // どちらも成立しないときだけ右出し(planIntoTop)に落ちる。
    // 下ラベル付きイベントの bottom はラベル動線と衝突するため使わない(C-65)
    const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
    if (gV > gU && bottomFree(u.node)) {
      if (u.col === v.col && reserveColRun(ctx, u.col, gU, gV, e)) {
        markExclusiveColRun(ctx, u.col);
        return {
          edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'drop',
          points: [
            { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
            { x: nodeCX(e.to), y: portY(e.to, 'top') },
          ],
        };
      }
      // 終端チャネルの直下のセルにノードがいると、そのノードへの最終降下と同じ x で
      // 重なる(チャネル帯の中は離散区間で見えない)。空のときだけ縦出しする
      if (
        !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
        reserveColRun(ctx, u.col, gU, chV, e)
      ) {
        const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'above', gU, u.col);
        return {
          edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'channel-approach',
          points: [
            { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
            { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh) },
            { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
            { x: nodeCX(e.to), y: portY(e.to, 'top') },
          ],
        };
      }
      if (hasSequenceOut(ctx, e.from)) return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
    }
    if (gV < gU && topFree(ctx, u)) {
      if (
        !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
        !(v.row > 0 && ctx.occupied.has(`${v.lane}:${v.row - 1}:${u.col}`)) &&
        reserveColRun(ctx, u.col, chV, gU, e)
      ) {
        const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'below', gU, u.col);
        return {
          edgeId: e.id, fromSide: 'top', toSide: 'top', pattern: 'channel-approach',
          points: [
            { x: nodeCX(e.from), y: portY(e.from, 'top') },
            { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh) },
            { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
            { x: nodeCX(e.to), y: portY(e.to, 'top') },
          ],
        };
      }
      const detour = planMessageFromTopViaGutter(ctx, e, u, v, gU, chV);
      if (detour) return detour;
    }
    // top が入りに使われていても bottom が空いていれば、短い下向きスタブから
    // 溝へ出す。右ポートへ戻してシーケンスと幹線を共有させない。
    if (bottomFree(u.node) && hasSequenceOut(ctx, e.from)) {
      return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
    }
    return planIntoTop(ctx, e, u, v, gU);
  }

  // direct: 同一行・間にノード無し
  if (sameRow && rowFree && e.kind === 'seq') {
    noteLabelNeed(ctx, e, u.col + 1);
    noteRowRun(ctx, u.lane, u.row, u.col, v.col, e);
    // Boundary Event は P4 で対象 Activity の論理 bottom へ重ねるため、セル基線から
    // 実ポートが移動する。2点の direct は移動後に斜線になるので、終点 x で曲げる。
    const points = isAttachedBoundary(u.node)
      ? [
          { x: portX(e.from, 'right'), y: portY(e.from, 'right') },
          { x: portX(e.to, 'left'), y: portY(e.from, 'right') },
          { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
        ]
      : [
          { x: portX(e.from, 'right'), y: portY(e.from, 'right') },
          { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
        ];
    return {
      edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'direct',
      points,
    };
  }
  if (sameRow && rowFree && e.kind === 'assoc') {
    // 同一行のデータ関連は基線から10px上へ分離する。工程のシーケンス出入口と
    // 同一点・同一スタブを共有させない。doc の左辺は関連専用。
    noteLabelNeed(ctx, e, u.col + 1);
    return {
      edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'direct',
      points: [
        { x: portX(e.from, 'right'), y: nodeCY(e.from, -10) },
        { x: portX(e.to, 'left'), y: nodeCY(e.to, -10) },
      ],
    };
  }

  // 改善候補では、同一行の途中ノードを飛び越す非本流を下側へ置く。
  // 図全体の合法性と可読性スコアが改善したときだけ compile.ts が採用する。
  if (
    ctx.optimizeReadability && e.kind === 'seq' && isGw(u.node) && !e.onSpine &&
    sameRow && v.col > u.col && !rowFree
  ) {
    const useBelow = alternativeBelow(ctx, u);
    const channelRow = useBelow ? u.row + 1 : u.row;
    const channelPos = ctx.globalChannel.get(rowKey(u.lane, channelRow));
    const sourceFree = useBelow ? true : topFree(ctx, u);
    const targetFree = useBelow
      ? bottomFree(v.node) && noDownwardOut(ctx, v, gV) && !needsBottomMessagePort(ctx, v.node.id)
      : true;
    if (
      channelPos !== undefined && sourceFree && targetFree &&
      reserveColRun(ctx, u.col, gU, channelPos, e) &&
      reserveColRun(ctx, v.col, gV, channelPos, e)
    ) {
      const side: PortSide = useBelow ? 'bottom' : 'top';
      const tCh = allocChannel(
        ctx, u.lane, channelRow, u.col, v.col, useBelow ? 'above' : 'below', gU, u.col,
      );
      return {
        edgeId: e.id, fromSide: side, toSide: side, pattern: 'channel-approach',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, side) },
          { x: nodeCX(e.from), y: channelY(u.lane, channelRow, tCh) },
          { x: nodeCX(e.to), y: channelY(u.lane, channelRow, tCh) },
          { x: nodeCX(e.to), y: portY(e.to, side) },
        ],
      };
    }
  }

  // rise: drop の鏡像。上側の非本流分岐で自列が対象行まで空いていれば、north から
  // 自列中心を昇り、対象行で曲がって左から入る(1 折れ)。
  if (
    ctx.optimizeReadability && isGw(u.node) && !e.onSpine && gV < gU && !isGw(v.node) &&
    topFree(ctx, u) && rowFree && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
    canReserveRowRun(ctx, v.lane, v.row, u.col, v.col, e.from, e.to) &&
    reserveColRun(ctx, u.col, gV, gU, e)
  ) {
    noteRowRun(ctx, v.lane, v.row, u.col, v.col, e);
    return {
      edgeId: e.id, fromSide: 'top', toSide: 'left', pattern: 'rise',
      points: [
        { x: nodeCX(e.from), y: portY(e.from, 'top') },
        { x: nodeCX(e.from), y: rowMidY(v.lane, v.row) },
        { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
      ],
    };
  }

  // 上側の非本流分岐は north から出す（main の east と共有しない）
  if (
    ctx.optimizeReadability && isGw(u.node) && !e.onSpine && gV < gU &&
    topFree(ctx, u) && rowFreeWide
  ) {
    const chU = ctx.globalChannel.get(rowKey(u.lane, u.row))!;
    if (
      canReserveRowRun(ctx, v.lane, v.row, gutterScale(u.col + 1), v.col, e.from, e.to) &&
      reserveColRun(ctx, u.col, chU, gU, e)
    ) {
      const g1 = u.col + 1;
      noteLabelNeed(ctx, e, g1);
      noteRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e);
      const tSrc = allocChannel(ctx, u.lane, u.row, u.col, g1 - 0.5, 'below', gU, u.col);
      const r1 = allocGutter(ctx, g1, 'exit', chU, gV);
      return {
        edgeId: e.id, fromSide: 'top', toSide: 'left', pattern: 'row-approach',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'top') },
          { x: nodeCX(e.from), y: channelY(u.lane, u.row, tSrc) },
          { x: gutterX(g1, 'exit', r1), y: channelY(u.lane, u.row, tSrc) },
          { x: gutterX(g1, 'exit', r1), y: rowMidY(v.lane, v.row) },
          { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
        ],
      };
    }
  }

  // drop: ゲートウェイの下方向分岐で、自列の中心線を対象行まで直進できる場合
  if (isGw(u.node) && !e.onSpine && gV > gU) {
    if (
      !isGw(v.node) &&
      !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
      rowFree &&
      reserveColRun(ctx, u.col, gU, gV, e)
    ) {
      noteRowRun(ctx, v.lane, v.row, u.col, v.col, e);
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'left', pattern: 'drop',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.from), y: rowMidY(v.lane, v.row) },
          { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
        ],
      };
    }
    // 非本流の下降分岐は、直落としできなくても south から出す。
    // east へ戻すと本流条件と同じ頂点を共有してしまう。
    const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
    // msg 縦出しと同じガード: 自列中心を対象行上チャネルまで降りて横走する中間形。
    if (
      !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
      reserveColRun(ctx, u.col, gU, chV, e)
    ) {
      const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'above', gU, u.col);
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'channel-approach',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh) },
          { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
          { x: nodeCX(e.to), y: portY(e.to, 'top') },
        ],
      };
    }
    return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
  }

  // 行違いでゲートウェイに入る辺は頂点入り(channel-approach 系)に限定する。
  // 交差軸プラス側からイベントへ着くシーケンスも同じ。上へ回ると図形の裏側へ出る。
  if (!sameRow && isGw(v.node)) {
    const l = planRowThenColumn(ctx, e, u, v, gU, gV);
    if (l) return l;
    // 同一行の前任者が無く、行違いの入りがこの 1 本だけなら西頂点は空いている:
    // 通常の左入り(row-approach / channel-approach)に任せ、上頂点へ回り込まない。
    if (!westFree(ctx, v, e)) return planIntoTop(ctx, e, u, v, gU);
  }
  if (!sameRow && isEventKind(v.node.kind) && gU > gV && eventBottomOpen(ctx, v.node)) {
    return planRowThenColumn(ctx, e, u, v, gU, gV) ?? planIntoTop(ctx, e, u, v, gU);
  }

  const g1 = u.col + 1; // 出口すぐ右の溝
  noteLabelNeed(ctx, e, g1);
  const srcY = fallbackRightY(e, e.from);

  // row-approach: 溝を垂直移動して対象行の基線に乗る。
  // 時間を戻るストア関連は基線に乗せない。他所出のシーケンス列を貫いて途中出現に見える。
  if (
    rowFreeWide && !sameRow && !(e.kind === 'assoc' && u.col > v.col && v.node.kind === 'store') &&
    (e.kind !== 'seq' || canReserveRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e.from, e.to)) &&
    canReserveRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e.from, e.to)
  ) {
    if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
    noteRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e);
    const run = allocGutter(ctx, g1, 'exit', gU, gV);
    return {
      edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'row-approach',
      points: [
        { x: portX(e.from, 'right'), y: srcY },
        { x: gutterX(g1, 'exit', run), y: srcY },
        { x: gutterX(g1, 'exit', run), y: rowMidY(v.lane, v.row) },
        { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
      ],
    };
  }

  // 隣接列で同じ終点へ収束する辺は、出口溝と入口溝を一度だけ使う。
  const adjacentPeer = ctx.occupied.get(`${v.lane}:${v.row}:${u.col}`);
  if (
    e.kind === 'assoc' && !isDocLike(u.node.kind) && v.node.kind === 'doc' &&
    u.lane === v.lane && !sameRow && v.col === g1 && adjacentPeer !== undefined &&
    ctx.g.edges.some((other) => other.from === adjacentPeer && other.to === e.to)
  ) {
    noteRowRun(ctx, v.lane, v.row, gutterScale(v.col), v.col, e);
    const run = allocGutter(ctx, v.col, 'entry', gU, gV);
    return {
      edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'row-approach',
      points: [
        { x: portX(e.from, 'right'), y: srcY },
        { x: gutterX(v.col, 'entry', run), y: srcY },
        { x: gutterX(v.col, 'entry', run), y: rowMidY(v.lane, v.row) },
        { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
      ],
    };
  }

  // channel-approach: 対象行の上チャネル経由で、対象列すぐ左の溝から基線に降りる(常に合法)
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  const r1 = allocGutter(ctx, g1, 'exit', gU, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, g1 - 0.5, v.col - 0.5, gU < chPos ? 'above' : 'below', gU, g1 - 0.5);
  const gv = v.col; // 対象列のすぐ左の溝
  const r2 = allocGutter(ctx, gv, 'entry', chPos, gV);
  if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  noteRowRun(ctx, v.lane, v.row, gutterScale(gv), v.col, e);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'channel-approach',
    points: [
      { x: portX(e.from, 'right'), y: srcY },
      { x: gutterX(g1, 'exit', r1), y: srcY },
      { x: gutterX(g1, 'exit', r1), y: channelY(v.lane, v.row, tCh) },
      { x: gutterX(gv, 'entry', r2), y: channelY(v.lane, v.row, tCh) },
      { x: gutterX(gv, 'entry', r2), y: rowMidY(v.lane, v.row) },
      { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
    ],
  };
}

/**
 * 溝へ向かう右出の y。seq は基線(S-40)。非 seq はシーケンス出の有無を問わず
 * 基線を使わない(S-36): 溝で終わる水平を行中心に載せると、同じ行の
 * ノード終端アプローチと O-6 で重なる。+側はラベル帯(上)の反対。
 * -10 は S-55 同一行 assoc 専用で、ここには出さない。
 */
function fallbackRightY(e: NormEdge, fromId: string): SymY {
  if (e.kind === 'seq') return portY(fromId, 'right');
  return nodeCY(fromId, e.kind === 'msg' ? 8 : 10);
}

function adjacentPoolGap(ctx: Ctx, u: Cell, v: Cell): number | undefined {
  const pair = poolPairIndices(ctx, u, v);
  if (!pair) return undefined;
  const [ui, vi] = pair;
  return Math.abs(ui - vi) === 1 ? Math.min(ui, vi) : undefined;
}

function poolPairIndices(ctx: Ctx, u: Cell, v: Cell): [number, number] | undefined {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ui = poolIndex.get(lanePool.get(u.lane)!);
  const vi = poolIndex.get(lanePool.get(v.lane)!);
  return ui !== undefined && vi !== undefined ? [ui, vi] : undefined;
}

/** 通信が多い側と反対の外周へ、同一行の迂回分岐を置く。 */
function alternativeBelow(ctx: Ctx, u: Cell): boolean {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ownPool = lanePool.get(u.lane);
  const ownIndex = ownPool === undefined ? undefined : poolIndex.get(ownPool);
  if (ownIndex === undefined) return true;
  const nodePool = (id: string) => {
    const n = ctx.nodeById.get(id);
    return n ? lanePool.get(n.lane) : undefined;
  };
  let above = 0;
  let below = 0;
  for (const e of ctx.g.edges) {
    if (e.kind !== 'msg') continue;
    const fromPool = e.fromPool ?? nodePool(e.from);
    const toPool = e.toPool ?? nodePool(e.to);
    if (fromPool !== ownPool && toPool !== ownPool) continue;
    const other = fromPool === ownPool ? toPool : fromPool;
    const oi = other === undefined ? undefined : poolIndex.get(other);
    if (oi === undefined) continue;
    if (oi < ownIndex) above++;
    if (oi > ownIndex) below++;
  }
  return above >= below;
}

/**
 * 隣接プール間メッセージ: 列溝に面した左右辺の専用点を、プール間水平回廊で結ぶ。
 * 参加者内部の行チャネルを横幹線にせず、境界直後の無意味な小折れも作らない。
 */
function planAcrossPoolGap(ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gap: number): EdgePlan {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ui = poolIndex.get(lanePool.get(u.lane)!)!;
  const down = ui === gap;
  const gapPos = ctx.globalPoolGap.get(gap)!;
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row))!;
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  const z = planAcrossPoolGapZ(ctx, e, u, v, gap, gapPos, gU, gV, down);
  if (z) return z;
  // 列溝に面した左右辺から直接出入りする。上下ポート直後の小さなコの字は
  // BPMN上の意味を持たず、視覚ノイズになるため作らない。
  const rightward = v.col > u.col;
  const sameCol = v.col === u.col;
  const fromSide: PortSide = sameCol ? 'right' : rightward ? 'left' : 'right';
  let toSide: PortSide = sameCol ? 'left' : rightward ? 'left' : 'right';
  // 両端だけを直近の列溝へ逃がし、長い水平成分はプール間回廊に閉じる。
  // 中心列直結は後続辺との重なりを局所判定できないため採用しない。
  const srcG = rightward ? u.col : u.col + 1;
  let dstG = rightward || sameCol ? v.col : v.col + 1;
  // Cycle C: 対象の反対面。左方向到着が対象の右溝を貫いて本流水平と交差するのを避ける。
  if (ctx.gapDestFlip.has(e.id)) {
    toSide = toSide === 'left' ? 'right' : 'left';
    dstG = toSide === 'left' ? v.col : v.col + 1;
  }
  const srcYOffset = down ? 8 : -8;
  const dstMagnitude = toSide === 'left' ? 12 : 14;
  const dstYOffset = down ? -dstMagnitude : dstMagnitude;
  const srcRun = allocGutter(ctx, srcG, 'exit', gU, gapPos);
  const dstRun = allocGutter(ctx, dstG, 'entry', gapPos, gV);
  const srcScale = srcG - 0.5;
  const dstScale = dstG - 0.5;
  const run = allocPoolGap(ctx, gap, down ? srcScale : dstScale, down ? dstScale : srcScale);
  return {
    edgeId: e.id, fromSide, toSide, pattern: 'channel-approach',
    points: [
      { x: portX(e.from, fromSide), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, 'exit', srcRun), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, 'exit', srcRun), y: poolChannelY(gap, run) },
      { x: gutterX(dstG, 'entry', dstRun), y: poolChannelY(gap, run) },
      { x: gutterX(dstG, 'entry', dstRun), y: nodeCY(e.to, dstYOffset) },
      { x: portX(e.to, toSide), y: nodeCY(e.to, dstYOffset) },
    ],
  };
}

/**
 * 隣接プール間メッセージの Z 形: 送信側の列中心をプール間回廊まで縦走し、回廊を横走して
 * 受信側の列中心へ縦に入る(BPMN の慣習どおり、通信は参加者間を縦に渡る)。
 * 同列なら一直線。列中心の縦走は colRuns(S-58)、回廊は poolGap トラックで予約する。
 * 成立しなければ従来の側面ポート経路(4 折れ)へ落ちる。
 */
function planAcrossPoolGapZ(
  ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gap: number, gapPos: number, gU: number, gV: number,
  down: boolean,
): EdgePlan | undefined {
  if (isAttachedBoundary(u.node) || isAttachedBoundary(v.node)) return undefined;
  const otherMsg = (id: string) =>
    ctx.g.edges.some((o) => o.id !== e.id && o.kind === 'msg' && (o.from === id || o.to === id));
  // ゲートウェイの上下頂点は後段でスロット分離されない。他の通信があれば側面経路に任せる
  if ((isGw(u.node) && otherMsg(u.node.id)) || (isGw(v.node) && otherMsg(v.node.id))) return undefined;
  const bottomLabelFree = (n: NormNode) => bottomFree(n) || eventLabelMovedUp(ctx, n.id);
  // タスクとイベントの上下面は separateSharedEntries がスロットへ分けるので、
  // 同じ面に着く他の通信(往復対)と列を共有できる。ゲートウェイは分けられない。
  // イベントは入口だけがスロット分離され出口は分けられないため、タスクに限る
  const slotted = (n: NormNode) => n.kind === 'task';
  const fromSide: PortSide = down ? 'bottom' : 'top';
  const toSide: PortSide = down ? 'top' : 'bottom';
  if (down) {
    if (!bottomLabelFree(u.node)) return undefined;
    if (isGw(u.node) && !bottomOutFree(ctx, u, gU)) return undefined;
    if (eventLabelMovedUp(ctx, v.node.id)) return undefined; // 上辺にラベル
  } else {
    // 上面を使う入りが全て非 seq(スロット分離される)なら、タスク/イベントは top から出せる
    if (!topFree(ctx, u) && !(slotted(u.node) && topUsersSlottable(ctx, u))) return undefined;
    if (isEventKind(u.node.kind) && eventLabelMovedUp(ctx, u.node.id)) return undefined;
    if (!bottomLabelFree(v.node)) return undefined;
    if (v.node.kind !== 'task' && eventHasBottomOut(ctx, v.node.id) && !isEventKind(v.node.kind)) return undefined;
    if (isGw(v.node) && !bottomOutFree(ctx, v, gV)) return undefined;
  }
  // 同列の一直線(2 点)はスロット分離の対象にならないので、面共有なしで列を占有できるときだけ。
  // さらに、チャネルから頂点へ降りる終端(planIntoTop 系)は列予約を持たないため、
  // 両端の面に他の非 seq の出入りが一切ないことを静的に要求する。
  const straight = u.col === v.col;
  if (straight && !(faceQuiet(ctx, u.node.id, e) && faceQuiet(ctx, v.node.id, e))) return undefined;
  const shareU = !straight && slotted(u.node) ? u.node.id : undefined;
  const shareV = !straight && slotted(v.node) ? v.node.id : undefined;
  // 回廊は帯であり離散位置 gapPos では厚みが見えない。反対側から同じ列に着く走行とは、
  // 回廊トラックの入れ子順が両者を矛盾なく並べられるときだけ帯の中で離れる。
  const gapRun = {
    a: Math.min(u.col, v.col), b: Math.max(u.col, v.col),
    upperX: down ? u.col : v.col, lowerX: down ? v.col : u.col,
  };
  if (!straight) {
    if (!gapOrderConsistent(ctx, u.col, { ...gapRun, upperSide: down })) return undefined;
    if (!gapOrderConsistent(ctx, v.col, { ...gapRun, upperSide: !down })) return undefined;
  }
  if (!canReserveColRun(ctx, u.col, gU, gapPos, e.from, e.to, shareU)) return undefined;
  if (!canReserveColRun(ctx, v.col, gapPos, gV, e.from, e.to, shareV)) return undefined;
  reserveColRun(ctx, u.col, gU, gapPos, e, e.from, shareU);
  if (straight) markExclusiveColRun(ctx, u.col);
  else ctx.colRuns.get(u.col)!.at(-1)!.gap = { ...gapRun, upperSide: down };
  reserveColRun(ctx, v.col, gapPos, gV, e, e.from, shareV);
  if (straight) markExclusiveColRun(ctx, v.col);
  else ctx.colRuns.get(v.col)!.at(-1)!.gap = { ...gapRun, upperSide: !down };
  if (straight) {
    return {
      edgeId: e.id, fromSide, toSide, pattern: 'drop',
      points: [
        { x: nodeCX(e.from), y: portY(e.from, fromSide) },
        { x: nodeCX(e.to), y: portY(e.to, toSide) },
      ],
    };
  }
  const run = allocPoolGap(ctx, gap, down ? u.col : v.col, down ? v.col : u.col);
  return {
    edgeId: e.id, fromSide, toSide, pattern: 'channel-approach',
    points: [
      { x: nodeCX(e.from), y: portY(e.from, fromSide) },
      { x: nodeCX(e.from), y: poolChannelY(gap, run) },
      { x: nodeCX(e.to), y: poolChannelY(gap, run) },
      { x: nodeCX(e.to), y: portY(e.to, toSide) },
    ],
  };
}

/**
 * 非隣接プール間メッセージ: 両端に最も近いプール間回廊から右外周へ出し、
 * 中間プールの枠外を縦走する。中間参加者の内部を通信線で貫かない(C-40)。
 */
function planAcrossPoolExterior(
  ctx: Ctx, e: NormEdge, u: Cell, v: Cell, ui: number, vi: number,
): EdgePlan {
  const down = ui < vi;
  const srcGap = down ? ui : ui - 1;
  const dstGap = down ? vi - 1 : vi;
  const srcGapPos = ctx.globalPoolGap.get(srcGap)!;
  const dstGapPos = ctx.globalPoolGap.get(dstGap)!;
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row))!;
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  const srcG = u.col + 1;
  const dstG = v.col + 1;
  // 通常ルータが使う最終溝(maxCol + 1)を奪わず、その外側に専用溝を足す。
  const outerG = ctx.p.maxCol + 2;
  ctx.poolExteriorGutter = outerG;

  const srcRun = allocGutter(ctx, srcG, 'exit', gU, srcGapPos);
  const dstRun = allocGutter(ctx, dstG, 'entry', dstGapPos, gV);
  const outerRun = allocGutter(ctx, outerG, 'exit', srcGapPos, dstGapPos);
  const srcPoolRun = allocPoolGap(ctx, srcGap, srcG - 0.5, outerG + 0.5);
  const dstPoolRun = allocPoolGap(ctx, dstGap, outerG + 0.5, dstG - 0.5);
  const srcYOffset = down ? 8 : -8;
  const dstYOffset = down ? -14 : 14;

  return {
    edgeId: e.id, fromSide: 'right', toSide: 'right', pattern: 'channel-approach',
    points: [
      { x: portX(e.from, 'right'), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, 'exit', srcRun), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, 'exit', srcRun), y: poolChannelY(srcGap, srcPoolRun) },
      { x: gutterX(outerG, 'exit', outerRun), y: poolChannelY(srcGap, srcPoolRun) },
      { x: gutterX(outerG, 'exit', outerRun), y: poolChannelY(dstGap, dstPoolRun) },
      { x: gutterX(dstG, 'entry', dstRun), y: poolChannelY(dstGap, dstPoolRun) },
      { x: gutterX(dstG, 'entry', dstRun), y: nodeCY(e.to, dstYOffset) },
      { x: portX(e.to, 'right'), y: nodeCY(e.to, dstYOffset) },
    ],
  };
}

/**
 * bottom から短い専用スタブで右溝へ出し、対象行チャネルから target top へ入る。
 * 中心列が塞がっていても異種フローの右ポート共有へフォールバックしない。
 */
function planFromBottomViaGutter(
  ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gU: number, chV: number,
): EdgePlan {
  const g1 = u.col + 1;
  noteLabelNeed(ctx, e, g1);
  const rGutter = allocGutter(ctx, g1, 'exit', gU, chV);
  const tDst = allocChannel(
    ctx, v.lane, v.row, g1 - 0.5, v.col,
    gU < chV ? 'above' : 'below', gU, g1 - 0.5,
  );
  return {
    edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'channel-approach',
    points: [
      { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
      { x: nodeCX(e.from), y: portStubY(e.from, 'bottom') },
      { x: gutterX(g1, 'exit', rGutter), y: portStubY(e.from, 'bottom') },
      { x: gutterX(g1, 'exit', rGutter), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: portY(e.to, 'top') },
    ],
  };
}

/**
 * 上向きメッセージの中心列が塞がれている場合も、シーケンスと右ポートを共有させない。
 * top から自レーンの上チャネルへ抜け、右溝を上って対象の上頂点へ入る。
 */
function planMessageFromTopViaGutter(
  ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gU: number, chV: number,
): EdgePlan | undefined {
  const chU = ctx.globalChannel.get(rowKey(u.lane, u.row));
  if (chU === undefined || !reserveColRun(ctx, u.col, chU, gU, e)) return undefined;
  const g1 = u.col + 1;
  noteLabelNeed(ctx, e, g1);
  const tSrc = allocChannel(ctx, u.lane, u.row, u.col, g1 - 0.5, 'below', gU, u.col);
  const rGutter = allocGutter(ctx, g1, 'exit', chU, chV);
  const tDst = allocChannel(
    ctx, v.lane, v.row, g1 - 0.5, v.col,
    chU < chV ? 'above' : 'below', chU, g1 - 0.5,
  );
  return {
    edgeId: e.id, fromSide: 'top', toSide: 'top', pattern: 'channel-approach',
    points: [
      { x: nodeCX(e.from), y: portY(e.from, 'top') },
      { x: nodeCX(e.from), y: channelY(u.lane, u.row, tSrc) },
      { x: gutterX(g1, 'exit', rGutter), y: channelY(u.lane, u.row, tSrc) },
      { x: gutterX(g1, 'exit', rGutter), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: portY(e.to, 'top') },
    ],
  };
}

/**
 * 頂点(上または下)への入り。行違いのゲートウェイ入りと、データ関連の非 doc 入りが使う。
 *
 * 接続位置も交差最小化の自由度にする:
 * 下から来る辺は、対象の下頂点が構造的に空いているとき(下向きの出が一つも無く、
 * 対象行の直下にチャネルがあるとき)、上まで回り込まず下頂点に直接入る。
 * フックの昇り越えが消え、壁越えの交差が減る。判定は静的(辺集合と配置のみ)なので
 * 出入り専用ポートの衝突排除(S-54)は保たれる。
 */
function planIntoTop(ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gU: number): EdgePlan {
  const vRowPos = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  const fromBelow = gU > vRowPos;
  const chBelowKey = rowKey(v.lane, v.row + 1);
  const canEnterBottom =
    fromBelow && ctx.globalChannel.has(chBelowKey) && bottomOutFree(ctx, v, vRowPos) &&
    !ctx.occupied.has(`${v.lane}:${v.row + 1}:${v.col}`) &&
    (bottomFree(v.node) || eventBottomOpen(ctx, v.node)) &&
    !needsBottomMessagePort(ctx, v.node.id);
  const farTargetGutter =
    ctx.optimizeReadability && fromBelow && !canEnterBottom && u.lane === v.lane && u.col < v.col &&
    !nodeBetweenOnRow(ctx, u.lane, u.row, u.col + 1, v.col);
  const g1 = farTargetGutter ? v.col + 1 : u.col + 1;
  noteLabelNeed(ctx, e, g1);
  if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  // 真下のセルが埋まっていると、そのノードへの上頂点降りと同じ x で重なるため不可
  if (canEnterBottom) {
    const chB = ctx.globalChannel.get(chBelowKey)!;
    const r1 = allocGutter(ctx, g1, farTargetGutter ? 'entry' : 'exit', gU, chB);
    const tCh = allocChannel(ctx, v.lane, v.row + 1, g1 - 0.5, v.col, 'below', gU, g1 - 0.5);
    const srcY = fallbackRightY(e, e.from);
    return {
      edgeId: e.id, fromSide: 'right', toSide: 'bottom', pattern: 'channel-approach',
      points: [
        { x: portX(e.from, 'right'), y: srcY },
        { x: gutterX(g1, farTargetGutter ? 'entry' : 'exit', r1), y: srcY },
        { x: gutterX(g1, farTargetGutter ? 'entry' : 'exit', r1), y: channelY(v.lane, v.row + 1, tCh) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row + 1, tCh) },
        { x: nodeCX(e.to), y: portY(e.to, 'bottom') },
      ],
    };
  }
  if (fromBelow && isEventKind(v.node.kind) && eventBottomOpen(ctx, v.node) && !needsBottomMessagePort(ctx, v.node.id)) {
    const side: GutterSide = farTargetGutter ? 'entry' : 'exit';
    const run = allocGutter(ctx, g1, side, gU, vRowPos);
    const srcY = fallbackRightY(e, e.from);
    return {
      edgeId: e.id, fromSide: 'right', toSide: 'bottom', pattern: 'channel-approach',
      points: [
        { x: portX(e.from, 'right'), y: srcY },
        { x: gutterX(g1, side, run), y: srcY },
        { x: gutterX(g1, side, run), y: portStubY(e.to, 'bottom') },
        { x: nodeCX(e.to), y: portStubY(e.to, 'bottom') },
        { x: nodeCX(e.to), y: portY(e.to, 'bottom') },
      ],
    };
  }
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  const gutterSide: GutterSide = farTargetGutter ? 'entry' : 'exit';
  const r1 = allocGutter(ctx, g1, gutterSide, gU, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, g1 - 0.5, v.col, gU < chPos ? 'above' : 'below', gU, g1 - 0.5);
  const srcY = fallbackRightY(e, e.from);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'top', pattern: 'channel-approach',
    points: [
      { x: portX(e.from, 'right'), y: srcY },
      { x: gutterX(g1, gutterSide, r1), y: srcY },
      { x: gutterX(g1, gutterSide, r1), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: portY(e.to, 'top') },
    ],
  };
}

/**
 * 行先行 L(row-column): 自行の基線を対象列まで直進し、対象列の中心を縦走して
 * 対象の上/下頂点へ入る 1 折れ形。列先行 L(drop)の鏡像で、合流ゲートウェイへの
 * 行違い入りと文書→工程のデータ関連の自然形。
 *
 * 安全条件は全て静的 + 予約:
 *   - 出発行の u.col+1..v.col のセルが空(水平部が図形を貫かない)
 *   - 対象列の u.row..v.row 間のセルが空 + colRuns 予約(同一終点は収束共有 = バス化)
 *   - 出発行の基線区間を rowRuns 予約(S-36 の相互保護を予約で置き換える)
 *   - 入る頂点が出として使われない(下: bottomOutFree 系 / 上: 出予約は colRuns が守る)
 * ゲートウェイ発は S-50 の頂点文法(上下出し)に従うため対象外。
 */
function planRowThenColumn(
  ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gU: number, gV: number,
): EdgePlan | undefined {
  if (gU === gV || v.col <= u.col) return undefined;
  // ゲートウェイ発は本流(東出し。S-50)だけ。非本流は上下頂点の文法に従う
  if (isGw(u.node) && !e.onSpine) return undefined;
  if (isAttachedBoundary(u.node) || isAttachedBoundary(v.node)) return undefined;
  if (isDocLike(v.node.kind) && e.kind !== 'assoc') return undefined;
  if (nodeBetweenOnRow(ctx, u.lane, u.row, u.col + 1, v.col)) return undefined;
  const fromBelow = gU > gV;
  const side: PortSide = fromBelow ? 'bottom' : 'top';
  if (fromBelow) {
    if (!bottomOutFree(ctx, v, gV) || needsBottomMessagePort(ctx, v.node.id)) return undefined;
    if (!(bottomFree(v.node) || eventBottomOpen(ctx, v.node))) return undefined;
    // 非タスクの下スタブ(planFromBottomViaGutter)は予約を持たないため、非 seq 出があれば避ける
    // (文書類の読み出しは右辺から出るので対象外)
    if (v.node.kind !== 'task' && !isDocLike(v.node.kind) && eventHasBottomOut(ctx, v.node.id)) return undefined;
  } else if (isEventKind(v.node.kind) && e.kind === 'seq') {
    return undefined; // イベントの上辺入りは現行文法に無い(ラベル面の可能性)
  }
  if (!canReserveRowRun(ctx, u.lane, u.row, u.col, v.col, e.from, e.to)) return undefined;
  if (!reserveColRun(ctx, v.col, gU, gV, e)) return undefined;
  noteRowRun(ctx, u.lane, u.row, u.col, v.col, e);
  noteLabelNeed(ctx, e, u.col + 1);
  const srcY = fallbackRightY(e, e.from);
  return {
    edgeId: e.id, fromSide: 'right', toSide: side, pattern: 'row-column',
    points: [
      { x: portX(e.from, 'right'), y: srcY },
      { x: nodeCX(e.to), y: srcY },
      { x: nodeCX(e.to), y: portY(e.to, side) },
    ],
  };
}

/** v の下頂点が出として使われる可能性が無いか(下向きの非戻り出辺が一つも無い) */
function noDownwardOut(ctx: Ctx, v: Cell, vRowPos: number): boolean {
  for (const e2 of ctx.g.edges) {
    if (e2.from !== v.node.id || e2.isReturn) continue;
    // プール参照(黒箱)への出辺も下向き判定に含める(帯が下なら bottom を使う)
    if (e2.toPool) {
      const lane = blackboxLane(ctx, e2.toPool);
      const bandPos = lane === undefined ? undefined : ctx.globalRow.get(rowKey(lane, 0));
      if (bandPos !== undefined && bandPos > vRowPos) return false;
      continue;
    }
    const t = ctx.nodeById.get(e2.to);
    if (!t) continue;
    const tPos = ctx.globalRow.get(rowKey(t.lane, ctx.p.row.get(t.id)!))!;
    if (tPos > vRowPos) return false;
  }
  return true;
}

/** 実際のポート文法上、bottom を使う出辺が無いか。 */
function bottomOutFree(ctx: Ctx, v: Cell, vRowPos: number): boolean {
  for (const e2 of ctx.g.edges) {
    if (e2.from !== v.node.id || e2.isReturn) continue;
    if (e2.toPool) {
      const lane = blackboxLane(ctx, e2.toPool);
      const bandPos = lane === undefined ? undefined : ctx.globalRow.get(rowKey(lane, 0));
      if (bandPos !== undefined && bandPos > vRowPos) return false;
      continue;
    }
    const t = ctx.nodeById.get(e2.to);
    if (!t) continue;
    const tPos = ctx.globalRow.get(rowKey(t.lane, ctx.p.row.get(t.id)!))!;
    if (tPos <= vRowPos) continue;
    if (e2.kind === 'assoc' || e2.kind === 'msg') {
      if (v.node.kind === 'task') continue; // 後段の辺スロットで入出を分離する
      return false;
    }
    if (e2.kind === 'seq' && isGw(v.node) && !e2.onSpine) return false;
  }
  return true;
}

/**
 * 黒箱プール参照メッセージ(C-51): 枠そのものがポート。
 * 帯が相手側にあるとき、端点はプール帯の縁に垂直に付く。
 * 同列直進できれば bottom→縁 / 縁→top の一直線。だめなら溝を経由する。
 */
function planPoolMsg(ctx: Ctx, e: NormEdge): EdgePlan {
  if (e.toPool) {
    const u = cellOf(ctx, e.from);
    const lane = blackboxLane(ctx, e.toPool)!;
    const bandPos = ctx.globalRow.get(rowKey(lane, 0))!;
    const gU = ctx.globalRow.get(rowKey(u.lane, u.row))!;
    const below = bandPos > gU;
    if (below && bottomFree(u.node) && reserveColRun(ctx, u.col, gU, bandPos, e)) {
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'drop',
        points: [
          { x: nodeCX(e.from), y: portY(e.from, 'bottom') },
          { x: nodeCX(e.from), y: { t: 'laneEdge', lane, edge: 'top' } },
        ],
      };
    }
    // 溝を経由して帯の縁に付く(上の帯なら下縁、下の帯なら上縁)
    const g1 = u.col + 1;
    const run = allocGutter(ctx, g1, 'exit', gU, bandPos);
    const srcY = fallbackRightY(e, e.from);
    return {
      edgeId: e.id, fromSide: 'right', toSide: below ? 'top' : 'bottom', pattern: 'channel-approach',
      points: [
        { x: portX(e.from, 'right'), y: srcY },
        { x: gutterX(g1, 'exit', run), y: srcY },
        { x: gutterX(g1, 'exit', run), y: { t: 'laneEdge', lane, edge: below ? 'top' : 'bottom' } },
      ],
    };
  }
  // fromPool: イベントは帯に面した側へ入る。タスクは従来どおり上へ入れ、出メッセージと点を共有しない。
  const v = cellOf(ctx, e.to);
  const lane = blackboxLane(ctx, e.fromPool!)!;
  const bandPos = ctx.globalRow.get(rowKey(lane, 0))!;
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  const above = bandPos < gV;
  if (!isEventKind(v.node.kind)) {
    if (above && reserveColRun(ctx, v.col, bandPos, gV, e, `#pool:${lane}`)) {
      return {
        edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'drop',
        points: [
          { x: nodeCX(e.to), y: { t: 'laneEdge', lane, edge: 'bottom' } },
          { x: nodeCX(e.to), y: portY(e.to, 'top') },
        ],
      };
    }
    const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
    const gx = v.col + 1;
    const run = allocGutter(ctx, gx, 'exit', bandPos, chPos);
    const tCh = allocChannel(ctx, v.lane, v.row, gx - 0.5, v.col, bandPos < chPos ? 'above' : 'below', bandPos, gx - 0.5);
    return {
      edgeId: e.id, fromSide: above ? 'bottom' : 'top', toSide: 'top', pattern: 'channel-approach',
      points: [
        { x: gutterX(gx, 'exit', run), y: { t: 'laneEdge', lane, edge: above ? 'bottom' : 'top' } },
        { x: gutterX(gx, 'exit', run), y: channelY(v.lane, v.row, tCh) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
        { x: nodeCX(e.to), y: portY(e.to, 'top') },
      ],
    };
  }
  const face: PortSide = above ? 'top' : 'bottom';
  const poolEdge = above ? 'bottom' : 'top';
  const faceOpen = face === 'top' || eventBottomOpen(ctx, v.node);
  const enter: PortSide = faceOpen ? face : 'top';
  if ((enter === 'top' ? above : !above) && reserveColRun(ctx, v.col, bandPos, gV, e, `#pool:${lane}`)) {
    return {
      edgeId: e.id, fromSide: poolEdge, toSide: enter, pattern: 'drop',
      points: [
        { x: nodeCX(e.to), y: { t: 'laneEdge', lane, edge: poolEdge } },
        { x: nodeCX(e.to), y: portY(e.to, enter) },
      ],
    };
  }
  const gx = v.col + 1;
  if (enter === 'bottom') {
    const belowRow = v.row + 1;
    const belowCh = ctx.globalChannel.get(rowKey(v.lane, belowRow));
    if (belowCh !== undefined) {
      const run = allocGutter(ctx, gx, 'exit', bandPos, belowCh);
      const tCh = allocChannel(ctx, v.lane, belowRow, gx - 0.5, v.col, 'below', bandPos, gx - 0.5);
      return {
        edgeId: e.id, fromSide: poolEdge, toSide: 'bottom', pattern: 'channel-approach',
        points: [
          { x: gutterX(gx, 'exit', run), y: { t: 'laneEdge', lane, edge: poolEdge } },
          { x: gutterX(gx, 'exit', run), y: channelY(v.lane, belowRow, tCh) },
          { x: nodeCX(e.to), y: channelY(v.lane, belowRow, tCh) },
          { x: nodeCX(e.to), y: portY(e.to, 'bottom') },
        ],
      };
    }
    const run = allocGutter(ctx, gx, 'exit', bandPos, gV);
    return {
      edgeId: e.id, fromSide: poolEdge, toSide: 'bottom', pattern: 'channel-approach',
      points: [
        { x: gutterX(gx, 'exit', run), y: { t: 'laneEdge', lane, edge: poolEdge } },
        { x: gutterX(gx, 'exit', run), y: portStubY(e.to, 'bottom') },
        { x: nodeCX(e.to), y: portStubY(e.to, 'bottom') },
        { x: nodeCX(e.to), y: portY(e.to, 'bottom') },
      ],
    };
  }
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  const run = allocGutter(ctx, gx, 'exit', bandPos, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, gx - 0.5, v.col, bandPos < chPos ? 'above' : 'below', bandPos, gx - 0.5);
  return {
    edgeId: e.id, fromSide: poolEdge, toSide: 'top', pattern: 'channel-approach',
    points: [
      { x: gutterX(gx, 'exit', run), y: { t: 'laneEdge', lane, edge: poolEdge } },
      { x: gutterX(gx, 'exit', run), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: portY(e.to, 'top') },
    ],
  };
}

// ---- 戻り辺(C-25) ----
// 改善候補はループ外周、基準候補は対象行の上チャネルを逆走する。

function planReturn(ctx: Ctx, e: NormEdge): EdgePlan {
  const u = cellOf(ctx, e.from);
  const v = cellOf(ctx, e.to);
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row))!;
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  if (ctx.optimizeReadability) {
    // ループ内部の target 上チャネルではなく、source から target と反対側の外周を使う。
    // 同一行は下へ回し、前向き枝と戻り線の入れ子を構造で分離する。
    const outerRow = gV < gU ? u.row + 1 : gV > gU ? u.row : u.row + 1;
    const outer = ctx.globalChannel.get(rowKey(u.lane, outerRow));
    const targetSide: PortSide = outer !== undefined && outer < gV ? 'top' : 'bottom';
    const targetDirect = targetSide === 'top' || (
      bottomFree(v.node) && noDownwardOut(ctx, v, gV) && !needsBottomMessagePort(ctx, v.node.id)
    );
    if (outer !== undefined && targetDirect && reserveColRun(ctx, v.col, outer, gV, e)) {
      const gup = u.col + 1;
      const sourceSide: PortSide = outer < gU ? 'top' : 'bottom';
      const sourceDirect = sourceSide === 'top' ? topFree(ctx, u) : bottomFree(u.node);
      if (sourceDirect && reserveColRun(ctx, u.col, outer, gU, e)) {
        const t = allocChannel(
          ctx, u.lane, outerRow, v.col, u.col,
          outer < gU ? 'below' : 'above', gU, u.col,
        );
        return {
          edgeId: e.id, fromSide: sourceSide, toSide: targetSide, pattern: 'return',
          points: [
            { x: nodeCX(e.from), y: portY(e.from, sourceSide) },
            { x: nodeCX(e.from), y: channelY(u.lane, outerRow, t) },
            { x: nodeCX(e.to), y: channelY(u.lane, outerRow, t) },
            { x: nodeCX(e.to), y: portY(e.to, targetSide) },
          ],
        };
      }
      const rUp = allocGutter(ctx, gup, 'exit', gU, outer);
      const t = allocChannel(
        ctx, u.lane, outerRow, v.col, gup - 0.5,
        outer < gU ? 'below' : 'above', gU, gup - 0.5,
      );
      const srcY = fallbackRightY(e, e.from);
      if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(gup), e);
      return {
        edgeId: e.id, fromSide: 'right', toSide: targetSide, pattern: 'return',
        points: [
          { x: portX(e.from, 'right'), y: srcY },
          { x: gutterX(gup, 'exit', rUp), y: srcY },
          { x: gutterX(gup, 'exit', rUp), y: channelY(u.lane, outerRow, t) },
          { x: nodeCX(e.to), y: channelY(u.lane, outerRow, t) },
          { x: nodeCX(e.to), y: portY(e.to, targetSide) },
        ],
      };
    }
  }
  const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  // 同一行戻り: 逆走チャネルは自行直上。top が S-56 で空き自列を予約できるとき north。
  if (
    chV === gU - 1 && !isAttachedBoundary(u.node) &&
    topFree(ctx, u) && reserveColRun(ctx, u.col, chV, gU, e)
  ) {
    const t = allocChannel(ctx, v.lane, v.row, v.col, u.col, 'below', gU, u.col);
    return {
      edgeId: e.id, fromSide: 'top', toSide: 'top', pattern: 'return',
      points: [
        { x: nodeCX(e.from), y: portY(e.from, 'top') },
        { x: nodeCX(e.from), y: channelY(v.lane, v.row, t) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, t) },
        { x: nodeCX(e.to), y: portY(e.to, 'top') },
      ],
    };
  }
  // 行違い戻り(改善候補のみ): top が空いていて自列中心を対象上チャネルまで昇れるなら、
  // 右溝の昇りを省いて north から直接出る(2 折れ)。基準系には入れない(cycle1 で
  // 基準系に入れると keihi の申請者レーンで上チャネル全幅逆走が勝つことが確認済み)。
  // 非 seq の戻り(書き戻しの関連など)は S-57 の +10 帯で右溝へ出す C2 規則を保つ。
  // 基準系ではゲートウェイ発を除く(cycle1: 基準系の south 出口が top 出しに化けて keihi を割った)。
  if (
    (ctx.optimizeReadability || !isGw(u.node)) && e.kind === 'seq' && chV < gU &&
    !isAttachedBoundary(u.node) && topFree(ctx, u) &&
    !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) &&
    !(v.row > 0 && ctx.occupied.has(`${v.lane}:${v.row - 1}:${u.col}`)) &&
    reserveColRun(ctx, u.col, chV, gU, e)
  ) {
    const t = allocChannel(ctx, v.lane, v.row, v.col, u.col, 'below', gU, u.col);
    return {
      edgeId: e.id, fromSide: 'top', toSide: 'top', pattern: 'return',
      points: [
        { x: nodeCX(e.from), y: portY(e.from, 'top') },
        { x: nodeCX(e.from), y: channelY(v.lane, v.row, t) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, t) },
        { x: nodeCX(e.to), y: portY(e.to, 'top') },
      ],
    };
  }
  const gup = u.col + 1; // 自列すぐ右の溝を昇る
  const rUp = allocGutter(ctx, gup, 'exit', gU, chV);
  const t = allocChannel(ctx, v.lane, v.row, v.col, gup - 0.5, gU < chV ? 'above' : 'below', gU, gup - 0.5);
  const srcY = fallbackRightY(e, e.from);
  if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(gup), e);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'top', pattern: 'return',
    points: [
      { x: portX(e.from, 'right'), y: srcY },
      { x: gutterX(gup, 'exit', rUp), y: srcY },
      { x: gutterX(gup, 'exit', rUp), y: channelY(v.lane, v.row, t) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, t) },
      { x: nodeCX(e.to), y: portY(e.to, 'top') },
    ],
  };
}
