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
  alignMessageTiming(g, col, docIds);
  keepDocsOffMessageCorridors(g, col, docIds);
  pullReadableDocColumns(g, col, docIds);
  keepDocsOffForeignSpine(g, col, docIds);
  snapStoresToLaneWriter(g, col);
  pullStartsToSuccessor(g, col);
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
  // 同じ列の相手と通信する書き手の直下(自列)はメッセージの縦回廊(一直線の Z)。文書を戻すと
  // 往復対が一直線を取れず側面経路で交差するので、そのような書き手の列へは戻さない。
  // 相手が別の列なら Z は列中心を使わないので従来どおり戻す(invoice_reception で確認)。
  const nodeCol = (id: string) => col.get(id) ?? -1;
  const communicates = (id: string) =>
    g.edges.some((e) =>
      e.kind === 'msg' && !e.fromPool && !e.toPool && (e.from === id || e.to === id) &&
      nodeCol(e.from === id ? e.to : e.from) === nodeCol(id));
  for (const n of g.nodes) {
    if (n.kind !== 'doc' || !docIds.has(n.id)) continue;
    const writers = writersOf(n.id);
    if (writers.size === 0) continue;
    if (g.edges.some((e) => e.kind === 'assoc' && e.from === n.id)) continue;
    if ([...writers].some(communicates)) continue;
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
 * メッセージの時系列整列(S-15)。各プールの時間軸は独立だが、通信の受信側を送信元より
 * 手前の列に置くと、メッセージが時間を遡って見える。そこで、ノード間メッセージを
 * 「受信側の列 ≥ 送信側の列」という重み 0 の下限制約として層化に加える。
 * L12 が排した「メッセージで列を進める(重み 1)」とは違い、同列(一直線)を許すので
 * 往復が一本の長い直列にはならず、受信側が送信元の直下に揃う。
 *
 * 規則: メッセージを宣言順に一本ずつ制約へ加え、工程辺(重み 1)と合わせた緩和を不動点まで
 * 繰り返す。送信側は動かさない。要求を送った工程自身が返信を受けるような循環(重み 1 を含む
 * 閉路)は収束しないので、回数上限で検出し、その一本だけを制約から外して直前の列へ戻す。
 * 先に宣言した通信が優先される(決定的)。
 */
function alignMessageTiming(g: NormGraph, col: Map<string, number>, docIds: Set<string>): void {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const messages = g.edges
    .filter((e) => e.kind === 'msg' && !e.fromPool && !e.toPool && nodeById.has(e.from) && nodeById.has(e.to))
    .sort((a, b) => a.declIndex - b.declIndex);
  if (messages.length === 0) return;
  const fwd = g.edges.filter((e) => isLayeringEdge(e, docIds) && !isAttachedBoundary(nodeById.get(e.to)!));
  const limit = g.nodes.length + g.edges.length + 2;
  const relax = (active: NormEdge[]): boolean => {
    for (let iter = 0; ; iter++) {
      let changed = false;
      for (const e of active) {
        const need = col.get(e.from) ?? 0;
        if ((col.get(e.to) ?? 0) < need) { col.set(e.to, need); changed = true; }
      }
      for (const e of fwd) {
        const need = (col.get(e.from) ?? 0) + 1;
        if ((col.get(e.to) ?? 0) < need) { col.set(e.to, need); changed = true; }
      }
      // 境界イベントは対象と同じ列に張り付く
      for (const n of g.nodes) {
        if (!isAttachedBoundary(n)) continue;
        const hc = col.get(n.attachedTo!);
        if (hc !== undefined && col.get(n.id) !== hc) { col.set(n.id, hc); changed = true; }
      }
      if (!changed) return true;
      if (iter > limit) return false;
    }
  };
  const active: NormEdge[] = [];
  for (const m of messages) {
    const snapshot = new Map(col);
    active.push(m);
    if (!relax(active)) {
      active.pop();
      for (const [id, c] of snapshot) col.set(id, c);
    }
  }
}

/**
 * 同列の送受信対(時系列整列で揃った一直線の通信)が通る列中心は縦回廊。その経路上のレーン
 * (送信側レーンとそのプール内で回廊側にあるレーン、受信側も同様)に層化された、読み手を
 * 持たない文書・注釈が回廊を塞ぐと、通信が側面経路へ落ちて交差する。そのような文書類は
 * 右隣の列へ逃がす(読み手が無いので列を進めても関連が逆走しない)。
 */
function keepDocsOffMessageCorridors(g: NormGraph, col: Map<string, number>, docIds: Set<string>): void {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const laneIndex = new Map(g.lanes.map((l, i) => [l.id, i]));
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const corridors = new Set<string>(); // `${lane}:${col}`
  for (const e of g.edges) {
    if (e.kind !== 'msg' || e.fromPool || e.toPool) continue;
    const u = nodeById.get(e.from);
    const v = nodeById.get(e.to);
    if (!u || !v || col.get(u.id) !== col.get(v.id)) continue;
    const pu = poolIndex.get(poolOfLane.get(u.lane) ?? '');
    const pv = poolIndex.get(poolOfLane.get(v.lane) ?? '');
    if (pu === undefined || pv === undefined || Math.abs(pu - pv) !== 1) continue;
    const c = col.get(u.id)!;
    const down = pu < pv;
    for (const [end, towardGap] of [[u, down], [v, !down]] as const) {
      const li = laneIndex.get(end.lane)!;
      for (const lane of g.lanes) {
        if (poolOfLane.get(lane.id) !== poolOfLane.get(end.lane)) continue;
        const i = laneIndex.get(lane.id)!;
        if (towardGap ? i >= li : i <= li) corridors.add(`${lane.id}:${c}`);
      }
    }
  }
  if (corridors.size === 0) return;
  for (const n of g.nodes) {
    if (!docIds.has(n.id)) continue;
    if (g.edges.some((e) => e.from === n.id || (e.kind !== 'assoc' && e.to === n.id))) continue;
    let c = col.get(n.id)!;
    for (let guard = 0; guard < g.nodes.length && corridors.has(`${n.lane}:${c}`); guard++) c++;
    if (c !== col.get(n.id)) col.set(n.id, c);
  }
}

/**
 * 開始イベントを直後のノードの直前へ寄せる。メッセージ整列で直後ノードが右へ動くと、
 * 開始だけが左端に残って長い辺になる(「注文待ち → 注文書を受信」)。開始は前任者を
 * 持たないので右へ寄せても制約を破らない。合成開始も同じ。
 */
function pullStartsToSuccessor(g: NormGraph, col: Map<string, number>): void {
  for (const n of g.nodes) {
    if (n.kind !== 'start') continue;
    const succ = g.edges.filter((e) => e.kind === 'seq' && e.from === n.id).map((e) => col.get(e.to) ?? 0);
    if (succ.length === 0) continue;
    const target = Math.min(...succ) - 1;
    if (target > (col.get(n.id) ?? 0)) col.set(n.id, target);
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
