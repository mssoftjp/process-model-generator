// 公開 API。テキスト -> IR -> P0..P6 -> SVG。
// 同じテキストと同じオプションは同じ絵(C-82)。乱数・時刻・環境計測をどこにも持たない。

import { applyStrictSemantics } from './bpmn.ts';
import { crossMinusLabelEvents } from './message-labels.ts';
import { parse } from './parse.ts';
import { normalize } from './normalize.ts';
import { measureNodes } from './measure.ts';
import { place } from './place.ts';
import { route } from './route.ts';
import { computeCoords, PAD, TITLE_H, transposeCells, VERT_GUTTER_LABEL_NEED } from './coords.ts';
import { EDGE_FONT_SIZE, measureText, TITLE_FONT_SIZE } from './metrics.ts';
import { computeHops, wire } from './wire.ts';
import { placeEdgeLabels } from './edge-labels.ts';
import { checkOracle } from './oracle.ts';
import { diagnosePageBudget } from './page-budget.ts';
import { improveRouting } from './sift-order.ts';
import { improveDataAssociations, visualAppearancePenalty } from './oarsp.ts';
import { renderSvg } from './svg.ts';
import { isDocLike } from './types.ts';
import type { CompileOptions, CompileResult, Diagnostic, Geometry, Orientation, RoutePlan } from './types.ts';

