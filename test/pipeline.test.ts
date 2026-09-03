import { describe, expect, it } from 'vitest';
import { compile, CompileError, parse } from '../src/compile.ts';
import { normalize } from '../src/normalize.ts';
import { place } from '../src/place.ts';
import { route } from '../src/route.ts';
import { wrapText, measureText, quant } from '../src/metrics.ts';
import { measureNodes } from '../src/measure.ts';
import { checkOracle } from '../src/oracle.ts';
import { currentLabelScore, edgeLabelBox, inspectEdgeLabels, placeEdgeLabels } from '../src/edge-labels.ts';
import { computeHops } from '../src/wire.ts';
import {
  boundaryRayPorts, improveDataAssociations, visualAppearancePenalty,
} from '../src/oarsp.ts';
import { differentSourceSharedLength } from '../src/crossing-causes.ts';
import type { EdgeGeom, Geometry, NodeGeom } from '../src/types.ts';

const BRANCH_FLOW = `flow review
pool internal[Internal]
lane requester
  start s[Start]
  task receive[Receive]
lane reviewer
  xor decision[Decision]
  task approve[Approve]
  task reject[Reject]
  end approved[Approved]
  end rejected[Rejected]
s -> receive
receive -> decision
decision => approve: yes
decision -> reject: no
approve -> approved
reject -> rejected`;

const IMPLICIT_JOIN_FLOW = `flow implicit join
lane operations
  start s[Start]
  xor split[Choose]
  task B[Path B]
  task C[Path C]
  task D[Continue]
  end e[Done]
s -> split
split -> B
split -> C
B -> D
C -> D
D -> e`;

const COLLABORATION_FLOW = `flow collaboration
pool p0[Requester]
lane requester
  start req_start[Start]
  task req_send[Send request]
  task req_review[Review reply]
  xor req_decide[Accept?]
  task req_revise[Revise request]
  end req_done[Done]
  doc record[Review record]
req_start -> req_send
req_send -> req_review
req_review -> req_decide
req_decide => req_done: yes
req_decide -> req_revise: no
req_revise -> req_send
req_review -.-> record

pool p1[Service]
lane service
  start(message) svc_start[Request received]
  task svc_receive[Validate request]
  task svc_process[Process]
  mid(message) svc_wait[Wait for confirmation]
  task svc_reply[Send reply]
  end(message) svc_end[Closed]
svc_start -> svc_receive
svc_receive -> svc_process
svc_process -> svc_wait
svc_wait -> svc_reply
svc_reply -> svc_end

req_send ~> svc_start
svc_reply ~> req_review
req_review ~> svc_reply`;

const VERTICAL_MESSAGE_LABEL_FLOW = `orientation vertical
flow message label ownership
pool company[社内]
lane internal[社内]
  task A[A]
  task(sub) B[B]
  task X[X]
  task Y[Y]
  task Z[Z]
  task(sub) C[納品・検収]
pool supplier[取引先]
lane supplier[取引先]
  task(sub) S1[受注確認]
  task(sub) S2[納品・完了報告]
  task(sub) S3[請求]
A -> B
B -> X
X -> Y
Y -> Z
Z -> C
S1 -> S2: 受注可能
S2 -> S3
B ~> S1: 注文書PDF
S1 ~> B: 受注可否・変更納期
S2 ~> C: 商品・納品書・完了報告書
C ~> S2: 交換・追納依頼`;

const SMOKE_FLOWS = [BRANCH_FLOW, IMPLICIT_JOIN_FLOW, COLLABORATION_FLOW];

const noOracleViolations = (src: string) => {
  const r = compile(src);
  const oracle = r.diagnostics.filter((d) => d.code.startsWith('O-'));
  expect(oracle, oracle.map((d) => d.message).join('\n')).toEqual([]);
  return r;
};

