// イベント外置きラベルの退避規則(C-65 / S-62)。
// 交差軸プラス側(横図=下 / 縦図=右)のプールと通信するイベントは、ラベルをマイナス側へ
// 逃がす。逃がさないとラベルがポートを塞ぎ、線が図形の裏側へ回る。
// P1(計測)と P3(経路計画)が同じ集合を見る。片方だけ変えるとラベルとポートが衝突する。

import { isAttachedBoundary, isEventKind } from './bpmn.ts';
import { buildPoolIndex } from './pools.ts';
import type { NormGraph } from './types.ts';

/**
 * 対象 Activity の上辺に掛ける境界イベントの id 集合(C-53 / S-53)。
 * 境界イベントは Activity のどの辺にも置けるので、メッセージが上のプール(黒箱を含む)から
 * 届くものは上辺に置き、送信元から真下へ一直線で入れる。それ以外は下辺。
 * P1(計測の張り出し)・P3(経路)・P4(重ね位置)が同じ集合を見る。
 */
export function boundaryTopEvents(g: NormGraph): Set<string> {
  const pools = buildPoolIndex(g);
  const out = new Set<string>();
  for (const n of g.nodes) {
    if (!isAttachedBoundary(n)) continue;
    const own = pools.indexOfNode(n.id);
    if (own === undefined) continue;
    const fromAbove = g.edges.some((e) => {
      if (e.kind !== 'msg' || e.to !== n.id) return false;
      const from = e.fromPool ? pools.indexOf(e.fromPool) : pools.indexOfNode(e.from);
      return from !== undefined && from < own;
    });
    if (fromAbove) out.add(n.id);
  }
  return out;
}

/** 交差軸マイナス側へラベルを逃がすイベントの id 集合 */
export function crossMinusLabelEvents(g: NormGraph): Set<string> {
  const pools = buildPoolIndex(g);
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const poolIdx = (id: string | undefined) => pools.indexOf(id);
  const nodePoolIdx = (id: string) => pools.indexOfNode(id);
  for (const e of g.edges) {
    if (e.kind !== 'msg') continue;
    if (e.fromPool) {
      const fi = poolIdx(e.fromPool);
      const vi = nodePoolIdx(e.to);
      const v = nodeById.get(e.to);
      if (fi !== undefined && vi !== undefined && fi > vi && v && isEventKind(v.kind)) out.add(v.id);
      continue;
    }
    if (e.toPool) {
      const ui = nodePoolIdx(e.from);
      const ti = poolIdx(e.toPool);
      const u = nodeById.get(e.from);
      if (ui !== undefined && ti !== undefined && ti > ui && u && isEventKind(u.kind)) out.add(u.id);
      continue;
    }
    const u = nodeById.get(e.from);
    const v = nodeById.get(e.to);
    const ui = u ? pools.indexOf(pools.poolOfLane(u.lane)) : undefined;
    const vi = v ? pools.indexOf(pools.poolOfLane(v.lane)) : undefined;
    if (ui === undefined || vi === undefined || Math.abs(ui - vi) !== 1) continue;
    if (ui < vi && u && isEventKind(u.kind)) out.add(u.id);
    if (vi < ui && v && isEventKind(v.kind)) out.add(v.id);
  }
  return out;
}
