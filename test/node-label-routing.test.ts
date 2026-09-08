import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';
import { externalNodeLabel, inspectNodeLabelRoutes } from '../src/node-labels.ts';
import { connectedRouteCandidates, improveDataAssociations, sharedPair } from '../src/oarsp.ts';
import { checkNodeLabelRoutes, checkOracle } from '../src/oracle.ts';
import { computeHops } from '../src/wire.ts';
import { rawHits } from '../src/route-intersections.ts';
import type { Geometry, NodeGeom, Pt } from '../src/types.ts';

function positioned(n: NodeGeom, x: number, y: number, w = n.w, h = n.h): NodeGeom {
  return { ...n, x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function mixed() {
  const r = compile(`orientation vertical
lane source
task send[申請を送信]
doc d1[申請内容の詳細な説明書]
doc d2[証憑PDF]
lane target
task check[確認する]
send -> check
d1 -.-> check
d2 -.-> check`, { optimizePlacement: false });
  const boxes: Record<string, number[]> = { send: [100, 60, 100, 60], d1: [280, 66, 40, 48], d2: [460, 66, 40, 48], check: [650, 220, 120, 72] };
  const paths: Record<string, Pt[]> = {
    send: [{ x: 150, y: 120 }, { x: 150, y: 190 }, { x: 710, y: 190 }, { x: 710, y: 220 }],
    d1: [{ x: 300, y: 114 }, { x: 300, y: 240 }, { x: 650, y: 240 }],
    d2: [{ x: 480, y: 114 }, { x: 480, y: 268 }, { x: 650, y: 268 }],
  };
  const geometry: Geometry = {
    ...r.geometry, width: 900, height: 420, bandRight: 880, bandBottom: 400,
    nodes: r.geometry.nodes.filter(n => boxes[n.id]).map(n => {
      const [x, y, w, h] = boxes[n.id]!; return positioned(n, x!, y!, w!, h!);
    }),
    edges: r.geometry.edges.filter(e => e.to === 'check').map(e => ({ ...e, points: paths[e.from]!, hops: undefined })),
    lanes: r.geometry.lanes.map(l => ({ ...l, x: l.id === 'source' ? 0 : 600, y: 0, w: l.id === 'source' ? 600 : 300, h: 420 })),
  };
  return { normalized: r.normalized, geometry };
}

describe('external text and connected route geometry', () => {
  it.each(['seq', 'assoc', 'msg'] as const)('inspects unlabeled %s routes, including their own document text', kind => {
    const { geometry } = mixed();
    const doc = geometry.nodes.find(n => n.id === 'd1')!;
    const label = externalNodeLabel(doc)!.box;
    const edge = { ...geometry.edges[1]!, kind, from: doc.id, label: undefined,
      points: [{ x: label.x + 2, y: doc.y + doc.h }, { x: label.x + 2, y: label.y + label.h + 20 }] };
    const g = { ...geometry, edges: [edge] };
    expect(inspectNodeLabelRoutes(g)).toEqual([expect.objectContaining({ edgeId: edge.id, nodeId: doc.id, segment: 0 })]);
    expect(checkNodeLabelRoutes(g)[0]?.message).toContain(doc.id);
    expect(checkNodeLabelRoutes(g)[0]?.message).toContain('x=');
  });

  it('repairs an own-document label crossing without moving the text or node', () => {
    const { geometry } = mixed();
    const doc = geometry.nodes.find(n => n.id === 'd1')!;
    const e = geometry.edges.find(e => e.from === 'd1')!;
    const x = doc.cx + 10;
    const g = { ...geometry, edges: [{ ...e, points: [{ x, y: doc.y + doc.h }, { x, y: 240 }, { x: 650, y: 240 }] }] };
    expect(inspectNodeLabelRoutes(g)).toHaveLength(1);
    const repaired = improveDataAssociations(g);
    expect(inspectNodeLabelRoutes(repaired)).toEqual([]);
    expect(repaired.nodes).toEqual(g.nodes);
  });

  it.each([false, true])('generates a joint mixed input candidate with a changed sequence face (reverse=%s)', reversed => {
    const { geometry, normalized } = mixed();
    if (reversed) { geometry.edges.reverse(); geometry.nodes.reverse(); }
    const original = structuredClone(geometry);
    expect(rawHits(geometry.edges)).toHaveLength(3);
    const candidates = [...connectedRouteCandidates(geometry)];
    const safe = candidates.find(g => rawHits(g.edges).length === 0 && inspectNodeLabelRoutes(g).length === 0 &&
      checkOracle(normalized, g).length === 0 && g.edges.find(e => e.kind === 'seq')!.points.at(-1)!.x === 650 &&
      g.edges.every((e, i) => g.edges.slice(i + 1).every(other => sharedPair(e, other) === 0)));
    expect(safe).toBeDefined();
    expect(geometry).toEqual(original);
    expect(safe!.nodes).toEqual(geometry.nodes);
    for (const e of safe!.edges) {
      const prior = geometry.edges.find(p => p.id === e.id)!;
      for (const key of ['id', 'from', 'to', 'kind', 'isReturn', 'isConditional', 'mainHint', 'provisional'] as const) expect(e[key]).toEqual(prior[key]);
    }
  });

  it('generates distinct gateway exits instead of extending a shared T stem', () => {
    const r = compile('orientation vertical\nlane work\nand fork\ntask a[分岐A]\ntask b[分岐B]\nfork -> a\nfork -> b', { optimizePlacement: false });
    const geometry: Geometry = { ...r.geometry, width: 900, height: 500,
      lanes: r.geometry.lanes.map(l => ({ ...l, x: 0, y: 0, w: 900, h: 500 })),
      nodes: r.geometry.nodes.filter(n => ['fork', 'a', 'b'].includes(n.id)).map(n =>
        n.id === 'fork' ? positioned(n, 450, 100, 44, 44) : positioned(n, n.id === 'a' ? 200 : 60, 260, 100, 56)),
      edges: r.geometry.edges.filter(e => e.from === 'fork').map(e => ({ ...e, hops: undefined,
        points: [{ x: 472, y: 144 }, { x: 472, y: 200 }, { x: e.to === 'a' ? 250 : 110, y: 200 }, { x: e.to === 'a' ? 250 : 110, y: 260 }] })),
    };
    expect(sharedPair(geometry.edges[0]!, geometry.edges[1]!)).toBeGreaterThan(0);
    const safe = [...connectedRouteCandidates(geometry)].find(g =>
      sharedPair(g.edges[0]!, g.edges[1]!) === 0 && checkOracle(r.normalized, g).length === 0 &&
      inspectNodeLabelRoutes(g).length === 0 && rawHits(g.edges).length === 0);
    expect(safe).toBeDefined();
    expect(safe!.edges[0]!.points[0]).not.toEqual(safe!.edges[1]!.points[0]);
  });

  it('retains separate external boxes for shifted event labels and multiline document labels', () => {
    const { geometry } = mixed();
    const node = geometry.nodes.find(n => n.id === 'd1')!;
    expect(externalNodeLabel({ ...node, labelLines: ['長い日本語の文書名', '続きの行'] })!.box.h).toBe(32);
    const event = { ...node, kind: 'mid' as const, labelSide: 'left' as const, labelShift: 18 };
    expect(externalNodeLabel(event)!.box.y).toBe(event.cy + 18 - event.labelLines.length * 8);
  });

  it('counts geometric crossings even when the hop renderer suppresses a near-endpoint arc', () => {
    const { geometry } = mixed();
    const edges: Geometry['edges'] = [
      { ...geometry.edges[0]!, onSpine: false, points: [{ x: 0, y: 5 }, { x: 100, y: 5 }], hops: undefined },
      { ...geometry.edges[1]!, onSpine: false, points: [{ x: 5, y: 0 }, { x: 5, y: 40 }], hops: undefined },
    ];
    computeHops(edges);
    expect(rawHits(edges)).toHaveLength(1);
    expect(edges.reduce((sum, e) => sum + (e.hops?.length ?? 0), 0)).toBe(0);
  });
});
