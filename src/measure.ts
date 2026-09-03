// P1: 計測。ラベルからノードセル寸法を確定する。
// 以後の相でサイズは既知量となり、C-31 の「測る」の腕が環から外れる。
// 外置きラベル（ゲートウェイ・イベント）は張り出し ext として寸法に算入する（C-62）。

import { hasBottomActivityMarker, hasTopTaskIcon, isAttachedBoundary, isGatewayKind } from './bpmn.ts';
import { FONT_SIZE, LINE_H, quant, measureText, wrapText } from './metrics.ts';
import type { NodeCell, NormNode, Orientation } from './types.ts';

export const TASK_MIN_W = 80;
// 短い工程は80pxまで詰め、外形を最大128px級に抑える。
// BPMNの整った箱感を残しつつ、文字量のないノードを96pxへ固定しない。
// 本文幅に左右余白が加わるため、折返し幅そのものは 96px とする。
export const TASK_MAX_TEXT_W = 96;
export const TASK_MIN_H = 56;
export const TASK_PAD_X = 14;
export const TASK_PAD_Y = 12;
export const GW_SIZE = 44; // 菱形の外接正方形
export const EVENT_R = 16;
export const OUT_LABEL_FONT = 12;
export const OUT_LABEL_LINE_H = 16;
export const OUT_LABEL_MAX_W = 152;
export const OUT_LABEL_GAP = 6;

/** 境界イベントのラベルを、円の中心線(出るシーケンスの線)から外側へ離す量。 */
const BOUNDARY_LABEL_CLEAR = 8;

/**
 * 境界イベントの張り出し。円は辺から半径 + 余白、ラベルは円の主軸プラス側(横図=右)に
 * 置き、交差軸では中心線から BOUNDARY_LABEL_CLEAR だけ Activity の外側へ寄せる
 * (中心線は境界イベントから出るシーケンスの線なので、ラベルを横切らない)。
 * hang = 交差軸の張り出し、reach = 主軸プラス側へラベルが届く距離(円の中心から)。
 */
function boundaryExtent(n: NormNode, orientation: Orientation): { hang: number; reach: number; shift: number } {
  const lines = n.label === '' ? [] : wrapText(n.label, OUT_LABEL_MAX_W, OUT_LABEL_FONT);
  if (lines.length === 0) return { hang: EVENT_R + 4, reach: EVENT_R, shift: 0 };
  const labelW = Math.max(0, ...lines.map((l) => measureText(l, OUT_LABEL_FONT)));
  const labelH = lines.length * OUT_LABEL_LINE_H;
  // 横図: ラベルは円の右、上下に寄せる。縦図: ラベルは円の下、左右に寄せる
  const along = orientation === 'vertical' ? labelH : labelW;
  const across = orientation === 'vertical' ? labelW : labelH;
  return {
    hang: Math.max(EVENT_R + 4, BOUNDARY_LABEL_CLEAR + across),
    reach: EVENT_R + OUT_LABEL_GAP + along,
    shift: BOUNDARY_LABEL_CLEAR + across / 2,
  };
}

interface Hang {
  minus: number; // 交差軸マイナス側(横図=上 / 縦図=左)へ掛かる境界イベントの張り出し
  plus: number; // 交差軸プラス側(横図=下 / 縦図=右)へ掛かる境界イベントの張り出し
  reach: number; // 主軸プラス側(横図=右 / 縦図=下)へ伸びるラベルの届く距離(Activity 中心から)
}

/**
 * labelCrossMinus: 交差軸マイナス側（横図=上 / 縦図=左）へラベルを逃がすイベントの集合。
 * 境界イベントの掛かる辺は正規化が決めた boundarySide(S-53)を読む。
 * 既定は交差軸プラス側（横図=下 / 縦図=右）。テキストは回転しないため、
 * 「使用ポートの反対側」という規則は向きごとに別の実面へ写る。
 */
