// 成果物一式の評価ゲート。
// 単一 .flow の意味を推測せず、コンパイラ証拠、レビュー台帳、ビュー集合の
// 機械的な契約だけを照合する。面談固有の claims は上位の評価フィクスチャが担う。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { compile, CompileError } from './compile.ts';
import { parse } from './parse.ts';
import type { Diagnostic, Ir } from './types.ts';

export type EvalLevel = 'error' | 'warning' | 'info';

export interface EvalFinding {
  level: EvalLevel;
  code: string;
  message: string;
}

export interface LedgerRow {
  claim: string;
  kind: string;
  source?: string;
  viewId: string;
  status: 'modeled' | '?' | 'excluded' | 'unresolved';
  reason: string;
  line: number;
}

export interface DeliveryEvalOptions {
  directory: string;
  reportPath: string;
  parentId?: string;
  version?: string;
  consulting?: boolean;
}

export interface DeliveryEvalResult {
  findings: EvalFinding[];
  flowIds: string[];
  rows: LedgerRow[];
}

interface View {
  id: string;
  file: string;
  ir: Ir;
  diagnostics: Diagnostic[];
  svgHash: string;
}

const HEADERS = ['claim', 'kind', 'view:id', 'status', 'reason'];
const CONSULTING_HEADERS = ['claim', 'kind', 'source', 'view:id', 'status', 'reason'];
const STATUSES = new Set<LedgerRow['status']>(['modeled', '?', 'excluded', 'unresolved']);
const CONSULTING_KINDS = new Set([
  'fact', 'assume', 'conflict', 'unknown-topology', 'unknown-label', 'proposal', 'view', 'diagnostic',
]);
const VIEW_BOUNDARIES = new Set(['outcome', 'handoff', 'subprocess', 'trigger', 'time', 'variant']);
const SEMANTIC_INVARIANTS = ['scope/trigger', 'participant/lane', 'entry/precondition', 'exit/continuation', 'exception/return/time', 'artifact/system/control'];

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function separator(line: string, columns: number): boolean {
  const parts = cells(line);
  return parts.length === columns && parts.every((part) => /^:?-{3,}:?$/u.test(part));
}

export function parseLedger(markdown: string, consulting = false): { rows: LedgerRow[]; findings: EvalFinding[] } {
  const lines = markdown.split(/\r?\n/u);
  const findings: EvalFinding[] = [];
  const headers = consulting ? CONSULTING_HEADERS : HEADERS;
  let header = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    const normalized = cells(lines[i]!).map((cell) => cell.toLowerCase());
    if (normalized.join('\u0000') === headers.join('\u0000') && separator(lines[i + 1]!, headers.length)) {
      header = i;
      break;
    }
  }
  if (header < 0) {
    return {
      rows: [],
      findings: [{
        level: 'error', code: 'E-510',
        message: `レビュー台帳がない。列を ${headers.join(' | ')} の順で作成する`,
      }],
    };
  }

  const rows: LedgerRow[] = [];
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith('|')) break;
    const parts = cells(line);
    if (parts.length !== headers.length) {
      findings.push({
        level: 'error', code: 'E-510',
        message: `レビュー台帳 ${i + 1} 行目の列数が ${parts.length}。${headers.length} 列に固定する`,
      });
      continue;
    }
    const [claim, kind, source, viewId, statusRaw, reason] = consulting
      ? parts
      : [parts[0], parts[1], undefined, parts[2], parts[3], parts[4]];
    if (!claim || !kind || (consulting && !source) || !viewId || !statusRaw || !reason) {
      findings.push({
        level: 'error', code: 'E-510',
        message: `レビュー台帳 ${i + 1} 行目に空欄がある`,
      });
      continue;
    }
    if (!STATUSES.has(statusRaw as LedgerRow['status'])) {
      findings.push({
        level: 'error', code: 'E-510',
        message: `レビュー台帳 ${i + 1} 行目の status「${statusRaw}」は modeled / ? / excluded / unresolved のいずれでもない`,
      });
      continue;
    }
    if (consulting) {
      const locators = source!.split(';').map((value) => value.trim()).filter(Boolean);
      if (locators.length === 0 || locators.some((value) => !/^[a-z][a-z0-9-]*:.+/u.test(value)) ||
          (kind === 'conflict' && locators.length < 2)) {
        findings.push({
          level: 'error', code: 'E-515',
          message: `レビュー台帳 ${i + 1} 行目の source は種別:位置形式${kind === 'conflict' ? 'を2件以上' : ''}で記録する`,
        });
        continue;
      }
      if (!CONSULTING_KINDS.has(kind)) {
        findings.push({
          level: 'error', code: 'E-515',
          message: `レビュー台帳 ${i + 1} 行目の kind「${kind}」は consulting の固定語彙にない`,
        });
        continue;
      }
      if (kind === 'unknown-topology' && statusRaw !== 'unresolved') {
        findings.push({
          level: 'error', code: 'E-515',
          message: `レビュー台帳 ${i + 1} 行目の unknown-topology は unresolved にする。回答済みなら fact 等へ更新する`,
        });
        continue;
      }
      const asked = kind === 'unknown-topology' ? listValue(reason!, 'asked') : undefined;
      if (kind === 'unknown-topology' &&
          (asked?.length !== 1 || !/^(?:user-question:.+|unavailable:.+|no-channel)$/u.test(asked[0]!))) {
        findings.push({
          level: 'error', code: 'E-515',
          message: `レビュー台帳 ${i + 1} 行目の unknown-topology は reason に asked=user-question:<id> / unavailable:<locator> / no-channel のいずれかを記録する`,
        });
        continue;
      }
    }
    rows.push({ claim, kind, source, viewId, status: statusRaw as LedgerRow['status'], reason, line: i + 1 });
  }
  if (rows.length === 0) {
    findings.push({ level: 'error', code: 'E-510', message: 'レビュー台帳にデータ行がない' });
  }
  return { rows, findings };
}

