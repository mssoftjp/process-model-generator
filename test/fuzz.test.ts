// プロパティテスト: ランダムな入力をコンパイルし、オラクル(C-80)が沈黙することを検査する。
// 「構築が正しければオラクルは発火しない」という不変条件の検証面。
// 乱数は seed 固定(決定的)。生成器は意図的に攻撃的:
// 大きいグラフ・任意の追加辺(循環含む)・start/end を辺の途中に置く・空レーン・単一ノード。

import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ['受注', '検品', '長い長い長い名前の工程をここに', 'OK', '購買申請の承認（部長以上）'];

function genSource(rnd: () => number): string {
  const laneCount = 1 + Math.floor(rnd() * 5);
  const nodeCount = 2 + Math.floor(rnd() * 18);
  const decl: string[][] = Array.from({ length: laneCount }, () => []);
  const kinds = [
    'task', 'task', 'task(user)', 'task(call)', 'task(sub)', 'task(user,loop)',
    'xor', 'xor(event)', 'xor(or)', 'xor(complex)', 'and', 'and(event)',
    'start', 'start(message)', 'start(timer)', 'end', 'end(terminate)', 'end(error)',
    'mid', 'mid(message)', 'mid(signal)', 'mid(message,throw)',
    'store', 'note', 'doc(input)', 'doc(collection)',
  ];
  const laneOf: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const l = Math.floor(rnd() * laneCount);
    laneOf.push(l);
    const kind = kinds[Math.floor(rnd() * kinds.length)]!;
    const label = LABELS[Math.floor(rnd() * LABELS.length)]!;
    decl[l]!.push(kind === 'task' ? `  n${i}[${label}]` : `  ${kind} n${i}[${label}]`);
    if (kind.startsWith('task') && rnd() < 0.12) {
      const bKind = rnd() < 0.5 ? 'boundary(timer)' : 'boundary(message,nonint)';
      decl[l]!.push(`  ${bKind} nb${i}[境界] @n${i}`);
    }
  }
  const out: string[] = [];
  const poolSplit = laneCount >= 2 && rnd() < 0.5 ? Math.ceil(laneCount / 2) : -1; // 半分をプールに割る
  for (let l = 0; l < laneCount; l++) {
    if (poolSplit >= 0 && l === 0) out.push('pool プールA');
    if (poolSplit >= 0 && l === poolSplit) out.push('pool プールB');
    out.push(`lane レーン${l}`);
    out.push(...decl[l]!);
  }
  const hasBB = rnd() < 0.3;
  if (hasBB) out.push('pool BB[外部システム]');
  for (let i = 0; i + 1 < nodeCount; i++) if (rnd() < 0.9) out.push(`n${i} ${rnd() < 0.1 ? '~>' : '->'} n${i + 1}`);
  if (hasBB) {
    out.push(`n${Math.floor(rnd() * nodeCount)} ~> BB: 依頼`);
    out.push(`BB ~> n${Math.floor(rnd() * nodeCount)}: 応答`);
  }
  const extra = Math.floor(rnd() * 8);
  for (let k = 0; k < extra; k++) {
    const a = Math.floor(rnd() * nodeCount);
    const b = Math.floor(rnd() * nodeCount);
    if (a === b) continue;
    const arrow2 = rnd() < 0.12 ? '~>' : rnd() < 0.15 ? '-.->' : rnd() < 0.15 ? '-.-' : rnd() < 0.15 ? '..>' : rnd() < 0.12 ? '->/' : '->';
    out.push(`n${a} ${arrow2} n${b}${rnd() < 0.4 ? ': 条件ラベル' : ''}`);
  }
  // 境界イベントを受信先にする他プールからのメッセージ(Message Boundary Event)。
  // 同一プール内は ~> が seq に読み替えられ、境界イベントへのシーケンスは BPMN 上不正なので作らない
  const poolOfLane = (l: number) => (poolSplit >= 0 && l >= poolSplit ? 1 : 0);
  for (let i = 0; i < nodeCount; i++) {
    const line = decl.flat().find((d) => d.includes(` nb${i}[`));
    if (!line || poolSplit < 0 || rnd() < 0.5) continue;
    const hostLane = decl.findIndex((lines) => lines.includes(line));
    const senders = laneOf.map((l, j) => [l, j] as const).filter(([l]) => poolOfLane(l) !== poolOfLane(hostLane));
    if (senders.length === 0) continue;
    const [, j] = senders[Math.floor(rnd() * senders.length)]!;
    out.push(`n${j} ~> nb${i}`);
  }
  // 境界イベントから出るシーケンス(同一プールのノードへ。戻り・合流・文書行きも混ざる)
  for (let i = 0; i < nodeCount; i++) {
    if (!decl.flat().some((d) => d.includes(` nb${i}[`)) || rnd() < 0.5) continue;
    const targets = laneOf.map((l, j) => [l, j] as const).filter(([l, j]) => j !== i && poolOfLane(l) === poolOfLane(laneOf[i]!));
    if (targets.length === 0) continue;
    const [, k] = targets[Math.floor(rnd() * targets.length)]!;
    out.push(`nb${i} -> n${k}`);
  }
  // 書類とデータ関連(生産者→doc、doc→読み手。稀に doc 同士や逆向きも混ぜる)
  const docCount = Math.floor(rnd() * 4);
  for (let d = 0; d < docCount; d++) {
    const writer = Math.floor(rnd() * nodeCount);
    out.push(`n${writer} -.-> 書類${d}`); // 未宣言 doc の自動実体化(W-102)も踏む
    if (rnd() < 0.5) out.push(`n${(writer + 1) % nodeCount} -.-> 書類${d}`);
    if (rnd() < 0.2) out.push(`n${(writer + 2) % nodeCount} -.-> 書類${d}`);
    const readers = 1 + Math.floor(rnd() * 2);
    for (let r = 0; r < readers; r++) {
      out.push(`書類${d} -.-> n${Math.floor(rnd() * nodeCount)}`);
    }
    if (rnd() < 0.2 && d > 0) out.push(`書類${d - 1} -.-> 書類${d}`);
  }
  return out.join('\n');
}

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
