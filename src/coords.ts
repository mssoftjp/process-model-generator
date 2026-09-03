// P4: 座標化。列幅・行高・回廊幅を内容寸法と予約トラック数から合算する。
// 全座標は接頭和であり、探索も反復も無い。後段(P5)が幅を broaden することはない
// (容量は P3 が数え終えているため、ここでは座標だけを決める)。
//
// computeCoords 自体は論理軸(x=主軸/時間, y=交差軸/レーン)で計算し、縦図は呼び出し側が
//   - セル張り出しを transposeCells で論理軸へ写してから渡し
//   - 出力(座標・折れ線)を転置して実座標にする
// 図形寸法(shapeW/H)はテキスト由来で回転しないため、転置はセルの「軸への配分」
// だけを入れ替える。向きの入り口は P1(回転しないテキストの計測)と P4/P5(転置)の
// 二つだけで、P0・P2・P3 は向きを知らない(構造の向き不変量)。

import { isAttachedBoundary } from './bpmn.ts';
import { EVENT_R } from './measure.ts';
import { buildPoolIndex } from './pools.ts';
import { GRID, measureText, quant } from './metrics.ts';
import type { GutterSide, LaneGeom, NodeCell, NodeGeom, NormGraph, Placement, PoolGeom, PortSide, RoutePlan } from './types.ts';

export const GUTTER_BASE = 28; // 密度と可読性の均衡点
export const TRACK_PITCH = 14;
export const GUTTER_PAD = 10;
export const CH_BASE = 16;
export const CH_PAD = 10;
export const LANE_PAD = 10;
export const HEADER_W = 34;
export const POOL_HEADER_W = 34;
export const POOL_GAP_BASE = 48; // 参加者間の通信層。メッセージ水平幹線をプール内部へ置かない
export const POOL_GAP_PAD = 10;
export const PAD = 24;
export const TITLE_H = 44;
export const ROW_MIN_EXT = 20; // 空行の最小半高

export interface Coords {
  colCenterX: number[];
  gutterX: (g: number, side: GutterSide, track: number) => number;
  rowMid: Map<string, number>; // `${lane}:${row}`
  channelY: (lane: string, row: number, track: number) => number;
  poolChannelY: (gap: number, track: number) => number;
  nodeGeom: Map<string, NodeGeom>;
  lanes: LaneGeom[];
  poolGeoms: PoolGeom[];
  width: number;
  height: number;
  headerW: number;
  bandRight: number;
  titleH: number;
  portPt: (id: string, side: PortSide) => { x: number; y: number };
}

/**
 * 縦図用: セル張り出しを論理軸へ転置する。
 * 論理主軸(列幅)は実高さ方向の張り出し、論理交差軸(行高)は実幅方向の張り出しが決める。
 * shapeW/H も入れ替える(nodeGeom は転置で実寸へ戻る)。
 */
export function transposeCells(cells: Map<string, NodeCell>): Map<string, NodeCell> {
  const out = new Map<string, NodeCell>();
  for (const [id, c] of cells) {
    out.set(id, {
      ...c,
      shapeW: c.shapeH,
      shapeH: c.shapeW,
      leftExt: c.topExt,
      rightExt: c.bottomExt,
      topExt: c.leftExt,
      bottomExt: c.rightExt,
    });
  }
  return out;
}

// 縦図の溝ラベル余白: 横書きテキストは溝(実横帯)の長手方向に寝るため、
// 溝の厚みに要るのは1行分の高さだけ。横図のような「ラベル幅ぶんの拡幅」(C-62)は
// 転置すると過大な縦余白になるので、定数上限に置き換える。
export const VERT_GUTTER_LABEL_NEED = 32;

