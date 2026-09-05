import { describe, expect, it } from 'vitest';
import { compile, CompileError, parse } from '../src/compile.ts';
import { normalize } from '../src/normalize.ts';
import { place } from '../src/place.ts';
import { IMPLICIT_JOIN_FLOW, noOracleViolations } from './helpers.ts';

describe('P0 正規化', () => {
  it('孤立循環と出口のない循環を拒否し、出口付きの再試行は保つ', () => {
    const island = `lane L\nstart s\nend e\ntask a\ntask b\ns -> e\na -> b\nb -> a`;
    expect(() => compile(island, { strict: true })).toThrow('E-226');
    const loop = `lane L\nstart s\nxor a\ntask b\ns -> a\na -> b\nb -> a`;
    expect(() => compile(loop, { strict: true })).toThrow('E-227');
    expect(() => compile(loop + '\nend e\na -> e: done', { strict: true })).not.toThrow();
    const timeout = `lane L\nstart s\ntask t\nend e\nboundary(timer) b @t\ns -> t\nt -> e\nb -> e`;
    expect(() => compile(timeout, { strict: true })).not.toThrow();
  });

  it('暗黙合流を XOR join に昇格する (C-21)', () => {
    const src = `lane L\n A[a]\n B[b]\n C[c]\nA -> C\nB -> C`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.some((x) => x.id === 'x_j_C' && x.kind === 'xor' && x.synthetic)).toBe(true);
    expect(n.edges.filter((e) => e.to === 'x_j_C')).toHaveLength(2);
  });

  it('合流と分岐を兼ねるゲートウェイを join + split に分離する (C-21)', () => {
    const src = `lane L\n A[a]\n B[b]\n xor G\n C[c]\n D[d]\nA -> G\nB -> G\nG -> C\nG -> D`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.edges.filter((e) => e.to === 'x_j_G' && e.kind === 'seq')).toHaveLength(2);
    expect(n.edges.some((e) => e.from === 'x_j_G' && e.to === 'G')).toBe(true);
    expect(n.edges.filter((e) => e.from === 'G' && e.kind === 'seq')).toHaveLength(2);
    expect(n.report.some((d) => d.code === 'W-202')).toBe(false);
  });

  it('event-based gateway の合流側は通常 XOR merge にする (C-21)', () => {
    const src = `lane L\n A[a]\n B[b]\n xor(event) G\n C[c]\n D[d]\nA -> G\nB -> G\nG -> C\nG -> D`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.find((x) => x.id === 'x_j_G')?.subtype).toBeUndefined();
    expect(n.nodes.find((x) => x.id === 'G')?.subtype).toBe('event');
  });

  it('複数出辺の task に出所印つき XOR split を仮挿入する (C-13, lax)', () => {
    const src = `lane L\n A[a]\n B[b]\n C[c]\nA -> B\nA -> C`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    const gw = n.nodes.find((x) => x.id === 'x_s_A');
    expect(gw?.provisional).toBe(true);
  });

  it('strict では複数出辺はエラー (C-13)', () => {
    const src = `lane L\n A[a]\n B[b]\n C[c]\nA -> B\nA -> C`;
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('循環を作る辺を戻り辺に選挙する (C-25)', () => {
    const src = `lane L\n A[a]\n B[b]\nA -> B\nB -> A`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    const back = n.edges.find((e) => e.from === 'B' && e.to === 'A');
    expect(back?.isReturn).toBe(true);
  });

  it('合流（ダイヤモンド）は戻り辺にしない (C-25)', () => {
    // 宣言順がレーン別で逆行していても、循環が無ければ前向き
    const src = `lane L1\n D[d]\nlane L2\n A[a]\n B[b]\n C[c]\nA -> B\nA -> C\nB -> D\nC -> D`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.edges.filter((e) => e.isReturn)).toHaveLength(0);
  });

  it('->> が無い invoice 同型は再合流を戻りにする (C-25)', () => {
    const src = `lane TA
 start s
 task assign[Assign]
 task review[Review]
 xor ok[Review successful?]
 end fail[not processed]
lane AP
 task approve[Approve]
 xor dec[approved?]
lane AC
 task pay[Pay]
 end done[processed]
s -> assign
assign -> approve
ok -> approve: yes
ok -> fail: no
dec -> pay: yes
review -> ok
approve -> dec
dec -> review: no`;
    const n = normalize(parse(src).ir, false);
    expect(n.edges.find((e) => e.from === 'ok' && e.to.startsWith('x_j'))?.isReturn).toBe(true);
    expect(n.edges.find((e) => e.from === 'dec' && e.to === 'review')?.isReturn).toBe(false);
  });

  it('->> は指定辺だけを戻りに固定し、残る循環は DFS のまま (C-25)', () => {
    const src = `lane TA
 start s
 task assign[Assign]
 task review[Review]
 xor ok[Review successful?]
 end fail[not processed]
lane AP
 task approve[Approve]
 xor dec[approved?]
lane AC
 task pay[Pay]
 end done[processed]
s -> assign
assign -> approve
ok -> approve: yes
ok -> fail: no
dec -> pay: yes
review -> ok
approve -> dec
dec ->> review: no`;
    const n = normalize(parse(src).ir, false);
    const p = place(n);
    expect(n.edges.find((e) => e.from === 'dec' && e.to === 'review')?.isReturn).toBe(true);
    expect(n.edges.find((e) => e.from === 'dec' && e.to === 'review')?.returnHint).toBe(true);
    expect(n.edges.find((e) => e.from === 'ok' && e.to.startsWith('x_j'))?.isReturn).toBe(false);
    expect(p.col.get('review')!).toBeLessThan(p.col.get('dec')!);
    expect(n.nodes.find((x) => x.id === 'pay')?.onSpine).toBe(true);
    expect(n.nodes.find((x) => x.id === 'review')?.onSpine).toBe(false);
  });

  it('閉路に無い ->> は戻りにせず警告する (C-25)', () => {
    const src = `lane L\n start s\n A[a]\n B[b]\n end e\ns -> A\nA ->> B\nB -> e`;
    const n = normalize(parse(src).ir, false);
    expect(n.edges.find((e) => e.from === 'A' && e.to === 'B')?.isReturn).toBe(false);
    expect(n.report.some((d) => d.code === 'W-254')).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('倉庫を先に宣言したループでも DFS 既定は決定へ戻る辺 (C-25)', () => {
    const src = `lane Stock\n task stock[在庫]\nlane Desk\n start s\n xor g[判定]\n end e\ns -> g\ng -> stock\nstock -> g\ng -> e`;
    const n = normalize(parse(src).ir, false);
    expect(n.edges.some((e) => e.from === 'stock' && e.isReturn)).toBe(true);
    expect(n.edges.find((e) => e.from === 'g' && e.to === 'stock')?.isReturn).toBe(false);
  });

  it('start / end が無ければ補完する', () => {
    const src = `lane L\n A[a]\n B[b]\nA -> B`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.some((x) => x.kind === 'start' && x.synthetic)).toBe(true);
    expect(n.nodes.some((x) => x.kind === 'end' && x.synthetic)).toBe(true);
    expect(n.report.some((d) => d.code === 'W-220')).toBe(true);
    expect(n.report.some((d) => d.code === 'W-221')).toBe(true);
  });

  it('strict でも start / end の全自動補完は警告として可視化し、互換性を保つ', () => {
    const r = compile(`lane L\n A[a]\n B[b]\nA -> B`, { strict: true });
    expect(r.diagnostics.some((d) => d.code === 'W-220')).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'W-221')).toBe(true);
  });

  it('明示 start があるプールの追加 source は strict で停止する', () => {
    const src = `lane L\n start s\n task A[本流]\n task orphan[孤立]\n end e\ns -> A\nA -> e`;
    expect(compile(src).diagnostics.some((d) => d.code === 'W-223' && d.message.includes('orphan'))).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('明示 end があるプールの追加 sink は strict で停止する', () => {
    const src = `lane L\n start s\n xor branch[分岐]\n task A[本流]\n task dead[未完了]\n end e\ns -> branch\nbranch -> A\nbranch -> dead\nA -> e`;
    expect(compile(src).diagnostics.some((d) => d.code === 'W-224' && d.message.includes('dead'))).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('BPMN 合法な暗黙 XOR merge は strict でも維持する', () => {
    expect(() => compile(IMPLICIT_JOIN_FLOW, { strict: true })).not.toThrow();
  });

  it('message だけが入る自動 source は受信開始の明示を促す', () => {
    const src = `pool caller[依頼者]\nlane C\n task send[依頼する]\npool service[サービス]\nlane S\n task(receive) receive[受信する]\nsend ~> receive`;
    const r = compile(src, { strict: true });
    expect(r.diagnostics.some((d) => d.code === 'W-234' && d.message.includes('receive'))).toBe(true);
  });

  it('Event Sub-Process と compensation handler は通常の source/sink 診断から除外する', () => {
    const src = `lane L\n start s\n task main[本流]\n end e\n task(eventSub,message) interrupt[割込み処理]\n task(user,compensation) undo[補償処理]\ns -> main\nmain -> e`;
    const r = compile(src, { strict: true });
    expect(r.diagnostics.some((d) => ['E-223', 'E-224', 'W-223', 'W-224'].includes(d.code))).toBe(false);
  });

  it('Link Intermediate Event は意図的な接続点として source/sink 診断から除外する', () => {
    const src = `lane L\n start s\n task before[前半]\n mid(link,throw) jump[移動]\n mid(link) resume[再開]\n task after[後半]\n end e\ns -> before\nbefore -> jump\nresume -> after\nafter -> e`;
    const r = compile(src, { strict: true });
    expect(r.diagnostics.some((d) => ['E-223', 'E-224', 'W-223', 'W-224'].includes(d.code))).toBe(false);
  });

  it('start / end はプールごとに不足分を補完する', () => {
    const src = `pool p1[P1]\nlane L1\n A[a]\npool p2[P2]\nlane L2\n start s2\n B[b]\n end e2\n s2 -> B\n B -> e2\n A ~> B`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    const a = n.nodes.find((x) => x.id === 'A')!;
    expect(n.nodes.some((x) => x.kind === 'start' && x.synthetic && x.lane === a.lane)).toBe(true);
    expect(n.nodes.some((x) => x.kind === 'end' && x.synthetic && x.lane === a.lane)).toBe(true);
    expect(n.nodes.filter((x) => x.kind === 'start' && x.lane !== a.lane)).toHaveLength(1);
    expect(n.nodes.filter((x) => x.kind === 'end' && x.lane !== a.lane)).toHaveLength(1);
  });

  it('合成ノード ID はユーザー ID と衝突しない', () => {
    const src = `lane L\n xor x_s_A\n xor x_j_C\n A[a]\n B[b]\n C[c]\n A -> B\n A -> C\n B -> C`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(new Set(n.nodes.map((x) => x.id)).size).toBe(n.nodes.length);
    expect(n.nodes.some((x) => x.synthetic && x.id === 'x_s_A_2')).toBe(true);
    expect(n.nodes.some((x) => x.synthetic && x.id === 'x_j_C_2')).toBe(true);
  });

  it('補完 start / end の ID もユーザー ID と衝突しない', () => {
    const src = `lane L\n task s_a_A[user]\n task e_a_A[user]\n A[a]\n B[b]\n B -> s_a_A\n e_a_A -> B`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(new Set(n.nodes.map((x) => x.id)).size).toBe(n.nodes.length);
    expect(n.nodes.some((x) => x.synthetic && x.id === 's_a_A_2')).toBe(true);
    expect(n.nodes.some((x) => x.synthetic && x.id === 'e_a_A_2')).toBe(true);
  });

  it('本流を選挙し => ヒントが優先される (C-22)', () => {
    const src = `lane L\n start s\n A[a]\n xor g[判定]\n B[b]\n C[c]\ns -> A\nA -> g\ng -> B: 例外\ng => C\n`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.find((x) => x.id === 'C')?.onSpine).toBe(true);
    expect(n.nodes.find((x) => x.id === 'B')?.onSpine).toBe(false);
  });

  it('ヒントがなければ行き止まりより終了へ到達する枝を本流にする (C-22)', () => {
    const src = `lane L\n start s\n xor g[判定]\n task dead[保留]\n task finish[完了処理]\n end e[完了]\ns -> g\ng -> dead\ng -> finish: 承認\nfinish -> e`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.find((x) => x.id === 'finish')?.onSpine).toBe(true);
    expect(n.nodes.find((x) => x.id === 'dead')?.onSpine).toBe(false);
  });

  it('明示した => は終了到達性より優先する (C-22)', () => {
    const src = `lane L\n start s\n xor g[判定]\n task hold[保留]\n task finish[完了処理]\n end e[完了]\ns -> g\ng => hold\ng -> finish\nfinish -> e`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.find((x) => x.id === 'hold')?.onSpine).toBe(true);
    expect(n.nodes.find((x) => x.id === 'finish')?.onSpine).toBe(false);
  });

  it('Default Flow の otherwise/却下は無ラベル継続に負けて本流にならない (C-22)', () => {
    const src = `lane L\n start s\n xor g[判定]\n task work[通常処理]\n task timeout[期限切れ]\n end e_ok[完了]\n end e_ng[却下]\ns -> g\ng -> work\ng ->/ timeout\nwork -> e_ok\ntimeout -> e_ng`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.find((x) => x.id === 'work')?.onSpine).toBe(true);
    expect(n.nodes.find((x) => x.id === 'timeout')?.onSpine).toBe(false);
  });

  it('協調図ではプールごとに本流を選挙する (C-22)', () => {
    const src = `pool P1[依頼者]\nlane L1\n start s1\n A[a]\n s1 -> A\npool P2[処理者]\nlane L2\n start s2\n B[b]\n s2 -> B`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    for (const id of ['s1', 'A', 's2', 'B']) expect(n.nodes.find((x) => x.id === id)?.onSpine, id).toBe(true);
  });

  it('同条件の分岐では同一レーンの継続を本流にする (C-22)', () => {
    const src = `pool P[工程]\nlane Main\n start s\n xor g\n A[a]\nlane Other\n B[b]\ns -> g\ng -> B: optional\ng -> A: always`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    expect(n.nodes.find((x) => x.id === 'A')?.onSpine).toBe(true);
    expect(n.nodes.find((x) => x.id === 'B')?.onSpine).toBe(false);
  });
});

