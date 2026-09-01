// P0: 正規化。レイアウトの前に行うグラフ書き換えと選挙（C-21, C-22, C-25）。
//
// ここで行うこと（全て決定的・全て report に可視化）:
//   1. 戻り辺の選挙: 既定は「循環を作る辺」= DFS 後退辺（訪問順は宣言順）。
//      当初の「宣言順逆行」規則は棄却した。この DSL の宣言順はレーン別（組織軸）であり
//      時間軸ではないため、前向きの合流辺を誤って戻り辺に選挙する（fuzz が検出）。
//      循環を作る辺だけが戻り辺であり、合流（ダイヤモンド）は前向きに描く。
//      ->> ヒントはその辺だけを戻りに固定する。残る循環は同じ DFS。向きと接続は変えない。
//   2. 単出化: 非ゲートウェイの複数出辺に XOR split を挿入（意味の推定なので出所印つき。strict ではエラー）
//   3. 単入化: 非ゲートウェイの複数入辺に XOR join を挿入（BPMN の暗黙マージと等価なので無印）
//   4. 合流・分岐兼務ゲートウェイを join + split に分離
//   5. 開始・終了の補完: 各プールで start / end が一つも無いときだけ補う
//   6. 本流の選挙: 各プールの最初の start から一本。明示 => は終了到達性より優先。
//      => が無ければ、終了へ到達する出辺があればそこに限定し、無条件辺 >
//      同一レーン継続 > 宣言順。Default Flow（->/）は本流ヒントではない。

import { isAttachedBoundary, isGatewayKind } from './bpmn.ts';
import { isDocLike } from './types.ts';
import type { Diagnostic, Ir, NormEdge, NormGraph, NormNode } from './types.ts';

