// P3 の静的述語: ポートの空き(S-5x)・面の静寂・プール位置。辺集合と配置だけを見る。

import { isEventKind, isGatewayKind } from '../bpmn.ts';
import type {
  NormEdge, NormNode, PortSide, SymY,
} from '../types.ts';
import { rowKey, columnClear } from './context.ts';
import type { Ctx, Cell } from './context.ts';
import { portY, nodeCY } from './symbols.ts';

export const isGw = (n: NormNode) => isGatewayKind(n.kind);

export const hasSequenceOut = (ctx: Ctx, id: string) =>
  ctx.g.edges.some((e) => e.from === id && e.kind === 'seq');

export const needsBottomMessagePort = (ctx: Ctx, id: string) =>
  hasSequenceOut(ctx, id) && ctx.g.edges.some((e) => e.from === id && e.kind === 'msg' && !e.toPool);

export const blackboxLane = (ctx: Ctx, pool: string) =>
  ctx.g.lanes.find((lane) => lane.pool === pool && lane.blackbox)?.id;

/** A black-box message cannot take the bottom port through an occupied column. */
function poolMessageCanLeaveBottom(ctx: Ctx, e: NormEdge): boolean {
  const source = ctx.nodeById.get(e.from);
  const lane = e.toPool && blackboxLane(ctx, e.toPool);
  if (!source || !lane || !bottomFree(source)) return false;
  const start = ctx.globalRow.get(rowKey(source.lane, ctx.p.row.get(source.id)!))!;
  const end = ctx.globalRow.get(rowKey(lane, 0))!;
  return end > start && columnClear(ctx, ctx.p.col.get(source.id)!, start, end);
}

/** 下ポートを使ってよいか: 下置きラベルのあるイベント類は不可(ラベル動線と衝突。C-65) */
export const bottomFree = (n: NormNode) =>
  !(isEventKind(n.kind) && n.label !== '');

/** 交差軸プラス側のプールから着くメッセージは、ラベルを反対側へ逃すので下ポートが空く。 */
function poolMessageFacesBottom(ctx: Ctx, nodeId: string): boolean {
  const ni = ctx.pools.indexOfNode(nodeId);
  if (ni === undefined) return false;
  return ctx.g.edges.some((e) => {
    if (e.kind !== 'msg' || e.to !== nodeId || !e.fromPool) return false;
    const fi = ctx.pools.indexOf(e.fromPool);
    return fi !== undefined && fi > ni;
  });
}

/** P1 と同じ規則(message-labels.ts)でラベルが交差軸マイナス側へ逃げたイベントか。下ポートが空く。 */
export function eventLabelMovedUp(ctx: Ctx, nodeId: string): boolean {
  return ctx.labelCrossMinus.has(nodeId);
}

export function eventHasBottomOut(ctx: Ctx, id: string): boolean {
  return ctx.g.edges.some((e) =>
    e.from === id && (e.kind === 'assoc' || (e.kind === 'msg' && !e.toPool)));
}

export function eventBottomOpen(ctx: Ctx, n: NormNode): boolean {
  if (eventHasBottomOut(ctx, n.id)) return false;
  return bottomFree(n) || poolMessageFacesBottom(ctx, n.id);
}

/**
 * u の上ポートが入りとして使われないことが静的に分かるか(S-56。メッセージの top 出し用)。
 * 上を使う入り = 戻り辺・非シーケンス辺・プール発・(ゲートウェイなら行違いのシーケンス)。
 */
