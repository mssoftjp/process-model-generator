// SVG 出力。描画は幾何の写像であり、ここで位置の判断はしない。
// - 折返しはエンジンの計測で決まった行を tspan で明示し、textLength で幅を強制する(R5, C-83)
// - 矢印は marker でなくパスで描く(マーカーの線短縮補正を仕様から消す)
// - 人が一塊と認識する単位を <g> にまとめ、帯→辺→ノードの3層を固定順で重ねる(S-66)。
//   グループ化は描画順を保存する(見た目は恒等)

import {
  activityBottomMarkers, dataObjectExtras, eventMarkerGroup, eventSubStartMarker, gatewayInner, taskTypeIcon,
} from './markers.ts';
import { hasBottomActivityMarker, hasTopTaskIcon, isGatewayKind, isThrowEvent } from './bpmn.ts';
import { EDGE_FONT_SIZE, FONT_SIZE, LINE_H, measureText, TITLE_FONT_SIZE } from './metrics.ts';
import { OUT_LABEL_FONT, OUT_LABEL_LINE_H } from './measure.ts';
import type { EdgeGeom, Geometry, NodeGeom, Pt } from './types.ts';

const FONT = `'Hiragino Kaku Gothic ProN','Hiragino Sans','Noto Sans JP','Yu Gothic',Meiryo,sans-serif`;

const C = {
  bg: '#ffffff',
  laneBorder: '#c9c9cf',
  laneHeader: '#ececef',
  laneAlt: '#fafafa',
  node: '#3f3f46',
  nodeSpine: '#18181b',
  nodeFill: '#ffffff',
  text: '#18181b',
  subText: '#52525b',
  edge: '#52525b',
  edgeSpine: '#18181b',
  provisional: '#b45309',
  title: '#18181b',
};

