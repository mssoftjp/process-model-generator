// BPMN 2.0.2 の標準マーカー。自作 SVG 幾何。座標は呼び出し側が決める。
// 公式 PDF や第三者画像は切り抜かない。

import type { EventTrigger, NodeGeom } from './types.ts';
import { hasBottomActivityMarker, isThrowEvent } from './bpmn.ts';

export function eventMarkerGroup(n: NodeGeom, stroke: string): string {
  const raw = n.subtype;
  if (!raw || raw === 'none') return '';
  if (!(EVENT_MARKER_SET as Set<string>).has(raw)) {
    return `<rect data-event-marker="unknown" data-unknown-subtype="${escAttr(raw)}" x="${n.cx}" y="${n.cy}" width="0" height="0"/>`;
  }
  const filled = isThrowEvent(n);
  return eventMarker(raw as EventTrigger, filled, n.cx, n.cy, stroke);
}

function stamp(svg: string, attrs: string): string {
  return svg.replace(/^<([a-z]+)\b/, `<$1 ${attrs}`);
}

const EVENT_MARKER_SET = new Set<string>([
  'message', 'timer', 'error', 'escalation', 'cancel', 'compensation',
  'conditional', 'link', 'signal', 'terminate', 'multiple', 'parallelMultiple',
]);

export function eventMarker(
  trigger: EventTrigger, filled: boolean, cx: number, cy: number, stroke: string,
): string {
  const fill = filled ? stroke : 'none';
  const inner = filled ? '#ffffff' : stroke;
  const s = `fill="${fill}" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"`;
  const line = `fill="none" stroke="${stroke}" stroke-width="1.1" stroke-linecap="round"`;
  const body = markerPath(trigger, filled, cx, cy, s, line, inner);
  if (body === '') return '';
  return stamp(body, `data-event-marker="${trigger}" data-event-filled="${filled ? 'true' : 'false'}"`);
}

