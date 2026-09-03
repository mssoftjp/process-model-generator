import { describe, expect, it } from 'vitest';
import { currentLabelScore, edgeLabelBox, inspectEdgeLabels } from '../src/edge-labels.ts';
import { BRANCH_FLOW, noOracleViolations } from './helpers.ts';

describe('辺ラベルの所有と始点距離', () => {
  it('現在位置も候補と同じ13要素の優先順位で比較する', () => {
    expect(currentLabelScore([1, 2, 3, 4, 5], 6, 7, 8)).toEqual([
      1, 2, 3, 6, 4, 5, 7, 8, 0, 0, 0, 0, 0,
    ]);
  });

  it('縦図の黒箱プール発メッセージは最初の横区間の送信側に付く', () => {
    const r = noOracleViolations(`orientation vertical
pool company[自社]
lane requester[申請者]
task obtain[見積を取得する]
pool supplier[取引先]
obtain ~> supplier: 見積依頼
supplier ~> obtain: 見積書`);
    const edge = r.geometry.edges.find((e) => e.from === 'supplier')!;
    const box = edgeLabelBox(edge)!;
    const sourceDistance = Math.abs(box.x + box.w / 2 - edge.points[0]!.x) + Math.abs(box.y + box.h / 2 - edge.points[0]!.y);
    const target = edge.points.at(-1)!;
    const targetDistance = Math.abs(box.x + box.w / 2 - target.x) + Math.abs(box.y + box.h / 2 - target.y);
    expect(sourceDistance).toBeLessThan(targetDistance);
    expect(box.y + box.h).toBeLessThan(edge.points[0]!.y);
  });

  it('縦図の黒箱プール発メッセージは受け側の右側へ入り、図形の左へ回らない', () => {
    const r = noOracleViolations(`orientation vertical
pool company[自社]
lane L
start(message) recv[受領]
end e
recv -> e
pool other[相手]
other ~> recv`);
    const recv = r.geometry.nodes.find((n) => n.id === 'recv')!;
    const msg = r.geometry.edges.find((e) => e.from === 'other' && e.to === 'recv')!;
    const end = msg.points.at(-1)!;
    expect(end.x).toBeGreaterThan(recv.cx);
    expect(msg.points.every((p) => p.x >= recv.x - 1)).toBe(true);
  });

  it('縦図で右側レーンからキャッチへ入るシーケンスは図形の左へ回らない', () => {
    const r = noOracleViolations(`orientation vertical
pool company[自社]
lane left[左]
catch(message) recv[受領]
end e
recv -> e
lane right[右]
start s
task send[送る]
s -> send
send -> recv
pool other[相手]
other ~> recv`);
    const recv = r.geometry.nodes.find((n) => n.id === 'recv')!;
    const seq = r.geometry.edges.find((e) => e.kind === 'seq' && e.from === 'send' && e.to === 'recv')!;
    const end = seq.points.at(-1)!;
    expect(end.x).toBeGreaterThan(recv.cx);
    expect(seq.points.every((p) => p.x >= recv.x - 1)).toBe(true);
  });

  it('合流 XOR へ入る2本のシーケンスは終点を共有しない', () => {
    const r = noOracleViolations(`lane L
start s
xor split[分岐]
task a[本流]
task back[戻り]
xor j[合流]
end e
s -> split
split => a: 本流
split -> back: 例外
a -> j
back -> j
j -> e`);
    const ins = r.geometry.edges.filter((e) => e.kind === 'seq' && e.to === 'j');
    expect(ins.length).toBe(2);
    const ends = ins.map((e) => e.points.at(-1)!);
    expect(new Set(ends.map((p) => `${p.x},${p.y}`)).size).toBe(2);
    const join = r.geometry.nodes.find((n) => n.id === 'j')!;
    for (const p of ends) {
      const metric = Math.abs(p.x - join.cx) / (join.w / 2) + Math.abs(p.y - join.cy) / (join.h / 2);
      expect(metric).toBeCloseTo(1, 5);
    }
    expect(Math.hypot(ends[0]!.x - ends[1]!.x, ends[0]!.y - ends[1]!.y)).toBeGreaterThanOrEqual(16);
  });

  it('縦図の非本流条件は固有横区間の始点寄り', () => {
    const r = noOracleViolations(`orientation vertical\n${BRANCH_FLOW}`);
    const gw = r.geometry.nodes.find((n) => n.id === 'decision')!;
    const no = r.geometry.edges.find((e) => e.from === 'decision' && e.label === 'no')!;
    const unique = no.points.find((p, i) => {
      const q = no.points[i + 1];
      return q && Math.abs(p.y - q.y) < 0.01 && Math.abs(q.x - p.x) >= 16;
    });
    expect(unique).toBeTruthy();
    const along = Math.abs((no.labelPos!.x + 20) - unique!.x);
    expect(along).toBeLessThanOrEqual(40);
    expect(gw.kind).toBe('xor');
  });

  it('共有スタブの分岐ラベルはそれぞれの固有側に付き stolen 0', () => {
    const r = noOracleViolations(BRANCH_FLOW);
    const report = inspectEdgeLabels(r.geometry);
    expect(report.stolen).toBe(0);
    expect(report.nodeHits).toBe(0);
  });

  it('3分岐の長い条件ラベルは隣の戻り辺に盗まれない', () => {
    const r = noOracleViolations(`lane L
start s
xor enough[十分か]
task ret[差し戻し]
xor band[金額帯]
task low[少額]
task mid[中額]
task high[高額]
end e
s -> enough
enough -> ret: 不足
enough => band: 十分
ret -> s
band => low: 10万円未満（原則）
band -> mid: 10万円以上100万円未満
band -> high: 100万円以上
low -> e
mid -> e
high -> e`);
    const report = inspectEdgeLabels(r.geometry);
    expect(report.stolen).toBe(0);
    expect(report.ambiguous).toBe(0);
    const mid = r.geometry.edges.find((e) => e.label === '10万円以上100万円未満')!;
    const start = mid.points[0]!;
    const box = edgeLabelBox(mid)!;
    const far = Math.abs(box.x + box.w / 2 - start.x) + Math.abs(box.y + box.h / 2 - start.y);
    // 2 本の下出しは交差しない順にトラックを置く(L30)ので、中額の幹線は高額と 1 溝ぶん
    // 共有してから分かれる。ラベルは分かれた直後(高額と共有しない最初の頂点の直後)に付く
    const highEdge = r.geometry.edges.find((e) => e.label === '100万円以上')!;
    const own = mid.points.find((p) => !highEdge.points.some((q) => q.x === p.x && q.y === p.y))!;
    expect(box.x - own.x).toBeLessThanOrEqual(16);
    expect(far).toBeLessThanOrEqual(240);
    expect(r.geometry.edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0)).toBe(0);
    const high = r.geometry.edges.find((e) => e.label === '100万円以上')!;
    const highStart = high.points[0]!;
    const highBox = edgeLabelBox(high)!;
    const highFar = Math.abs(highBox.x + highBox.w / 2 - highStart.x) +
      Math.abs(highBox.y + highBox.h / 2 - highStart.y);
    expect(highFar).toBeLessThanOrEqual(160);
  });
});
