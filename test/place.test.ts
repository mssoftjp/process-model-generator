import { describe, expect, it } from 'vitest';
import { compile, parse } from '../src/compile.ts';
import { normalize } from '../src/normalize.ts';
import { place } from '../src/place.ts';
import { route } from '../src/route.ts';
import { inspectEdgeLabels } from '../src/edge-labels.ts';
import { boundaryRayPorts, improveDataAssociations, visualAppearancePenalty } from '../src/oarsp.ts';
import { differentSourceSharedLength } from '../src/crossing-causes.ts';
import type { EdgeGeom, Geometry, NodeGeom } from '../src/types.ts';
import { noOracleViolations } from './helpers.ts';

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

  it('同じ工程から出る 2 本の通信は、同列の 1 本を一直線にし残りが幹線を共有する', () => {
    // 2 点の一直線はスロット分離を受けないが、同一始点の通信は幹線共有(S-32)で重なってよい。
    const src = `pool p1[A]\nlane L1\n start s1\n task F[発信]\n task X[受信1]\n s1 -> F\n F -> X\npool p2[B]\nlane L2\n start s2\n task P[相手1]\n task Q[中間]\n task R[相手2]\n s2 -> P\n P -> Q\n Q -> R\n F ~> P\n F ~> R`;
    const r = noOracleViolations(src);
    const toP = r.geometry.edges.find((e) => e.kind === 'msg' && e.to === 'P')!;
    const toR = r.geometry.edges.find((e) => e.kind === 'msg' && e.to === 'R')!;
    expect(toP.points).toHaveLength(2); // 同列は一直線
    expect(toR.points[0]).toEqual(toP.points[0]); // 同じ出口点から幹線を共有して分岐
    expect(toR.points).toHaveLength(4);
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
