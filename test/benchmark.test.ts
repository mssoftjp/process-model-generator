import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { runBenchmark, fixtureRoot } from '../scripts/eval/benchmark.mts';
import { detailSheet } from '../src/detail-sheet.ts';
import { compile } from '../src/compile.ts';

it('checks pinned external examples, disclosed loss, both orientations and semantic mutations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpmn-benchmark-'));
  try {
    const result = runBenchmark(dir);
    expect(result.results.flatMap(r => r.failures)).toEqual([]);
    expect(result.results.filter(r => r.conversion === 'partial').map(r => r.id)).toEqual(['extensions', 'nested']);
    expect(result.results.flatMap(r => r.mutations).every(m => m.detected)).toBe(true);
    expect(result.readiness).toBe('PENDING_VISUAL_REVIEW');
    expect(result.results).toHaveLength(7);
    expect(result.results.every(r=>r.completeSheet)).toBe(true);
    const nested = JSON.parse(readFileSync(join(dir,'nested-detail/detail.json'),'utf8'));
    expect(nested.views).toHaveLength(7);
    expect(nested.missing).toEqual([]);
    const extension = readFileSync(join(dir,'extensions-horizontal.svg'),'utf8');
    expect(extension).toContain('suitable = 0.7');
    expect(extension).toContain('author: Klaus');
    const child=join(dir,'nested-detail/scope-1.flow');
    const original=readFileSync(child,'utf8');
    writeFileSync(child,original.replace('n0 -> n1','n0 -> n2'));
    expect(()=>detailSheet(join(dir,'nested-detail'),'horizontal')).toThrow('Scope connection missing');
    writeFileSync(child,original);
    expect(result.results.flatMap(r => r.mutations)).toHaveLength(3);
    const reviews = JSON.parse(readFileSync(join(fixtureRoot,'visual-review.json'),'utf8'));
    reviews['monthly-horizontal'].svgHash = result.results[0]!.renders[0]!.svgHash;
    reviews['monthly-horizontal'].verdict = 'FAIL';
    expect(runBenchmark(dir,reviews).readiness).toBe('FAIL');
    for (const review of Object.values(reviews) as Array<{svgHash:string}>) review.svgHash = 'stale';
    expect(runBenchmark(dir,reviews).readiness).toBe('PENDING_VISUAL_REVIEW');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

it('only allows a no-exit sibling loop when a parallel path can terminate its pool', () => {
  const source = `lane L\nstart s\nand fork\ntask work\nend(terminate) done\nmid(message) loop\ntask reply\ns -> fork\nfork -> work\nwork -> done\nfork -> loop\nloop -> reply\nreply -> loop`;
  expect(() => compile(source,{strict:true})).not.toThrow();
  expect(() => compile(source.replace('and fork','xor fork'),{strict:true})).toThrow('E-227');
  expect(() => compile(source.replace('end(terminate)','end'),{strict:true})).toThrow('E-227');
  expect(() => compile(source+'\ntask island\nisland -> island',{strict:true})).toThrow('E-226');
});