export function renderSvg(geo: Geometry, version = 'dev'): string {
  const gid = idAllocator();
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" data-process-model-generator="${esc(version)}" width="${geo.width}" height="${geo.height}" viewBox="0 0 ${geo.width} ${geo.height}" font-family="${esc(FONT)}">`,
  );
  parts.push(`<rect width="${geo.width}" height="${geo.height}" fill="${C.bg}"/>`);

  if (geo.title) {
    parts.push(text(geo.title, 24, 24 + 18, TITLE_FONT_SIZE, C.title, 'start', 600, true));
  }

  // プール帯とレーン帯。見出しは読み始めの側(横図=左、縦図=上)に置き、
  // テキストは横図では回転、縦図ではそのまま横書きにする(テキストは絵と一緒に回らない)。
  const vertical = geo.orientation === 'vertical';
  const poolHeaderT = geo.pools.length > 0 ? 34 : 0; // 見出し帯の厚み
  const laneHeaderT = geo.headerW - poolHeaderT;
  // プール名と同名の単一レーンはラベルを省く(名前の二重表示を避ける)
  const laneInPool = (l: (typeof geo.lanes)[number], pl: (typeof geo.pools)[number]) =>
    vertical ? l.x >= pl.x && l.x < pl.x + pl.w : l.y >= pl.y && l.y < pl.y + pl.h;
  const dupLaneLabel = new Set(
    geo.pools
      .filter((pl) => geo.lanes.filter((l) => laneInPool(l, pl)).length === 1)
      .map((pl) => pl.label),
  );
  const renderLane = (lane: (typeof geo.lanes)[number], i: number): string => {
    const out: string[] = [];
    if (lane.blackbox) {
      // 黒箱プール帯(C-51): 閉じた帯。横図は横書き中央、縦図はスリムな縦帯なので回転
      out.push(`<rect x="${lane.x}" y="${lane.y}" width="${lane.w}" height="${lane.h}" fill="#f1f1f3" stroke="#a1a1aa" stroke-width="1.5"/>`);
      const bx = lane.x + lane.w / 2;
      const by = lane.y + lane.h / 2;
      if (vertical) {
        out.push(
          `<text x="${bx}" y="${by}" font-size="13" font-weight="600" fill="${C.subText}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${bx} ${by})">${esc(lane.label)}</text>`,
        );
      } else {
        out.push(text(lane.label, bx, by, 13, C.subText, 'middle', 600, false, false));
      }
      return out.join('\n');
    }
    // 内側領域 = プール見出し帯を除いたレーン矩形
    const ix = vertical ? lane.x : lane.x + poolHeaderT;
    const iy = vertical ? lane.y + poolHeaderT : lane.y;
    const iw = vertical ? lane.w : lane.w - poolHeaderT;
    const ih = vertical ? lane.h - poolHeaderT : lane.h;
    if (i % 2 === 1) {
      out.push(`<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" fill="${C.laneAlt}"/>`);
    }
    if (vertical) {
      out.push(`<rect x="${ix}" y="${iy}" width="${iw}" height="${laneHeaderT}" fill="${C.laneHeader}"/>`);
    } else {
      out.push(`<rect x="${ix}" y="${iy}" width="${laneHeaderT}" height="${ih}" fill="${C.laneHeader}"/>`);
    }
    out.push(`<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" fill="none" stroke="${C.laneBorder}" stroke-width="1"/>`);
    if (dupLaneLabel.has(lane.label)) return out.join('\n');
    if (vertical) {
      out.push(
        `<text x="${ix + iw / 2}" y="${iy + laneHeaderT / 2}" font-size="12" textLength="${measureText(lane.label, 12).toFixed(1)}" lengthAdjust="spacingAndGlyphs" fill="${C.subText}" text-anchor="middle" dominant-baseline="central">${esc(lane.label)}</text>`,
      );
    } else {
      const lx = ix + laneHeaderT / 2;
      const ly = lane.y + lane.h / 2;
      out.push(
        `<text x="${lx}" y="${ly}" font-size="12" textLength="${measureText(lane.label, 12).toFixed(1)}" lengthAdjust="spacingAndGlyphs" fill="${C.subText}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${lx} ${ly})">${esc(lane.label)}</text>`,
      );
    }
    return out.join('\n');
  };

  // 帯レイヤ(S-66): レーンは所属プールのグループへ入れ子にする。
  // 発行順は従来の描画順のまま(プール枠→見出し→所属レーン。帯同士は交差しないので恒等)
  const laneGs = geo.lanes.map((lane, i) => group(gid('lane', lane.id), renderLane(lane, i)));
  const band: string[] = [];
  if (geo.pools.length > 0) {
    const claimed = new Set<number>();
    for (const pool of geo.pools) {
      const inner: string[] = [];
      inner.push(`<rect x="${pool.x}" y="${pool.y}" width="${pool.w}" height="${pool.h}" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>`);
      const isBlackbox = vertical
        ? geo.lanes.some((l) => l.blackbox && l.x === pool.x && l.w === pool.w)
        : geo.lanes.some((l) => l.blackbox && l.y === pool.y && l.h === pool.h);
      if (!isBlackbox) {
        // 黒箱プールはラベルをレーン側で描く
        if (vertical) {
          inner.push(`<rect x="${pool.x}" y="${pool.y}" width="${pool.w}" height="${poolHeaderT}" fill="#e4e4e7"/>`);
          inner.push(
            `<text x="${pool.x + pool.w / 2}" y="${pool.y + poolHeaderT / 2}" font-size="12" font-weight="600" fill="${C.subText}" text-anchor="middle" dominant-baseline="central">${esc(pool.label)}</text>`,
          );
        } else {
          inner.push(`<rect x="${pool.x}" y="${pool.y}" width="${poolHeaderT}" height="${pool.h}" fill="#e4e4e7"/>`);
          const px = pool.x + poolHeaderT / 2;
          const py = pool.y + pool.h / 2;
          inner.push(
            `<text x="${px}" y="${py}" font-size="12" font-weight="600" fill="${C.subText}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${px} ${py})">${esc(pool.label)}</text>`,
          );
        }
      }
      geo.lanes.forEach((lane, i) => {
        if (claimed.has(i) || !laneInPool(lane, pool)) return;
        claimed.add(i);
        inner.push(laneGs[i]!);
      });
      band.push(group(gid('pool', pool.id), inner.join('\n')));
    }
    // どのプールにも属さないレーンは帯レイヤ直下へ(構築上は起きない防衛)
    geo.lanes.forEach((_, i) => {
      if (!claimed.has(i)) band.push(laneGs[i]!);
    });
  } else {
    band.push(...laneGs);
  }
  parts.push(layer('layer-band', band));

  // 辺レイヤ(ノードより下層)とノードレイヤ
  const emphasizedNodes = new Set(geo.edges.filter(e => e.mainHint).flatMap(e => [e.from, e.to]));
  parts.push(layer('layer-edges', geo.edges.map((e) => group(gid('edge', e.id), renderEdge(e)))));
  parts.push(layer('layer-nodes', geo.nodes.map((n) => group(gid('node', n.id), renderNode(n, emphasizedNodes.has(n.id))))));

  parts.push('</svg>');
  return parts.join('\n');
}