export function measureNodes(
  nodes: NormNode[],
  labelCrossMinus = new Set<string>(),
  orientation: Orientation = 'horizontal',
): Map<string, NodeCell> {
  const hanging = new Map<string, Hang>();
  for (const n of nodes) {
    if (!isAttachedBoundary(n) || !n.attachedTo) continue;
    const h = hanging.get(n.attachedTo) ?? { minus: 0, plus: 0, reach: 0 };
    const ext = boundaryExtent(n, orientation);
    if (n.boundarySide === 'top') h.minus = Math.max(h.minus, ext.hang);
    else h.plus = Math.max(h.plus, ext.hang);
    h.reach = Math.max(h.reach, ext.reach);
    hanging.set(n.attachedTo, h);
  }
  const cells = new Map<string, NodeCell>();
  for (const n of nodes) {
    const cell = measureNode(n, labelCrossMinus.has(n.id), orientation, hanging.get(n.id));
    if (isAttachedBoundary(n)) {
      // ラベルは円の横(主軸プラス側): 縦線が円へ真っ直ぐ入るときにラベルを横切らない。
      // 交差軸では Activity の外側へ寄せ、円から出るシーケンスの線(中心線)を避ける
      cell.labelSide = orientation === 'vertical' ? 'bottom' : 'right';
      const { shift } = boundaryExtent(n, orientation);
      cell.labelShift = n.boundarySide === 'top' ? -shift : shift;
    }
    cells.set(n.id, cell);
  }
  return cells;
}

