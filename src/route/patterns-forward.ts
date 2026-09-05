// P3 前向き辺の経路パターン(direct / row-column / drop / rise / row-approach / channel-approach)。
// planForward は順に試し、最初に成立した形を採る。順序は可読性の優先順位そのもの。

import { isAttachedBoundary, isEventKind } from '../bpmn.ts';
import { isDocLike } from '../types.ts';
import type {
  EdgePlan, GutterSide, NormEdge, PortSide,
} from '../types.ts';
import { rowKey, cellOccupied, occupantAt, cellOf, nodeBetweenOnRow, railClear, reserveColRun, markExclusiveColRun, canReserveRowRun, noteRowRun, gutterScale, reserveStubRun, noteStubRun, fallbackOffset, allocGutter, allocChannel, noteLabelNeed } from './context.ts';
import type { Ctx, Cell } from './context.ts';
import { portX, portY, portStubY, gutterX, nodeCX, nodeCY, channelY, rowMidY, verticalLine, verticalZ } from './symbols.ts';
import { isGw, hasSequenceOut, needsBottomMessagePort, bottomFree, eventHasBottomOut, eventBottomOpen, topFree, westFree, faceQuiet, noDownwardOut, bottomOutFree, fallbackRightY, adjacentPoolGap, poolPairIndices, alternativeBelow } from './predicates.ts';
import { planAcrossPoolGap, planIntoBoundary, planAcrossPoolExterior, planMessageFromTopViaGutter } from './patterns-message.ts';

/**
 * 前向き辺 1 本の判定材料。各パターンはこれだけを見て、成立すれば計画を返し、
 * 成立しなければ undefined を返して次のパターンへ譲る。
 */
export interface ForwardCase {
  ctx: Ctx;
  e: NormEdge;
  u: Cell;
  v: Cell;
  sameRow: boolean;
  gU: number; // 出発行の通し縦位置
  gV: number; // 対象行の通し縦位置
  rowFree: boolean; // 対象行の u.col+1..v.col-1 のセルが空
  // row-approach は出発列のセルも空である必要がある(そのセルの出スタブと基線上で衝突するため)
  rowFreeWide: boolean;
}

export type ForwardPattern = (k: ForwardCase) => EdgePlan | undefined;

/**
 * 前向き辺の経路。パターンを宣言順に試し、最初に成立した形を採る。
 * 順序そのものが可読性の優先順位で、後ろほど一般的(最後の channel-approach は常に合法)。
 * 途中の noteExitLabel のように、以後のパターンが共有する副作用だけを持つ段もある。
 */
export function planForward(ctx: Ctx, e: NormEdge): EdgePlan {
  const u = cellOf(ctx, e.from);
  const v = cellOf(ctx, e.to);
  const sameRow = u.lane === v.lane && u.row === v.row;
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row))!;
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row))!;
  const rowFree = !nodeBetweenOnRow(ctx, v.lane, v.row, u.col + 1, v.col - 1);
  const rowFreeWide = rowFree && !cellOccupied(ctx, v.lane, v.row, u.col);
  const k: ForwardCase = { ctx, e, u, v, sameRow, gU, gV, rowFree, rowFreeWide };
  for (const pattern of FORWARD_PATTERNS) {
    const plan = pattern(k);
    if (plan) return plan;
  }
  return channelApproach(k);
}

// ---- データ関連(assoc) ----

