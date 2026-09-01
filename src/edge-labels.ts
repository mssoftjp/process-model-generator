// P5 後段: 全辺の実座標が揃ってから、辺ラベルを自辺の近傍で衝突回避する。
// 経路・ノード・キャンバス寸法は変えず、既存位置が空いていれば動かさない。

import { EDGE_FONT_SIZE, measureText } from './metrics.ts';
import { OUT_LABEL_FONT, OUT_LABEL_LINE_H } from './measure.ts';
import type { EdgeGeom, Geometry, NodeGeom, Pt } from './types.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeLabelReport {
  moved: number;
  kept: number;
  fallback: number;
  nodeHits: number;
  edgeHits: number;
  labelHits: number;
  stolen: number;
  ambiguous: number;
  details: string[];
}

const LABEL_H = EDGE_FONT_SIZE + 4;
const EDGE_CLEARANCE = 1;
const AMBIG_GAP = 8;
const START_ALONG_BAND = 80;
type LabelScore = [
  outside: number, node: number, label: number, ambiguity: number, sequence: number, other: number,
  ownHits: number, farBand: number, alongBand: number, segment: number, overflow: number,
  offsetRank: number, order: number,
];
type ExternalScore = [outside: number, node: number, label: number, sequence: number, other: number];

export function currentLabelScore(
  [outside, node, label, sequence, other]: ExternalScore,
  ambiguity: number,
  ownHits: number,
  farBand: number,
): LabelScore {
  return [outside, node, label, ambiguity, sequence, other, ownHits, farBand, 0, 0, 0, 0, 0];
}

export function edgeLabelBox(e: EdgeGeom): Box | undefined {
  if (!e.label || !e.labelPos) return undefined;
  return {
    x: e.labelPos.x,
    y: e.labelPos.y,
    w: measureText(e.label, EDGE_FONT_SIZE),
    h: LABEL_H,
  };
}

