// 生成後の実寸から、1600x900 の共有画面で判読できるかを測る。
// ノード数は密度を表さず、向きによって時間軸とレーン軸も入れ替わるため判定に使わない。

import { FONT_SIZE } from './metrics.ts';
import type { Diagnostic, Geometry } from './types.ts';

const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 900;
const SOFT_FONT_LIMIT = 9;
const HARD_LANE_FONT_LIMIT = 6;
const TIME_SCREEN_LIMIT = 2;

export interface PageBudgetMetrics {
  fitFont: number;
  laneFont: number;
  timeScreens: number;
  width: number;
  height: number;
}

export interface PageBudgetResult {
  metrics: PageBudgetMetrics;
  diagnostics: Diagnostic[];
}

export function diagnosePageBudget(geometry: Geometry, strict = false): PageBudgetResult {
  const width = Math.max(1, geometry.width);
  const height = Math.max(1, geometry.height);
  const vertical = geometry.orientation === 'vertical';
  const laneAxis = vertical ? width : height;
  const timeAxis = vertical ? height : width;
  const laneViewport = vertical ? VIEWPORT_WIDTH : VIEWPORT_HEIGHT;
  const timeViewport = vertical ? VIEWPORT_HEIGHT : VIEWPORT_WIDTH;
  const metrics: PageBudgetMetrics = {
    fitFont: FONT_SIZE * Math.min(1, VIEWPORT_WIDTH / width, VIEWPORT_HEIGHT / height),
    laneFont: FONT_SIZE * Math.min(1, laneViewport / laneAxis),
    timeScreens: timeAxis / timeViewport,
    width: geometry.width,
    height: geometry.height,
  };
  const summary =
    `1600x900換算: 全体 ${metrics.fitFont.toFixed(1)}px、` +
    `レーン軸 ${metrics.laneFont.toFixed(1)}px、時間軸 ${metrics.timeScreens.toFixed(2)}画面` +
    `（SVG ${geometry.width}x${geometry.height}）`;
  const diagnostics: Diagnostic[] = [];

  const hopCount = geometry.edges.reduce((count, edge) => count + (edge.hops?.length ?? 0), 0);
  diagnostics.push({
    level: 'info',
    code: 'N-440',
    message: `表示予算 ${summary}、交差ホップ ${hopCount} 箇所`,
  });

  if (
    metrics.fitFont < SOFT_FONT_LIMIT &&
    (metrics.laneFont < SOFT_FONT_LIMIT || metrics.timeScreens > TIME_SCREEN_LIMIT)
  ) {
    diagnostics.push({
      level: 'warning',
      code: 'W-440',
      message: `単一ビューだけでの提供に不向き。概要図と必要な詳細図へ分ける（${summary}）`,
    });
  }

  if (metrics.laneFont < HARD_LANE_FONT_LIMIT) {
    diagnostics.push({
      level: strict ? 'error' : 'warning',
      code: strict ? 'E-441' : 'W-441',
      message: `レーン軸の縮小で物理的に判読できない。分割してから提供する（${summary}）`,
    });
  }

  return { metrics, diagnostics };
}
