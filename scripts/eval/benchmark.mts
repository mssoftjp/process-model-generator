// Source-pinned semantic/conversion contracts; geometry remains supporting evidence.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { detailSheet } from '../../src/detail-sheet.ts';
import { compile, parse } from '../../src/compile.ts';
import type { Ir } from '../../src/types.ts';

export const fixtureRoot = fileURLToPath(new URL('../../test/fixtures/benchmark/', import.meta.url));
type Case = { id: string; file: string; source: string; sha256: string; expected: string;
  nodes?: Array<Record<string, string>>; edges?: string[][]; differentPools?: string[][];
  unsupportedTags?: string[]; mutations?: Array<{old: string; new: string; reason: string}> };
export const cases: Case[] = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function semanticFailures(ir: Ir, c: Case): string[] {
  const failures: string[] = [];
  for (const expected of c.nodes ?? []) {
    const actual = ir.nodes.find(n => n.id === expected.id);
    if (!actual || Object.entries(expected).some(([k,v]) => (actual as unknown as Record<string, unknown>)[k] !== v)) failures.push(`node ${JSON.stringify(expected)}`);
  }
  for (const [kind, from, to] of c.edges ?? []) {
    const seen = new Set([from]);
    let found = false;
    for (const id of seen) for (const e of ir.edges.filter(e => e.kind === kind && e.from === id)) {
      if (e.to === to) found = true;
      if (ir.nodes.some(n => n.id === e.to && n.synthetic)) seen.add(e.to);
    }
    if (!found) failures.push(`edge ${kind}:${from}->${to}`);
  }
  const pool = (id: string) => ir.lanes.find(l => l.id === ir.nodes.find(n => n.id === id)?.lane)?.pool;
  for (const [a,b] of c.differentPools ?? []) if (!a || !b || !pool(a) || pool(a) === pool(b)) failures.push(`independent pools ${a}/${b}`);
  return failures;
}
function signature(ir: Ir): string {
  return JSON.stringify({pools: ir.pools, lanes: ir.lanes, nodes: ir.nodes.map(({declIndex, ...n}) => n),
    edges: ir.edges.map(({declIndex, ...e}) => e)});
}
type Review = { svgHash: string; verdict: 'PASS' | 'FAIL'; traceability: string; readability: string; emphasis: string };
export function runBenchmark(outDir: string, reviews: Record<string, Review> = {}) {
  mkdirSync(outDir, {recursive: true});
  const results = cases.map(c => {
    const failures: string[] = [];
    const bytes = readFileSync(join(fixtureRoot, c.file));
    if (hash(bytes) !== c.sha256) failures.push('source hash mismatch');
    let source = bytes.toString();
    let unsupported: Array<{tag: string; reason: string}> = [];
    if (c.file.endsWith('.bpmn')) {
      execFileSync('python3', [fileURLToPath(new URL('../../skills/process-model-generator/scripts/bpmn2flow.py', import.meta.url)), join(fixtureRoot,c.file), join(outDir,c.id+'.flow'), c.source, '--json-stats', join(outDir,c.id+'.conversion.json')]);
      source = readFileSync(join(outDir,c.id+'.flow'),'utf8');
      unsupported = JSON.parse(readFileSync(join(outDir,c.id+'.conversion.json'),'utf8')).unsupported;
    } else writeFileSync(join(outDir,c.id+'.flow'),source);
    let detailDirectory: string | undefined;
    if (unsupported.length) {
      detailDirectory=join(outDir,c.id+'-detail');
      execFileSync('python3',[fileURLToPath(new URL('../../skills/process-model-generator/scripts/bpmn-detail.py',import.meta.url)),join(fixtureRoot,c.file),detailDirectory,c.source]);
    }
    const conversion = unsupported.length ? 'partial' : 'supported';
    if (conversion !== c.expected) failures.push(`conversion ${conversion}; expected ${c.expected}`);
    for (const tag of c.unsupportedTags ?? []) if (!unsupported.some(u => u.tag === tag)) failures.push(`missing loss disclosure: ${tag}`);
    let baseline: string | undefined;
    const renders = (['horizontal','vertical'] as const).map(orientation => {
      try {
        const r = compile(source, {strict:true, orientation});
        failures.push(...semanticFailures(r.normalized,c).map(f => `${orientation}: ${f}`));
        const semantic = signature(r.normalized);
        if (baseline && semantic !== baseline) failures.push('orientation changed semantics');
        baseline = semantic;
        const sheet=detailDirectory ? detailSheet(detailDirectory,orientation) : {svg:r.svg, width:r.geometry.width,height:r.geometry.height,diagnostics:r.diagnostics};
        writeFileSync(join(outDir,`${c.id}-${orientation}.svg`),sheet.svg);
        const review = reviews[`${c.id}-${orientation}`];
        const current = review?.svgHash === hash(sheet.svg) && ['PASS','FAIL'].includes(review.verdict) && [review.traceability, review.readability, review.emphasis].every(v => typeof v === 'string' && v.trim());
        return {orientation, svgHash:hash(sheet.svg), width:sheet.width, height:sheet.height,
          diagnostics:sheet.diagnostics, visual:current ? review.verdict : 'PENDING', review:current ? review : undefined, questions:[
            'Can a reader follow each condition and return without guessing at crossings?',
            'Are task labels, responsibility and document ownership legible at the target viewport?',
            'Do size, emphasis and symmetry suggest meaning absent from the source?']};
      } catch(e) { failures.push(`${orientation}: ${String(e)}`); return {orientation, visual:'BLOCKED'}; }
    });
    const mutations = (c.mutations ?? []).map(m => {
      if (!source.includes(m.old)) { failures.push(`mutation did not apply: ${m.reason}`); return {reason:m.reason,detected:false}; }
      const mutated = parse(source.replace(m.old,m.new));
      const violations = semanticFailures(mutated.ir,c);
      const detected = violations.length > 0;
      if (!detected) failures.push(`missed mutation: ${m.reason}`);
      return {reason:m.reason,detected,violations};
    });
    return {id:c.id,completeSheet:!failures.length && (!unsupported.length || !!detailDirectory),source:c.source,inputHash:hash(bytes),conversion,unsupported,contract:failures.length?'FAIL':'PASS',failures,mutations,renders};
  });
  const visual = results.some(r => r.renders.some(v => v.visual === 'FAIL')) ? 'FAIL' : results.every(r => r.renders.every(v => v.visual === 'PASS')) ? 'PASS' : 'PENDING';
  const contract = results.some(r=>r.contract==='FAIL')?'FAIL':'PASS';
  const result = {contract, visual, readiness: contract === 'FAIL' || visual === 'FAIL' ? 'FAIL' : visual === 'PENDING' ? 'PENDING_VISUAL_REVIEW' : results.some(r=>!r.completeSheet) ? 'PARTIAL_CONVERSION' : 'PASS', results};
  writeFileSync(join(outDir,'results.json'),JSON.stringify(result,null,2)+'\n');
  writeFileSync(join(outDir,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BPMN benchmark</title><style>body{font:16px/1.6 system-ui;margin:32px;color:#243044}section{border-top:1px solid #ccc;margin-top:32px}figure{overflow:auto;margin:12px 0}img{max-width:none}pre{white-space:pre-wrap}.partial{color:#975b00}</style><h1>BPMN benchmark</h1><p>Contract: ${result.contract}. Visual: ${result.visual}. Readiness: ${result.readiness}. Original nested scopes and extension data are included in one detailed sheet. Single-scope conversion remains partial where indicated. Blue dashed lines denote messages; read large diagrams at native size using scrolling or zoom.</p>${results.map(r=>`<section><h2>${escape(r.id)} — ${r.contract}</h2><a href="${escape(r.source)}">Source</a><p class="${r.conversion}">Single-scope conversion: ${r.conversion}; complete detailed sheet: ${r.completeSheet}</p><pre>${escape(JSON.stringify({failures:r.failures,unsupported:r.unsupported,mutations:r.mutations},null,2))}</pre>${r.renders.map(v=>`<h3>${v.orientation} — ${v.visual}</h3><pre>${escape(JSON.stringify('review' in v ? v.review : {},null,2) ?? '')}</pre>${'svgHash' in v?`<a href="${r.id}-${v.orientation}.svg">Open SVG</a><figure><img src="${r.id}-${v.orientation}.svg" alt="${r.id} ${v.orientation}"></figure>`:''}`).join('')}</section>`).join('')}`);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const reviewFlag = args.indexOf('--reviews');
  const reviews = reviewFlag < 0 ? {} : JSON.parse(readFileSync(args.splice(reviewFlag,2)[1]!, 'utf8'));
  const requireReady = args.includes('--require-ready');
  const result = runBenchmark(resolve(args.find(a=>!a.startsWith('--')) ?? 'outputs/benchmark'), reviews);
  console.log(JSON.stringify({contract:result.contract,readiness:result.readiness,cases:result.results.map(r=>({id:r.id,contract:r.contract,conversion:r.conversion,failures:r.failures}))},null,2));
  process.exitCode = result.contract !== 'PASS' ? 1 : requireReady && result.readiness !== 'PASS' ? 2 : 0;
}