export class CompileError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(
      'コンパイルエラー:\n' +
        diagnostics.filter((d) => d.level === 'error').map((d) => `  ${d.code}: ${d.message}`).join('\n'),
    );
  }
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const strict = opts.strict ?? false;
  const parsed = parse(source);
  const diagnostics = applyStrictSemantics(parsed.diagnostics, strict);
  const ir = parsed.ir;
  if (strict && diagnostics.some((d) => d.level === 'error')) {
    throw new CompileError(diagnostics);
  }

  const normalized = normalize(ir, strict);
  const diags = [...diagnostics, ...normalized.report];
  if (strict && normalized.report.some((d) => d.level === 'error')) {
    throw new CompileError(diags);
  }

  // 向きは修辞。DSL 宣言 > オプション既定 > horizontal。トポロジ判断には使わない
  const orientation: Orientation = normalized.orientation ?? opts.orientation ?? 'horizontal';
  const vertical = orientation === 'vertical';

  // 交差軸プラス側(横図=下/縦図=右)からイベントへ着くメッセージは、ラベルを反対側へ逃がす。
  // 黒箱プール発も同じ。P3(route)も同じ集合でポートの空きを判定する。
  const labelCrossMinus = crossMinusLabelEvents(normalized);
  const cells = measureNodes(normalized.nodes, labelCrossMinus, orientation); // P1
  const placement = place(normalized); // P2
  // 縦図: P2/P3 は論理軸のまま使い(向き不変)、P4 へ渡すセルとラベル余白だけ論理軸へ写す
  const cellsL = vertical ? transposeCells(cells) : cells;
  const titleShift = vertical && normalized.title ? TITLE_H : 0;
  const assemble = (plan: RoutePlan) => {
    const planL = vertical
      ? {
        ...plan,
        gutterLabelNeed: new Map(
          [...plan.gutterLabelNeed].map(([gi, w]) => [gi, Math.min(w, VERT_GUTTER_LABEL_NEED)]),
        ),
      }
      : plan;
    const coords = computeCoords(normalized, placement, cellsL, planL, !vertical); // P4(論理軸)
    const edges = wire(normalized, planL, coords, orientation, titleShift); // P5(実座標)
    const nodes = normalized.nodes.map((n) => {
      const lg = coords.nodeGeom.get(n.id)!;
      if (!vertical) return lg;
      // 論理→実の転置。shapeW/H はセル側で入れ替え済みなので、ここで実寸へ戻る
      return { ...lg, x: lg.y, y: lg.x + titleShift, w: lg.h, h: lg.w, cx: lg.cy, cy: lg.cx + titleShift };
    });
    const band = <T extends { x: number; y: number; w: number; h: number }>(b: T): T =>
      vertical ? { ...b, x: b.y, y: b.x + titleShift, w: b.h, h: b.w } : b;
    // タイトルは回転しない横書きなので、向きによらず実 x 方向の幅を要求する。
    // 縦図(幅=レーン軸)や小さな横図では帯より広くなり得るため、キャンバス幅だけを
    // 広げる(帯 bandRight はレーンの実体なので触らない)
    const titleNeed = normalized.title ? PAD + measureText(normalized.title, TITLE_FONT_SIZE) + PAD : 0;
    const geometry: Geometry = {
      title: normalized.title,
      orientation,
      width: Math.max(vertical ? coords.height : coords.width, titleNeed),
      height: vertical ? coords.width + titleShift : coords.height,
      headerW: coords.headerW,
      bandRight: vertical ? coords.height - PAD : coords.bandRight,
      bandBottom: vertical ? coords.bandRight + titleShift : coords.height - PAD,
      pools: coords.poolGeoms.map(band),
      lanes: coords.lanes.map(band),
      nodes,
      edges,
    };
    computeHops(edges);
    const labelReport = placeEdgeLabels(geometry);
    return { plan: planL, geometry, coords, titleShift, labelReport };
  };
  const finish = (assembled: ReturnType<typeof assemble>) => {
    const geometry = assembled.geometry;
    return { assembled, geometry, violations: checkOracle(normalized, geometry), labelReport: assembled.labelReport };
  };
  const baseline = finish(assemble(route(normalized, placement, false)));
  const improved = finish(assemble(route(normalized, placement, true)));
  const picked = compareScore(layoutScore(improved), layoutScore(baseline)) < 0 ? improved : baseline;
  const readability = picked === improved;
  const refinedAssembled = improveRouting(
    normalized, placement, readability, assemble, picked.assembled,
  );
  const unchanged = refinedAssembled.geometry.edges === picked.geometry.edges;
  const refined = unchanged ? picked : finish(refinedAssembled);
  const symbolicSelected = unchanged || compareScore(layoutScore(refined), layoutScore(picked)) < 0
    ? refined
    : picked;
  const oarspGeometry = improveDataAssociations(symbolicSelected.geometry);
  let selected = symbolicSelected;
  if (oarspGeometry !== symbolicSelected.geometry) {
    computeHops(oarspGeometry.edges);
    const labelReport = placeEdgeLabels(oarspGeometry);
    const candidate = {
      assembled: { ...symbolicSelected.assembled, geometry: oarspGeometry, labelReport },
      geometry: oarspGeometry,
      violations: checkOracle(normalized, oarspGeometry),
      labelReport,
    };
    if (compareScore(layoutScore(candidate), layoutScore(symbolicSelected)) < 0) selected = candidate;
  }
  const geometry = selected.geometry;
  const edges = geometry.edges;
  if (picked === improved) {
    diags.push({ level: 'info', code: 'N-431', message: '全体可読性スコアにより改善経路を採用' });
  }
  if (selected !== symbolicSelected) {
    diags.push({ level: 'info', code: 'N-434', message: 'Data Association の直交可視グラフ経路を採用' });
  }

  // 不変条件の安全網: DFS 後退辺の対象は祖先なので、列は必ず手前になるはず。
  // プールをまたぐ辺は対象外(各プールの時間軸は独立で、S-15 の時系列整列は
  // 受信側の列だけを送信側以降へ動かすため、プール間の関連は前後どちらにもなり得る)。
  const laneOfNode = new Map(normalized.nodes.map((n) => [n.id, n.lane]));
  const poolOfLane = new Map(normalized.lanes.map((l) => [l.id, l.pool]));
  const poolOfNode = (id: string) => poolOfLane.get(laneOfNode.get(id) ?? '');
  // 文書類は状態であり時間軸を進めない(S-73)。書き手の列へ戻す配置(S-13)があるため、
  // 文書類を端点に持つ戻り辺は列の前後関係を約束しない。
  const kindOf = new Map(normalized.nodes.map((n) => [n.id, n.kind]));
  for (const e of normalized.edges) {
    if (e.fromPool || e.toPool || poolOfNode(e.from) !== poolOfNode(e.to)) continue;
    if (isDocLike(kindOf.get(e.from) ?? 'task') || isDocLike(kindOf.get(e.to) ?? 'task')) continue;
    if (e.isReturn && placement.col.get(e.to)! >= placement.col.get(e.from)!) {
      diags.push({
        level: 'warning', code: 'W-252',
        message: `戻り辺 ${e.from} -> ${e.to} が時間軸の順方向に配置された（エンジン不変条件の破れの疑い）`,
      });
    }
  }

  diags.push(...selected.violations); // P6

  if (selected.labelReport.nodeHits > 0) {
    const nodeDetails = selected.labelReport.details.filter((detail) => detail.includes(':node:'));
    diags.push({
      level: 'warning', code: 'W-432',
      message: `辺ラベルとノードの重なり ${selected.labelReport.nodeHits} 箇所（${nodeDetails.slice(0, 3).join(', ')}）`,
    });
  }
  if (selected.labelReport.edgeHits > 0 || selected.labelReport.labelHits > 0) {
    diags.push({
      level: 'info', code: 'N-432',
      message: `辺ラベルの残存交差: 線 ${selected.labelReport.edgeHits}、ラベル ${selected.labelReport.labelHits}`,
    });
  }
  if (selected.labelReport.stolen > 0 || selected.labelReport.ambiguous > 0) {
    diags.push({
      level: 'info', code: 'N-433',
      message: `辺ラベルの所有不明: stolen ${selected.labelReport.stolen}、ambiguous ${selected.labelReport.ambiguous}`,
    });
  }

  // 可読性の代理指標(C-81): 残った交差ホップの数
  const hopCount = edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0);
  if (hopCount > 0) {
    diags.push({ level: 'info', code: 'N-430', message: `交差ホップ ${hopCount} 箇所` });
  }

  const pageBudget = diagnosePageBudget(geometry, strict);
  diags.push(...pageBudget.diagnostics);
  if (pageBudget.diagnostics.some((d) => d.level === 'error')) {
    throw new CompileError(diags);
  }

  return {
    svg: renderSvg(geometry, opts.version),
    geometry,
    normalized,
    diagnostics: diags,
  };
}

