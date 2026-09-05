import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile, parse } from '../src/compile.ts';
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

// テスト内の合成モデルに対するレビュー記録。実際の納品では目視後に記入する。
function consultingReport(dir: string, base: string[]): string {
  const rows = base.filter(Boolean);
  const semantics = ['| child | invariant | parent claim | child evidence | verdict | action |', '|---|---|---|---|---|---|'];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.flow'))) {
    const ir = parse(readFileSync(join(dir, file), 'utf8')).ir;
    const hash = createHash('sha256').update(readFileSync(join(dir, file.replace(/\.flow$/, '.svg')))).digest('hex');
    rows.push(`| Synthetic process | fact | test:fixture | ${ir.id}:* | modeled | Fixture defines this process |`);
    rows.push(`| delivery-review | view | test:fixture | ${ir.id}:* | modeled | semantic=pass; visual=pass; svg-sha256=${hash} |`);
    for (const child of ir.nodes.filter(n => n.kind === 'task' && n.subtype === 'sub')) {
      for (const invariant of ['scope/trigger', 'participant/lane', 'entry/precondition', 'exit/continuation', 'exception/return/time', 'artifact/system/control']) {
        semantics.push(`| ${child.id} | ${invariant} | ${ir.id}:${child.id} | ${child.id}:* test:fixture | supported | none |`);
      }
    }
  }
  return [...rows, '', ...semantics, ''].join('\n');
}

