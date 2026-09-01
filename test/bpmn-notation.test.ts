import { describe, expect, it } from 'vitest';
import { compile, CompileError, parse } from '../src/compile.ts';
import { LEGAL_EVENT, LEGAL_BOUNDARY_NONINT, eventTriggerOf, eventSlotOf, legalEvent } from '../src/bpmn.ts';
import type { EventTrigger } from '../src/types.ts';

const lane = (body: string) => `lane L\n${body}`;

const svgOf = (body: string) => compile(lane(body)).svg;

describe('SVG provenance', () => {
  it('生成元の Process Model Generator 版を root に刻む', () => {
    expect(compile(lane('task A[x]'), { version: '9.8.7' }).svg).toContain('data-process-model-generator="9.8.7"');
  });
});

describe('未知 subtype は黙って消えない', () => {
  it('未知タスク subtype は warning と data-unknown-subtype を残す', () => {
    const r = compile(lane('task(foo) A[x]'));
    expect(r.diagnostics.some((d) => d.code === 'W-311')).toBe(true);
    expect(r.svg).toContain('data-unknown-subtype="foo"');
    expect(r.svg).not.toMatch(/data-task-marker="foo"/);
  });

  it('未知イベント subtype は空アイコンにせず unknown を残す', () => {
    const r = compile(lane('start(foo) s'));
    expect(r.diagnostics.some((d) => d.code === 'W-311')).toBe(true);
    expect(r.svg).toContain('data-event-marker="unknown"');
    expect(r.svg).toContain('data-unknown-subtype="foo"');
  });

  it('strict では未知 subtype が error になる', () => {
    expect(() => compile(lane('end(nope) e'), { strict: true })).toThrow(CompileError);
  });
});

describe('イベントの合法・違法組合せ', () => {
  const all: EventTrigger[] = [
    'none', 'message', 'timer', 'error', 'escalation', 'cancel',
    'compensation', 'conditional', 'link', 'signal', 'terminate',
    'multiple', 'parallelMultiple',
  ];

  it('合法表は Start/Catch/Throw/End を列挙する', () => {
    expect(LEGAL_EVENT.start).toContain('message');
    expect(LEGAL_EVENT.start).not.toContain('error');
    expect(LEGAL_EVENT.catch).not.toContain('none');
    expect(LEGAL_EVENT.throw).toContain('none');
    expect(LEGAL_EVENT.end).toContain('terminate');
    expect(LEGAL_EVENT.end).not.toContain('timer');
  });

  for (const trigger of all) {
    it(`end(${trigger}) の合法性`, () => {
      const src = trigger === 'none' ? lane('end e') : lane(`end(${trigger}) e`);
      const r = compile(src);
      const illegal = r.diagnostics.some((d) => d.code === 'W-310' || d.code === 'E-310');
      // Cancel End 自体は表上の End Event だが、フラット DSL では必須の Transaction
      // 内部文脈を表現できないため fail-closed で診断する。
      expect(illegal).toBe(trigger === 'cancel' || !legalEvent('end', trigger));
    });
  }

  it('end(timer) は違法として診断する', () => {
    const r = compile(lane('end(timer) e'));
    expect(r.diagnostics.some((d) => d.code === 'W-310' && d.message.includes('timer'))).toBe(true);
  });

  it('mid(message) は catch、mid(message,throw) は throw', () => {
    const c = parse(lane('mid(message) a[wait]'));
    const t = parse(lane('mid(message,throw) b[send]'));
    expect(eventSlotOf(c.ir.nodes[0]!)).toBe('catch');
    expect(eventSlotOf(t.ir.nodes[0]!)).toBe('throw');
    expect(eventTriggerOf(c.ir.nodes[0]!)).toBe('message');
  });

  it('mid 無印は none throw（catch none は違法）', () => {
    const { ir } = parse(lane('mid m'));
    expect(eventSlotOf(ir.nodes[0]!)).toBe('throw');
    expect(eventTriggerOf(ir.nodes[0]!)).toBe('none');
  });

  it('catch 無印（none catch）は違法', () => {
    const r = compile(lane('catch c'));
    expect(r.diagnostics.some((d) => d.code === 'W-310')).toBe(true);
  });
});

