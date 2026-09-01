import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';
import {
  allocatedTrackDensity,
  compareDeclarationOrder,
  diagnoseCompiled,
  diagnoseCrossingCauses,
  recoverSelectedRoute,
} from '../src/crossing-causes.ts';
import { computeHops } from '../src/wire.ts';
import type { EdgeGeom, Geometry } from '../src/types.ts';

const DOC_FLOW = `lane L
task w[Write]
task r[Read]
doc d[Doc]
w -> r
w -.-> d
d -.-> r`;

const ORDER_A = `lane L
start s
xor g
task a
task b
task j
end e
s -> g
g -> a
g -> b
a -> j
b -> j
j -> e`;

const ORDER_B = `lane L
start s
xor g
task a
task b
task j
end e
s -> g
g -> b
g -> a
a -> j
b -> j
j -> e`;

function hopEdge(id: string, points: Array<{ x: number; y: number }>, onSpine = false): EdgeGeom {
  return {
    id, kind: 'seq', from: 'a', to: 'b', points, onSpine, isReturn: false, provisional: false,
  };
}

function geom(edges: EdgeGeom[]): Geometry {
  return {
    orientation: 'horizontal',
    width: 200,
    height: 80,
    headerW: 0,
    bandRight: 200,
    bandBottom: 80,
    pools: [],
    lanes: [],
    nodes: [],
    edges,
  };
}

describe('交差原因診断', () => {
  it('T 字接続は生交差に数えない', () => {
    const h = hopEdge('h', [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const v = hopEdge('v', [{ x: 50, y: 0 }, { x: 50, y: 20 }]);
    computeHops([h, v]);
    const report = diagnoseCrossingCauses(geom([h, v]));
    expect(report.rawIntersections).toBe(0);
    expect(report.hops).toBe(0);
  });

  it('内部交差はホップ抑制前に数え、診断は SVG を変えない', () => {
    const h = hopEdge('h', [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const v = hopEdge('v', [{ x: 50, y: 0 }, { x: 50, y: 28 }]);
    computeHops([h, v]);
    expect(diagnoseCrossingCauses(geom([h, v])).rawIntersections).toBe(1);
    expect(diagnoseCrossingCauses(geom([h, v])).hops).toBe(1);

    const before = compile(DOC_FLOW).svg;
    const drawn = compile(DOC_FLOW);
    const report = diagnoseCompiled(drawn);
    expect(report.channelDensity).toBe(allocatedTrackDensity(recoverSelectedRoute(drawn)));
    expect(compile(DOC_FLOW).svg).toBe(before);
    expect(report.hops).toBe(drawn.geometry.edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0));
    expect(report.rawIntersections).toBeGreaterThanOrEqual(report.hops);
    expect(report.spineCrossings).toBeLessThanOrEqual(report.rawIntersections);
    expect(report.endpointInversions).toBeLessThanOrEqual(report.rawIntersections);
    expect(report.trackOrderInversions).toBeLessThanOrEqual(report.rawIntersections);
    expect(report.residual).toBeGreaterThanOrEqual(0);
    expect(report.residual).toBeLessThanOrEqual(report.rawIntersections);
  });

  it('宣言順だけ変えた入力の交差差を原因として分離できる', () => {
    const baseline = diagnoseCrossingCauses(compile(ORDER_A).geometry);
    const variant = diagnoseCrossingCauses(compile(ORDER_B).geometry);
    const order = compareDeclarationOrder(baseline, variant);
    expect(order.baseline).toBe(baseline.rawIntersections);
    expect(order.variant).toBe(variant.rawIntersections);
    expect(order.delta).toBe(variant.rawIntersections - baseline.rawIntersections);
    expect(baseline.endpointInversions).toBeLessThanOrEqual(baseline.rawIntersections);
    expect(baseline.trackOrderInversions).toBeLessThanOrEqual(baseline.rawIntersections);
  });
});