describe('synthetic smoke cases', () => {
  for (const [index, source] of SMOKE_FLOWS.entries()) {
    it(`case ${index + 1} がオラクル違反なくコンパイルできる`, () => {
      const r = noOracleViolations(source);
      expect(r.svg).toContain('<svg');
      expect(r.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    });
  }
});

describe('決定性 (C-82)', () => {
  it('同じテキストは同じ SVG', () => {
    expect(compile(BRANCH_FLOW).svg).toBe(compile(BRANCH_FLOW).svg);
  });
});

describe('P0 正規化', () => {
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

describe('R5 計測', () => {
  it('CJK は全角幅で計測される', () => {
    expect(measureText('あい', 14)).toBe(28);
  });
  it('禁則: 行頭に「。」が来ない', () => {
    const lines = wrapText('こんにちは。世界のみなさん。', 70, 14);
    for (const l of lines) expect(l.startsWith('。')).toBe(false);
  });
  it('量子化は格子の整数倍', () => {
    expect(quant(41) % 8).toBe(0);
  });
  it('長いタスクも最大 128px 級の外形に折り返す (C-71)', () => {
    const { ir } = parse(`lane L\n A[hand over to collection agency]`);
    const n = normalize(ir, false).nodes.find((x) => x.id === 'A')!;
    const cell = measureNodes([n]).get('A')!;
    expect(cell.shapeW).toBeLessThanOrEqual(128);
    expect(cell.shapeH).toBeGreaterThanOrEqual(56);
  });
  it('短いタスクはラベルに合わせて最小幅へ縮める (C-71)', () => {
    const { ir } = parse(`lane L\n A[OK]`);
    const n = normalize(ir, false).nodes.find((x) => x.id === 'A')!;
    const cell = measureNodes([n]).get('A')!;
    expect(cell.shapeW).toBe(80);
  });
});

describe('R4 局所性', () => {
  it('末尾への追加は既存ノードのセルを動かさない', () => {
    const base = `lane L1\n A[a]\n B[b]\nlane L2\n C[c]\nA -> B\nB -> C`;
    const added = base + `\nlane L2\n D[追加]\nC -> D`;
    const r1 = compile(base);
    const r2 = compile(added);
    for (const n1 of r1.geometry.nodes) {
      if (n1.id.startsWith('e_a_')) continue; // 補完された終了イベントは付け替わる
      const n2 = r2.geometry.nodes.find((n) => n.id === n1.id);
      expect(n2, `${n1.id} が消えた`).toBeDefined();
      expect(n2!.lane).toBe(n1.lane);
    }
  });
});

describe('タスク種別マーカー', () => {
  it('manual task を手作業マーカーで描き分ける', () => {
    const r = compile(`lane L\n task(manual) A[手作業]`);
    expect(r.svg).toContain('data-task-marker="manual"');
  });
});

describe('SVG 編集グループ (S-66)', () => {
  const parentGroupId = (svg: string, targetId: string): string | undefined => {
    const stack: Array<string | undefined> = [];
    for (const m of svg.matchAll(/<g\b[^>]*>|<\/g>/g)) {
      const tag = m[0];
      if (tag === '</g>') {
        stack.pop();
        continue;
      }
      const id = /\bid="([^"]+)"/.exec(tag)?.[1];
      if (id === targetId) return stack.at(-1);
      if (!tag.endsWith('/>')) stack.push(id);
    }
    return undefined;
  };

  const groupContent = (svg: string, id: string): string => {
    // ノード・辺グループは <g> を入れ子にしないので非貪欲でよい
    const m = svg.match(new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`));
    expect(m, `グループ ${id} が無い`).toBeTruthy();
    return m![1]!;
  };

  it('帯→辺→ノードの3層が固定順で重なる(帯が背面、ノードが前面)', () => {
    const { svg } = compile(BRANCH_FLOW);
    const iBand = svg.indexOf('<g id="layer-band">');
    const iEdges = svg.indexOf('<g id="layer-edges">');
    const iNodes = svg.indexOf('<g id="layer-nodes">');
    expect(iBand).toBeGreaterThan(-1);
    expect(iEdges).toBeGreaterThan(iBand);
    expect(iNodes).toBeGreaterThan(iEdges);
  });

  it('レーンは所属プールのグループへ入れ子になる', () => {
    const { svg } = compile(COLLABORATION_FLOW);
    expect(parentGroupId(svg, 'pool-p0')).toBe('layer-band');
    expect(parentGroupId(svg, 'lane-requester')).toBe('pool-p0');
    expect(parentGroupId(svg, 'pool-p1')).toBe('layer-band');
    expect(parentGroupId(svg, 'lane-service')).toBe('pool-p1');
  });

  it('ノードは全部品と名称、辺は線と矢じりとラベルが各一つのグループにまとまる', () => {
    const r = compile(COLLABORATION_FLOW);
    // 中間イベント = 二重円+封筒マーカー+外置きラベルが一塊
    const mid = groupContent(r.svg, 'node-svc_wait');
    expect((mid.match(/<circle /g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(mid).toContain('<text');
    // 辺 = 線+矢じり(+条件ラベル)が一塊
    const b = compile(BRANCH_FLOW);
    expect((groupContent(b.svg, 'edge-e0_s_receive').match(/<path /g) ?? []).length).toBe(2);
    expect(groupContent(b.svg, 'edge-e2_decision_approve')).toContain('yes');
  });

  it('グループ id は許可された全 DSL id に対して NCName 安全で、正規化衝突を分離する', () => {
    const r = compile(`pool a:b[P1]
lane L1
  task ²[test]
pool a?b[P2]
lane L2
  task B[test]`);
    const ids = [...r.svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `${id} は NCName の安全な部分集合でない`).toMatch(/^[\p{L}_][\p{L}0-9_.-]*$/u);
    }
    expect(ids).toContain('pool-a_b');
    expect(ids).toContain('pool-a_b_2');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('orientation (縦横は同じ意味の別修辞)', () => {
  const vert = (src: string) => `orientation vertical\n${src}`;

  it('DSL 宣言で縦になり、オラクル違反なくコンパイルできる', () => {
    const r = noOracleViolations(vert(COLLABORATION_FLOW));
    expect(r.geometry.orientation).toBe('vertical');
    expect(r.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('縦図ではレーンが左右に並び、本流は上から下へ流れる', () => {
    const r = noOracleViolations(vert(BRANCH_FLOW));
    const [l1, l2] = r.geometry.lanes;
    expect(l1!.y).toBe(l2!.y);
    expect(l1!.x + l1!.w).toBeLessThanOrEqual(l2!.x + 0.01);
    const byId = new Map(r.geometry.nodes.map((n) => [n.id, n]));
    for (const e of r.geometry.edges) {
      if (!e.onSpine || e.kind !== 'seq' || e.isReturn) continue;
      expect(byId.get(e.to)!.cy, `${e.id} は時間軸(下)へ進む`).toBeGreaterThan(byId.get(e.from)!.cy);
    }
  });

  it('縦横で正規化・表配置は変わらない(P0・P2・P3 は向きを知らない)', () => {
    const h = compile(BRANCH_FLOW);
    const v = compile(vert(BRANCH_FLOW));
    const hn = h.normalized;
    const vn = v.normalized;
    expect(vn.nodes.map((n) => [n.id, n.onSpine])).toEqual(hn.nodes.map((n) => [n.id, n.onSpine]));
    expect(vn.edges.map((e) => [e.id, e.isReturn, e.onSpine])).toEqual(
      hn.edges.map((e) => [e.id, e.isReturn, e.onSpine]),
    );
    const ph = place(hn);
    const pv = place(vn);
    expect([...pv.col.entries()]).toEqual([...ph.col.entries()]);
    expect([...pv.row.entries()]).toEqual([...ph.row.entries()]);
  });

  it('縦図のイベント外置きラベルは横(左右)に置かれ、上下ポートを塞がない', () => {
    const r = noOracleViolations(vert(BRANCH_FLOW));
    const start = r.geometry.nodes.find((n) => n.id === 's')!;
    expect(start.labelSide === 'left' || start.labelSide === 'right').toBe(true);
  });

  it('縦図の隣接プール間メッセージ幹線はプール間の縦回廊に収まる', () => {
    const r = noOracleViolations(vert(COLLABORATION_FLOW));
    const p0 = r.geometry.pools.find((p) => p.id === 'p0')!;
    const p1 = r.geometry.pools.find((p) => p.id === 'p1')!;
    expect(p1.x - (p0.x + p0.w)).toBeGreaterThanOrEqual(48);
    for (const e of r.geometry.edges.filter((e) => e.kind === 'msg')) {
      // 同列の一直線(2 点)は幹線を持たない(S-57 / O-10)
      if (e.points.length === 2) continue;
      expect(e.points.some((a, i) => {
        const b = e.points[i + 1];
        return !!b && a.x === b.x && a.y !== b.y && a.x > p0.x + p0.w && a.x < p1.x;
      }), e.id).toBe(true);
    }
  });

  it('縦図の非隣接プール間メッセージは帯の下端より外の回廊を通る', () => {
    const src = `pool p0[P0]\nlane L0\n A[a]\npool p1[P1]\nlane L1\n B[b]\npool p2[P2]\nlane L2\n C[c]\n A ~> C`;
    const r = noOracleViolations(vert(src));
    const middle = r.geometry.pools.find((p) => p.id === 'p1')!;
    const message = r.geometry.edges.find((e) => e.kind === 'msg')!;
    const horizontalThroughMiddle = message.points.some((p, i) => {
      const q = message.points[i + 1];
      if (!q || p.y !== q.y || p.y >= r.geometry.bandBottom) return false;
      return Math.max(p.x, q.x) > middle.x && Math.min(p.x, q.x) < middle.x + middle.w;
    });
    expect(horizontalThroughMiddle).toBe(false);
    expect(message.points.some((p) => p.y > r.geometry.bandBottom)).toBe(true);
  });

  it('縦でも決定的 (C-82)', () => {
    expect(compile(vert(BRANCH_FLOW)).svg).toBe(compile(vert(BRANCH_FLOW)).svg);
  });

  it('タイトルは回転しないので、向きによらずキャンバス幅に算入される', () => {
    const title = '出張精算ワークフロー';
    const need = 24 + measureText(title, 16) + 24;
    const v = noOracleViolations(`flow ${title}\norientation vertical\nlane L\n start S`);
    expect(v.geometry.width).toBeGreaterThanOrEqual(need);
    const h = noOracleViolations(`flow ${title}\nlane L\n start S`);
    expect(h.geometry.width).toBeGreaterThanOrEqual(need);
  });

  it('プール名は帯の交差スパンに算入され、隣のプール名と重ならない', () => {
    const body = `pool p0[カスタマーサポートセンター東京本社]\nlane A\n start s1\npool p1[バックオフィス経理財務部]\nlane B\n start s2\n s1 ~> s2`;
    const v = noOracleViolations(`orientation vertical\n${body}`);
    for (const pl of v.geometry.pools) {
      // 縦図: 横書きプール名は帯の幅を要求する。中央寄せテキストが帯に収まれば隣と交差しない
      expect(pl.w, pl.label).toBeGreaterThanOrEqual(measureText(pl.label, 12) + 28);
    }
    const h = noOracleViolations(body);
    for (const pl of h.geometry.pools) {
      // 横図: 回転プール名は帯の高さを要求する(同じ規則の転置)
      expect(pl.h, pl.label).toBeGreaterThanOrEqual(measureText(pl.label, 12) + 28);
    }
  });

  it('縦図でもオラクルは壊れた幾何を検出する(空振りの否定)', () => {
    const r = noOracleViolations(vert(BRANCH_FLOW));
    const broken = structuredClone(r.geometry);
    const edge = broken.edges.find((e) => e.to === 'approved')!;
    const target = broken.nodes.find((n) => n.id === 'approved')!;
    edge.points[edge.points.length - 1] = { x: target.x + target.w, y: target.cy - 14 };
    expect(checkOracle(r.normalized, broken).some((d) => d.code === 'O-2')).toBe(true);
  });

  it('CompileOptions は既定を与えるだけで、DSL 宣言が優先される', () => {
    expect(compile(BRANCH_FLOW, { orientation: 'vertical' }).geometry.orientation).toBe('vertical');
    expect(compile(vert(BRANCH_FLOW), { orientation: 'horizontal' }).geometry.orientation).toBe('vertical');
    expect(compile(`orientation horizontal\n${BRANCH_FLOW}`, { orientation: 'vertical' }).geometry.orientation)
      .toBe('horizontal');
    expect(compile(BRANCH_FLOW).geometry.orientation).toBe('horizontal');
  });

  it('不正な orientation 値は警告して無視する (W-013 / W-014)', () => {
    const bad = parse(`orientation diagonal\nlane L\n A[a]`);
    expect(bad.diagnostics.some((d) => d.code === 'W-013')).toBe(true);
    expect(bad.ir.orientation).toBeUndefined();
    const dup = parse(`orientation vertical\norientation horizontal\nlane L\n A[a]`);
    expect(dup.diagnostics.some((d) => d.code === 'W-014')).toBe(true);
    expect(dup.ir.orientation).toBe('vertical');
  });

  it('orientation は独立したキーワードとしてだけ解釈し、ID 名前空間を奪わない', () => {
    const { ir, diagnostics } = parse(`lane L\n orientation[向き]\n B[b]\n orientation -> B: 条件`);
    expect(ir.orientation).toBeUndefined();
    expect(ir.nodes.some((n) => n.id === 'orientation' && n.label === '向き')).toBe(true);
    const edge = ir.edges.find((e) => e.from === 'orientation' && e.to === 'B');
    expect(edge?.kind).toBe('seq');
    expect(edge?.label).toBe('条件');
    expect(diagnostics.some((d) => d.code === 'W-013' || d.code === 'W-007')).toBe(false);
  });
});

describe('プールごとの時間軸', () => {
  it('途中のメッセージは受信側を送信元より手前に置かず、送信側と受信側の前段は動かさない', () => {
    // 受信側 C は送信元 A3 の列(3)まで右へ。s2 と B は据え置き(待ち時間が空白として現れる)。
    const src = `pool p1[依頼者]\nlane L1\n start s1\n A[依頼]\n A2[追加]\n A3[再依頼]\n s1 -> A\n A -> A2\n A2 -> A3\npool p2[処理者]\nlane L2\n start s2\n B[処理]\n C[続き]\n s2 -> B\n B -> C\n A3 ~> C`;
    const { ir } = parse(src);
    const n = normalize(ir, false);
    const p = place(n);
    expect(p.col.get('s1')).toBe(0);
    expect(p.col.get('A3')).toBe(3);
    expect(p.col.get('s2')).toBe(0);
    expect(p.col.get('B')).toBe(1);
    expect(p.col.get('C')).toBe(3);
  });

  it('返信を受ける工程は返信元の直下に揃い、同列の往復は平行な 2 本の縦線になる', () => {
    const src = `pool p1[依頼者]\nlane L1\n start s1\n A[依頼]\n s1 -> A\npool p2[処理者]\nlane L2\n start(message) s2\n B[処理]\n s2 -> B\n A ~> s2\n B ~> A`;
    const r = noOracleViolations(src);
    const p = place(normalize(parse(src).ir, false));
    expect(p.col.get('A')).toBe(1);
    expect(p.col.get('B')).toBe(2);
    const msgs = r.geometry.edges.filter((e) => e.kind === 'msg');
    expect(msgs).toHaveLength(2);
    const pair = `pool p1[依頼者]\nlane L1\n start s1\n A[依頼]\n s1 -> A\npool p2[処理者]\nlane L2\n task(receive) B[処理]\n A ~> B\n B ~> A`;
    const rp = noOracleViolations(pair);
    const straight = rp.geometry.edges.filter((e) => e.kind === 'msg' && e.points.length === 2);
    expect(straight).toHaveLength(2);
    expect(straight[0]!.points[0]!.x).not.toBe(straight[1]!.points[0]!.x);
  });

  it('開始イベントへのメッセージは受信側プールを送信元の列まで平行移動する', () => {
    // 「注文が届いた時点で仕入先の工程が始まる」を開始イベントの位置で読めるようにする。
    const src = `pool p1[依頼者]\nlane L1\n start s1\n A[依頼]\n s1 -> A\npool p2[処理者]\nlane L2\n start s2\n B[処理]\n s2 -> B\n A ~> s2`;
    const n = normalize(parse(src).ir, false);
    const p = place(n);
    expect(p.col.get('s1')).toBe(0);
    expect(p.col.get('A')).toBe(1);
    expect(p.col.get('s2')).toBe(1); // 送信元 A の列
    expect(p.col.get('B')).toBe(2); // プール内部の相対配置は不変
    const r = noOracleViolations(src);
    const msg = r.geometry.edges.find((e) => e.kind === 'msg')!;
    expect(msg.points).toHaveLength(2); // 同列なので一直線
  });

  it('互いに開始を送り合う循環は、先に宣言した通信だけを整列に使う', () => {
    // A ~> s2 は s2 ≥ col(A) を満たせる。B ~> s1 は s1 ≥ col(B) ≥ col(s2)+1 ≥ col(A)+1 ≥ col(s1)+2 で
    // 収束しないので制約から外れ、直前の列に戻る。
    const src = `pool p1[甲]\nlane L1\n start s1\n A[a]\n s1 -> A\npool p2[乙]\nlane L2\n start s2\n B[b]\n s2 -> B\n A ~> s2\n B ~> s1`;
    const n = normalize(parse(src).ir, false);
    const p = place(n);
    expect(p.col.get('s1')).toBe(0);
    expect(p.col.get('A')).toBe(1);
    expect(p.col.get('s2')).toBe(1);
    expect(p.col.get('B')).toBe(2);
  });
});

describe('分岐と出口の視覚文法', () => {
  it('オフセット付きメッセージ端点は円イベントの実境界へ着地する', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const byId = new Map(r.geometry.nodes.map((n) => [n.id, n]));
    const eventEnds = r.geometry.edges.flatMap((e) => {
      if (e.kind !== 'msg') return [];
      return [[e.from, e.points[0]!], [e.to, e.points.at(-1)!]] as const;
    }).filter(([id]) => {
      const kind = byId.get(id)?.kind;
      return kind === 'start' || kind === 'end' || kind === 'mid';
    });
    expect(eventEnds.length).toBeGreaterThan(0);
    for (const [id, p] of eventEnds) {
      const n = byId.get(id)!;
      expect(Math.hypot((p.x - n.cx) / (n.w / 2), (p.y - n.cy) / (n.h / 2)), id).toBeCloseTo(1, 8);
    }

    const broken = structuredClone(r.geometry);
    const edge = broken.edges.find((e) => e.kind === 'msg' && byId.get(e.to)?.kind === 'start')!;
    const target = broken.nodes.find((n) => n.id === edge.to)!;
    edge.points[edge.points.length - 1] = { x: target.x + target.w, y: target.cy - 14 };
    expect(checkOracle(r.normalized, broken).some((d) => d.code === 'O-2')).toBe(true);
  });

  it('異種の出辺は同じ境界点を共有しない', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const seq = r.geometry.edges.find((e) => e.from === 'svc_reply' && e.kind === 'seq')!;
    const msg = r.geometry.edges.find((e) => e.from === 'svc_reply' && e.kind === 'msg')!;
    expect(msg.points[0]).not.toEqual(seq.points[0]);
  });

  it('縦図のメッセージラベルは他の線やノードと重ならない', () => {
    const r = noOracleViolations(VERTICAL_MESSAGE_LABEL_FLOW);
    expect(inspectEdgeLabels(r.geometry)).toMatchObject({ nodeHits: 0, edgeHits: 0, labelHits: 0 });
  });

  it('辺ラベルの一括配置は決定的かつ冪等', () => {
    const r = noOracleViolations(VERTICAL_MESSAGE_LABEL_FLOW.replace('orientation vertical\n', ''));
    const before = r.geometry.edges.map((e) => e.labelPos && { ...e.labelPos });
    const report = placeEdgeLabels(r.geometry);
    const after = r.geometry.edges.map((e) => e.labelPos && { ...e.labelPos });
    expect(report.moved).toBe(0);
    expect(after).toEqual(before);
    expect(inspectEdgeLabels(r.geometry)).toMatchObject({ nodeHits: 0, edgeHits: 0, labelHits: 0 });
  });

  it('非本流の条件ラベルは共有スタブでなく固有の縦区間に付く', () => {
    const r = noOracleViolations(BRANCH_FLOW);
    const gw = r.geometry.nodes.find((n) => n.id === 'decision')!;
    const yes = r.geometry.edges.find((e) => e.from === 'decision' && e.label === 'yes')!;
    const no = r.geometry.edges.find((e) => e.from === 'decision' && e.label === 'no')!;
    expect(yes.points[0]).toEqual({ x: gw.x + gw.w, y: gw.cy });
    expect(no.points[0]).toEqual({ x: gw.cx, y: gw.y + gw.h });
    expect(yes.labelPos!.y).toBeLessThan(gw.cy);
    expect(no.labelPos!.x).toBeGreaterThan(gw.cx);
    expect(no.labelPos!.x).toBeLessThan(gw.x + gw.w);
    expect(no.labelPos!.y).toBeGreaterThanOrEqual(gw.cy + 20);
    expect(no.labelPos!.y).toBeLessThanOrEqual(gw.y + gw.h + 24);
  });

  it('上下の代替を持つ2分岐は別頂点から出る', () => {
    const r = noOracleViolations(BRANCH_FLOW);
    const outs = r.geometry.edges.filter((e) => e.from === 'decision' && e.kind === 'seq');
    expect(outs).toHaveLength(2);
    expect(outs[0]!.points[0]).not.toEqual(outs[1]!.points[0]);
  });

  it('受信と返信を担うタスクでも異種フローの出口を分ける', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const seq = r.geometry.edges.find((e) => e.from === 'req_review' && e.kind === 'seq')!;
    const msg = r.geometry.edges.find((e) => e.from === 'req_review' && e.kind === 'msg')!;
    expect(msg.points[0]).not.toEqual(seq.points[0]);
  });

  it('データ関連はシーケンスと同じ出口を共有しない', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const assoc = r.geometry.edges.find((e) => e.from === 'req_review' && e.kind === 'assoc')!;
    const seq = r.geometry.edges.find((e) => e.from === 'req_review' && e.kind === 'seq')!;
    expect(assoc.points[0]).not.toEqual(seq.points[0]);
  });

  it('隣接列の同じ溝を二重使用して短いジョグを作らない', () => {
    const r = noOracleViolations(`flow adjacent gutter
lane L
  start e1[Electronic]
  task record[Record]
  start e2[Paper]
  task scan[Scan]
  doc invoice[Invoice]
e1 -> record
e2 -> scan
record -.-> invoice
scan -.-> invoice`);
    const edge = r.geometry.edges.find((e) => e.from === 'record' && e.to === 'invoice')!;
    expect(edge.points).toHaveLength(4);
    expect(edge.points[1]!.x).toBe(edge.points[2]!.x);
  });

  it('暗黙合流は T 字線へ潰さず XOR join を表示する', () => {
    const r = noOracleViolations(IMPLICIT_JOIN_FLOW);
    const join = r.geometry.nodes.find((n) => n.id === 'x_j_D')!;
    const incoming = r.geometry.edges.filter((e) => e.to === join.id);
    const outgoing = r.geometry.edges.find((e) => e.from === join.id)!;
    expect(join.kind).toBe('xor');
    expect(incoming).toHaveLength(2);
    expect(new Set(incoming.map((e) => JSON.stringify(e.points.at(-1)))).size).toBe(2);
    expect(incoming.some((e) => e.points.at(-1)!.x === outgoing.points[0]!.x && e.points.at(-1)!.y === outgoing.points[0]!.y)).toBe(false);
  });

  it('隣接プール間メッセージの水平幹線はプール間余白に収容する', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const p0 = r.geometry.pools.find((p) => p.id === 'p0')!;
    const p1 = r.geometry.pools.find((p) => p.id === 'p1')!;
    expect(p1.y - (p0.y + p0.h)).toBeGreaterThanOrEqual(48);
    const messages = r.geometry.edges.filter((e) => e.kind === 'msg');
    // 境界直後に意味のない小折れを作らない(S-57)。側面出しは水平、列中心の Z 形は垂直で、
    // どちらも最初と最後の区間は 16px 以上の一直線であること。
    const len = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    for (const e of messages) {
      expect(len(e.points[0]!, e.points[1]!), `${e.id} source stub`).toBeGreaterThanOrEqual(16);
      expect(len(e.points.at(-1)!, e.points.at(-2)!), `${e.id} target stub`).toBeGreaterThanOrEqual(16);
      const straight = e.points.length === 2;
      expect(straight || e.points.some((a, i) => {
        const b = e.points[i + 1];
        return !!b && a.y === b.y && a.x !== b.x && a.y > p0.y + p0.h && a.y < p1.y;
      }), e.id).toBe(true);
    }
  });

  it('非隣接プール間メッセージは中間プールの外周を通る', () => {
    const src = `pool p0[P0]\nlane L0\n A[a]\npool p1[P1]\nlane L1\n B[b]\npool p2[P2]\nlane L2\n C[c]\n A ~> C`;
    const r = noOracleViolations(src);
    const middle = r.geometry.pools.find((p) => p.id === 'p1')!;
    const message = r.geometry.edges.find((e) => e.kind === 'msg')!;
    const verticalThroughMiddle = message.points.some((p, i) => {
      const q = message.points[i + 1];
      if (!q || p.x !== q.x || p.x >= r.geometry.bandRight) return false;
      return Math.max(p.y, q.y) > middle.y && Math.min(p.y, q.y) < middle.y + middle.h;
    });
    expect(verticalThroughMiddle).toBe(false);
    expect(message.points.some((p) => p.x > r.geometry.bandRight)).toBe(true);
  });

  it('往復メッセージは同じノードでも送信点と受信点を分ける', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const outgoing = r.geometry.edges.find((e) => e.kind === 'msg' && e.from === 'req_review')!;
    const incoming = r.geometry.edges.find((e) => e.kind === 'msg' && e.to === 'req_review')!;
    expect(outgoing.points[0]).not.toEqual(incoming.points.at(-1));
  });

  it('プール間メッセージ同士に不要な直角交差を作らない', () => {
    const r = noOracleViolations(COLLABORATION_FLOW);
    const messages = r.geometry.edges.filter((e) => e.kind === 'msg');
    const crosses = (a1: { x: number; y: number }, a2: { x: number; y: number }, b1: { x: number; y: number }, b2: { x: number; y: number }) => {
      const aH = a1.y === a2.y;
      const bH = b1.y === b2.y;
      if (aH === bH) return false;
      const [h1, h2, v1, v2] = aH ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
      return v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x) &&
        h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y);
    };
    for (let i = 0; i < messages.length; i++) {
      for (let j = i + 1; j < messages.length; j++) {
        const a = messages[i]!;
        const b = messages[j]!;
        for (let ai = 0; ai + 1 < a.points.length; ai++) {
          for (let bi = 0; bi + 1 < b.points.length; bi++) {
            expect(crosses(a.points[ai]!, a.points[ai + 1]!, b.points[bi]!, b.points[bi + 1]!), `${a.id} × ${b.id}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('競合群の局所入れ替え', () => {
  const JOIN_MESSAGES = `pool Upper
lane u
  start(message) inA[A到着]
  start(message) inB[B到着]
  xor j[合流]
  end e[終]
inA -> j
inB -> j
j -> e
pool Lower
lane l
  start s[開始]
  task sendA[送A]
  task sendB[送B]
  end le[終]
s -> sendA
sendA -> sendB
sendB -> le
sendA ~> inA
sendB ~> inB`;

  it('競合入れ替えは決定的である', () => {
    expect(compile(JOIN_MESSAGES).svg).toBe(compile(JOIN_MESSAGES).svg);
  });

  it('左方向のプール間メッセージは対象から出る本流水平を貫かない', () => {
    const r = noOracleViolations(JOIN_MESSAGES);
    const seq = r.geometry.edges.find((e) => e.kind === 'seq' && e.from === 'inA')!;
    const msg = r.geometry.edges.find((e) => e.kind === 'msg' && e.to === 'inA')!;
    const crosses = (a1: { x: number; y: number }, a2: { x: number; y: number }, b1: { x: number; y: number }, b2: { x: number; y: number }) => {
      const aH = a1.y === a2.y;
      const bH = b1.y === b2.y;
      if (aH === bH) return false;
      const [h1, h2, v1, v2] = aH ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
      return v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x) &&
        h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y);
    };
    for (let si = 0; si + 1 < seq.points.length; si++) {
      for (let mi = 0; mi + 1 < msg.points.length; mi++) {
        expect(
          crosses(seq.points[si]!, seq.points[si + 1]!, msg.points[mi]!, msg.points[mi + 1]!),
          `${seq.id} × ${msg.id}`,
        ).toBe(false);
      }
    }
  });
});

describe('同一終点の列中心予約 (O-6 / S-32)', () => {
  const horizontalOf = (e: { points: Array<{ x: number; y: number }> }) =>
    e.points.flatMap((p, i) => {
      const q = e.points[i + 1];
      return q && p.y === q.y && Math.abs(q.x - p.x) > 40 ? [{ y: p.y, span: Math.abs(q.x - p.x) }] : [];
    });

  it('keihi の二本の戻りは対象レーン上チャネルを不要に占有せず、g2 の出口を分ける', () => {
    const r = noOracleViolations(`lane Applicant
start s
task A[申請]
lane Manager
task B[承認]
xor g1[承認結果]
lane Accounting
task C[確認]
xor g2[不備判定]
task D[振込]
end e
s -> A
A -> B
B -> g1
g1 => C: 承認
g1 -> A: 差し戻し
C -> g2
g2 => D: OK
g2 -> A: 不備返却
D -> e`);
    const applicant = r.geometry.nodes.find((n) => n.id === 'A')!;
    const join = r.geometry.nodes.find((n) => n.id === 'x_j_A')!;
    const g2 = r.geometry.nodes.find((n) => n.id === 'g2')!;
    const ok = r.geometry.edges.find((e) => e.from === 'g2' && e.to === 'D')!;
    const defect = r.geometry.edges.find((e) => e.from === 'g2' && e.isReturn)!;
    expect(ok.points[0]).not.toEqual(defect.points[0]);
    expect(defect.points[0]).toEqual({ x: g2.cx, y: g2.y + g2.h });
    const north = horizontalOf(defect).filter((seg) => seg.y < applicant.cy);
    expect(north, `不備返却が申請者上チャネル y=${north.map((s) => s.y).join(',')}`).toEqual([]);
    expect(r.geometry.edges.filter((e) => e.to === join.id && e.isReturn).length).toBe(2);
  });

  it('同一行の戻りは top が空くとき north 縦出しで右溝を使わない', () => {
    const src = `lane L
start s
task A[A]
xor g[?]
task B[B]
end e
s -> A
A -> g
g => B
B -> e
g ->> A`;
    noOracleViolations(src);
    const n = normalize(parse(src).ir);
    const plan = route(n, place(n), false);
    const edge = n.edges.find((e) => e.from === 'g' && e.isReturn)!;
    const ret = plan.plans.find((pl) => pl.edgeId === edge.id)!;
    expect(ret.fromSide).toBe('top');
    expect(ret.toSide).toBe('top');
    expect(ret.points).toHaveLength(4);
    expect(ret.points[0]!.x).toEqual(ret.points[1]!.x);
    expect(ret.points[0]!.x.t).toBe('nodeCX');
  });

  it('下降分岐は drop 不能でも自列チャネルまで空なら 4 点 U', () => {
    const r = noOracleViolations(`lane L
start s
xor g[?]
task A[A]
xor j[Join]
end ok[OK]
end bad[Bad]
s -> g
g => A
A -> j
j -> ok
g -> bad: no
j -> bad`);
    const g = r.geometry.nodes.find((n) => n.id === 'g')!;
    const down = r.geometry.edges.find((e) => e.from === 'g' && e.label === 'no')!;
    expect(down.points).toHaveLength(4);
    expect(down.points[0]!.x).toBe(g.cx);
    expect(down.points[0]!.y).toBe(g.y + g.h);
    expect(down.points[1]!.x).toBe(down.points[0]!.x);
  });

  it('seq と共存する右出 assoc は cy+10 で始点を共有しない', () => {
    const r = noOracleViolations(`lane L
start s
task a[Mark]
task b[Save]
end e
store st[Sys]
doc d[Ev]
s -> a
a -> b
b -> e
a -.-> st
b -.-> d`);
    const seq = r.geometry.edges.find((e) => e.from === 'b' && e.kind === 'seq')!;
    const assoc = r.geometry.edges.find((e) => e.from === 'b' && e.kind === 'assoc')!;
    expect(assoc.points[0]).not.toEqual(seq.points[0]);
    expect(assoc.points[0]!.x).toBe(seq.points[0]!.x);
    expect(assoc.points[0]!.y).toBe(seq.points[0]!.y + 10);
  });

  it('戻り右溝の非 seq は seq と始点を共有しない', () => {
    // planReturn 右溝フォールバック(C2)。seq 共存の戻り assoc が右中点を共有すると O-8。
    const r = noOracleViolations(`lane レーン1
  store n1[台帳]
lane レーン3
  n0[申請]
n0 -> n1
n1 ~> n0`);
    const seq = r.geometry.edges.find((e) => e.from === 'n0' && e.kind === 'seq')!;
    const assoc = r.geometry.edges.find((e) => e.from === 'n0' && e.kind === 'assoc')!;
    expect(assoc.points[0]).not.toEqual(seq.points[0]);
    expect(assoc.points[0]!.x).toBe(seq.points[0]!.x);
    expect(assoc.points[0]!.y).toBe(seq.points[0]!.y + 10);
  });

  it('複数 writer の文書関連は行基線を共有しない', () => {
    // n2 に seq 出が無くても、溝へ向かう assoc を基線に載せると
    // 同じ行の d1 左入りと水平区間が重なる(O-6 / S-36)。
    const r = noOracleViolations(`lane A
and n0[S]
doc n1[N]
xor n4[G]
lane B
end n2[E]
xor n3[X]
n0 -> n1
n1 -> n2
n3 -> n4
n3 -.-> d1
n2 -.-> d2
n3 -.-> d2`);
    const n2 = r.geometry.nodes.find((n) => n.id === 'n2')!;
    const d1 = r.geometry.nodes.find((n) => n.id === 'd1')!;
    const up = r.geometry.edges.find((e) => e.from === 'n3' && e.to === 'd1')!;
    const across = r.geometry.edges.find((e) => e.from === 'n2' && e.to === 'd2')!;
    expect(n2.cy).toBe(d1.cy);
    expect(across.points[0]!.y).toBe(n2.cy + 10);
    expect(up.points.at(-1)!.y).toBe(d1.cy);
  });

  it('下側の非 seq 入出力は別スロットを使い、入線を上辺へ回さない', () => {
    const r = noOracleViolations(`lane A
task upload[保存]
doc d[文書]
lane B
note n[注記]
upload -.-> d
n -.-> upload`);
    const task = r.geometry.nodes.find((n) => n.id === 'upload')!;
    const outgoing = r.geometry.edges.find((e) => e.from === 'upload' && e.kind === 'assoc')!;
    const incoming = r.geometry.edges.find((e) => e.to === 'upload' && e.kind === 'assoc')!;
    expect(outgoing.points[0]!.y).toBe(task.y + task.h);
    expect(incoming.points.at(-1)!.y).toBe(task.y + task.h);
    expect(outgoing.points[0]!.x).not.toBe(incoming.points.at(-1)!.x);
    expect(outgoing.points[0]!.x).toBe(outgoing.points[1]!.x);
    expect(incoming.points.at(-2)!.x).toBe(incoming.points.at(-1)!.x);
  });

  it('同一始点の関連は口の後で幹線を共有し、他所出の基線に乗らない', () => {
    const r = noOracleViolations(`lane L
start s
task write[書く]
task later[後]
end e
s -> write
write -> later
later -> e
lane archive
store a[A]
store b[B]
write -.-> a
write -.-> b`);
    const assocs = r.geometry.edges.filter((e) => e.kind === 'assoc' && e.from === 'write');
    expect(assocs).toHaveLength(2);
    expect(assocs[0]!.points[0]).not.toEqual(assocs[1]!.points[0]);
    const overlap = (e1: typeof assocs[0], e2: typeof assocs[0]) => {
      let n = 0;
      for (let i = 0; i + 1 < e1.points.length; i++) {
        const a1 = e1.points[i]!, a2 = e1.points[i + 1]!;
        const aH = Math.abs(a1.y - a2.y) < 0.01;
        for (let j = 0; j + 1 < e2.points.length; j++) {
          const b1 = e2.points[j]!, b2 = e2.points[j + 1]!;
          if ((Math.abs(b1.y - b2.y) < 0.01) !== aH) continue;
          if (aH) {
            if (a1.y !== b1.y) continue;
            n += Math.max(0, Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)));
          } else {
            if (a1.x !== b1.x) continue;
            n += Math.max(0, Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)));
          }
        }
      }
      return n;
    };
    expect(overlap(assocs[0]!, assocs[1]!)).toBeGreaterThan(16);
    const seq = r.geometry.edges.find((e) => e.kind === 'seq' && e.from === 'write')!;
    expect(overlap(assocs[0]!, seq)).toBe(0);
    expect(overlap(assocs[1]!, seq)).toBe(0);
  });
});