/** 同列の直落とし(帳票フローの型): 書類は工程の真下に落ち、真下の工程に真上から読まれる。 */
function assocDropStraight({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc') return undefined;
  // 境界イベントは対象の右半分に載るので列中心と x が合わず、2 点形は斜線になる
  if (!(u.col === v.col && gV > gU && !isAttachedBoundary(u.node) && reserveColRun(ctx, u.col, gU, gV, e))) return undefined;
  markExclusiveColRun(ctx, u.col);
  return {
    edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'drop',
    points: verticalLine(e.from, 'bottom', e.to, 'top'),
  };
}

/**
 * 同じ列の文書類へ落とす中心線が手前のノードで塞がる場合は、右隣の溝を
 * 一度だけ回って右辺へ入る。対象行の上チャネルまで往復する必要はない。
 */
function assocSameColumnSide({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (
    e.kind !== 'assoc' || isDocLike(u.node.kind) || !isDocLike(v.node.kind) ||
    u.col !== v.col || gU === gV
  ) return undefined;
  const outputs = ctx.g.edges.filter((o) => o.kind === 'assoc' && o.from === e.from);
  if (!outputs.every((o) => {
    const target = ctx.nodeById.get(o.to);
    return target !== undefined && isDocLike(target.kind) && target.lane === u.lane &&
      ctx.p.col.get(target.id) === u.col &&
      !ctx.g.edges.some((peer) =>
        peer.id !== o.id && (peer.from === target.id || peer.to === target.id)
      );
  })) return undefined;
  const g1 = u.col + 1;
  noteLabelNeed(ctx, e, g1);
  noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
  noteRowRun(ctx, v.lane, v.row, v.col, gutterScale(g1), e);
  const run = allocGutter(ctx, g1, 'exit', gU, gV);
  const srcY = fallbackRightY(e, e.from);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'right', pattern: 'row-approach',
    points: [
      { x: portX(e.from, 'right'), y: srcY },
      { x: gutterX(g1, 'exit', run), y: srcY },
      { x: gutterX(g1, 'exit', run), y: portY(e.to, 'right') },
      { x: portX(e.to, 'right'), y: portY(e.to, 'right') },
    ],
  };
}

/**
 * 直下の文書を上の工程が読む: top → bottom の一直線(帳票フローの型の鏡像)。
 * 2 点形はスロット分離を受けないので、工程の下面に他の非 seq の出入りが無いときだけ。
 */
function assocRiseStraight({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc') return undefined;
  if (!(
    u.col === v.col && gV < gU && isDocLike(u.node.kind) && !isDocLike(v.node.kind) &&
    faceQuiet(ctx, v.node.id, 'bottom', e) && bottomOutFree(ctx, v, gV) &&
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
  )) return undefined;
  markExclusiveColRun(ctx, u.col);
  return {
    edgeId: e.id, fromSide: 'top', toSide: 'bottom', pattern: 'drop',
    points: verticalLine(e.from, 'top', e.to, 'bottom'),
  };
}

/** 文書類以外に入る関連は必ず上頂点へ(左ポートはシーケンス入りの領分。S-51)。 */
function assocIntoNonDoc({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc' || isDocLike(v.node.kind)) return undefined;
  return planRowThenColumn(ctx, e, u, v, gU, gV) ?? planIntoTop(ctx, e, u, v, gU);
}

/**
 * 文書類へ落とす辺: 生産タスクの真下方向にあれば drop(下ポートは出専用)。
 * 別列は、同じノードに他の関連があるときだけ(下辺の入出力スロット)。
 * シーケンスと共存する単独の右出関連は cy+10 のまま残す。
 */
function assocDropToDoc({ ctx, e, u, v, gU, gV, rowFree }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc') return undefined;
  const otherAssoc = ctx.g.edges.some((o) =>
    o.kind === 'assoc' && o.id !== e.id && o.to === e.from
  );
  if (!(
    gV > gU && v.col > u.col && otherAssoc &&
    !cellOccupied(ctx, v.lane, v.row, u.col) &&
    rowFree &&
    reserveColRun(ctx, u.col, gU, gV, e)
  )) return undefined;
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

/**
 * 同じ列の遠い書類は中心線が手前の書類で塞がる。次列の XOR 溝ではなく、
 * 書き手の直後を通って右から入れる。長いスタブの競合は OARSP が実座標で解く。
 * レールは列中心 +28px を予約なしで縦走するので、途中のセルが幅の狭い文書だけで、
 * 書き手がタスク(下面のスロット分離を受ける)であり、下面に他の入りが無いときに限る。
 */
function assocRailBelow({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc') return undefined;
  if (!(
    v.node.kind === 'doc' && u.col === v.col && gV > gU && u.node.kind === 'task' &&
    railClear(ctx, u.col, gU, gV) &&
    !ctx.g.edges.some((o) => o.id !== e.id && o.to === u.node.id && o.kind !== 'seq')
  )) return undefined;
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

/**
 * 前の列の共著者: 時間軸を先に進めてから書類へ。隣接列の4点溝は奪わない。
 * レール(対象列中心 +48px)は予約を持たないので、対象列の途中セルが狭い doc だけのときに限る。
 */
function assocRailCoWriter({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc') return undefined;
  const coWriterHere = ctx.g.edges.some((other) =>
    other.kind === 'assoc' && other.to === e.to && other.from !== e.from &&
    ctx.p.col.get(other.from) === v.col
  );
  const adjacentPeer = occupantAt(ctx, v.lane, v.row, u.col);
  const adjacentFour =
    v.col === u.col + 1 && adjacentPeer !== undefined &&
    ctx.g.edges.some((other) => other.from === adjacentPeer && other.to === e.to);
  if (!(
    v.node.kind === 'doc' && gV > gU && u.lane === v.lane &&
    u.col < v.col && v.col - u.col <= 2 && coWriterHere && !adjacentFour &&
    railClear(ctx, v.col, gU, gV)
  )) return undefined;
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

/** 行違いの文書類へは、専用形が無ければ行先行 L で上/下辺から入る(S-55 の西入りは同一行の形)。 */
function assocRowThenColumn({ ctx, e, u, v, gU, gV, sameRow }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'assoc' || sameRow) return undefined;
  return planRowThenColumn(ctx, e, u, v, gU, gV);
}

// ---- メッセージ(msg) ----

/**
 * 境界イベント宛のメッセージ: 境界イベントは P4 で対象 Activity の辺へ重ねられ、
 * セル基線から離れるので、左入り系の経路は終点で斜線になる。専用経路で円へ入る。
 */
function messageIntoBoundary({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'msg' || !isAttachedBoundary(v.node)) return undefined;
  return planIntoBoundary(ctx, e, u, v, gU, gV);
}

/** 別プールへのメッセージ: 非隣接なら外周、隣接ならプール間回廊。 */
function messageAcrossPools({ ctx, e, u, v }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'msg') return undefined;
  const poolPair = poolPairIndices(ctx, u, v);
  if (poolPair && Math.abs(poolPair[0] - poolPair[1]) > 1) {
    return planAcrossPoolExterior(ctx, e, u, v, poolPair[0], poolPair[1]);
  }
  const poolGap = adjacentPoolGap(ctx, u, v);
  if (poolGap !== undefined) return planAcrossPoolGap(ctx, e, u, v, poolGap);
  return undefined;
}

/**
 * 同一プール内のメッセージ: 種類の異なる出は出口を分ける。
 * シーケンスは右から出るので、メッセージは縦(bottom/top)から出す — 右出しに重ねると
 * ノードが分岐しているように見える(ユーザー指摘)。
 * 下向き: bottom から出て対象行の上チャネルへ降り、対象の上頂点に入る。
 *   同列で列が空いていれば bottom→top の一直線(手描きの型)。
 * 下ラベル付きイベントの bottom はラベル動線と衝突するため使わない(C-65)
 */
function messageDownward({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'msg' || !(gV > gU && bottomFree(u.node))) return undefined;
  const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  if (u.col === v.col && !isAttachedBoundary(u.node) && reserveColRun(ctx, u.col, gU, gV, e)) {
    markExclusiveColRun(ctx, u.col);
    return {
      edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'drop',
      points: verticalLine(e.from, 'bottom', e.to, 'top'),
    };
  }
  // 終端チャネルの直下のセルにノードがいると、そのノードへの最終降下と同じ x で
  // 重なる(チャネル帯の中は離散区間で見えない)。空のときだけ縦出しする
  if (
    !cellOccupied(ctx, v.lane, v.row, u.col) &&
    reserveColRun(ctx, u.col, gU, chV, e)
  ) {
    const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'above', gU, u.col);
    return {
      edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'channel-approach',
      points: verticalZ(e.from, 'bottom', channelY(v.lane, v.row, tCh), e.to, 'top'),
    };
  }
  if (hasSequenceOut(ctx, e.from)) return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
  return undefined;
}

/**
 * 上向き: 上ポートが入りとして使われないことが静的に分かるノード(topFree)なら
 * top から出す(S-56 条件付きポート開放)。
 */
function messageUpward({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'msg' || !(gV < gU && topFree(ctx, u))) return undefined;
  const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  if (
    !cellOccupied(ctx, v.lane, v.row, u.col) &&
    !(v.row > 0 && cellOccupied(ctx, v.lane, v.row - 1, u.col)) &&
    reserveColRun(ctx, u.col, chV, gU, e)
  ) {
    const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'below', gU, u.col);
    return {
      edgeId: e.id, fromSide: 'top', toSide: 'top', pattern: 'channel-approach',
      points: verticalZ(e.from, 'top', channelY(v.lane, v.row, tCh), e.to, 'top'),
    };
  }
  return planMessageFromTopViaGutter(ctx, e, u, v, gU, chV);
}

/**
 * top が入りに使われていても bottom が空いていれば、短い下向きスタブから
 * 溝へ出す。右ポートへ戻してシーケンスと幹線を共有させない。
 */
function messageBottomStub({ ctx, e, u, v, gU }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'msg' || !(bottomFree(u.node) && hasSequenceOut(ctx, e.from))) return undefined;
  const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
}

/** どの縦出しも成立しないメッセージは右出しで上頂点へ(planIntoTop)。 */
function messageIntoTop({ ctx, e, u, v, gU }: ForwardCase): EdgePlan | undefined {
  if (e.kind !== 'msg') return undefined;
  return planIntoTop(ctx, e, u, v, gU);
}

// ---- 同一行 ----

/**
 * 境界イベントから同じ行の右のノードへ: 境界イベントは対象 Activity の辺の高さに載るので
 * 基線の 2 点直線は斜線になる。対象の左の溝(入りブロック)で基線へ降りる 3 区間にする。
 */
function boundarySameRow({ ctx, e, u, v, gU, gV, sameRow, rowFree }: ForwardCase): EdgePlan | undefined {
  if (!(sameRow && rowFree && isAttachedBoundary(u.node) && u.col < v.col && (e.kind === 'seq' || e.kind === 'assoc'))) return undefined;
  const gx = v.col;
  const run = allocGutter(ctx, gx, 'entry', gU, gV);
  const dstY = e.kind === 'seq' ? portY(e.to, 'left') : nodeCY(e.to, -10);
  noteLabelNeed(ctx, e, u.col + 1);
  noteRowRun(ctx, v.lane, v.row, gutterScale(gx), v.col, e);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'row-approach',
    points: [
      { x: portX(e.from, 'right'), y: portY(e.from, 'right') },
      { x: gutterX(gx, 'entry', run), y: portY(e.from, 'right') },
      { x: gutterX(gx, 'entry', run), y: dstY },
      { x: portX(e.to, 'left'), y: dstY },
    ],
  };
}

/** direct: 同一行・間にノード無し。 */
function directSequence({ ctx, e, u, v, sameRow, rowFree }: ForwardCase): EdgePlan | undefined {
  if (!(sameRow && rowFree && e.kind === 'seq')) return undefined;
  noteLabelNeed(ctx, e, u.col + 1);
  noteRowRun(ctx, u.lane, u.row, u.col, v.col, e);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'direct',
    points: [
      { x: portX(e.from, 'right'), y: portY(e.from, 'right') },
      { x: portX(e.to, 'left'), y: portY(e.to, 'left') },
    ],
  };
}

/**
 * 同一行のデータ関連は基線から10px上へ分離する。工程のシーケンス出入口と
 * 同一点・同一スタブを共有させない。doc の左辺は関連専用。
 * 時間を戻る関連(対象が左)は基線に乗せない: 右出→左入の直線が自身や途中ノードを貫く。
 */
function directAssoc({ ctx, e, u, v, sameRow, rowFree }: ForwardCase): EdgePlan | undefined {
  if (!(sameRow && rowFree && e.kind === 'assoc' && u.col < v.col)) return undefined;
  noteLabelNeed(ctx, e, u.col + 1);
  return {
    edgeId: e.id, fromSide: 'right', toSide: 'left', pattern: 'direct',
    points: [
      { x: portX(e.from, 'right'), y: nodeCY(e.from, -10) },
      { x: portX(e.to, 'left'), y: nodeCY(e.to, -10) },
    ],
  };
}

// ---- ゲートウェイの分岐 ----

/**
 * 改善候補では、同一行の途中ノードを飛び越す非本流を下側へ置く。
 * 図全体の合法性と可読性スコアが改善したときだけ compile.ts が採用する。
 */
function gatewayDetourSameRow({ ctx, e, u, v, gU, gV, sameRow, rowFree }: ForwardCase): EdgePlan | undefined {
  if (!(
    ctx.optimizeReadability && e.kind === 'seq' && isGw(u.node) && !e.onSpine &&
    sameRow && v.col > u.col && !rowFree
  )) return undefined;
  const useBelow = alternativeBelow(ctx, u);
  const channelRow = useBelow ? u.row + 1 : u.row;
  const channelPos = ctx.globalChannel.get(rowKey(u.lane, channelRow));
  const sourceFree = useBelow ? true : topFree(ctx, u);
  const targetFree = useBelow
    ? bottomFree(v.node) && noDownwardOut(ctx, v, gV) && !needsBottomMessagePort(ctx, v.node.id)
    : true;
  if (!(
    channelPos !== undefined && sourceFree && targetFree &&
    reserveColRun(ctx, u.col, gU, channelPos, e) &&
    reserveColRun(ctx, v.col, gV, channelPos, e)
  )) return undefined;
  const side: PortSide = useBelow ? 'bottom' : 'top';
  const tCh = allocChannel(
    ctx, u.lane, channelRow, u.col, v.col, useBelow ? 'above' : 'below', gU, u.col,
  );
  return {
    edgeId: e.id, fromSide: side, toSide: side, pattern: 'channel-approach',
    points: verticalZ(e.from, side, channelY(u.lane, channelRow, tCh), e.to, side),
  };
}

/**
 * rise: drop の鏡像。上側の非本流分岐で自列が対象行まで空いていれば、north から
 * 自列中心を昇り、対象行で曲がって左から入る(1 折れ)。
 */
function rise({ ctx, e, u, v, gU, gV, rowFree }: ForwardCase): EdgePlan | undefined {
  if (!(
    ctx.optimizeReadability && isGw(u.node) && !e.onSpine && gV < gU && !isGw(v.node) &&
    topFree(ctx, u) && rowFree && !cellOccupied(ctx, v.lane, v.row, u.col) &&
    canReserveRowRun(ctx, v.lane, v.row, u.col, v.col, e.from, e.to) &&
    reserveColRun(ctx, u.col, gV, gU, e)
  )) return undefined;
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

/** 上側の非本流分岐は north から出す(main の east と共有しない)。 */
function gatewayNorthRowApproach({ ctx, e, u, v, gU, gV, rowFreeWide }: ForwardCase): EdgePlan | undefined {
  if (!(
    ctx.optimizeReadability && isGw(u.node) && !e.onSpine && gV < gU &&
    topFree(ctx, u) && rowFreeWide
  )) return undefined;
  const chU = ctx.globalChannel.get(rowKey(u.lane, u.row))!;
  if (!(
    canReserveRowRun(ctx, v.lane, v.row, gutterScale(u.col + 1), v.col, e.from, e.to) &&
    reserveColRun(ctx, u.col, chU, gU, e)
  )) return undefined;
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

/**
 * ゲートウェイの下方向分岐。自列の中心線を対象行まで直進できれば drop、
 * できなくても south から出す(east へ戻すと本流条件と同じ頂点を共有してしまう)。
 */
function gatewayDownward({ ctx, e, u, v, gU, gV, rowFree }: ForwardCase): EdgePlan | undefined {
  if (!(isGw(u.node) && !e.onSpine && gV > gU)) return undefined;
  if (
    !isGw(v.node) &&
    !cellOccupied(ctx, v.lane, v.row, u.col) &&
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
  const chV = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  // msg 縦出しと同じガード: 自列中心を対象行上チャネルまで降りて横走する中間形。
  if (
    !cellOccupied(ctx, v.lane, v.row, u.col) &&
    reserveColRun(ctx, u.col, gU, chV, e)
  ) {
    const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'above', gU, u.col);
    return {
      edgeId: e.id, fromSide: 'bottom', toSide: 'top', pattern: 'channel-approach',
      points: verticalZ(e.from, 'bottom', channelY(v.lane, v.row, tCh), e.to, 'top'),
    };
  }
  return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
}

// ---- 行違いの入り ----

/**
 * 行違いでゲートウェイに入る辺は頂点入り(channel-approach 系)に限定する。
 * 同一行の前任者が無く、行違いの入りがこの 1 本だけなら西頂点は空いている:
 * 通常の左入り(row-approach / channel-approach)に任せ、上頂点へ回り込まない。
 */
function intoGatewayFromOtherRow({ ctx, e, u, v, gU, gV, sameRow }: ForwardCase): EdgePlan | undefined {
  if (!(!sameRow && isGw(v.node))) return undefined;
  const l = planRowThenColumn(ctx, e, u, v, gU, gV);
  if (l) return l;
  if (!westFree(ctx, v, e)) return planIntoTop(ctx, e, u, v, gU);
  return undefined;
}

/** 交差軸プラス側からイベントへ着くシーケンスも頂点入り。上へ回ると図形の裏側へ出る。 */
function intoEventFromBelow({ ctx, e, u, v, gU, gV, sameRow }: ForwardCase): EdgePlan | undefined {
  if (!(!sameRow && isEventKind(v.node.kind) && gU > gV && eventBottomOpen(ctx, v.node))) return undefined;
  return planRowThenColumn(ctx, e, u, v, gU, gV) ?? planIntoTop(ctx, e, u, v, gU);
}

// ---- 出口右の溝を使う一般形 ----

/** 以後の形はすべて出口すぐ右の溝を使うので、ラベル幅をその溝に算入する(副作用のみ)。 */
function noteExitLabel({ ctx, e, u }: ForwardCase): EdgePlan | undefined {
  noteLabelNeed(ctx, e, u.col + 1);
  return undefined;
}

/**
 * row-approach: 溝を垂直移動して対象行の基線に乗る。
 * 時間を戻るストア関連は基線に乗せない。他所出のシーケンス列を貫いて途中出現に見える。
 * 時間を戻る辺(対象が左)は基線に乗せない。溝から左へ向かう接近が対象や途中ノードを貫く。
 * 境界イベントから出るシーケンスは対象 Activity の辺の高さ(基線ではない)を走るので、
 * 基線の予約ではなく辺ごとのスタブ帯を予約する。基線で数えると同じ Activity の
 * 2 つの境界イベントの出線が衝突扱いになり、片方が意味のない折れを持つ回り道へ落ちる(L31)。
 */
function rowApproach({ ctx, e, u, v, gU, gV, sameRow, rowFreeWide }: ForwardCase): EdgePlan | undefined {
  const g1 = u.col + 1;
  const boundaryExit = e.kind === 'seq' && isAttachedBoundary(u.node);
  const boundaryOffset = u.node.boundarySide === 'top' ? -100 : 100;
  if (!(
    rowFreeWide && !sameRow && u.col < v.col &&
    canReserveRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e.from, e.to) &&
    (e.kind !== 'seq' || boundaryExit ||
      canReserveRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e.from, e.to)) &&
    (!boundaryExit || reserveStubRun(ctx, u.lane, u.row, boundaryOffset, u.col, gutterScale(g1), e))
  )) return undefined;
  if (boundaryExit) { /* reserveStubRun が登録済み */ }
  else if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
  noteRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e);
  const run = allocGutter(ctx, g1, 'exit', gU, gV);
  const srcY = fallbackRightY(e, e.from);
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

/** 隣接列で同じ終点へ収束する辺は、出口溝と入口溝を一度だけ使う。 */
function adjacentConvergingAssoc({ ctx, e, u, v, gU, gV, sameRow }: ForwardCase): EdgePlan | undefined {
  const g1 = u.col + 1;
  const adjacentPeer = occupantAt(ctx, v.lane, v.row, u.col);
  if (!(
    e.kind === 'assoc' && !isDocLike(u.node.kind) && v.node.kind === 'doc' &&
    u.lane === v.lane && !sameRow && v.col === g1 && adjacentPeer !== undefined &&
    ctx.g.edges.some((other) => other.from === adjacentPeer && other.to === e.to)
  )) return undefined;
  noteRowRun(ctx, v.lane, v.row, gutterScale(v.col), v.col, e);
  noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(v.col), e);
  const run = allocGutter(ctx, v.col, 'entry', gU, gV);
  const srcY = fallbackRightY(e, e.from);
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

/** channel-approach: 対象行の上チャネル経由で、対象列すぐ左の溝から基線に降りる(常に合法)。 */
function channelApproach({ ctx, e, u, v, gU, gV }: ForwardCase): EdgePlan {
  const g1 = u.col + 1;
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  const r1 = allocGutter(ctx, g1, 'exit', gU, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, g1 - 0.5, v.col - 0.5, gU < chPos ? 'above' : 'below', gU, g1 - 0.5);
  const gv = v.col; // 対象列のすぐ左の溝
  const r2 = allocGutter(ctx, gv, 'entry', chPos, gV);
  if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
  noteRowRun(ctx, v.lane, v.row, gutterScale(gv), v.col, e);
  const srcY = fallbackRightY(e, e.from);
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

/** 試す順序。前にあるほど優先(可読性の高い形)。channelApproach は常に成立するので末尾の既定。 */
const FORWARD_PATTERNS: readonly ForwardPattern[] = [
  assocDropStraight, assocSameColumnSide, assocRiseStraight, assocIntoNonDoc, assocDropToDoc, assocRailBelow, assocRailCoWriter,
  assocRowThenColumn,
  messageIntoBoundary, messageAcrossPools, messageDownward, messageUpward, messageBottomStub, messageIntoTop,
  boundarySameRow, directSequence, directAssoc,
  gatewayDetourSameRow, rise, gatewayNorthRowApproach, gatewayDownward,
  intoGatewayFromOtherRow, intoEventFromBelow,
  noteExitLabel, rowApproach, adjacentConvergingAssoc,
];

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
    !cellOccupied(ctx, v.lane, v.row + 1, v.col) &&
    (bottomFree(v.node) || eventBottomOpen(ctx, v.node)) &&
    !needsBottomMessagePort(ctx, v.node.id);
  const farTargetGutter =
    ctx.optimizeReadability && fromBelow && !canEnterBottom && u.lane === v.lane && u.col < v.col &&
    !nodeBetweenOnRow(ctx, u.lane, u.row, u.col + 1, v.col);
  const g1 = farTargetGutter ? v.col + 1 : u.col + 1;
  noteLabelNeed(ctx, e, g1);
  if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
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
