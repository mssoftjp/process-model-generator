import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { compile, parse } from '../src/compile.ts';
import { checkOracle } from '../src/oracle.ts';
import { evaluateDelivery } from '../src/eval.ts';
import { placeEdgeLabels } from '../src/edge-labels.ts';

const source = readFileSync(new URL('./fixtures/review-expense/expense-settlement.flow', import.meta.url), 'utf8');
const ledger = readFileSync(new URL('./fixtures/review-expense/review.md', import.meta.url), 'utf8');

describe('external expense review regressions', () => {
  it.each(['vertical', 'horizontal'])('reduces the fixed fixture without changing business edges (%s)', orientation => {
    const r = compile(source.replace('orientation vertical', `orientation ${orientation}`), { strict: true });
    expect(r.geometry.edges.reduce((n, e) => n + Math.max(0, e.points.length - 2), 0)).toBeLessThanOrEqual(45);
    expect(r.geometry.edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0)).toBeLessThanOrEqual(6);
    if (orientation === 'vertical') expect([r.geometry.width, r.geometry.height]).toEqual([2140, 2528]);
    expect(checkOracle(r.normalized, r.geometry)).toEqual([]);
    const labels = placeEdgeLabels(r.geometry);
    expect(labels.nodeHits + labels.edgeHits + labels.labelHits).toBe(0);
    for (const edge of r.normalized.edges) {
      const drawn = r.geometry.edges.find(e => e.id === edge.id)!;
      for (const key of ['from', 'to', 'kind', 'provisional', 'isReturn', 'mainHint', 'returnHint', 'isConditional'] as const) expect(drawn[key]).toEqual(edge[key]);
    }
    expect(r.diagnostics.find(d => d.code === 'N-222')?.message).toContain('same-lane');
  });

  it.each(['unresolved', 'confirmed', 'outside'])('checks ledger backwards: %s', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'review-regression-'));
    try {
      const r = compile(source, { strict: true, version: 'test' });
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
  });

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
