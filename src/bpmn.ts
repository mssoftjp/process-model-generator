// BPMN 2.0.2 Process / Collaboration の意味カタログと検証(再輸出)。
// 記号表と述語は bpmn-kinds.ts、DSL 解釈は bpmn-interpret.ts、IR 検証は validate-ir.ts。

export {
  EVENT_TRIGGERS, LEGAL_EVENT, LEGAL_BOUNDARY_NONINT, EVENT_SUB_START, EVENT_SUB_START_NONINT,
  TASK_TYPES, GW_XOR_SUBTYPES, GW_AND_SUBTYPES, DOC_SUBTYPES,
  isEventKind, isGatewayKind, isActivityKind, isAttachedBoundary,
  eventSlotOf, eventTriggerOf, isThrowEvent, isNonInterrupting,
  hasBottomActivityMarker, hasTopTaskIcon,
} from './bpmn-kinds.ts';
export type { EventSlot } from './bpmn-kinds.ts';
export { interpretNode, applyInterpretation, diagnoseInterpretation, legalEvent } from './bpmn-interpret.ts';
export type { InterpretedNode } from './bpmn-interpret.ts';
export { validateIr, applyStrictSemantics } from './validate-ir.ts';
