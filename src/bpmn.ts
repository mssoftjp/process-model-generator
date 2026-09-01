// BPMN 2.0.2 Process / Collaboration の意味カタログと検証。
// パーサが構文を IR に写し、ここで合法な位置・組合せを判定する。
// 描画はマーカーを正確に出し、未知・違法は黙って別記号へ読み替えない。

import type {
  ActivityLoop, Diagnostic, EventTrigger, Ir, IrNode, NodeKind,
} from './types.ts';
import { isDocLike } from './types.ts';

export type EventSlot = 'start' | 'catch' | 'throw' | 'boundary' | 'end';

export const EVENT_TRIGGERS: readonly EventTrigger[] = [
  'none', 'message', 'timer', 'error', 'escalation', 'cancel',
  'compensation', 'conditional', 'link', 'signal', 'terminate',
  'multiple', 'parallelMultiple',
] as const;

const EVENT_TRIGGER_SET = new Set<string>(EVENT_TRIGGERS);

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

const GW_XOR_SET = new Set<string>(GW_XOR_SUBTYPES);

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

/** IR 全体の BPMN 合法性。未知・違法は警告として残し、別記号へは読み替えない。 */
export function validateIr(ir: Ir): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const lanePool = new Map(ir.lanes.map((lane) => [lane.id, lane.pool]));
  const poolOfNode = (id: string): string | undefined => {
    const node = byId.get(id);
    return node ? lanePool.get(node.lane) : undefined;
  };

  // レーンは工程の置き場所ではなく役割。同じプールで「役割（工程）」だけを増やす
  // 典型的な疑似レーンを、言語に依存しない表示名の構造でレビュー対象にする。
  for (const lane of ir.lanes) {
    const match = /^(.*?)\s*[（(][^()（）]+[)）]\s*$/u.exec(lane.label);
    const base = match?.[1]?.trim();
    if (!base) continue;
    const sibling = ir.lanes.find((candidate) =>
      candidate.id !== lane.id && candidate.pool === lane.pool && candidate.label.trim() === base,
    );
    if (!sibling) continue;
    out.push({
      level: 'warning', code: 'W-107',
      message: `${lane.id}「${lane.label}」は ${sibling.id}「${sibling.label}」と同じ役割の疑似レーンか確認する。工程や結果確認のためだけなら一つのレーンへ戻す`,
    });
  }

  for (const n of ir.nodes) {
    if (isEventKind(n.kind)) {
      const slot = eventSlotOf(n)!;
      const trigger = eventTriggerOf(n);
      if (!n.subtype || EVENT_TRIGGER_SET.has(n.subtype)) {
        if (!legalEvent(slot, trigger, n.interrupting)) {
        // Event Sub-Process 専用開始は別メッセージ
          if (n.kind === 'start' && (EVENT_SUB_START as readonly string[]).includes(trigger)) {
            out.push({
              level: 'warning', code: 'W-310',
              message: `${n.id}: start(${trigger}) は Event Sub-Process 開始向け。展開 Event Sub-Process は未対応のため違法な位置として診断する`,
            });
          } else {
            out.push({
              level: 'warning', code: 'W-310',
              message: `${n.id}: ${slot} 位置に ${trigger} イベントは BPMN 2.0.2 で違法`,
            });
          }
        }
      }
      if (n.kind === 'start' && n.interrupting === false) {
        if (!(EVENT_SUB_START_NONINT as readonly string[]).includes(trigger)) {
          out.push({
            level: 'warning', code: 'W-310',
            message: `${n.id}: 非割込み開始に ${trigger} は違法`,
          });
        } else {
          out.push({
            level: 'warning', code: 'W-310',
            message: `${n.id}: 非割込み開始は Event Sub-Process 向け。展開は未対応`,
          });
        }
      }
      if (n.kind === 'end' && trigger === 'cancel') {
        out.push({
          level: 'warning', code: 'W-310',
          message: `${n.id}: Cancel End は Transaction 内部専用。フラットな DSL ではその文脈を表現できない`,
        });
      }
    }
    if (n.kind === 'xor' && n.subtype && !GW_XOR_SET.has(n.subtype)) {
      out.push({
        level: 'warning', code: 'W-313',
        message: `${n.id}: 未知のゲートウェイ subtype「${n.subtype}」`,
      });
    }
    if (n.kind === 'and' && n.subtype && n.subtype !== 'event') {
      out.push({
        level: 'warning', code: 'W-313',
        message: `${n.id}: 未知のゲートウェイ subtype「${n.subtype}」`,
      });
    }
    if (n.kind === 'task') {
      if (n.subtype === 'call' && n.callTaskType && n.callProcess !== false) {
        out.push({
          level: 'warning', code: 'W-312',
          message: `${n.id}: タスク種別マーカーは Global Task を呼ぶ Call Activity にだけ付けられる`,
        });
      }
      if (n.subtype === 'eventSub') {
        const tr = n.eventSubTrigger;
        if (!tr || !(EVENT_SUB_START as readonly string[]).includes(tr)) {
          out.push({
            level: 'warning', code: 'W-310',
            message: `${n.id}: collapsed Event Sub-Process には合法な Start Event trigger が必要`,
          });
        } else if (n.eventSubInterrupting === false &&
          !(EVENT_SUB_START_NONINT as readonly string[]).includes(tr)) {
          out.push({
            level: 'warning', code: 'W-310',
            message: `${n.id}: 非割込み Event Sub-Process 開始に ${tr} は違法`,
          });
        }
      }
    }
    if (n.kind === 'boundary') {
      if (!n.attachedTo) {
        out.push({
          level: 'warning', code: 'W-314',
          message: `${n.id}: 境界イベントに @対象 が無い。独立した中間イベントとしては描かない`,
        });
      } else {
        const host = byId.get(n.attachedTo);
        if (!host) {
          out.push({
            level: 'warning', code: 'W-314',
            message: `${n.id}: 境界イベントの対象 ${n.attachedTo} が存在しない`,
          });
        } else if (!isActivityKind(host.kind)) {
          out.push({
            level: 'warning', code: 'W-314',
            message: `${n.id}: 境界イベントの対象 ${n.attachedTo} は Activity ではない`,
          });
        } else if (eventTriggerOf(n) === 'cancel' && host.subtype !== 'transaction') {
          out.push({
            level: 'warning', code: 'W-310',
            message: `${n.id}: Cancel Boundary は Transaction にだけ付けられる（対象: ${n.attachedTo}）`,
          });
        }
      }
    }
  }
  const defaultCount = new Map<string, number>();
  for (const e of ir.edges) {
    if (e.kind !== 'seq') continue;
    if (e.isDefault && e.isConditional) {
      out.push({
        level: 'warning', code: 'W-316',
        message: `辺 ${e.from} -> ${e.to}: Default Flow に条件を付けられない`,
      });
    }
    const src = byId.get(e.from);
    if (e.isDefault) {
      defaultCount.set(e.from, (defaultCount.get(e.from) ?? 0) + 1);
      const legalSource = src?.kind === 'task' ||
        (src?.kind === 'xor' && (src.subtype === undefined || src.subtype === 'or' || src.subtype === 'complex'));
      if (!legalSource) {
        out.push({
          level: 'warning', code: 'W-316',
          message: `辺 ${e.from} -> ${e.to}: この始点に Default Flow は定義できない`,
        });
      }
    }
    if (e.isConditional && src?.kind !== 'task') {
      out.push({
        level: 'warning', code: 'W-316',
        message: `辺 ${e.from} -> ${e.to}: Conditional Flow は Activity 起点でなければならない`,
      });
    }
  }
  for (const [source, count] of defaultCount) {
    if (count > 1) {
      out.push({
        level: 'warning', code: 'W-316',
        message: `${source}: Default Flow は一つだけ定義できる（${count} 本）`,
      });
    }
  }

  // Data Association は Activity/Event とデータ要素の間に置く。ゲートウェイは
  // データを読み書きせず、Data Object は参加者プールを越えて共有されない。
  // 自動修復では所有者を発明するため、初回はレビュー警告に留める。
  for (const edge of ir.edges) {
    if (edge.kind !== 'assoc' || (edge.assocKind !== undefined && edge.assocKind !== 'data')) continue;
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (source && target && (isGatewayKind(source.kind) || isGatewayKind(target.kind))) {
      out.push({
        level: 'warning', code: 'W-208',
        message: `データ関連 ${edge.from} -.-> ${edge.to} の端点にゲートウェイがある。データを読むまたは書く活動へ付け替える`,
      });
    }
    if (!source || !target || source.kind === 'store' || target.kind === 'store') continue;
    if (source.kind !== 'doc' && target.kind !== 'doc') continue;
    const sourcePool = poolOfNode(source.id);
    const targetPool = poolOfNode(target.id);
    if (sourcePool === undefined || targetPool === undefined || sourcePool === targetPool) continue;
    out.push({
      level: 'warning', code: 'W-209',
      message: `Data Object を参加者プール越しに関連付けている（${edge.from} -.-> ${edge.to}）。交換内容は Message Flow のラベルに置き、受領側で管理する doc を別に宣言する`,
    });
  }

  for (const e of ir.edges) {
    if (e.kind !== 'seq') continue;
    const source = byId.get(e.from);
    const target = byId.get(e.to);
    if (target?.kind === 'start') {
      out.push({
        level: 'warning', code: 'W-225',
        message: `開始イベント ${target.id} にシーケンス ${e.from} -> ${e.to} が入っている。戻り先は開始後の活動または合流点にする`,
      });
    }
    if (source?.kind === 'end') {
      out.push({
        level: 'warning', code: 'W-225',
        message: `終了イベント ${source.id} からシーケンス ${e.from} -> ${e.to} が出ている。終了前の活動から分岐する`,
      });
    }
  }

  // メッセージ catch は、見た目だけでなく実際の Message Flow の着地点でなければならない。
  // start(message) や Receive Task は単独プロセスで相手を省略できるため、ここでは狭く catch だけを見る。
  for (const n of ir.nodes) {
    if (n.kind !== 'mid' || n.subtype !== 'message' || n.eventThrow === true) continue;
    if (ir.edges.some((e) => e.kind === 'msg' && e.to === n.id)) continue;
    out.push({
      level: 'warning', code: 'W-235',
      message: `${n.id} は catch(message) だが着地する Message Flow がない。外部応答なら相手プールから ~> を接続し、同一プール内の引継ぎなら通常の task と sequence flow を使う`,
    });
  }

  // 条件を並べただけで挙動が変わらない菱形は、分岐として読者を誤解させる。
  for (const n of ir.nodes) {
    if (!isGatewayKind(n.kind)) continue;
    const outs = ir.edges.filter((e) => e.kind === 'seq' && e.from === n.id);
    if (outs.length < 2 || new Set(outs.map((e) => e.to)).size !== 1) continue;
    out.push({
      level: 'warning', code: 'W-237',
      message: `${n.id} の ${outs.length} 分岐はすべて ${outs[0]!.to} へ直結し、業務上の挙動を分けていない。差が説明だけなら note、待機や処理が異なるなら各枝へ明示する`,
    });
  }

  // 一方向通信をレビュー対象として列挙する。通知は合法なので strict でも warning のまま。
  // 返信判定は、同じ sequence path 上の明示的な受信と既送信の残高を見る。
  // これにより、一度の往復後に始まる第二の照会を古い返信で抑止しない。
  // 黒箱プールからの受信は送信活動を持たず対応関係を示せないため、返信残高に数えない。
  const seqOut = new Map<string, string[]>();
  const seqIn = new Map<string, string[]>();
  for (const edge of ir.edges) {
    if (edge.kind !== 'seq') continue;
    const list = seqOut.get(edge.from) ?? [];
    list.push(edge.to);
    seqOut.set(edge.from, list);
    const incoming = seqIn.get(edge.to) ?? [];
    incoming.push(edge.from);
    seqIn.set(edge.to, incoming);
  }
  const hasReplyCredit = (sourceId: string, sourcePool: string | undefined, targetPool: string): boolean => {
    if (sourcePool === undefined) return false;
    const poolNodes = ir.nodes.filter((node) => poolOfNode(node.id) === sourcePool);
    const roots = poolNodes.filter((node) =>
      (seqIn.get(node.id) ?? []).every((from) => poolOfNode(from) !== sourcePool),
    );
    const relevantMessages = ir.edges.filter((candidate) => {
      if (candidate.kind !== 'msg') return false;
      const fromPool = candidate.fromPool ? candidate.from : poolOfNode(candidate.from);
      const toPool = candidate.toPool ? candidate.to : poolOfNode(candidate.to);
      return (fromPool === sourcePool && toPool === targetPool) ||
        (!candidate.fromPool && fromPool === targetPool && toPool === sourcePool);
    });
    const bound = Math.max(1, relevantMessages.length + 1);
    const clamp = (value: number): number => Math.max(-bound, Math.min(bound, value));
    const queue = roots.map((node) => ({ id: node.id, balance: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const state = queue.shift()!;
      const stateKey = `${state.id}\u0000${state.balance}`;
      if (seen.has(stateKey)) continue;
      seen.add(stateKey);
      const received = relevantMessages.filter((candidate) =>
        candidate.kind === 'msg' && !candidate.fromPool && candidate.to === state.id &&
        poolOfNode(candidate.from) === targetPool,
      ).length;
      const available = clamp(state.balance + received);
      if (state.id === sourceId && available > 0) return true;
      const sent = relevantMessages.filter((candidate) =>
        candidate.kind === 'msg' && !candidate.fromPool && candidate.from === state.id &&
        (candidate.toPool ? candidate.to : poolOfNode(candidate.to)) === targetPool,
      ).length;
      const nextBalance = clamp(available - sent);
      for (const next of seqOut.get(state.id) ?? []) {
        if (poolOfNode(next) === sourcePool) queue.push({ id: next, balance: nextBalance });
      }
    }
    return false;
  };
  const warnedMessages = new Set<string>();
  for (const edge of ir.edges) {
    if (edge.kind !== 'msg' || edge.fromPool) continue;
    const sourcePool = poolOfNode(edge.from);
    const targetPool = edge.toPool ? edge.to : poolOfNode(edge.to);
    if (targetPool === undefined || targetPool === sourcePool) continue;
    const key = `${edge.from}\u0000${targetPool}`;
    if (warnedMessages.has(key)) continue;
    const reachable = new Set<string>();
    const queue = [edge.from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id) || poolOfNode(id) !== sourcePool) continue;
      reachable.add(id);
      queue.push(...(seqOut.get(id) ?? []));
    }
    const hasReply = ir.edges.some((candidate) => {
      if (candidate.kind !== 'msg' || candidate.toPool || !reachable.has(candidate.to)) return false;
      const replyPool = candidate.fromPool ? candidate.from : poolOfNode(candidate.from);
      return replyPool === targetPool;
    });
    const isReply = hasReplyCredit(edge.from, sourcePool, targetPool);
    if (hasReply || isReply) continue;
    warnedMessages.add(key);
    out.push({
      level: 'warning', code: 'W-236',
      message: `${edge.from} からプール ${targetPool} へのメッセージに、送信活動または後続へ戻る Message Flow がない。一方向通知か、回答待ちの欠落かを確認する`,
    });
  }

  for (const artifact of ir.nodes.filter((n) => n.kind === 'doc' || n.kind === 'store')) {
    const related = ir.edges
      .filter((e) => e.kind === 'assoc' && (e.from === artifact.id || e.to === artifact.id))
      .map((e) => byId.get(e.from === artifact.id ? e.to : e.from))
      .filter((n): n is IrNode => n !== undefined && !isDocLike(n.kind));
    if (related.some((n) => n.lane === artifact.lane)) continue;
    out.push({
      level: 'warning', code: 'W-105',
      message: `${artifact.id} の宣言レーンに関連する活動がない。作成・維持・統制の責任レーンを確認する`,
    });
  }
  return out;
}

const STRICT_CODES = new Set([
  'W-207',
  'W-225',
  'W-310', 'W-311', 'W-312', 'W-313', 'W-314', 'W-315', 'W-316',
]);

/** strict では BPMN 合法性の警告を error に昇格する */
export function applyStrictSemantics(diags: Diagnostic[], strict: boolean): Diagnostic[] {
  if (!strict) return diags;
  return diags.map((d) => {
    if (d.level === 'warning' && STRICT_CODES.has(d.code)) {
      return { ...d, level: 'error', code: `E-${d.code.slice(2)}` };
    }
    return d;
  });
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
