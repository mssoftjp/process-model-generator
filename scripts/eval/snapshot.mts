// Compile every .flow file of a corpus and write one SVG per figure plus metrics.json.
//
//   npx tsx scripts/eval/snapshot.mts <outDir> <corpus.txt | dir> [--vertical] [--src <srcRoot>]
//
// corpus.txt lists .flow paths one per line; a directory is scanned for *.flow.
// --vertical prepends `orientation vertical` (replacing any orientation line).
// --src points at a checkout of src/ from another commit, so the same corpus can be
// snapshotted at several points in history and compared with compare.mts / timeline.mts.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; return args.splice(i, 2)[1]; };
const vertical = args.includes('--vertical');
if (vertical) args.splice(args.indexOf('--vertical'), 1);
const srcRoot = resolve(flag('--src') ?? join(fileURLToPath(import.meta.url), '../../../src'));
const [outDir, corpus] = args;
if (!outDir || !corpus) {
  console.error('usage: snapshot.mts <outDir> <corpus.txt | dir> [--vertical] [--src <srcRoot>]');
  process.exit(2);
}
const files = statSync(corpus).isDirectory()
  ? readdirSync(corpus).filter((f) => f.endsWith('.flow')).sort().map((f) => join(corpus, f))
  : readFileSync(corpus, 'utf8').split('\n').filter(Boolean);

const { compile } = await import(join(srcRoot, 'compile.ts'));
const { recoverSelectedRoute, diagnoseCrossingCauses } = await import(join(srcRoot, 'crossing-causes.ts'));
mkdirSync(outDir, { recursive: true });

const rows: Record<string, unknown>[] = [];
const total = { edges: 0, bends: 0, hops: 0, oracle: 0, length: 0, area: 0, uturn: 0, excess: 0, patterns: {} as Record<string, number> };
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  if (vertical) src = 'orientation vertical\n' + src.split('\n').filter((l) => !/^\s*orientation\b/.test(l)).join('\n');
  const name = basename(f, '.flow');
  let r;
  try { r = compile(src); } catch (e) { rows.push({ name, error: String(e).slice(0, 200) }); continue; }
  writeFileSync(join(outDir, `${name}.svg`), r.svg);
  const plan = recoverSelectedRoute(r);
  const planById = new Map(plan.plans.map((p: { edgeId: string }) => [p.edgeId, p]));
  const rep = diagnoseCrossingCauses(r.geometry, plan);
  const patterns: Record<string, number> = {};
  for (const e of r.geometry.edges) {
    const pat = planById.get(e.id)?.pattern ?? '?';
    patterns[pat] = (patterns[pat] ?? 0) + 1;
  }
  const oracle = r.diagnostics.filter((d: { code: string }) => d.code.startsWith('O-')).length;
  const row = { name, edges: r.geometry.edges.length, bends: rep.bends, hops: rep.hops, oracle, uturn: rep.detourEdges, excess: rep.excessBends, length: rep.length, area: rep.area, patterns };
  rows.push(row);
  total.edges += row.edges; total.bends += row.bends; total.hops += row.hops; total.oracle += oracle;
  total.length += row.length; total.area += row.area; total.uturn += row.uturn; total.excess += row.excess;
  for (const [k, v] of Object.entries(patterns)) total.patterns[k] = (total.patterns[k] ?? 0) + v;
}
writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ vertical, srcRoot, total, rows }, null, 2));
console.log(JSON.stringify(total));
