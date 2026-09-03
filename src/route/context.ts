// P3 の文脈: 占有表・通し位置・予約レジストリ(列走行・行基線・側面スタブ)と走行の登録。
// 座標は使わない。回廊の混雑は組合せとして数え、P4 が幅に反映する。

import { isAttachedBoundary } from '../bpmn.ts';
import { crossMinusLabelEvents } from '../message-labels.ts';
import { buildPoolIndex, type PoolIndex } from '../pools.ts';
import { EDGE_FONT_SIZE, measureText } from '../metrics.ts';
import type {
  EdgePlan, GutterSide, NormEdge, NormGraph, NormNode, Placement,
} from '../types.ts';

export interface Ctx {
  g: NormGraph;
  p: Placement;
  nodeById: Map<string, NormNode>;
  occupied: Map<string, string>; // cellKey(lane, row, col) -> nodeId。cellOccupied / occupantAt で照会する
  rows: ReadonlyArray<{ lane: string; row: number; pos: number }>; // 全レーンの行と通し縦位置(縦走の占有検査用)
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
    a: number; b: number; from: string; to: string; edge: string; exclusive?: boolean;
    gap?: { a: number; b: number; upperX: number; lowerX: number; upperSide: boolean };
  }>>;
  // 行基線の水平走行(direct・drop・row/channel-approach の基線区間)。列スケール
  // (列 c = c、溝 g = g - 0.5)。S-36 の「ノードで終わる」相互保護を明示予約に置き換え、
  // 列中心で終わる水平(行先行 L)も同じ規則で安全に扱う。共有規則は colRuns と同じ。
  rowRuns: Map<string, Array<{ a: number; b: number; from: string; to: string }>>;
  // 側面出し(S-57)の水平スタブ。`${lane}:${row}@${yOffset}` ごとに列スケール区間を持つ。
  // 同じ行の隣り合うノードが同じ溝へ左右から同じ高さで出ると、溝の中でトラック位置の差だけ
  // 重なる。離散区間では端点接触なので、この登録だけ端点を含めて衝突とみなす。
  stubRuns: Map<string, Array<{ a: number; b: number; from: string; to: string }>>;
  pools: PoolIndex; // レーン→プール、プール→順位(全相で共有)
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

/**
 * 文脈の構築: 占有表、通し縦位置(チャネル→行を交互に、プール境界に回廊を挟む)、空の予約レジストリ。
 * 改善候補(optimizeReadability)は各レーンの最終行の下にも終端チャネルを持つ。
 */
export function buildContext(
  g: NormGraph, p: Placement, optimizeReadability = false, options?: RouteOptions,
): Ctx {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const occupied = new Map<string, string>();
  for (const n of g.nodes) {
    if (isAttachedBoundary(n)) continue; // 対象 Activity がセルを占有する
    occupied.set(cellKey(n.lane, p.row.get(n.id)!, p.col.get(n.id)!), n.id);
  }
  const rows: Array<{ lane: string; row: number; pos: number }> = [];
  const globalRow = new Map<string, number>();
  const globalChannel = new Map<string, number>();
  const globalPoolGap = new Map<number, number>();
  const pools = buildPoolIndex(g);
  let pos = 0;
  let prevPool: string | undefined | null = null;
  for (const lane of g.lanes) {
    if (prevPool !== null && lane.pool !== prevPool) {
      const pi = pools.indexOf(prevPool!);
      if (pi !== undefined) globalPoolGap.set(pi, pos++);
    }
    prevPool = lane.pool;
    const laneRowCount = p.laneRows.get(lane.id) ?? 1;
    for (let r = 0; r < laneRowCount; r++) {
      globalChannel.set(rowKey(lane.id, r), pos++);
      globalRow.set(rowKey(lane.id, r), pos);
      rows.push({ lane: lane.id, row: r, pos: pos++ });
    }
    if (optimizeReadability) globalChannel.set(rowKey(lane.id, laneRowCount), pos++);
  }
  return {
    g, p, nodeById, occupied, rows, globalRow, globalChannel, globalPoolGap, laneRows: p.laneRows,
    gutterRuns: new Map(), channelRuns: new Map(), runSeq: { n: 0 }, gutterLabelNeed: new Map(),
    poolGapRuns: new Map(),
    colRuns: new Map(),
    rowRuns: new Map(),
    stubRuns: new Map(),
    pools,
    labelCrossMinus: crossMinusLabelEvents(g),
    planned: new Map(),
    optimizeReadability,
    gapDestFlip: options?.gapDestFlip ?? new Set(),
  };
}

