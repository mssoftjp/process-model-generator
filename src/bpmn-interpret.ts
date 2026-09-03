// DSL の括弧内トークン(task(user,loop) / xor(event) など)を IR フィールドへ写す解釈と、
// その診断。未知・違法は黙って別記号へ読み替えず、unknown / notes に残す。

import type { ActivityLoop, Diagnostic, EventTrigger, IrNode, NodeKind } from './types.ts';
import { DOC_SUBTYPES, EVENT_TRIGGERS, LEGAL_BOUNDARY_NONINT, LEGAL_EVENT, TASK_TYPES, isEventKind } from './bpmn-kinds.ts';
import type { EventSlot } from './bpmn-kinds.ts';

export interface InterpretedNode {
  kind: NodeKind;
  subtype?: string;
  eventThrow?: boolean;
  interrupting?: boolean;
  callProcess?: boolean;
  callTaskType?: 'user' | 'manual' | 'script' | 'rule';
  eventSubTrigger?: EventTrigger;
  eventSubInterrupting?: boolean;
  loop?: ActivityLoop;
  compensation?: boolean;
  adhoc?: boolean;
  collection?: boolean;
  unknown: string[];
  notes: string[];
}

const KIND_ALIASES: Record<string, NodeKind> = {
  task: 'task', xor: 'xor', and: 'and', start: 'start', end: 'end',
  doc: 'doc', mid: 'mid', store: 'store', note: 'note',
  boundary: 'boundary', group: 'group',
};

/** DSL の括弧内トークンを IR フィールドへ写す。未知トークンは unknown に残す。 */
export function interpretNode(kindRaw: string, params: string | undefined): InterpretedNode {
  const unknown: string[] = [];
  const notes: string[] = [];
  let kind: NodeKind = KIND_ALIASES[kindRaw] ?? 'task';
  let eventThrow: boolean | undefined;
  let interrupting: boolean | undefined;
  let callProcess: boolean | undefined;
  let callTaskType: 'user' | 'manual' | 'script' | 'rule' | undefined;
  let eventSubTrigger: EventTrigger | undefined;
  let eventSubInterrupting: boolean | undefined;
  let loop: ActivityLoop | undefined;
  let compensation: boolean | undefined;
  let adhoc: boolean | undefined;
  let collection: boolean | undefined;
  const tokens: string[] = [];
  if (params !== undefined && params.trim() !== '') {
    for (const raw of params.split(',')) {
      const t = raw.trim().toLowerCase().replace(/-/g, '');
      if (t === '') continue;
      tokens.push(t);
    }
  }

  if (kindRaw === 'or') {
    kind = 'xor';
    return { kind, subtype: 'or', unknown, notes };
  }
  if (kindRaw === 'complex') {
    kind = 'xor';
    return { kind, subtype: 'complex', unknown, notes };
  }
  if (kindRaw === 'catch') {
    kind = 'mid';
    eventThrow = false;
  }
  if (kindRaw === 'throw') {
    kind = 'mid';
    eventThrow = true;
  }

  const take = (t: string): boolean => {
    const i = tokens.indexOf(t);
    if (i < 0) return false;
    tokens.splice(i, 1);
    return true;
  };

  if (isEventKind(kind) || kindRaw === 'catch' || kindRaw === 'throw') {
    if (take('throw')) eventThrow = true;
    if (take('catch')) eventThrow = false;
    if (take('nonint') || take('noninterrupting')) interrupting = false;
    if (take('int') || take('interrupting')) interrupting = true;
    let trigger: EventTrigger | undefined;
    if (take('parallelmultiple') || take('parallel')) trigger = 'parallelMultiple';
    for (const tr of EVENT_TRIGGERS) {
      if (tr === 'none' || tr === 'parallelMultiple') continue;
      if (take(tr)) {
        if (trigger && trigger !== tr) unknown.push(tr);
        else trigger = tr;
      }
    }
    if (kind === 'mid' && eventThrow === undefined) {
      eventThrow = trigger === undefined || trigger === 'none';
    }
    if (kind === 'start' || kind === 'boundary') eventThrow = undefined;
    if (kind === 'end') eventThrow = undefined;
    if (kind === 'boundary' && interrupting === undefined) interrupting = true;
    unknown.push(...tokens);
    let subtype: string | undefined = trigger && trigger !== 'none' ? trigger : undefined;
    if (!subtype && unknown[0]) subtype = unknown[0];
    return { kind, subtype, eventThrow, interrupting, unknown, notes };
  }

  if (kind === 'task') {
    if (take('global')) callProcess = false;
    if (take('process')) callProcess = true;
    const hasLoop = take('loop');
    const hasSequential = take('sequential') || take('seqmi');
    const hasParallel = take('parallel') || take('parmi');
    const loopCount = Number(hasLoop) + Number(hasSequential) + Number(hasParallel);
    if (loopCount > 1) notes.push('loop-mi-conflict');
    // Multi-instance を標準 Loop より優先し、MI 同士なら parallel を採用する。
    loop = hasParallel ? 'parallel' : hasSequential ? 'sequential' : hasLoop ? 'loop' : undefined;
    if (take('compensation') || take('comp')) compensation = true;
    if (take('adhoc')) adhoc = true;
    if (take('expanded')) notes.push('expanded');
    const wantsEventSub = take('eventsub') || take('event');
    let subtype: string | undefined;
    if (wantsEventSub) {
      take('sub');
      subtype = 'eventSub';
      if (take('nonint') || take('noninterrupting')) eventSubInterrupting = false;
      if (take('int') || take('interrupting')) eventSubInterrupting = true;
      if (take('parallelmultiple')) eventSubTrigger = 'parallelMultiple';
      for (const tr of EVENT_TRIGGERS) {
        if (tr === 'none' || tr === 'parallelMultiple') continue;
        if (take(tr)) {
          if (eventSubTrigger && eventSubTrigger !== tr) unknown.push(tr);
          else eventSubTrigger = tr;
        }
      }
      if (eventSubInterrupting === undefined) eventSubInterrupting = true;
    }
    const wantsCall = take('call');
    if (!wantsEventSub && wantsCall) {
      subtype = 'call';
      for (const t of ['user', 'manual', 'script', 'rule'] as const) {
        if (take(t)) {
          if (callTaskType) unknown.push(t);
          else callTaskType = t;
        }
      }
    } else if (!wantsEventSub) {
      for (const t of TASK_TYPES) {
        if (t === 'eventSub' || t === 'call') continue;
        if (take(t)) {
          if (subtype && subtype !== t) unknown.push(t);
          else if (!subtype) subtype = t;
        }
      }
    }
    if (!subtype && take('sub')) subtype = 'sub';
    unknown.push(...tokens);
    if (!subtype && unknown[0]) subtype = unknown[0];
    if (subtype === 'call' && callProcess === undefined) callProcess = true;
    return {
      kind, subtype, callProcess, callTaskType, eventSubTrigger, eventSubInterrupting,
      loop, compensation, adhoc, unknown, notes,
    };
  }

  if (kind === 'xor') {
    if (take('event')) return finishGw('xor', 'event', tokens, unknown, notes);
    if (take('or') || take('inclusive')) return finishGw('xor', 'or', tokens, unknown, notes);
    if (take('complex')) return finishGw('xor', 'complex', tokens, unknown, notes);
    if (take('parallel') || take('parallelevent')) {
      unknown.push(...tokens);
      return { kind: 'and', subtype: 'event', unknown, notes };
    }
    unknown.push(...tokens);
    if (unknown[0]) return { kind, subtype: unknown[0], unknown, notes };
    return { kind, unknown, notes };
  }

  if (kind === 'and') {
    if (take('event') || take('parallel') || take('parallelevent')) {
      unknown.push(...tokens);
      return { kind: 'and', subtype: 'event', unknown, notes };
    }
    unknown.push(...tokens);
    if (unknown[0]) return { kind, subtype: unknown[0], unknown, notes };
    return { kind, unknown, notes };
  }

  if (kind === 'doc') {
    if (take('collection')) collection = true;
    let subtype: string | undefined;
    for (const d of DOC_SUBTYPES) {
      if (take(d)) subtype = d;
    }
    unknown.push(...tokens);
    if (!subtype && unknown[0]) subtype = unknown[0];
    return { kind, subtype, collection, unknown, notes };
  }

  unknown.push(...tokens);
  return { kind, unknown, notes };
}