/** 衝突したラベルだけを、自辺の区間脇にある決定的な候補へ移す。 */
export function placeEdgeLabels(geometry: Geometry): EdgeLabelReport {
  const obstacles = geometry.nodes.flatMap(nodeObstacles);
  const placed: Box[] = [];
  const rank = (e: EdgeGeom) => e.kind === 'seq' ? 0 : e.kind === 'assoc' ? 1 : 2;
  const labels = geometry.edges.filter((e) => e.label && e.labelPos)
    .map((e, index) => ({ e, index }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.index - b.index);
  let moved = 0;
  let kept = 0;
  let fallback = 0;

  for (const { e } of labels) {
    const current = edgeLabelBox(e)!;
    const curExternal = externalHits(geometry, e, current, obstacles, placed);
    const curAmb = ambiguity(geometry, e, current);
    if (curExternal.every((n) => n === 0) && curAmb === 0 && startDist(e, current) <= 160) {
      placed.push(current);
      kept++;
      continue;
    }

    const selectBest = (cands: Candidate[]) => {
      let best: { score: LabelScore; pos: Pt } | undefined;
      for (const candidate of cands) {
        const box = { x: candidate.pos.x, y: candidate.pos.y, w: current.w, h: LABEL_H };
        const [outside, node, labelHit, sequence, other] = externalHits(geometry, e, box, obstacles, placed);
        let ownHits = 0;
        for (let i = 0; i + 1 < e.points.length; i++) {
          if (i === candidate.segment) continue;
          if (intersects(box, segmentBox(e.points[i]!, e.points[i + 1]!), EDGE_CLEARANCE)) ownHits++;
        }
        const far = startDist(e, box);
        // 所有の曖昧さは他線との交差より先。共有スタブ上で衝突ゼロでも盗まれる配置を捨てる。
        const score: LabelScore = [
          outside, node, labelHit,
          ambiguity(geometry, e, box),
          sequence, other, ownHits,
          Math.floor(far / START_ALONG_BAND),
          Math.floor(candidate.along / START_ALONG_BAND),
          candidate.segment,
          candidate.overflow,
          candidate.offsetRank,
          candidate.order,
        ];
        if (!best || compareScore(score, best.score) < 0) best = { score, pos: candidate.pos };
      }
      return best;
    };

    let best = selectBest(labelCandidates(e, current.w, geometry));
    if (best && (best.score.slice(0, 7).some((n) => n > 0) || (best.score[10] ?? 0) > 0)) {
      const wide = selectBest(labelCandidates(e, current.w, geometry, true));
      if (wide && compareScore(wide.score, best.score) < 0) best = wide;
    }

    let curOwnHits = 0;
    for (let i = 0; i + 1 < e.points.length; i++) {
      if (intersects(current, segmentBox(e.points[i]!, e.points[i + 1]!), EDGE_CLEARANCE)) curOwnHits++;
    }
    const currentScore = currentLabelScore(
      curExternal, curAmb, curOwnHits, Math.floor(startDist(e, current) / START_ALONG_BAND),
    );
    if (best && compareScore(best.score, currentScore) < 0) {
      e.labelPos = best.pos;
      placed.push(edgeLabelBox(e)!);
      moved++;
    } else {
      placed.push(current);
      fallback++;
    }
  }

  return { moved, kept, fallback, ...inspectEdgeLabels(geometry) };
}

/** 配置後の残存衝突。候補選択と診断・テストで同じ箱定義を使う。 */
export function inspectEdgeLabels(geometry: Geometry): Omit<EdgeLabelReport, 'moved' | 'kept' | 'fallback'> {
  const obstacles = geometry.nodes.flatMap((n) => nodeObstacles(n).map((box) => ({ id: n.id, box })));
  const labels = geometry.edges.flatMap((e) => {
    const box = edgeLabelBox(e);
    return box ? [{ e, box }] : [];
  });
  let nodeHits = 0;
  let edgeHits = 0;
  let labelHits = 0;
  let stolen = 0;
  let ambiguous = 0;
  const details: string[] = [];

  for (let li = 0; li < labels.length; li++) {
    const current = labels[li]!;
    for (const obstacle of obstacles) {
      if (!intersects(current.box, obstacle.box)) continue;
      nodeHits++;
      details.push(`${current.e.id}:node:${obstacle.id}`);
    }
    for (const other of geometry.edges) {
      if (other.id === current.e.id) continue;
      if (!edgeIntersectsBox(other, current.box)) continue;
      edgeHits++;
      details.push(`${current.e.id}:edge:${other.id}`);
    }
    for (let mi = li + 1; mi < labels.length; mi++) {
      const other = labels[mi]!;
      if (!intersects(current.box, other.box)) continue;
      labelHits++;
      details.push(`${current.e.id}:label:${other.e.id}`);
    }
    const own = ownDist(current.e, current.box);
    const other = otherDist(geometry, current.e, current.box);
    if (other < own) stolen++;
    if (other < own + AMBIG_GAP) ambiguous++;
  }
  return { nodeHits, edgeHits, labelHits, stolen, ambiguous, details };
}

function nodeObstacles(n: NodeGeom): Box[] {
  const out: Box[] = [{ x: n.x, y: n.y, w: n.w, h: n.h }];
  if (n.kind === 'task' || n.kind === 'note' || n.kind === 'group' || n.labelLines.length === 0) return out;
  const labelW = Math.max(...n.labelLines.map((line) => measureText(line, OUT_LABEL_FONT)));
  const labelH = n.labelLines.length * OUT_LABEL_LINE_H;
  if (n.kind === 'xor' || n.kind === 'and') {
    out.push({ x: n.cx - 8 - labelW, y: n.y - 6 - labelH, w: labelW, h: labelH });
  } else if (n.kind === 'doc' || n.kind === 'store') {
    out.push({ x: n.cx + 6, y: n.y + n.h + 4, w: labelW, h: labelH });
  } else if (n.labelSide === 'left') {
    out.push({ x: n.x - 6 - labelW, y: n.cy - labelH / 2, w: labelW, h: labelH });
  } else if (n.labelSide === 'right') {
    out.push({ x: n.x + n.w + 6, y: n.cy - labelH / 2, w: labelW, h: labelH });
  } else if (n.labelSide === 'top') {
    out.push({ x: n.cx - labelW / 2, y: n.y - 6 - labelH, w: labelW, h: labelH });
  } else {
    out.push({ x: n.cx - labelW / 2, y: n.y + n.h + 6, w: labelW, h: labelH });
  }
  return out;
}

interface Candidate {
  pos: Pt;
  segment: number;
  overflow: number;
  offsetRank: number;
  order: number;
  along: number;
}

function prefixLength(pts: Pt[], seg: number): number {
  let n = 0;
  for (let i = 0; i < seg; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    n += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return n;
}

function alongAnchors(p: number, q: number, pad: number, box: number, minOff: number): number[] {
  const len = Math.abs(q - p);
  const dir = q >= p ? 1 : -1;
  const at = (off: number) => dir > 0 ? p + off : p - off - box;
  const out: number[] = [];
  for (let off = minOff; off <= 96 && off < len; off += 8) out.push(at(off));
  if (len >= 120) out.push(at(0.15 * len), at(0.3 * len));
  out.push((p + q) / 2 - box / 2);
  out.push(dir > 0 ? q - pad - box : q + pad);
  const seen = new Set<number>();
  return out.filter((v) => {
    const k = Math.round(v * 2);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function labelCandidates(e: EdgeGeom, width: number, geometry: Geometry, full = false): Candidate[] {
  const candidates: Candidate[] = [];
  const source = geometry.nodes.find((n) => n.id === e.from);
  const restrictGatewayBranch = !e.isReturn && e.kind === 'seq' && !e.onSpine &&
    (source?.kind === 'xor' || source?.kind === 'and');
  let order = 0;
  const hOffsets: Array<[number, number]> = [[6, 0], [2, 1], [20, 2], [34, 3]];
  const vOffsets: Array<[number, number]> = [[8, 0], [2, 1], [22, 2], [36, 3]];
  for (let i = 0; i + 1 < e.points.length; i++) {
    if (restrictGatewayBranch && !full && i > 3) break;
    const a = e.points[i]!;
    const b = e.points[i + 1]!;
    const spans = full ? [{ p: a, q: b }] : uniqueSubsegments(e, i, geometry.edges);
    const base = prefixLength(e.points, i);
    for (const { p, q } of spans) {
      const horizontal = Math.abs(p.y - q.y) < 0.01;
      if (horizontal) {
        const lo = Math.min(p.x, q.x);
        const hi = Math.max(p.x, q.x);
        const anchors = alongAnchors(p.x, q.x, 6, width, 6);
        for (const [offset, offsetRank] of hOffsets) {
          for (const x of anchors) {
            const overflow = Math.max(0, lo - x) + Math.max(0, x + width - hi);
            const along = base + Math.abs((x + width / 2) - a.x);
            candidates.push({ pos: { x, y: p.y - offset - LABEL_H }, segment: i, overflow, offsetRank, order: order++, along });
            candidates.push({ pos: { x, y: p.y + offset }, segment: i, overflow, offsetRank, order: order++, along });
          }
        }
      } else {
        const lo = Math.min(p.y, q.y);
        const hi = Math.max(p.y, q.y);
        const anchors = alongAnchors(p.y, q.y, 10, LABEL_H, 10);
        for (const [offset, offsetRank] of vOffsets) {
          for (const y of anchors) {
            const overflow = Math.max(0, lo - y) + Math.max(0, y + LABEL_H - hi);
            const along = base + Math.abs((y + LABEL_H / 2) - a.y);
            candidates.push({ pos: { x: p.x + offset, y }, segment: i, overflow, offsetRank, order: order++, along });
            candidates.push({ pos: { x: p.x - offset - width, y }, segment: i, overflow, offsetRank, order: order++, along });
          }
        }
      }
    }
  }
  return candidates;
}

/** [canvas, node, prior label, sequence edge, other edge] の辞書式衝突数。 */
function externalHits(
  geometry: Geometry, e: EdgeGeom, box: Box, obstacles: Box[], placed: Box[],
): [number, number, number, number, number] {
  const outside = box.x < 0 || box.y < 0 || box.x + box.w > geometry.width || box.y + box.h > geometry.height ? 1 : 0;
  const node = obstacles.reduce((n, obstacle) => n + Number(intersects(box, obstacle)), 0);
  const label = placed.reduce((n, other) => n + Number(intersects(box, other)), 0);
  let sequence = 0;
  let other = 0;
  for (const edge of geometry.edges) {
    if (edge.id === e.id || !edgeIntersectsBox(edge, box)) continue;
    if (edge.kind === 'seq') sequence++;
    else other++;
  }
  return [outside, node, label, sequence, other];
}

function ambiguity(geometry: Geometry, e: EdgeGeom, box: Box): number {
  return otherDist(geometry, e, box) < ownDist(e, box) + AMBIG_GAP ? 1 : 0;
}

function startDist(e: EdgeGeom, box: Box): number {
  const start = e.points[0]!;
  return Math.abs(box.x + box.w / 2 - start.x) + Math.abs(box.y + box.h / 2 - start.y);
}

/** 他辺と同一直線上で重ならない部分。共有接頭辞の上に置くと所有が入れ替わる。 */
function uniqueSubsegments(e: EdgeGeom, i: number, edges: EdgeGeom[]): { p: Pt; q: Pt }[] {
  const a = e.points[i]!;
  const b = e.points[i + 1]!;
  const horizontal = Math.abs(a.y - b.y) < 0.01;
  const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  if (hi - lo < 12) return [];
  const line = horizontal ? a.y : a.x;
  const cuts: { lo: number; hi: number }[] = [];
  for (const other of edges) {
    if (other.id === e.id) continue;
    for (let j = 0; j + 1 < other.points.length; j++) {
      const p = other.points[j]!;
      const q = other.points[j + 1]!;
      const otherH = Math.abs(p.y - q.y) < 0.01;
      if (otherH !== horizontal) continue;
      if (Math.abs((otherH ? p.y : p.x) - line) > 0.5) continue;
      const oLo = otherH ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
      const oHi = otherH ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
      const cLo = Math.max(lo, oLo);
      const cHi = Math.min(hi, oHi);
      if (cHi - cLo > 4) cuts.push({ lo: cLo, hi: cHi });
    }
  }
  const forward = horizontal ? b.x >= a.x : b.y >= a.y;
  return subtractRanges(lo, hi, cuts).map((range) => {
    if (horizontal) {
      return forward
        ? { p: { x: range.lo, y: line }, q: { x: range.hi, y: line } }
        : { p: { x: range.hi, y: line }, q: { x: range.lo, y: line } };
    }
    return forward
      ? { p: { x: line, y: range.lo }, q: { x: line, y: range.hi } }
      : { p: { x: line, y: range.hi }, q: { x: line, y: range.lo } };
  });
}

function subtractRanges(lo: number, hi: number, cuts: { lo: number; hi: number }[]): { lo: number; hi: number }[] {
  const sorted = cuts
    .map((c) => ({ lo: Math.max(lo, c.lo), hi: Math.min(hi, c.hi) }))
    .filter((c) => c.hi > c.lo)
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: { lo: number; hi: number }[] = [];
  let cur = lo;
  for (const cut of sorted) {
    if (cut.lo > cur) out.push({ lo: cur, hi: cut.lo });
    cur = Math.max(cur, cut.hi);
  }
  if (cur < hi) out.push({ lo: cur, hi });
  return out.filter((range) => range.hi - range.lo >= 12);
}

function ownDist(e: EdgeGeom, box: Box): number {
  let own = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < e.points.length; i++) {
    own = Math.min(own, boxSegDist(box, e.points[i]!, e.points[i + 1]!));
  }
  return own;
}

function otherDist(geometry: Geometry, e: EdgeGeom, box: Box): number {
  let other = Number.POSITIVE_INFINITY;
  for (const o of geometry.edges) {
    if (o.id === e.id) continue;
    for (let i = 0; i + 1 < o.points.length; i++) {
      other = Math.min(other, boxSegDist(box, o.points[i]!, o.points[i + 1]!));
      if (other === 0) return 0;
    }
  }
  return other;
}

function boxSegDist(box: Box, a: Pt, b: Pt): number {
  const sb = segmentBox(a, b);
  const dx = Math.max(sb.x - (box.x + box.w), box.x - (sb.x + sb.w), 0);
  const dy = Math.max(sb.y - (box.y + box.h), box.y - (sb.y + sb.h), 0);
  return Math.hypot(dx, dy);
}

function edgeIntersectsBox(edge: EdgeGeom, box: Box): boolean {
  for (let i = 0; i + 1 < edge.points.length; i++) {
    if (intersects(box, segmentBox(edge.points[i]!, edge.points[i + 1]!), EDGE_CLEARANCE)) return true;
  }
  return false;
}

function segmentBox(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function intersects(a: Box, b: Box, pad = 0): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
