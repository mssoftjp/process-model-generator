// P2: 表配置。ノードに (レーン, 行, 列) の離散セルを与える。座標はまだ無い。
//
// - 列: 戻り辺を除いた DAG 上の最長路レイヤリング（トポロジのみ。距離を見ない）
// - 行: 本流は各レーンの行 0（背骨行）。それ以外は「チェーン」単位で、
//        列区間 [c0, c1] を予約しながら最小の空き行に詰める。
//   チェーンが区間を予約するので、同一行の直進辺が他ノードを貫くことは構築上ない。
//   「層とレーンのどちらを先に固定するか」（C-33）はここで問いごと消える。

import { isAttachedBoundary } from './bpmn.ts';
import { isDocLike } from './types.ts';
import type { NormEdge, NormGraph, NormNode, Placement } from './types.ts';

/**
 * 列を拘束するグラフ: シーケンス辺 ＋ doc へ入るデータ関連。
 * メッセージフローは参加者間の通信であり、各プール内部の時間軸を進めない。
 * ここへ含めるとプール間の往復が一つの巨大な直列工程になり、図が横へ間延びする。
 * 文書は時間軸上の出来事ではなく状態なので、doc から読む関連は
 * タスクの列を押さない。戻り辺の選挙(P0)・レイヤリング・チェーン連結は
 * 全てこの同じグラフを見る。ずらすと右向き戻り辺やセル衝突が生まれる。
 */
export function isLayeringEdge(e: NormEdge, docIds: Set<string>): boolean {
  if (e.fromPool || e.toPool) return false; // プール帯は全幅なので列を拘束しない
  return !e.isReturn && (e.kind === 'seq' || (e.kind === 'assoc' && docIds.has(e.to)));
}

export function place(g: NormGraph): Placement {
  const docIds = new Set(g.nodes.filter((n) => isDocLike(n.kind)).map((n) => n.id));
  const col = layerColumns(g, docIds);
  pinBoundaryColumns(g, col, docIds);
  pullReadableDocColumns(g, col, docIds);
  keepDocsOffForeignSpine(g, col, docIds);
  snapStoresToLaneWriter(g, col);
  alignMessageStarts(g, col);
  const { row, laneRows, reserved } = assignRows(g, col, docIds);
  const maxCol = Math.max(0, ...[...col.values()]);
  return { col, row, laneRows, maxCol, reserved };
}