describe('C-15 不正・途中入力', () => {
  it('未宣言ノードは自動実体化して描く (lax)', () => {
    const src = `lane L\n A[a]\nA -> 謎ノード`;
    const r = compile(src);
    expect(r.geometry.nodes.some((n) => n.id === '謎ノード')).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'W-102')).toBe(true);
  });

  it('壊れた行はスキップして必ず何かを描く', () => {
    const src = `lane L\n A[a]\n!!!! ???\nA ->`;
    const r = compile(src);
    expect(r.svg).toContain('<svg');
  });

  it('レーン外宣言は「？」レーンに収容 (lax)', () => {
    const src = `A[a]\nlane L\n B[b]\nA -> B`;
    const r = compile(src);
    expect(r.geometry.lanes.some((l) => l.id === '？')).toBe(true);
  });
});

describe('パーサ契約', () => {
  it('flow と lane の安定 ID と表示名を分離し、従来形も維持する', () => {
    const named = parse(`flow purchase[購買・支払]\nlane applicant[申請者]\n A[申請する]`);
    expect(named.ir.id).toBe('purchase');
    expect(named.ir.title).toBe('購買・支払');
    expect(named.ir.lanes[0]).toMatchObject({ id: 'applicant', label: '申請者' });
    expect(compile(`flow purchase[購買・支払]\nlane applicant[申請者]\n A[申請する]`).svg)
      .not.toContain('applicant[申請者]');

    const legacy = parse(`flow 購買・支払\nlane 申請者\n A[申請する]`);
    expect(legacy.ir.id).toBeUndefined();
    expect(legacy.ir.title).toBe('購買・支払');
    expect(legacy.ir.lanes[0]).toMatchObject({ id: '申請者', label: '申請者' });
  });

  it('同じ表示名のレーンをプールごとに分離する', () => {
    const src = `pool p1[A社]\nlane 営業\n start s1\n T1[受注]\n s1 -> T1\npool p2[B社]\nlane 営業\n start s2\n T2[受注]\n s2 -> T2\n T1 ~> T2`;
    const { ir, diagnostics } = parse(src);
    const sales = ir.lanes.filter((lane) => lane.label === '営業');
    expect(sales).toHaveLength(2);
    expect(new Set(sales.map((lane) => lane.id)).size).toBe(2);
    expect(ir.nodes.find((n) => n.id === 'T1')?.lane).not.toBe(ir.nodes.find((n) => n.id === 'T2')?.lane);
    expect(ir.edges.find((e) => e.from === 'T1' && e.to === 'T2')?.kind).toBe('msg');
    expect(diagnostics.some((d) => d.code === 'W-003' || d.code === 'E-205')).toBe(false);
  });

  it('黒箱プール ID と既存レーン表示名が重なっても別帯として扱う', () => {
    const src = `pool p1[P1]\nlane BB\n A[a]\npool BB[外部]\n A ~> BB`;
    const r = noOracleViolations(src);
    const lanes = r.normalized.lanes.filter((lane) => lane.label === 'BB' || lane.label === '外部');
    expect(new Set(lanes.map((lane) => lane.id)).size).toBe(2);
    expect(r.normalized.lanes.find((lane) => lane.pool === 'BB')?.blackbox).toBe(true);
  });

  it('角括弧内の # はラベルとして保持し、外側の # はコメントにする', () => {
    const { ir, diagnostics } = parse(`lane L\n A[Issue #123] # ticket\n B[done]\n A -> B: 本流 # comment`);
    expect(ir.nodes.find((n) => n.id === 'A')?.label).toBe('Issue #123');
    expect(ir.edges[0]?.label).toBe('本流');
    expect(diagnostics.some((d) => d.code === 'W-007')).toBe(false);
  });

  it('flow は独立したキーワードとしてだけ解釈する', () => {
    const { ir } = parse(`lane L\n flowing[流れ]\n B[b]\n flowing -> B`);
    expect(ir.title).toBeUndefined();
    expect(ir.nodes.some((n) => n.id === 'flowing' && n.label === '流れ')).toBe(true);
    expect(ir.edges.some((e) => e.from === 'flowing' && e.to === 'B')).toBe(true);
  });
});

