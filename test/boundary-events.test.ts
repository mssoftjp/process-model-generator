import { describe, expect, it } from 'vitest';
import { parse } from '../src/compile.ts';
import { normalize } from '../src/normalize.ts';
import { place } from '../src/place.ts';
import { noOracleViolations } from './helpers.ts';

describe('境界イベントへのメッセージ整列 (L29)', () => {
  it('境界イベントへのメッセージは対象 Activity ごと送信元の列まで動かす', () => {
    // 境界イベント自身に下限を掛けると列固定と打ち消し合い、制約が捨てられて逆走していた
    const src = `pool P1[A]
lane L1[L1]
 start s1
 task a1[準備]
 task a2[調整]
 task(send) send[通知]
 s1 -> a1
 a1 -> a2
 a2 -> send
pool P2[B]
lane L2[L2]
 start s2
 task work[作業]
 boundary(message) alert[中断] @work
 task fix[対応]
 s2 -> work
 alert -> fix
send ~> alert`;
    const r = noOracleViolations(src);
    const p = place(normalize(parse(src).ir, false));
    expect(p.col.get('send')).toBe(3);
    expect(p.col.get('work')).toBe(3);
    expect(p.col.get('alert')).toBe(3);
    const msg = r.geometry.edges.find((e) => e.kind === 'msg')!;
    const from = r.geometry.nodes.find((n) => n.id === 'send')!;
    expect(msg.points.at(-1)!.x).toBeGreaterThanOrEqual(from.x); // 時間を遡らない
    // 上のプールから届くので境界イベントは対象の上辺に掛かり、メッセージは上から真っ直ぐ入る(S-53)
    const alert = r.geometry.nodes.find((n) => n.id === 'alert')!;
    const work = r.geometry.nodes.find((n) => n.id === 'work')!;
    expect(alert.cy).toBe(work.y);
    expect(alert.cx).toBeGreaterThan(work.cx);
    expect(msg.points.at(-1)!.y).toBe(alert.y);
    expect(msg.points[0]!.y).toBe(from.y + from.h);
    expect(msg.points.length).toBeLessThanOrEqual(4);
    // ラベルは円の右、出るシーケンスの線(中心線)から Activity の外側へ離す
    expect(alert.labelSide).toBe('right');
    expect(alert.labelShift).toBeLessThan(0);
  });

  it('下のプールから届く境界イベントは下辺に掛かり、下から真っ直ぐ入る', () => {
    const src = `pool P1[A]
lane L1[L1]
 start s1
 task work[作業]
 boundary(message) alert[中断] @work
 task fix[対応]
 s1 -> work
 alert -> fix
pool P2[B]
lane L2[L2]
 start s2
 task a1[準備]
 task(send) send[通知]
 s2 -> a1
 a1 -> send
send ~> alert`;
    const r = noOracleViolations(src);
    const alert = r.geometry.nodes.find((n) => n.id === 'alert')!;
    const work = r.geometry.nodes.find((n) => n.id === 'work')!;
    const from = r.geometry.nodes.find((n) => n.id === 'send')!;
    const msg = r.geometry.edges.find((e) => e.kind === 'msg')!;
    expect(alert.cy).toBe(work.y + work.h);
    expect(msg.points.at(-1)!.y).toBe(alert.y + alert.h);
    expect(msg.points[0]!.y).toBe(from.y);
    expect(msg.points.length).toBeLessThanOrEqual(4);
    expect(alert.labelShift).toBeGreaterThan(0);
    // 出るシーケンスの線はラベルの箱を通らない
    const seq = r.geometry.edges.find((e) => e.id.includes('alert_fix'))!;
    const labelTop = alert.cy + alert.labelShift! - 8;
    expect(seq.points[0]!.y).toBeLessThan(labelTop);
  });

  it('縦図でも上辺(実左)の境界イベントへ横から真っ直ぐ入る', () => {
    const src = `orientation vertical
pool P1[A]
lane L1[L1]
 start s1
 task(send) send[通知]
 s1 -> send
pool P2[B]
lane L2[L2]
 start s2
 task work[作業]
 boundary(message) alert[中断] @work
 s2 -> work
send ~> alert`;
    const r = noOracleViolations(src);
    const alert = r.geometry.nodes.find((n) => n.id === 'alert')!;
    const work = r.geometry.nodes.find((n) => n.id === 'work')!;
    const msg = r.geometry.edges.find((e) => e.kind === 'msg')!;
    expect(alert.cx).toBe(work.x);
    expect(msg.points.at(-1)!.x).toBe(alert.x);
    expect(alert.labelSide).toBe('bottom');
  });

  it('同じ Activity の 2 つの境界イベントから出るシーケンスは 2 折れで交差しない', () => {
    // 境界イベントの出線は Activity の辺の高さを走るので基線の予約で衝突扱いにしない(L31)。
    // 溝トラックは交差しない順(L30)なので、互い違いの 2 本は互いを横切らない
    const src = `pool P1[A]
lane L1[L1]
 start s1
 task(send) send[通知]
 s1 -> send
pool P2[B]
lane L2[L2]
 start s2
 task work[作業]
 boundary(message) alert[中断] @work
 boundary(timer) late[期限超過] @work
 task fix[対応]
 task esc[エスカレーション]
 s2 -> work
 alert -> fix
 late -> esc
pool P3[C]
lane L3[L3]
 start s3
 task(send) ping[催促]
 s3 -> ping
send ~> alert
ping ~> late`;
    const r = noOracleViolations(src);
    const fix = r.geometry.edges.find((e) => e.id.includes('alert_fix'))!;
    const esc = r.geometry.edges.find((e) => e.id.includes('late_esc'))!;
    expect(fix.points.length).toBe(4);
    expect(esc.points.length).toBe(4);
    // 期限超過(下辺、下へ長い)が内側、中断(上辺、短い)が外側
    expect(esc.points[1]!.x).toBeLessThan(fix.points[1]!.x);
    expect((fix.hops?.length ?? 0) + (esc.hops?.length ?? 0)).toBe(1); // 作業 → 終了 との交差だけ
  });

  it('境界イベントから前のノードへ戻る辺は対象 Activity を通る循環として戻り辺になる (L32)', () => {
    // 境界イベント自身には入辺が無いので DFS が循環を見つけられず、前向きに層化されて
    // 対象への張り付きと矛盾し、境界イベントが対象より左の列に置かれていた(fuzz seed 186)
    const src = `lane L
start s
task a[受付]
task b[作業]
boundary(timer) tb[期限] @b
end e
s -> a
a -> b
b -> e
tb -> a`;
    const r = noOracleViolations(src);
    const back = r.normalized.edges.find((e) => e.from === 'tb')!; // a は合流 x_j_a を挟む
    expect(back.isReturn).toBe(true);
    const p = place(r.normalized);
    expect(p.col.get('tb')).toBe(p.col.get('b'));
    const geo = r.geometry.edges.find((e) => e.id.includes('_tb_'))!;
    const tb = r.geometry.nodes.find((n) => n.id === 'tb')!;
    expect(geo.points[0]!.x).toBeGreaterThanOrEqual(tb.x + tb.w - 0.01); // 円の右から出る
  });

  it('境界イベントから同じ行の文書への関連は対象の左の溝で基線へ降りる', () => {
    // 基線の 2 点直線は境界イベントの高さから斜めになる(fuzz seed 16)
    const src = `lane L
start s
task b[作業]
boundary(timer) tb[期限] @b
end e
s -> b
b -> e
tb -.-> 記録`;
    const r = noOracleViolations(src);
    const geo = r.geometry.edges.find((e) => e.id.includes('tb_'))!;
    expect(geo.points.length).toBe(4);
    expect(geo.points[0]!.y).toBe(geo.points[1]!.y);
    expect(geo.points[1]!.x).toBe(geo.points[2]!.x);
  });

  it('データ関連の可視グラフ経路はイベントの円周に着地する', () => {
    // 混み合った左面で 12px 刻みに分けたポートが外接矩形の辺に置かれ、円周から外れていた(fuzz seed 1863)
    const src = `pool P1[A]
lane L1[L1]
 task a[作業]
lane L2[L2]
 task b[準備]
 mid m[受領]
 task c[処理]
 b -> m
 m -> c
 a -.-> m
 記録 -.-> m
 台帳 -.-> m
 b -.-> 記録
 b -.-> 台帳`;
    const r = noOracleViolations(src);
    const m = r.geometry.nodes.find((n) => n.id === 'm')!;
    for (const e of r.geometry.edges) {
      if (e.to !== 'm') continue;
      const end = e.points.at(-1)!;
      const d = Math.hypot(end.x - m.cx, end.y - m.cy);
      expect(Math.abs(d - m.w / 2)).toBeLessThan(0.05);
    }
  });
});
