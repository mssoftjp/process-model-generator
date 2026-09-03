// プール索引。レーン→プール、プール→宣言順位、ノード→プールを 1 回だけ作り、各相で共有する。
// 以前は 8 ファイル 14 箇所が同じ Map を作り直していた(route では辺ごとに毎回)。
// 黒箱プール(C-51)は id 自身がプールで、辺の fromPool/toPool に現れる。

import type { IrLane, IrPool } from './types.ts';

export interface PoolIndex {
  /** レーンの所属プール(暗黙の単一プールなら undefined) */
  poolOfLane(laneId: string): string | undefined;
  /** ノード id の所属プール(未知のノードは undefined) */
  poolOfNode(nodeId: string): string | undefined;
  /** プールの宣言順位(上から 0, 1, ...)。未知のプールは undefined */
  indexOf(poolId: string | undefined): number | undefined;
  /** ノード id の所属プールの順位 */
  indexOfNode(nodeId: string): number | undefined;
  /** 2 プールが上下に隣接するか */
  adjacent(a: string | undefined, b: string | undefined): boolean;
  readonly size: number;
}

export function buildPoolIndex(
  g: { pools: readonly IrPool[]; lanes: readonly IrLane[]; nodes: readonly { id: string; lane: string }[] },
): PoolIndex {
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const index = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const laneOfNode = new Map(g.nodes.map((n) => [n.id, n.lane]));
  const poolOfNode = (id: string): string | undefined => {
    const lane = laneOfNode.get(id);
    return lane === undefined ? undefined : poolOfLane.get(lane);
  };
  const indexOf = (pool: string | undefined) => (pool === undefined ? undefined : index.get(pool));
  return {
    poolOfLane: (laneId) => poolOfLane.get(laneId),
    poolOfNode,
    indexOf,
    indexOfNode: (id) => indexOf(poolOfNode(id)),
    adjacent: (a, b) => {
      const ia = indexOf(a);
      const ib = indexOf(b);
      return ia !== undefined && ib !== undefined && Math.abs(ia - ib) === 1;
    },
    size: g.pools.length,
  };
}