export function normalize(ir: Ir, strict = false): NormGraph {
  const report: Diagnostic[] = [];
  let seq = 0;
  const nodes: NormNode[] = ir.nodes.map((n) => ({ ...n, onSpine: false }));
  let edges: NormEdge[] = ir.edges.map((e) => ({ ...e, isReturn: false, onSpine: false }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const allocateNodeId = (base: string): string => {
    if (!nodeById.has(base)) return base;
    let n = 2;
    while (nodeById.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  };
  const declOf = (id: string) => nodeById.get(id)!.declIndex;
  let nextDecl = Math.max(0, ...nodes.map((n) => n.declIndex + 1), ...edges.map((e) => e.declIndex + 1));

  // ---- 1. 戻り辺の選挙（C-25） ----
  electReturns(nodes, edges, report, strict);

  // ---- 2. 単出化（シーケンスのみ。データ関連と文書類は対象外） ----
  for (const n of [...nodes]) {
    if (isGatewayKind(n.kind) || isDocLike(n.kind) || isAttachedBoundary(n)) continue;
    const outs = edges.filter((e) => e.from === n.id && e.kind === 'seq');
    if (outs.length <= 1) continue;
    const msg = `${n.id} に複数出辺。分岐種別が未指定（C-13）`;
    if (strict) {
      report.push({ level: 'error', code: 'E-130', message: `${msg}。xor / and を明示せよ` });
      continue;
    }
    const gwId = allocateNodeId(`x_s_${n.id}`);
    const gw: NormNode = {
      id: gwId, kind: 'xor', label: '', lane: n.lane,
      declIndex: nextDecl++, provisional: true, synthetic: true, onSpine: false,
    };
    nodes.push(gw);
    nodeById.set(gw.id, gw);
    for (const e of outs) e.from = gw.id;
    edges.push({
      id: `e_syn_${gw.id}`, kind: 'seq', from: n.id, to: gw.id, mainHint: false,
      declIndex: nextDecl++, provisional: true, synthetic: true, isReturn: false, onSpine: false,
    });
    report.push({ level: 'warning', code: 'N-130', message: `${msg}。XOR split ${gw.id} を仮挿入（出所印つき・要確認）` });
  }

  // ---- 3. 単入化（シーケンスのみ） ----
  for (const n of [...nodes]) {
    if (isGatewayKind(n.kind) || isDocLike(n.kind) || isAttachedBoundary(n)) continue;
    const ins = edges.filter((e) => e.to === n.id && e.kind === 'seq');
    if (ins.length <= 1) continue;
    const gwId = allocateNodeId(`x_j_${n.id}`);
    const gw: NormNode = {
      id: gwId, kind: 'xor', label: '', lane: n.lane,
      declIndex: nextDecl++, provisional: false, synthetic: true, onSpine: false,
    };
    nodes.push(gw);
    nodeById.set(gw.id, gw);
    for (const e of ins) e.to = gw.id;
    edges.push({
      id: `e_syn_${gw.id}`, kind: 'seq', from: gw.id, to: n.id, mainHint: false,
      declIndex: nextDecl++, provisional: false, synthetic: true, isReturn: false, onSpine: false,
    });
    report.push({ level: 'info', code: 'N-210', message: `${n.id} の暗黙合流を XOR join ${gw.id} に昇格（意味保存）` });
  }

  // ---- 4. 合流・分岐兼務ゲートウェイを分離 ----
  // 一つのダイヤに入出を集中させると、戻り入力と下側分岐が同じ頂点を奪い合う。
  // 入力側へ同種 join を前置し、元ノードは split として残す（到達意味は不変）。
  for (const n of [...nodes]) {
    if (n.kind !== 'xor' && n.kind !== 'and') continue;
    const ins = edges.filter((e) => e.to === n.id && e.kind === 'seq');
    const outs = edges.filter((e) => e.from === n.id && e.kind === 'seq');
    if (ins.length <= 1 || outs.length <= 1) continue;
    const joinId = allocateNodeId(`x_j_${n.id}`);
    const join: NormNode = {
      // event-based gateway は分岐専用なので、合流側は通常 XOR merge とする。
      id: joinId, kind: n.kind, subtype: n.subtype === 'event' ? undefined : n.subtype,
      label: '', lane: n.lane,
      declIndex: nextDecl++, provisional: false, synthetic: true, onSpine: false,
    };
    nodes.push(join);
    nodeById.set(join.id, join);
    for (const e of ins) e.to = join.id;
    edges.push({
      id: `e_syn_${join.id}`, kind: 'seq', from: join.id, to: n.id, mainHint: false,
      declIndex: nextDecl++, provisional: false, synthetic: true, isReturn: false, onSpine: false,
    });
    report.push({ level: 'info', code: 'N-211', message: `合流・分岐兼務 ${n.id} を ${join.id} + ${n.id} に分離` });
  }

  // ---- 5. 開始・終了の補完（シーケンスの流れだけを見る。doc は対象外） ----
  const poolOfLane = new Map(ir.lanes.map((l) => [l.id, l.pool]));
  const processPools: Array<string | undefined> = [];
  for (const n of nodes) {
    if (isDocLike(n.kind)) continue;
    const pool = poolOfLane.get(n.lane);
    if (!processPools.includes(pool)) processPools.push(pool);
  }
  const inPool = (n: NormNode, pool: string | undefined) => poolOfLane.get(n.lane) === pool;
  for (const pool of processPools) {
    const processNodes = nodes.filter((n) => !isDocLike(n.kind) && !isAttachedBoundary(n) && inPool(n, pool));
    const hasExplicitStart = processNodes.some((n) => n.kind === 'start' && !n.synthetic);
    const hasExplicitEnd = processNodes.some((n) => n.kind === 'end' && !n.synthetic);
    const isOutOfBandHandler = (n: NormNode) =>
      (n.kind === 'task' && n.subtype === 'eventSub') || n.compensation === true ||
      (n.kind === 'mid' && n.subtype === 'link');

    if (hasExplicitStart) {
      const extraSources = processNodes.filter(
        (n) => n.kind !== 'start' && !isOutOfBandHandler(n) &&
          !edges.some((e) => e.to === n.id && e.kind === 'seq'),
      );
      for (const source of extraSources) {
        report.push({
          level: strict ? 'error' : 'warning',
          code: strict ? 'E-223' : 'W-223',
          message: `${source.id} は明示した開始イベントとは別の、シーケンス入辺を持たない入口。開始条件または前段のシーケンスを明示せよ`,
        });
      }
    }

    if (!hasExplicitStart) {
      const sources = processNodes.filter(
        (n) => !edges.some((e) => e.to === n.id && e.kind === 'seq'),
      );
      for (const s of sources) {
        if (edges.some((e) => e.to === s.id && e.kind === 'msg')) {
          report.push({
            level: 'warning', code: 'W-234',
            message: `${s.id} は外部メッセージだけを入口にするため無印 start を補完する。開始受信なら start(message)、途中の応答待ちなら catch(message) または task(receive) を明示する`,
          });
        }
        const stId = allocateNodeId(`s_a_${s.id}`);
        const st: NormNode = {
          id: stId, kind: 'start', label: '', lane: s.lane,
          declIndex: -1, provisional: false, synthetic: true, onSpine: false,
        };
        nodes.push(st);
        nodeById.set(st.id, st);
        edges.push({
          id: `e_syn_${st.id}`, kind: 'seq', from: st.id, to: s.id, mainHint: false,
          declIndex: nextDecl++, provisional: false, synthetic: true, isReturn: false, onSpine: false,
        });
        report.push({ level: 'warning', code: 'W-220', message: `開始イベント ${st.id} を ${s.id} の前に補完。開始条件を確認する` });
      }
    }
    const updatedProcessNodes = nodes.filter((n) => !isDocLike(n.kind) && !isAttachedBoundary(n) && inPool(n, pool));
    if (hasExplicitEnd) {
      const extraSinks = updatedProcessNodes.filter(
        (n) => n.kind !== 'end' && !isOutOfBandHandler(n) &&
          !edges.some((e) => e.from === n.id && e.kind === 'seq'),
      );
      for (const sink of extraSinks) {
        report.push({
          level: strict ? 'error' : 'warning',
          code: strict ? 'E-224' : 'W-224',
          message: `${sink.id} は明示した終了イベントとは別の、シーケンス出辺を持たない出口。終了結果または後段のシーケンスを明示せよ`,
        });
      }
    }

    if (!hasExplicitEnd) {
      const sinks = updatedProcessNodes.filter(
        (n) => n.kind !== 'start' && !edges.some((e) => e.from === n.id && e.kind === 'seq'),
      );
      for (const t of sinks) {
        const enId = allocateNodeId(`e_a_${t.id}`);
        const en: NormNode = {
          id: enId, kind: 'end', label: '', lane: t.lane,
          declIndex: nextDecl++, provisional: false, synthetic: true, onSpine: false,
        };
        nodes.push(en);
        nodeById.set(en.id, en);
        edges.push({
          id: `e_syn_${en.id}`, kind: 'seq', from: t.id, to: en.id, mainHint: false,
          declIndex: nextDecl++, provisional: false, synthetic: true, isReturn: false, onSpine: false,
        });
        report.push({ level: 'warning', code: 'W-221', message: `終了イベント ${en.id} を ${t.id} の後に補完。終了結果を確認する` });
      }
    }
  }

  // ---- 6. 本流の選挙（C-22） ----
  // 協調図の時間軸はプールごとに独立している。最初のプールだけを太くすると、
  // 他プールの通常経路まで代替行へ落ち、通信線と例外線が不必要に交差する。
  const starts = nodes.filter((n) => n.kind === 'start').sort((a, b) => a.declIndex - b.declIndex);
  const reachesEnd = nodesReachingEnd(nodes, edges);
  const firstByPool = new Map<string, NormNode>();
  for (const start of starts) {
    const pool = poolOfLane.get(start.lane) ?? '';
    if (!firstByPool.has(pool)) firstByPool.set(pool, start);
  }
  for (const [pool, first] of firstByPool) {
    let cur = first;
    const visited = new Set<string>();
    const path: string[] = [];
    while (!visited.has(cur.id)) {
      visited.add(cur.id);
      path.push(cur.id);
      cur.onSpine = true;
      const outs = edges
        .filter((e) => e.from === cur.id && !e.isReturn && e.kind === 'seq')
        .sort((a, b) => a.declIndex - b.declIndex);
      if (outs.length === 0) break;
      const completing = outs.filter((e) => reachesEnd.has(e.to));
      const candidates = completing.length > 0 ? completing : outs;
      const chosen = outs.find((e) => e.mainHint) ??
        candidates.find((e) => e.label === undefined) ??
        candidates.find((e) => nodeById.get(e.to)?.lane === cur.lane) ??
        candidates[0]!;
      chosen.onSpine = true;
      cur = nodeById.get(chosen.to)!;
    }
    report.push({
      level: 'info', code: 'N-222',
      message: `本流を選挙(${pool || 'default'}): ${path.join(' -> ')}`,
    });
  }

  return { id: ir.id, title: ir.title, orientation: ir.orientation, pools: ir.pools, lanes: ir.lanes, nodes, edges, report };
}

/** 戻り辺を除くシーケンスだけを逆向きにたどり、明示・補完 end へ到達できるノードを求める。 */
function nodesReachingEnd(nodes: NormNode[], edges: NormEdge[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'seq' || edge.isReturn || edge.fromPool || edge.toPool) continue;
    const sources = incoming.get(edge.to) ?? [];
    sources.push(edge.from);
    incoming.set(edge.to, sources);
  }
  const reachable = new Set(nodes.filter((node) => node.kind === 'end').map((node) => node.id));
  const queue = [...reachable];
  for (let i = 0; i < queue.length; i++) {
    for (const source of incoming.get(queue[i]!) ?? []) {
      if (reachable.has(source)) continue;
      reachable.add(source);
      queue.push(source);
    }
  }
  return reachable;
}

function isLayeringSeq(e: NormEdge, docIds: Set<string>): boolean {
  if (e.fromPool || e.toPool) return false;
  if (e.kind === 'msg' || (e.kind === 'assoc' && !docIds.has(e.to))) return false;
  return true;
}

function reaches(from: string, to: string, outAdj: Map<string, NormEdge[]>): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const e of outAdj.get(queue[i]!) ?? []) {
      if (seen.has(e.to)) continue;
      if (e.to === to) return true;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return false;
}

/**
 * 戻り辺の選挙: 既定は DFS 後退辺だけを戻りとする。
 * ->> ヒントはその辺を先に固定し、残るグラフだけを同じ DFS が処理する。
 * 根は入辺の無いノード（宣言順）、残りは宣言順。出辺の走査も宣言順。決定的。
 *
 * 選挙が見るグラフはレイヤリング（P2）が拘束するグラフと同一でなければならない:
 * シーケンス辺 ＋ doc へ入るデータ関連。メッセージフローはプール内時間軸を進めない。
 * doc から読むデータ関連も列を拘束しない
 * （文書は状態であって出来事ではない）ので、そこを通る循環は戻り辺を生まない。
 * ずらすと「右向きの戻り辺」が生まれる（fuzz が検出）。
 */
function electReturns(nodes: NormNode[], edges: NormEdge[], report: Diagnostic[], strict: boolean): void {
  const docIds = new Set(nodes.filter((n) => isDocLike(n.kind)).map((n) => n.id));
  const layering = edges.filter((e) => isLayeringSeq(e, docIds) && nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
  const fullAdj = new Map<string, NormEdge[]>();
  for (const n of nodes) fullAdj.set(n.id, []);
  for (const e of layering.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    fullAdj.get(e.from)?.push(e);
  }
  for (const e of edges) {
    if (!e.returnHint) continue;
    const ok = e.kind === 'seq' && !e.fromPool && !e.toPool && fullAdj.has(e.from) && reaches(e.to, e.from, fullAdj);
    if (!ok) {
      report.push({
        level: strict ? 'error' : 'warning',
        code: strict ? 'E-254' : 'W-254',
        message: `戻りヒント ->> は循環を作るシーケンスにだけ使える: ${e.from} -> ${e.to}`,
      });
      continue;
    }
    e.isReturn = true;
    report.push({ level: 'info', code: 'N-251', message: `辺 ${e.from} -> ${e.to} を戻り辺と固定（->> ヒント）` });
  }

  const outAdj = new Map<string, NormEdge[]>();
  for (const n of nodes) outAdj.set(n.id, []);
  for (const e of layering.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    if (e.isReturn) continue;
    outAdj.get(e.from)?.push(e);
  }
  const hasIn = new Set(edges.map((e) => e.to));
  const roots = [
    ...nodes.filter((n) => !hasIn.has(n.id)).sort((a, b) => a.declIndex - b.declIndex),
    ...nodes.filter((n) => hasIn.has(n.id)).sort((a, b) => a.declIndex - b.declIndex),
  ];

  const color = new Map<string, 'gray' | 'black'>();
  for (const root of roots) {
    if (color.has(root.id)) continue;
    // 反復 DFS（フレーム = ノードと出辺カーソル）
    const stack: Array<{ id: string; i: number }> = [{ id: root.id, i: 0 }];
    color.set(root.id, 'gray');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const outs = outAdj.get(frame.id)!;
      if (frame.i >= outs.length) {
        color.set(frame.id, 'black');
        stack.pop();
        continue;
      }
      const e = outs[frame.i++]!;
      const c = color.get(e.to);
      if (c === 'gray') {
        e.isReturn = true;
        report.push({ level: 'info', code: 'N-250', message: `辺 ${e.from} -> ${e.to} を戻り辺と選挙（循環を作る辺）` });
      } else if (c === undefined) {
        color.set(e.to, 'gray');
        stack.push({ id: e.to, i: 0 });
      }
    }
  }
}