describe('書き手ゼロ文書の列 (C-67)', () => {
  it('読み専用ストアは読み手の直前列に来る', () => {
    const src = `lane L
task use[読む]
store s[台帳]
s -.-> use`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('s')).toBe(Math.max(0, (p.col.get('use') ?? 0) - 1));
  });

  it('同じ読み手を読む2文書は同列・別行でオラクル沈黙', () => {
    const src = `lane L
task use[読む]
doc a[A]
doc b[B]
a -.-> use
b -.-> use`;
    const r = noOracleViolations(src);
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('a')).toBe(p.col.get('b'));
    expect(p.col.get('a')).toBe(Math.max(0, (p.col.get('use') ?? 0) - 1));
    expect(p.row.get('a')).not.toBe(p.row.get('b'));
    expect(inspectEdgeLabels(r.geometry)).toMatchObject({ nodeHits: 0, edgeHits: 0, labelHits: 0 });
    const entries = r.geometry.edges.filter((e) => e.kind === 'assoc' && e.to === 'use');
    const xs = entries.map((e) => e.points.at(-1)!.x);
    expect(new Set(xs).size).toBe(2);
    expect(xs[0]! + xs[1]!).toBe(2 * r.geometry.nodes.find((n) => n.id === 'use')!.cx);
    expect(entries.every((e) => e.points.at(-2)!.x === e.points.at(-1)!.x)).toBe(true);
  });

  it('多著者文書は最終書き手+1のまま', () => {
    const src = `lane L
task prepare[準備]
task approve[承認]
doc form[帳票]
prepare -.-> form
approve -.-> form
prepare -> approve`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('form')).toBe(Math.max(p.col.get('prepare')!, p.col.get('approve')!) + 1);
    const r = noOracleViolations(src);
    const entries = r.geometry.edges.filter((e) => e.kind === 'assoc' && e.to === 'form');
    const ys = entries.map((e) => e.points.at(-1)!.y);
    expect(new Set(ys).size).toBe(2);
    expect(ys[0]! + ys[1]!).toBe(2 * r.geometry.nodes.find((x) => x.id === 'form')!.cy);
    expect(entries.every((e) => e.points.at(-2)!.y === e.points.at(-1)!.y)).toBe(true);
  });

  it('照合文書は次の XOR と同じ列へ進まず書き手の横へ戻る', () => {
    const src = `lane L
start s
task write[照合する]
xor g[一致したか]
task next[次]
end e
doc a[請求書]
doc b[注文書]
s -> write
write -> g
g => next: 一致
next -> e
write -.-> a
write -.-> b`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('a')).toBe(p.col.get('write'));
    expect(p.col.get('b')).toBe(p.col.get('write'));
    expect(p.col.get('g')).not.toBe(p.col.get('a'));
    noOracleViolations(src);
  });

  it('同じ列の遠い書類は次列の溝を通り書き手より前へ回らない', () => {
    const src = `orientation vertical
lane L
start s
task write[照合する]
xor g[一致したか]
end e
doc a[請求書]
doc b[注文書]
doc c[検収記録]
s -> write
write -> g
g -> e
write -.-> a
write -.-> b
write -.-> c`;
    const r = noOracleViolations(src);
    const write = r.geometry.nodes.find((n) => n.id === 'write')!;
    const a = r.geometry.nodes.find((n) => n.id === 'a')!;
    const b = r.geometry.nodes.find((n) => n.id === 'b')!;
    const c = r.geometry.nodes.find((n) => n.id === 'c')!;
    expect(c.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(a.x);
    const xor = r.geometry.nodes.find((n) => n.id === 'g')!;
    for (const id of ['a', 'b']) {
      const e = r.geometry.edges.find((x) => x.kind === 'assoc' && x.to === id)!;
      const minY = Math.min(...e.points.map((p) => p.y));
      const maxY = Math.max(...e.points.map((p) => p.y));
      expect(minY, id).toBeGreaterThanOrEqual(write.y - 8);
      expect(maxY, id).toBeLessThan(xor.y);
    }
  });

  it('複数書類へ伸びる線は境界ポートと直線ステムを保つ', () => {
    const r = noOracleViolations(`orientation vertical
lane L
start s
task keep[保存]
task write[照合]
xor g
end e
doc invoice[請求書]
doc order[注文書]
doc receipt[検収記録]
s -> keep
keep -> write
write -> g
g -> e
keep -.-> invoice
write -.-> invoice
write -.-> order
write -.-> receipt`);
    expect(r.diagnostics.some((d) => d.code === 'N-434')).toBe(true);
    const keep = r.geometry.nodes.find((n) => n.id === 'keep')!;
    const write = r.geometry.nodes.find((n) => n.id === 'write')!;
    const invoice = r.geometry.nodes.find((n) => n.id === 'invoice')!;
    const rerouted = r.geometry.edges.find((e) => e.from === 'keep' && e.to === 'invoice')!;
    const otherEntry = r.geometry.edges.find((e) => e.from === 'write' && e.to === 'invoice')!;
    const orderEntry = r.geometry.edges.find((e) => e.from === 'write' && e.to === 'order')!;
    const onBoundary = (n: NodeGeom, p: { x: number; y: number }) =>
      p.x === n.x || p.x === n.x + n.w || p.y === n.y || p.y === n.y + n.h;
    expect(onBoundary(keep, rerouted.points[0]!)).toBe(true);
    expect(onBoundary(invoice, rerouted.points.at(-1)!)).toBe(true);
    expect(rerouted.points.at(-1)).not.toEqual(otherEntry.points.at(-1));
    expect(onBoundary(write, orderEntry.points[0]!)).toBe(true);
    const writes = r.geometry.edges.filter((e) => e.kind === 'assoc' && e.from === 'write');
    const groups = new Map<string, number[]>();
    for (const edge of writes) {
      const point = edge.points[0]!;
      const actual = point.x === write.x ? 'left' : point.x === write.x + write.w ? 'right'
        : point.y === write.y ? 'top' : 'bottom';
      expect(onBoundary(write, point)).toBe(true);
      const list = groups.get(actual) ?? [];
      list.push(actual === 'left' || actual === 'right' ? point.y : point.x);
      groups.set(actual, list);
    }
    for (const values of groups.values()) {
      values.sort((a, b) => a - b);
      if (values.length > 1) {
        expect(Math.min(...values.slice(1).map((value, i) => value - values[i]!))).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('互いに塞ぎ合う仮想配線世界から共有ゼロの構成を選ぶ', () => {
    const node = (id: string, x: number, y: number): NodeGeom => ({
      id, kind: 'task', label: id, labelLines: [id], lane: 'L', x, y, w: 40, h: 40,
      cx: x + 20, cy: y + 20, onSpine: false, provisional: false, synthetic: false,
    });
    const edge = (id: string, from: string, to: string, points: EdgeGeom['points']): EdgeGeom => ({
      id, from, to, points, kind: 'assoc', assocKind: 'data', onSpine: false,
      isReturn: false, provisional: false,
    });
    const geometry: Geometry = {
      orientation: 'horizontal', width: 280, height: 160, headerW: 0, bandRight: 280, bandBottom: 160,
      pools: [], lanes: [{ id: 'L', label: 'L', x: 0, y: 0, w: 280, h: 160 }],
      nodes: [node('a', 20, 20), node('b', 20, 100), node('c', 220, 100), node('d', 220, 20)],
      edges: [
        edge('a-c', 'a', 'c', [{ x: 60, y: 40 }, { x: 120, y: 40 }, { x: 120, y: 120 }, { x: 220, y: 120 }]),
        edge('b-d', 'b', 'd', [{ x: 60, y: 120 }, { x: 120, y: 120 }, { x: 120, y: 40 }, { x: 220, y: 40 }]),
      ],
    };
    const improved = improveDataAssociations(geometry);
    expect(improved).not.toBe(geometry);
    expect(differentSourceSharedLength(improved.edges)).toBe(0);
    expect(improveDataAssociations(geometry).edges).toEqual(improved.edges);
  });

  it('同一側に密集した三本・四本を向いた側の離れたポートから扇出しする', () => {
    const node = (id: string, x: number, y: number, w = 40, h = 48): NodeGeom => ({
      id, kind: id === 'source' ? 'task' : 'doc', label: id, labelLines: [id], lane: 'L',
      x, y, w, h, cx: x + w / 2, cy: y + h / 2,
      onSpine: false, provisional: false, synthetic: false,
    });
    const edge = (id: string, to: string, points: EdgeGeom['points']): EdgeGeom => ({
      id, from: 'source', to, points, kind: 'assoc', assocKind: 'data', onSpine: false,
      isReturn: false, provisional: false,
    });
    const geometry: Geometry = {
      orientation: 'horizontal', width: 600, height: 220, headerW: 0, bandRight: 600, bandBottom: 220,
      pools: [], lanes: [{ id: 'L', label: 'L', x: 0, y: 0, w: 600, h: 220 }],
      nodes: [
        node('source', 40, 70, 100, 80), node('d1', 300, 20),
        node('d2', 400, 76), node('d3', 500, 132), node('d4', 540, 160),
      ],
      edges: [
        edge('source-d1', 'd1', [{ x: 140, y: 94 }, { x: 156, y: 94 }, { x: 156, y: 44 }, { x: 300, y: 44 }]),
        edge('source-d2', 'd2', [{ x: 140, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 90 }, { x: 400, y: 90 }, { x: 400, y: 100 }]),
        edge('source-d3', 'd3', [{ x: 140, y: 106 }, { x: 200, y: 106 }, { x: 200, y: 156 }, { x: 500, y: 156 }]),
        edge('source-d4', 'd4', [{ x: 140, y: 112 }, { x: 220, y: 112 }, { x: 220, y: 184 }, { x: 540, y: 184 }]),
      ],
    };
    const expectFanout = (candidate: Geometry) => {
      const improved = improveDataAssociations(candidate);
      expect(improved).not.toBe(candidate);
      const routes = improved.edges.filter((e) => e.from === 'source');
      const ports = routes.map((e) => e.points[0]!);
      expect(ports.every((p) => p.x === 140)).toBe(true);
      const ys = ports.map((p) => p.y).sort((a, b) => a - b);
      expect(Math.min(...ys.slice(1).map((y, i) => y - ys[i]!))).toBeGreaterThanOrEqual(12);
      for (const route of routes.map((e) => e.points).filter((points) => points.length > 2)) {
        expect(Math.abs(route[0]!.x - route[1]!.x) + Math.abs(route[0]!.y - route[1]!.y)).toBeGreaterThanOrEqual(16);
      }
    };
    for (const count of [3, 4]) {
      expectFanout({ ...geometry, nodes: geometry.nodes.slice(0, count + 1), edges: geometry.edges.slice(0, count) });
    }
    expectFanout({
      ...geometry,
      edges: geometry.edges.map((item, i) => ({
        ...item,
        points: item.points.map((point, j) => j < 2 ? { ...point, y: 76 + i * 4 } : point),
      })),
    });

    const other = node('other', 40, 20);
    const competing: EdgeGeom = {
      ...edge('other-d2', 'd2', [
        { x: 80, y: 44 }, { x: 300, y: 44 }, { x: 300, y: 100 }, { x: 400, y: 100 },
      ]),
      from: 'other',
    };
    expectFanout({ ...geometry, nodes: [...geometry.nodes, other], edges: [...geometry.edges, competing] });
  });

  it('短いガタつき・逆走・角寄りポートを外観ペナルティにする', () => {
    const node = (id: string, x: number): NodeGeom => ({
      id, kind: 'task', label: id, labelLines: [id], lane: 'L', x, y: 20, w: 40, h: 40,
      cx: x + 20, cy: 40, onSpine: false, provisional: false, synthetic: false,
    });
    const base: Geometry = {
      orientation: 'horizontal', width: 240, height: 100, headerW: 0, bandRight: 240, bandBottom: 100,
      pools: [], lanes: [{ id: 'L', label: 'L', x: 0, y: 0, w: 240, h: 100 }],
      nodes: [node('a', 20), node('b', 180)], edges: [],
    };
    const edge = (points: EdgeGeom['points']): EdgeGeom => ({
      id: 'a-b', from: 'a', to: 'b', points, kind: 'assoc', assocKind: 'data', onSpine: false,
      isReturn: false, provisional: false,
    });
    const clean = { ...base, edges: [edge([{ x: 60, y: 40 }, { x: 180, y: 40 }])] };
    const ugly = { ...base, edges: [edge([
      { x: 60, y: 26 }, { x: 100, y: 26 }, { x: 100, y: 30 },
      { x: 92, y: 30 }, { x: 92, y: 26 }, { x: 180, y: 26 },
    ])] };
    expect(visualAppearancePenalty(clean)).toBe(0);
    expect(visualAppearancePenalty(ugly)).toBe(76);
  });

  it('中心レイから角を避けた全周ポート集合を作る', () => {
    const node: NodeGeom = {
      id: 'n', kind: 'task', label: 'n', labelLines: ['n'], lane: 'L', x: 20, y: 30, w: 80, h: 54,
      cx: 60, cy: 57, onSpine: false, provisional: false, synthetic: false,
    };
    const ray = boundaryRayPorts(node);
    expect(ray).toHaveLength(16);
    for (const port of ray) {
      const p = port.point;
      expect(p.x === node.x || p.x === node.x + node.w || p.y === node.y || p.y === node.y + node.h).toBe(true);
      expect(Math.min(
        Math.hypot(p.x - node.x, p.y - node.y), Math.hypot(p.x - node.x - node.w, p.y - node.y),
        Math.hypot(p.x - node.x, p.y - node.y - node.h), Math.hypot(p.x - node.x - node.w, p.y - node.y - node.h),
      )).toBeGreaterThanOrEqual(6);
    }
  });

  it('前の列の書き手から余剰行の書類へは、書き手の高さで横断しない', () => {
    const src = `orientation vertical
lane L
start s
task keep[保存]
task write[照合]
xor g
end e
doc d[請求書]
s -> keep
keep -> write
write -> g
g -> e
keep -.-> d
write -.-> d`;
    const r = noOracleViolations(src);
    const keep = r.geometry.nodes.find((n) => n.id === 'keep')!;
    const write = r.geometry.nodes.find((n) => n.id === 'write')!;
    const d = r.geometry.nodes.find((n) => n.id === 'd')!;
    const e = r.geometry.edges.find((x) => x.kind === 'assoc' && x.from === 'keep' && x.to === 'd')!;
    const atKeepHeight = e.points.filter((p) => Math.abs(p.y - keep.cy) < 8);
    expect(Math.max(...atKeepHeight.map((p) => p.x))).toBeLessThan(d.x);
    expect(Math.max(...e.points.map((p) => p.y))).toBeLessThan(write.y + write.h + 24);
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i]!;
      const b = e.points[i + 1]!;
      if (Math.abs(a.y - b.y) > 1) continue;
      if (Math.max(a.x, b.x) < d.x) continue;
      expect(a.y, '照合段の上を横断しない').toBeGreaterThanOrEqual(d.y);
    }
  });

  it('ストアは別レーンの後書き手より同じレーンの書き手の列へ戻る', () => {
    const src = `lane A
task write[入力]
store s[台帳]
lane B
task later[後処理]
write -> later
write -.-> s
later -.-> s`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('s')).toBe(p.col.get('write'));
    noOracleViolations(src);
  });

  it('非本流の書き手と同じセルへ書類を重ねない', () => {
    const src = `lane L
start s
task a[本流]
task b[次]
end e
xor g[分岐]
start extra[開始]
doc d[帳票]
s -> a
a -> b
b -> e
g -> extra
extra -.-> d`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(`${p.col.get('d')}:${p.row.get('d')}`).not.toBe(`${p.col.get('extra')}:${p.row.get('extra')}`);
    noOracleViolations(src);
  });

  it('min は全読み手にわたりレーン優先しない', () => {
    const src = `lane A
doc d[文書]
task t11[後工程]
lane B
task t2[先読み]
t2 -> t11
d -.-> t2
d -.-> t11`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('d')).toBe(Math.max(0, Math.min(p.col.get('t2')!, p.col.get('t11')!) - 1));
  });

  it('note 孤児も最初の読み手の直前', () => {
    const src = `lane L
task t4[終端]
note m[監査対象]
m -.- t4`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('m')).toBe(Math.max(0, (p.col.get('t4') ?? 0) - 1));
  });

  it('W-105 でもレーンは動かさず列だけ直前へ', () => {
    const src = `pool company[自社]\nlane 責任者\n doc invoice[請求書]\nlane 経理\n task check[照合する]\ninvoice -.-> check`;
    const r = compile(src);
    expect(r.diagnostics.some((d) => d.code === 'W-105')).toBe(true);
    expect(r.normalized.nodes.find((n) => n.id === 'invoice')?.lane).toBe('責任者');
    const p = place(r.normalized);
    expect(p.col.get('invoice')).toBe(Math.max(0, (p.col.get('check') ?? 0) - 1));
  });

  it('layering 始点のストアは読み手直前へ動かない (seed758)', () => {
    const src = `lane L
store s[台帳]
mid t1[中間]
task t2[参照]
s ~> t1
s ->/ t2
t1 -> t2
s -.-> t2`;
    const r = noOracleViolations(src);
    const p = place(r.normalized);
    expect(p.col.get('s')!).toBeLessThan(p.col.get('t1')!);
  });
});

