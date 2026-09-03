// P3 の記号座標。数値座標は一切含まず、P4/P5 が実座標へ写す(types.ts の SymX / SymY)。

import type {
  GutterSide, PortSide, SymX, SymY,
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