describe('P0 文書再掲 (C-66)', () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => `  task t${i}[工程${i}]`).join('\n') +
    '\n' + Array.from({ length: n - 1 }, (_, i) => `t${i} -> t${i + 1}`).join('\n');

  it('遠く離れた書き手を持つストアを参照の塊ごとに再掲する', () => {
    const src = `lane L
${chain(9)}
  store s[会計システム]
t0 -.-> s
t8 -.-> s`;
    const n = normalize(parse(src).ir);
    const glyphs = n.nodes.filter((x) => x.id === 's' || x.repeatOf === 's');
    expect(glyphs.map((x) => x.id)).toEqual(['s', 's__2']);
    expect(glyphs[1]!.synthetic).toBe(true);
    expect(n.edges.find((e) => e.from === 't0' && e.kind === 'assoc')!.to).toBe('s');
    expect(n.edges.find((e) => e.from === 't8' && e.kind === 'assoc')!.to).toBe('s__2');
    expect(n.report.some((d) => d.code === 'N-260')).toBe(true);
    const r = compile(src);
    expect(r.diagnostics.filter((d) => d.code.startsWith('O-'))).toEqual([]);
    expect(r.geometry.nodes.filter((x) => x.label === '会計システム')).toHaveLength(2);
  });

  it('近い参照は再掲しない', () => {
    const src = `lane L
${chain(4)}
  store s[会計システム]
t0 -.-> s
t3 -.-> s`;
    const n = normalize(parse(src).ir);
    expect(n.nodes.filter((x) => x.repeatOf !== undefined)).toHaveLength(0);
  });

  it('再掲図形は参照元のレーンへ置き、順序は決定的', () => {
    const src = `lane A
  task a[書く]
lane B
  task b[中継]
lane C
  task c[読む]
  doc d[帳票]
a -> b
b -> c
a -.-> d
d -.-> c`;
    const first = normalize(parse(src).ir);
    const second = normalize(parse(src).ir);
    expect(first.nodes.map((x) => `${x.id}:${x.lane}`)).toEqual(second.nodes.map((x) => `${x.id}:${x.lane}`));
    const glyphs = first.nodes.filter((x) => x.id === 'd' || x.repeatOf === 'd');
    // レーン距離 2 は再掲しない(隣接 2 レーン以内は 1 折れの関連線で読める)
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]!.lane).toBe('C');
  });
});