/** 境界イベントは対象 Activity と同じ列に張り付く。出辺の下流はそこから再レイヤする。 */
function pinBoundaryColumns(g: NormGraph, col: Map<string, number>, docIds: Set<string>): void {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const fwd = g.edges.filter((e) => isLayeringEdge(e, docIds));
  for (let iter = 0; iter < g.nodes.length + 2; iter++) {
    let changed = false;
    for (const n of g.nodes) {
      if (!isAttachedBoundary(n)) continue;
      const hc = col.get(n.attachedTo!);
      if (hc === undefined) continue;
      if (col.get(n.id) !== hc) {
        col.set(n.id, hc);
        changed = true;
      }
    }
    for (const e of fwd) {
      const to = nodeById.get(e.to);
      if (to && isAttachedBoundary(to)) continue;
      const next = (col.get(e.from) ?? 0) + 1;
      if (next > (col.get(e.to) ?? 0)) {
        col.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/**
 * 読み専用文書、または単一の書き手と読み手だけを持つ文書を、最初の読み手の
 * 直前へ寄せる。複数関係・循環・工程辺へ参加する文書は動かさない。
 * レーン・他ノードの列は触らない。
 */
function pullReadableDocColumns(g: NormGraph, col: Map<string, number>, docIds: Set<string>): void {
  for (const n of g.nodes) {
    if (!docIds.has(n.id)) continue;
    if (g.edges.some((e) => e.kind !== 'assoc' && (e.from === n.id || e.to === n.id))) continue;
    const readerCols = g.edges
      .filter((e) => e.kind === 'assoc' && e.from === n.id)
      .flatMap((e) => col.has(e.to) ? [col.get(e.to)!] : []);
    const writerCols = g.edges
      .filter((e) => e.kind === 'assoc' && e.to === n.id)
      .flatMap((e) => col.has(e.from) ? [col.get(e.from)!] : []);
    if (readerCols.length === 0) continue;
    const target = writerCols.length === 0
      ? Math.max(0, Math.min(...readerCols) - 1)
      : writerCols.length === 1 && readerCols.length === 1 && readerCols[0]! > writerCols[0]! + 1
        ? readerCols[0]! - 1
        : undefined;
    if (target !== undefined && target > (col.get(n.id) ?? 0)) col.set(n.id, target);
  }
}

/**
 * 文書が次工程のゲートウェイやタスクと同じ列に乗ると、関連線が本流を横切る。
 * 書き手自身の列へ戻し、本流ノードの横の余剰行へ置く。
 */
function keepDocsOffForeignSpine(g: NormGraph, col: Map<string, number>, docIds: Set<string>): void {
  const writersOf = (id: string) =>
    new Set(g.edges.filter((e) => e.kind === 'assoc' && e.to === id).map((e) => e.from));
  const foreignSpine = (lane: string, c: number, ignore: Set<string>) =>
    g.nodes.some((n) =>
      n.onSpine && n.lane === lane && col.get(n.id) === c && !ignore.has(n.id) &&
      !isDocLike(n.kind) && n.kind !== 'start' && n.kind !== 'end');
  for (const n of g.nodes) {
    if (n.kind !== 'doc' || !docIds.has(n.id)) continue;
    const writers = writersOf(n.id);
    if (writers.size === 0) continue;
    if (g.edges.some((e) => e.kind === 'assoc' && e.from === n.id)) continue;
    const here = col.get(n.id)!;
    if (!foreignSpine(n.lane, here, writers)) continue;
    const home = Math.max(...[...writers].map((id) => col.get(id) ?? 0));
    if (home !== here) col.set(n.id, home);
  }
}

/**
 * ストアは宣言レーンの書き手の横へ戻す。後工程の別レーン書き手に列を引っ張られると、
 * 図の端で破線が横一列に積み上がる。シーケンスに乗るストアと、文書からの書き戻しは
 * 列を動かさない（W-252）。前へは進めず、後ろへだけ戻す。
 */
function snapStoresToLaneWriter(g: NormGraph, col: Map<string, number>): void {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  for (const n of g.nodes) {
    if (n.kind !== 'store') continue;
    // 工程への関連出があるストアは連鎖の途中。列を戻すと順方向の関連がノードを貫く。
    if (
      g.edges.some((e) =>
        e.kind === 'assoc' && e.from === n.id &&
        !isDocLike(nodeById.get(e.to)?.kind ?? 'doc')
      )
    ) continue;
    const sameLane = g.edges
      .filter((e) => e.kind === 'assoc' && e.to === n.id)
      .map((e) => nodeById.get(e.from))
      .filter((w): w is NormNode => w !== undefined && w.lane === n.lane && !isDocLike(w.kind));
    if (sameLane.length === 0) continue;
    const home = Math.max(...sameLane.map((w) => col.get(w.id) ?? 0));
    const here = col.get(n.id) ?? 0;
    if (home < here) col.set(n.id, home);
  }
}

/**
 * メッセージ開始の整列。各プールの時間軸は独立で、メッセージは列を進めない(S-15)。
 * ただし「注文が届いた時点で仕入先の工程が始まる」というトリガのタイミングは、
 * 開始イベントを送信元の列に揃えると読み取れる。BPMN も協調図の慣習として、
 * メッセージ開始イベントを送信活動の下に置く。
 *
 * 規則: プール P の開始イベント(合成開始の直後ノードを含む)へ他プールのノードから
 * メッセージが入るとき、開始の列がその送信元の列より手前なら、P の全ノードを差分だけ
 * 右へ平行移動する。平行移動なので P 内部の配置は変わらない。
 * 送信元プールを先に確定するため、プール間のトリガ関係を位相順に処理し、
 * 循環するプール(互いに開始を送り合う)は動かさない。
 */
function alignMessageStarts(g: NormGraph, col: Map<string, number>): void {
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const poolOf = (id: string) => {
    const n = nodeById.get(id);
    return n ? poolOfLane.get(n.lane) : undefined;
  };
  // 開始トリガ: 開始イベント、またはその直後のノード(受信タスク・受信イベント)へ入るメッセージ。
  // 「注文待ち → 注文書を受信」のように、無印の開始の次で最初の通信を受ける形が多い。
  // 直後ノードは受信要素(task(receive) / mid(message))に限る。返信を受ける普通のタスクまで
  // 含めると往復がトリガの循環になり、整列が働かなくなる。
  const startLike = new Set<string>();
  const receiving = (id: string) => {
    const n = nodeById.get(id);
    return !!n && (
      (n.kind === 'task' && n.subtype === 'receive') ||
      (n.kind === 'mid' && n.subtype === 'message' && n.eventThrow !== true)
    );
  };
  for (const n of g.nodes) {
    if (n.kind !== 'start') continue;
    startLike.add(n.id);
    for (const e of g.edges) if (e.kind === 'seq' && e.from === n.id && receiving(e.to)) startLike.add(e.to);
  }
  const triggers: Array<{ from: string; to: string; fromPool: string; toPool: string }> = [];
  for (const e of g.edges) {
    if (e.kind !== 'msg' || e.fromPool || e.toPool || !startLike.has(e.to)) continue;
    const fp = poolOf(e.from);
    const tp = poolOf(e.to);
    if (fp === undefined || tp === undefined || fp === tp) continue;
    triggers.push({ from: e.from, to: e.to, fromPool: fp, toPool: tp });
  }
  if (triggers.length === 0) return;
  // プール間トリガ関係の位相順(Kahn)。残ったプールは循環に属するので動かさない
  const pools = [...new Set(triggers.flatMap((t) => [t.fromPool, t.toPool]))];
  const indeg = new Map(pools.map((p) => [p, 0]));
  for (const t of triggers) indeg.set(t.toPool, (indeg.get(t.toPool) ?? 0) + 1);
  const order: string[] = [];
  const queue = pools.filter((p) => indeg.get(p) === 0).sort();
  while (queue.length > 0) {
    const p = queue.shift()!;
    order.push(p);
    for (const t of triggers.filter((t) => t.fromPool === p)) {
      const d = (indeg.get(t.toPool) ?? 0) - 1;
      indeg.set(t.toPool, d);
      if (d === 0) queue.push(t.toPool);
    }
    queue.sort();
  }
  for (const pool of order) {
    let shift = 0;
    for (const t of triggers) {
      if (t.toPool !== pool || !order.includes(t.fromPool)) continue;
      shift = Math.max(shift, (col.get(t.from) ?? 0) - (col.get(t.to) ?? 0));
    }
    if (shift <= 0) continue;
    // プールの全ノードを一律に動かす。文書だけ残すとチェーン連結が前提にする列の単調性が
    // 壊れ、同じセルに 2 ノードが乗る(fuzz seed 1798)。プール越えの関連が逆向きになる
    // ことはあるが、プール間の時間軸は独立なので順序の不変条件は元々成り立たない。
    for (const n of g.nodes) {
      if (poolOfLane.get(n.lane) !== pool) continue;
      col.set(n.id, (col.get(n.id) ?? 0) + shift);
    }
  }
}

function layerColumns(g: NormGraph, docIds: Set<string>): Map<string, number> {
  const col = new Map<string, number>();
  const fwd = g.edges.filter((e) => isLayeringEdge(e, docIds));
  const indeg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of fwd) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);

  const queue = g.nodes
    .filter((n) => (indeg.get(n.id) ?? 0) === 0)
    .sort((a, b) => a.declIndex - b.declIndex);
  for (const n of queue) col.set(n.id, 0);
  let qi = 0;
  while (qi < queue.length) {
    const n = queue[qi++]!;
    for (const e of fwd) {
      if (e.from !== n.id) continue;
      const c = Math.max(col.get(e.to) ?? 0, col.get(n.id)! + 1);
      col.set(e.to, c);
      const d = indeg.get(e.to)! - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(g.nodes.find((x) => x.id === e.to)!);
    }
  }
  // P0 が DAG を保証するので全ノードに列が付くはずだが、防御として残りを 0 に
  for (const n of g.nodes) if (!col.has(n.id)) col.set(n.id, 0);
  return col;
}

interface Chain {
  nodes: NormNode[];
  lane: string;
  c0: number;
  c1: number;
  firstDecl: number;
}

function assignRows(g: NormGraph, col: Map<string, number>, docIds: Set<string>) {
  const row = new Map<string, number>();
  const laneRows = new Map<string, number>();
  const reserved = new Map<string, Array<{ row: number; c0: number; c1: number }>>();
  for (const lane of g.lanes) reserved.set(lane.id, []);

  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  // チェーンの連結は列を拘束するグラフだけで判定する(列の単調性が要る)
  const outsOf = (id: string) => g.edges.filter((e) => e.from === id && isLayeringEdge(e, docIds));
  const insOf = (id: string) => g.edges.filter((e) => e.to === id && isLayeringEdge(e, docIds));

  // --- 本流: 同一レーン連続区間（ラン）ごとに行 0 を予約 ---
  const spineNodes = g.nodes.filter((n) => n.onSpine).sort((a, b) => col.get(a.id)! - col.get(b.id)!);
  const spineHasLane = new Set(spineNodes.map((n) => n.lane));
  let run: NormNode[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const lane = run[0]!.lane;
    const c0 = col.get(run[0]!.id)!;
    const c1 = col.get(run[run.length - 1]!.id)!;
    reserved.get(lane)!.push({ row: 0, c0, c1 });
    for (const n of run) row.set(n.id, 0);
    run = [];
  };
  for (const n of spineNodes) {
    if (run.length > 0 && run[run.length - 1]!.lane !== n.lane) flushRun();
    run.push(n);
  }
  flushRun();

  // --- 非本流: チェーンを組み、小さい行から区間詰め ---
  const chainable = (e: NormEdge): boolean => {
    const u = nodeById.get(e.from)!;
    const v = nodeById.get(e.to)!;
    // 同じ列は1セル1ノード。列を戻した書類を書き手と同じ行へ鎖で落とさない。
    return (
      u.lane === v.lane && !u.onSpine && !v.onSpine &&
      col.get(u.id) !== col.get(v.id) &&
      outsOf(u.id).length === 1 && insOf(v.id).length === 1
    );
  };
  const nextIn = new Map<string, string>(); // chainable リンク
  const prevIn = new Map<string, string>();
  for (const e of g.edges) {
    if (isLayeringEdge(e, docIds) && chainable(e)) {
      nextIn.set(e.from, e.to);
      prevIn.set(e.to, e.from);
    }
  }
  const seen = new Set<string>();
  const chains: Chain[] = [];
  for (const n of g.nodes.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    if (n.onSpine || seen.has(n.id) || isAttachedBoundary(n)) continue;
    let head = n;
    while (prevIn.has(head.id)) head = nodeById.get(prevIn.get(head.id)!)!;
    const members: NormNode[] = [];
    let cur: NormNode | undefined = head;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      members.push(cur);
      cur = nextIn.has(cur.id) ? nodeById.get(nextIn.get(cur.id)!) : undefined;
    }
    chains.push({
      nodes: members,
      lane: head.lane,
      c0: Math.min(...members.map((m) => col.get(m.id)!)),
      c1: Math.max(...members.map((m) => col.get(m.id)!)),
      firstDecl: Math.min(...members.map((m) => m.declIndex)),
    });
  }
  chains.sort((a, b) => a.c0 - b.c0 || a.firstDecl - b.firstDecl);
  // 同じレーン・同じ列で差戻し合流と競合する、複数関連の文書だけ本流行へ先に置く。
  // 注記や単関連のストアまで先に詰めると、受領図のように例外工程が帳票の奥へ沈む。
  const idsOf = (ch: Chain) => new Set(ch.nodes.map((m) => m.id));
  const promotedDoc = (ch: Chain) => {
    if (!ch.nodes.every((m) => m.kind === 'doc')) return false;
    const ids = idsOf(ch);
    return g.edges.filter((e) => e.kind === 'assoc' && (ids.has(e.from) || ids.has(e.to))).length >= 2;
  };
  const overlaps = (a: Chain, b: Chain) => a.lane === b.lane && a.c0 <= b.c1 && b.c0 <= a.c1;
  const joinOrReturn = (ch: Chain) => ch.nodes.some((m) => {
    const seqIns = g.edges.filter((e) => e.kind === 'seq' && e.to === m.id);
    return seqIns.length >= 2 || seqIns.some((e) => e.isReturn);
  });
  for (const doc of chains.filter(promotedDoc).sort((a, b) => a.c0 - b.c0 || a.firstDecl - b.firstDecl)) {
    const docAt = chains.indexOf(doc);
    const processAt = chains.findIndex((ch) =>
      ch !== doc && joinOrReturn(ch) && overlaps(ch, doc));
    if (processAt >= 0 && docAt > processAt) {
      chains.splice(docAt, 1);
      chains.splice(processAt, 0, doc);
    }
  }

  const writeOnlyDoc = (ch: Chain) =>
    ch.nodes.every((m) => m.kind === 'doc') &&
    !g.edges.some((e) => e.kind !== 'assoc' && ch.nodes.some((m) => m.id === e.from || m.id === e.to)) &&
    !g.edges.some((e) => e.kind === 'assoc' && ch.nodes.some((m) => m.id === e.from));
  const lastWriterOf = (ch: Chain) => {
    const writers = [...new Set(
      g.edges.filter((e) => e.kind === 'assoc' && ch.nodes.some((m) => m.id === e.to)).map((e) => e.from),
    )];
    if (writers.length === 0) return '';
    return writers.sort((a, b) => (col.get(b)! - col.get(a)!) || a.localeCompare(b))[0]!;
  };
  // 読み手だけを持つ文書類は、本流の無いレーンでも行 0 に置かない。読み手と同じ行に並ぶと
  // 文書→工程の関連は頂点入りしかなく 3 折れになる。一段下なら行先行 L の 1 折れで済む。
  const readOnlyDoc = (ch: Chain) =>
    ch.nodes.every((m) => isDocLike(m.kind)) &&
    !g.edges.some((e) => ch.nodes.some((m) => m.id === e.to));
  const packed = new Set<Chain>();
  const placeChain = (ch: Chain) => {
    const res = reserved.get(ch.lane)!;
    const startRow = spineHasLane.has(ch.lane) || readOnlyDoc(ch) ? 1 : 0;
    let r = startRow;
    while (res.some((iv) => iv.row === r && iv.c0 <= ch.c1 && ch.c0 <= iv.c1)) r++;
    res.push({ row: r, c0: ch.c0, c1: ch.c1 });
    for (const m of ch.nodes) row.set(m.id, r);
  };
  for (const ch of chains) {
    if (packed.has(ch)) continue;
    const siblings = writeOnlyDoc(ch)
      ? chains.filter((other) =>
        writeOnlyDoc(other) && other.lane === ch.lane && other.c0 === ch.c0 && other.c1 === ch.c1 &&
        lastWriterOf(other) === lastWriterOf(ch))
      : [ch];
    const ordered = siblings.length > 1
      ? siblings.slice().sort((a, b) => b.firstDecl - a.firstDecl)
      : siblings;
    for (const one of ordered) {
      if (packed.has(one)) continue;
      packed.add(one);
      placeChain(one);
    }
  }

  for (const n of g.nodes) {
    if (!isAttachedBoundary(n)) continue;
    const hostRow = n.attachedTo !== undefined ? row.get(n.attachedTo) : undefined;
    row.set(n.id, hostRow ?? 0);
  }

  for (const lane of g.lanes) {
    const rows = g.nodes.filter((n) => n.lane === lane.id).map((n) => row.get(n.id) ?? 0);
    laneRows.set(lane.id, Math.max(0, ...rows) + 1);
  }
  return { row, laneRows, reserved };
}
