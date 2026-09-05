import { describe, expect, it } from 'vitest';
import { compile, parse } from '../src/compile.ts';
import { normalize } from '../src/normalize.ts';
import { place } from '../src/place.ts';
import { route } from '../src/route.ts';
import { checkOracle } from '../src/oracle.ts';
import { inspectEdgeLabels, placeEdgeLabels } from '../src/edge-labels.ts';
import { computeHops } from '../src/wire.ts';
import type { EdgeGeom } from '../src/types.ts';
import { BRANCH_FLOW, IMPLICIT_JOIN_FLOW, COLLABORATION_FLOW, VERTICAL_MESSAGE_LABEL_FLOW, noOracleViolations } from './helpers.ts';

describe('分岐と出口の視覚文法', () => {
  it('同列の文書・保管先出力は手前のノードを短い側面経路で避ける', () => {
    const r = noOracleViolations(`lane accounting
task write[記録する]
task exception[例外処理]
store archive[保管先]
write -.-> archive`);
    const edge = r.geometry.edges.find((e) => e.from === 'write' && e.to === 'archive')!;
    const target = r.geometry.nodes.find((n) => n.id === 'archive')!;
    expect(edge.points).toHaveLength(4);
    expect(edge.points.at(-1)).toEqual({ x: target.x + target.w, y: target.cy });
  });

  it('同列の複数保管先も同じ側面経路で分岐する', () => {
    const r = noOracleViolations(`lane accounting
task write[記録する]
task exception[例外処理]
store ledger[台帳]
store archive[保管先]
write -.-> ledger
write -.-> archive`);
    const edges = r.geometry.edges.filter((e) => e.from === 'write' && e.kind === 'assoc');
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      const target = r.geometry.nodes.find((n) => n.id === edge.to)!;
      expect(edge.points).toHaveLength(4);
      expect(edge.points.at(-1)).toEqual({ x: target.x + target.w, y: target.cy });
    }
  });

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

describe('fuzz 残余の回帰 (L28)', () => {
  it('同一始点のストア関連を束ねるとき、同一行の 2 点直線は斜線にしない', () => {
    // seed 1707: 2 点の直線に始点だけのオフセットが掛かり O-1 になった
    const src = `pool A[A]
lane L0[L0]
  end n0[終了]
  task n1[検品]
  mid n2[待機]
  store n3[台帳]
  task n4[処理]
pool B[B]
lane L1[L1]
  store n5[別台帳]
  task n6[確認]
n0 -> n1
n2 -> n3
n3 -> n4
n4 -> n5
n5 -> n6
n2 -> n5: 条件ラベル`;
    const r = noOracleViolations(src);
    const direct = r.geometry.edges.find((e) => e.kind === 'assoc' && e.from === 'n2' && e.to === 'n3')!;
    expect(direct.points).toHaveLength(2);
    expect(direct.points[0]!.y).toBe(direct.points[1]!.y);
  });

  it('黒箱プールからの下辺入りは、直下のセルが埋まっていれば同じチャネルを使わない', () => {
    // seed 784 / 1734: 直下ノードへの上辺降下と列中心で重なった
    const src = `pool P[自社]
lane A[上]
  task a[準備]
lane L[下]
  start(message) s[受信]
  task t[処理]
  and g[並列]
  s -> t
pool BB[外部]
BB ~> s
a -.-> g`;
    const r = noOracleViolations(src);
    const msg = r.geometry.edges.find((e) => e.kind === 'msg')!;
    const s = r.geometry.nodes.find((n) => n.id === 's')!;
    // 下辺(直下に g がいる)ではなく上辺へ入る
    expect(msg.points.at(-1)!.y).toBeLessThan(s.cy);
  });

  it('書き手の列へ戻したストアからの戻り辺は W-252 を出さない', () => {
    // seed 1435: 文書類は時間軸を進めないので列の前後関係を約束しない
    const src = `pool P[P]
lane L[L]
  xor n0[受注]
  store n1[台帳]
n0 -> n1
n1 ~> n0`;
    const r = compile(src);
    expect(r.diagnostics.filter((d) => d.code === 'W-252')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code.startsWith('O-'))).toEqual([]);
  });
});
