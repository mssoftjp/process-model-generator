// プロパティテスト: ランダムな入力をコンパイルし、オラクル(C-80)が沈黙することを検査する。
// 「構築が正しければオラクルは発火しない」という不変条件の検証面。
// 乱数は seed 固定(決定的)。生成器は意図的に攻撃的:
// 大きいグラフ・任意の追加辺(循環含む)・start/end を辺の途中に置く・空レーン・単一ノード。

import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';
import { genSource, mulberry32 } from './fuzz-gen.ts';

describe('fuzz × oracle', () => {
  // Orientation only changes the physical axis used by each O-* check.
  for (const orientation of ['horizontal', 'vertical'] as const) {
    it(`has zero oracle violations across 500 random cases (${orientation})`, () => {
      const prefix = orientation === 'vertical' ? 'orientation vertical\n' : '';
      const failures: string[] = [];
      for (let seed = 1; seed <= 500; seed++) {
        const src = prefix + genSource(mulberry32(seed * 40503 + 7));
        try {
          const r = compile(src);
          const viols = r.diagnostics.filter((d) => d.code.startsWith('O-') || d.code === 'W-252');
          if (viols.length > 0) {
            failures.push(`seed=${seed}\n${viols.map((v) => v.message).join('\n')}\n---\n${src}`);
          }
        } catch (err) {
          failures.push(`seed=${seed} threw: ${String(err)}\n---\n${src}`);
        }
      }
      expect(failures, failures.slice(0, 3).join('\n\n')).toEqual([]);
    }, 60_000);
  }

  it('is deterministic for the same generated seed', () => {
    const src = genSource(mulberry32(42 * 40503 + 7));
    expect(compile(src).svg).toBe(compile(src).svg);
  });
});
