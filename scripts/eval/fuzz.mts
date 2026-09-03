// Long fuzz run with the same generator as test/fuzz.test.ts, for development.
//
//   npx tsx scripts/eval/fuzz.mts [N] [--src <srcRoot>] [--dump <seed>] [--vertical-only | --horizontal-only]
//
// Runs N seeds (default 2000) in both orientations, prints every seed whose oracle fires
// (or that throws), and a summary line with total bends and hops so two checkouts can be
// compared: run once with --src pointing at another commit's src/.
// --dump prints the generated .flow of one seed instead of running.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genSource, mulberry32 } from '../../test/fuzz-gen.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; return args.splice(i, 2)[1]; };
const srcRoot = resolve(flag('--src') ?? join(fileURLToPath(import.meta.url), '../../../src'));
const dump = flag('--dump');
const only = args.includes('--vertical-only') ? 'vertical' : args.includes('--horizontal-only') ? 'horizontal' : undefined;
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 2000);
const seedOf = (seed: number) => mulberry32(seed * 40503 + 7);

if (dump !== undefined) {
  console.log(genSource(seedOf(Number(dump))));
  process.exit(0);
}
const { compile } = await import(join(srcRoot, 'compile.ts'));
let fails = 0, bends = 0, hops = 0;
for (const orientation of ['horizontal', 'vertical'] as const) {
  if (only && only !== orientation) continue;
  const prefix = orientation === 'vertical' ? 'orientation vertical\n' : '';
  for (let seed = 1; seed <= N; seed++) {
    const src = prefix + genSource(seedOf(seed));
    try {
      const r = compile(src);
      const viols = r.diagnostics.filter((d: { code: string }) => d.code.startsWith('O-') || d.code === 'W-252');
      for (const e of r.geometry.edges) { bends += Math.max(0, e.points.length - 2); hops += e.hops?.length ?? 0; }
      if (viols.length > 0) { fails++; console.log(`FAIL ${orientation} seed=${seed}: ${viols.map((v: { message: string }) => v.message).join(' | ')}`); }
    } catch (err) {
      fails++;
      console.log(`THROW ${orientation} seed=${seed}: ${String(err).slice(0, 200)}`);
    }
  }
}
console.log(`fuzz N=${N}${only ? '' : 'x2'} fails=${fails} bends=${bends} hops=${hops}`);
process.exit(fails > 0 ? 1 : 0);
