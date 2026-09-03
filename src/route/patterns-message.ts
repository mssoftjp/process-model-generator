// P3 メッセージフローの経路(隣接プール回廊の Z 形、非隣接プールの外周、黒箱プール、境界イベント宛)。

import { isAttachedBoundary, isEventKind } from '../bpmn.ts';
import type {
  EdgePlan, NormEdge, NormNode, PortSide, SymX,
} from '../types.ts';
import { rowKey, cellOf, reserveColRun, canReserveColRun, markExclusiveColRun, gutterScale, reserveStubRun, noteStubRun, fallbackOffset, allocGutter, allocChannel, allocPoolGap, noteLabelNeed, gapOrderConsistent } from './context.ts';
import type { Ctx, Cell } from './context.ts';
import { portX, portY, portStubY, gutterX, nodeCX, nodeCY, channelY, poolChannelY } from './symbols.ts';
import { isGw, blackboxLane, bottomFree, eventLabelMovedUp, eventHasBottomOut, eventBottomOpen, topFree, faceQuiet, topUsersSlottable, bottomOutFree, fallbackRightY, adjacentPoolGap, poolPairIndices } from './predicates.ts';

/**
 * 隣接プール間メッセージ: 列溝に面した左右辺の専用点を、プール間水平回廊で結ぶ。
 * 参加者内部の行チャネルを横幹線にせず、境界直後の無意味な小折れも作らない。
 */