export function computeCoords(
  g: NormGraph,
  p: Placement,
  cells: Map<string, NodeCell>,
  rp: RoutePlan,
  includeTitle = true,
): Coords {
  // ---- X: 溝と列を交互に積む ----
  // 列幅は非対称: 右張り出しラベル(ゲートウェイ右上・doc 右下)は右側だけを広げる
  const maxCol = p.maxCol;
  const leftW: number[] = [];
  const rightW: number[] = [];
  for (let c = 0; c <= maxCol; c++) {
    let lw = 20;
    let rw = 20;
    for (const n of g.nodes) {
      if (p.col.get(n.id) !== c) continue;
      const cell = cells.get(n.id)!;
      lw = Math.max(lw, cell.leftExt);
      rw = Math.max(rw, cell.rightExt);
    }
    leftW.push(quant(lw));
    rightW.push(quant(rw));
  }
  const gutterCenter: number[] = [];
  const gutterLeft: number[] = [];
  const gutterExit: number[] = []; // 出ブロックのトラック数
  const gutterTotal: number[] = [];
  const colCenterX: number[] = [];
  const hasPools = g.pools.length > 0;
  const totalHeader = (hasPools ? POOL_HEADER_W : 0) + HEADER_W;
  let x = PAD + totalHeader;
  const lastGutter = rp.poolExteriorGutter ?? maxCol + 1;
  for (let gi = 0; gi <= lastGutter; gi++) {
    const t = rp.gutterTracks.get(gi) ?? { exit: 0, entry: 0 };
    const total = t.exit + t.entry;
    const label = rp.gutterLabelNeed.get(gi) ?? 0;
    const w = quant(Math.max(GUTTER_BASE, total * TRACK_PITCH + 2 * GUTTER_PAD, label + GRID));
    gutterLeft.push(x);
    gutterExit.push(t.exit);
    gutterTotal.push(total);
    gutterCenter.push(x + w / 2);
    x += w;
    if (gi <= maxCol) {
      colCenterX.push(x + leftW[gi]!);
      x += leftW[gi]! + rightW[gi]!;
    }
  }
  const width = x + PAD;
  const bandRight = rp.poolExteriorGutter === undefined ? width - PAD : gutterLeft[rp.poolExteriorGutter]!;

  // 出ブロックは左、入りブロックは右(route.ts のポート文法を参照)
  const gutterX = (gi: number, side: GutterSide, track: number): number => {
    const total = Math.max(1, gutterTotal[gi] ?? 1);
    const k = side === 'exit' ? track : (gutterExit[gi] ?? 0) + track;
    return gutterCenter[gi]! - ((total - 1) * TRACK_PITCH) / 2 + k * TRACK_PITCH;
  };

  // ---- Y: レーンごとに チャネル→行 を交互に積む ----
  const rowMid = new Map<string, number>();
  const channelTop = new Map<string, number>();
  const channelH = new Map<string, number>();
  const lanes: LaneGeom[] = [];
  const poolGapTop = new Map<number, number>();
  const poolGapH = new Map<number, number>();
  // 縦図ではタイトル帯は交差軸でなく実 y に付くため、呼び出し側が転置後に平行移動する
  const titleH = includeTitle && g.title ? TITLE_H : 0;
  let y = PAD + titleH;
  let prevPool: string | undefined | null = null;
  const poolSpan = new Map<string, { y0: number; y1: number }>();
  const pools = buildPoolIndex(g);
  for (let li = 0; li < g.lanes.length; li++) {
    const lane = g.lanes[li]!;
    // プール境界でプール溝(帯間の隙間)を挟む
    const myPool = pools.poolOfLane(lane.id);
    if (prevPool !== null && myPool !== prevPool) {
      const gap = pools.indexOf(prevPool!);
      if (gap !== undefined) {
        const tracks = rp.poolGapTracks.get(gap) ?? 0;
        const h = quant(Math.max(POOL_GAP_BASE, tracks * TRACK_PITCH + (tracks > 0 ? 2 * POOL_GAP_PAD : 0)));
        poolGapTop.set(gap, y);
        poolGapH.set(gap, h);
        y += h;
      }
    }
    prevPool = myPool;
    const laneTop = y;
    if (lane.blackbox) {
      // 黒箱プール帯(C-51)はスリム固定。ラベルは横書きなので V3 の縦ラベル算入はしない
      y = laneTop + 56;
      lanes.push({ id: lane.id, label: lane.label, blackbox: true, x: PAD, w: bandRight - PAD, y: laneTop, h: 56 });
      if (myPool !== undefined) poolSpan.set(myPool, { y0: laneTop, y1: y });
      continue;
    }
    y += LANE_PAD;
    const rows = p.laneRows.get(lane.id) ?? 1;
    for (let r = 0; r < rows; r++) {
      const key = `${lane.id}:${r}`;
      const tracks = rp.channelTracks.get(key) ?? 0;
      const ch = quant(Math.max(CH_BASE, tracks * TRACK_PITCH + 2 * CH_PAD * Math.sign(tracks)));
      channelTop.set(key, y);
      channelH.set(key, ch);
      y += ch;
      let topExt = ROW_MIN_EXT;
      let bottomExt = ROW_MIN_EXT;
      for (const n of g.nodes) {
        if (n.lane !== lane.id || p.row.get(n.id) !== r) continue;
        const cell = cells.get(n.id)!;
        topExt = Math.max(topExt, cell.topExt);
        bottomExt = Math.max(bottomExt, cell.bottomExt);
      }
      rowMid.set(key, y + quant(topExt));
      y += quant(topExt) + quant(bottomExt);
    }
    const terminalKey = `${lane.id}:${rows}`;
    const terminalTracks = rp.channelTracks.get(terminalKey) ?? 0;
    if (terminalTracks > 0) {
      const ch = quant(Math.max(CH_BASE, terminalTracks * TRACK_PITCH + 2 * CH_PAD));
      channelTop.set(terminalKey, y);
      channelH.set(terminalKey, ch);
      y += ch;
    }
    y += LANE_PAD;
    // レーン見出しの文字長を帯の最小交差スパンに算入する
    // (横図=回転文字が帯の高さを、縦図=横書き文字が帯の幅を使う)
    const headerNeed = quant(measureText(lane.label, 12) + 28);
    if (y - laneTop < headerNeed) y = laneTop + headerNeed;
    // プール名も同じ規則で交差スパンを要求する。プールの最終レーンで
    // プール全体のスパンをラベル長まで広げる(帯はレーンでタイル張りのまま、
    // 最終レーンが余白を引き受ける)。短い工程×長い部署名で隣のプール名と
    // 重なるのを防ぐ
    if (myPool !== undefined && pools.poolOfLane(g.lanes[li + 1]?.id ?? '') !== myPool) {
      const pl = g.pools.find((p) => p.id === myPool);
      if (pl) {
        const poolStart = poolSpan.get(myPool)?.y0 ?? laneTop;
        const poolNeed = quant(measureText(pl.label, 12) + 28);
        if (y - poolStart < poolNeed) y = poolStart + poolNeed;
      }
    }
    lanes.push({ id: lane.id, label: lane.label, blackbox: lane.blackbox, x: PAD, w: bandRight - PAD, y: laneTop, h: y - laneTop });
    if (myPool !== undefined) {
      const span = poolSpan.get(myPool) ?? { y0: laneTop, y1: y };
      span.y1 = y;
      if (!poolSpan.has(myPool)) poolSpan.set(myPool, span);
      else poolSpan.get(myPool)!.y1 = y;
    }
  }
  const height = y + PAD;
  const poolGeoms: PoolGeom[] = g.pools
    .filter((pl) => poolSpan.has(pl.id))
    .map((pl) => {
      const sp = poolSpan.get(pl.id)!;
      return { id: pl.id, label: pl.label, x: PAD, w: bandRight - PAD, y: sp.y0, h: sp.y1 - sp.y0 };
    });

  const channelY = (lane: string, row: number, track: number): number => {
    const key = `${lane}:${row}`;
    const tracks = Math.max(1, rp.channelTracks.get(key) ?? 1);
    const mid = channelTop.get(key)! + channelH.get(key)! / 2;
    return mid - ((tracks - 1) * TRACK_PITCH) / 2 + track * TRACK_PITCH;
  };
  const poolChannelY = (gap: number, track: number): number => {
    const tracks = Math.max(1, rp.poolGapTracks.get(gap) ?? 1);
    const mid = poolGapTop.get(gap)! + poolGapH.get(gap)! / 2;
    return mid - ((tracks - 1) * TRACK_PITCH) / 2 + track * TRACK_PITCH;
  };

  // ---- ノード幾何(図形は基線に中心合わせ) ----
  const nodeGeom = new Map<string, NodeGeom>();
  for (const n of g.nodes) {
    const cell = cells.get(n.id)!;
    const cx = colCenterX[p.col.get(n.id)!]!;
    const cy = rowMid.get(`${n.lane}:${p.row.get(n.id)}`)!;
    nodeGeom.set(n.id, {
      id: n.id, kind: n.kind, subtype: n.subtype, label: n.label, labelLines: cell.labelLines,
      lane: n.lane,
      x: cx - cell.shapeW / 2, y: cy - cell.shapeH / 2, w: cell.shapeW, h: cell.shapeH,
      cx, cy, onSpine: n.onSpine, provisional: n.provisional, synthetic: n.synthetic,
      labelSide: cell.labelSide,
      labelShift: cell.labelShift,
      eventThrow: n.eventThrow, interrupting: n.interrupting, attachedTo: n.attachedTo,
      callProcess: n.callProcess, callTaskType: n.callTaskType,
      eventSubTrigger: n.eventSubTrigger, eventSubInterrupting: n.eventSubInterrupting,
      loop: n.loop, compensation: n.compensation, adhoc: n.adhoc,
      collection: n.collection,
    });
  }
  overlayBoundaryEvents(g, nodeGeom);

  const portPt = (id: string, side: PortSide) => {
    const ng = nodeGeom.get(id)!;
    switch (side) {
      case 'left': return { x: ng.x, y: ng.cy };
      case 'right': return { x: ng.x + ng.w, y: ng.cy };
      case 'top': return { x: ng.cx, y: ng.y };
      case 'bottom': return { x: ng.cx, y: ng.y + ng.h };
    }
  };

  return { colCenterX, gutterX, rowMid, channelY, poolChannelY, nodeGeom, lanes, poolGeoms, width, height, bandRight, headerW: totalHeader, titleH, portPt };
}

