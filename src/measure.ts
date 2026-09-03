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

/**
 * labelCrossMinus: 交差軸マイナス側（横図=上 / 縦図=左）へラベルを逃がすイベントの集合。
 * 既定は交差軸プラス側（横図=下 / 縦図=右）。テキストは回転しないため、
 * 「使用ポートの反対側」という規則は向きごとに別の実面へ写る。
 */
/** 境界イベントが対象 Activity の下辺から下へ張り出す量(円の半径 + 外置きラベル)。P3 の下辺スタブもこれを使う。 */
export function boundaryHang(n: NormNode): number {
  const lines = n.label === '' ? [] : wrapText(n.label, OUT_LABEL_MAX_W, OUT_LABEL_FONT);
  return EVENT_R + (lines.length ? lines.length * OUT_LABEL_LINE_H + OUT_LABEL_GAP : 4);
}

export function measureNodes(
  nodes: NormNode[],
  labelCrossMinus = new Set<string>(),
  orientation: Orientation = 'horizontal',
): Map<string, NodeCell> {
  const hanging = new Map<string, number>();
  for (const n of nodes) {
    if (!isAttachedBoundary(n) || !n.attachedTo) continue;
    hanging.set(n.attachedTo, Math.max(hanging.get(n.attachedTo) ?? 0, boundaryHang(n)));
  }
  const cells = new Map<string, NodeCell>();
  for (const n of nodes) {
    cells.set(n.id, measureNode(n, labelCrossMinus.has(n.id), orientation, hanging.get(n.id) ?? 0));
  }
  return cells;
}

function measureNode(n: NormNode, labelCrossMinus: boolean, orientation: Orientation, hang = 0): NodeCell {
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
    if (hang > 0) {
      if (orientation === 'vertical') rightExt += hang;
      else bottomExt += hang;
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
