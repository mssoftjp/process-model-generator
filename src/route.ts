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
//
// 実装は src/route/ に分かれる: context(文脈と予約)、symbols(記号座標)、predicates(静的述語)、
// patterns-forward / patterns-message / patterns-return(経路パターン)、tracks(後段のトラック順)。

import type { EdgePlan, NormGraph, Placement, RoutePlan } from './types.ts';
import { buildContext, type RouteOptions } from './route/context.ts';
import { planForward } from './route/patterns-forward.ts';
import { planPoolMsg } from './route/patterns-message.ts';
import { planReturn } from './route/patterns-return.ts';
import { separateSharedEntries, bundleSameOrigin, assignPoolGapTracks, assignGutterTracks, assignChannelTracks } from './route/tracks.ts';

export type { RouteOptions } from './route/context.ts';

export function route(
  g: NormGraph, p: Placement, optimizeReadability = false, options?: RouteOptions,
): RoutePlan {
  const ctx = buildContext(g, p, optimizeReadability, options);

  const plans: EdgePlan[] = [];
  for (const e of g.edges.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    const plan = e.fromPool || e.toPool
      ? planPoolMsg(ctx, e)
      : e.isReturn ? planReturn(ctx, e) : planForward(ctx, e);
    plans.push(plan);
    ctx.planned.set(e.id, plan);
  }
  // 回廊トラックを先に決め、同じ面に集まる通信のスロット順をトラック順に合わせる(梯子形)
  const { poolGapTracks, poolGapRunTrack } = assignPoolGapTracks(ctx);
  separateSharedEntries(ctx, plans, poolGapRunTrack);
  bundleSameOrigin(ctx, plans);

  const { gutterTracks, gutterRunTrack } = assignGutterTracks(ctx);
  const { channelTracks, channelRunTrack } = assignChannelTracks(ctx);
  return {
    plans, gutterTracks, channelTracks, channelRunTrack, gutterRunTrack,
    poolGapTracks, poolGapRunTrack, gutterLabelNeed: ctx.gutterLabelNeed,
    poolExteriorGutter: ctx.poolExteriorGutter,
  };
}
