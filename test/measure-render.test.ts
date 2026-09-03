import { describe, expect, it } from 'vitest';
import { compile, parse } from '../src/compile.ts';
import { normalize } from '../src/normalize.ts';
import { place } from '../src/place.ts';
import { wrapText, measureText, quant } from '../src/metrics.ts';
import { measureNodes } from '../src/measure.ts';
import { checkOracle } from '../src/oracle.ts';
import { BRANCH_FLOW, COLLABORATION_FLOW, noOracleViolations } from './helpers.ts';

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