export function topFree(ctx: Ctx, u: Cell): boolean {
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

/** ゲートウェイ v の西頂点が空いているか: 同一行からの seq 入りが無く、行違いの seq 入りが e だけ。 */
export function westFree(ctx: Ctx, v: Cell, e: NormEdge): boolean {
  let crossRow = 0;
  for (const o of ctx.g.edges) {
    if (o.to !== v.node.id || o.kind !== 'seq' || o.isReturn || o.fromPool) continue;
    if (sameRowSource(ctx, o, v)) return false;
    crossRow++;
  }
  return crossRow === 1 && ctx.g.edges.some((o) => o.id === e.id && o.kind === 'seq');
}

/**
 * ノードの面 face を使い得る他の辺が無いか。ignore は対の辺。
 * 計画済みの辺は実際の入口・出口面で判定し、未計画の辺は静的に保守的に
 * (非 seq の出入り・戻り・プール発は上下面を使い得る)扱う。
 */
export function faceQuiet(
  ctx: Ctx, nodeId: string, face: PortSide, e: NormEdge, ignore?: string,
  skip?: (o: NormEdge) => boolean,
): boolean {
  return !ctx.g.edges.some((o) => {
    if (o.id === e.id || o.id === ignore || (o.from !== nodeId && o.to !== nodeId)) return false;
    if (skip?.(o)) return false;
    if (face === 'bottom' && o.from === nodeId && o.toPool && !poolMessageCanLeaveBottom(ctx, o)) return false;
    const done = ctx.planned.get(o.id);
    if (done) {
      return (o.from === nodeId && done.fromSide === face) || (o.to === nodeId && done.toSide === face);
    }
    return (o.to === nodeId && (o.kind !== 'seq' || o.isReturn || !!o.fromPool)) ||
      (o.from === nodeId && o.kind !== 'seq');
  });
}

/** u の上面を使う入りが全て非 seq(スロット分離の対象)か。戻り seq や行違いゲートウェイ入りがあれば false。 */
export function topUsersSlottable(ctx: Ctx, u: Cell): boolean {
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

/**
 * 溝へ向かう右出の y。seq は基線(S-40)。非 seq はシーケンス出の有無を問わず
 * 基線を使わない(S-36): 溝で終わる水平を行中心に載せると、同じ行の
 * ノード終端アプローチと O-6 で重なる。+側はラベル帯(上)の反対。
 * -10 は S-55 同一行 assoc 専用で、ここには出さない。
 */
export function fallbackRightY(e: NormEdge, fromId: string): SymY {
  if (e.kind === 'seq') return portY(fromId, 'right');
  return nodeCY(fromId, e.kind === 'msg' ? 8 : 10);
}

export function adjacentPoolGap(ctx: Ctx, u: Cell, v: Cell): number | undefined {
  const pair = poolPairIndices(ctx, u, v);
  if (!pair) return undefined;
  const [ui, vi] = pair;
  return Math.abs(ui - vi) === 1 ? Math.min(ui, vi) : undefined;
}

export function poolPairIndices(ctx: Ctx, u: Cell, v: Cell): [number, number] | undefined {
  const ui = ctx.pools.indexOf(ctx.pools.poolOfLane(u.lane));
  const vi = ctx.pools.indexOf(ctx.pools.poolOfLane(v.lane));
  return ui !== undefined && vi !== undefined ? [ui, vi] : undefined;
}

/** 通信が多い側と反対の外周へ、同一行の迂回分岐を置く。 */
export function alternativeBelow(ctx: Ctx, u: Cell): boolean {
  const ownPool = ctx.pools.poolOfLane(u.lane);
  const ownIndex = ctx.pools.indexOf(ownPool);
  if (ownIndex === undefined) return true;
  const nodePool = (id: string) => ctx.pools.poolOfNode(id);
  let above = 0;
  let below = 0;
  for (const e of ctx.g.edges) {
    if (e.kind !== 'msg') continue;
    const fromPool = e.fromPool ?? nodePool(e.from);
    const toPool = e.toPool ?? nodePool(e.to);
    if (fromPool !== ownPool && toPool !== ownPool) continue;
    const other = fromPool === ownPool ? toPool : fromPool;
    const oi = ctx.pools.indexOf(other);
    if (oi === undefined) continue;
    if (oi < ownIndex) above++;
    if (oi > ownIndex) below++;
  }
  return above >= below;
}

/** v の下頂点が出として使われる可能性が無いか(下向きの非戻り出辺が一つも無い) */
export function noDownwardOut(ctx: Ctx, v: Cell, vRowPos: number): boolean {
  for (const e2 of ctx.g.edges) {
    if (e2.from !== v.node.id || e2.isReturn) continue;
    // プール参照(黒箱)への出辺も下向き判定に含める(帯が下なら bottom を使う)
    if (e2.toPool) {
      const lane = blackboxLane(ctx, e2.toPool);
      const bandPos = lane === undefined ? undefined : ctx.globalRow.get(rowKey(lane, 0));
      if (bandPos !== undefined && bandPos > vRowPos && poolMessageCanLeaveBottom(ctx, e2)) return false;
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
export function bottomOutFree(ctx: Ctx, v: Cell, vRowPos: number): boolean {
  for (const e2 of ctx.g.edges) {
    if (e2.from !== v.node.id || e2.isReturn) continue;
    if (e2.toPool) {
      const lane = blackboxLane(ctx, e2.toPool);
      const bandPos = lane === undefined ? undefined : ctx.globalRow.get(rowKey(lane, 0));
      if (bandPos !== undefined && bandPos > vRowPos && poolMessageCanLeaveBottom(ctx, e2)) return false;
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
