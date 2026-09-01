import { build } from 'esbuild';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'skills', 'process-model-generator', 'scripts', 'process-model-generator.mjs');
const check = process.argv.includes('--check');
const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  define: { __PROCESS_MODEL_GENERATOR_VERSION__: JSON.stringify(version) },
  write: false,
  logLevel: 'silent',
});
const generated = result.outputFiles[0]?.contents;

if (!generated) throw new Error('esbuild did not produce the Process Model Generator bundle');

if (check) {
  let current;
  try {
    current = readFileSync(outfile);
  } catch {
    console.error('Bundled compiler is missing. Run `npm run build`.');
    process.exit(1);
  }

  if (!current.equals(Buffer.from(generated))) {
    console.error('Bundled compiler is stale. Run `npm run build` and include skills/process-model-generator/scripts/process-model-generator.mjs.');
    process.exit(1);
  }

  console.log('bundled compiler matches TypeScript sources');
} else {
  writeFileSync(outfile, generated);
  chmodSync(outfile, 0o755);
  console.log(`built ${outfile}`);
}