function finishGw(
  kind: NodeKind, subtype: string, tokens: string[], unknown: string[], notes: string[],
): InterpretedNode {
  unknown.push(...tokens);
  return { kind, subtype, unknown, notes };
}

export function applyInterpretation(n: IrNode, interp: InterpretedNode): void {
  n.kind = interp.kind;
  n.subtype = interp.subtype;
  n.eventThrow = interp.eventThrow;
  n.interrupting = interp.interrupting;
  n.callProcess = interp.callProcess;
  n.callTaskType = interp.callTaskType;
  n.eventSubTrigger = interp.eventSubTrigger;
  n.eventSubInterrupting = interp.eventSubInterrupting;
  n.loop = interp.loop;
  n.compensation = interp.compensation;
  n.adhoc = interp.adhoc;
  n.collection = interp.collection;
}

/** ノード宣言時の診断。lax は warning、compile が strict で error に昇格する。 */
export function diagnoseInterpretation(
  interp: InterpretedNode, kindRaw: string, id: string, line?: number,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = line !== undefined ? { line } : {};
  for (const tok of interp.unknown) {
    out.push({
      level: 'warning', code: 'W-311', ...at,
      message: `${id}: 未知の subtype トークン「${tok}」（${kindRaw}）。マーカーを描かず診断する`,
    });
  }
  if (interp.notes.includes('expanded')) {
    out.push({
      level: 'warning', code: 'W-315', ...at,
      message: `${id}: Expanded Sub-Process は未対応。崩した入れ子にはせず collapsed として扱う`,
    });
  }
  if (interp.notes.includes('loop-mi-conflict')) {
    out.push({
      level: 'warning', code: 'W-312', ...at,
      message: `${id}: Loop と Multi-instance は排他。Multi-instance を採用`,
    });
  }
  if (interp.kind === 'task' && interp.adhoc && interp.subtype !== 'sub' && interp.subtype !== 'eventSub' && interp.subtype !== 'transaction') {
    out.push({
      level: 'warning', code: 'W-312', ...at,
      message: `${id}: Ad-hoc マーカーは Sub-Process 向け。task に付けた Ad-hoc は診断対象`,
    });
  }
  return out;
}

export function legalEvent(slot: EventSlot, trigger: EventTrigger, interrupting?: boolean): boolean {
  if (slot === 'boundary' && interrupting === false) {
    return (LEGAL_BOUNDARY_NONINT as readonly string[]).includes(trigger);
  }
  return (LEGAL_EVENT[slot] as readonly string[]).includes(trigger);
}