function measureNode(n: NormNode, labelCrossMinus: boolean, orientation: Orientation, hang?: Hang): NodeCell {
  if (n.kind === 'task') {
    const lines = wrapText(n.label, TASK_MAX_TEXT_W, FONT_SIZE);
    const textW = Math.max(0, ...lines.map((l) => measureText(l, FONT_SIZE)));
    const topPad = hasTopTaskIcon(n) ? 12 : 0;
    const bottomPad = hasBottomActivityMarker(n) ? 14 : 0;
    const shapeW = quant(Math.max(TASK_MIN_W, textW + TASK_PAD_X * 2));
    const shapeH = quant(Math.max(TASK_MIN_H, lines.length * LINE_H + TASK_PAD_Y * 2 + topPad + bottomPad));
    let topExt = shapeH / 2;
    let bottomExt = shapeH / 2;
    let leftExt = shapeW / 2;
    let rightExt = shapeW / 2;
    if (hang) {
      // 境界イベントの円は交差軸の両側へ、ラベルは主軸プラス側へ張り出す
      if (orientation === 'vertical') {
        rightExt += hang.plus;
        leftExt += hang.minus;
        bottomExt = Math.max(bottomExt, shapeH / 2 + hang.reach);
      } else {
        bottomExt += hang.plus;
        topExt += hang.minus;
        rightExt = Math.max(rightExt, shapeW / 2 + hang.reach);
      }
    }
    return {
      id: n.id, shapeW, shapeH,
      topExt, bottomExt, leftExt, rightExt,
      labelLines: lines, labelW: textW, labelH: lines.length * LINE_H,
    };
  }
  // 外置きラベル（上: ゲートウェイ / 下: イベント）
  const lines = n.label === '' ? [] : wrapText(n.label, OUT_LABEL_MAX_W, OUT_LABEL_FONT);
  const labelW = Math.max(0, ...lines.map((l) => measureText(l, OUT_LABEL_FONT)));
  const labelH = lines.length * OUT_LABEL_LINE_H;

  if (n.kind === 'store') {
    // データストア: 円筒。ラベルは右下(doc と同じ規則)
    const w = 44;
    const h = 44;
    return {
      id: n.id, shapeW: w, shapeH: h,
      topExt: h / 2,
      bottomExt: h / 2 + (lines.length ? labelH + OUT_LABEL_GAP : 0),
      leftExt: w / 2,
      rightExt: Math.max(w / 2, 6 + labelW),
      labelLines: lines, labelW, labelH,
    };
  }

  if (n.kind === 'note') {
    // 注釈: 開き括弧+テキスト。枠なし
    const noteLines = wrapText(n.label, 140, OUT_LABEL_FONT);
    const w = Math.max(48, 10 + Math.max(0, ...noteLines.map((l) => measureText(l, OUT_LABEL_FONT))));
    const h = Math.max(28, noteLines.length * OUT_LABEL_LINE_H + 8);
    return {
      id: n.id, shapeW: quant(w), shapeH: quant(h),
      topExt: quant(h) / 2, bottomExt: quant(h) / 2,
      leftExt: quant(w) / 2, rightExt: quant(w) / 2,
      labelLines: noteLines, labelW: w - 10, labelH: noteLines.length * OUT_LABEL_LINE_H,
    };
  }

  if (n.kind === 'group') {
    const groupLines = wrapText(n.label, 140, OUT_LABEL_FONT);
    const w = Math.max(72, 16 + Math.max(0, ...groupLines.map((l) => measureText(l, OUT_LABEL_FONT))));
    const h = Math.max(40, groupLines.length * OUT_LABEL_LINE_H + 16);
    return {
      id: n.id, shapeW: quant(w), shapeH: quant(h),
      topExt: quant(h) / 2, bottomExt: quant(h) / 2,
      leftExt: quant(w) / 2, rightExt: quant(w) / 2,
      labelLines: groupLines, labelW: w - 16, labelH: groupLines.length * OUT_LABEL_LINE_H,
    };
  }

  if (n.kind === 'doc') {
    // データオブジェクト: 書類の形。ラベルは右下(中心軸は上下ポートの動線として空ける)
    const w = n.subtype === 'message' ? 36 : 40;
    const h = n.subtype === 'message' ? 28 : 48;
    const extraBottom = n.collection ? 8 : 0;
    return {
      id: n.id, shapeW: w, shapeH: h + extraBottom,
      topExt: (h + extraBottom) / 2,
      bottomExt: (h + extraBottom) / 2 + (lines.length ? labelH + OUT_LABEL_GAP : 0),
      leftExt: w / 2,
      rightExt: Math.max(w / 2, 6 + labelW),
      labelLines: lines, labelW, labelH,
    };
  }

  if (isGatewayKind(n.kind)) {
    // ラベルは左上。右上は分岐条件ラベルの領分、中心軸は入りポートの動線
    const half = GW_SIZE / 2;
    return {
      id: n.id, shapeW: GW_SIZE, shapeH: GW_SIZE,
      topExt: half + (lines.length ? labelH + OUT_LABEL_GAP : 0),
      bottomExt: half,
      leftExt: Math.max(half, 8 + labelW),
      rightExt: half,
      labelLines: lines, labelW, labelH,
    };
  }
  // start / end / mid / boundary
  if (orientation === 'vertical') {
    // 縦図: 上下は本流ポートの動線なので、ラベルは横（既定=右、cross− 指定で左）
    const sideExt = lines.length ? labelW + OUT_LABEL_GAP : 0;
    return {
      id: n.id, shapeW: EVENT_R * 2, shapeH: EVENT_R * 2,
      topExt: Math.max(EVENT_R, labelH / 2),
      bottomExt: Math.max(EVENT_R, labelH / 2),
      leftExt: EVENT_R + (labelCrossMinus ? sideExt : 0),
      rightExt: EVENT_R + (labelCrossMinus ? 0 : sideExt),
      labelLines: lines, labelW, labelH, labelSide: labelCrossMinus ? 'left' : 'right',
    };
  }
  const labelExt = lines.length ? labelH + OUT_LABEL_GAP : 0;
  return {
    id: n.id, shapeW: EVENT_R * 2, shapeH: EVENT_R * 2,
    topExt: EVENT_R + (labelCrossMinus ? labelExt : 0),
    bottomExt: EVENT_R + (labelCrossMinus ? 0 : labelExt),
    leftExt: Math.max(EVENT_R, labelW / 2),
    rightExt: Math.max(EVENT_R, labelW / 2),
    labelLines: lines, labelW, labelH, labelSide: labelCrossMinus ? 'top' : 'bottom',
  };
}
