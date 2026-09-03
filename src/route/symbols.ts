// P3 の記号座標。数値座標は一切含まず、P4/P5 が実座標へ写す(types.ts の SymX / SymY)。

import type {
  GutterSide, PortSide, SymX, SymY, SymPt,
} from '../types.ts';

export const portX = (id: string, side: PortSide): SymX => ({ t: 'portX', id, side });

export const portY = (id: string, side: PortSide): SymY => ({ t: 'portY', id, side });

export const portStubY = (id: string, side: 'top' | 'bottom', offset = 16): SymY => ({ t: 'portStubY', id, side, offset });

export const gutterX = (gi: number, side: GutterSide, run: number): SymX => ({ t: 'gutter', g: gi, side, run });

export const nodeCX = (id: string, offset = 0): SymX => ({ t: 'nodeCX', id, offset });

export const nodeCY = (id: string, offset = 0): SymY => ({ t: 'nodeCY', id, offset });

export const channelY = (lane: string, row: number, run: number): SymY => ({ t: 'channel', lane, row, run });

export const poolChannelY = (gap: number, run: number): SymY => ({ t: 'poolChannel', gap, run });

export const rowMidY = (lane: string, row: number): SymY => ({ t: 'rowMid', lane, row });

// ---- 折れ線の構成子(S-5x の定型) ----

/** 同列の一直線(2 点): 送信元の面から対象の面へ列中心を縦に渡る。off は往復対の ±6px ずらし。 */
export const verticalLine = (from: string, fromSide: PortSide, to: string, toSide: PortSide, off = 0): SymPt[] => [
  { x: nodeCX(from, off), y: portY(from, fromSide) },
  { x: nodeCX(to, off), y: portY(to, toSide) },
];

/** 縦→横→縦の Z 形(4 点): 送信元の面から列中心を y まで進み、y を横走して対象の列中心から面へ入る。 */
export const verticalZ = (from: string, fromSide: PortSide, y: SymY, to: string, toSide: PortSide): SymPt[] => [
  { x: nodeCX(from), y: portY(from, fromSide) },
  { x: nodeCX(from), y },
  { x: nodeCX(to), y },
  { x: nodeCX(to), y: portY(to, toSide) },
];