describe('catch / throw の塗り分け', () => {
  it('mid(message) は未塗り、throw と end は塗り', () => {
    const catchSvg = svgOf('mid(message) a[wait]');
    const throwSvg = svgOf('mid(message,throw) b[send]');
    const endSvg = svgOf('end(message) e');
    expect(catchSvg).toContain('data-event-filled="false"');
    expect(throwSvg).toContain('data-event-filled="true"');
    expect(endSvg).toContain('data-event-filled="true"');
    expect(catchSvg).toContain('data-event-role="catch"');
    expect(throwSvg).toContain('data-event-role="throw"');
  });

  it('start は常に catch、terminate は塗りつぶし円', () => {
    expect(svgOf('start(message) s')).toContain('data-event-filled="false"');
    expect(svgOf('end(terminate) e')).toContain('data-event-marker="terminate"');
  });
});

describe('境界イベント interrupting / non-interrupting', () => {
  const src = (line: string) => `lane L
  task A[作業]
  ${line}
  task B[続き]
  task H[例外]
A -> B
be -> H`;

  it('割込み境界は実線の二重円', () => {
    const r = compile(src('boundary(timer) be[期限] @A'));
    expect(r.diagnostics.filter((d) => d.code === 'W-314')).toEqual([]);
    const g = r.svg.match(/<g id="node-be">[\s\S]*?<\/g>/)![0];
    expect(g).toContain('data-event-role="boundary"');
    expect(g).not.toContain('stroke-dasharray="4 3"');
    expect(g).toContain('data-event-marker="timer"');
  });

  it('非割込み境界は破線', () => {
    const r = compile(src('boundary(message,nonint) be[通知] @A'));
    const g = r.svg.match(/<g id="node-be">[\s\S]*?<\/g>/)![0];
    expect(g).toContain('data-event-role="boundary-nonint"');
    expect(g).toContain('stroke-dasharray="4 3"');
  });

  it('error の非割込み境界は違法', () => {
    const r = compile(src('boundary(error,nonint) be[誤] @A'));
    expect(r.diagnostics.some((d) => d.code === 'W-310')).toBe(true);
    expect(LEGAL_BOUNDARY_NONINT).not.toContain('error');
  });

  it('Cancel Boundary は Transaction にだけ付けられる', () => {
    expect(compile(src('boundary(cancel) be[取消] @A')).diagnostics.some((d) => d.code === 'W-310')).toBe(true);
    const ok = compile(`lane L
task(transaction) T[取引]
boundary(cancel) be[取消] @T`);
    expect(ok.diagnostics.filter((d) => d.code === 'W-310')).toEqual([]);
  });

  it('Boundary の合流配線は両方向とも直交する', () => {
    const body = `lane L
start s
task A[Work]
boundary(timer) be[Timeout] @A
end e
s -> A
A -> e
be -> e`;
    for (const source of [body, `orientation vertical\n${body}`]) {
      const r = compile(source);
      expect(r.diagnostics.filter((d) => d.code.startsWith('O-') || d.code === 'W-252')).toEqual([]);
      const edge = r.geometry.edges.find((e) => e.from === 'be')!;
      expect(edge.points.every((p, i) => i === 0 || p.x === edge.points[i - 1]!.x || p.y === edge.points[i - 1]!.y)).toBe(true);
    }
  });

  it('対象のない境界は診断する', () => {
    const r = compile(lane('boundary(timer) be'));
    expect(r.diagnostics.some((d) => d.code === 'W-314')).toBe(true);
  });
});

describe('ゲートウェイ', () => {
  it('既存 xor(event) と xor(or) を維持する', () => {
    expect(svgOf('xor(event) g')).toContain('data-gateway-marker="event"');
    expect(svgOf('xor(or) g')).toContain('data-gateway-marker="inclusive"');
  });

  it('complex と並列イベントベースを描く', () => {
    expect(svgOf('xor(complex) g')).toContain('data-gateway-marker="complex"');
    expect(svgOf('and(event) g')).toContain('data-gateway-marker="parallel-event"');
    expect(svgOf('or g1[含む]')).toContain('data-gateway-marker="inclusive"');
    expect(svgOf('complex g2')).toContain('data-gateway-marker="complex"');
  });
});

