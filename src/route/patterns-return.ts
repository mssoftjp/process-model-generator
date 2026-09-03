// P3 戻り辺(C-25)。改善候補はループ外周、基準候補は対象行の上チャネルを逆走する。

import { isAttachedBoundary } from '../bpmn.ts';
import type {
  EdgePlan, NormEdge, PortSide,
} from '../types.ts';
import { rowKey, cellOccupied, cellOf, reserveColRun, noteRowRun, gutterScale, noteStubRun, fallbackOffset, allocGutter, allocChannel } from './context.ts';
import type { Ctx } from './context.ts';
import { portX, portY, gutterX, nodeCX, channelY, verticalZ } from './symbols.ts';
import { isGw, needsBottomMessagePort, bottomFree, topFree, noDownwardOut, fallbackRightY } from './predicates.ts';

export function planReturn(ctx: Ctx, e: NormEdge): EdgePlan {
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
      // 境界イベントの外向きの面は受信メッセージの入口(S-53)なので縦出ししない
      const sourceDirect = !isAttachedBoundary(u.node) &&
        (sourceSide === 'top' ? topFree(ctx, u) : bottomFree(u.node));
      if (sourceDirect && reserveColRun(ctx, u.col, outer, gU, e)) {
        const t = allocChannel(
          ctx, u.lane, outerRow, v.col, u.col,
          outer < gU ? 'below' : 'above', gU, u.col,
        );
        return {
          edgeId: e.id, fromSide: sourceSide, toSide: targetSide, pattern: 'return',
          points: verticalZ(e.from, sourceSide, channelY(u.lane, outerRow, t), e.to, targetSide),
        };
      }
      const rUp = allocGutter(ctx, gup, 'exit', gU, outer);
      const t = allocChannel(
        ctx, u.lane, outerRow, v.col, gup - 0.5,
        outer < gU ? 'below' : 'above', gU, gup - 0.5,
      );
      const srcY = fallbackRightY(e, e.from);
      if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(gup), e);
      else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(gup), e);
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
      points: verticalZ(e.from, 'top', channelY(v.lane, v.row, t), e.to, 'top'),
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
    !cellOccupied(ctx, v.lane, v.row, u.col) &&
    !(v.row > 0 && cellOccupied(ctx, v.lane, v.row - 1, u.col)) &&
    reserveColRun(ctx, u.col, chV, gU, e)
  ) {
    const t = allocChannel(ctx, v.lane, v.row, v.col, u.col, 'below', gU, u.col);
    return {
      edgeId: e.id, fromSide: 'top', toSide: 'top', pattern: 'return',
      points: verticalZ(e.from, 'top', channelY(v.lane, v.row, t), e.to, 'top'),
    };
  }
  const gup = u.col + 1; // 自列すぐ右の溝を昇る
  const rUp = allocGutter(ctx, gup, 'exit', gU, chV);
  const t = allocChannel(ctx, v.lane, v.row, v.col, gup - 0.5, gU < chV ? 'above' : 'below', gU, gup - 0.5);
  const srcY = fallbackRightY(e, e.from);
  if (e.kind === 'seq') noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(gup), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(gup), e);
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