export function planAcrossPoolGap(ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gap: number): EdgePlan {
  const ui = ctx.pools.indexOf(ctx.pools.poolOfLane(u.lane))!;
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
  let fromSide: PortSide = sameCol ? 'right' : rightward ? 'left' : 'right';
  let toSide: PortSide = sameCol ? 'left' : rightward ? 'left' : 'right';
  // 両端だけを直近の列溝へ逃がし、長い水平成分はプール間回廊に閉じる。
  // 中心列直結は後続辺との重なりを局所判定できないため採用しない。
  let srcG = fromSide === 'left' ? u.col : u.col + 1;
  let dstG = toSide === 'left' ? v.col : v.col + 1;
  // Cycle C: 対象の反対面。左方向到着が対象の右溝を貫いて本流水平と交差するのを避ける。
  if (ctx.gapDestFlip.has(e.id)) {
    toSide = toSide === 'left' ? 'right' : 'left';
    dstG = toSide === 'left' ? v.col : v.col + 1;
  }
  const srcYOffset = down ? 8 : -8;
  // 同じ行の隣ノードが同じ溝へ同じ高さで出ていれば、反対側の溝から出す(スタブの重なり防止)
  const stub = (side: PortSide, c: number, g: number) =>
    side === 'left' ? [gutterScale(g), c] as const : [c, gutterScale(g)] as const;
  if (!reserveStubRun(ctx, u.lane, u.row, srcYOffset, ...stub(fromSide, u.col, srcG), e)) {
    const altSide: PortSide = fromSide === 'left' ? 'right' : 'left';
    const altG = altSide === 'left' ? u.col : u.col + 1;
    if (reserveStubRun(ctx, u.lane, u.row, srcYOffset, ...stub(altSide, u.col, altG), e)) {
      fromSide = altSide;
      srcG = altG;
    }
  }
  let dstMagnitude = toSide === 'left' ? 12 : 14;
  let dstYOffset = down ? -dstMagnitude : dstMagnitude;
  if (!reserveStubRun(ctx, v.lane, v.row, dstYOffset, ...stub(toSide, v.col, dstG), e)) {
    const altSide: PortSide = toSide === 'left' ? 'right' : 'left';
    const altG = altSide === 'left' ? v.col : v.col + 1;
    const altMag = altSide === 'left' ? 12 : 14;
    const altOffset = down ? -altMag : altMag;
    if (reserveStubRun(ctx, v.lane, v.row, altOffset, ...stub(altSide, v.col, altG), e)) {
      toSide = altSide;
      dstG = altG;
      dstMagnitude = altMag;
      dstYOffset = altOffset;
    }
  }
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
  // 同列の往復対(要求と返信が同じ 2 ノード間で共に一直線)は、互いを ±6px にずらした
  // 2 本の平行な縦線にする。両端とも同じ 2 辺しか面を使わないので、ずらしは両端で一致する。
  // 先に置く側(要求)は対が未計画でも対の存在だけで -6 に寄せておく。後の側(返信)は +6。
  // 対が結局一直線にならなくても 6px のずれが残るだけで害はない。
  const pair = straight
    ? ctx.g.edges.find((o) => o.kind === 'msg' && o.from === e.to && o.to === e.from)
    : undefined;
  const pairPlan = pair ? ctx.planned.get(pair.id) : undefined;
  const pairId = pair?.id;
  // 同一始点の通信は幹線を共有でき(S-32)、同一終点の通信は収束できる(S-91)ので、
  // 同じ面を使っても一直線と重なってよい。それ以外の非 seq が面を使うなら側面経路へ。
  const sameSourceMsg = (o: NormEdge) => o.kind === 'msg' && o.from === u.node.id;
  const sameTargetMsg = (o: NormEdge) => o.kind === 'msg' && o.to === v.node.id;
  if (
    straight &&
    !(faceQuiet(ctx, u.node.id, fromSide, e, pairId, sameSourceMsg) &&
      faceQuiet(ctx, v.node.id, toSide, e, pairId, sameTargetMsg))
  ) return undefined;
  // 同じ面から出る seq 戻りはスロット分離されないので、縦出しと同一点になる(O-8)
  const returnExitsFace = ctx.g.edges.some((o) => {
    if (o.from !== u.node.id || o.kind !== 'seq' || !o.isReturn) return false;
    const done = ctx.planned.get(o.id);
    return done ? done.fromSide === fromSide : true;
  });
  if (returnExitsFace) return undefined;
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
  if (!canReserveColRun(ctx, u.col, gU, gapPos, e.from, e.to, shareU, pairId)) return undefined;
  if (!canReserveColRun(ctx, v.col, gapPos, gV, e.from, e.to, shareV, pairId)) return undefined;
  reserveColRun(ctx, u.col, gU, gapPos, e, e.from, shareU, pairId);
  if (straight) markExclusiveColRun(ctx, u.col);
  else ctx.colRuns.get(u.col)!.at(-1)!.gap = { ...gapRun, upperSide: down };
  reserveColRun(ctx, v.col, gapPos, gV, e, e.from, shareV, pairId);
  if (straight) markExclusiveColRun(ctx, v.col);
  else ctx.colRuns.get(v.col)!.at(-1)!.gap = { ...gapRun, upperSide: !down };
  if (straight) {
    const PAIR = 6;
    // 対の両端は同じ 2 ノードなので、先に置いた側を左(-6)、後の側を右(+6)にすると向きが揃う
    const off = pair === undefined ? 0 : pairPlan ? PAIR : -PAIR;
    return {
      edgeId: e.id, fromSide, toSide, pattern: 'drop',
      points: [
        { x: nodeCX(e.from, off), y: portY(e.from, fromSide) },
        { x: nodeCX(e.to, off), y: portY(e.to, toSide) },
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
 * 境界イベント宛メッセージ(C-53 / S-53)。境界イベントは対象 Activity の辺に掛かる円で、
 * 上のプールから届くものは上辺、それ以外は下辺に置かれる(正規化の boundarySide)。
 * 送信元がその辺の側にあれば、送信元の面から回廊(隣接プール)または対象行の上チャネル
 * (同一プール)を経て円へ真っ直ぐ入る Z 形。そうでなければ対象列の右溝を縦回廊にして
 * 円の外側のスタブから入る。非隣接プールは対象外。
 */
export function planIntoBoundary(
  ctx: Ctx, e: NormEdge, u: Cell, v: Cell, gU: number, gV: number,
): EdgePlan | undefined {
  if (isAttachedBoundary(u.node)) return undefined;
  const hostId = v.node.attachedTo!;
  const onTop = v.node.boundarySide === 'top';
  const toSide: PortSide = onTop ? 'top' : 'bottom';
  const gap = adjacentPoolGap(ctx, u, v);
  const pair = poolPairIndices(ctx, u, v);
  if (gap === undefined && pair && pair[0] !== pair[1]) return undefined; // 非隣接プールは既存経路に任せる
  const down = gap !== undefined ? ctx.pools.indexOf(ctx.pools.poolOfLane(u.lane)) === gap : gU < gV;
  const gx = v.col + 1;

  // 送信元の面から円へ真っ直ぐ入る Z 形。送信元がタスクなら同じ面の他の通信とスロット分離される。
  // 受信側の縦線は円の x(対象の右半分)にあり対象中心の縦線とは物理的に離れるので、
  // 対象の面に着く走行とは共有できる(shareFace = 対象)。
  const straightIn = (): EdgePlan | undefined => {
    if (down !== onTop) return undefined;
    if (isGw(u.node)) return undefined;
    const fromSide: PortSide = down ? 'bottom' : 'top';
    if (down) {
      if (!(bottomFree(u.node) || eventLabelMovedUp(ctx, u.node.id))) return undefined;
    } else {
      if (!topFree(ctx, u) && !(u.node.kind === 'task' && topUsersSlottable(ctx, u))) return undefined;
      if (isEventKind(u.node.kind) && eventLabelMovedUp(ctx, u.node.id)) return undefined;
    }
    const shareU = u.node.kind === 'task' ? u.node.id : undefined;
    if (shareU === undefined && !faceQuiet(ctx, u.node.id, fromSide, e)) return undefined;
    const returnExitsFace = ctx.g.edges.some((o) => {
      if (o.from !== u.node.id || o.kind !== 'seq' || !o.isReturn) return false;
      const done = ctx.planned.get(o.id);
      return done ? done.fromSide === fromSide : true;
    });
    if (returnExitsFace) return undefined;
    if (gap !== undefined) {
      const gapPos = ctx.globalPoolGap.get(gap)!;
      if (!canReserveColRun(ctx, u.col, gU, gapPos, e.from, e.to, shareU)) return undefined;
      if (!canReserveColRun(ctx, v.col, gapPos, gV, e.from, e.to, hostId)) return undefined;
      reserveColRun(ctx, u.col, gU, gapPos, e, e.from, shareU);
      reserveColRun(ctx, v.col, gapPos, gV, e, e.from, hostId);
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
    // 同一プール: 送信元が上の行にあるときだけ、対象行の上チャネルから上辺の円へ降りる
    if (!down) return undefined;
    const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
    if (!(gU < chPos)) return undefined;
    if (!canReserveColRun(ctx, u.col, gU, chPos, e.from, e.to, shareU)) return undefined;
    reserveColRun(ctx, u.col, gU, chPos, e, e.from, shareU);
    const tCh = allocChannel(ctx, v.lane, v.row, u.col, v.col, 'above', gU, u.col);
    return {
      edgeId: e.id, fromSide, toSide, pattern: 'channel-approach',
      points: [
        { x: nodeCX(e.from), y: portY(e.from, fromSide) },
        { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
        { x: nodeCX(e.to), y: portY(e.to, toSide) },
      ],
    };
  };
  const z = straightIn();
  if (z) return z;

  // 対象列の右溝を縦回廊にし、円の外側のスタブ(ラベルは円の横なので跨がない)から入る
  const stubY = portStubY(e.to, toSide);
  const tail = (dstX: SymX) => [
    { x: dstX, y: stubY },
    { x: nodeCX(e.to), y: stubY },
    { x: nodeCX(e.to), y: portY(e.to, toSide) },
  ];
  // 送信側の側面スタブ: 右溝が同じ行の隣のスタブと衝突するなら左溝から出る(S-57 と同じ)
  const pickSource = (yOffset: number): { side: PortSide; g: number } => {
    const right = { side: 'right' as PortSide, g: u.col + 1 };
    if (reserveStubRun(ctx, u.lane, u.row, yOffset, u.col, gutterScale(right.g), e)) return right;
    const left = { side: 'left' as PortSide, g: u.col };
    if (reserveStubRun(ctx, u.lane, u.row, yOffset, gutterScale(left.g), u.col, e)) return left;
    return right;
  };
  if (gap !== undefined) {
    const gapPos = ctx.globalPoolGap.get(gap)!;
    const srcYOffset = down ? 8 : -8;
    const src = pickSource(srcYOffset);
    const srcRun = allocGutter(ctx, src.g, 'exit', gU, gapPos);
    const dstRun = allocGutter(ctx, gx, 'entry', gapPos, gV);
    const run = allocPoolGap(ctx, gap, down ? gutterScale(src.g) : gutterScale(gx), down ? gutterScale(gx) : gutterScale(src.g));
    return {
      edgeId: e.id, fromSide: src.side, toSide, pattern: 'channel-approach',
      points: [
        { x: portX(e.from, src.side), y: nodeCY(e.from, srcYOffset) },
        { x: gutterX(src.g, 'exit', srcRun), y: nodeCY(e.from, srcYOffset) },
        { x: gutterX(src.g, 'exit', srcRun), y: poolChannelY(gap, run) },
        { x: gutterX(gx, 'entry', dstRun), y: poolChannelY(gap, run) },
        ...tail(gutterX(gx, 'entry', dstRun)),
      ],
    };
  }
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row))!;
  const src = pickSource(fallbackOffset(e));
  const srcY = nodeCY(e.from, fallbackOffset(e));
  const r1 = allocGutter(ctx, src.g, 'exit', gU, chPos);
  const tCh = allocChannel(
    ctx, v.lane, v.row, gutterScale(src.g), gutterScale(gx), gU < chPos ? 'above' : 'below', gU, gutterScale(src.g),
  );
  const r2 = allocGutter(ctx, gx, 'entry', chPos, gV);
  return {
    edgeId: e.id, fromSide: src.side, toSide, pattern: 'channel-approach',
    points: [
      { x: portX(e.from, src.side), y: srcY },
      { x: gutterX(src.g, 'exit', r1), y: srcY },
      { x: gutterX(src.g, 'exit', r1), y: channelY(v.lane, v.row, tCh) },
      { x: gutterX(gx, 'entry', r2), y: channelY(v.lane, v.row, tCh) },
      ...tail(gutterX(gx, 'entry', r2)),
    ],
  };
}

/**
 * 非隣接プール間メッセージ: 両端に最も近いプール間回廊から右外周へ出し、
 * 中間プールの枠外を縦走する。中間参加者の内部を通信線で貫かない(C-40)。
 */
export function planAcrossPoolExterior(
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
  noteStubRun(ctx, u.lane, u.row, srcYOffset, u.col, gutterScale(srcG), e);
  noteStubRun(ctx, v.lane, v.row, dstYOffset, v.col, gutterScale(dstG), e);

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
 * 上向きメッセージの中心列が塞がれている場合も、シーケンスと右ポートを共有させない。
 * top から自レーンの上チャネルへ抜け、右溝を上って対象の上頂点へ入る。
 */
export function planMessageFromTopViaGutter(
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
 * 黒箱プール参照メッセージ(C-51): 枠そのものがポート。
 * 帯が相手側にあるとき、端点はプール帯の縁に垂直に付く。
 * 同列直進できれば bottom→縁 / 縁→top の一直線。だめなら溝を経由する。
 */
export function planPoolMsg(ctx: Ctx, e: NormEdge): EdgePlan {
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
    noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
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
  // 下辺入りは直下のチャネルを使う。直下のセルにノードがいると、そのノードへの上辺降下と
  // 同じ列中心で重なる(planIntoTop の canEnterBottom と同じ条件)
  const belowClear = !ctx.occupied.has(`${v.lane}:${v.row + 1}:${v.col}`);
  const faceOpen = face === 'top' || (eventBottomOpen(ctx, v.node) && belowClear);
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