describe('Message Flow の端点', () => {
  const collaboration = (target: string) => `pool sender[送信者]\nlane S\n task send[送る]\npool receiver[受信者]\nlane R\n ${target}\nsend ~> receive`;

  it('task と message catch は送受信端点として使える', () => {
    const task = compile(collaboration('task(receive) receive[受信する]'), { strict: true });
    expect(task.diagnostics.some((d) => d.code.endsWith('207'))).toBe(false);
    const event = compile(collaboration('catch(message) receive[回答を待つ]'), { strict: true });
    expect(event.diagnostics.some((d) => d.code.endsWith('207'))).toBe(false);
  });

  it('gateway への message は lax で W-207、strict で E-207', () => {
    const src = collaboration('xor receive[回答は可能か]');
    expect(compile(src).diagnostics.some((d) => d.code === 'W-207')).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('doc からの message は lax で W-207、strict で E-207', () => {
    const src = `pool sender[送信者]\nlane S\n doc payload[回答書]\npool receiver[受信者]\nlane R\n task receive[受信する]\npayload ~> receive`;
    expect(compile(src).diagnostics.some((d) => d.code === 'W-207')).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('black-box pool は合法な端点だが、反対側の gateway は診断する', () => {
    const bad = `pool supplier[取引先]\npool company[自社]\nlane buyer\n xor decision[回答は可能か]\nsupplier ~> decision`;
    expect(compile(bad).diagnostics.some((d) => d.code === 'W-207')).toBe(true);
    expect(() => compile(bad, { strict: true })).toThrow(CompileError);

    const ok = `pool supplier[取引先]\npool company[自社]\nlane buyer\n task(receive) answer[回答を受信する]\nsupplier ~> answer`;
    expect(compile(ok, { strict: true }).diagnostics.some((d) => d.code.endsWith('207'))).toBe(false);
  });

  it('Message Flow が none start に着地したら message start を要求する', () => {
    const bad = collaboration('start receive[受信開始]');
    expect(compile(bad).diagnostics.some((d) => d.code === 'W-207')).toBe(true);
    expect(() => compile(bad, { strict: true })).toThrow(CompileError);

    const ok = collaboration('start(message) receive[受信開始]');
    expect(compile(ok, { strict: true }).diagnostics.some((d) => d.code.endsWith('207'))).toBe(false);
  });
});

describe('監査向け通信と分岐レビュー', () => {
  it('Message Flow が着地しない catch(message) を W-235 にする', () => {
    const src = lane('task ask[照会する]\ncatch(message) answer[回答を待つ]\nask -> answer');
    expect(compile(src, { strict: true }).diagnostics.some((d) => d.code === 'W-235')).toBe(true);
  });

  it('外部送信の後続に返信があれば W-236 を出さず、片道なら出す', () => {
    const answered = `pool company[自社]\nlane buyer\n task ask[照会する]\n catch(message) answer[回答を受信する]\n ask -> answer\npool supplier[取引先]\nask ~> supplier: 照会\nsupplier ~> answer: 回答`;
    expect(compile(answered).diagnostics.some((d) => d.code === 'W-236')).toBe(false);

    const oneWay = `pool company[自社]\nlane buyer\n task ask[照会する]\n task continue_work[続行する]\n ask -> continue_work\npool supplier[取引先]\nask ~> supplier: 照会`;
    expect(compile(oneWay, { strict: true }).diagnostics.some((d) => d.code === 'W-236')).toBe(true);
  });

  it('白箱プールの返信側を W-236 にせず、黒箱から始まる未回答照会は残す', () => {
    const whiteBoxReply = `pool company[自社]\nlane buyer[購買]\n task ask[照会する]\n catch(message) answer[回答を受信する]\n ask -> answer\npool supplier[取引先]\nlane sales[営業]\n task receive[照会を受ける]\n task reply[回答する]\n receive -> reply\nask ~> receive: 照会\nreply ~> answer: 回答`;
    expect(compile(whiteBoxReply).diagnostics.filter((d) => d.code === 'W-236')).toEqual([]);

    const unansweredAfterInbound = `pool company[自社]\nlane accounting[経理]\n start(message) invoice[請求書を受信する]\n task investigate[差異を照会する]\n invoice -> investigate\npool supplier[取引先]\nsupplier ~> invoice: 請求書\ninvestigate ~> supplier: 差異照会`;
    expect(compile(unansweredAfterInbound).diagnostics.some((d) => d.code === 'W-236')).toBe(true);
  });

  it('完了した往復の後に始まる第二の照会を返信扱いにしない', () => {
    const src = `pool company[自社]
lane buyer[購買]
 task ask1[第一照会]
 catch(message) answer1[第一回答]
 task ask2[第二照会]
 task continue_work[続行]
 ask1 -> answer1
 answer1 -> ask2
 ask2 -> continue_work
pool supplier[取引先]
lane sales[営業]
 task receive1[第一照会を受ける]
 task reply1[第一回答を返す]
 task receive2[第二照会を受ける]
 receive1 -> reply1
 reply1 -> receive2
ask1 ~> receive1: 第一照会
reply1 ~> answer1: 第一回答
ask2 ~> receive2: 第二照会`;
    const warnings = compile(src).diagnostics.filter((d) => d.code === 'W-236');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('ask2');
  });

  it('一つの受信から並列に返す二つの応答を片道扱いにしない', () => {
    const src = `pool company[自社]
lane buyer[購買]
 task ask[照会]
 catch(message) answer1[回答1]
 catch(message) answer2[回答2]
 ask -> answer1
pool supplier[取引先]
lane sales[営業]
 task receive[照会を受ける]
 and split[回答を分ける]
 task reply1[回答1を返す]
 task reply2[回答2を返す]
 receive -> split
 split -> reply1
 split -> reply2
ask ~> receive: 照会
reply1 ~> answer1: 回答1
reply2 ~> answer2: 回答2`;
    expect(compile(src).diagnostics.filter((d) => d.code === 'W-236')).toEqual([]);
  });

  it('すべて同じ次ノードへ直結する gateway を W-237 にする', () => {
    const bad = lane('xor variants[方式はどれか]\ntask next[続行する]\nvariants -> next: A\nvariants -> next: B');
    expect(compile(bad, { strict: true }).diagnostics.some((d) => d.code === 'W-237')).toBe(true);

    const ok = lane('xor variants[方式はどれか]\ntask a[Aを処理する]\ntask b[Bを処理する]\nvariants -> a: A\nvariants -> b: B');
    expect(compile(ok).diagnostics.some((d) => d.code === 'W-237')).toBe(false);
  });
});

describe('開始・終了イベントのシーケンス方向', () => {
  it('start への入辺は lax で W-225、strict で E-225', () => {
    const src = lane('start s\ntask revise[修正]\nrevise -> s');
    expect(compile(src).diagnostics.some((d) => d.code === 'W-225')).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });

  it('end からの出辺は lax で W-225、strict で E-225', () => {
    const src = lane('end e\ntask next[続行]\ne -> next');
    expect(compile(src).diagnostics.some((d) => d.code === 'W-225')).toBe(true);
    expect(() => compile(src, { strict: true })).toThrow(CompileError);
  });
});

describe('成果物レーンの所有権レビュー', () => {
  it('ゲートウェイを data association の端点にしたら W-208', () => {
    const src = `pool company[自社]
lane owner[担当]
 xor issued[発行済みか]
 store erp[ERP]
 issued -.-> erp`;
    expect(compile(src).diagnostics.some((d) => d.code === 'W-208')).toBe(true);
  });

  it('Data Object をプール越しに関連付けたら W-209、Data Store は免除', () => {
    const bad = `pool supplier[取引先]
lane sales[営業]
 doc invoice[請求書]
pool company[自社]
lane accounting[経理]
 task preserve[請求書を保存する]
 invoice -.-> preserve`;
    expect(compile(bad).diagnostics.some((d) => d.code === 'W-209')).toBe(true);

    const ok = `pool supplier[取引先]
lane sales[営業]
 store portal[請求ポータル]
pool company[自社]
lane accounting[経理]
 task read[請求情報を読む]
 portal -.-> read`;
    expect(compile(ok).diagnostics.some((d) => d.code === 'W-209')).toBe(false);
  });

  it('関連活動が別レーンだけなら W-105 を出し、自動移動しない', () => {
    const src = `pool company[自社]\nlane 責任者\n doc invoice[請求書]\nlane 経理\n task check[照合する]\ninvoice -.-> check`;
    const r = compile(src, { strict: true });
    expect(r.diagnostics.some((d) => d.code === 'W-105' && d.message.includes('invoice'))).toBe(true);
    expect(r.normalized.nodes.find((n) => n.id === 'invoice')?.lane).toBe('責任者');
  });

  it('同じレーンの関連活動があれば W-105 を出さない', () => {
    const src = lane('task create[作成する]\ndoc invoice[請求書]\ncreate -.-> invoice');
    expect(compile(src).diagnostics.some((d) => d.code === 'W-105')).toBe(false);
  });
});

describe('役割レーンのレビュー', () => {
  it('同じ役割に工程名だけを足した疑似レーンを W-107 にする', () => {
    const bad = `pool company[自社]\nlane accounting[経理担当]\n task prepare[振込データを作る]\nlane accounting_result[経理担当（結果確認）]\n task confirm[結果を確認する]\nprepare -> confirm`;
    expect(compile(bad).diagnostics.some((d) => d.code === 'W-107')).toBe(true);

    const ok = `pool company[自社]\nlane domestic[経理担当（国内）]\n task prepare[国内振込を作る]\nlane international[経理担当（海外）]\n task confirm[海外振込を作る]\nprepare -> confirm`;
    expect(compile(ok).diagnostics.some((d) => d.code === 'W-107')).toBe(false);
  });
});

describe('Activity マーカーと Call Activity', () => {
  it('collapsed sub-process と call process を区別する', () => {
    const sub = svgOf('task(sub) S[子]');
    const call = svgOf('task(call) C[呼出]');
    const glob = svgOf('task(call,global) G[大域]');
    expect(sub).toContain('data-task-type="sub"');
    expect(sub).toContain('data-activity-marker="collapsed"');
    expect(call).toContain('data-task-type="call-process"');
    expect(call).toContain('data-activity-marker="collapsed"');
    expect(call).toMatch(/stroke-width="2.6"/);
    expect(glob).toContain('data-task-type="call-global"');
    expect(glob).not.toContain('data-activity-marker="collapsed"');
    expect(glob).toMatch(/stroke-width="2.6"/);
    const globalUser = svgOf('task(call,global,user) U[利用者呼出]');
    expect(globalUser).toContain('data-task-type="call-global"');
    expect(globalUser).toContain('data-task-marker="user"');
  });

  it('loop / MI / compensation / ad-hoc を下部に並べる', () => {
    const loop = svgOf('task(user,loop) A[反復]');
    expect(loop).toContain('data-task-marker="user"');
    expect(loop).toContain('data-activity-marker="loop"');
    expect(svgOf('task(service,parallel) A[並]')).toContain('data-activity-marker="parallel-mi"');
    expect(svgOf('task(service,sequential) A[順]')).toContain('data-activity-marker="sequential-mi"');
    expect(svgOf('task(user,compensation) A[補償]')).toContain('data-activity-marker="compensation"');
    expect(svgOf('task(sub,adhoc) A[adhoc]')).toContain('data-activity-marker="adhoc"');
  });

  it('transaction は二重枠、event sub は破線枠', () => {
    expect(svgOf('task(transaction) T[tx]')).toContain('data-task-border="transaction"');
    const ev = svgOf('task(sub,event,message) E[esub]');
    expect(ev).toContain('data-task-type="eventSub"');
    expect(ev).toContain('stroke-dasharray="4 3"');
    expect(ev).toContain('data-event-sub-start="message"');
    expect(svgOf('task(eventSub,timer,nonint) E[esub]')).toContain('data-event-sub-interrupting="false"');
    expect(compile(lane('task(eventSub) E[esub]')).diagnostics.some((d) => d.code === 'W-310')).toBe(true);
  });

  it('全イベントマーカーが SVG に識別属性を持つ', () => {
    const markers: Array<[string, string]> = [
      ['start(message) s', 'message'],
      ['start(timer) s', 'timer'],
      ['start(conditional) s', 'conditional'],
      ['start(signal) s', 'signal'],
      ['start(multiple) s', 'multiple'],
      ['start(parallel) s', 'parallelMultiple'],
      ['end(error) e', 'error'],
      ['end(escalation) e', 'escalation'],
      ['end(cancel) e', 'cancel'],
      ['end(compensation) e', 'compensation'],
      ['end(terminate) e', 'terminate'],
      ['mid(link) m', 'link'],
    ];
    for (const [line, marker] of markers) {
      expect(svgOf(line), line).toContain(`data-event-marker="${marker}"`);
    }
  });
});

describe('default flow / conditional / main-path hint', () => {
  it('=> は本流ヒントであり default slash を付けない', () => {
    const r = compile(`lane L
start s
xor g
task A[a]
task B[b]
end e
s -> g
g => A
g -> B: 例外
A -> e`);
    const main = r.svg.match(/<g id="edge-e1_g_A">[\s\S]*?<\/g>/)![0];
    const alt = r.svg.match(/<g id="edge-e2_g_B">[\s\S]*?<\/g>/)![0];
    expect(main).not.toContain('data-default-slash');
    expect(main).toContain('data-main-path="true"');
    expect(alt).not.toContain('data-conditional-diamond');
    expect(r.normalized.edges.find((e) => e.from === 'g' && e.to === 'A')?.mainHint).toBe(true);
    expect(r.normalized.edges.find((e) => e.from === 'g' && e.to === 'A')?.isDefault).toBeFalsy();
  });

  it('->> は戻りヒントであり => や default とは独立', () => {
    const r = compile(`lane L
start s
task A[a]
xor g
end e
s -> A
A -> g
g => e
g ->> A: 差戻し`);
    const hinted = r.normalized.edges.find((e) => e.returnHint)!;
    expect(hinted.from).toBe('g');
    expect(hinted.returnHint).toBe(true);
    expect(hinted.mainHint).toBe(false);
    expect(hinted.isDefault).toBeFalsy();
    expect(hinted.isReturn).toBe(true);
    expect(r.svg).toContain('data-return-hint="true"');
    expect(r.svg).not.toContain('data-default-slash');
    expect(r.normalized.edges.find((e) => e.from === 'g' && e.to === 'e')?.onSpine).toBe(true);
  });

  it('->/ は Default Flow の斜線を描き、=> とは独立', () => {
    const r = compile(`lane L
start s
task A[a]
task B[b]
xor g
end e
s -> g
g ->/ A
g -> B: 他
A -> e`);
    expect(r.svg).toContain('data-default-slash="true"');
    expect(r.svg).toContain('data-edge-default="true"');
    const def = r.normalized.edges.find((e) => e.from === 'g' && e.to === 'A')!;
    expect(def.isDefault).toBe(true);
    expect(def.mainHint).toBe(false);
  });

  it('非ゲートウェイ起点の条件ラベルはミニ菱形', () => {
    const r = compile(`lane L
start s
task A[a]
task B[b]
end e
s -> A
A -> B: 条件付き
B -> e`);
    expect(r.svg).toContain('data-conditional-diamond="true"');
    expect(r.normalized.edges.find((e) => e.from === 'A' && e.to === 'B')?.isConditional).toBe(true);
  });

  it('Default Flow の始点と本数を検証する', () => {
    const badSource = compile(`lane L
start s
task A[a]
s ->/ A`);
    expect(badSource.diagnostics.some((d) => d.code === 'W-316')).toBe(true);
    const multiple = compile(`lane L
xor g
task A[a]
task B[b]
g ->/ A
g ->/ B`);
    expect(multiple.diagnostics.some((d) => d.code === 'W-316' && d.message.includes('一つ'))).toBe(true);
    const conditionalDefault = compile(`lane L
task A[a]
task B[b]
A ->/ B: 条件`);
    expect(conditionalDefault.diagnostics.some((d) => d.code === 'W-316' && d.message.includes('条件'))).toBe(true);
  });
});

describe('Association の方向性', () => {
  it('データ関連・無方向・方向付き・双方向を区別する', () => {
    const r = compile(`lane L
task A[a]
doc d[帳票]
note n[注]
A -.-> d
A -.- n
n ..> A`);
    expect(r.svg).toContain('data-assoc="data"');
    expect(r.svg).toContain('data-assoc="undirected"');
    expect(r.svg).toContain('data-assoc="directed"');
    const both = compile(`lane L
task A[a]
note n[n]
A <..> n`);
    expect(both.normalized.edges[0]?.assocKind).toBe('both');
    expect(both.svg).toContain('data-assoc="both"');
  });
});

describe('診断と SVG の構文健全性', () => {
  it('未知 subtype は同じ W-311 を重複報告しない', () => {
    expect(compile(lane('task(foo) A[x]')).diagnostics.filter((d) => d.code === 'W-311')).toHaveLength(1);
  });

  it('Loop と MI の全競合を診断し、MI を採用する', () => {
    const sequential = compile(lane('task(user,loop,sequential) A[x]'));
    expect(sequential.diagnostics.filter((d) => d.code === 'W-312')).toHaveLength(1);
    expect(sequential.normalized.nodes[0]?.loop).toBe('sequential');
    const parallel = compile(lane('task(user,sequential,parallel) A[x]'));
    expect(parallel.normalized.nodes[0]?.loop).toBe('parallel');
  });

  it('全標準マーカーを含む SVG に隣接属性や重複属性がない', () => {
    const source = `lane L
task(user,loop) u[user]
task(service,parallel) sv[service]
task(rule,sequential) r[rule]
task(script,compensation) sc[script]
task(send) se[send]
task(receive) re[receive]
task(manual) ma[manual]
task(sub,adhoc) sub[sub]
task(call,global,user) call[call]
task(eventSub,message) es[event]
start(parallelMultiple) st
end(cancel) ca
mid(link,throw) li
u -> sv
sv -> r
r -> sc
sc -> se
se -> re
re -> ma
ma -> sub
sub -> call
call -> es
es -> st
st -> ca
li -> ca`;
    const svg = compile(source).svg;
    expect(svg).not.toMatch(/"[A-Za-z_:][\w:.-]*=/);
    for (const tag of svg.match(/<[^!?/][^>]*>/g) ?? []) {
      const attrs = [...tag.matchAll(/(?:^|\s)([A-Za-z_:][\w:.-]*)\s*=/g)].map((m) => m[1]);
      expect(new Set(attrs).size, tag).toBe(attrs.length);
    }
  });
});

describe('Data / Artifact', () => {
  it('Data Input/Output と collection を描く', () => {
    expect(svgOf('doc(input) i[in]')).toContain('data-doc-io="input"');
    expect(svgOf('doc(output) o[out]')).toContain('data-doc-io="output"');
    expect(svgOf('doc(collection) c[列]')).toContain('data-collection="true"');
    expect(svgOf('doc(message) m[msg]')).toContain('data-artifact="message"');
    expect(svgOf('group g[班]')).toContain('data-artifact="group"');
  });
});

describe('決定性と向きの意味同一性', () => {
  const src = `lane L
start(message) s[開始]
task(user,loop) A[作業]
boundary(timer,nonint) be[期限] @A
xor(complex) g
task(call) C[呼出]
end(terminate) e
s -> A
A ->/ g
g -> C: 条件
C -> e
be -> e`;

  it('連続コンパイルは byte-identical', () => {
    expect(compile(src).svg).toBe(compile(src).svg);
  });

  it('horizontal / vertical で意味モデルが同じ', () => {
    const h = compile(src);
    const v = compile(`orientation vertical\n${src}`);
    expect(v.normalized.nodes.map((n) => [
      n.id, n.kind, n.subtype, n.eventThrow, n.interrupting, n.attachedTo,
      n.callProcess, n.callTaskType, n.eventSubTrigger, n.eventSubInterrupting, n.loop,
    ])).toEqual(h.normalized.nodes.map((n) => [
      n.id, n.kind, n.subtype, n.eventThrow, n.interrupting, n.attachedTo,
      n.callProcess, n.callTaskType, n.eventSubTrigger, n.eventSubInterrupting, n.loop,
    ]));
    expect(v.normalized.edges.map((e) => [e.id, e.kind, e.mainHint, e.returnHint, e.isDefault, e.isConditional, e.assocKind]))
      .toEqual(h.normalized.edges.map((e) => [e.id, e.kind, e.mainHint, e.returnHint, e.isDefault, e.isConditional, e.assocKind]));
  });

  it('S-66 のトップレベルグループ順を保つ', () => {
    const { svg } = compile(src);
    const iBand = svg.indexOf('<g id="layer-band">');
    const iEdges = svg.indexOf('<g id="layer-edges">');
    const iNodes = svg.indexOf('<g id="layer-nodes">');
    expect(iBand).toBeGreaterThan(-1);
    expect(iEdges).toBeGreaterThan(iBand);
    expect(iNodes).toBeGreaterThan(iEdges);
  });
});