export const rowKey = (lane: string, row: number) => `${lane}:${row}`;
export const cellKey = (lane: string, row: number, col: number) => `${lane}:${row}:${col}`;

/** セル (lane, row, col) を占めるノード id。境界イベントは対象 Activity の中なので占めない。 */
export function occupantAt(ctx: Ctx, lane: string, row: number, col: number): string | undefined {
  return ctx.occupied.get(cellKey(lane, row, col));
}

export function cellOccupied(ctx: Ctx, lane: string, row: number, col: number): boolean {
  return ctx.occupied.has(cellKey(lane, row, col));
}

export function nodeBetweenOnRow(ctx: Ctx, lane: string, row: number, c0: number, c1: number): boolean {
  for (let c = c0; c <= c1; c++) if (cellOccupied(ctx, lane, row, c)) return true;
  return false;
}

/** 列 col の中心 +28px のレールを a..b の間で通れるか: 途中のセルが空か幅の狭い doc だけ */
export function railClear(ctx: Ctx, col: number, a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const r of ctx.rows) {
    if (r.pos <= lo || r.pos >= hi) continue;
    const occ = occupantAt(ctx, r.lane, r.row, col);
    if (occ !== undefined && ctx.nodeById.get(occ)?.kind !== 'doc') return false;
  }
  return true;
}

/** 列 col の中心線を、通し縦位置 a..b の間(両端は含まない)で垂直に通れるか */
function columnClear(ctx: Ctx, col: number, a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const r of ctx.rows) {
    if (r.pos <= lo || r.pos >= hi) continue;
    if (cellOccupied(ctx, r.lane, r.row, col)) return false;
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
export function reserveColRun(
  ctx: Ctx, col: number, a: number, b: number, e: NormEdge, from = colRunEnd(e, 'from'),
  shareFace?: string, pairEdge?: string,
): boolean {
  const to = colRunEnd(e, 'to');
  if (!canReserveColRun(ctx, col, a, b, from, to, shareFace, pairEdge)) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runs = ctx.colRuns.get(col) ?? [];
  runs.push({ a: lo, b: hi, from, to, edge: e.id });
  ctx.colRuns.set(col, runs);
  return true;
}

/**
 * shareFace: このノードの上下面に着く/発つ走行とは重なってよい。後段の
 * separateSharedEntries が同じ面の非 seq 線をスロットへ分けるので、実座標では
 * 平行線として離れる(往復メッセージ対の型)。タスクとイベントだけに使う。
 */
export function canReserveColRun(
  ctx: Ctx, col: number, a: number, b: number, from: string, to: string, shareFace?: string,
  pairEdge?: string,
): boolean {
  if (!columnClear(ctx, col, a, b)) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return !(ctx.colRuns.get(col) ?? []).some(
    (r) =>
      r.from !== from && r.to !== to && r.a < hi && lo < r.b && r.edge !== pairEdge &&
      !(shareFace !== undefined && !r.exclusive && (r.from === shareFace || r.to === shareFace)),
  );
}

/** 直前に予約した列走行を排他にする(2 点の一直線はスロット分離されないため面共有できない)。 */
export function markExclusiveColRun(ctx: Ctx, col: number): void {
  const runs = ctx.colRuns.get(col);
  const last = runs?.at(-1);
  if (last) last.exclusive = true;
}

/** 行基線の水平区間を予約できるか(列スケール。同一始点・同一終点は共有可)。 */
export function canReserveRowRun(
  ctx: Ctx, lane: string, row: number, a: number, b: number, from: string, to: string,
): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return !(ctx.rowRuns.get(rowKey(lane, row)) ?? []).some(
    (r) => r.from !== from && r.to !== to && r.a < hi && lo < r.b,
  );
}