function markerPath(
  trigger: EventTrigger, filled: boolean, cx: number, cy: number,
  s: string, line: string, inner: string,
): string {
  switch (trigger) {
    case 'message': {
      const w = 14, h = 10;
      const x = cx - w / 2, y = cy - h / 2;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${s}/>` +
        `<path d="M ${x} ${y} L ${cx} ${cy + 1} L ${x + w} ${y}" fill="none" stroke="${filled ? '#ffffff' : inner}" stroke-width="1.1"/>`;
    }
    case 'timer':
      return `<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="${strokeOf(s)}" stroke-width="1.1"/>` +
        `<circle cx="${cx}" cy="${cy}" r="6.2" fill="none" stroke="${strokeOf(s)}" stroke-width="0.9"/>` +
        `<path d="M ${cx} ${cy} L ${cx} ${cy - 4.2} M ${cx} ${cy} L ${cx + 3.2} ${cy + 1.6}" ${line}/>`;
    case 'error':
      return `<path d="M ${cx - 1.2} ${cy - 7.2} L ${cx + 4.2} ${cy - 0.6} L ${cx + 0.6} ${cy - 0.6} L ${cx + 2.4} ${cy + 7.2} L ${cx - 4.4} ${cy + 0.4} L ${cx - 0.2} ${cy + 0.4} Z" ${s}/>`;
    case 'escalation':
      return `<path d="M ${cx} ${cy - 7.2} L ${cx + 5.6} ${cy + 6.4} L ${cx} ${cy + 2.4} L ${cx - 5.6} ${cy + 6.4} Z" ${s}/>`;
    case 'cancel':
      return `<path d="M ${cx - 5.2} ${cy - 5.2} L ${cx + 5.2} ${cy + 5.2} M ${cx + 5.2} ${cy - 5.2} L ${cx - 5.2} ${cy + 5.2}" ${line.replace('stroke-width="1.1"', 'stroke-width="1.8"')}/>`;
    case 'compensation':
      return `<path d="M ${cx + 6.2} ${cy - 5.4} L ${cx - 0.2} ${cy} L ${cx + 6.2} ${cy + 5.4} Z" ${s}/>` +
        `<path d="M ${cx + 0.4} ${cy - 5.4} L ${cx - 6} ${cy} L ${cx + 0.4} ${cy + 5.4} Z" ${s}/>`;
    case 'conditional': {
      const x = cx - 5, y = cy - 6.5;
      return `<rect x="${x}" y="${y}" width="10" height="13" rx="0.5" ${s}/>` +
        `<path d="M ${x + 2} ${y + 3.2} H ${x + 8} M ${x + 2} ${y + 6.2} H ${x + 8} M ${x + 2} ${y + 9.2} H ${x + 7}" fill="none" stroke="${filled ? '#ffffff' : strokeOf(s)}" stroke-width="1"/>`;
    }
    case 'link':
      return `<path d="M ${cx - 6.4} ${cy - 3} L ${cx + 0.6} ${cy - 3} L ${cx + 0.6} ${cy - 5.6} L ${cx + 7} ${cy} L ${cx + 0.6} ${cy + 5.6} L ${cx + 0.6} ${cy + 3} L ${cx - 6.4} ${cy + 3} Z" ${s}/>`;
    case 'signal':
      return `<path d="M ${cx} ${cy - 7.2} L ${cx + 6.4} ${cy + 5.2} L ${cx - 6.4} ${cy + 5.2} Z" ${s}/>`;
    case 'terminate':
      return `<circle cx="${cx}" cy="${cy}" r="6.2" fill="${strokeOf(s)}" stroke="${strokeOf(s)}" data-event-inner="terminate"/>`;
    case 'multiple':
      return pentagon(cx, cy, 7, s);
    case 'parallelMultiple':
      return `<path d="M ${cx} ${cy - 6.5} L ${cx} ${cy + 6.5} M ${cx - 6.5} ${cy} L ${cx + 6.5} ${cy}" ${line.replace('stroke-width="1.1"', 'stroke-width="1.8"')}/>`;
    default:
      return '';
  }
}

function strokeOf(s: string): string {
  const m = /stroke="([^"]+)"/.exec(s);
  return m?.[1] ?? '#18181b';
}

function pentagon(cx: number, cy: number, r: number, s: string): string {
  const pts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / 5;
    pts.push(`${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`);
  }
  return `<polygon points="${pts.join(' ')}" ${s}/>`;
}

export function taskTypeIcon(n: NodeGeom, stroke: string): string {
  const x = n.x + 6;
  const y = n.y + 5;
  const s = ` stroke="${stroke}" stroke-width="1.2" fill="none" stroke-linecap="round"`;
  const wrap = (name: string, body: string) => stamp(body, `data-task-marker="${name}"`);
  const taskType = n.subtype === 'call' && n.callProcess === false && n.callTaskType
    ? n.callTaskType
    : n.subtype;
  switch (taskType) {
    case 'user':
      return wrap('user',
        `<circle cx="${x + 4.5}" cy="${y + 3.4}" r="2.3"${s}/>` +
        `<path d="M ${x + 0.6} ${y + 10.6} Q ${x + 4.5} ${y + 5.6} ${x + 8.4} ${y + 10.6}"${s}/>`);
    case 'service': {
      const cx = x + 5, cy = y + 5;
      let ticks = '';
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        ticks += `M ${cx + Math.cos(a) * 3.1} ${cy + Math.sin(a) * 3.1} L ${cx + Math.cos(a) * 5} ${cy + Math.sin(a) * 5} `;
      }
      return wrap('service', `<circle cx="${cx}" cy="${cy}" r="3.1"${s}/><path d="${ticks}"${s}/>`);
    }
    case 'rule':
      return wrap('rule',
        `<rect x="${x}" y="${y + 1}" width="11" height="8.5"${s}/>` +
        `<path d="M ${x} ${y + 4} H ${x + 11} M ${x + 3.5} ${y + 4} V ${y + 9.5}"${s}/>`);
    case 'script':
      return wrap('script',
        `<path d="M ${x} ${y + 2} H ${x + 10} M ${x} ${y + 5} H ${x + 10} M ${x} ${y + 8} H ${x + 7}"${s}/>`);
    case 'send':
      return wrap('send',
        `<rect x="${x}" y="${y + 1.5}" width="12" height="8" fill="${stroke}" stroke="${stroke}" stroke-width="1"/>` +
        `<path d="M ${x} ${y + 1.5} L ${x + 6} ${y + 6} L ${x + 12} ${y + 1.5}" stroke="#ffffff" stroke-width="1" fill="none"/>`);
    case 'receive':
      return wrap('receive',
        `<rect x="${x}" y="${y + 1.5}" width="12" height="8"${s}/>` +
        `<path d="M ${x} ${y + 1.5} L ${x + 6} ${y + 6} L ${x + 12} ${y + 1.5}"${s}/>`);
    case 'manual':
      return wrap('manual',
        `<path d="M ${x + 1} ${y + 10.5} V ${y + 5.2} ` +
        `Q ${x + 1} ${y + 4.2} ${x + 2} ${y + 4.2} Q ${x + 3} ${y + 4.2} ${x + 3} ${y + 5.2} ` +
        `V ${y + 2.5} Q ${x + 3} ${y + 1.5} ${x + 4} ${y + 1.5} Q ${x + 5} ${y + 1.5} ${x + 5} ${y + 2.5} ` +
        `V ${y + 4.4} V ${y + 1.8} Q ${x + 5} ${y + 0.8} ${x + 6} ${y + 0.8} Q ${x + 7} ${y + 0.8} ${x + 7} ${y + 1.8} ` +
        `V ${y + 4.4} V ${y + 2.5} Q ${x + 7} ${y + 1.5} ${x + 8} ${y + 1.5} Q ${x + 9} ${y + 1.5} ${x + 9} ${y + 2.5} ` +
        `V ${y + 5} Q ${x + 10.5} ${y + 3.8} ${x + 11.3} ${y + 4.8} Q ${x + 11.8} ${y + 5.5} ${x + 11} ${y + 6.5} ` +
        `L ${x + 8.5} ${y + 10.5} Z"${s}/>`);
    default:
      if (n.subtype && n.subtype !== 'call' && n.subtype !== 'sub' && n.subtype !== 'transaction' && n.subtype !== 'eventSub') {
        return `<rect data-task-marker="unknown" data-unknown-subtype="${escAttr(n.subtype)}" x="${n.x}" y="${n.y}" width="0" height="0"/>`;
      }
      return '';
  }
}

/** collapsed Event Sub-Process の左上に置く Start Event マーカー。 */
export function eventSubStartMarker(n: NodeGeom, stroke: string): string {
  if (n.subtype !== 'eventSub') return '';
  const cx = n.x + 16;
  const cy = n.y + 16;
  const trigger = n.eventSubTrigger;
  if (!trigger) {
    return `<rect data-event-sub-start="missing" x="${cx}" y="${cy}" width="0" height="0"/>`;
  }
  const dash = n.eventSubInterrupting === false ? ' stroke-dasharray="3 2"' : '';
  return `<g data-event-sub-start="${trigger}" data-event-sub-interrupting="${n.eventSubInterrupting === false ? 'false' : 'true'}">` +
    `<circle cx="${cx}" cy="${cy}" r="10" fill="#ffffff" stroke="${stroke}" stroke-width="1.2"${dash}/>` +
    eventMarker(trigger, false, cx, cy, stroke) +
    '</g>';
}

/** 下部中央に並べる Activity マーカー（仕様どおり [+] / loop / MI / compensation / ad-hoc） */
export function activityBottomMarkers(n: NodeGeom, stroke: string): string {
  if (!hasBottomActivityMarker(n)) return '';
  const items: Array<{ name: string; w: number; draw: (x: number, y: number) => string }> = [];
  const s = ` stroke="${stroke}" stroke-width="1.2" fill="none" stroke-linecap="round"`;
  const plus = n.subtype === 'sub' || n.subtype === 'transaction' || n.subtype === 'eventSub'
    || (n.subtype === 'call' && n.callProcess !== false);
  if (plus) {
    items.push({
      name: 'collapsed',
      w: 12,
      draw: (x, y) =>
        `<rect data-activity-marker="collapsed" x="${x}" y="${y}" width="12" height="12"${s}/>` +
        `<path d="M ${x + 6} ${y + 2.5} V ${y + 9.5} M ${x + 2.5} ${y + 6} H ${x + 9.5}"${s}/>`,
    });
  }
  if (n.loop === 'loop') {
    items.push({
      name: 'loop',
      w: 12,
      draw: (x, y) =>
        `<path data-activity-marker="loop" d="M ${x + 9.2} ${y + 3.2} A 4.4 4.4 0 1 0 ${x + 9.4} ${y + 8.6}"${s}/>` +
        `<path d="M ${x + 9.2} ${y + 0.8} L ${x + 9.2} ${y + 4.4} L ${x + 5.8} ${y + 3.2}"${s}/>`,
    });
  } else if (n.loop === 'parallel') {
    items.push({
      name: 'parallel-mi',
      w: 12,
      draw: (x, y) =>
        `<path data-activity-marker="parallel-mi" d="M ${x + 3} ${y + 2} V ${y + 10} M ${x + 6} ${y + 2} V ${y + 10} M ${x + 9} ${y + 2} V ${y + 10}"${s}/>`,
    });
  } else if (n.loop === 'sequential') {
    items.push({
      name: 'sequential-mi',
      w: 12,
      draw: (x, y) =>
        `<path data-activity-marker="sequential-mi" d="M ${x + 2} ${y + 3.5} H ${x + 10} M ${x + 2} ${y + 6} H ${x + 10} M ${x + 2} ${y + 8.5} H ${x + 10}"${s}/>`,
    });
  }
  if (n.compensation) {
    items.push({
      name: 'compensation',
      w: 14,
      draw: (x, y) =>
        `<path data-activity-marker="compensation" d="M ${x + 13} ${y + 2} L ${x + 7} ${y + 6} L ${x + 13} ${y + 10} Z"${s}/>` +
        `<path d="M ${x + 7.5} ${y + 2} L ${x + 1.5} ${y + 6} L ${x + 7.5} ${y + 10} Z"${s}/>`,
    });
  }
  if (n.adhoc) {
    items.push({
      name: 'adhoc',
      w: 14,
      draw: (x, y) =>
        `<path data-activity-marker="adhoc" d="M ${x + 1} ${y + 7} Q ${x + 4} ${y + 2} ${x + 7} ${y + 7} T ${x + 13} ${y + 7}"${s}/>`,
    });
  }
  if (items.length === 0) return '';
  const gap = 4;
  const total = items.reduce((w, it) => w + it.w, 0) + gap * (items.length - 1);
  let x = n.cx - total / 2;
  const y = n.y + n.h - 14;
  return items.map((it) => {
    const drawn = it.draw(x, y);
    x += it.w + gap;
    return drawn;
  }).join('');
}

export function gatewayInner(n: NodeGeom, stroke: string): string {
  const { cx, cy } = n;
  const m = 7;
  if (n.kind === 'and' && n.subtype !== 'event') {
    return `<path data-gateway-marker="parallel" d="M ${cx} ${cy - m - 2} L ${cx} ${cy + m + 2} M ${cx - m - 2} ${cy} L ${cx + m + 2} ${cy}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (n.kind === 'and' && n.subtype === 'event') {
    return `<circle data-gateway-marker="parallel-event" cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="${stroke}" stroke-width="1.1"/>` +
      `<circle cx="${cx}" cy="${cy}" r="6.5" fill="none" stroke="${stroke}" stroke-width="1.1"/>` +
      pentagon(cx, cy, 4, `fill="none" stroke="${stroke}" stroke-width="1.1"`) +
      `<path d="M ${cx} ${cy - 2.2} L ${cx} ${cy + 2.2} M ${cx - 2.2} ${cy} L ${cx + 2.2} ${cy}" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/>`;
  }
  if (n.subtype === 'event') {
    return `<circle data-gateway-marker="event" cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="${stroke}" stroke-width="1.1"/>` +
      `<circle cx="${cx}" cy="${cy}" r="6.5" fill="none" stroke="${stroke}" stroke-width="1.1"/>` +
      pentagon(cx, cy, 4, `fill="none" stroke="${stroke}" stroke-width="1.1"`);
  }
  if (n.subtype === 'or') {
    return `<circle data-gateway-marker="inclusive" cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="${stroke}" stroke-width="2.2"/>`;
  }
  if (n.subtype === 'complex') {
    return `<path data-gateway-marker="complex" d="M ${cx} ${cy - 8} L ${cx} ${cy + 8} M ${cx - 8} ${cy} L ${cx + 8} ${cy} M ${cx - 5.6} ${cy - 5.6} L ${cx + 5.6} ${cy + 5.6} M ${cx + 5.6} ${cy - 5.6} L ${cx - 5.6} ${cy + 5.6}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>`;
  }
  if (n.subtype) {
    return `<rect data-gateway-marker="unknown" data-unknown-subtype="${escAttr(n.subtype)}" x="${cx}" y="${cy}" width="0" height="0"/>`;
  }
  return `<path data-gateway-marker="exclusive" d="M ${cx - m} ${cy - m} L ${cx + m} ${cy + m} M ${cx - m} ${cy + m} L ${cx + m} ${cy - m}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`;
}

export function dataObjectExtras(n: NodeGeom, stroke: string): string {
  const out: string[] = [];
  if (n.subtype === 'input' || n.subtype === 'output') {
    const filled = n.subtype === 'output';
    const ax = n.x + 3;
    const ay = n.cy;
    out.push(
      `<path data-doc-io="${n.subtype}" d="M ${ax} ${ay - 4} L ${ax + 7} ${ay - 4} L ${ax + 7} ${ay - 7} L ${ax + 13} ${ay} L ${ax + 7} ${ay + 7} L ${ax + 7} ${ay + 4} L ${ax} ${ay + 4} Z"` +
      ` fill="${filled ? stroke : 'none'}" stroke="${stroke}" stroke-width="1"/>`,
    );
  }
  if (n.collection) {
    const y = n.y + n.h - 5;
    const cx = n.cx;
    out.push(
      `<path data-collection="true" d="M ${cx - 5} ${y - 6} V ${y} M ${cx} ${y - 6} V ${y} M ${cx + 5} ${y - 6} V ${y}" stroke="${stroke}" stroke-width="1.2"/>`,
    );
  }
  return out.join('');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
