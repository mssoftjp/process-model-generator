// DSL パーサ。表層はマーメイド風、意味は IR への写像として定義する（C-04）。
//
//   flow 受注処理
//   lane 営業
//     start s1
//     A[受注入力]            # task の省略形
//     xor g1[金額判定]
//   lane 倉庫
//     B[ピッキング]
//     end e1
//   s1 -> A
//   A -> g1
//   g1 => B: 100万未満       # => は本流ヒント、: は条件ラベル
//   g1 ->> A                 # ->> は戻りヒント（レイアウトの戻り辺固定）
//   g1 ->? B                 # ->? は出所印（AI 推定など未確定の辺）
//
// C-15: 任意のテキストに対して決定的に応答する。
// lax（既定）は自動補完＋警告で必ず IR を返し、strict は同じ事象をエラーにする。

import { applyInterpretation, diagnoseInterpretation, interpretNode, isEventKind, isGatewayKind, validateIr } from './bpmn.ts';
import { isDocLike } from './types.ts';
import type { AssocKind, Diagnostic, Ir, IrEdge, IrLane, IrNode, IrPool, Orientation } from './types.ts';

const ID = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_]*`;
const NODE_KINDS = 'task|xor|and|start|end|doc|mid|store|note|boundary|group|or|complex|catch|throw';
// 最長一致: -.-> を -.- より先、->/ と ->> を -> より先
const RE_EDGE = new RegExp(
  `^(${ID})(?:\\[([^\\]]*)\\])?\\s*(<\\.\\.>|-\\.->|-\\.-|\\.\\.>|->\\/|->>|=>|~>|->)(\\?)?\\s*(${ID})(?:\\[([^\\]]*)\\])?\\s*(?::\\s*(.*))?$`,
  'u',
);
const RE_NODE = new RegExp(
  `^(?:(${NODE_KINDS})(?:\\(([^)]*)\\))?(\\?)?\\s+)?(${ID})\\s*(?:\\[(.*)\\])?(?:\\s+@(${ID}))?$`,
  'u',
);

export interface ParseResult {
  ir: Ir;
  diagnostics: Diagnostic[];
}

export function parse(source: string): ParseResult {
  const diags: Diagnostic[] = [];
  const pools: IrPool[] = [];
  const lanes: IrLane[] = [];
  const nodes: IrNode[] = [];
  const edges: IrEdge[] = [];
  let flowId: string | undefined;
  let title: string | undefined;
  let orientation: Orientation | undefined;
  let currentPool: string | undefined;
  let currentLane: string | null = null;
  let declIndex = 0;

  // 表示名はプールをまたいで重複できる。参照解決に使う ID と、
  // (pool, label) の宣言単位を分離する。
  const laneByKey = new Map<string, IrLane>();
  const laneById = new Map<string, IrLane>();
  const nodeById = new Map<string, IrNode>();

  const ensureLane = (declaredId: string, label: string, line: number): IrLane => {
    const key = JSON.stringify([currentPool ?? null, declaredId]);
    const found = laneByKey.get(key);
    if (found) return found;
    const id = laneById.has(declaredId) ? uniqueId(declaredId, laneById) : declaredId;
    const lane: IrLane = { id, label, pool: currentPool, declIndex: declIndex++ };
    lanes.push(lane);
    laneByKey.set(key, lane);
    laneById.set(id, lane);
    return lane;
  };

  const inlineLabels = new Map<string, { label: string; line: number }>();
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = stripComment(lines[i]!).trim();
    if (text === '') continue;

    if (/^flow(?:\s|$)/u.test(text)) {
      const t = text.slice(4).trim();
      if (title !== undefined) {
        diags.push({ level: 'warning', code: 'W-001', message: 'flow 行が重複。後の行を無視', line: lineNo });
      } else {
        const parsed = parseScopedName(t);
        flowId = parsed.hasExplicitLabel ? parsed.id : undefined;
        title = parsed.label || undefined;
      }
      continue;
    }

    // orientation vertical | horizontal（向きをテキストへ固定する修辞宣言）。
    // 宣言として消費するのは値が正しいときだけ。orientation は ID 名前空間を奪わない:
    // 辺・ノードとして読める行（`orientation -> B` など）はそちらの構文が優先され、
    // どちらでもない行だけを宣言の書き損じ（W-013）として報告する。
    if (/^orientation(?:\s|$)/u.test(text)) {
      const v = text.slice('orientation'.length).trim();
      if (v === 'vertical' || v === 'horizontal') {
        if (orientation !== undefined) {
          diags.push({ level: 'warning', code: 'W-014', message: 'orientation 行が重複。後の行を無視', line: lineNo });
        } else {
          orientation = v;
        }
        continue;
      }
      const nm0 = RE_NODE.exec(text);
      const parsesAsEdgeOrNode = RE_EDGE.test(text) || (nm0 !== null && (nm0[1] !== undefined || nm0[5] !== undefined));
      if (!parsesAsEdgeOrNode) {
        diags.push({
          level: 'warning', code: 'W-013', line: lineNo,
          message: `orientation の値「${v}」は vertical / horizontal のどちらでもない。無視`,
        });
        continue;
      }
      // 辺・ノード構文へ落とす
    }

    if (text.startsWith('pool ')) {
      const rest = text.slice(5).trim();
      // pool p0[表示名] の形も許す(表示名に空白・記号を使うため)
      const { id, label } = parseScopedName(rest);
      if (id === '') {
        diags.push({ level: 'error', code: 'E-009', message: 'pool にラベルがない', line: lineNo });
        continue;
      }
      if (!pools.some((pl) => pl.id === id)) {
        pools.push({ id, label, declIndex: declIndex++ });
      } else {
        diags.push({ level: 'warning', code: 'W-010', message: `pool ${id} が再宣言。続きとして扱う`, line: lineNo });
      }
      currentPool = id;
      currentLane = null;
      continue;
    }

    if (text.startsWith('lane ')) {
      const rest = text.slice(5).trim();
      const { id, label } = parseScopedName(rest);
      if (label === '') {
        diags.push({ level: 'error', code: 'E-002', message: 'lane にラベルがない', line: lineNo });
        continue;
      }
      const key = JSON.stringify([currentPool ?? null, id]);
      if (laneByKey.has(key)) {
        diags.push({ level: 'warning', code: 'W-003', message: `lane ${label} が重複宣言。同一レーンに合流`, line: lineNo });
      }
      currentLane = ensureLane(id, label, lineNo).id;
      continue;
    }

    const em = RE_EDGE.exec(text);
    if (em) {
      const [, from, fromLabel, arrow, prov, to, toLabel, label] = em;
      if (from === to) {
        diags.push({ level: 'warning', code: 'W-004', message: `自己ループ ${from} -> ${from} は v1 非対応。無視`, line: lineNo });
        continue;
      }
      // 辺内ラベル宣言: A[受注] -> B[検品] の形。未宣言ノードの
      // 実体化に使う(レーンは参照解決時に相手側から推定するため出所印つき)
      if (fromLabel !== undefined) inlineLabels.set(from!, { label: fromLabel, line: lineNo });
      if (toLabel !== undefined) inlineLabels.set(to!, { label: toLabel, line: lineNo });
      const { kind, mainHint, isDefault, returnHint, assocKind } = classifyArrow(arrow!);
      edges.push({
        id: `e${edges.length}_${from}_${to}`,
        kind,
        from: from!,
        to: to!,
        label: label?.trim() || undefined,
        mainHint,
        isDefault,
        returnHint,
        assocKind,
        declIndex: declIndex++,
        provisional: prov === '?',
        synthetic: false,
      });
      continue;
    }

    const nm = RE_NODE.exec(text);
    if (nm && (nm[1] !== undefined || nm[5] !== undefined)) {
      const kindRaw = nm[1] ?? 'task';
      const params = nm[2];
      const interp = interpretNode(kindRaw, params);
      const provisional = nm[3] === '?';
      let id = nm[4]!;
      const attachedTo = nm[6];
      const kind = interp.kind;
      const label = nm[5] ?? (kind === 'start' || kind === 'end' || kind === 'boundary' ? '' : id);
      if (nodeById.has(id)) {
        const renamed = uniqueId(id, nodeById);
        diags.push({
          level: 'error', code: 'E-005', line: lineNo,
          message: `ノード ID ${id} が重複。lax では ${renamed} に読み替え`,
        });
        id = renamed;
      }
      let lane = currentLane;
      if (lane === null) {
        diags.push({
          level: 'error', code: 'E-006', line: lineNo,
          message: `ノード ${id} が lane の外で宣言。lax ではレーン「？」に収容`,
        });
        lane = ensureLane('？', '？', lineNo).id;
        currentLane = null; // 収容は一時的。次のノードも同じ扱い
      }
      const node: IrNode = { id, kind, label, lane, declIndex: declIndex++, provisional, synthetic: false };
      applyInterpretation(node, interp);
      if (attachedTo) {
        if (kind === 'boundary') node.attachedTo = attachedTo;
        else {
          diags.push({
            level: 'warning', code: 'W-314', line: lineNo,
            message: `${id}: @対象 は境界イベント専用。無視`,
          });
        }
      }
      diags.push(...diagnoseInterpretation(interp, kindRaw, id, lineNo));
      nodes.push(node);
      nodeById.set(id, node);
      continue;
    }

    diags.push({ level: 'warning', code: 'W-007', message: `解釈できない行を無視: ${text}`, line: lineNo });
  }

  // 参照解決（C-15: 未宣言ノードの自動実体化）。データ関連の参照先は doc と推定する。
  // 辺内ラベル宣言があればそのラベルで実体化する（レーン推定なので出所印は付く）
  const poolIds = new Set(pools.map((pl) => pl.id));
  for (const e of edges) {
    for (const ref of [e.from, e.to] as const) {
      // プール参照(C-51): 黒箱プールの枠そのものをポートにする
      if (!nodeById.has(ref) && poolIds.has(ref)) {
        if (ref === e.from) e.fromPool = ref;
        else e.toPool = ref;
        if (e.kind !== 'msg') {
          diags.push({
            level: 'error', code: 'E-206',
            message: `プール ${ref} に繋げられるのはメッセージ ~> だけ。lax では読み替え`,
          });
          e.kind = 'msg';
          e.mainHint = false;
          e.returnHint = false;
          e.isDefault = false;
          e.isConditional = false;
        }
        continue;
      }
      if (!nodeById.has(ref)) {
        const other = ref === e.from ? e.to : e.from;
        const anchor = nodeById.get(other);
        const lane = anchor?.lane ?? lanes[0]?.id ?? ensureLane('？', '？', 0).id;
        const kind = e.kind === 'assoc' ? 'doc' : 'task';
        const inline = inlineLabels.get(ref);
        diags.push({
          level: 'warning', code: inline ? 'W-103' : 'W-102',
          message: inline
            ? `辺内宣言 ${ref}[${inline.label}] を ${kind} としてレーン ${lane} に実体化（レーン推定・要確認）`
            : `未宣言ノード ${ref} を ${kind} としてレーン ${lane} に自動実体化（要確認）`,
          line: inline?.line,
        });
        const node: IrNode = {
          id: ref, kind, label: inline?.label ?? ref, lane,
          declIndex: declIndex++, provisional: true, synthetic: false,
        };
        nodes.push(node);
        nodeById.set(ref, node);
      }
    }
  }
  // 宣言済みノードへの辺内ラベルは照合だけ行う
  for (const [ref, inline] of inlineLabels) {
    const n = nodeById.get(ref);
    if (n && !n.provisional && n.label !== inline.label) {
      diags.push({
        level: 'warning', code: 'W-104', line: inline.line,
        message: `辺内ラベル ${ref}[${inline.label}] は宣言 [${n.label}] と不一致。宣言を優先`,
      });
    }
  }

  // シーケンスは doc に接続できない（BPMN）。lax はデータ関連に読み替える
  for (const e of edges) {
    if (e.kind !== 'seq') continue;
    const fk = nodeById.get(e.from)?.kind;
    const tk = nodeById.get(e.to)?.kind;
    const touchesDoc = (fk !== undefined && isDocLike(fk)) || (tk !== undefined && isDocLike(tk));
    if (touchesDoc) {
      diags.push({
        level: 'error', code: 'E-203',
        message: `シーケンス ${e.from} -> ${e.to} が doc に接続。lax ではデータ関連 -.-> に読み替え`,
      });
      e.kind = 'assoc';
      e.mainHint = false;
      e.returnHint = false;
      e.isDefault = false;
      e.isConditional = false;
      e.assocKind = e.assocKind ?? 'data';
    }
  }

  // プール間規則(C-60): シーケンスはプールを越えない。メッセージはプール間だけ。
  // lax は読み替えて描き続ける(C-15)。プール無し図では全ノードが同一(暗黙)プールなので
  // メッセージは常にシーケンスに読み替えられる
  {
    const poolOf = (nid: string) => {
      if (poolIds.has(nid)) return nid;
      const n = nodeById.get(nid);
      return n ? laneById.get(n.lane)?.pool : undefined;
    };
    for (const e of edges) {
      if (e.fromPool || e.toPool) continue; // プール参照は上で検証済み
      if (e.kind === 'seq' && poolOf(e.from) !== poolOf(e.to)) {
        diags.push({
          level: 'error', code: 'E-204',
          message: `シーケンス ${e.from} -> ${e.to} がプールを越えている。lax ではメッセージ ~> に読み替え`,
        });
        e.kind = 'msg';
        e.mainHint = false;
        e.returnHint = false;
        e.isDefault = false;
        e.isConditional = false;
      } else if (e.kind === 'msg' && poolOf(e.from) === poolOf(e.to)) {
        diags.push({
          level: 'error', code: 'E-205',
          message: `メッセージ ${e.from} ~> ${e.to} が同一プール内。lax ではシーケンス -> に読み替え`,
        });
        e.kind = 'seq';
      }
    }

    // Message Flow は通信の相手を表す。Gateway やデータ成果物は送受信主体ではない。
    // lax では描画を残して修正箇所を可視化し、strict では W-207 を E-207 へ昇格する。
    for (const e of edges) {
      if (e.kind !== 'msg') continue;
      const fromNode = e.fromPool ? undefined : nodeById.get(e.from);
      const toNode = e.toPool ? undefined : nodeById.get(e.to);
      const invalidFrom = fromNode !== undefined && (
        isGatewayKind(fromNode.kind) || isDocLike(fromNode.kind) ||
        (isEventKind(fromNode.kind) && !isMessageEventEndpoint(fromNode, 'send'))
      );
      const invalidTo = toNode !== undefined && (
        isGatewayKind(toNode.kind) || isDocLike(toNode.kind) ||
        (isEventKind(toNode.kind) && !isMessageEventEndpoint(toNode, 'receive'))
      );
      if (!invalidFrom && !invalidTo) continue;
      const endpoints = [invalidFrom ? e.from : undefined, invalidTo ? e.to : undefined]
        .filter((id): id is string => id !== undefined)
        .join(', ');
      diags.push({
        level: 'warning', code: 'W-207',
        message: `メッセージ ${e.from} ~> ${e.to} の端点 ${endpoints} は送受信主体でない。task または message event で送受信を表す`,
      });
    }

    // プール帯は連続でなければならない: レーンをプールの初出順に安定に並べ替える
    if (pools.length > 0) {
      const poolOrder = new Map<string | undefined, number>();
      for (const l of lanes) {
        if (!poolOrder.has(l.pool)) poolOrder.set(l.pool, poolOrder.size);
      }
      lanes.sort((a, b) => poolOrder.get(a.pool)! - poolOrder.get(b.pool)! || a.declIndex - b.declIndex);
    }
  }

  // 黒箱プール(レーン無し)は帯そのものをレーンとして合成する(C-51)
  for (const pl of pools) {
    if (!lanes.some((l) => l.pool === pl.id)) {
      const id = laneById.has(pl.id) ? uniqueId(pl.id, laneById) : pl.id;
      const lane: IrLane = { id, label: pl.label, pool: pl.id, blackbox: true, declIndex: pl.declIndex };
      lanes.push(lane);
      laneById.set(id, lane);
    }
  }
  if (pools.length > 0) {
    const poolOrder2 = new Map<string | undefined, number>();
    for (const l of lanes.slice().sort((a, b) => a.declIndex - b.declIndex)) {
      if (!poolOrder2.has(l.pool)) poolOrder2.set(l.pool, poolOrder2.size);
    }
    lanes.sort((a, b) => poolOrder2.get(a.pool)! - poolOrder2.get(b.pool)! || a.declIndex - b.declIndex);
  }

  if (lanes.length === 0) {
    diags.push({ level: 'error', code: 'E-008', message: 'レーンが一つもない。lax ではレーン「？」を補う' });
    ensureLane('？', '？', 0);
  }

  // 非ゲートウェイ起点の条件ラベルは Conditional Sequence Flow（ミニ菱形）。
  // ゲートウェイの条件はラベルのみ。Default Flow とは独立。
  for (const e of edges) {
    if (e.kind !== 'seq' || !e.label) continue;
    const src = nodeById.get(e.from);
    if (src && !isGatewayKind(src.kind)) e.isConditional = true;
  }

  const ir: Ir = { id: flowId, title, orientation, pools, lanes, nodes, edges };
  diags.push(...validateIr(ir));
  return { ir, diagnostics: diags };
}

function parseScopedName(text: string): { id: string; label: string; hasExplicitLabel: boolean } {
  const match = /^([^\s\[\]]+)\[(.*)\]$/u.exec(text);
  return match
    ? { id: match[1]!, label: match[2]!, hasExplicitLabel: true }
    : { id: text, label: text, hasExplicitLabel: false };
}

function isMessageEventEndpoint(node: IrNode, direction: 'send' | 'receive'): boolean {
  const messageTrigger = node.subtype === 'message' || node.subtype === 'multiple' || node.subtype === 'parallelMultiple';
  if (!messageTrigger) return false;
  if (direction === 'receive') {
    return node.kind === 'start' || node.kind === 'boundary' || (node.kind === 'mid' && node.eventThrow !== true);
  }
  return node.kind === 'end' || (node.kind === 'mid' && node.eventThrow === true);
}

function classifyArrow(arrow: string): {
  kind: IrEdge['kind']; mainHint: boolean; isDefault?: boolean; returnHint?: boolean; assocKind?: AssocKind;
} {
  switch (arrow) {
    case '-.->': return { kind: 'assoc', mainHint: false, assocKind: 'data' };
    case '-.-': return { kind: 'assoc', mainHint: false, assocKind: 'undirected' };
    case '..>': return { kind: 'assoc', mainHint: false, assocKind: 'directed' };
    case '<..>': return { kind: 'assoc', mainHint: false, assocKind: 'both' };
    case '->/': return { kind: 'seq', mainHint: false, isDefault: true };
    case '->>': return { kind: 'seq', mainHint: false, returnHint: true };
    case '=>': return { kind: 'seq', mainHint: true };
    case '~>': return { kind: 'msg', mainHint: false };
    default: return { kind: 'seq', mainHint: false };
  }
}

function uniqueId(base: string, taken: Map<string, unknown>): string {
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** `#` はラベル `[...]` の外側だけで行コメントを開始する。 */
function stripComment(line: string): string {
  let bracketDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '#' && bracketDepth === 0) return line.slice(0, i);
  }
  return line;
}