// ---- 編集グループ(S-66) ----

/** 一塊の部品を <g> に包む。空内容はグループも作らない */
function group(id: string, content: string): string {
  return content === '' ? '' : `<g id="${id}">\n${content}\n</g>`;
}

/** 重ね順レイヤ。空でも発行し、帯→辺→ノードの3層構造を常に保つ */
function layer(id: string, members: string[]): string {
  const content = members.filter((m) => m !== '').join('\n');
  return content === '' ? `<g id="${id}"/>` : `<g id="${id}">\n${content}\n</g>`;
}

/**
 * グループ id の割り当て。幾何の id を XML NCName の安全な部分集合へ正規化し、
 * 正規化衝突は連番で分離する(同一入力で同一 id。決定性を保つ)
 */
function idAllocator(): (prefix: string, raw: string) => string {
  const used = new Set<string>();
  return (prefix, raw) => {
    // Unicode Letter は XML NameStartChar の安全な部分集合。数字は ASCII に限定する。
    // \p{N} 全体には ² など NCName で使えない文字も含まれるため、そのまま許可しない。
    let s = raw.replace(/[^\p{L}0-9_.-]/gu, '_');
    if (!/^[\p{L}_]/u.test(s)) s = `_${s}`;
    let id = `${prefix}-${s}`;
    for (let k = 2; used.has(id); k++) id = `${prefix}-${s}_${k}`;
    used.add(id);
    return id;
  };
}

// ---- ノード ----

