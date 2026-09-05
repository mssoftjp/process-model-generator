import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const BUNDLE = join(ROOT, 'skills', 'process-model-generator', 'scripts', 'process-model-generator.mjs');

describe('bundled CLI distribution', () => {
  it('reports the canonical release version', () => {
    const expected = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
    expect(execFileSync(process.execPath, [BUNDLE, '--version'], { encoding: 'utf8' }).trim()).toBe(expected);
  });

  it('compiles without npm dependencies in the working directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-dist-'));
    const input = join(dir, 'input.flow');
    const output = join(dir, 'out', 'input.svg');
    const bundle = join(dir, 'process-model-generator.mjs');
    const source = `flow sample[Sample]
pool p[Company]
lane p:l[Owner]
start s[Request received]
task t[Review request]
end e[Review completed]
s -> t
t -> e
`;

    try {
      copyFileSync(BUNDLE, bundle);
      writeFileSync(input, source, 'utf8');
      execFileSync(process.execPath, [bundle, input, '-o', output], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
      expect(readFileSync(output, 'utf8')).toBe(compile(source, { version }).svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an unknown task subtype inside one inert SVG attribute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-dist-subtype-'));
    const input = join(dir, 'input.flow');
    const output = join(dir, 'input.svg');
    const source = `lane L
task(foo"><script>alert</script><rect data-pwn="yes) A[x]`;
    const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

    try {
      writeFileSync(input, source, 'utf8');
      execFileSync(process.execPath, [BUNDLE, input, '-o', output], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const svg = compile(source, { version }).svg;
      expect(svg).toContain('data-task-type="foo&quot;&gt;&lt;script&gt;alert&lt;/script&gt;&lt;rect datapwn=&quot;yes"');
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<rect datapwn=');
      expect(readFileSync(output, 'utf8')).toBe(svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes one complete detailed SVG under --strict with a fit-to-screen warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-strict-budget-'));
    const input = join(dir, 'wide.flow');
    const output = join(dir, 'wide.svg');
    const lines = ['flow wide[Wide process]'];
    for (let i = 0; i < 32; i++) {
      lines.push(`lane l${i}[Owner ${i}]`);
      lines.push(`  ${i === 0 ? 'start' : i === 31 ? 'end' : 'task'} n${i}[Step ${i}]`);
    }
    for (let i = 0; i < 31; i++) lines.push(`n${i} -> n${i + 1}`);

    try {
      writeFileSync(input, lines.join('\n'), 'utf8');
      const result = spawnSync(process.execPath, [BUNDLE, input, '-o', output, '--strict'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('W-441');
      expect(existsSync(output)).toBe(true);
      expect(readFileSync(output,'utf8')).toContain('Step 31');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the bundled delivery evaluation gate without npm dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-dist-eval-'));
    const input = join(dir, 'sample.flow');
    const output = join(dir, 'sample.svg');
    const report = join(dir, 'review.md');
    const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
    const source = `flow sample[Sample]
pool company[Company]
lane owner[Owner]
start s[Started]
task t[Work]
end e[Completed]
s -> t
t -> e`;
    try {
      writeFileSync(input, source, 'utf8');
      writeFileSync(output, compile(source, { strict: true, version }).svg, 'utf8');
      const hash = createHash('sha256').update(readFileSync(output)).digest('hex');
      writeFileSync(report, [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | sample:* | modeled | entry=s; exits=e |',
        '| Work follows start | fact | test:fixture | sample:t | modeled | Synthetic example |',
        `| delivery-review | view | test:fixture | sample:* | modeled | semantic=pass; visual=pass; svg-sha256=${hash} |`,
        '',
      ].join('\n'), 'utf8');
      const result = spawnSync(process.execPath, [BUNDLE, 'eval', '--dir', dir, '--report', report, '--consulting'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('evaluated 1 views: 0 errors');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('visualizes model control characters only on a TTY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-dist-tty-'));
    const input = join(dir, 'input.flow');
    const output = join(dir, `out\x1b.svg`);
    const wrapper = join(dir, 'tty.mjs');
    const source = `flow sample[Sample]
lane owner[Owner]
start s[Started\x1b\x07]
end e[Completed]
s -> e`;

    try {
      writeFileSync(input, source, 'utf8');
      writeFileSync(wrapper, [
        "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
        "Object.defineProperty(process.stderr, 'isTTY', { value: true });",
        `await import(${JSON.stringify(pathToFileURL(BUNDLE).href)});`,
      ].join('\n'), 'utf8');

      const redirected = spawnSync(process.execPath, [BUNDLE, input], { encoding: 'utf8' });
      expect(redirected.status).toBe(0);
      expect(redirected.stdout).toBe(`${compile(source, { version: readFileSync(join(ROOT, 'VERSION'), 'utf8').trim() }).svg}\n`);
      expect(redirected.stdout).toContain('\x1b');

      const terminal = spawnSync(process.execPath, [wrapper, input, '--emit-normalized', '-o', output], { encoding: 'utf8' });
      expect(terminal.status).toBe(0);
      expect(terminal.stdout).not.toContain('\x1b');
      expect(terminal.stdout).not.toContain('\x07');
      expect(terminal.stderr).not.toContain('\x1b');
      expect(terminal.stdout).toContain('Started\\x1b\\x07');
      expect(terminal.stderr).toContain('out\\x1b.svg');
      expect(readFileSync(output, 'utf8')).toBe(compile(source, {
        version: readFileSync(join(ROOT, 'VERSION'), 'utf8').trim(),
      }).svg);

      const missing = spawnSync(process.execPath, [wrapper, `${input}\x1b-missing`], { encoding: 'utf8' });
      expect(missing.status).toBe(1);
      expect(missing.stderr).not.toContain('\x1b');
      expect(missing.stderr).toContain('input.flow\\x1b-missing');

      const blockedParent = join(dir, `blocked\x1b`);
      writeFileSync(blockedParent, '', 'utf8');
      const failedWrite = spawnSync(process.execPath, [wrapper, input, '-o', join(blockedParent, 'out.svg')], {
        encoding: 'utf8',
      });
      expect(failedWrite.status).toBe(1);
      expect(failedWrite.stderr).not.toContain('\x1b');
      expect(failedWrite.stderr).toContain('blocked\\x1b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('visualizes review ledger control characters only on a TTY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-tty-'));
    const input = join(dir, 'sample.flow');
    const output = join(dir, 'sample.svg');
    const report = join(dir, 'review.md');
    const wrapper = join(dir, 'tty.mjs');
    const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
    const source = `flow sample[Sample]
lane owner[Owner]
start s[Started]
end e[Completed]
s -> e`;

    try {
      writeFileSync(input, source, 'utf8');
      writeFileSync(output, compile(source, { strict: true, version }).svg, 'utf8');
      writeFileSync(report, [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| injected | fact | interview:1 | missing\x1b:* | modeled | test |',
        '',
      ].join('\n'), 'utf8');
      writeFileSync(wrapper, [
        "Object.defineProperty(process.stderr, 'isTTY', { value: true });",
        `await import(${JSON.stringify(pathToFileURL(BUNDLE).href)});`,
      ].join('\n'), 'utf8');

      const args = ['eval', '--dir', dir, '--report', report, '--consulting'];
      const redirected = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8' });
      expect(redirected.status).toBe(1);
      expect(redirected.stderr).toContain('missing\x1b:*');

      const terminal = spawnSync(process.execPath, [wrapper, ...args], { encoding: 'utf8' });
      expect(terminal.status).toBe(1);
      expect(terminal.stderr).not.toContain('\x1b');
      expect(terminal.stderr).toContain('missing\\x1b:*');

      const missingDirectory = spawnSync(process.execPath, [wrapper, 'eval', '--dir', `${dir}\x1b-missing`, '--report', report], {
        encoding: 'utf8',
      });
      expect(missingDirectory.status).toBe(1);
      expect(missingDirectory.stderr).not.toContain('\x1b');
      expect(missingDirectory.stderr).toContain('\\x1b-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
