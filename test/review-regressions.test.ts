import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
import { compile, parse } from '../src/compile.ts';
import { checkOracle } from '../src/oracle.ts';
import { evaluateDelivery } from '../src/eval.ts';
import { placeEdgeLabels } from '../src/edge-labels.ts';
import { inspectNodeLabelRoutes } from '../src/node-labels.ts';
import { rawHits } from '../src/route-intersections.ts';
import { sharedPair } from '../src/oarsp.ts';

const source = readFileSync(new URL('./fixtures/review-expense/expense-settlement.flow', import.meta.url), 'utf8');
const ledger = readFileSync(new URL('./fixtures/review-expense/review.md', import.meta.url), 'utf8');

describe('external expense review regressions', () => {
  let delivered: ReturnType<typeof compile>;
  beforeAll(() => { delivered = compile(source, { strict: true, version: 'test' }); }, 15000);
  it.each(['vertical', 'horizontal'])('reduces the fixed fixture without changing business edges (%s)', orientation => {
    const r = compile(source.replace('orientation vertical', `orientation ${orientation}`), { strict: true, optimizePlacement: false });
    // Text avoidance and distinct split ports may require more bends than the old unsafe 45-bend route.
    expect(r.geometry.edges.reduce((n, e) => n + Math.max(0, e.points.length - 2), 0)).toBeLessThanOrEqual(48);
    expect(r.geometry.edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0)).toBeLessThanOrEqual(6);
    if (orientation === 'vertical') expect([r.geometry.width, r.geometry.height]).toEqual([2140, 2528]);
    expect(checkOracle(r.normalized, r.geometry)).toEqual([]);
    expect(inspectNodeLabelRoutes(r.geometry)).toEqual([]);
    const inputs = r.geometry.edges.filter(e => e.to === 'review_supervisor');
    expect(rawHits(inputs)).toEqual([]);
    const outputs = r.geometry.edges.filter(e => e.from === 'parallel_processing');
    expect(sharedPair(outputs[0]!, outputs[1]!)).toBe(0);
    const labels = placeEdgeLabels(r.geometry);
    expect(labels.nodeHits + labels.edgeHits + labels.labelHits).toBe(0);
    for (const edge of r.normalized.edges) {
      const drawn = r.geometry.edges.find(e => e.id === edge.id)!;
      for (const key of ['from', 'to', 'kind', 'provisional', 'isReturn', 'mainHint', 'returnHint', 'isConditional'] as const) expect(drawn[key]).toEqual(edge[key]);
    }
    expect(r.diagnostics.find(d => d.code === 'N-222')?.message).toContain('same-lane');
  });

  it('re-evaluates placement without hiding global intersections or changing responsibility', () => {
    const r = delivered;
    expect(rawHits(r.geometry.edges).length).toBeLessThanOrEqual(1);
    expect(inspectNodeLabelRoutes(r.geometry)).toEqual([]);
    expect(checkOracle(r.normalized, r.geometry)).toEqual([]);
    expect(r.geometry.width * r.geometry.height).toBeLessThanOrEqual(2140 * 2528 * 1.15);
    for (const n of r.geometry.nodes) expect(n.lane).toBe(r.normalized.nodes.find(g => g.id === n.id)!.lane);
    const hits = rawHits(r.geometry.edges);
    expect(hits.some(h => h.a.includes('notify_supervisor_return') || h.b.includes('notify_supervisor_return'))).toBe(false);
  });

  it.each(['unresolved', 'confirmed', 'outside'])('checks ledger backwards: %s', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'review-regression-'));
    try {
      const r = delivered;
      writeFileSync(join(dir, 'expense.flow'), source);
      writeFileSync(join(dir, 'expense.svg'), r.svg);
      let report = ledger.replace(/svg-sha256=[a-f0-9]+/u, `svg-sha256=${createHash('sha256').update(r.svg).digest('hex')}`);
      if (mode === 'confirmed') report = report.replace('| unknown-topology |', '| fact |').replace('| unresolved |', '| modeled |');
      if (mode === 'outside') report = report.replace(/^.*入金確認と原本保管の双方で完了とする.*$/mu, '| 翌年度の税務申告手順 | unknown-topology | test:outside-scope | expense_settlement:* | unresolved | asked=no-channel; scope=outside; 税務申告はこの精算手続の開始終了条件に含まない |');
      writeFileSync(join(dir, 'review.md'), report);
      const result = evaluateDelivery({ directory: dir, reportPath: join(dir, 'review.md'), consulting: true, parentId: 'expense_settlement', version: 'test' });
      if (mode === 'unresolved') expect(result.findings.some(d => d.code === 'E-520')).toBe(true);
      else expect(result.findings).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15000);

  it('keeps display names, explicit conditions and return hints independent', () => {
    const named = parse(source).ir.edges.find(e => e.from === 'revise_application')!;
    expect(named.label).toBe('再申請');
    expect(named.isConditional).not.toBe(true);
    expect(named.returnHint).toBe(true);
    const conditional = parse(source.replace(': 再申請', ': [if 修正完了] 再申請')).ir.edges.find(e => e.from === 'revise_application')!;
    expect(conditional.label).toBe('再申請');
    expect(conditional.condition).toBe('修正完了');
    expect(conditional.isConditional).toBe(true);
    expect(conditional.returnHint).toBe(true);
    const quoted = parse('lane a\ntask t\ntask u\nt -> u: [if "items[0] > 0"] Send').ir.edges[0]!;
    expect(quoted.condition).toBe('items[0] > 0');
    expect(quoted.label).toBe('Send');
  });
});