/** 行基線の水平区間を登録する。検査済み・または構築上安全な区間に使う。 */
export function noteRowRun(ctx: Ctx, lane: string, row: number, a: number, b: number, e: NormEdge): void {
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
export const gutterScale = (g: number) => g - 0.5;

/** 側面出しスタブの予約。端点接触(同じ溝を左右から使う)も衝突。成立すれば登録して true。 */
export function reserveStubRun(
  ctx: Ctx, lane: string, row: number, yOffset: number, a: number, b: number, e: NormEdge,
): boolean {
  const key = `${rowKey(lane, row)}@${yOffset}`;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const from = colRunEnd(e, 'from');
  const to = colRunEnd(e, 'to');
  const runs = ctx.stubRuns.get(key) ?? [];
  if (runs.some((r) => r.from !== from && r.to !== to && r.a <= hi && lo <= r.b)) return false;
  runs.push({ a: lo, b: hi, from, to });
  ctx.stubRuns.set(key, runs);
  return true;
}

/** 代替の無い右出しスタブ(fallbackRightY 系)を登録だけする。側面経路が避けるための情報。 */
export function noteStubRun(
  ctx: Ctx, lane: string, row: number, yOffset: number, a: number, b: number, e: NormEdge,
): void {
  const key = `${rowKey(lane, row)}@${yOffset}`;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runs = ctx.stubRuns.get(key) ?? [];
  runs.push({ a: lo, b: hi, from: colRunEnd(e, 'from'), to: colRunEnd(e, 'to') });
  ctx.stubRuns.set(key, runs);
}

/** fallbackRightY と同じオフセット(msg +8 / assoc +10)。seq は基線なので 0。 */
export const fallbackOffset = (e: NormEdge) => (e.kind === 'seq' ? 0 : e.kind === 'msg' ? 8 : 10);

// ---- 走行の登録 ----

export function allocGutter(ctx: Ctx, gi: number, side: GutterSide, a: number, b: number): number {
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
export function allocChannel(
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

export function allocPoolGap(ctx: Ctx, gap: number, upperX: number, lowerX: number): number {
  const runs = ctx.poolGapRuns.get(gap) ?? [];
  ctx.poolGapRuns.set(gap, runs);
  const [a, b] = upperX < lowerX ? [upperX, lowerX] : [lowerX, upperX];
  const runId = ctx.runSeq.n++;
  runs.push({ a, b, upperX, lowerX, runId });
  return runId;
}

// ---- 記号座標のヘルパ ----

export interface Cell {
  lane: string;
  row: number;
  col: number;
  node: NormNode;
}

export function cellOf(ctx: Ctx, id: string): Cell {
  const n = ctx.nodeById.get(id)!;
  return { lane: n.lane, row: ctx.p.row.get(id)!, col: ctx.p.col.get(id)!, node: n };
}

/**
 * 列 col の回廊帯に反対側から着く既存走行と、入れ子順(assignPoolGapTracks の before 関係)が
 * 矛盾なく並ぶか。上側から着く走行 P と下側から着く走行 Q が同じ x を端点に持つとき、
 * P は必ず Q の上に置かれる(P.upperX が Q の区間内)。逆向きの関係も成立すると順序が循環し、
 * 帯の中で縦線が重なり得る(fuzz seed 72 の X 字対)。
 */
export function gapOrderConsistent(
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

export function noteLabelNeed(ctx: Ctx, e: NormEdge, gi: number): void {
  if (!e.label) return;
  const w = measureText(e.label, EDGE_FONT_SIZE) + 12;
  ctx.gutterLabelNeed.set(gi, Math.max(ctx.gutterLabelNeed.get(gi) ?? 0, w));
}

// ---- 前向き辺 ----
