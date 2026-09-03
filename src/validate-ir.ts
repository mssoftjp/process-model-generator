// IR 全体の BPMN 合法性検証。未知・違法は警告として残し、strict では error へ昇格する。

import type { Diagnostic, Ir, IrNode } from './types.ts';
import { isDocLike } from './types.ts';
import { buildPoolIndex } from './pools.ts';
import { EVENT_SUB_START, EVENT_SUB_START_NONINT, EVENT_TRIGGER_SET, GW_XOR_SET, eventSlotOf, eventTriggerOf, isActivityKind, isEventKind, isGatewayKind } from './bpmn-kinds.ts';
import { legalEvent } from './bpmn-interpret.ts';

/** IR 全体の BPMN 合法性。未知・違法は警告として残し、別記号へは読み替えない。 */
export function validateIr(ir: Ir): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const poolOfNode = buildPoolIndex(ir).poolOfNode;

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
