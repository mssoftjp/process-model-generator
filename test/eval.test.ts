import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';
import { evaluateDelivery, parseLedger } from '../src/eval.ts';

const VERSION = 'test';

function writeView(dir: string, name: string, source: string): void {
  writeFileSync(join(dir, `${name}.flow`), source, 'utf8');
  writeFileSync(join(dir, `${name}.svg`), compile(source, { strict: true, version: VERSION }).svg, 'utf8');
}

function report(rows: string[]): string {
  return [
    '| claim | kind | view:id | status | reason |',
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
    '',
  ].join('\n');
}

describe('delivery evaluation gate', () => {
  it('固定列台帳、SVG 再現、親子 task(sub) が揃えば通る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-pass-'));
    const parent = `flow overview[全体]
pool company[自社]
lane owner[担当]
start s[開始]
task(sub) detail[詳細を実行する]
end e[完了]
s -> detail
detail -> e`;
    const child = `flow detail[詳細]
pool company[自社]
lane owner[担当]
start cs[詳細開始]
task work[処理する]
end ce[詳細完了]
cs -> work
work -> ce`;
    try {
      writeView(dir, 'overview', parent);
      writeView(dir, 'detail', child);
      const reportPath = join(dir, 'review.md');
      writeFileSync(reportPath, report([
        'view-index | view | overview:* | modeled | entry=s; exits=e',
        'view-index | view | detail:* | modeled | entry=cs; exits=ce',
      ]), 'utf8');
      const result = evaluateDelivery({ directory: dir, reportPath, parentId: 'overview', version: VERSION });
      expect(result.findings.filter((finding) => finding.level === 'error')).toEqual([]);

      writeFileSync(reportPath, [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | overview:* | modeled | entry=s; exits=e |',
        '| view-index | view | generated:flow | detail:* | modeled | entry=cs; exits=ce |',
        '| view-plan | view | analysis:decomposition | detail:* | modeled | boundary=subprocess; level=2; state=asis |',
        '',
      ].join('\n'), 'utf8');
      const consulting = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true,
      });
      expect(consulting.findings.filter((finding) => finding.level === 'error')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('実際の warning を台帳が処分していなければ失敗する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-warning-'));
    const source = `flow payment[支払]
pool company[自社]
lane accounting[経理担当]
start s[開始]
task create[振込を作る]
lane result[経理担当（結果確認）]
task confirm[結果を確認する]
end e[完了]
s -> create
create -> confirm
confirm -> e`;
    try {
      writeView(dir, 'payment', source);
      const reportPath = join(dir, 'review.md');
      writeFileSync(reportPath, report([
        'view-index | view | payment:* | modeled | entry=s; exits=e',
      ]), 'utf8');
      const result = evaluateDelivery({ directory: dir, reportPath, version: VERSION });
      expect(result.findings.some((finding) => finding.code === 'E-513' && finding.message.includes('W-107'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('子 flow が親の同名 task(sub) に結ばれなければ失敗する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-child-'));
    const parent = `flow overview[全体]
pool company[自社]
lane owner[担当]
start s[開始]
task other[曖昧な詳細]
end e[完了]
s -> other
other -> e`;
    const child = `flow detail[詳細]
pool company[自社]
lane owner[担当]
start cs[開始]
end ce[完了]
cs -> ce`;
    try {
      writeView(dir, 'overview', parent);
      writeView(dir, 'detail', child);
      const reportPath = join(dir, 'review.md');
      writeFileSync(reportPath, report([
        'view-index | view | overview:* | modeled | entry=s; exits=e',
        'view-index | view | detail:* | modeled | entry=cs; exits=ce',
      ]), 'utf8');
      const result = evaluateDelivery({ directory: dir, reportPath, parentId: 'overview', version: VERSION });
      expect(result.findings.some((finding) => finding.code === 'E-501' && finding.message.includes('task(sub)'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('多段の task(sub) をたどり、独立トリガーによる親子偽装を拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-nested-'));
    const root = `flow overview[全体]
pool company[自社]
lane owner[担当]
start s[開始]
task(sub) detail[詳細]
end e[完了]
s -> detail
detail -> e`;
    const detail = `flow detail[詳細]
pool company[自社]
lane owner[担当]
start ds[開始]
task(sub) leaf[下位詳細]
end de[完了]
ds -> leaf
leaf -> de`;
    const leaf = `flow leaf[下位詳細]
pool company[自社]
lane owner[担当]
start ls[開始]
end le[完了]
ls -> le`;
    try {
      writeView(dir, 'overview', root);
      writeView(dir, 'detail', detail);
      writeView(dir, 'leaf', leaf);
      const reportPath = join(dir, 'review.md');
      const base = [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | overview:* | modeled | entry=s; exits=e |',
        '| view-index | view | generated:flow | detail:* | modeled | entry=ds; exits=de |',
        '| view-index | view | generated:flow | leaf:* | modeled | entry=ls; exits=le |',
        '| view-plan | view | analysis:decomposition | detail:* | modeled | boundary=subprocess; level=2; state=asis |',
        '| view-plan | view | analysis:decomposition | leaf:* | modeled | boundary=subprocess; level=2; state=asis |',
      ];
      writeFileSync(reportPath, [...base, ''].join('\n'), 'utf8');
      const nested = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true,
      });
      expect(nested.findings.filter((finding) => finding.level === 'error')).toEqual([]);

      writeFileSync(reportPath, [
        ...base,
        '| independent-trigger | view | analysis:decomposition | leaf:* | modeled | boundary=trigger; level=2; state=asis |',
        '',
      ].join('\n'), 'utf8');
      const disguised = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true,
      });
      expect(disguised.findings.some((finding) =>
        finding.code === 'E-501' && finding.message.includes('重複宣言'),
      )).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('独立トリガーの view-plan は boundary=trigger または time を要求する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-trigger-'));
    const root = `flow overview[全体]
pool company[自社]
lane owner[担当]
start s[開始]
end e[完了]
s -> e`;
    const independent = `flow alert[独立イベント]
pool company[自社]
lane owner[担当]
start as[通知]
end ae[対応済み]
as -> ae`;
    try {
      writeView(dir, 'overview', root);
      writeView(dir, 'alert', independent);
      const reportPath = join(dir, 'review.md');
      writeFileSync(reportPath, [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | overview:* | modeled | entry=s; exits=e |',
        '| view-index | view | generated:flow | alert:* | modeled | entry=as; exits=ae |',
        '| view-plan | view | analysis:decomposition | alert:* | modeled | boundary=handoff; level=2; state=asis |',
        '| independent-trigger | view | analysis:decomposition | alert:* | modeled | boundary=handoff; level=2; state=asis |',
        '',
      ].join('\n'), 'utf8');
      const result = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true,
      });
      expect(result.findings.some((finding) =>
        finding.code === 'E-516' && finding.message.includes('boundary=trigger または time'),
      )).toBe(true);

      writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replaceAll('boundary=handoff', 'boundary=time'), 'utf8');
      const valid = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true,
      });
      expect(valid.findings.filter((finding) => finding.level === 'error')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('台帳の列契約を崩したら E-510', () => {
    const parsed = parseLedger('| claim | view:id | status |\n|---|---|---|\n| x | a:* | modeled |');
    expect(parsed.findings.some((finding) => finding.code === 'E-510')).toBe(true);
  });

  it('consulting 台帳は出典を必須にし、conflict は二つの出典を要求する', () => {
    const valid = parseLedger([
      '| claim | kind | source | view:id | status | reason |',
      '|---|---|---|---|---|---|',
      '| 規程と実務が異なる | conflict | manual:v3#申請; interview:turn7 | sample:t | modeled | As-Is は実務を採用 |',
    ].join('\n'), true);
    expect(valid.findings).toEqual([]);

    const invalid = parseLedger([
      '| claim | kind | source | view:id | status | reason |',
      '|---|---|---|---|---|---|',
      '| 規程と実務が異なる | conflict | interview:turn7 | sample:t | modeled | 比較元不足 |',
    ].join('\n'), true);
    expect(invalid.findings.some((finding) => finding.code === 'E-515')).toBe(true);

    const inventedKind = parseLedger([
      '| claim | kind | source | view:id | status | reason |',
      '|---|---|---|---|---|---|',
      '| x | guessed | interview:turn1 | sample:t | modeled | 語彙外 |',
    ].join('\n'), true);
    expect(inventedKind.findings.some((finding) => finding.code === 'E-515')).toBe(true);
  });

  it('W-440 の単一 .flow は E-517', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-w440-single-'));
    const lines = ['flow long[Long process]', 'lane work[Work]', '  start n0[Started]'];
    for (let i = 1; i <= 40; i++) lines.push(`  task n${i}[Complete step ${i}]`);
    lines.push('  end n41[Completed]');
    for (let i = 0; i <= 40; i++) lines.push(`n${i} -> n${i + 1}`);
    try {
      writeView(dir, 'long', lines.join('\n'));
      const reportPath = join(dir, 'review.md');
      writeFileSync(reportPath, report([
        'view-index | view | long:* | modeled | entry=n0; exits=n41',
        'W-440 | diagnostic | long:W-440 | modeled | 単一図として提出',
      ]), 'utf8');
      const result = evaluateDelivery({ directory: dir, reportPath, version: VERSION });
      expect(result.findings.some((finding) => finding.code === 'E-517')).toBe(true);
      expect(() => compile(lines.join('\n'), { strict: true, version: VERSION })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W-440 を含む複数 .flow は --parent が無ければ E-517、親子が揃えば通る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-w440-bundle-'));
    const parent = `flow overview[全体]
pool company[自社]
lane owner[担当]
start s[開始]
task(sub) long[詳細を実行する]
end e[完了]
s -> long
long -> e`;
    const lines = ['flow long[Long process]', 'lane work[Work]', '  start n0[Started]'];
    for (let i = 1; i <= 40; i++) lines.push(`  task n${i}[Complete step ${i}]`);
    lines.push('  end n41[Completed]');
    for (let i = 0; i <= 40; i++) lines.push(`n${i} -> n${i + 1}`);
    try {
      writeView(dir, 'overview', parent);
      writeView(dir, 'long', lines.join('\n'));
      const reportPath = join(dir, 'review.md');
      const rows = [
        'view-index | view | overview:* | modeled | entry=s; exits=e',
        'view-index | view | long:* | modeled | entry=n0; exits=n41',
        'W-440 | diagnostic | long:W-440 | modeled | 詳細図',
      ];
      writeFileSync(reportPath, report(rows), 'utf8');
      const missingParent = evaluateDelivery({ directory: dir, reportPath, version: VERSION });
      expect(missingParent.findings.some((finding) => finding.code === 'E-517')).toBe(true);

      const structured = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION,
      });
      expect(structured.findings.filter((finding) => finding.level === 'error')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未解決 topology は質問の処分を要求する', () => {
    const table = (reason: string) => [
      '| claim | kind | source | view:id | status | reason |',
      '|---|---|---|---|---|---|',
      `| 承認者不明 | unknown-topology | interview:turn3 | sample:g | unresolved | ${reason} |`,
    ].join('\n');
    expect(parseLedger(table('要確認'), true).findings.some((finding) => finding.code === 'E-515')).toBe(true);
    expect(parseLedger(table('asked=user-question:1'), true).findings).toEqual([]);
  });
});

describe('snapshot comparison script', () => {
  it('片側だけにある図を報告して失敗する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-compare-'));
    const row = { name: 'shared', bends: 0, hops: 0, uturn: 0, excess: 0, oracle: 0, area: 1, length: 1 };
    try {
      const before = join(dir, 'before.json');
      const after = join(dir, 'after.json');
      writeFileSync(before, JSON.stringify({ rows: [row] }), 'utf8');
      writeFileSync(after, JSON.stringify({ rows: [row, { ...row, name: 'added' }] }), 'utf8');
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', fileURLToPath(new URL('../scripts/eval/compare.mts', import.meta.url)), before, after,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('added missing from A');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