function renderNode(n: NodeGeom, emphasized: boolean): string {
  const stroke = n.provisional ? C.provisional : emphasized ? C.nodeSpine : C.node;
  const sw = emphasized ? 1.6 : 1.25;
  const out: string[] = [];

  if (n.kind === 'task') {
    const isCall = n.subtype === 'call';
    const isEventSub = n.subtype === 'eventSub';
    const isTx = n.subtype === 'transaction';
    const shapeDash = n.provisional
      ? ' stroke-dasharray="5 3"'
      : isEventSub
        ? ' stroke-dasharray="4 3"'
        : '';
    const attrs = `data-task-type="${n.subtype === 'call'
      ? (n.callProcess === false ? 'call-global' : 'call-process')
      : esc(n.subtype ?? 'abstract')}"`;
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${isCall ? 2.6 : sw}"${shapeDash} ${attrs}/>`,
    );
    if (isTx) {
      out.push(
        `<rect data-task-border="transaction" x="${n.x + 3}" y="${n.y + 3}" width="${n.w - 6}" height="${n.h - 6}" rx="6" fill="none" stroke="${stroke}" stroke-width="1.1"/>`,
      );
    }
    if (isEventSub) out.push(eventSubStartMarker(n, stroke));
    else if (hasTopTaskIcon(n)) out.push(taskTypeIcon(n, stroke));
    else if (n.subtype && n.subtype !== 'call' && n.subtype !== 'sub' && n.subtype !== 'transaction' && n.subtype !== 'eventSub') {
      out.push(taskTypeIcon(n, stroke));
    }
    out.push(activityBottomMarkers(n, stroke));
    const total = n.labelLines.length * LINE_H;
    const shift = (hasTopTaskIcon(n) ? 6 : 0) + (hasBottomActivityMarker(n) ? -7 : 0);
    n.labelLines.forEach((line, i) => {
      const y = n.cy + shift - total / 2 + i * LINE_H + LINE_H / 2;
      out.push(text(line, n.cx, y, FONT_SIZE, C.text, 'middle', 400, true));
    });
    return out.join('\n');
  }

  if (isGatewayKind(n.kind)) {
    const { cx, cy } = n;
    const h = n.w / 2;
    const dash = n.provisional ? ' stroke-dasharray="5 3"' : '';
    out.push(
      `<path d="M ${cx} ${cy - h} L ${cx + h} ${cy} L ${cx} ${cy + h} L ${cx - h} ${cy} Z" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
    );
    out.push(gatewayInner(n, stroke));
    const totalH = n.labelLines.length * OUT_LABEL_LINE_H;
    n.labelLines.forEach((line, i) => {
      const y = n.y - 6 - totalH + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx - 8, y, OUT_LABEL_FONT, C.subText, 'end', 400, true, true));
    });
    return out.join('\n');
  }

  const dash = n.provisional ? ' stroke-dasharray="5 3"' : '';

  if (n.kind === 'store') {
    // データストア: 円筒(C-70)
    const { x, y, w, h } = n;
    const ry = 7;
    out.push(
      `<path d="M ${x} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} V ${y + ry}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
      `<ellipse cx="${n.cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
      `<path d="M ${x} ${y + ry + 5} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry + 5}" fill="none" stroke="${stroke}" stroke-width="1"/>`,
    );
    n.labelLines.forEach((line, i) => {
      const ly = n.y + n.h + 4 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx + 6, ly, OUT_LABEL_FONT, C.subText, 'start', 400, true, true));
    });
    return out.join('\n');
  }

  if (n.kind === 'note') {
    // 注釈: 開き括弧+テキスト(C-70)。枠なし
    const { x, y, h } = n;
    out.push(
      `<path d="M ${x + 8} ${y} H ${x} V ${y + h} H ${x + 8}" fill="none" stroke="${stroke}" stroke-width="1.1"/>`,
    );
    const totalNH = n.labelLines.length * OUT_LABEL_LINE_H;
    n.labelLines.forEach((line, i) => {
      const ly = n.cy - totalNH / 2 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, x + 6, ly, OUT_LABEL_FONT, C.subText, 'start', 400, true, true));
    });
    return out.join('\n');
  }

  if (n.kind === 'group') {
    const gDash = n.provisional ? ' stroke-dasharray="5 3"' : ' stroke-dasharray="6 4"';
    out.push(
      `<rect data-artifact="group" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" fill="none" stroke="${stroke}" stroke-width="1.2"${gDash}/>`,
    );
    const totalGH = n.labelLines.length * OUT_LABEL_LINE_H;
    n.labelLines.forEach((line, i) => {
      const ly = n.y + 8 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx, ly, OUT_LABEL_FONT, C.subText, 'middle', 400, true, true));
    });
    if (totalGH === 0) { /* keep empty group visible */ }
    return out.join('\n');
  }

  if (n.kind === 'doc') {
    if (n.subtype === 'message') {
      const x = n.x, y = n.y, w = n.w, h = n.h;
      out.push(
        `<rect data-artifact="message" x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
        `<path d="M ${x} ${y} L ${n.cx} ${y + h * 0.55} L ${x + w} ${y}" fill="none" stroke="${stroke}" stroke-width="1.1"/>`,
      );
    } else {
      const f = 10;
      const { x, y, w, h } = n;
      const bodyH = n.collection ? h - 8 : h;
      out.push(
        `<path data-artifact="data-object" d="M ${x} ${y} L ${x + w - f} ${y} L ${x + w} ${y + f} L ${x + w} ${y + bodyH} L ${x} ${y + bodyH} Z" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
        `<path d="M ${x + w - f} ${y} L ${x + w - f} ${y + f} L ${x + w} ${y + f}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
      out.push(dataObjectExtras({ ...n, h: bodyH }, stroke));
    }
    n.labelLines.forEach((line, i) => {
      const ly = n.y + n.h + 4 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx + 6, ly, OUT_LABEL_FONT, C.subText, 'start', 400, true, true));
    });
    return out.join('\n');
  }

  // start / end / mid / boundary
  const r = n.w / 2;
  const swc = n.kind === 'end' ? 3 : 1.6;
  const eventDash = n.provisional
    ? ' stroke-dasharray="5 3"'
    : n.interrupting === false
      ? ' stroke-dasharray="4 3"'
      : '';
  const role = n.kind === 'boundary'
    ? (n.interrupting === false ? 'boundary-nonint' : 'boundary')
    : n.kind === 'end'
      ? 'end'
      : n.kind === 'start'
        ? (n.interrupting === false ? 'start-nonint' : 'start')
        : (isThrowEvent(n) ? 'throw' : 'catch');
  out.push(
    `<circle data-event-role="${role}" cx="${n.cx}" cy="${n.cy}" r="${r - swc / 2}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${swc}"${eventDash}/>`,
  );
  if (n.kind === 'mid' || n.kind === 'boundary') {
    out.push(`<circle cx="${n.cx}" cy="${n.cy}" r="${r - 4}" fill="none" stroke="${stroke}" stroke-width="1.2"${eventDash}/>`);
  }
  out.push(eventMarkerGroup(n, stroke));
  const totalH = n.labelLines.length * OUT_LABEL_LINE_H;
  if (n.labelSide === 'left' || n.labelSide === 'right') {
    const lx = n.labelSide === 'left' ? n.x - 6 : n.x + n.w + 6;
    n.labelLines.forEach((line, i) => {
      const y = n.cy + (n.labelShift ?? 0) - totalH / 2 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, lx, y, OUT_LABEL_FONT, C.subText, n.labelSide === 'left' ? 'end' : 'start', 400, true, true));
    });
    return out.join('\n');
  }
  n.labelLines.forEach((line, i) => {
    const y = n.labelSide === 'top'
      ? n.y - 6 - totalH + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2
      : n.y + n.h + 6 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
    out.push(text(line, n.cx, y, OUT_LABEL_FONT, C.subText, 'middle', 400, true, true));
  });
  return out.join('\n');
}

// ---- 辺 ----

const ARROW_L = 9;
const ARROW_W = 7;
const HOP_R = 5;

function renderEdge(e: EdgeGeom): string {
  if (e.points.length < 2) return '';
  const isAssoc = e.kind === 'assoc';
  const isMsg = e.kind === 'msg';
  const assocKind = e.assocKind ?? (isAssoc ? 'data' : undefined);
  const undirected = isAssoc && assocKind === 'undirected';
  const both = isAssoc && assocKind === 'both';
  const stroke = e.provisional
    ? C.provisional
    : e.mainHint
      ? C.edgeSpine
      : isMsg ? '#236e91' : C.edge;
  const sw = e.mainHint ? 2 : isAssoc ? 1.2 : isMsg ? 1.6 : 1.3;
  const dash = e.provisional
    ? ' stroke-dasharray="5 3"'
    : isAssoc
      ? (assocKind === 'data' ? ' stroke-dasharray="2 4" stroke-linecap="round"' : ' stroke-dasharray="1 3"')
      : isMsg
        ? ' stroke-dasharray="7 4"'
        : '';
  const pts = e.points;
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2]!;
  const dx = Math.sign(last.x - prev.x);
  const dy = Math.sign(last.y - prev.y);
  const shortened: Pt = undirected
    ? last
    : { x: last.x - dx * ARROW_L, y: last.y - dy * ARROW_L };
  const linePts = [...pts.slice(0, -1), shortened];
  const out: string[] = [];
  const assocAttr = isAssoc ? ` data-assoc="${assocKind}"` : '';
  const defaultAttr = e.isDefault ? ' data-edge-default="true"' : '';
  const condAttr = e.isConditional ? ' data-edge-conditional="true"' : '';
  const mainAttr = e.mainHint ? ' data-main-path="true"' : '';
  const returnAttr = e.returnHint ? ' data-return-hint="true"' : '';
  out.push(`<path d="${pathWithHops(linePts, e.hops)}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash}${assocAttr}${defaultAttr}${condAttr}${mainAttr}${returnAttr}/>`);
  const bx = last.x - dx * ARROW_L;
  const by = last.y - dy * ARROW_L;
  const px = dy !== 0 ? ARROW_W / 2 : 0;
  const py = dx !== 0 ? ARROW_W / 2 : 0;
  const openArrow = (x: number, y: number, ddx: number, ddy: number) => {
    const abx = x - ddx * ARROW_L;
    const aby = y - ddy * ARROW_L;
    const apx = ddy !== 0 ? ARROW_W / 2 : 0;
    const apy = ddx !== 0 ? ARROW_W / 2 : 0;
    return `<path d="M ${abx - apx} ${aby - apy} L ${x} ${y} L ${abx + apx} ${aby + apy}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
  };
  if (isMsg) {
    const p0 = pts[0]!;
    out.push(
      `<circle cx="${p0.x}" cy="${p0.y}" r="3.5" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="1.2"/>`,
      openArrow(last.x, last.y, dx, dy),
    );
  } else if (isAssoc) {
    if (!undirected) out.push(openArrow(last.x, last.y, dx, dy));
    if (both) {
      const p0 = pts[0]!;
      const p1 = pts[1]!;
      out.push(openArrow(p0.x, p0.y, Math.sign(p0.x - p1.x), Math.sign(p0.y - p1.y)));
    }
  } else {
    out.push(
      `<path d="M ${last.x} ${last.y} L ${bx - px} ${by - py} L ${bx + px} ${by + py} Z" fill="${stroke}"/>`,
    );
  }
  if (e.isDefault && e.kind === 'seq') {
    out.push(defaultSlash(pts[0]!, pts[1]!, stroke));
  }
  if (e.isConditional && e.kind === 'seq') {
    out.push(conditionalDiamond(pts[0]!, pts[1]!, stroke));
  }
  if (e.label && e.labelPos) {
    out.push(text(e.label, e.labelPos.x, e.labelPos.y + EDGE_FONT_SIZE / 2 + 2, EDGE_FONT_SIZE, C.subText, 'start', 400, false, true));
  }
  return out.join('\n');
}

/** BPMN Default Sequence Flow: 始点近くの斜線 */
function defaultSlash(a: Pt, b: Pt, stroke: string): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(10, len / 2);
  const cx = a.x + (dx / len) * t;
  const cy = a.y + (dy / len) * t;
  const nx = -dy / len;
  const ny = dx / len;
  const s = 5;
  return `<path data-default-slash="true" d="M ${cx + nx * s - (dx / len) * 2} ${cy + ny * s - (dy / len) * 2} L ${cx - nx * s + (dx / len) * 2} ${cy - ny * s + (dy / len) * 2}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round"/>`;
}

/** 非ゲートウェイ起点の Conditional Sequence Flow: 始点のミニ菱形 */
function conditionalDiamond(a: Pt, b: Pt, stroke: string): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const t = 7;
  const cx = a.x + ux * t;
  const cy = a.y + uy * t;
  const s = 4;
  return `<path data-conditional-diamond="true" d="M ${cx + ux * s} ${cy + uy * s} L ${cx - uy * s} ${cy + ux * s} L ${cx - ux * s} ${cy - uy * s} L ${cx + uy * s} ${cy - ux * s} Z" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="1.1"/>`;
}

/**
 * ホップ入りのパス文字列(C-43)。水平区間は上に、垂直区間は右に半円で膨らむ。
 * 近接ホップ(間隔 < 2r+2)は一つの楕円弧にまとめる。
 */
function pathWithHops(pts: Pt[], hops: EdgeGeom['hops']): string {
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    const segHops = (hops ?? []).filter((h) => h.seg === k);
    if (segHops.length === 0) {
      d += ` L ${b.x} ${b.y}`;
      continue;
    }
    const horizontal = Math.abs(a.y - b.y) < 0.01;
    const dir = horizontal ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
    const pos = segHops
      .map((h) => (horizontal ? h.x : h.y))
      .sort((p, q) => (p - q) * dir);
    // 近接ホップをクラスタにまとめる
    const clusters: Array<{ lo: number; hi: number }> = [];
    for (const p of pos) {
      const lastC = clusters[clusters.length - 1];
      if (lastC && Math.abs(p - (dir > 0 ? lastC.hi : lastC.lo)) < HOP_R * 2 + 2) {
        if (dir > 0) lastC.hi = p;
        else lastC.lo = p;
      } else {
        clusters.push({ lo: Math.min(p, p), hi: Math.max(p, p) });
        const c = clusters[clusters.length - 1]!;
        c.lo = p;
        c.hi = p;
      }
    }
    const sweep = dir > 0 ? 1 : 0; // 右向き/下向きは 1 で上(右)に膨らむ
    for (const c of clusters) {
      const [start, end] = dir > 0 ? [c.lo - HOP_R, c.hi + HOP_R] : [c.hi + HOP_R, c.lo - HOP_R];
      const rLong = Math.abs(end - start) / 2;
      if (horizontal) {
        d += ` L ${start} ${a.y} A ${rLong} ${HOP_R} 0 0 ${sweep} ${end} ${a.y}`;
      } else {
        d += ` L ${a.x} ${start} A ${HOP_R} ${rLong} 0 0 ${sweep} ${a.x} ${end}`;
      }
    }
    d += ` L ${b.x} ${b.y}`;
  }
  return d;
}

// ---- テキスト ----

function text(
  s: string, x: number, y: number, size: number, fill: string,
  anchor: 'start' | 'middle' | 'end' = 'start', weight = 400, forceWidth = false, halo = false,
): string {
  if (s === '') return '';
  const w = measureText(s, size);
  const tl = forceWidth ? ` textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : '';
  const haloAttr = halo ? ` paint-order="stroke" stroke="#ffffff" stroke-width="3"` : '';
  const weightAttr = weight !== 400 ? ` font-weight="${weight}"` : '';
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="central"${weightAttr}${haloAttr}${tl}>${esc(s)}</text>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