/**
 * 境界イベントを対象 Activity の辺へ載せる。既定は交差軸プラス側(論理 bottom)、
 * 上のプールからメッセージを受けるものは交差軸マイナス側(論理 top)。S-53。
 */
function overlayBoundaryEvents(g: NormGraph, nodeGeom: Map<string, NodeGeom>): void {
  const groups = new Map<string, { top: string[]; bottom: string[] }>();
  for (const n of g.nodes) {
    if (!isAttachedBoundary(n) || !n.attachedTo || !nodeGeom.has(n.attachedTo)) continue;
    const group = groups.get(n.attachedTo) ?? { top: [], bottom: [] };
    (n.boundarySide === 'top' ? group.top : group.bottom).push(n.id);
    groups.set(n.attachedTo, group);
  }
  for (const [hostId, group] of groups) {
    const host = nodeGeom.get(hostId)!;
    const r = EVENT_R;
    const place = (ids: string[], onTop: boolean) => ids.forEach((id, i) => {
      const ng = nodeGeom.get(id);
      if (!ng) return;
      // 対象の辺の右半分に並べ、中心(上下ポート。文書への落としや頂点入りの列中心)を空ける。
      // 中心に置くと、境界イベント宛メッセージの縦線が対象の縦線と同じ x で重なる。
      const cx = host.x + host.w * (0.5 + (i + 1) / (2 * (ids.length + 1)));
      const cy = onTop ? host.y : host.y + host.h;
      ng.cx = cx;
      ng.cy = cy;
      ng.w = r * 2;
      ng.h = r * 2;
      ng.x = cx - r;
      ng.y = cy - r;
    });
    place(group.top, true);
    place(group.bottom, false);
  }
}
