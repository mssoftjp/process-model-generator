import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';
import { BRANCH_FLOW, SMOKE_FLOWS, noOracleViolations } from './helpers.ts';

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