function splitViewRef(ref: string): { view: string; target: string } | undefined {
  const index = ref.indexOf(':');
  if (index <= 0 || index === ref.length - 1) return undefined;
  return { view: ref.slice(0, index), target: ref.slice(index + 1) };
}

function listValue(reason: string, key: string): string[] | undefined {
  const match = new RegExp(`(?:^|;)\\s*${key}=([^;]+)`, 'u').exec(reason);
  if (!match) return undefined;
  const value = match[1]!.trim();
  if (value === '-' || value === 'none') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function sameMembers(actual: string[], reported: string[]): boolean {
  return [...actual].sort().join('\u0000') === [...reported].sort().join('\u0000');
}

export function evaluateDelivery(options: DeliveryEvalOptions): DeliveryEvalResult {
  const findings: EvalFinding[] = [];
  let markdown = '';
  try {
    markdown = readFileSync(options.reportPath, 'utf8');
  } catch {
    findings.push({
      level: 'error', code: 'E-510',
      message: `レビュー報告を読めない: ${options.reportPath}`,
    });
  }
  const ledger = parseLedger(markdown, options.consulting);
  findings.push(...ledger.findings);
  const rows = ledger.rows;

  const flowFiles = readdirSync(options.directory)
    .filter((name) => name.endsWith('.flow'))
    .sort();
  if (flowFiles.length === 0) {
    findings.push({ level: 'error', code: 'E-500', message: '評価対象の .flow がない' });
    return { findings, flowIds: [], rows };
  }

  const views: View[] = [];
  for (const name of flowFiles) {
    const flowPath = join(options.directory, name);
    const source = readFileSync(flowPath, 'utf8');
    const parsed = parse(source);
    const id = parsed.ir.id;
    if (!id) {
      findings.push({
        level: 'error', code: 'E-501',
        message: `${name}: flow id[label] の安定 ID がない`,
      });
      continue;
    }
    if (views.some((view) => view.id === id)) {
      findings.push({ level: 'error', code: 'E-501', message: `flow id ${id} が重複している` });
      continue;
    }
    try {
      const svgPath = join(options.directory, `${basename(name, '.flow')}.svg`);
      const delivered = existsSync(svgPath) ? readFileSync(svgPath, 'utf8') : undefined;
      const result = compile(source, { strict: true, version: options.version });
      views.push({ id, file: name, ir: parsed.ir, diagnostics: result.diagnostics, svgHash: createHash('sha256').update(result.svg).digest('hex') });
      if (delivered === undefined) {
        findings.push({ level: 'error', code: 'E-500', message: `${name}: 対応する SVG がない` });
      } else if (delivered !== result.svg) {
        findings.push({
          level: 'error', code: 'E-500',
          message: `${name}: 配布 SVG が同じ版の strict 再コンパイル結果と一致しない`,
        });
      }
    } catch (error) {
      if (error instanceof CompileError) {
        for (const diagnostic of error.diagnostics.filter((d) => d.level === 'error')) {
          findings.push({ level: 'error', code: diagnostic.code, message: `${name}: ${diagnostic.message}` });
        }
      } else {
        throw error;
      }
    }
  }

  const byView = new Map(views.map((view) => [view.id, view]));
  for (const row of rows) {
    const ref = splitViewRef(row.viewId);
    if (!ref || !byView.has(ref.view)) {
      findings.push({
        level: 'error', code: 'E-511',
        message: `レビュー台帳 ${row.line} 行目の view:id「${row.viewId}」が成果物に存在しない`,
      });
      continue;
    }
    if (ref.target === '*' || /^W-\d+$/u.test(ref.target)) continue;
    const view = byView.get(ref.view)!;
    const nodeExists = view.ir.nodes.some((node) => node.id === ref.target);
    const edgeExists = view.ir.edges.some((edge) => `${edge.from}->${edge.to}` === ref.target);
    if (!nodeExists && !edgeExists) {
      findings.push({
        level: 'error', code: 'E-511',
        message: `レビュー台帳 ${row.line} 行目の対象「${row.viewId}」が .flow に存在しない`,
      });
    }
  }

  for (const view of views) {
    const indexRow = rows.find((row) =>
      row.claim === 'view-index' && row.kind === 'view' && row.viewId === `${view.id}:*`,
    );
    if (!indexRow) {
      findings.push({
        level: 'error', code: 'E-512',
        message: `${view.id}: view-index 行がない`,
      });
    } else {
      const actualEntries = view.ir.nodes.filter((node) => node.kind === 'start').map((node) => node.id);
      const actualExits = view.ir.nodes.filter((node) => node.kind === 'end').map((node) => node.id);
      const entries = listValue(indexRow.reason, 'entry');
      const exits = listValue(indexRow.reason, 'exits');
      if (!entries || !exits || !sameMembers(actualEntries, entries) || !sameMembers(actualExits, exits)) {
        findings.push({
          level: 'error', code: 'E-512',
          message: `${view.id}: view-index の reason は entry=<id,...>; exits=<id,...> を実際の開始・終了と一致させる`,
        });
      }
    }

    const warningCodes = [...new Set(
      view.diagnostics.filter((diagnostic) => diagnostic.level === 'warning').map((diagnostic) => diagnostic.code),
    )];
    for (const code of warningCodes) {
      const disposition = rows.find((row) =>
        row.claim === code && row.kind === 'diagnostic' && row.viewId === `${view.id}:${code}`,
      );
      if (!disposition) {
        findings.push({
          level: 'error', code: 'E-513',
          message: `${view.id}: 実際に発生した ${code} の処分行がレビュー台帳にない`,
        });
      } else if (disposition.status === 'unresolved' || disposition.status === '?') {
        findings.push({
          level: 'error', code: 'E-513',
          message: `${view.id}: ${code} が ${disposition.status} のままで完了扱いにできない`,
        });
      }
    }

    for (const node of view.ir.nodes.filter((candidate) => candidate.provisional)) {
      const covered = rows.some((row) =>
        row.viewId === `${view.id}:${node.id}` && (row.status === '?' || row.status === 'unresolved'),
      );
      if (!covered) {
        findings.push({
          level: 'error', code: 'E-514',
          message: `${view.id}:${node.id} の ? をレビュー台帳が説明していない`,
        });
      }
    }
    for (const edge of view.ir.edges.filter((candidate) => candidate.provisional)) {
      const target = `${edge.from}->${edge.to}`;
      const covered = rows.some((row) =>
        row.viewId === `${view.id}:${target}` && (row.status === '?' || row.status === 'unresolved'),
      );
      if (!covered) {
        findings.push({
          level: 'error', code: 'E-514',
          message: `${view.id}:${target} の ->? をレビュー台帳が説明していない`,
        });
      }
    }
  }

  const children = new Map<string, string[]>();
  const referencedBy = new Map<string, Set<string>>();
  for (const owner of views) {
    const ids = owner.ir.nodes.filter(node => node.kind === 'task' && node.subtype === 'sub').map(node => node.id);
    children.set(owner.id, ids);
    for (const id of ids) {
      if (!byView.has(id)) {
        findings.push({ level: 'error', code: 'E-502', message: `${owner.id}:${id} の task(sub) に対応する子 .flow がない` });
        continue;
      }
      const owners = referencedBy.get(id) ?? new Set<string>();
      owners.add(owner.id);
      referencedBy.set(id, owners);
    }
  }
  if (views.length > 1 && !options.parentId) {
    findings.push({ level: 'error', code: 'E-501', message: '複数ビューの納品には --parent で概要図を指定する' });
  }
  const parentId = options.parentId ?? (views.length === 1 ? views[0]!.id : undefined);
  if (parentId) {
    const parent = byView.get(parentId);
    if (!parent) {
      findings.push({ level: 'error', code: 'E-501', message: `親ビュー ${parentId} が存在しない` });
    } else {
      const reachable = new Set<string>();
      const active = new Set<string>();
      const visit = (id: string): void => {
        if (active.has(id)) {
          findings.push({ level: 'error', code: 'E-501', message: `${id}: task(sub) の詳細参照が循環している` });
          return;
        }
        if (reachable.has(id) || !byView.has(id)) return;
        reachable.add(id);
        active.add(id);
        for (const child of children.get(id) ?? []) visit(child);
        active.delete(id);
      };
      visit(parent.id);
      for (const row of rows.filter(row => row.claim === 'independent-trigger' && row.kind === 'view' && row.status === 'modeled')) {
        const ref = splitViewRef(row.viewId);
        if (ref?.target === '*') visit(ref.view);
      }
      for (const child of views.filter((view) => view.id !== parent.id)) {
        let plan: LedgerRow | undefined;
        let boundary: string | undefined;
        if (options.consulting) {
          plan = rows.find((row) =>
            row.claim === 'view-plan' && row.kind === 'view' && row.viewId === `${child.id}:*`,
          );
          boundary = plan && listValue(plan.reason, 'boundary')?.[0];
          const level = plan && listValue(plan.reason, 'level')?.[0];
          const state = plan && listValue(plan.reason, 'state')?.[0];
          if (!plan || !boundary || !VIEW_BOUNDARIES.has(boundary) ||
              !['1', '2'].includes(level ?? '') || !['asis', 'tobe'].includes(state ?? '')) {
            findings.push({
              level: 'error', code: 'E-516',
              message: `${child.id}: consulting の view-plan は boundary=<outcome|handoff|subprocess|trigger|time|variant>; level=<1|2>; state=<asis|tobe> を要求する`,
            });
          }
        }
        const independent = rows.some((row) =>
          row.claim === 'independent-trigger' && row.kind === 'view' &&
          row.viewId === `${child.id}:*` && row.status === 'modeled',
        );
        const owners = referencedBy.get(child.id);
        if (independent && owners?.size) {
          findings.push({
            level: 'error', code: 'E-501',
            message: `${child.id}: task(sub) から参照される子ビューを independent-trigger として重複宣言できない`,
          });
        } else if (independent && options.consulting && !['trigger', 'time'].includes(boundary ?? '')) {
          findings.push({
            level: 'error', code: 'E-516',
            message: `${child.id}: independent-trigger の view-plan は boundary=trigger または time にする`,
          });
        } else if (!owners?.size && !independent) {
          findings.push({
            level: 'error', code: 'E-501',
            message: `${child.id}: どのビューにも同じ ID の task(sub) がなく、independent-trigger 行もない`,
          });
        } else if (!reachable.has(child.id)) {
          findings.push({ level: 'error', code: 'E-501', message: `${child.id}: 概要図 ${parent.id} または独立トリガーから到達できない子ビュー` });
        }
      }
      const parentPoolLabels = new Set(parent.ir.pools.flatMap((pool) => [pool.id, pool.label]));
      const parentLaneLabels = new Set(parent.ir.lanes.flatMap((lane) => [lane.id, lane.label]));
      for (const child of views.filter((view) => view.id !== parent.id)) {
        for (const pool of child.ir.pools) {
          if (parentPoolLabels.has(pool.id) || parentPoolLabels.has(pool.label)) continue;
          if (!parentLaneLabels.has(pool.id) && !parentLaneLabels.has(pool.label)) continue;
          findings.push({
            level: 'warning', code: 'W-503',
            message: `${child.id} で外部プールの ${pool.id}「${pool.label}」が親ではレーンになっている`,
          });
        }
      }
    }
  }

  if (options.consulting) {
    const evidenceKinds = new Set(['fact', 'assume', 'conflict', 'proposal']);
    for (const view of views) {
      const evidence = rows.filter(row => evidenceKinds.has(row.kind) && row.viewId.startsWith(`${view.id}:`) && (row.status === 'modeled' || row.status === '?'));
      if (evidence.length === 0) findings.push({ level: 'error', code: 'E-518', message: `${view.id}: 業務の根拠行がない。ビュー管理行だけでは検証できない` });
      for (const node of view.ir.nodes) {
        const branches = view.ir.edges.filter(edge => edge.kind === 'seq' && edge.from === node.id);
        if (branches.length < 2) continue;
        for (const edge of branches) {
          if (!evidence.some(row => row.viewId === `${view.id}:${edge.from}->${edge.to}`)) {
            findings.push({ level: 'error', code: 'E-518', message: `${view.id}:${edge.from}->${edge.to}: 分岐の根拠行がない` });
          }
        }
      }
      const reviews = rows.filter(row => row.claim === 'delivery-review' && row.kind === 'view' && row.viewId === `${view.id}:*`);
      const review = reviews[0];
      if (reviews.length !== 1 || review?.status !== 'modeled' ||
          listValue(review.reason, 'semantic')?.join() !== 'pass' ||
          listValue(review.reason, 'visual')?.join() !== 'pass' ||
          listValue(review.reason, 'svg-sha256')?.join() !== view.svgHash) {
        findings.push({ level: 'error', code: 'E-519', message: `${view.id}: 現在の SVG に対する意味・目視レビューが未完了。delivery-review に semantic=pass; visual=pass; svg-sha256=<確認したSVGのSHA256> を記録する` });
      }
    }

    // 意味そのものは推測しない。既存の6項目表の欠落・不合格・参照切れを閉じる。
    const reviewHeaders = ['child', 'invariant', 'parent claim', 'child evidence', 'verdict', 'action'];
    const lines = markdown.split(/\r?\n/u);
    const reviewed = new Map<string, number>();
    const tokens = (value: string) => value.split(/[\s;,]+/u).map(token => token.replace(/^`|`$/gu, ''));
    const cites = (value: string, view: View): boolean => tokens(value).some(token => {
      const ref = splitViewRef(token);
      return ref?.view === view.id && (ref.target === '*' || view.ir.nodes.some(n => n.id === ref.target) || view.ir.edges.some(e => `${e.from}->${e.to}` === ref.target));
    });
    for (let i = 0; i + 1 < lines.length; i++) {
      if (cells(lines[i]!).map(cell => cell.toLowerCase()).join('|') !== reviewHeaders.join('|') || !separator(lines[i + 1]!, 6)) continue;
      i += 2;
      for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
        const parts = cells(lines[i]!);
        const [childId, invariant, parentClaim, childEvidence, verdict] = parts;
        const child = byView.get(childId ?? '');
        const owners = views.filter(view => (children.get(view.id) ?? []).includes(childId ?? '') && cites(parentClaim ?? '', view));
        const hasSource = tokens(childEvidence ?? '').some(token => /^[a-z][a-z0-9-]*:.+/u.test(token) && !byView.has(token.split(':')[0]!) && !/^(generated|compiler|analysis):/u.test(token));
        if (parts.length !== 6 || parts.some(cell => !cell) || !child || owners.length !== 1 ||
            !SEMANTIC_INVARIANTS.includes(invariant ?? '') || !cites(childEvidence ?? '', child) || !hasSource || verdict !== 'supported') {
          findings.push({ level: 'error', code: 'E-518', message: `意味レビュー ${i + 1} 行目が未完了または参照不正。親・子の view:id、原資料の出典、supported 判定と action が必要` });
          continue;
        }
        const key = `${owners[0]!.id}\u0000${childId}\u0000${invariant}`;
        reviewed.set(key, (reviewed.get(key) ?? 0) + 1);
      }
      i--;
    }
    for (const [owner, ids] of children) for (const child of ids) {
      if (!byView.has(child)) continue;
      for (const invariant of SEMANTIC_INVARIANTS) {
        if (reviewed.get(`${owner}\u0000${child}\u0000${invariant}`) !== 1) findings.push({
          level: 'error', code: 'E-518', message: `${owner} → ${child}: ${invariant} の supported レビューが1行必要`,
        });
      }
    }
  }

  const labelIds = new Map<string, Set<string>>();
  for (const view of views) {
    for (const lane of view.ir.lanes) {
      const ids = labelIds.get(lane.label) ?? new Set<string>();
      ids.add(lane.id);
      labelIds.set(lane.label, ids);
    }
  }
  for (const [label, ids] of labelIds) {
    if (ids.size < 2) continue;
    findings.push({
      level: 'info', code: 'N-505',
      message: `同じレーン表示名「${label}」に複数 ID がある: ${[...ids].sort().join(', ')}`,
    });
  }

  return { findings, flowIds: views.map((view) => view.id), rows };
}
