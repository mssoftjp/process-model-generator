import { expect, it } from 'vitest';
import { routeShape } from '../scripts/eval/visual-metrics.mts';
it('measures detours without counting redundant waypoints as bends', () => {
  expect(routeShape([{x:0,y:0},{x:0,y:10},{x:0,y:20}])).toEqual({length:20,ratio:1,excursion:0,bends:0});
  const points = [{x:0,y:0},{x:10,y:0},{x:10,y:20},{x:0,y:20}];
  expect(routeShape(points)).toEqual({length:40,ratio:2,excursion:10,bends:2});
  expect(routeShape(points.map(p => ({x:p.y,y:p.x})))).toEqual(routeShape(points));
  expect(routeShape([{x:0,y:0}]).ratio).toBeNull();
});