describe('delivery evaluation gate', () => {
  it('後段のオラクルエラーも strict と納品評価の両方で拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-oracle-'));
    const source = `flow boundary[Boundary]
lane a
start s
task t
end e
s -> t
t -> e
lane b
boundary(timer) timer @t
end timeout
timer -> timeout`;
    try {
      const preview = compile(source, { version: VERSION });
      expect(preview.diagnostics.some((d) => d.code === 'O-4')).toBe(true);
      expect(() => compile(source, { strict: true })).toThrow('O-4');
      writeFileSync(join(dir, 'boundary.flow'), source);
      writeFileSync(join(dir, 'boundary.svg'), preview.svg);
      const reportPath = join(dir, 'review.md');
      writeFileSync(reportPath, report([
        'view-index | view | boundary:* | modeled | entry=s; exits=e,timeout',
      ]));
      const result = evaluateDelivery({ directory: dir, reportPath, version: VERSION });
      expect(result.findings.some((d) => d.level === 'error' && d.code === 'O-4')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

      writeFileSync(reportPath, consultingReport(dir, [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | overview:* | modeled | entry=s; exits=e |',
        '| view-index | view | generated:flow | detail:* | modeled | entry=cs; exits=ce |',
        '| view-plan | view | analysis:decomposition | detail:* | modeled | boundary=subprocess; level=2; state=asis |',
        '',
      ]), 'utf8');
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
      writeFileSync(reportPath, consultingReport(dir, base), 'utf8');
      const nested = evaluateDelivery({
        directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true,
      });
      expect(nested.findings.filter((finding) => finding.level === 'error')).toEqual([]);

      writeFileSync(reportPath, consultingReport(dir, [
        ...base,
        '| independent-trigger | view | analysis:decomposition | leaf:* | modeled | boundary=trigger; level=2; state=asis |',
        '',
      ]), 'utf8');
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
      writeFileSync(reportPath, consultingReport(dir, [
        '| claim | kind | source | view:id | status | reason |',
        '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | overview:* | modeled | entry=s; exits=e |',
        '| view-index | view | generated:flow | alert:* | modeled | entry=as; exits=ae |',
        '| view-plan | view | analysis:decomposition | alert:* | modeled | boundary=handoff; level=2; state=asis |',
        '| independent-trigger | view | analysis:decomposition | alert:* | modeled | boundary=handoff; level=2; state=asis |',
        '',
      ]), 'utf8');
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

  it('親から離れた循環と子の欠落を拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-reachability-'));
    const view = (id: string, child?: string) => `flow ${id}[${id}]\nlane owner\nstart s\nend e\n${child ? `task(sub) ${child}\ns -> ${child}\n${child} -> e` : 's -> e'}`;
    try {
      const reportPath = join(dir, 'review.md');
      writeView(dir, 'overview', view('overview', 'missing'));
      writeFileSync(reportPath, report(['view-index | view | overview:* | modeled | entry=s; exits=e']));
      expect(evaluateDelivery({ directory: dir, reportPath, version: VERSION }).findings.some(f => f.code === 'E-502')).toBe(true);
      writeView(dir, 'overview', view('overview', 'overview'));
      expect(evaluateDelivery({ directory: dir, reportPath, version: VERSION }).findings.some(f => f.message.includes('循環'))).toBe(true);
      writeView(dir, 'overview', view('overview'));
      writeView(dir, 'a', view('a', 'b'));
      writeView(dir, 'b', view('b', 'a'));
      writeFileSync(reportPath, report(['overview', 'a', 'b'].map(id => `view-index | view | ${id}:* | modeled | entry=s; exits=e`)));
      const options = { directory: dir, reportPath, parentId: 'overview', version: VERSION };
      expect(evaluateDelivery(options).findings.filter(f => f.message.includes('到達できない'))).toHaveLength(2);
      writeView(dir, 'overview', view('overview', 'a'));
      expect(evaluateDelivery(options).findings.some(f => f.message.includes('循環'))).toBe(true);
      writeView(dir, 'b', view('b'));
      expect(evaluateDelivery(options).findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('意味レビューの欠落・不合格・参照切れと、目視確認後の変更を拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-eval-review-'));
    try {
      writeView(dir, 'overview', 'flow overview[Overview]\nlane owner\nstart s\ntask(sub) detail\nend e\ns -> detail\ndetail -> e');
      const detail = 'flow detail[Detail]\nlane owner\nstart s\ntask work[Work]\nend e\ns -> work\nwork -> e';
      writeView(dir, 'detail', detail);
      const base = [
        '| claim | kind | source | view:id | status | reason |', '|---|---|---|---|---|---|',
        '| view-index | view | generated:flow | overview:* | modeled | entry=s; exits=e |',
        '| view-index | view | generated:flow | detail:* | modeled | entry=s; exits=e |',
        '| view-plan | view | test:fixture | detail:* | modeled | boundary=subprocess; level=2; state=asis |',
      ];
      const reportPath = join(dir, 'review.md');
      const options = { directory: dir, reportPath, parentId: 'overview', version: VERSION, consulting: true };
      writeFileSync(reportPath, base.join('\n'));
      expect(evaluateDelivery(options).findings.some(f => f.code === 'E-518')).toBe(true);
      expect(evaluateDelivery(options).findings.some(f => f.code === 'E-519')).toBe(true);
      // 主経路ヒントも含め、分岐をビュー全体の根拠だけで代用できない。
      writeView(dir, 'detail', 'flow detail[Detail]\nlane owner\nstart s\nxor g\nend e\nend rejected\ns -> g\ng => e: yes\ng -> rejected: no');
      const branching = consultingReport(dir, base.map(row => row.replace('detail:* | modeled | entry=s; exits=e', 'detail:* | modeled | entry=s; exits=e,rejected')));
      writeFileSync(reportPath, branching);
      expect(evaluateDelivery(options).findings.filter(f => f.message.includes('分岐の根拠行'))).toHaveLength(2);
      writeFileSync(reportPath, branching.replace('\n\n| child |', '\n| Approve | fact | test:fixture | detail:g->e | modeled | Yes |\n| Reject | fact | test:fixture | detail:g->rejected | modeled | No |\n\n| child |'));
      expect(evaluateDelivery(options).findings).toEqual([]);
      writeView(dir, 'detail', detail);
      const valid = consultingReport(dir, base);
      writeFileSync(reportPath, valid);
      expect(evaluateDelivery(options).findings).toEqual([]);
      for (const invalid of [
        valid.replace('| supported |', '| mismatch |'),
        valid.replace('| supported |', '| unresolved |'),
        valid.replace('overview:detail | detail:*', 'overview:missing | detail:*'),
        valid.replace(/^\| detail \| scope\/trigger .*\n/m, ''),
      ]) {
        writeFileSync(reportPath, invalid);
        expect(evaluateDelivery(options).findings.some(f => f.code === 'E-518')).toBe(true);
      }
      writeFileSync(reportPath, valid.replace('visual=pass', 'visual=fail'));
      expect(evaluateDelivery(options).findings.some(f => f.code === 'E-519')).toBe(true);
      writeFileSync(reportPath, valid);
      writeView(dir, 'detail', detail.replace('[Work]', '[Revised work]'));
      expect(evaluateDelivery(options).findings.some(f => f.code === 'E-519')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('W-440 の詳細1枚は分解せず提供できる', () => {
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
      expect(result.findings).toEqual([]);
      expect(() => compile(lines.join('\n'), { strict: true, version: VERSION })).not.toThrow();
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

  it('オーバーレイは SVG を壊さない形で埋め込む', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-timeline-'));
    try {
      const before = join(dir, 'before');
      const after = join(dir, 'after');
      mkdirSync(before);
      mkdirSync(after);
      const svg = '<svg width="10" height="10"><text>請求 &amp; 保管</text></svg>';
      const metrics = JSON.stringify({ rows: [{ name: 'sample', bends: 0, hops: 0, area: 100 }] });
      for (const snapshot of [before, after]) {
        writeFileSync(join(snapshot, 'sample.svg'), svg, 'utf8');
        writeFileSync(join(snapshot, 'metrics.json'), metrics, 'utf8');
      }
      const output = join(dir, 'timeline.html');
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', fileURLToPath(new URL('../scripts/eval/timeline.mts', import.meta.url)),
        output, `before=${before}`, `after=${after}`,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      const html = readFileSync(output, 'utf8');
      const encoded = /<script type="application\/octet-stream" id="data">([^<]+)<\/script>/.exec(html)?.[1];
      expect(encoded).toBeTruthy();
      const payload = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
      expect(payload.svgs).toContain(svg);
      expect(html).not.toContain(`<script type="application/json"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