/** オラクル違反 → gateway 出口共有 → ラベル衝突 → 交差 → 所有/距離 → 外観 → 折れ → 総線長 → 面積。 */
function layoutScore(candidate: {
  geometry: Geometry;
  violations: Diagnostic[];
  labelReport: { nodeHits: number; edgeHits: number; labelHits: number; stolen: number; ambiguous: number };
}): number[] {
  const { geometry, violations, labelReport } = candidate;
  let sharedGatewayExits = 0;
  let hops = 0;
  let bends = 0;
  let length = 0;
  let farLabels = 0;
  for (const e of geometry.edges) {
    hops += e.hops?.length ?? 0;
    bends += Math.max(0, e.points.length - 2);
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }
    if (e.label && e.labelPos) {
      const a = e.points[0]!;
      const x = e.labelPos.x + measureText(e.label, EDGE_FONT_SIZE) / 2;
      const y = e.labelPos.y + (EDGE_FONT_SIZE + 4) / 2;
      if (Math.abs(x - a.x) + Math.abs(y - a.y) > 160) farLabels++;
    }
  }
  for (const n of geometry.nodes) {
    if (n.kind !== 'xor' && n.kind !== 'and') continue; // ゲートウェイ出口共有の可読性スコア
    const outs = geometry.edges.filter((e) => e.from === n.id && e.kind === 'seq');
    if (outs.length !== 2) continue;
    if (outs[0]!.points[0]!.x === outs[1]!.points[0]!.x && outs[0]!.points[0]!.y === outs[1]!.points[0]!.y) {
      sharedGatewayExits++;
    }
  }
  return [
    violations.filter((d) => d.level === 'error').length,
    sharedGatewayExits,
    labelReport.nodeHits,
    labelReport.edgeHits + labelReport.labelHits,
    hops,
    labelReport.stolen,
    labelReport.ambiguous,
    farLabels,
    visualAppearancePenalty(geometry),
    bends,
    length,
    geometry.width * geometry.height,
  ];
}

function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export { parse } from './parse.ts';
export { normalize } from './normalize.ts';
export type * from './types.ts';
