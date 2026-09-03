// Compare two snapshot directories figure by figure (bends, hops, detours, excess bends, oracle, area).
//
//   npx tsx scripts/eval/compare.mts <before/metrics.json> <after/metrics.json> [--changed]
//
// --changed prints only figures whose numbers differ. A trailing "<-- worse" marks a figure
// where bends, hops or oracle violations increased.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const onlyChanged = args.includes('--changed');
const [aFile, bFile] = args.filter((a) => !a.startsWith('--'));
if (!aFile || !bFile) {
  console.error('usage: compare.mts <before/metrics.json> <after/metrics.json> [--changed]');
  process.exit(2);
}
type Row = { name: string; error?: string; bends: number; hops: number; uturn: number; excess: number; oracle: number; area: number; length: number };
const a = JSON.parse(readFileSync(aFile, 'utf8')) as { rows: Row[] };
const b = JSON.parse(readFileSync(bFile, 'utf8')) as { rows: Row[] };
const byName = new Map(b.rows.map((r) => [r.name, r]));
const keys = ['bends', 'hops', 'uturn', 'excess', 'oracle'] as const;
console.log('name                          bends      hops     uturn   excess   oracle   area%');
const sum = { a: { bends: 0, hops: 0, uturn: 0, excess: 0, oracle: 0, length: 0, area: 0 }, b: { bends: 0, hops: 0, uturn: 0, excess: 0, oracle: 0, length: 0, area: 0 } };
for (const ra of a.rows) {
  const rb = byName.get(ra.name);
  if (!rb || ra.error || rb.error) { console.log(`${ra.name} ${ra.error ?? rb?.error ?? 'missing'}`); continue; }
  for (const k of [...keys, 'length', 'area'] as const) { sum.a[k] += ra[k]; sum.b[k] += rb[k]; }
  const same = keys.every((k) => ra[k] === rb[k]) && ra.area === rb.area;
  if (onlyChanged && same) continue;
  const d = (k: (typeof keys)[number]) => `${String(ra[k]).padStart(3)}->${String(rb[k]).padEnd(3)}`;
  const flag = rb.bends > ra.bends || rb.hops > ra.hops || rb.oracle > ra.oracle ? ' <-- worse' : '';
  console.log(`${ra.name.padEnd(28)} ${d('bends')} ${d('hops')} ${d('uturn')} ${d('excess')} ${d('oracle')} ${(100 * rb.area / ra.area - 100).toFixed(1).padStart(6)}${flag}`);
}
const line = (t: typeof sum.a) => `bends=${t.bends} hops=${t.hops} uturn=${t.uturn} excess=${t.excess} oracle=${t.oracle} length=${Math.round(t.length)} area=${t.area}`;
console.log(`A: ${line(sum.a)}`);
console.log(`B: ${line(sum.b)}`);
