// BPMN 2.0.2 の記号カタログ: イベントの位置と引き金、タスク種別、ゲートウェイ種別の表と、
// ノード種別の述語、Activity マーカーの有無。パーサ・正規化・描画が共通に参照する。

import type { ActivityLoop, EventTrigger, IrNode, NodeKind } from './types.ts';

export type EventSlot = 'start' | 'catch' | 'throw' | 'boundary' | 'end';

export const EVENT_TRIGGERS: readonly EventTrigger[] = [
  'none', 'message', 'timer', 'error', 'escalation', 'cancel',
  'compensation', 'conditional', 'link', 'signal', 'terminate',
  'multiple', 'parallelMultiple',
] as const;

export const EVENT_TRIGGER_SET = new Set<string>(EVENT_TRIGGERS);

/** BPMN 2.0.2 Table 10.84–10.93 相当。Event Sub-Process 専用の開始は別表。 */
export const LEGAL_EVENT: Record<EventSlot, readonly EventTrigger[]> = {
  start: ['none', 'message', 'timer', 'conditional', 'signal', 'multiple', 'parallelMultiple'],
  catch: ['message', 'timer', 'conditional', 'link', 'signal', 'multiple', 'parallelMultiple'],
  throw: ['none', 'message', 'escalation', 'compensation', 'link', 'signal', 'multiple'],
  end: ['none', 'message', 'error', 'escalation', 'cancel', 'compensation', 'signal', 'terminate', 'multiple'],
  boundary: [
    'message', 'timer', 'error', 'escalation', 'cancel', 'compensation',
    'conditional', 'signal', 'multiple', 'parallelMultiple',
  ],
};

/** 非割込み境界で合法なトリガ */
export const LEGAL_BOUNDARY_NONINT: readonly EventTrigger[] = [
  'message', 'timer', 'escalation', 'conditional', 'signal', 'multiple', 'parallelMultiple',
];

/** Event Sub-Process 開始としてだけ合法（展開サブプロセスは未対応） */
export const EVENT_SUB_START: readonly EventTrigger[] = [
  'message', 'timer', 'escalation', 'error', 'compensation', 'conditional',
  'signal', 'multiple', 'parallelMultiple',
];

export const EVENT_SUB_START_NONINT: readonly EventTrigger[] = [
  'message', 'timer', 'escalation', 'conditional', 'signal', 'multiple', 'parallelMultiple',
];

export const TASK_TYPES = [
  'user', 'service', 'rule', 'script', 'send', 'receive', 'manual',
  'call', 'sub', 'transaction', 'eventSub',
] as const;

export const GW_XOR_SUBTYPES = ['event', 'or', 'complex'] as const;
export const GW_AND_SUBTYPES = ['event'] as const;
export const DOC_SUBTYPES = ['input', 'output', 'message'] as const;

export const GW_XOR_SET = new Set<string>(GW_XOR_SUBTYPES);

export const isEventKind = (k: NodeKind): boolean =>
  k === 'start' || k === 'end' || k === 'mid' || k === 'boundary';

export const isGatewayKind = (k: NodeKind): boolean => k === 'xor' || k === 'and';

export const isActivityKind = (k: NodeKind): boolean => k === 'task';

export const isAttachedBoundary = (n: { kind: NodeKind; attachedTo?: string }): boolean =>
  n.kind === 'boundary' && !!n.attachedTo;

export function eventSlotOf(n: IrNode): EventSlot | undefined {
  if (n.kind === 'start') return 'start';
  if (n.kind === 'end') return 'end';
  if (n.kind === 'boundary') return 'boundary';
  if (n.kind === 'mid') return n.eventThrow ? 'throw' : 'catch';
  return undefined;
}

export function eventTriggerOf(n: IrNode): EventTrigger {
  if (!n.subtype) return 'none';
  return EVENT_TRIGGER_SET.has(n.subtype) ? n.subtype as EventTrigger : 'none';
}

export function isThrowEvent(n: { kind: NodeKind; eventThrow?: boolean }): boolean {
  if (n.kind === 'end') return true;
  if (n.kind === 'start' || n.kind === 'boundary') return false;
  if (n.kind === 'mid') return n.eventThrow === true;
  return false;
}

export function isNonInterrupting(n: IrNode): boolean {
  return n.interrupting === false;
}

export function hasBottomActivityMarker(n: {
  subtype?: string; callProcess?: boolean; loop?: ActivityLoop; compensation?: boolean; adhoc?: boolean;
}): boolean {
  if (n.loop || n.compensation || n.adhoc) return true;
  if (n.subtype === 'sub' || n.subtype === 'transaction' || n.subtype === 'eventSub') return true;
  if (n.subtype === 'call' && n.callProcess !== false) return true;
  return false;
}

export function hasTopTaskIcon(n: {
  subtype?: string; callProcess?: boolean; callTaskType?: string; eventSubTrigger?: EventTrigger;
}): boolean {
  if (n.subtype === 'call' && n.callProcess === false && n.callTaskType) return true;
  if (n.subtype === 'eventSub' && n.eventSubTrigger) return true;
  const s = n.subtype;
  return s === 'user' || s === 'service' || s === 'rule' || s === 'script'
    || s === 'send' || s === 'receive' || s === 'manual';
}