describe('同一レーンの文書行と例外行', () => {
  it('帳票は差戻し合流より本流側の行を取る', () => {
    const src = `lane requester
start s
task write[書く]
task send[送る]
end e
task back[差戻しを受ける]
doc form[帳票]
lane manager
task review[確認]
xor gate[足りるか]
task ret[差し戻す]
task ok[承認]
lane director
task dret[差し戻す]
s -> write
write -> send
send -> review
review -> gate
gate => ok: 十分
gate -> ret: 不足
ok -> e
ret -> back
dret -> back
write -.-> form
ok -.-> form`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    const join = n.nodes.find((x) => n.edges.some((e) => e.from === x.id && e.to === 'back'))!;
    expect(p.col.get('form')).toBe(p.col.get(join.id));
    expect(p.row.get('form')!).toBeLessThan(p.row.get(join.id)!);
    noOracleViolations(src);
  });

  it('注記は同じ列の例外工程より本流側へ上がらない', () => {
    const src = `lane L
start s
task pre[前]
xor g[分岐]
task mid[本流]
task close[確認]
end e
task coordinate[調整]
note n[催促]
s -> pre
pre -> g
g => mid: 本流
g -> coordinate: 例外
mid -> close
close -> e
n -.- close`;
    const n = normalize(parse(src).ir);
    const p = place(n);
    expect(p.col.get('n')).toBe(p.col.get('coordinate'));
    expect(p.row.get('coordinate')!).toBeLessThan(p.row.get('n')!);
    noOracleViolations(src);
  });
});

