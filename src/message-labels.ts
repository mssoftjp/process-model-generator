// イベント外置きラベルの退避規則(C-65 / S-62)。
// 交差軸プラス側(横図=下 / 縦図=右)のプールと通信するイベントは、ラベルをマイナス側へ
// 逃がす。逃がさないとラベルがポートを塞ぎ、線が図形の裏側へ回る。
// P1(計測)と P3(経路計画)が同じ集合を見る。片方だけ変えるとラベルとポートが衝突する。

import { isEventKind } from './bpmn.ts';
import type { NormGraph } from './types.ts';

/** 交差軸マイナス側へラベルを逃がすイベントの id 集合 */
export function crossMinusLabelEvents(g: NormGraph): Set<string> {
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const poolIdx = (id: string | undefined) => (id === undefined ? undefined : poolIndex.get(id));
  const nodePoolIdx = (id: string) => {
    const n = nodeById.get(id);
    return n ? poolIdx(poolOfLane.get(n.lane)) : undefined;
  };
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
    const ui = u ? poolIdx(poolOfLane.get(u.lane)) : undefined;
    const vi = v ? poolIdx(poolOfLane.get(v.lane)) : undefined;
    if (ui === undefined || vi === undefined || Math.abs(ui - vi) !== 1) continue;
    if (ui < vi && u && isEventKind(u.kind)) out.add(u.id);
    if (vi < ui && v && isEventKind(v.kind)) out.add(v.id);
  }
  return out;
}
