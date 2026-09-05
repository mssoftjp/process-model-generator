import { describe, expect, it } from 'vitest';
import { compile, CompileError } from '../src/compile.ts';
import { diagnosePageBudget } from '../src/page-budget.ts';
import type { Geometry, Orientation } from '../src/types.ts';

function emptyGeometry(orientation: Orientation, width: number, height: number): Geometry {
  return {
    orientation,
    width,
    height,
    headerW: 0,
    bandRight: width,
    bandBottom: height,
    pools: [],
    lanes: [],
    nodes: [],
    edges: [],
  };
}

function linearFlow(count: number, orientation: Orientation = 'horizontal'): string {
  const lines = [
    'flow long[Long process]',
    ...(orientation === 'vertical' ? ['orientation vertical'] : []),
    'lane work[Work]',
    '  start n0[Started]',
  ];
  for (let i = 1; i <= count; i++) lines.push(`  task n${i}[Complete step ${i}]`);
  lines.push(`  end n${count + 1}[Completed]`);
  for (let i = 0; i <= count; i++) lines.push(`n${i} -> n${i + 1}`);
  return lines.join('\n');
}

function manyLaneProcess(count: number): string {
  const lines = ['flow wide[Wide process]'];
  for (let i = 0; i < count; i++) {
    lines.push(`lane l${i}[Owner ${i}]`);
    lines.push(`  ${i === 0 ? 'start' : i === count - 1 ? 'end' : 'task'} n${i}[Step ${i}]`);
  }
  for (let i = 0; i + 1 < count; i++) lines.push(`n${i} -> n${i + 1}`);
  return lines.join('\n');
}

describe('page-budget diagnostics', () => {
  it('maps lane and time axes to the actual orientation', () => {
    const horizontal = diagnosePageBudget(emptyGeometry('horizontal', 3200, 900));
    expect(horizontal.metrics.laneFont).toBe(14);
    expect(horizontal.metrics.timeScreens).toBe(2);
    expect(horizontal.diagnostics.map((d) => d.code)).toEqual(['N-440']);

    const vertical = diagnosePageBudget(emptyGeometry('vertical', 1600, 1800));
    expect(vertical.metrics.laneFont).toBe(14);
    expect(vertical.metrics.timeScreens).toBe(2);
    expect(vertical.diagnostics.map((d) => d.code)).toEqual(['N-440']);
  });

  it('warns only after the soft boundary is exceeded', () => {
    const result = diagnosePageBudget(emptyGeometry('horizontal', 3201, 900));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['N-440', 'W-440']);
    expect(result.diagnostics[1]!.message).toContain('3201x900');
  });

  it('uses a strict hard boundary for physical lane-axis readability', () => {
    const boundary = diagnosePageBudget(emptyGeometry('horizontal', 1600, 2100), true);
    expect(boundary.metrics.laneFont).toBeCloseTo(6);
    expect(boundary.diagnostics.map((d) => d.code)).toEqual(['N-440', 'W-440']);

    const lax = diagnosePageBudget(emptyGeometry('horizontal', 1600, 2101));
    expect(lax.diagnostics.map((d) => d.code)).toEqual(['N-440', 'W-440', 'W-441']);
    const strict = diagnosePageBudget(emptyGeometry('horizontal', 1600, 2101), true);
    expect(strict.diagnostics.map((d) => d.code)).toEqual(['N-440', 'W-440', 'W-441']);
    expect(strict.diagnostics[2]!.level).toBe('warning');
  });

  it('keeps ordinary diagrams silent and long diagrams renderable with W-440', () => {
    expect(compile(linearFlow(3)).diagnostics.filter((d) => d.code.startsWith('W-44'))).toEqual([]);

    const source = linearFlow(40);
    const lax = compile(source);
    expect(lax.diagnostics.map((d) => d.code)).toContain('W-440');
    expect(lax.diagnostics.map((d) => d.code)).not.toContain('W-441');
    expect(() => compile(source, { strict: true })).not.toThrow();
  });

  it('retains a complete single SVG even when fit-to-screen is unreadable', () => {
    const source = manyLaneProcess(32);
    const lax = compile(source);
    expect(lax.diagnostics.map((d) => d.code)).toContain('W-441');
    expect(lax.svg).toContain('<svg');

    expect(() => compile(source, { strict: true })).not.toThrow();
  });
});