describe('読み手のある文書の列', () => {
  it('書き手直後で固定せず最初の読み手の直前へ寄せる', () => {
    const n = normalize(parse(`lane L
  task make[作成]
  task a[A]
  task b[B]
  task use[利用]
  doc d[証憑]
make -> a
a -> b
b -> use
make -.-> d
d -.-> use`).ir);
    const p = place(n);
    expect(p.col.get('d')).toBe(p.col.get('use')! - 1);
    expect(p.col.get('d')).toBeGreaterThan(p.col.get('make')! + 1);
  });
});

describe('交差ホップ (S-35 点単位)', () => {
  const hopEdge = (id: string, points: Array<{ x: number; y: number }>, onSpine = false): EdgeGeom => ({
    id, kind: 'seq' as const, from: 'a', to: 'b', points, onSpine, isReturn: false, provisional: false,
  });

  it('肘から8pxの内部交差は水平側が跳ぶ', () => {
    const h = hopEdge('h', [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const v = hopEdge('v', [{ x: 50, y: 0 }, { x: 50, y: 28 }]);
    computeHops([h, v]);
    expect(h.hops).toEqual([{ seg: 0, x: 50, y: 20 }]);
    expect(v.hops).toBeUndefined();
  });

  it('端点一致の T 字にはホップが付かない', () => {
    const h = hopEdge('h', [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const v = hopEdge('v', [{ x: 50, y: 0 }, { x: 50, y: 20 }]);
    computeHops([h, v]);
    expect(h.hops).toBeUndefined();
    expect(v.hops).toBeUndefined();
  });

  it('幹線共有では本流が直線のまま縦だけ跳ぶ', () => {
    const spine = hopEdge('s', [{ x: 0, y: 20 }, { x: 100, y: 20 }], true);
    const share = hopEdge('n', [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const vert = hopEdge('v', [{ x: 50, y: 0 }, { x: 50, y: 80 }]);
    computeHops([spine, share, vert]);
    expect(spine.hops).toBeUndefined();
    expect(share.hops).toBeUndefined();
    expect(vert.hops).toEqual([{ seg: 0, x: 50, y: 20 }]);
  });
});

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
    expect(far).toBeLessThanOrEqual(160);
    const high = r.geometry.edges.find((e) => e.label === '100万円以上')!;
    const highStart = high.points[0]!;
    const highBox = edgeLabelBox(high)!;
    const highFar = Math.abs(highBox.x + highBox.w / 2 - highStart.x) +
      Math.abs(highBox.y + highBox.h / 2 - highStart.y);
    expect(highFar).toBeLessThanOrEqual(160);
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
