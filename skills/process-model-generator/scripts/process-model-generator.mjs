#!/usr/bin/env node

// src/cli.ts
import { readFileSync as readFileSync2, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// src/types.ts
var isDocLike = (k) => k === "doc" || k === "store" || k === "note" || k === "group";

// src/bpmn.ts
var EVENT_TRIGGERS = [
  "none",
  "message",
  "timer",
  "error",
  "escalation",
  "cancel",
  "compensation",
  "conditional",
  "link",
  "signal",
  "terminate",
  "multiple",
  "parallelMultiple"
];
var EVENT_TRIGGER_SET = new Set(EVENT_TRIGGERS);
var LEGAL_EVENT = {
  start: ["none", "message", "timer", "conditional", "signal", "multiple", "parallelMultiple"],
  catch: ["message", "timer", "conditional", "link", "signal", "multiple", "parallelMultiple"],
  throw: ["none", "message", "escalation", "compensation", "link", "signal", "multiple"],
  end: ["none", "message", "error", "escalation", "cancel", "compensation", "signal", "terminate", "multiple"],
  boundary: [
    "message",
    "timer",
    "error",
    "escalation",
    "cancel",
    "compensation",
    "conditional",
    "signal",
    "multiple",
    "parallelMultiple"
  ]
};
var LEGAL_BOUNDARY_NONINT = [
  "message",
  "timer",
  "escalation",
  "conditional",
  "signal",
  "multiple",
  "parallelMultiple"
];
var EVENT_SUB_START = [
  "message",
  "timer",
  "escalation",
  "error",
  "compensation",
  "conditional",
  "signal",
  "multiple",
  "parallelMultiple"
];
var EVENT_SUB_START_NONINT = [
  "message",
  "timer",
  "escalation",
  "conditional",
  "signal",
  "multiple",
  "parallelMultiple"
];
var TASK_TYPES = [
  "user",
  "service",
  "rule",
  "script",
  "send",
  "receive",
  "manual",
  "call",
  "sub",
  "transaction",
  "eventSub"
];
var GW_XOR_SUBTYPES = ["event", "or", "complex"];
var DOC_SUBTYPES = ["input", "output", "message"];
var GW_XOR_SET = new Set(GW_XOR_SUBTYPES);
var isEventKind = (k) => k === "start" || k === "end" || k === "mid" || k === "boundary";
var isGatewayKind = (k) => k === "xor" || k === "and";
var isActivityKind = (k) => k === "task";
var isAttachedBoundary = (n) => n.kind === "boundary" && !!n.attachedTo;
function eventSlotOf(n) {
  if (n.kind === "start") return "start";
  if (n.kind === "end") return "end";
  if (n.kind === "boundary") return "boundary";
  if (n.kind === "mid") return n.eventThrow ? "throw" : "catch";
  return void 0;
}
function eventTriggerOf(n) {
  if (!n.subtype) return "none";
  return EVENT_TRIGGER_SET.has(n.subtype) ? n.subtype : "none";
}
function isThrowEvent(n) {
  if (n.kind === "end") return true;
  if (n.kind === "start" || n.kind === "boundary") return false;
  if (n.kind === "mid") return n.eventThrow === true;
  return false;
}
var KIND_ALIASES = {
  task: "task",
  xor: "xor",
  and: "and",
  start: "start",
  end: "end",
  doc: "doc",
  mid: "mid",
  store: "store",
  note: "note",
  boundary: "boundary",
  group: "group"
};
function interpretNode(kindRaw, params) {
  const unknown = [];
  const notes = [];
  let kind = KIND_ALIASES[kindRaw] ?? "task";
  let eventThrow;
  let interrupting;
  let callProcess;
  let callTaskType;
  let eventSubTrigger;
  let eventSubInterrupting;
  let loop;
  let compensation;
  let adhoc;
  let collection;
  const tokens = [];
  if (params !== void 0 && params.trim() !== "") {
    for (const raw of params.split(",")) {
      const t = raw.trim().toLowerCase().replace(/-/g, "");
      if (t === "") continue;
      tokens.push(t);
    }
  }
  if (kindRaw === "or") {
    kind = "xor";
    return { kind, subtype: "or", unknown, notes };
  }
  if (kindRaw === "complex") {
    kind = "xor";
    return { kind, subtype: "complex", unknown, notes };
  }
  if (kindRaw === "catch") {
    kind = "mid";
    eventThrow = false;
  }
  if (kindRaw === "throw") {
    kind = "mid";
    eventThrow = true;
  }
  const take = (t) => {
    const i = tokens.indexOf(t);
    if (i < 0) return false;
    tokens.splice(i, 1);
    return true;
  };
  if (isEventKind(kind) || kindRaw === "catch" || kindRaw === "throw") {
    if (take("throw")) eventThrow = true;
    if (take("catch")) eventThrow = false;
    if (take("nonint") || take("noninterrupting")) interrupting = false;
    if (take("int") || take("interrupting")) interrupting = true;
    let trigger;
    if (take("parallelmultiple") || take("parallel")) trigger = "parallelMultiple";
    for (const tr of EVENT_TRIGGERS) {
      if (tr === "none" || tr === "parallelMultiple") continue;
      if (take(tr)) {
        if (trigger && trigger !== tr) unknown.push(tr);
        else trigger = tr;
      }
    }
    if (kind === "mid" && eventThrow === void 0) {
      eventThrow = trigger === void 0 || trigger === "none";
    }
    if (kind === "start" || kind === "boundary") eventThrow = void 0;
    if (kind === "end") eventThrow = void 0;
    if (kind === "boundary" && interrupting === void 0) interrupting = true;
    unknown.push(...tokens);
    let subtype = trigger && trigger !== "none" ? trigger : void 0;
    if (!subtype && unknown[0]) subtype = unknown[0];
    return { kind, subtype, eventThrow, interrupting, unknown, notes };
  }
  if (kind === "task") {
    if (take("global")) callProcess = false;
    if (take("process")) callProcess = true;
    const hasLoop = take("loop");
    const hasSequential = take("sequential") || take("seqmi");
    const hasParallel = take("parallel") || take("parmi");
    const loopCount = Number(hasLoop) + Number(hasSequential) + Number(hasParallel);
    if (loopCount > 1) notes.push("loop-mi-conflict");
    loop = hasParallel ? "parallel" : hasSequential ? "sequential" : hasLoop ? "loop" : void 0;
    if (take("compensation") || take("comp")) compensation = true;
    if (take("adhoc")) adhoc = true;
    if (take("expanded")) notes.push("expanded");
    const wantsEventSub = take("eventsub") || take("event");
    let subtype;
    if (wantsEventSub) {
      take("sub");
      subtype = "eventSub";
      if (take("nonint") || take("noninterrupting")) eventSubInterrupting = false;
      if (take("int") || take("interrupting")) eventSubInterrupting = true;
      if (take("parallelmultiple")) eventSubTrigger = "parallelMultiple";
      for (const tr of EVENT_TRIGGERS) {
        if (tr === "none" || tr === "parallelMultiple") continue;
        if (take(tr)) {
          if (eventSubTrigger && eventSubTrigger !== tr) unknown.push(tr);
          else eventSubTrigger = tr;
        }
      }
      if (eventSubInterrupting === void 0) eventSubInterrupting = true;
    }
    const wantsCall = take("call");
    if (!wantsEventSub && wantsCall) {
      subtype = "call";
      for (const t of ["user", "manual", "script", "rule"]) {
        if (take(t)) {
          if (callTaskType) unknown.push(t);
          else callTaskType = t;
        }
      }
    } else if (!wantsEventSub) {
      for (const t of TASK_TYPES) {
        if (t === "eventSub" || t === "call") continue;
        if (take(t)) {
          if (subtype && subtype !== t) unknown.push(t);
          else if (!subtype) subtype = t;
        }
      }
    }
    if (!subtype && take("sub")) subtype = "sub";
    unknown.push(...tokens);
    if (!subtype && unknown[0]) subtype = unknown[0];
    if (subtype === "call" && callProcess === void 0) callProcess = true;
    return {
      kind,
      subtype,
      callProcess,
      callTaskType,
      eventSubTrigger,
      eventSubInterrupting,
      loop,
      compensation,
      adhoc,
      unknown,
      notes
    };
  }
  if (kind === "xor") {
    if (take("event")) return finishGw("xor", "event", tokens, unknown, notes);
    if (take("or") || take("inclusive")) return finishGw("xor", "or", tokens, unknown, notes);
    if (take("complex")) return finishGw("xor", "complex", tokens, unknown, notes);
    if (take("parallel") || take("parallelevent")) {
      unknown.push(...tokens);
      return { kind: "and", subtype: "event", unknown, notes };
    }
    unknown.push(...tokens);
    if (unknown[0]) return { kind, subtype: unknown[0], unknown, notes };
    return { kind, unknown, notes };
  }
  if (kind === "and") {
    if (take("event") || take("parallel") || take("parallelevent")) {
      unknown.push(...tokens);
      return { kind: "and", subtype: "event", unknown, notes };
    }
    unknown.push(...tokens);
    if (unknown[0]) return { kind, subtype: unknown[0], unknown, notes };
    return { kind, unknown, notes };
  }
  if (kind === "doc") {
    if (take("collection")) collection = true;
    let subtype;
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
function finishGw(kind, subtype, tokens, unknown, notes) {
  unknown.push(...tokens);
  return { kind, subtype, unknown, notes };
}
function applyInterpretation(n, interp) {
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
function diagnoseInterpretation(interp, kindRaw, id, line) {
  const out = [];
  const at = line !== void 0 ? { line } : {};
  for (const tok of interp.unknown) {
    out.push({
      level: "warning",
      code: "W-311",
      ...at,
      message: `${id}: \u672A\u77E5\u306E subtype \u30C8\u30FC\u30AF\u30F3\u300C${tok}\u300D\uFF08${kindRaw}\uFF09\u3002\u30DE\u30FC\u30AB\u30FC\u3092\u63CF\u304B\u305A\u8A3A\u65AD\u3059\u308B`
    });
  }
  if (interp.notes.includes("expanded")) {
    out.push({
      level: "warning",
      code: "W-315",
      ...at,
      message: `${id}: Expanded Sub-Process \u306F\u672A\u5BFE\u5FDC\u3002\u5D29\u3057\u305F\u5165\u308C\u5B50\u306B\u306F\u305B\u305A collapsed \u3068\u3057\u3066\u6271\u3046`
    });
  }
  if (interp.notes.includes("loop-mi-conflict")) {
    out.push({
      level: "warning",
      code: "W-312",
      ...at,
      message: `${id}: Loop \u3068 Multi-instance \u306F\u6392\u4ED6\u3002Multi-instance \u3092\u63A1\u7528`
    });
  }
  if (interp.kind === "task" && interp.adhoc && interp.subtype !== "sub" && interp.subtype !== "eventSub" && interp.subtype !== "transaction") {
    out.push({
      level: "warning",
      code: "W-312",
      ...at,
      message: `${id}: Ad-hoc \u30DE\u30FC\u30AB\u30FC\u306F Sub-Process \u5411\u3051\u3002task \u306B\u4ED8\u3051\u305F Ad-hoc \u306F\u8A3A\u65AD\u5BFE\u8C61`
    });
  }
  return out;
}
function legalEvent(slot, trigger, interrupting) {
  if (slot === "boundary" && interrupting === false) {
    return LEGAL_BOUNDARY_NONINT.includes(trigger);
  }
  return LEGAL_EVENT[slot].includes(trigger);
}
function validateIr(ir) {
  const out = [];
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const lanePool = new Map(ir.lanes.map((lane) => [lane.id, lane.pool]));
  const poolOfNode = (id) => {
    const node = byId.get(id);
    return node ? lanePool.get(node.lane) : void 0;
  };
  for (const lane of ir.lanes) {
    const match = /^(.*?)\s*[（(][^()（）]+[)）]\s*$/u.exec(lane.label);
    const base = match?.[1]?.trim();
    if (!base) continue;
    const sibling = ir.lanes.find(
      (candidate) => candidate.id !== lane.id && candidate.pool === lane.pool && candidate.label.trim() === base
    );
    if (!sibling) continue;
    out.push({
      level: "warning",
      code: "W-107",
      message: `${lane.id}\u300C${lane.label}\u300D\u306F ${sibling.id}\u300C${sibling.label}\u300D\u3068\u540C\u3058\u5F79\u5272\u306E\u7591\u4F3C\u30EC\u30FC\u30F3\u304B\u78BA\u8A8D\u3059\u308B\u3002\u5DE5\u7A0B\u3084\u7D50\u679C\u78BA\u8A8D\u306E\u305F\u3081\u3060\u3051\u306A\u3089\u4E00\u3064\u306E\u30EC\u30FC\u30F3\u3078\u623B\u3059`
    });
  }
  for (const n of ir.nodes) {
    if (isEventKind(n.kind)) {
      const slot = eventSlotOf(n);
      const trigger = eventTriggerOf(n);
      if (!n.subtype || EVENT_TRIGGER_SET.has(n.subtype)) {
        if (!legalEvent(slot, trigger, n.interrupting)) {
          if (n.kind === "start" && EVENT_SUB_START.includes(trigger)) {
            out.push({
              level: "warning",
              code: "W-310",
              message: `${n.id}: start(${trigger}) \u306F Event Sub-Process \u958B\u59CB\u5411\u3051\u3002\u5C55\u958B Event Sub-Process \u306F\u672A\u5BFE\u5FDC\u306E\u305F\u3081\u9055\u6CD5\u306A\u4F4D\u7F6E\u3068\u3057\u3066\u8A3A\u65AD\u3059\u308B`
            });
          } else {
            out.push({
              level: "warning",
              code: "W-310",
              message: `${n.id}: ${slot} \u4F4D\u7F6E\u306B ${trigger} \u30A4\u30D9\u30F3\u30C8\u306F BPMN 2.0.2 \u3067\u9055\u6CD5`
            });
          }
        }
      }
      if (n.kind === "start" && n.interrupting === false) {
        if (!EVENT_SUB_START_NONINT.includes(trigger)) {
          out.push({
            level: "warning",
            code: "W-310",
            message: `${n.id}: \u975E\u5272\u8FBC\u307F\u958B\u59CB\u306B ${trigger} \u306F\u9055\u6CD5`
          });
        } else {
          out.push({
            level: "warning",
            code: "W-310",
            message: `${n.id}: \u975E\u5272\u8FBC\u307F\u958B\u59CB\u306F Event Sub-Process \u5411\u3051\u3002\u5C55\u958B\u306F\u672A\u5BFE\u5FDC`
          });
        }
      }
      if (n.kind === "end" && trigger === "cancel") {
        out.push({
          level: "warning",
          code: "W-310",
          message: `${n.id}: Cancel End \u306F Transaction \u5185\u90E8\u5C02\u7528\u3002\u30D5\u30E9\u30C3\u30C8\u306A DSL \u3067\u306F\u305D\u306E\u6587\u8108\u3092\u8868\u73FE\u3067\u304D\u306A\u3044`
        });
      }
    }
    if (n.kind === "xor" && n.subtype && !GW_XOR_SET.has(n.subtype)) {
      out.push({
        level: "warning",
        code: "W-313",
        message: `${n.id}: \u672A\u77E5\u306E\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4 subtype\u300C${n.subtype}\u300D`
      });
    }
    if (n.kind === "and" && n.subtype && n.subtype !== "event") {
      out.push({
        level: "warning",
        code: "W-313",
        message: `${n.id}: \u672A\u77E5\u306E\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4 subtype\u300C${n.subtype}\u300D`
      });
    }
    if (n.kind === "task") {
      if (n.subtype === "call" && n.callTaskType && n.callProcess !== false) {
        out.push({
          level: "warning",
          code: "W-312",
          message: `${n.id}: \u30BF\u30B9\u30AF\u7A2E\u5225\u30DE\u30FC\u30AB\u30FC\u306F Global Task \u3092\u547C\u3076 Call Activity \u306B\u3060\u3051\u4ED8\u3051\u3089\u308C\u308B`
        });
      }
      if (n.subtype === "eventSub") {
        const tr = n.eventSubTrigger;
        if (!tr || !EVENT_SUB_START.includes(tr)) {
          out.push({
            level: "warning",
            code: "W-310",
            message: `${n.id}: collapsed Event Sub-Process \u306B\u306F\u5408\u6CD5\u306A Start Event trigger \u304C\u5FC5\u8981`
          });
        } else if (n.eventSubInterrupting === false && !EVENT_SUB_START_NONINT.includes(tr)) {
          out.push({
            level: "warning",
            code: "W-310",
            message: `${n.id}: \u975E\u5272\u8FBC\u307F Event Sub-Process \u958B\u59CB\u306B ${tr} \u306F\u9055\u6CD5`
          });
        }
      }
    }
    if (n.kind === "boundary") {
      if (!n.attachedTo) {
        out.push({
          level: "warning",
          code: "W-314",
          message: `${n.id}: \u5883\u754C\u30A4\u30D9\u30F3\u30C8\u306B @\u5BFE\u8C61 \u304C\u7121\u3044\u3002\u72EC\u7ACB\u3057\u305F\u4E2D\u9593\u30A4\u30D9\u30F3\u30C8\u3068\u3057\u3066\u306F\u63CF\u304B\u306A\u3044`
        });
      } else {
        const host = byId.get(n.attachedTo);
        if (!host) {
          out.push({
            level: "warning",
            code: "W-314",
            message: `${n.id}: \u5883\u754C\u30A4\u30D9\u30F3\u30C8\u306E\u5BFE\u8C61 ${n.attachedTo} \u304C\u5B58\u5728\u3057\u306A\u3044`
          });
        } else if (!isActivityKind(host.kind)) {
          out.push({
            level: "warning",
            code: "W-314",
            message: `${n.id}: \u5883\u754C\u30A4\u30D9\u30F3\u30C8\u306E\u5BFE\u8C61 ${n.attachedTo} \u306F Activity \u3067\u306F\u306A\u3044`
          });
        } else if (eventTriggerOf(n) === "cancel" && host.subtype !== "transaction") {
          out.push({
            level: "warning",
            code: "W-310",
            message: `${n.id}: Cancel Boundary \u306F Transaction \u306B\u3060\u3051\u4ED8\u3051\u3089\u308C\u308B\uFF08\u5BFE\u8C61: ${n.attachedTo}\uFF09`
          });
        }
      }
    }
  }
  const defaultCount = /* @__PURE__ */ new Map();
  for (const e of ir.edges) {
    if (e.kind !== "seq") continue;
    if (e.isDefault && e.isConditional) {
      out.push({
        level: "warning",
        code: "W-316",
        message: `\u8FBA ${e.from} -> ${e.to}: Default Flow \u306B\u6761\u4EF6\u3092\u4ED8\u3051\u3089\u308C\u306A\u3044`
      });
    }
    const src = byId.get(e.from);
    if (e.isDefault) {
      defaultCount.set(e.from, (defaultCount.get(e.from) ?? 0) + 1);
      const legalSource = src?.kind === "task" || src?.kind === "xor" && (src.subtype === void 0 || src.subtype === "or" || src.subtype === "complex");
      if (!legalSource) {
        out.push({
          level: "warning",
          code: "W-316",
          message: `\u8FBA ${e.from} -> ${e.to}: \u3053\u306E\u59CB\u70B9\u306B Default Flow \u306F\u5B9A\u7FA9\u3067\u304D\u306A\u3044`
        });
      }
    }
    if (e.isConditional && src?.kind !== "task") {
      out.push({
        level: "warning",
        code: "W-316",
        message: `\u8FBA ${e.from} -> ${e.to}: Conditional Flow \u306F Activity \u8D77\u70B9\u3067\u306A\u3051\u308C\u3070\u306A\u3089\u306A\u3044`
      });
    }
  }
  for (const [source, count] of defaultCount) {
    if (count > 1) {
      out.push({
        level: "warning",
        code: "W-316",
        message: `${source}: Default Flow \u306F\u4E00\u3064\u3060\u3051\u5B9A\u7FA9\u3067\u304D\u308B\uFF08${count} \u672C\uFF09`
      });
    }
  }
  for (const edge of ir.edges) {
    if (edge.kind !== "assoc" || edge.assocKind !== void 0 && edge.assocKind !== "data") continue;
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (source && target && (isGatewayKind(source.kind) || isGatewayKind(target.kind))) {
      out.push({
        level: "warning",
        code: "W-208",
        message: `\u30C7\u30FC\u30BF\u95A2\u9023 ${edge.from} -.-> ${edge.to} \u306E\u7AEF\u70B9\u306B\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4\u304C\u3042\u308B\u3002\u30C7\u30FC\u30BF\u3092\u8AAD\u3080\u307E\u305F\u306F\u66F8\u304F\u6D3B\u52D5\u3078\u4ED8\u3051\u66FF\u3048\u308B`
      });
    }
    if (!source || !target || source.kind === "store" || target.kind === "store") continue;
    if (source.kind !== "doc" && target.kind !== "doc") continue;
    const sourcePool = poolOfNode(source.id);
    const targetPool = poolOfNode(target.id);
    if (sourcePool === void 0 || targetPool === void 0 || sourcePool === targetPool) continue;
    out.push({
      level: "warning",
      code: "W-209",
      message: `Data Object \u3092\u53C2\u52A0\u8005\u30D7\u30FC\u30EB\u8D8A\u3057\u306B\u95A2\u9023\u4ED8\u3051\u3066\u3044\u308B\uFF08${edge.from} -.-> ${edge.to}\uFF09\u3002\u4EA4\u63DB\u5185\u5BB9\u306F Message Flow \u306E\u30E9\u30D9\u30EB\u306B\u7F6E\u304D\u3001\u53D7\u9818\u5074\u3067\u7BA1\u7406\u3059\u308B doc \u3092\u5225\u306B\u5BA3\u8A00\u3059\u308B`
    });
  }
  for (const e of ir.edges) {
    if (e.kind !== "seq") continue;
    const source = byId.get(e.from);
    const target = byId.get(e.to);
    if (target?.kind === "start") {
      out.push({
        level: "warning",
        code: "W-225",
        message: `\u958B\u59CB\u30A4\u30D9\u30F3\u30C8 ${target.id} \u306B\u30B7\u30FC\u30B1\u30F3\u30B9 ${e.from} -> ${e.to} \u304C\u5165\u3063\u3066\u3044\u308B\u3002\u623B\u308A\u5148\u306F\u958B\u59CB\u5F8C\u306E\u6D3B\u52D5\u307E\u305F\u306F\u5408\u6D41\u70B9\u306B\u3059\u308B`
      });
    }
    if (source?.kind === "end") {
      out.push({
        level: "warning",
        code: "W-225",
        message: `\u7D42\u4E86\u30A4\u30D9\u30F3\u30C8 ${source.id} \u304B\u3089\u30B7\u30FC\u30B1\u30F3\u30B9 ${e.from} -> ${e.to} \u304C\u51FA\u3066\u3044\u308B\u3002\u7D42\u4E86\u524D\u306E\u6D3B\u52D5\u304B\u3089\u5206\u5C90\u3059\u308B`
      });
    }
  }
  for (const n of ir.nodes) {
    if (n.kind !== "mid" || n.subtype !== "message" || n.eventThrow === true) continue;
    if (ir.edges.some((e) => e.kind === "msg" && e.to === n.id)) continue;
    out.push({
      level: "warning",
      code: "W-235",
      message: `${n.id} \u306F catch(message) \u3060\u304C\u7740\u5730\u3059\u308B Message Flow \u304C\u306A\u3044\u3002\u5916\u90E8\u5FDC\u7B54\u306A\u3089\u76F8\u624B\u30D7\u30FC\u30EB\u304B\u3089 ~> \u3092\u63A5\u7D9A\u3057\u3001\u540C\u4E00\u30D7\u30FC\u30EB\u5185\u306E\u5F15\u7D99\u304E\u306A\u3089\u901A\u5E38\u306E task \u3068 sequence flow \u3092\u4F7F\u3046`
    });
  }
  for (const n of ir.nodes) {
    if (!isGatewayKind(n.kind)) continue;
    const outs = ir.edges.filter((e) => e.kind === "seq" && e.from === n.id);
    if (outs.length < 2 || new Set(outs.map((e) => e.to)).size !== 1) continue;
    out.push({
      level: "warning",
      code: "W-237",
      message: `${n.id} \u306E ${outs.length} \u5206\u5C90\u306F\u3059\u3079\u3066 ${outs[0].to} \u3078\u76F4\u7D50\u3057\u3001\u696D\u52D9\u4E0A\u306E\u6319\u52D5\u3092\u5206\u3051\u3066\u3044\u306A\u3044\u3002\u5DEE\u304C\u8AAC\u660E\u3060\u3051\u306A\u3089 note\u3001\u5F85\u6A5F\u3084\u51E6\u7406\u304C\u7570\u306A\u308B\u306A\u3089\u5404\u679D\u3078\u660E\u793A\u3059\u308B`
    });
  }
  const seqOut = /* @__PURE__ */ new Map();
  const seqIn = /* @__PURE__ */ new Map();
  for (const edge of ir.edges) {
    if (edge.kind !== "seq") continue;
    const list = seqOut.get(edge.from) ?? [];
    list.push(edge.to);
    seqOut.set(edge.from, list);
    const incoming = seqIn.get(edge.to) ?? [];
    incoming.push(edge.from);
    seqIn.set(edge.to, incoming);
  }
  const hasReplyCredit = (sourceId, sourcePool, targetPool) => {
    if (sourcePool === void 0) return false;
    const poolNodes = ir.nodes.filter((node) => poolOfNode(node.id) === sourcePool);
    const roots = poolNodes.filter(
      (node) => (seqIn.get(node.id) ?? []).every((from) => poolOfNode(from) !== sourcePool)
    );
    const relevantMessages = ir.edges.filter((candidate) => {
      if (candidate.kind !== "msg") return false;
      const fromPool = candidate.fromPool ? candidate.from : poolOfNode(candidate.from);
      const toPool = candidate.toPool ? candidate.to : poolOfNode(candidate.to);
      return fromPool === sourcePool && toPool === targetPool || !candidate.fromPool && fromPool === targetPool && toPool === sourcePool;
    });
    const bound = Math.max(1, relevantMessages.length + 1);
    const clamp2 = (value) => Math.max(-bound, Math.min(bound, value));
    const queue = roots.map((node) => ({ id: node.id, balance: 0 }));
    const seen = /* @__PURE__ */ new Set();
    while (queue.length > 0) {
      const state = queue.shift();
      const stateKey = `${state.id}\0${state.balance}`;
      if (seen.has(stateKey)) continue;
      seen.add(stateKey);
      const received = relevantMessages.filter(
        (candidate) => candidate.kind === "msg" && !candidate.fromPool && candidate.to === state.id && poolOfNode(candidate.from) === targetPool
      ).length;
      const available = clamp2(state.balance + received);
      if (state.id === sourceId && available > 0) return true;
      const sent = relevantMessages.filter(
        (candidate) => candidate.kind === "msg" && !candidate.fromPool && candidate.from === state.id && (candidate.toPool ? candidate.to : poolOfNode(candidate.to)) === targetPool
      ).length;
      const nextBalance = clamp2(available - sent);
      for (const next of seqOut.get(state.id) ?? []) {
        if (poolOfNode(next) === sourcePool) queue.push({ id: next, balance: nextBalance });
      }
    }
    return false;
  };
  const warnedMessages = /* @__PURE__ */ new Set();
  for (const edge of ir.edges) {
    if (edge.kind !== "msg" || edge.fromPool) continue;
    const sourcePool = poolOfNode(edge.from);
    const targetPool = edge.toPool ? edge.to : poolOfNode(edge.to);
    if (targetPool === void 0 || targetPool === sourcePool) continue;
    const key2 = `${edge.from}\0${targetPool}`;
    if (warnedMessages.has(key2)) continue;
    const reachable = /* @__PURE__ */ new Set();
    const queue = [edge.from];
    while (queue.length > 0) {
      const id = queue.shift();
      if (reachable.has(id) || poolOfNode(id) !== sourcePool) continue;
      reachable.add(id);
      queue.push(...seqOut.get(id) ?? []);
    }
    const hasReply = ir.edges.some((candidate) => {
      if (candidate.kind !== "msg" || candidate.toPool || !reachable.has(candidate.to)) return false;
      const replyPool = candidate.fromPool ? candidate.from : poolOfNode(candidate.from);
      return replyPool === targetPool;
    });
    const isReply = hasReplyCredit(edge.from, sourcePool, targetPool);
    if (hasReply || isReply) continue;
    warnedMessages.add(key2);
    out.push({
      level: "warning",
      code: "W-236",
      message: `${edge.from} \u304B\u3089\u30D7\u30FC\u30EB ${targetPool} \u3078\u306E\u30E1\u30C3\u30BB\u30FC\u30B8\u306B\u3001\u9001\u4FE1\u6D3B\u52D5\u307E\u305F\u306F\u5F8C\u7D9A\u3078\u623B\u308B Message Flow \u304C\u306A\u3044\u3002\u4E00\u65B9\u5411\u901A\u77E5\u304B\u3001\u56DE\u7B54\u5F85\u3061\u306E\u6B20\u843D\u304B\u3092\u78BA\u8A8D\u3059\u308B`
    });
  }
  for (const artifact of ir.nodes.filter((n) => n.kind === "doc" || n.kind === "store")) {
    const related = ir.edges.filter((e) => e.kind === "assoc" && (e.from === artifact.id || e.to === artifact.id)).map((e) => byId.get(e.from === artifact.id ? e.to : e.from)).filter((n) => n !== void 0 && !isDocLike(n.kind));
    if (related.some((n) => n.lane === artifact.lane)) continue;
    out.push({
      level: "warning",
      code: "W-105",
      message: `${artifact.id} \u306E\u5BA3\u8A00\u30EC\u30FC\u30F3\u306B\u95A2\u9023\u3059\u308B\u6D3B\u52D5\u304C\u306A\u3044\u3002\u4F5C\u6210\u30FB\u7DAD\u6301\u30FB\u7D71\u5236\u306E\u8CAC\u4EFB\u30EC\u30FC\u30F3\u3092\u78BA\u8A8D\u3059\u308B`
    });
  }
  return out;
}
var STRICT_CODES = /* @__PURE__ */ new Set([
  "W-207",
  "W-225",
  "W-310",
  "W-311",
  "W-312",
  "W-313",
  "W-314",
  "W-315",
  "W-316"
]);
function applyStrictSemantics(diags, strict2) {
  if (!strict2) return diags;
  return diags.map((d) => {
    if (d.level === "warning" && STRICT_CODES.has(d.code)) {
      return { ...d, level: "error", code: `E-${d.code.slice(2)}` };
    }
    return d;
  });
}
function hasBottomActivityMarker(n) {
  if (n.loop || n.compensation || n.adhoc) return true;
  if (n.subtype === "sub" || n.subtype === "transaction" || n.subtype === "eventSub") return true;
  if (n.subtype === "call" && n.callProcess !== false) return true;
  return false;
}
function hasTopTaskIcon(n) {
  if (n.subtype === "call" && n.callProcess === false && n.callTaskType) return true;
  if (n.subtype === "eventSub" && n.eventSubTrigger) return true;
  const s = n.subtype;
  return s === "user" || s === "service" || s === "rule" || s === "script" || s === "send" || s === "receive" || s === "manual";
}

// src/message-labels.ts
function crossMinusLabelEvents(g) {
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const out = /* @__PURE__ */ new Set();
  const poolIdx = (id) => id === void 0 ? void 0 : poolIndex.get(id);
  const nodePoolIdx = (id) => {
    const n = nodeById.get(id);
    return n ? poolIdx(poolOfLane.get(n.lane)) : void 0;
  };
  for (const e of g.edges) {
    if (e.kind !== "msg") continue;
    if (e.fromPool) {
      const fi = poolIdx(e.fromPool);
      const vi2 = nodePoolIdx(e.to);
      const v2 = nodeById.get(e.to);
      if (fi !== void 0 && vi2 !== void 0 && fi > vi2 && v2 && isEventKind(v2.kind)) out.add(v2.id);
      continue;
    }
    if (e.toPool) {
      const ui2 = nodePoolIdx(e.from);
      const ti = poolIdx(e.toPool);
      const u2 = nodeById.get(e.from);
      if (ui2 !== void 0 && ti !== void 0 && ti > ui2 && u2 && isEventKind(u2.kind)) out.add(u2.id);
      continue;
    }
    const u = nodeById.get(e.from);
    const v = nodeById.get(e.to);
    const ui = u ? poolIdx(poolOfLane.get(u.lane)) : void 0;
    const vi = v ? poolIdx(poolOfLane.get(v.lane)) : void 0;
    if (ui === void 0 || vi === void 0 || Math.abs(ui - vi) !== 1) continue;
    if (ui < vi && u && isEventKind(u.kind)) out.add(u.id);
    if (vi < ui && v && isEventKind(v.kind)) out.add(v.id);
  }
  return out;
}

// src/parse.ts
var ID = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_]*`;
var NODE_KINDS = "task|xor|and|start|end|doc|mid|store|note|boundary|group|or|complex|catch|throw";
var RE_EDGE = new RegExp(
  `^(${ID})(?:\\[([^\\]]*)\\])?\\s*(<\\.\\.>|-\\.->|-\\.-|\\.\\.>|->\\/|->>|=>|~>|->)(\\?)?\\s*(${ID})(?:\\[([^\\]]*)\\])?\\s*(?::\\s*(.*))?$`,
  "u"
);
var RE_NODE = new RegExp(
  `^(?:(${NODE_KINDS})(?:\\(([^)]*)\\))?(\\?)?\\s+)?(${ID})\\s*(?:\\[(.*)\\])?(?:\\s+@(${ID}))?$`,
  "u"
);
function parse(source) {
  const diags = [];
  const pools = [];
  const lanes = [];
  const nodes = [];
  const edges = [];
  let flowId;
  let title;
  let orientation;
  let currentPool;
  let currentLane = null;
  let declIndex = 0;
  const laneByKey = /* @__PURE__ */ new Map();
  const laneById = /* @__PURE__ */ new Map();
  const nodeById = /* @__PURE__ */ new Map();
  const ensureLane = (declaredId, label, line) => {
    const key2 = JSON.stringify([currentPool ?? null, declaredId]);
    const found = laneByKey.get(key2);
    if (found) return found;
    const id = laneById.has(declaredId) ? uniqueId(declaredId, laneById) : declaredId;
    const lane = { id, label, pool: currentPool, declIndex: declIndex++ };
    lanes.push(lane);
    laneByKey.set(key2, lane);
    laneById.set(id, lane);
    return lane;
  };
  const inlineLabels = /* @__PURE__ */ new Map();
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text2 = stripComment(lines[i]).trim();
    if (text2 === "") continue;
    if (/^flow(?:\s|$)/u.test(text2)) {
      const t = text2.slice(4).trim();
      if (title !== void 0) {
        diags.push({ level: "warning", code: "W-001", message: "flow \u884C\u304C\u91CD\u8907\u3002\u5F8C\u306E\u884C\u3092\u7121\u8996", line: lineNo });
      } else {
        const parsed = parseScopedName(t);
        flowId = parsed.hasExplicitLabel ? parsed.id : void 0;
        title = parsed.label || void 0;
      }
      continue;
    }
    if (/^orientation(?:\s|$)/u.test(text2)) {
      const v = text2.slice("orientation".length).trim();
      if (v === "vertical" || v === "horizontal") {
        if (orientation !== void 0) {
          diags.push({ level: "warning", code: "W-014", message: "orientation \u884C\u304C\u91CD\u8907\u3002\u5F8C\u306E\u884C\u3092\u7121\u8996", line: lineNo });
        } else {
          orientation = v;
        }
        continue;
      }
      const nm0 = RE_NODE.exec(text2);
      const parsesAsEdgeOrNode = RE_EDGE.test(text2) || nm0 !== null && (nm0[1] !== void 0 || nm0[5] !== void 0);
      if (!parsesAsEdgeOrNode) {
        diags.push({
          level: "warning",
          code: "W-013",
          line: lineNo,
          message: `orientation \u306E\u5024\u300C${v}\u300D\u306F vertical / horizontal \u306E\u3069\u3061\u3089\u3067\u3082\u306A\u3044\u3002\u7121\u8996`
        });
        continue;
      }
    }
    if (text2.startsWith("pool ")) {
      const rest = text2.slice(5).trim();
      const { id, label } = parseScopedName(rest);
      if (id === "") {
        diags.push({ level: "error", code: "E-009", message: "pool \u306B\u30E9\u30D9\u30EB\u304C\u306A\u3044", line: lineNo });
        continue;
      }
      if (!pools.some((pl) => pl.id === id)) {
        pools.push({ id, label, declIndex: declIndex++ });
      } else {
        diags.push({ level: "warning", code: "W-010", message: `pool ${id} \u304C\u518D\u5BA3\u8A00\u3002\u7D9A\u304D\u3068\u3057\u3066\u6271\u3046`, line: lineNo });
      }
      currentPool = id;
      currentLane = null;
      continue;
    }
    if (text2.startsWith("lane ")) {
      const rest = text2.slice(5).trim();
      const { id, label } = parseScopedName(rest);
      if (label === "") {
        diags.push({ level: "error", code: "E-002", message: "lane \u306B\u30E9\u30D9\u30EB\u304C\u306A\u3044", line: lineNo });
        continue;
      }
      const key2 = JSON.stringify([currentPool ?? null, id]);
      if (laneByKey.has(key2)) {
        diags.push({ level: "warning", code: "W-003", message: `lane ${label} \u304C\u91CD\u8907\u5BA3\u8A00\u3002\u540C\u4E00\u30EC\u30FC\u30F3\u306B\u5408\u6D41`, line: lineNo });
      }
      currentLane = ensureLane(id, label, lineNo).id;
      continue;
    }
    const em = RE_EDGE.exec(text2);
    if (em) {
      const [, from, fromLabel, arrow, prov, to, toLabel, label] = em;
      if (from === to) {
        diags.push({ level: "warning", code: "W-004", message: `\u81EA\u5DF1\u30EB\u30FC\u30D7 ${from} -> ${from} \u306F v1 \u975E\u5BFE\u5FDC\u3002\u7121\u8996`, line: lineNo });
        continue;
      }
      if (fromLabel !== void 0) inlineLabels.set(from, { label: fromLabel, line: lineNo });
      if (toLabel !== void 0) inlineLabels.set(to, { label: toLabel, line: lineNo });
      const { kind, mainHint, isDefault, returnHint, assocKind } = classifyArrow(arrow);
      edges.push({
        id: `e${edges.length}_${from}_${to}`,
        kind,
        from,
        to,
        label: label?.trim() || void 0,
        mainHint,
        isDefault,
        returnHint,
        assocKind,
        declIndex: declIndex++,
        provisional: prov === "?",
        synthetic: false
      });
      continue;
    }
    const nm = RE_NODE.exec(text2);
    if (nm && (nm[1] !== void 0 || nm[5] !== void 0)) {
      const kindRaw = nm[1] ?? "task";
      const params = nm[2];
      const interp = interpretNode(kindRaw, params);
      const provisional = nm[3] === "?";
      let id = nm[4];
      const attachedTo = nm[6];
      const kind = interp.kind;
      const label = nm[5] ?? (kind === "start" || kind === "end" || kind === "boundary" ? "" : id);
      if (nodeById.has(id)) {
        const renamed = uniqueId(id, nodeById);
        diags.push({
          level: "error",
          code: "E-005",
          line: lineNo,
          message: `\u30CE\u30FC\u30C9 ID ${id} \u304C\u91CD\u8907\u3002lax \u3067\u306F ${renamed} \u306B\u8AAD\u307F\u66FF\u3048`
        });
        id = renamed;
      }
      let lane = currentLane;
      if (lane === null) {
        diags.push({
          level: "error",
          code: "E-006",
          line: lineNo,
          message: `\u30CE\u30FC\u30C9 ${id} \u304C lane \u306E\u5916\u3067\u5BA3\u8A00\u3002lax \u3067\u306F\u30EC\u30FC\u30F3\u300C\uFF1F\u300D\u306B\u53CE\u5BB9`
        });
        lane = ensureLane("\uFF1F", "\uFF1F", lineNo).id;
        currentLane = null;
      }
      const node = { id, kind, label, lane, declIndex: declIndex++, provisional, synthetic: false };
      applyInterpretation(node, interp);
      if (attachedTo) {
        if (kind === "boundary") node.attachedTo = attachedTo;
        else {
          diags.push({
            level: "warning",
            code: "W-314",
            line: lineNo,
            message: `${id}: @\u5BFE\u8C61 \u306F\u5883\u754C\u30A4\u30D9\u30F3\u30C8\u5C02\u7528\u3002\u7121\u8996`
          });
        }
      }
      diags.push(...diagnoseInterpretation(interp, kindRaw, id, lineNo));
      nodes.push(node);
      nodeById.set(id, node);
      continue;
    }
    diags.push({ level: "warning", code: "W-007", message: `\u89E3\u91C8\u3067\u304D\u306A\u3044\u884C\u3092\u7121\u8996: ${text2}`, line: lineNo });
  }
  const poolIds = new Set(pools.map((pl) => pl.id));
  for (const e of edges) {
    for (const ref of [e.from, e.to]) {
      if (!nodeById.has(ref) && poolIds.has(ref)) {
        if (ref === e.from) e.fromPool = ref;
        else e.toPool = ref;
        if (e.kind !== "msg") {
          diags.push({
            level: "error",
            code: "E-206",
            message: `\u30D7\u30FC\u30EB ${ref} \u306B\u7E4B\u3052\u3089\u308C\u308B\u306E\u306F\u30E1\u30C3\u30BB\u30FC\u30B8 ~> \u3060\u3051\u3002lax \u3067\u306F\u8AAD\u307F\u66FF\u3048`
          });
          e.kind = "msg";
          e.mainHint = false;
          e.returnHint = false;
          e.isDefault = false;
          e.isConditional = false;
        }
        continue;
      }
      if (!nodeById.has(ref)) {
        const other = ref === e.from ? e.to : e.from;
        const anchor = nodeById.get(other);
        const lane = anchor?.lane ?? lanes[0]?.id ?? ensureLane("\uFF1F", "\uFF1F", 0).id;
        const kind = e.kind === "assoc" ? "doc" : "task";
        const inline = inlineLabels.get(ref);
        diags.push({
          level: "warning",
          code: inline ? "W-103" : "W-102",
          message: inline ? `\u8FBA\u5185\u5BA3\u8A00 ${ref}[${inline.label}] \u3092 ${kind} \u3068\u3057\u3066\u30EC\u30FC\u30F3 ${lane} \u306B\u5B9F\u4F53\u5316\uFF08\u30EC\u30FC\u30F3\u63A8\u5B9A\u30FB\u8981\u78BA\u8A8D\uFF09` : `\u672A\u5BA3\u8A00\u30CE\u30FC\u30C9 ${ref} \u3092 ${kind} \u3068\u3057\u3066\u30EC\u30FC\u30F3 ${lane} \u306B\u81EA\u52D5\u5B9F\u4F53\u5316\uFF08\u8981\u78BA\u8A8D\uFF09`,
          line: inline?.line
        });
        const node = {
          id: ref,
          kind,
          label: inline?.label ?? ref,
          lane,
          declIndex: declIndex++,
          provisional: true,
          synthetic: false
        };
        nodes.push(node);
        nodeById.set(ref, node);
      }
    }
  }
  for (const [ref, inline] of inlineLabels) {
    const n = nodeById.get(ref);
    if (n && !n.provisional && n.label !== inline.label) {
      diags.push({
        level: "warning",
        code: "W-104",
        line: inline.line,
        message: `\u8FBA\u5185\u30E9\u30D9\u30EB ${ref}[${inline.label}] \u306F\u5BA3\u8A00 [${n.label}] \u3068\u4E0D\u4E00\u81F4\u3002\u5BA3\u8A00\u3092\u512A\u5148`
      });
    }
  }
  for (const e of edges) {
    if (e.kind !== "seq") continue;
    const fk = nodeById.get(e.from)?.kind;
    const tk = nodeById.get(e.to)?.kind;
    const touchesDoc = fk !== void 0 && isDocLike(fk) || tk !== void 0 && isDocLike(tk);
    if (touchesDoc) {
      diags.push({
        level: "error",
        code: "E-203",
        message: `\u30B7\u30FC\u30B1\u30F3\u30B9 ${e.from} -> ${e.to} \u304C doc \u306B\u63A5\u7D9A\u3002lax \u3067\u306F\u30C7\u30FC\u30BF\u95A2\u9023 -.-> \u306B\u8AAD\u307F\u66FF\u3048`
      });
      e.kind = "assoc";
      e.mainHint = false;
      e.returnHint = false;
      e.isDefault = false;
      e.isConditional = false;
      e.assocKind = e.assocKind ?? "data";
    }
  }
  {
    const poolOf = (nid) => {
      if (poolIds.has(nid)) return nid;
      const n = nodeById.get(nid);
      return n ? laneById.get(n.lane)?.pool : void 0;
    };
    for (const e of edges) {
      if (e.fromPool || e.toPool) continue;
      if (e.kind === "seq" && poolOf(e.from) !== poolOf(e.to)) {
        diags.push({
          level: "error",
          code: "E-204",
          message: `\u30B7\u30FC\u30B1\u30F3\u30B9 ${e.from} -> ${e.to} \u304C\u30D7\u30FC\u30EB\u3092\u8D8A\u3048\u3066\u3044\u308B\u3002lax \u3067\u306F\u30E1\u30C3\u30BB\u30FC\u30B8 ~> \u306B\u8AAD\u307F\u66FF\u3048`
        });
        e.kind = "msg";
        e.mainHint = false;
        e.returnHint = false;
        e.isDefault = false;
        e.isConditional = false;
      } else if (e.kind === "msg" && poolOf(e.from) === poolOf(e.to)) {
        diags.push({
          level: "error",
          code: "E-205",
          message: `\u30E1\u30C3\u30BB\u30FC\u30B8 ${e.from} ~> ${e.to} \u304C\u540C\u4E00\u30D7\u30FC\u30EB\u5185\u3002lax \u3067\u306F\u30B7\u30FC\u30B1\u30F3\u30B9 -> \u306B\u8AAD\u307F\u66FF\u3048`
        });
        e.kind = "seq";
      }
    }
    for (const e of edges) {
      if (e.kind !== "msg") continue;
      const fromNode = e.fromPool ? void 0 : nodeById.get(e.from);
      const toNode = e.toPool ? void 0 : nodeById.get(e.to);
      const invalidFrom = fromNode !== void 0 && (isGatewayKind(fromNode.kind) || isDocLike(fromNode.kind) || isEventKind(fromNode.kind) && !isMessageEventEndpoint(fromNode, "send"));
      const invalidTo = toNode !== void 0 && (isGatewayKind(toNode.kind) || isDocLike(toNode.kind) || isEventKind(toNode.kind) && !isMessageEventEndpoint(toNode, "receive"));
      if (!invalidFrom && !invalidTo) continue;
      const endpoints = [invalidFrom ? e.from : void 0, invalidTo ? e.to : void 0].filter((id) => id !== void 0).join(", ");
      diags.push({
        level: "warning",
        code: "W-207",
        message: `\u30E1\u30C3\u30BB\u30FC\u30B8 ${e.from} ~> ${e.to} \u306E\u7AEF\u70B9 ${endpoints} \u306F\u9001\u53D7\u4FE1\u4E3B\u4F53\u3067\u306A\u3044\u3002task \u307E\u305F\u306F message event \u3067\u9001\u53D7\u4FE1\u3092\u8868\u3059`
      });
    }
    if (pools.length > 0) {
      const poolOrder = /* @__PURE__ */ new Map();
      for (const l of lanes) {
        if (!poolOrder.has(l.pool)) poolOrder.set(l.pool, poolOrder.size);
      }
      lanes.sort((a, b) => poolOrder.get(a.pool) - poolOrder.get(b.pool) || a.declIndex - b.declIndex);
    }
  }
  for (const pl of pools) {
    if (!lanes.some((l) => l.pool === pl.id)) {
      const id = laneById.has(pl.id) ? uniqueId(pl.id, laneById) : pl.id;
      const lane = { id, label: pl.label, pool: pl.id, blackbox: true, declIndex: pl.declIndex };
      lanes.push(lane);
      laneById.set(id, lane);
    }
  }
  if (pools.length > 0) {
    const poolOrder2 = /* @__PURE__ */ new Map();
    for (const l of lanes.slice().sort((a, b) => a.declIndex - b.declIndex)) {
      if (!poolOrder2.has(l.pool)) poolOrder2.set(l.pool, poolOrder2.size);
    }
    lanes.sort((a, b) => poolOrder2.get(a.pool) - poolOrder2.get(b.pool) || a.declIndex - b.declIndex);
  }
  if (lanes.length === 0) {
    diags.push({ level: "error", code: "E-008", message: "\u30EC\u30FC\u30F3\u304C\u4E00\u3064\u3082\u306A\u3044\u3002lax \u3067\u306F\u30EC\u30FC\u30F3\u300C\uFF1F\u300D\u3092\u88DC\u3046" });
    ensureLane("\uFF1F", "\uFF1F", 0);
  }
  for (const e of edges) {
    if (e.kind !== "seq" || !e.label) continue;
    const src = nodeById.get(e.from);
    if (src && !isGatewayKind(src.kind)) e.isConditional = true;
  }
  const ir = { id: flowId, title, orientation, pools, lanes, nodes, edges };
  diags.push(...validateIr(ir));
  return { ir, diagnostics: diags };
}
function parseScopedName(text2) {
  const match = /^([^\s\[\]]+)\[(.*)\]$/u.exec(text2);
  return match ? { id: match[1], label: match[2], hasExplicitLabel: true } : { id: text2, label: text2, hasExplicitLabel: false };
}
function isMessageEventEndpoint(node, direction) {
  const messageTrigger = node.subtype === "message" || node.subtype === "multiple" || node.subtype === "parallelMultiple";
  if (!messageTrigger) return false;
  if (direction === "receive") {
    return node.kind === "start" || node.kind === "boundary" || node.kind === "mid" && node.eventThrow !== true;
  }
  return node.kind === "end" || node.kind === "mid" && node.eventThrow === true;
}
function classifyArrow(arrow) {
  switch (arrow) {
    case "-.->":
      return { kind: "assoc", mainHint: false, assocKind: "data" };
    case "-.-":
      return { kind: "assoc", mainHint: false, assocKind: "undirected" };
    case "..>":
      return { kind: "assoc", mainHint: false, assocKind: "directed" };
    case "<..>":
      return { kind: "assoc", mainHint: false, assocKind: "both" };
    case "->/":
      return { kind: "seq", mainHint: false, isDefault: true };
    case "->>":
      return { kind: "seq", mainHint: false, returnHint: true };
    case "=>":
      return { kind: "seq", mainHint: true };
    case "~>":
      return { kind: "msg", mainHint: false };
    default:
      return { kind: "seq", mainHint: false };
  }
}
function uniqueId(base, taken) {
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
function stripComment(line) {
  let bracketDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "[") bracketDepth++;
    else if (ch === "]" && bracketDepth > 0) bracketDepth--;
    else if (ch === "#" && bracketDepth === 0) return line.slice(0, i);
  }
  return line;
}

// src/normalize.ts
function normalize(ir, strict2 = false) {
  const report = [];
  let seq = 0;
  const nodes = ir.nodes.map((n) => ({ ...n, onSpine: false }));
  let edges = ir.edges.map((e) => ({ ...e, isReturn: false, onSpine: false }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const allocateNodeId = (base) => {
    if (!nodeById.has(base)) return base;
    let n = 2;
    while (nodeById.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  };
  const declOf = (id) => nodeById.get(id).declIndex;
  let nextDecl = Math.max(0, ...nodes.map((n) => n.declIndex + 1), ...edges.map((e) => e.declIndex + 1));
  repeatDistantDocuments(nodes, edges, ir, nodeById, allocateNodeId, () => nextDecl++, report);
  electReturns(nodes, edges, report, strict2);
  for (const n of [...nodes]) {
    if (isGatewayKind(n.kind) || isDocLike(n.kind) || isAttachedBoundary(n)) continue;
    const outs = edges.filter((e) => e.from === n.id && e.kind === "seq");
    if (outs.length <= 1) continue;
    const msg = `${n.id} \u306B\u8907\u6570\u51FA\u8FBA\u3002\u5206\u5C90\u7A2E\u5225\u304C\u672A\u6307\u5B9A\uFF08C-13\uFF09`;
    if (strict2) {
      report.push({ level: "error", code: "E-130", message: `${msg}\u3002xor / and \u3092\u660E\u793A\u305B\u3088` });
      continue;
    }
    const gwId = allocateNodeId(`x_s_${n.id}`);
    const gw = {
      id: gwId,
      kind: "xor",
      label: "",
      lane: n.lane,
      declIndex: nextDecl++,
      provisional: true,
      synthetic: true,
      onSpine: false
    };
    nodes.push(gw);
    nodeById.set(gw.id, gw);
    for (const e of outs) e.from = gw.id;
    edges.push({
      id: `e_syn_${gw.id}`,
      kind: "seq",
      from: n.id,
      to: gw.id,
      mainHint: false,
      declIndex: nextDecl++,
      provisional: true,
      synthetic: true,
      isReturn: false,
      onSpine: false
    });
    report.push({ level: "warning", code: "N-130", message: `${msg}\u3002XOR split ${gw.id} \u3092\u4EEE\u633F\u5165\uFF08\u51FA\u6240\u5370\u3064\u304D\u30FB\u8981\u78BA\u8A8D\uFF09` });
  }
  for (const n of [...nodes]) {
    if (isGatewayKind(n.kind) || isDocLike(n.kind) || isAttachedBoundary(n)) continue;
    const ins = edges.filter((e) => e.to === n.id && e.kind === "seq");
    if (ins.length <= 1) continue;
    const gwId = allocateNodeId(`x_j_${n.id}`);
    const gw = {
      id: gwId,
      kind: "xor",
      label: "",
      lane: n.lane,
      declIndex: nextDecl++,
      provisional: false,
      synthetic: true,
      onSpine: false
    };
    nodes.push(gw);
    nodeById.set(gw.id, gw);
    for (const e of ins) e.to = gw.id;
    edges.push({
      id: `e_syn_${gw.id}`,
      kind: "seq",
      from: gw.id,
      to: n.id,
      mainHint: false,
      declIndex: nextDecl++,
      provisional: false,
      synthetic: true,
      isReturn: false,
      onSpine: false
    });
    report.push({ level: "info", code: "N-210", message: `${n.id} \u306E\u6697\u9ED9\u5408\u6D41\u3092 XOR join ${gw.id} \u306B\u6607\u683C\uFF08\u610F\u5473\u4FDD\u5B58\uFF09` });
  }
  for (const n of [...nodes]) {
    if (n.kind !== "xor" && n.kind !== "and") continue;
    const ins = edges.filter((e) => e.to === n.id && e.kind === "seq");
    const outs = edges.filter((e) => e.from === n.id && e.kind === "seq");
    if (ins.length <= 1 || outs.length <= 1) continue;
    const joinId = allocateNodeId(`x_j_${n.id}`);
    const join2 = {
      // event-based gateway は分岐専用なので、合流側は通常 XOR merge とする。
      id: joinId,
      kind: n.kind,
      subtype: n.subtype === "event" ? void 0 : n.subtype,
      label: "",
      lane: n.lane,
      declIndex: nextDecl++,
      provisional: false,
      synthetic: true,
      onSpine: false
    };
    nodes.push(join2);
    nodeById.set(join2.id, join2);
    for (const e of ins) e.to = join2.id;
    edges.push({
      id: `e_syn_${join2.id}`,
      kind: "seq",
      from: join2.id,
      to: n.id,
      mainHint: false,
      declIndex: nextDecl++,
      provisional: false,
      synthetic: true,
      isReturn: false,
      onSpine: false
    });
    report.push({ level: "info", code: "N-211", message: `\u5408\u6D41\u30FB\u5206\u5C90\u517C\u52D9 ${n.id} \u3092 ${join2.id} + ${n.id} \u306B\u5206\u96E2` });
  }
  const poolOfLane = new Map(ir.lanes.map((l) => [l.id, l.pool]));
  const processPools = [];
  for (const n of nodes) {
    if (isDocLike(n.kind)) continue;
    const pool = poolOfLane.get(n.lane);
    if (!processPools.includes(pool)) processPools.push(pool);
  }
  const inPool = (n, pool) => poolOfLane.get(n.lane) === pool;
  for (const pool of processPools) {
    const processNodes = nodes.filter((n) => !isDocLike(n.kind) && !isAttachedBoundary(n) && inPool(n, pool));
    const hasExplicitStart = processNodes.some((n) => n.kind === "start" && !n.synthetic);
    const hasExplicitEnd = processNodes.some((n) => n.kind === "end" && !n.synthetic);
    const isOutOfBandHandler = (n) => n.kind === "task" && n.subtype === "eventSub" || n.compensation === true || n.kind === "mid" && n.subtype === "link";
    if (hasExplicitStart) {
      const extraSources = processNodes.filter(
        (n) => n.kind !== "start" && !isOutOfBandHandler(n) && !edges.some((e) => e.to === n.id && e.kind === "seq")
      );
      for (const source of extraSources) {
        report.push({
          level: strict2 ? "error" : "warning",
          code: strict2 ? "E-223" : "W-223",
          message: `${source.id} \u306F\u660E\u793A\u3057\u305F\u958B\u59CB\u30A4\u30D9\u30F3\u30C8\u3068\u306F\u5225\u306E\u3001\u30B7\u30FC\u30B1\u30F3\u30B9\u5165\u8FBA\u3092\u6301\u305F\u306A\u3044\u5165\u53E3\u3002\u958B\u59CB\u6761\u4EF6\u307E\u305F\u306F\u524D\u6BB5\u306E\u30B7\u30FC\u30B1\u30F3\u30B9\u3092\u660E\u793A\u305B\u3088`
        });
      }
    }
    if (!hasExplicitStart) {
      const sources = processNodes.filter(
        (n) => !edges.some((e) => e.to === n.id && e.kind === "seq")
      );
      for (const s of sources) {
        if (edges.some((e) => e.to === s.id && e.kind === "msg")) {
          report.push({
            level: "warning",
            code: "W-234",
            message: `${s.id} \u306F\u5916\u90E8\u30E1\u30C3\u30BB\u30FC\u30B8\u3060\u3051\u3092\u5165\u53E3\u306B\u3059\u308B\u305F\u3081\u7121\u5370 start \u3092\u88DC\u5B8C\u3059\u308B\u3002\u958B\u59CB\u53D7\u4FE1\u306A\u3089 start(message)\u3001\u9014\u4E2D\u306E\u5FDC\u7B54\u5F85\u3061\u306A\u3089 catch(message) \u307E\u305F\u306F task(receive) \u3092\u660E\u793A\u3059\u308B`
          });
        }
        const stId = allocateNodeId(`s_a_${s.id}`);
        const st = {
          id: stId,
          kind: "start",
          label: "",
          lane: s.lane,
          declIndex: -1,
          provisional: false,
          synthetic: true,
          onSpine: false
        };
        nodes.push(st);
        nodeById.set(st.id, st);
        edges.push({
          id: `e_syn_${st.id}`,
          kind: "seq",
          from: st.id,
          to: s.id,
          mainHint: false,
          declIndex: nextDecl++,
          provisional: false,
          synthetic: true,
          isReturn: false,
          onSpine: false
        });
        report.push({ level: "warning", code: "W-220", message: `\u958B\u59CB\u30A4\u30D9\u30F3\u30C8 ${st.id} \u3092 ${s.id} \u306E\u524D\u306B\u88DC\u5B8C\u3002\u958B\u59CB\u6761\u4EF6\u3092\u78BA\u8A8D\u3059\u308B` });
      }
    }
    const updatedProcessNodes = nodes.filter((n) => !isDocLike(n.kind) && !isAttachedBoundary(n) && inPool(n, pool));
    if (hasExplicitEnd) {
      const extraSinks = updatedProcessNodes.filter(
        (n) => n.kind !== "end" && !isOutOfBandHandler(n) && !edges.some((e) => e.from === n.id && e.kind === "seq")
      );
      for (const sink of extraSinks) {
        report.push({
          level: strict2 ? "error" : "warning",
          code: strict2 ? "E-224" : "W-224",
          message: `${sink.id} \u306F\u660E\u793A\u3057\u305F\u7D42\u4E86\u30A4\u30D9\u30F3\u30C8\u3068\u306F\u5225\u306E\u3001\u30B7\u30FC\u30B1\u30F3\u30B9\u51FA\u8FBA\u3092\u6301\u305F\u306A\u3044\u51FA\u53E3\u3002\u7D42\u4E86\u7D50\u679C\u307E\u305F\u306F\u5F8C\u6BB5\u306E\u30B7\u30FC\u30B1\u30F3\u30B9\u3092\u660E\u793A\u305B\u3088`
        });
      }
    }
    if (!hasExplicitEnd) {
      const sinks = updatedProcessNodes.filter(
        (n) => n.kind !== "start" && !edges.some((e) => e.from === n.id && e.kind === "seq")
      );
      for (const t of sinks) {
        const enId = allocateNodeId(`e_a_${t.id}`);
        const en = {
          id: enId,
          kind: "end",
          label: "",
          lane: t.lane,
          declIndex: nextDecl++,
          provisional: false,
          synthetic: true,
          onSpine: false
        };
        nodes.push(en);
        nodeById.set(en.id, en);
        edges.push({
          id: `e_syn_${en.id}`,
          kind: "seq",
          from: t.id,
          to: en.id,
          mainHint: false,
          declIndex: nextDecl++,
          provisional: false,
          synthetic: true,
          isReturn: false,
          onSpine: false
        });
        report.push({ level: "warning", code: "W-221", message: `\u7D42\u4E86\u30A4\u30D9\u30F3\u30C8 ${en.id} \u3092 ${t.id} \u306E\u5F8C\u306B\u88DC\u5B8C\u3002\u7D42\u4E86\u7D50\u679C\u3092\u78BA\u8A8D\u3059\u308B` });
      }
    }
  }
  const starts = nodes.filter((n) => n.kind === "start").sort((a, b) => a.declIndex - b.declIndex);
  const reachesEnd = nodesReachingEnd(nodes, edges);
  const firstByPool = /* @__PURE__ */ new Map();
  for (const start of starts) {
    const pool = poolOfLane.get(start.lane) ?? "";
    if (!firstByPool.has(pool)) firstByPool.set(pool, start);
  }
  for (const [pool, first] of firstByPool) {
    let cur = first;
    const visited = /* @__PURE__ */ new Set();
    const path = [];
    while (!visited.has(cur.id)) {
      visited.add(cur.id);
      path.push(cur.id);
      cur.onSpine = true;
      const outs = edges.filter((e) => e.from === cur.id && !e.isReturn && e.kind === "seq").sort((a, b) => a.declIndex - b.declIndex);
      if (outs.length === 0) break;
      const completing = outs.filter((e) => reachesEnd.has(e.to));
      const candidates = completing.length > 0 ? completing : outs;
      const chosen = outs.find((e) => e.mainHint) ?? candidates.find((e) => e.label === void 0) ?? candidates.find((e) => nodeById.get(e.to)?.lane === cur.lane) ?? candidates[0];
      chosen.onSpine = true;
      cur = nodeById.get(chosen.to);
    }
    report.push({
      level: "info",
      code: "N-222",
      message: `\u672C\u6D41\u3092\u9078\u6319(${pool || "default"}): ${path.join(" -> ")}`
    });
  }
  return { id: ir.id, title: ir.title, orientation: ir.orientation, pools: ir.pools, lanes: ir.lanes, nodes, edges, report };
}
var REPEAT_COL_GAP = 5;
var REPEAT_LANE_GAP = 2;
function repeatDistantDocuments(nodes, edges, ir, nodeById, allocateNodeId, nextDecl, report) {
  const laneIndex = new Map(ir.lanes.map((l, i) => [l.id, i]));
  const col = provisionalColumns(nodes, edges);
  for (const d of [...nodes]) {
    if (d.kind !== "doc" && d.kind !== "store") continue;
    const touching = edges.filter((e) => e.from === d.id || e.to === d.id);
    if (touching.some((e) => e.kind !== "assoc" || e.fromPool || e.toPool)) continue;
    const refs = touching.map((e) => ({ e, p: nodeById.get(e.from === d.id ? e.to : e.from) }));
    if (refs.length < 2 || refs.some((r) => !r.p || isDocLike(r.p.kind))) continue;
    const at = (r) => col.get(r.p.id) ?? 0;
    const laneOf = (r) => laneIndex.get(r.p.lane) ?? 0;
    refs.sort((a, b) => at(a) - at(b) || a.e.declIndex - b.e.declIndex);
    const clusters = [];
    for (const r of refs) {
      const last = clusters.at(-1);
      if (last) {
        const maxCol = Math.max(...last.map(at));
        const anchorLane = laneOf(last[0]);
        if (at(r) - maxCol <= REPEAT_COL_GAP && Math.abs(laneOf(r) - anchorLane) <= REPEAT_LANE_GAP) {
          last.push(r);
          continue;
        }
      }
      clusters.push([r]);
    }
    if (clusters.length < 2) continue;
    clusters.forEach((cluster, i) => {
      const anchor = cluster.find((r) => r.e.to === d.id)?.p ?? cluster[0].p;
      if (i === 0) {
        d.lane = anchor.lane;
        return;
      }
      const id = allocateNodeId(`${d.id}__${i + 1}`);
      const copy = {
        ...d,
        id,
        lane: anchor.lane,
        declIndex: nextDecl(),
        synthetic: true,
        repeatOf: d.id,
        onSpine: false
      };
      nodes.push(copy);
      nodeById.set(id, copy);
      for (const { e } of cluster) {
        if (e.from === d.id) e.from = id;
        else e.to = id;
      }
    });
    report.push({
      level: "info",
      code: "N-260",
      message: `\u6587\u66F8 ${d.id} \u3092 ${clusters.length} \u7B87\u6240\u306B\u518D\u63B2\uFF08\u53C2\u7167\u306E\u584A\u3054\u3068\u306E\u56F3\u5F62\u3002\u610F\u5473\u306F\u4E00\u3064\u306E\u6587\u66F8\u3002C-66\uFF09`
    });
  }
}
function provisionalColumns(nodes, edges) {
  const trial = edges.map((e) => ({ ...e }));
  electReturns(nodes, trial, [], false);
  const docIds = new Set(nodes.filter((n) => isDocLike(n.kind)).map((n) => n.id));
  const fwd = trial.filter((e) => !e.isReturn && isLayeringSeq(e, docIds));
  const col = /* @__PURE__ */ new Map();
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of fwd) if (indeg.has(e.to)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).sort((a, b) => a.declIndex - b.declIndex);
  for (const n of queue) col.set(n.id, 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    for (const e of fwd) {
      if (e.from !== n.id) continue;
      col.set(e.to, Math.max(col.get(e.to) ?? 0, (col.get(n.id) ?? 0) + 1));
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) {
        const next = nodes.find((x) => x.id === e.to);
        if (next) queue.push(next);
      }
    }
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const messages = trial.filter((e) => e.kind === "msg" && !e.fromPool && !e.toPool && nodeIds.has(e.from) && nodeIds.has(e.to));
  if (messages.length === 0) return col;
  const before = new Map(col);
  const limit = nodes.length + edges.length + 2;
  for (let iter = 0; ; iter++) {
    let changed = false;
    for (const e of messages) {
      if ((col.get(e.to) ?? 0) < (col.get(e.from) ?? 0)) {
        col.set(e.to, col.get(e.from));
        changed = true;
      }
    }
    for (const e of fwd) {
      if ((col.get(e.to) ?? 0) < (col.get(e.from) ?? 0) + 1) {
        col.set(e.to, (col.get(e.from) ?? 0) + 1);
        changed = true;
      }
    }
    if (!changed) return col;
    if (iter > limit) return before;
  }
}
function nodesReachingEnd(nodes, edges) {
  const incoming = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    if (edge.kind !== "seq" || edge.isReturn || edge.fromPool || edge.toPool) continue;
    const sources = incoming.get(edge.to) ?? [];
    sources.push(edge.from);
    incoming.set(edge.to, sources);
  }
  const reachable = new Set(nodes.filter((node) => node.kind === "end").map((node) => node.id));
  const queue = [...reachable];
  for (let i = 0; i < queue.length; i++) {
    for (const source of incoming.get(queue[i]) ?? []) {
      if (reachable.has(source)) continue;
      reachable.add(source);
      queue.push(source);
    }
  }
  return reachable;
}
function isLayeringSeq(e, docIds) {
  if (e.fromPool || e.toPool) return false;
  if (e.kind === "msg" || e.kind === "assoc" && !docIds.has(e.to)) return false;
  return true;
}
function reaches(from, to, outAdj) {
  const seen = /* @__PURE__ */ new Set([from]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const e of outAdj.get(queue[i]) ?? []) {
      if (seen.has(e.to)) continue;
      if (e.to === to) return true;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return false;
}
function electReturns(nodes, edges, report, strict2) {
  const docIds = new Set(nodes.filter((n) => isDocLike(n.kind)).map((n) => n.id));
  const layering = edges.filter((e) => isLayeringSeq(e, docIds) && nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
  const fullAdj = /* @__PURE__ */ new Map();
  for (const n of nodes) fullAdj.set(n.id, []);
  for (const e of layering.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    fullAdj.get(e.from)?.push(e);
  }
  for (const e of edges) {
    if (!e.returnHint) continue;
    const ok = e.kind === "seq" && !e.fromPool && !e.toPool && fullAdj.has(e.from) && reaches(e.to, e.from, fullAdj);
    if (!ok) {
      report.push({
        level: strict2 ? "error" : "warning",
        code: strict2 ? "E-254" : "W-254",
        message: `\u623B\u308A\u30D2\u30F3\u30C8 ->> \u306F\u5FAA\u74B0\u3092\u4F5C\u308B\u30B7\u30FC\u30B1\u30F3\u30B9\u306B\u3060\u3051\u4F7F\u3048\u308B: ${e.from} -> ${e.to}`
      });
      continue;
    }
    e.isReturn = true;
    report.push({ level: "info", code: "N-251", message: `\u8FBA ${e.from} -> ${e.to} \u3092\u623B\u308A\u8FBA\u3068\u56FA\u5B9A\uFF08->> \u30D2\u30F3\u30C8\uFF09` });
  }
  const outAdj = /* @__PURE__ */ new Map();
  for (const n of nodes) outAdj.set(n.id, []);
  for (const e of layering.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    if (e.isReturn) continue;
    outAdj.get(e.from)?.push(e);
  }
  const hasIn = new Set(edges.map((e) => e.to));
  const roots = [
    ...nodes.filter((n) => !hasIn.has(n.id)).sort((a, b) => a.declIndex - b.declIndex),
    ...nodes.filter((n) => hasIn.has(n.id)).sort((a, b) => a.declIndex - b.declIndex)
  ];
  const color = /* @__PURE__ */ new Map();
  for (const root of roots) {
    if (color.has(root.id)) continue;
    const stack = [{ id: root.id, i: 0 }];
    color.set(root.id, "gray");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const outs = outAdj.get(frame.id);
      if (frame.i >= outs.length) {
        color.set(frame.id, "black");
        stack.pop();
        continue;
      }
      const e = outs[frame.i++];
      const c = color.get(e.to);
      if (c === "gray") {
        e.isReturn = true;
        report.push({ level: "info", code: "N-250", message: `\u8FBA ${e.from} -> ${e.to} \u3092\u623B\u308A\u8FBA\u3068\u9078\u6319\uFF08\u5FAA\u74B0\u3092\u4F5C\u308B\u8FBA\uFF09` });
      } else if (c === void 0) {
        color.set(e.to, "gray");
        stack.push({ id: e.to, i: 0 });
      }
    }
  }
}

// src/metrics.ts
var GRID = 8;
var FONT_SIZE = 14;
var LINE_H = 20;
var EDGE_FONT_SIZE = 11;
var TITLE_FONT_SIZE = 16;
var ASCII_W = {
  " ": 278,
  "!": 278,
  '"': 355,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 667,
  "'": 191,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  ":": 278,
  ";": 278,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 556,
  "@": 1015,
  "[": 278,
  "\\": 278,
  "]": 278,
  "^": 469,
  _: 556,
  "`": 333,
  "{": 334,
  "|": 260,
  "}": 334,
  "~": 584
};
var NARROW = new Set(`iljftrI.,;:!|'"()[]`);
var WIDE = new Set("mwMW@%&");
function charWidthEm(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 128) {
    if (ASCII_W[ch] !== void 0) return ASCII_W[ch] / 1e3;
    if (cp >= 48 && cp <= 57) return 0.556;
    if (NARROW.has(ch)) return 0.24;
    if (WIDE.has(ch)) return 0.85;
    if (ch >= "A" && ch <= "Z") return 0.68;
    return 0.53;
  }
  if (cp >= 65377 && cp <= 65439) return 0.5;
  return 1;
}
function measureText(text2, fontSize = FONT_SIZE) {
  let w = 0;
  for (const ch of text2) w += charWidthEm(ch);
  return w * fontSize;
}
var KINSOKU_HEAD = new Set(
  "\u3001\u3002\uFF0C\uFF0E\uFF09\u300D\u300F\u3011\u3009\u300B\u3015\uFF5D\u201D\u2019!?\uFF01\uFF1F\u309D\u309E\u3005\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30FC\u30F5\u30F6\u30FB\u2026\u2025:;\uFF1A\uFF1B,.)]}\u301F"
);
var KINSOKU_TAIL = new Set("\uFF08\u300C\u300E\u3010\u3008\u300A\u3014\uFF5B\u201C\u2018([{\u301D");
function isCjk(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 12288 && cp <= 40959 || cp >= 63744 && cp <= 64255 || cp >= 65280 && cp <= 65519;
}
function canBreakBefore(chars, i) {
  if (i <= 0 || i >= chars.length) return false;
  const prev = chars[i - 1];
  const next = chars[i];
  if (KINSOKU_HEAD.has(next)) return false;
  if (KINSOKU_TAIL.has(prev)) return false;
  if (prev === " ") return true;
  if (isCjk(prev) || isCjk(next)) return true;
  return false;
}
function wrapText(text2, maxWidth, fontSize = FONT_SIZE) {
  const chars = Array.from(text2);
  if (chars.length === 0) return [];
  const lines = [];
  let lineStart = 0;
  let lineW = 0;
  let lastBreak = -1;
  for (let i = 0; i < chars.length; i++) {
    const w = charWidthEm(chars[i]) * fontSize;
    if (canBreakBefore(chars, i)) lastBreak = i;
    if (lineW + w > maxWidth && lineW > 0 && lastBreak > lineStart) {
      lines.push(chars.slice(lineStart, lastBreak).join("").trimEnd());
      lineStart = lastBreak;
      lineW = 0;
      for (let j = lineStart; j <= i; j++) lineW += charWidthEm(chars[j]) * fontSize;
      lastBreak = -1;
      continue;
    }
    lineW += w;
  }
  lines.push(chars.slice(lineStart).join("").trimEnd());
  return lines.map((l) => l.replace(/^ +/, ""));
}
function quant(v) {
  return Math.ceil(v / GRID) * GRID;
}

// src/measure.ts
var TASK_MIN_W = 80;
var TASK_MAX_TEXT_W = 96;
var TASK_MIN_H = 56;
var TASK_PAD_X = 14;
var TASK_PAD_Y = 12;
var GW_SIZE = 44;
var EVENT_R = 16;
var OUT_LABEL_FONT = 12;
var OUT_LABEL_LINE_H = 16;
var OUT_LABEL_MAX_W = 152;
var OUT_LABEL_GAP = 6;
function measureNodes(nodes, labelCrossMinus = /* @__PURE__ */ new Set(), orientation = "horizontal") {
  const hanging = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (!isAttachedBoundary(n) || !n.attachedTo) continue;
    const lines = n.label === "" ? [] : wrapText(n.label, OUT_LABEL_MAX_W, OUT_LABEL_FONT);
    const hang = EVENT_R + (lines.length ? lines.length * OUT_LABEL_LINE_H + OUT_LABEL_GAP : 4);
    hanging.set(n.attachedTo, Math.max(hanging.get(n.attachedTo) ?? 0, hang));
  }
  const cells2 = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    cells2.set(n.id, measureNode(n, labelCrossMinus.has(n.id), orientation, hanging.get(n.id) ?? 0));
  }
  return cells2;
}
function measureNode(n, labelCrossMinus, orientation, hang = 0) {
  if (n.kind === "task") {
    const lines2 = wrapText(n.label, TASK_MAX_TEXT_W, FONT_SIZE);
    const textW = Math.max(0, ...lines2.map((l) => measureText(l, FONT_SIZE)));
    const topPad = hasTopTaskIcon(n) ? 12 : 0;
    const bottomPad = hasBottomActivityMarker(n) ? 14 : 0;
    const shapeW = quant(Math.max(TASK_MIN_W, textW + TASK_PAD_X * 2));
    const shapeH = quant(Math.max(TASK_MIN_H, lines2.length * LINE_H + TASK_PAD_Y * 2 + topPad + bottomPad));
    let topExt = shapeH / 2;
    let bottomExt = shapeH / 2;
    let leftExt = shapeW / 2;
    let rightExt = shapeW / 2;
    if (hang > 0) {
      if (orientation === "vertical") rightExt += hang;
      else bottomExt += hang;
    }
    return {
      id: n.id,
      shapeW,
      shapeH,
      topExt,
      bottomExt,
      leftExt,
      rightExt,
      labelLines: lines2,
      labelW: textW,
      labelH: lines2.length * LINE_H
    };
  }
  const lines = n.label === "" ? [] : wrapText(n.label, OUT_LABEL_MAX_W, OUT_LABEL_FONT);
  const labelW = Math.max(0, ...lines.map((l) => measureText(l, OUT_LABEL_FONT)));
  const labelH = lines.length * OUT_LABEL_LINE_H;
  if (n.kind === "store") {
    const w = 44;
    const h = 44;
    return {
      id: n.id,
      shapeW: w,
      shapeH: h,
      topExt: h / 2,
      bottomExt: h / 2 + (lines.length ? labelH + OUT_LABEL_GAP : 0),
      leftExt: w / 2,
      rightExt: Math.max(w / 2, 6 + labelW),
      labelLines: lines,
      labelW,
      labelH
    };
  }
  if (n.kind === "note") {
    const noteLines = wrapText(n.label, 140, OUT_LABEL_FONT);
    const w = Math.max(48, 10 + Math.max(0, ...noteLines.map((l) => measureText(l, OUT_LABEL_FONT))));
    const h = Math.max(28, noteLines.length * OUT_LABEL_LINE_H + 8);
    return {
      id: n.id,
      shapeW: quant(w),
      shapeH: quant(h),
      topExt: quant(h) / 2,
      bottomExt: quant(h) / 2,
      leftExt: quant(w) / 2,
      rightExt: quant(w) / 2,
      labelLines: noteLines,
      labelW: w - 10,
      labelH: noteLines.length * OUT_LABEL_LINE_H
    };
  }
  if (n.kind === "group") {
    const groupLines = wrapText(n.label, 140, OUT_LABEL_FONT);
    const w = Math.max(72, 16 + Math.max(0, ...groupLines.map((l) => measureText(l, OUT_LABEL_FONT))));
    const h = Math.max(40, groupLines.length * OUT_LABEL_LINE_H + 16);
    return {
      id: n.id,
      shapeW: quant(w),
      shapeH: quant(h),
      topExt: quant(h) / 2,
      bottomExt: quant(h) / 2,
      leftExt: quant(w) / 2,
      rightExt: quant(w) / 2,
      labelLines: groupLines,
      labelW: w - 16,
      labelH: groupLines.length * OUT_LABEL_LINE_H
    };
  }
  if (n.kind === "doc") {
    const w = n.subtype === "message" ? 36 : 40;
    const h = n.subtype === "message" ? 28 : 48;
    const extraBottom = n.collection ? 8 : 0;
    return {
      id: n.id,
      shapeW: w,
      shapeH: h + extraBottom,
      topExt: (h + extraBottom) / 2,
      bottomExt: (h + extraBottom) / 2 + (lines.length ? labelH + OUT_LABEL_GAP : 0),
      leftExt: w / 2,
      rightExt: Math.max(w / 2, 6 + labelW),
      labelLines: lines,
      labelW,
      labelH
    };
  }
  if (isGatewayKind(n.kind)) {
    const half = GW_SIZE / 2;
    return {
      id: n.id,
      shapeW: GW_SIZE,
      shapeH: GW_SIZE,
      topExt: half + (lines.length ? labelH + OUT_LABEL_GAP : 0),
      bottomExt: half,
      leftExt: Math.max(half, 8 + labelW),
      rightExt: half,
      labelLines: lines,
      labelW,
      labelH
    };
  }
  if (orientation === "vertical") {
    const sideExt = lines.length ? labelW + OUT_LABEL_GAP : 0;
    return {
      id: n.id,
      shapeW: EVENT_R * 2,
      shapeH: EVENT_R * 2,
      topExt: Math.max(EVENT_R, labelH / 2),
      bottomExt: Math.max(EVENT_R, labelH / 2),
      leftExt: EVENT_R + (labelCrossMinus ? sideExt : 0),
      rightExt: EVENT_R + (labelCrossMinus ? 0 : sideExt),
      labelLines: lines,
      labelW,
      labelH,
      labelSide: labelCrossMinus ? "left" : "right"
    };
  }
  const labelExt = lines.length ? labelH + OUT_LABEL_GAP : 0;
  return {
    id: n.id,
    shapeW: EVENT_R * 2,
    shapeH: EVENT_R * 2,
    topExt: EVENT_R + (labelCrossMinus ? labelExt : 0),
    bottomExt: EVENT_R + (labelCrossMinus ? 0 : labelExt),
    leftExt: Math.max(EVENT_R, labelW / 2),
    rightExt: Math.max(EVENT_R, labelW / 2),
    labelLines: lines,
    labelW,
    labelH,
    labelSide: labelCrossMinus ? "top" : "bottom"
  };
}

// src/place.ts
function isLayeringEdge(e, docIds) {
  if (e.fromPool || e.toPool) return false;
  return !e.isReturn && (e.kind === "seq" || e.kind === "assoc" && docIds.has(e.to));
}
function place(g) {
  const docIds = new Set(g.nodes.filter((n) => isDocLike(n.kind)).map((n) => n.id));
  const col = layerColumns(g, docIds);
  pinBoundaryColumns(g, col, docIds);
  alignMessageTiming(g, col, docIds);
  pullReadableDocColumns(g, col, docIds);
  keepDocsOffForeignSpine(g, col, docIds);
  snapStoresToLaneWriter(g, col);
  keepDocsOffMessageCorridors(g, col, docIds);
  pullStartsToSuccessor(g, col);
  const { row, laneRows, reserved } = assignRows(g, col, docIds);
  const maxCol = Math.max(0, ...[...col.values()]);
  return { col, row, laneRows, maxCol, reserved };
}
function pinBoundaryColumns(g, col, docIds) {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const fwd = g.edges.filter((e) => isLayeringEdge(e, docIds));
  for (let iter = 0; iter < g.nodes.length + 2; iter++) {
    let changed = false;
    for (const n of g.nodes) {
      if (!isAttachedBoundary(n)) continue;
      const hc = col.get(n.attachedTo);
      if (hc === void 0) continue;
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
function pullReadableDocColumns(g, col, docIds) {
  for (const n of g.nodes) {
    if (!docIds.has(n.id)) continue;
    if (g.edges.some((e) => e.kind !== "assoc" && (e.from === n.id || e.to === n.id))) continue;
    const readerCols = g.edges.filter((e) => e.kind === "assoc" && e.from === n.id).flatMap((e) => col.has(e.to) ? [col.get(e.to)] : []);
    const writerCols = g.edges.filter((e) => e.kind === "assoc" && e.to === n.id).flatMap((e) => col.has(e.from) ? [col.get(e.from)] : []);
    if (readerCols.length === 0) continue;
    const target = writerCols.length === 0 ? Math.max(0, Math.min(...readerCols) - 1) : writerCols.length === 1 && readerCols.length === 1 && readerCols[0] > writerCols[0] + 1 ? readerCols[0] - 1 : void 0;
    if (target !== void 0 && target > (col.get(n.id) ?? 0)) col.set(n.id, target);
  }
}
function keepDocsOffForeignSpine(g, col, docIds) {
  const writersOf = (id) => new Set(g.edges.filter((e) => e.kind === "assoc" && e.to === id).map((e) => e.from));
  const foreignSpine = (lane, c, ignore) => g.nodes.some((n) => n.onSpine && n.lane === lane && col.get(n.id) === c && !ignore.has(n.id) && !isDocLike(n.kind) && n.kind !== "start" && n.kind !== "end");
  const nodeCol = (id) => col.get(id) ?? -1;
  const communicates = (id) => g.edges.some((e) => e.kind === "msg" && !e.fromPool && !e.toPool && (e.from === id || e.to === id) && nodeCol(e.from === id ? e.to : e.from) === nodeCol(id));
  for (const n of g.nodes) {
    if (n.kind !== "doc" || !docIds.has(n.id)) continue;
    const writers = writersOf(n.id);
    if (writers.size === 0) continue;
    if (g.edges.some((e) => e.kind === "assoc" && e.from === n.id)) continue;
    if ([...writers].some(communicates)) continue;
    const here = col.get(n.id);
    if (!foreignSpine(n.lane, here, writers)) continue;
    const home = Math.max(...[...writers].map((id) => col.get(id) ?? 0));
    if (home !== here) col.set(n.id, home);
  }
}
function snapStoresToLaneWriter(g, col) {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  for (const n of g.nodes) {
    if (n.kind !== "store") continue;
    if (g.edges.some(
      (e) => e.kind === "assoc" && e.from === n.id && !isDocLike(nodeById.get(e.to)?.kind ?? "doc")
    )) continue;
    const sameLane = g.edges.filter((e) => e.kind === "assoc" && e.to === n.id).map((e) => nodeById.get(e.from)).filter((w) => w !== void 0 && w.lane === n.lane && !isDocLike(w.kind));
    if (sameLane.length === 0) continue;
    const home = Math.max(...sameLane.map((w) => col.get(w.id) ?? 0));
    const here = col.get(n.id) ?? 0;
    if (home < here) col.set(n.id, home);
  }
}
function alignMessageTiming(g, col, docIds) {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const messages = g.edges.filter((e) => e.kind === "msg" && !e.fromPool && !e.toPool && nodeById.has(e.from) && nodeById.has(e.to)).sort((a, b) => a.declIndex - b.declIndex);
  if (messages.length === 0) return;
  const fwd = g.edges.filter((e) => isLayeringEdge(e, docIds) && !isAttachedBoundary(nodeById.get(e.to)));
  const limit = g.nodes.length + g.edges.length + 2;
  const floors = /* @__PURE__ */ new Map();
  const relax = (active2) => {
    for (let iter = 0; ; iter++) {
      let changed = false;
      for (const [id, floor] of floors) {
        if ((col.get(id) ?? 0) < floor) {
          col.set(id, floor);
          changed = true;
        }
      }
      for (const e of active2) {
        const need = col.get(e.from) ?? 0;
        if ((col.get(e.to) ?? 0) < need) {
          col.set(e.to, need);
          changed = true;
        }
      }
      for (const e of fwd) {
        const need = (col.get(e.from) ?? 0) + 1;
        if ((col.get(e.to) ?? 0) < need) {
          col.set(e.to, need);
          changed = true;
        }
      }
      for (const n of g.nodes) {
        if (!isAttachedBoundary(n)) continue;
        const hc = col.get(n.attachedTo);
        if (hc !== void 0 && col.get(n.id) !== hc) {
          col.set(n.id, hc);
          changed = true;
        }
      }
      if (!changed) return true;
      if (iter > limit) return false;
    }
  };
  const active = [];
  for (const m of messages) {
    const snapshot = new Map(col);
    active.push(m);
    if (!relax(active)) {
      active.pop();
      for (const [id, c] of snapshot) col.set(id, c);
    }
  }
  separateStackedCorridors(g, col, active, floors, relax);
}
function separateStackedCorridors(g, col, active, floors, relax) {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const poolIdx = (id) => poolIndex.get(poolOfLane.get(nodeById.get(id)?.lane ?? "") ?? "");
  const spine = (id) => nodeById.get(id)?.onSpine === true;
  const sameNodes = (a, b) => a.from === b.from && a.to === b.to || a.from === b.to && a.to === b.from;
  const tried = /* @__PURE__ */ new Set();
  const maxRounds = active.length * active.length + 1;
  for (let round = 0; round < maxRounds; round++) {
    let bumped = false;
    const seen = /* @__PURE__ */ new Map();
    for (const m of active) {
      const pu = poolIdx(m.from);
      const pv = poolIdx(m.to);
      if (pu === void 0 || pv === void 0 || Math.abs(pu - pv) !== 1) continue;
      const c = col.get(m.from);
      if (c === void 0 || col.get(m.to) !== c) continue;
      const key2 = `${Math.min(pu, pv)}-${Math.max(pu, pv)}:${c}`;
      const earlier = seen.get(key2) ?? [];
      seen.set(key2, [...earlier, m]);
      const first = earlier.find((o) => !sameNodes(o, m) && !tried.has(`${o.id}|${m.id}`));
      if (!first) continue;
      tried.add(`${first.id}|${m.id}`);
      const loser = spine(m.from) && !spine(first.from) ? first : m;
      const snapshot = new Map(col);
      floors.set(loser.from, c + 1);
      if (!relax(active)) {
        floors.delete(loser.from);
        for (const [id, v] of snapshot) col.set(id, v);
        continue;
      }
      bumped = true;
      break;
    }
    if (!bumped) return;
  }
}
function keepDocsOffMessageCorridors(g, col, docIds) {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const laneIndex = new Map(g.lanes.map((l, i) => [l.id, i]));
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const corridors = /* @__PURE__ */ new Set();
  for (const e of g.edges) {
    if (e.kind !== "msg" || e.fromPool || e.toPool) continue;
    const u = nodeById.get(e.from);
    const v = nodeById.get(e.to);
    if (!u || !v || col.get(u.id) !== col.get(v.id)) continue;
    const pu = poolIndex.get(poolOfLane.get(u.lane) ?? "");
    const pv = poolIndex.get(poolOfLane.get(v.lane) ?? "");
    if (pu === void 0 || pv === void 0 || Math.abs(pu - pv) !== 1) continue;
    const c = col.get(u.id);
    const down = pu < pv;
    for (const [end, towardGap] of [[u, down], [v, !down]]) {
      const li = laneIndex.get(end.lane);
      for (const lane of g.lanes) {
        if (poolOfLane.get(lane.id) !== poolOfLane.get(end.lane)) continue;
        const i = laneIndex.get(lane.id);
        if (towardGap ? i >= li : i <= li) corridors.add(`${lane.id}:${c}`);
      }
    }
  }
  if (corridors.size === 0) return;
  for (const n of g.nodes) {
    if (!docIds.has(n.id)) continue;
    if (g.edges.some((e) => e.from === n.id || e.kind !== "assoc" && e.to === n.id)) continue;
    let c = col.get(n.id);
    for (let guard = 0; guard < g.nodes.length && corridors.has(`${n.lane}:${c}`); guard++) c++;
    if (c !== col.get(n.id)) col.set(n.id, c);
  }
}
function pullStartsToSuccessor(g, col) {
  for (const n of g.nodes) {
    if (n.kind !== "start") continue;
    const succ = g.edges.filter((e) => e.kind === "seq" && e.from === n.id).map((e) => col.get(e.to) ?? 0);
    if (succ.length === 0) continue;
    let target = Math.min(...succ) - 1;
    for (const e of g.edges) {
      if (e.kind === "msg" && e.from === n.id && !e.toPool && col.has(e.to)) target = Math.min(target, col.get(e.to));
    }
    if (target > (col.get(n.id) ?? 0)) col.set(n.id, target);
  }
}
function layerColumns(g, docIds) {
  const col = /* @__PURE__ */ new Map();
  const fwd = g.edges.filter((e) => isLayeringEdge(e, docIds));
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of fwd) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = g.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).sort((a, b) => a.declIndex - b.declIndex);
  for (const n of queue) col.set(n.id, 0);
  let qi = 0;
  while (qi < queue.length) {
    const n = queue[qi++];
    for (const e of fwd) {
      if (e.from !== n.id) continue;
      const c = Math.max(col.get(e.to) ?? 0, col.get(n.id) + 1);
      col.set(e.to, c);
      const d = indeg.get(e.to) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(g.nodes.find((x) => x.id === e.to));
    }
  }
  for (const n of g.nodes) if (!col.has(n.id)) col.set(n.id, 0);
  return col;
}
function assignRows(g, col, docIds) {
  const row = /* @__PURE__ */ new Map();
  const laneRows = /* @__PURE__ */ new Map();
  const reserved = /* @__PURE__ */ new Map();
  for (const lane of g.lanes) reserved.set(lane.id, []);
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const outsOf = (id) => g.edges.filter((e) => e.from === id && isLayeringEdge(e, docIds));
  const insOf = (id) => g.edges.filter((e) => e.to === id && isLayeringEdge(e, docIds));
  const spineNodes = g.nodes.filter((n) => n.onSpine).sort((a, b) => col.get(a.id) - col.get(b.id));
  const spineHasLane = new Set(spineNodes.map((n) => n.lane));
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const lane = run[0].lane;
    const c0 = col.get(run[0].id);
    const c1 = col.get(run[run.length - 1].id);
    reserved.get(lane).push({ row: 0, c0, c1 });
    for (const n of run) row.set(n.id, 0);
    run = [];
  };
  for (const n of spineNodes) {
    if (run.length > 0 && run[run.length - 1].lane !== n.lane) flushRun();
    run.push(n);
  }
  flushRun();
  const chainable = (e) => {
    const u = nodeById.get(e.from);
    const v = nodeById.get(e.to);
    return u.lane === v.lane && !u.onSpine && !v.onSpine && col.get(u.id) !== col.get(v.id) && outsOf(u.id).length === 1 && insOf(v.id).length === 1;
  };
  const nextIn = /* @__PURE__ */ new Map();
  const prevIn = /* @__PURE__ */ new Map();
  for (const e of g.edges) {
    if (isLayeringEdge(e, docIds) && chainable(e)) {
      nextIn.set(e.from, e.to);
      prevIn.set(e.to, e.from);
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const chains = [];
  for (const n of g.nodes.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    if (n.onSpine || seen.has(n.id) || isAttachedBoundary(n)) continue;
    let head = n;
    while (prevIn.has(head.id)) head = nodeById.get(prevIn.get(head.id));
    const members = [];
    let cur = head;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      members.push(cur);
      cur = nextIn.has(cur.id) ? nodeById.get(nextIn.get(cur.id)) : void 0;
    }
    chains.push({
      nodes: members,
      lane: head.lane,
      c0: Math.min(...members.map((m) => col.get(m.id))),
      c1: Math.max(...members.map((m) => col.get(m.id))),
      firstDecl: Math.min(...members.map((m) => m.declIndex))
    });
  }
  chains.sort((a, b) => a.c0 - b.c0 || a.firstDecl - b.firstDecl);
  const idsOf = (ch) => new Set(ch.nodes.map((m) => m.id));
  const promotedDoc = (ch) => {
    if (!ch.nodes.every((m) => m.kind === "doc")) return false;
    const ids = idsOf(ch);
    return g.edges.filter((e) => e.kind === "assoc" && (ids.has(e.from) || ids.has(e.to))).length >= 2;
  };
  const overlaps = (a, b) => a.lane === b.lane && a.c0 <= b.c1 && b.c0 <= a.c1;
  const joinOrReturn = (ch) => ch.nodes.some((m) => {
    const seqIns = g.edges.filter((e) => e.kind === "seq" && e.to === m.id);
    return seqIns.length >= 2 || seqIns.some((e) => e.isReturn);
  });
  for (const doc of chains.filter(promotedDoc).sort((a, b) => a.c0 - b.c0 || a.firstDecl - b.firstDecl)) {
    const docAt = chains.indexOf(doc);
    const processAt = chains.findIndex((ch) => ch !== doc && joinOrReturn(ch) && overlaps(ch, doc));
    if (processAt >= 0 && docAt > processAt) {
      chains.splice(docAt, 1);
      chains.splice(processAt, 0, doc);
    }
  }
  const writeOnlyDoc = (ch) => ch.nodes.every((m) => m.kind === "doc") && !g.edges.some((e) => e.kind !== "assoc" && ch.nodes.some((m) => m.id === e.from || m.id === e.to)) && !g.edges.some((e) => e.kind === "assoc" && ch.nodes.some((m) => m.id === e.from));
  const lastWriterOf = (ch) => {
    const writers = [...new Set(
      g.edges.filter((e) => e.kind === "assoc" && ch.nodes.some((m) => m.id === e.to)).map((e) => e.from)
    )];
    if (writers.length === 0) return "";
    return writers.sort((a, b) => col.get(b) - col.get(a) || a.localeCompare(b))[0];
  };
  const laneHasProcess = new Set(g.nodes.filter((n) => !isDocLike(n.kind)).map((n) => n.lane));
  const readOnlyDoc = (ch) => ch.nodes.every((m) => isDocLike(m.kind)) && laneHasProcess.has(ch.lane) && !g.edges.some((e) => ch.nodes.some((m) => m.id === e.to));
  const packed = /* @__PURE__ */ new Set();
  const placeChain = (ch) => {
    const res = reserved.get(ch.lane);
    const startRow = spineHasLane.has(ch.lane) || readOnlyDoc(ch) ? 1 : 0;
    let r = startRow;
    while (res.some((iv) => iv.row === r && iv.c0 <= ch.c1 && ch.c0 <= iv.c1)) r++;
    res.push({ row: r, c0: ch.c0, c1: ch.c1 });
    for (const m of ch.nodes) row.set(m.id, r);
  };
  for (const ch of chains) {
    if (packed.has(ch)) continue;
    const siblings = writeOnlyDoc(ch) ? chains.filter((other) => writeOnlyDoc(other) && other.lane === ch.lane && other.c0 === ch.c0 && other.c1 === ch.c1 && lastWriterOf(other) === lastWriterOf(ch)) : [ch];
    const ordered = siblings.length > 1 ? siblings.slice().sort((a, b) => b.firstDecl - a.firstDecl) : siblings;
    for (const one of ordered) {
      if (packed.has(one)) continue;
      packed.add(one);
      placeChain(one);
    }
  }
  for (const n of g.nodes) {
    if (!isAttachedBoundary(n)) continue;
    const hostRow = n.attachedTo !== void 0 ? row.get(n.attachedTo) : void 0;
    row.set(n.id, hostRow ?? 0);
  }
  for (const lane of g.lanes) {
    const rows = g.nodes.filter((n) => n.lane === lane.id).map((n) => row.get(n.id) ?? 0);
    laneRows.set(lane.id, Math.max(0, ...rows) + 1);
  }
  return { row, laneRows, reserved };
}

// src/route.ts
function route(g, p, optimizeReadability = false, options) {
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const occupied = /* @__PURE__ */ new Map();
  for (const n of g.nodes) {
    if (isAttachedBoundary(n)) continue;
    occupied.set(`${n.lane}:${p.row.get(n.id)}:${p.col.get(n.id)}`, n.id);
  }
  const globalRow = /* @__PURE__ */ new Map();
  const globalChannel = /* @__PURE__ */ new Map();
  const globalPoolGap = /* @__PURE__ */ new Map();
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  let pos = 0;
  let prevPool = null;
  for (const lane of g.lanes) {
    if (prevPool !== null && lane.pool !== prevPool) {
      const pi = poolIndex.get(prevPool);
      if (pi !== void 0) globalPoolGap.set(pi, pos++);
    }
    prevPool = lane.pool;
    const rows = p.laneRows.get(lane.id) ?? 1;
    for (let r = 0; r < rows; r++) {
      globalChannel.set(`${lane.id}:${r}`, pos++);
      globalRow.set(`${lane.id}:${r}`, pos++);
    }
    if (optimizeReadability) globalChannel.set(`${lane.id}:${rows}`, pos++);
  }
  const ctx = {
    g,
    p,
    nodeById,
    occupied,
    globalRow,
    globalChannel,
    globalPoolGap,
    laneRows: p.laneRows,
    gutterRuns: /* @__PURE__ */ new Map(),
    channelRuns: /* @__PURE__ */ new Map(),
    runSeq: { n: 0 },
    gutterLabelNeed: /* @__PURE__ */ new Map(),
    poolGapRuns: /* @__PURE__ */ new Map(),
    colRuns: /* @__PURE__ */ new Map(),
    rowRuns: /* @__PURE__ */ new Map(),
    stubRuns: /* @__PURE__ */ new Map(),
    labelCrossMinus: crossMinusLabelEvents(g),
    planned: /* @__PURE__ */ new Map(),
    optimizeReadability,
    gapDestFlip: options?.gapDestFlip ?? /* @__PURE__ */ new Set()
  };
  const plans = [];
  for (const e of g.edges.slice().sort((a, b) => a.declIndex - b.declIndex)) {
    const plan = e.fromPool || e.toPool ? planPoolMsg(ctx, e) : e.isReturn ? planReturn(ctx, e) : planForward(ctx, e);
    plans.push(plan);
    ctx.planned.set(e.id, plan);
  }
  const { poolGapTracks, poolGapRunTrack } = assignPoolGapTracks(ctx);
  separateSharedEntries(ctx, plans, poolGapRunTrack);
  bundleSameOrigin(ctx, plans);
  const { gutterTracks, gutterRunTrack } = assignGutterTracks(ctx);
  const { channelTracks, channelRunTrack } = assignChannelTracks(ctx);
  return {
    plans,
    gutterTracks,
    channelTracks,
    channelRunTrack,
    gutterRunTrack,
    poolGapTracks,
    poolGapRunTrack,
    gutterLabelNeed: ctx.gutterLabelNeed,
    poolExteriorGutter: ctx.poolExteriorGutter
  };
}
function separateSharedEntries(ctx, plans, poolGapRunTrack) {
  const edgeById = new Map(ctx.g.edges.map((e) => [e.id, e]));
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ladderRank = (plan, ownId, peerCol) => {
    const pt = plan.points.find((q) => q.y.t === "poolChannel");
    if (!pt || pt.y.t !== "poolChannel") return 0;
    const t = poolGapRunTrack.get(pt.y.run) ?? 0;
    const own = ctx.nodeById.get(ownId);
    const ownPool = own ? poolIndex.get(lanePool.get(own.lane) ?? "") : void 0;
    if (ownPool === void 0) return 0;
    const isUpper = ownPool === pt.y.gap;
    const dir = Math.sign(peerCol - (ctx.p.col.get(ownId) ?? 0));
    const closeness = isUpper ? -t : t;
    return dir * closeness;
  };
  const hasCorridorRun = (plan) => plan.points.some((q) => q.y.t === "poolChannel");
  const groups = /* @__PURE__ */ new Map();
  const add2 = (nodeId, side, axis, slot) => {
    const key2 = `${nodeId}:${side}`;
    const group2 = groups.get(key2) ?? { axis, nodeId, slots: [] };
    group2.slots.push(slot);
    groups.set(key2, group2);
  };
  for (const plan of plans) {
    const e = edgeById.get(plan.edgeId);
    if (!e) continue;
    const toKind = ctx.nodeById.get(e.to)?.kind;
    if (e.kind !== "seq") {
      const boxLike = toKind === "task" || toKind === "doc" || toKind === "store" || toKind === "note";
      if (boxLike && (plan.toSide === "top" || plan.toSide === "bottom")) {
        const a = plan.points.at(-2)?.x, b = plan.points.at(-1)?.x;
        if (a?.t === "nodeCX" && b?.t === "nodeCX" && a.id === e.to && b.id === e.to) {
          add2(e.to, plan.toSide, "x", { plan, end: "to" });
        }
      } else if ((toKind === "doc" || toKind === "store" || toKind === "note") && (plan.toSide === "left" || plan.toSide === "right")) {
        const b = plan.points.at(-1)?.y;
        if (plan.points.length >= 3 && b?.t === "portY" && b.id === e.to && b.side === plan.toSide) {
          add2(e.to, plan.toSide, "y", { plan, end: "to" });
        }
      }
      if (ctx.nodeById.get(e.from)?.kind === "task" && (plan.fromSide === "bottom" || plan.fromSide === "top")) {
        const a = plan.points[0]?.x, b = plan.points[1]?.x;
        if (a?.t === "nodeCX" && b?.t === "nodeCX" && a.id === e.from && b.id === e.from) {
          add2(e.from, plan.fromSide, "x", { plan, end: "from" });
        }
      }
    }
    if (toKind && (isGatewayKind(toKind) || isEventKind(toKind))) {
      if (plan.toSide === "top" || plan.toSide === "bottom") {
        const a = plan.points.at(-2)?.x, b = plan.points.at(-1)?.x;
        const stub = a?.t === "nodeCX" && b?.t === "nodeCX" && a.id === e.to && b.id === e.to;
        const eventFace = isEventKind(toKind);
        if (stub && (eventFace || e.kind === "seq" && plan.points.length >= 4)) {
          add2(e.to, plan.toSide, "x", { plan, end: "to" });
        }
      } else if (e.kind === "seq" && plan.points.length >= 4 && (plan.toSide === "left" || plan.toSide === "right")) {
        add2(e.to, plan.toSide, "y", { plan, end: "to" });
      }
    }
  }
  for (const { axis, nodeId, slots: group2 } of groups.values()) {
    if (group2.length < 2) continue;
    group2.sort((a, b) => {
      const ea = edgeById.get(a.plan.edgeId), eb = edgeById.get(b.plan.edgeId);
      const na = ctx.nodeById.get(a.end === "to" ? ea.from : ea.to);
      const nb = ctx.nodeById.get(b.end === "to" ? eb.from : eb.to);
      const ca = na ? axis === "x" ? ctx.p.col.get(na.id) : ctx.globalRow.get(rowKey(na.lane, ctx.p.row.get(na.id))) : ea.declIndex;
      const cb = nb ? axis === "x" ? ctx.p.col.get(nb.id) : ctx.globalRow.get(rowKey(nb.lane, ctx.p.row.get(nb.id))) : eb.declIndex;
      if (axis === "x" && na && nb && hasCorridorRun(a.plan) && hasCorridorRun(b.plan)) {
        const ra = ladderRank(a.plan, nodeId, ca);
        const rb = ladderRank(b.plan, nodeId, cb);
        if (ra !== rb) return ra - rb;
      }
      if (ca !== cb) return ca - cb;
      return ea.declIndex - eb.declIndex;
    });
    const kind = ctx.nodeById.get(nodeId)?.kind;
    const gw = kind !== void 0 && isGatewayKind(kind);
    const limit = gw ? 14 : axis === "x" ? 10 : 8;
    const stepMax = gw ? 24 : 12;
    const step = Math.min(stepMax, 2 * limit / (group2.length - 1));
    group2.forEach(({ plan, end }, i) => {
      const offset = (i - (group2.length - 1) / 2) * step;
      if (axis === "x") {
        const a = end === "to" ? plan.points.length - 2 : 0;
        plan.points[a].x = nodeCX(nodeId, offset);
        plan.points[a + 1].x = nodeCX(nodeId, offset);
      } else if (end === "from") {
        const base = plan.points[0]?.y.t === "nodeCY" ? plan.points[0].y.offset ?? 0 : 0;
        plan.points[0].y = nodeCY(nodeId, base + offset);
        if (plan.points[1]?.y.t === "nodeCY") plan.points[1].y = nodeCY(nodeId, base + offset);
      } else {
        plan.points.at(-2).y = nodeCY(nodeId, offset);
        plan.points.at(-1).y = nodeCY(nodeId, offset);
      }
    });
  }
}
function bundleSameOrigin(ctx, plans) {
  const edgeById = new Map(ctx.g.edges.map((e) => [e.id, e]));
  const groups = /* @__PURE__ */ new Map();
  for (const plan of plans) {
    const e = edgeById.get(plan.edgeId);
    if (!e || e.kind !== "assoc") continue;
    const src = ctx.nodeById.get(e.from);
    if (!src || isGw(src)) continue;
    const key2 = `${e.from}|${e.kind}|${plan.fromSide}`;
    const list = groups.get(key2) ?? [];
    list.push(plan);
    groups.set(key2, list);
  }
  for (const group2 of groups.values()) {
    if (group2.length < 2) continue;
    if (group2[0]?.fromSide !== "right") continue;
    if (!group2.every((plan) => ctx.nodeById.get(edgeById.get(plan.edgeId).to)?.kind === "store")) continue;
    group2.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
    offsetOriginStubs(group2);
    shareOriginTrunk(group2);
  }
}
function offsetOriginStubs(group2) {
  if (group2[0]?.fromSide !== "right") return;
  const n = group2.length;
  const step = Math.min(12, 16 / (n - 1));
  group2.forEach((plan, i) => {
    const offset = (i - (n - 1) / 2) * step;
    const p0 = plan.points[0];
    const p1 = plan.points[1];
    if (!p0 || p0.y.t !== "nodeCY") return;
    const base = p0.y.offset ?? 0;
    const id = p0.y.id;
    p0.y = nodeCY(id, base + offset);
    if (p1?.y.t === "nodeCY" && p1.y.id === id) p1.y = nodeCY(id, base + offset);
  });
}
function shareOriginTrunk(group2) {
  const donor = group2.find((plan) => plan.points.some((pt) => pt.x.t === "gutter" || pt.y.t === "channel"));
  if (!donor) return;
  const donorGutterPoint = donor.points.find((pt) => pt.x.t === "gutter" && pt.x.side === "exit");
  const donorGutter = donorGutterPoint?.x.t === "gutter" ? donorGutterPoint.x : void 0;
  const donorTrunkY = donor.points.find((pt, i) => i >= 2 && (pt.y.t === "channel" || pt.y.t === "rowMid"))?.y;
  if (!donorGutter && !donorTrunkY) return;
  const sameY = (a, b) => a.t === b.t && JSON.stringify(a) === JSON.stringify(b);
  for (const plan of group2) {
    if (plan === donor) continue;
    if (donorGutter) {
      for (const pt of plan.points) {
        if (pt.x.t === "gutter" && pt.x.side === "exit" && pt.x.g === donorGutter.g) pt.x = donorGutter;
      }
    }
    if (!donorTrunkY) continue;
    for (let i = 1; i + 1 < plan.points.length; i++) {
      const a = plan.points[i];
      const b = plan.points[i + 1];
      if (!sameY(a.y, b.y)) continue;
      if (a.y.t !== "channel" && a.y.t !== "rowMid") continue;
      a.y = donorTrunkY;
      b.y = donorTrunkY;
      break;
    }
  }
}
function assignPoolGapTracks(ctx) {
  const poolGapTracks = /* @__PURE__ */ new Map();
  const poolGapRunTrack = /* @__PURE__ */ new Map();
  for (const [gap, runs] of ctx.poolGapRuns) {
    const placed = [];
    const score2 = (r) => {
      let n = 0;
      for (const other of runs) {
        if (other.runId === r.runId) continue;
        if (r.upperX >= other.a && r.upperX <= other.b) n--;
        if (r.lowerX >= other.a && r.lowerX <= other.b) n++;
      }
      return n;
    };
    const before = (p, r) => p.runId !== r.runId && (p.upperX >= r.a && p.upperX <= r.b || r.lowerX >= p.a && r.lowerX <= p.b);
    const preds = /* @__PURE__ */ new Map();
    for (const r of runs) {
      preds.set(r.runId, runs.filter((p) => before(p, r) && !before(r, p)));
    }
    const remaining = runs.slice().sort((a, b) => score2(a) - score2(b) || a.runId - b.runId);
    const done = /* @__PURE__ */ new Set();
    const place2 = (r) => {
      let t = Math.max(0, ...(preds.get(r.runId) ?? []).filter((p) => done.has(p.runId)).map((p) => poolGapRunTrack.get(p.runId) + 1));
      while (placed.some((p) => p.t === t && p.run.a <= r.b && r.a <= p.run.b)) t++;
      placed.push({ run: r, t });
      poolGapRunTrack.set(r.runId, t);
      done.add(r.runId);
      poolGapTracks.set(gap, Math.max(poolGapTracks.get(gap) ?? 0, t + 1));
    };
    while (remaining.length > 0) {
      const i = remaining.findIndex((r2) => (preds.get(r2.runId) ?? []).every((p) => done.has(p.runId)));
      const r = remaining.splice(i >= 0 ? i : 0, 1)[0];
      place2(r);
    }
  }
  return { poolGapTracks, poolGapRunTrack };
}
function assignGutterTracks(ctx) {
  const gutterTracks = /* @__PURE__ */ new Map();
  const gutterRunTrack = /* @__PURE__ */ new Map();
  for (const [key2, runs] of ctx.gutterRuns) {
    const i = key2.lastIndexOf(":");
    const gi = Number(key2.slice(0, i));
    const side = key2.slice(i + 1);
    const sorted = runs.slice().sort((x, y) => x.b - x.a - (y.b - y.a) || x.runId - y.runId);
    const placed = [];
    let count = 0;
    for (const r of sorted) {
      let t = 0;
      while (placed.some((p) => p.t === t && p.a <= r.b && r.a <= p.b)) t++;
      placed.push({ a: r.a, b: r.b, t });
      gutterRunTrack.set(r.runId, t);
      count = Math.max(count, t + 1);
    }
    const cur = gutterTracks.get(gi) ?? { exit: 0, entry: 0 };
    cur[side] = Math.max(cur[side], count);
    gutterTracks.set(gi, cur);
  }
  return { gutterTracks, gutterRunTrack };
}
function assignChannelTracks(ctx) {
  const channelTracks = /* @__PURE__ */ new Map();
  const channelRunTrack = /* @__PURE__ */ new Map();
  for (const [key2, runs] of ctx.channelRuns) {
    const contains = (list) => (r) => list.filter((o) => o.runId !== r.runId && o.entryX > r.a && o.entryX < r.b).length;
    const aboveList = runs.filter((r) => r.side === "above");
    const belowList = runs.filter((r) => r.side === "below");
    const cAbove = contains(aboveList);
    const cBelow = contains(belowList);
    const above = aboveList.sort((x, y) => cAbove(x) - cAbove(y) || x.depth - y.depth || x.runId - y.runId);
    const below = belowList.sort((x, y) => cBelow(x) - cBelow(y) || y.depth - x.depth || x.runId - y.runId);
    const firstFit = (list) => {
      const placed = [];
      const out = /* @__PURE__ */ new Map();
      for (const r of list) {
        let t = 0;
        while (placed.some((p) => p.t === t && p.a <= r.b && r.a <= p.b)) t++;
        placed.push({ a: r.a, b: r.b, t });
        out.set(r.runId, t);
      }
      return out;
    };
    const aboveT = firstFit(above);
    const belowT = firstFit(below);
    const topCount = Math.max(0, ...[...aboveT.values()].map((t) => t + 1));
    const bottomCount = Math.max(0, ...[...belowT.values()].map((t) => t + 1));
    const total = topCount + bottomCount;
    for (const [runId, t] of aboveT) channelRunTrack.set(runId, t);
    for (const [runId, t] of belowT) channelRunTrack.set(runId, total - 1 - t);
    channelTracks.set(key2, total);
  }
  return { channelTracks, channelRunTrack };
}
var rowKey = (lane, row) => `${lane}:${row}`;
function nodeBetweenOnRow(ctx, lane, row, c0, c1) {
  for (let c = c0; c <= c1; c++) if (ctx.occupied.has(`${lane}:${row}:${c}`)) return true;
  return false;
}
function railClear(ctx, col, a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const [key2, gr] of ctx.globalRow) {
    if (gr <= lo || gr >= hi) continue;
    const i = key2.lastIndexOf(":");
    const occ = ctx.occupied.get(`${key2.slice(0, i)}:${key2.slice(i + 1)}:${col}`);
    if (occ !== void 0 && ctx.nodeById.get(occ)?.kind !== "doc") return false;
  }
  return true;
}
function columnClear(ctx, col, a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const [key2, gr] of ctx.globalRow) {
    if (gr <= lo || gr >= hi) continue;
    const i = key2.lastIndexOf(":");
    if (ctx.occupied.has(`${key2.slice(0, i)}:${key2.slice(i + 1)}:${col}`)) return false;
  }
  return true;
}
function colRunEnd(e, side) {
  if (side === "from") return e.fromPool ? `#pool:${e.fromPool}` : e.from;
  return e.toPool ? `#pool:${e.toPool}` : e.to;
}
function reserveColRun(ctx, col, a, b, e, from = colRunEnd(e, "from"), shareFace, pairEdge) {
  const to = colRunEnd(e, "to");
  if (!canReserveColRun(ctx, col, a, b, from, to, shareFace, pairEdge)) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runs = ctx.colRuns.get(col) ?? [];
  runs.push({ a: lo, b: hi, from, to, edge: e.id });
  ctx.colRuns.set(col, runs);
  return true;
}
function canReserveColRun(ctx, col, a, b, from, to, shareFace, pairEdge) {
  if (!columnClear(ctx, col, a, b)) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return !(ctx.colRuns.get(col) ?? []).some(
    (r) => r.from !== from && r.to !== to && r.a < hi && lo < r.b && r.edge !== pairEdge && !(shareFace !== void 0 && !r.exclusive && (r.from === shareFace || r.to === shareFace))
  );
}
function markExclusiveColRun(ctx, col) {
  const runs = ctx.colRuns.get(col);
  const last = runs?.at(-1);
  if (last) last.exclusive = true;
}
function canReserveRowRun(ctx, lane, row, a, b, from, to) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return !(ctx.rowRuns.get(rowKey(lane, row)) ?? []).some(
    (r) => r.from !== from && r.to !== to && r.a < hi && lo < r.b
  );
}
function noteRowRun(ctx, lane, row, a, b, e) {
  const key2 = rowKey(lane, row);
  const runs = ctx.rowRuns.get(key2) ?? [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  runs.push({ a: lo, b: hi, from: colRunEnd(e, "from"), to: colRunEnd(e, "to") });
  ctx.rowRuns.set(key2, runs);
}
var gutterScale = (g) => g - 0.5;
function reserveStubRun(ctx, lane, row, yOffset, a, b, e) {
  const key2 = `${rowKey(lane, row)}@${yOffset}`;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const from = colRunEnd(e, "from");
  const to = colRunEnd(e, "to");
  const runs = ctx.stubRuns.get(key2) ?? [];
  if (runs.some((r) => r.from !== from && r.to !== to && r.a <= hi && lo <= r.b)) return false;
  runs.push({ a: lo, b: hi, from, to });
  ctx.stubRuns.set(key2, runs);
  return true;
}
function noteStubRun(ctx, lane, row, yOffset, a, b, e) {
  const key2 = `${rowKey(lane, row)}@${yOffset}`;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runs = ctx.stubRuns.get(key2) ?? [];
  runs.push({ a: lo, b: hi, from: colRunEnd(e, "from"), to: colRunEnd(e, "to") });
  ctx.stubRuns.set(key2, runs);
}
var fallbackOffset = (e) => e.kind === "seq" ? 0 : e.kind === "msg" ? 8 : 10;
function allocGutter(ctx, gi, side, a, b) {
  const key2 = `${gi}:${side}`;
  const runs = ctx.gutterRuns.get(key2) ?? [];
  ctx.gutterRuns.set(key2, runs);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const runId = ctx.runSeq.n++;
  runs.push({ a: lo, b: hi, runId });
  return runId;
}
function allocChannel(ctx, lane, row, cA, cB, side, depth, entryX) {
  const key2 = rowKey(lane, row);
  const runs = ctx.channelRuns.get(key2) ?? [];
  ctx.channelRuns.set(key2, runs);
  const [lo, hi] = cA < cB ? [cA, cB] : [cB, cA];
  const runId = ctx.runSeq.n++;
  runs.push({ a: lo, b: hi, side, depth, entryX, runId });
  return runId;
}
function allocPoolGap(ctx, gap, upperX, lowerX) {
  const runs = ctx.poolGapRuns.get(gap) ?? [];
  ctx.poolGapRuns.set(gap, runs);
  const [a, b] = upperX < lowerX ? [upperX, lowerX] : [lowerX, upperX];
  const runId = ctx.runSeq.n++;
  runs.push({ a, b, upperX, lowerX, runId });
  return runId;
}
var portX = (id, side) => ({ t: "portX", id, side });
var portY = (id, side) => ({ t: "portY", id, side });
var portStubY = (id, side, offset = 16) => ({ t: "portStubY", id, side, offset });
var gutterX = (gi, side, run) => ({ t: "gutter", g: gi, side, run });
var nodeCX = (id, offset = 0) => ({ t: "nodeCX", id, offset });
var nodeCY = (id, offset = 0) => ({ t: "nodeCY", id, offset });
var channelY = (lane, row, run) => ({ t: "channel", lane, row, run });
var poolChannelY = (gap, run) => ({ t: "poolChannel", gap, run });
var rowMidY = (lane, row) => ({ t: "rowMid", lane, row });
function cellOf(ctx, id) {
  const n = ctx.nodeById.get(id);
  return { lane: n.lane, row: ctx.p.row.get(id), col: ctx.p.col.get(id), node: n };
}
var isGw = (n) => isGatewayKind(n.kind);
var hasSequenceOut = (ctx, id) => ctx.g.edges.some((e) => e.from === id && e.kind === "seq");
var needsBottomMessagePort = (ctx, id) => hasSequenceOut(ctx, id) && ctx.g.edges.some((e) => e.from === id && e.kind === "msg" && !e.toPool);
var blackboxLane = (ctx, pool) => ctx.g.lanes.find((lane) => lane.pool === pool && lane.blackbox)?.id;
var bottomFree = (n) => !(isEventKind(n.kind) && n.label !== "");
function poolMessageFacesBottom(ctx, nodeId) {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const node = ctx.nodeById.get(nodeId);
  if (!node) return false;
  const ni = poolIndex.get(lanePool.get(node.lane));
  if (ni === void 0) return false;
  return ctx.g.edges.some((e) => {
    if (e.kind !== "msg" || e.to !== nodeId || !e.fromPool) return false;
    const fi = poolIndex.get(e.fromPool);
    return fi !== void 0 && fi > ni;
  });
}
function eventLabelMovedUp(ctx, nodeId) {
  return ctx.labelCrossMinus.has(nodeId);
}
function eventHasBottomOut(ctx, id) {
  return ctx.g.edges.some((e) => e.from === id && (e.kind === "assoc" || e.kind === "msg" && !e.toPool));
}
function eventBottomOpen(ctx, n) {
  if (eventHasBottomOut(ctx, n.id)) return false;
  return bottomFree(n) || poolMessageFacesBottom(ctx, n.id);
}
function topFree(ctx, u) {
  for (const e2 of ctx.g.edges) {
    if (e2.to !== u.node.id) continue;
    if (e2.isReturn || e2.kind !== "seq" || e2.fromPool) return false;
    if (isGw(u.node)) {
      const s = ctx.nodeById.get(e2.from);
      if (!s) return false;
      if (s.lane !== u.lane || ctx.p.row.get(s.id) !== u.row) return false;
    }
  }
  return true;
}
function gapOrderConsistent(ctx, col, mine) {
  for (const r of ctx.colRuns.get(col) ?? []) {
    if (!r.gap || r.gap.upperSide === mine.upperSide) continue;
    const P = mine.upperSide ? mine : r.gap;
    const Q = mine.upperSide ? r.gap : mine;
    const reverse = Q.upperX >= P.a && Q.upperX <= P.b || P.lowerX >= Q.a && P.lowerX <= Q.b;
    if (reverse) return false;
  }
  return true;
}
function westFree(ctx, v, e) {
  let crossRow = 0;
  for (const o of ctx.g.edges) {
    if (o.to !== v.node.id || o.kind !== "seq" || o.isReturn || o.fromPool) continue;
    if (sameRowSource(ctx, o, v)) return false;
    crossRow++;
  }
  return crossRow === 1 && ctx.g.edges.some((o) => o.id === e.id && o.kind === "seq");
}
function faceQuiet(ctx, nodeId, face, e, ignore, skip) {
  return !ctx.g.edges.some((o) => {
    if (o.id === e.id || o.id === ignore || o.from !== nodeId && o.to !== nodeId) return false;
    if (skip?.(o)) return false;
    const done = ctx.planned.get(o.id);
    if (done) {
      return o.from === nodeId && done.fromSide === face || o.to === nodeId && done.toSide === face;
    }
    return o.to === nodeId && (o.kind !== "seq" || o.isReturn || !!o.fromPool) || o.from === nodeId && o.kind !== "seq";
  });
}
function topUsersSlottable(ctx, u) {
  for (const e2 of ctx.g.edges) {
    if (e2.to !== u.node.id) continue;
    if (e2.kind === "seq" && (e2.isReturn || isGw(u.node) && !sameRowSource(ctx, e2, u))) return false;
  }
  return true;
}
function sameRowSource(ctx, e2, u) {
  const s = ctx.nodeById.get(e2.from);
  return !!s && s.lane === u.lane && ctx.p.row.get(s.id) === u.row;
}
function noteLabelNeed(ctx, e, gi) {
  if (!e.label) return;
  const w = measureText(e.label, EDGE_FONT_SIZE) + 12;
  ctx.gutterLabelNeed.set(gi, Math.max(ctx.gutterLabelNeed.get(gi) ?? 0, w));
}
function planForward(ctx, e) {
  const u = cellOf(ctx, e.from);
  const v = cellOf(ctx, e.to);
  const sameRow = u.lane === v.lane && u.row === v.row;
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row));
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row));
  const rowFree = !nodeBetweenOnRow(ctx, v.lane, v.row, u.col + 1, v.col - 1);
  const rowFreeWide = rowFree && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`);
  if (e.kind === "assoc") {
    if (u.col === v.col && gV > gU && reserveColRun(ctx, u.col, gU, gV, e)) {
      markExclusiveColRun(ctx, u.col);
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "top",
        pattern: "drop",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.to), y: portY(e.to, "top") }
        ]
      };
    }
    if (u.col === v.col && gV < gU && isDocLike(u.node.kind) && !isDocLike(v.node.kind) && faceQuiet(ctx, v.node.id, "bottom", e) && bottomOutFree(ctx, v, gV) && (bottomFree(v.node) || eventBottomOpen(ctx, v.node)) && // 文書の上辺は行違いの書き手(drop / チャネル降下)が使い得る。計画済みなら入口面で判定し、
    // 未計画なら同一行の書き手(左入り)だけを許す
    !ctx.g.edges.some((o) => {
      if (o.id === e.id || o.kind !== "assoc" || o.to !== u.node.id) return false;
      const done = ctx.planned.get(o.id);
      if (done) return done.toSide === "top";
      const w = ctx.nodeById.get(o.from);
      return !w || w.lane !== u.lane || ctx.p.row.get(w.id) !== u.row;
    }) && reserveColRun(ctx, u.col, gV, gU, e)) {
      markExclusiveColRun(ctx, u.col);
      return {
        edgeId: e.id,
        fromSide: "top",
        toSide: "bottom",
        pattern: "drop",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "top") },
          { x: nodeCX(e.to), y: portY(e.to, "bottom") }
        ]
      };
    }
    if (!isDocLike(v.node.kind)) {
      return planRowThenColumn(ctx, e, u, v, gU, gV) ?? planIntoTop(ctx, e, u, v, gU);
    }
    const otherAssoc = ctx.g.edges.some(
      (o) => o.kind === "assoc" && o.id !== e.id && o.to === e.from
    );
    if (gV > gU && v.col > u.col && otherAssoc && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && rowFree && reserveColRun(ctx, u.col, gU, gV, e)) {
      noteRowRun(ctx, v.lane, v.row, u.col, v.col, e);
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "left",
        pattern: "drop",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.from), y: rowMidY(v.lane, v.row) },
          { x: portX(e.to, "left"), y: portY(e.to, "left") }
        ]
      };
    }
    if (v.node.kind === "doc" && u.col === v.col && gV > gU && u.node.kind === "task" && railClear(ctx, u.col, gU, gV) && !ctx.g.edges.some((o) => o.id !== e.id && o.to === u.node.id && o.kind !== "seq")) {
      const rail = nodeCX(e.from, 28);
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "right",
        pattern: "row-approach",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.from), y: portStubY(e.from, "bottom") },
          { x: rail, y: portStubY(e.from, "bottom") },
          { x: rail, y: portY(e.to, "right") },
          { x: portX(e.to, "right"), y: portY(e.to, "right") }
        ]
      };
    }
    const coWriterHere = ctx.g.edges.some(
      (other) => other.kind === "assoc" && other.to === e.to && other.from !== e.from && ctx.p.col.get(other.from) === v.col
    );
    const adjacentPeer2 = ctx.occupied.get(`${v.lane}:${v.row}:${u.col}`);
    const adjacentFour = v.col === u.col + 1 && adjacentPeer2 !== void 0 && ctx.g.edges.some((other) => other.from === adjacentPeer2 && other.to === e.to);
    if (v.node.kind === "doc" && gV > gU && u.lane === v.lane && u.col < v.col && v.col - u.col <= 2 && coWriterHere && !adjacentFour && railClear(ctx, v.col, gU, gV)) {
      const rail = nodeCX(e.to, 48);
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "right",
        pattern: "row-approach",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.from), y: portStubY(e.from, "bottom") },
          { x: rail, y: portStubY(e.from, "bottom") },
          { x: rail, y: portY(e.to, "right") },
          { x: portX(e.to, "right"), y: portY(e.to, "right") }
        ]
      };
    }
    if (!sameRow) {
      const l = planRowThenColumn(ctx, e, u, v, gU, gV);
      if (l) return l;
    }
  }
  if (e.kind === "msg") {
    const poolPair = poolPairIndices(ctx, u, v);
    if (poolPair && Math.abs(poolPair[0] - poolPair[1]) > 1) {
      return planAcrossPoolExterior(ctx, e, u, v, poolPair[0], poolPair[1]);
    }
    const poolGap = adjacentPoolGap(ctx, u, v);
    if (poolGap !== void 0) return planAcrossPoolGap(ctx, e, u, v, poolGap);
    const chV = ctx.globalChannel.get(rowKey(v.lane, v.row));
    if (gV > gU && bottomFree(u.node)) {
      if (u.col === v.col && reserveColRun(ctx, u.col, gU, gV, e)) {
        markExclusiveColRun(ctx, u.col);
        return {
          edgeId: e.id,
          fromSide: "bottom",
          toSide: "top",
          pattern: "drop",
          points: [
            { x: nodeCX(e.from), y: portY(e.from, "bottom") },
            { x: nodeCX(e.to), y: portY(e.to, "top") }
          ]
        };
      }
      if (!ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && reserveColRun(ctx, u.col, gU, chV, e)) {
        const tCh2 = allocChannel(ctx, v.lane, v.row, u.col, v.col, "above", gU, u.col);
        return {
          edgeId: e.id,
          fromSide: "bottom",
          toSide: "top",
          pattern: "channel-approach",
          points: [
            { x: nodeCX(e.from), y: portY(e.from, "bottom") },
            { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh2) },
            { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh2) },
            { x: nodeCX(e.to), y: portY(e.to, "top") }
          ]
        };
      }
      if (hasSequenceOut(ctx, e.from)) return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
    }
    if (gV < gU && topFree(ctx, u)) {
      if (!ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && !(v.row > 0 && ctx.occupied.has(`${v.lane}:${v.row - 1}:${u.col}`)) && reserveColRun(ctx, u.col, chV, gU, e)) {
        const tCh2 = allocChannel(ctx, v.lane, v.row, u.col, v.col, "below", gU, u.col);
        return {
          edgeId: e.id,
          fromSide: "top",
          toSide: "top",
          pattern: "channel-approach",
          points: [
            { x: nodeCX(e.from), y: portY(e.from, "top") },
            { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh2) },
            { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh2) },
            { x: nodeCX(e.to), y: portY(e.to, "top") }
          ]
        };
      }
      const detour = planMessageFromTopViaGutter(ctx, e, u, v, gU, chV);
      if (detour) return detour;
    }
    if (bottomFree(u.node) && hasSequenceOut(ctx, e.from)) {
      return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
    }
    return planIntoTop(ctx, e, u, v, gU);
  }
  if (sameRow && rowFree && e.kind === "seq") {
    noteLabelNeed(ctx, e, u.col + 1);
    noteRowRun(ctx, u.lane, u.row, u.col, v.col, e);
    const points = isAttachedBoundary(u.node) ? [
      { x: portX(e.from, "right"), y: portY(e.from, "right") },
      { x: portX(e.to, "left"), y: portY(e.from, "right") },
      { x: portX(e.to, "left"), y: portY(e.to, "left") }
    ] : [
      { x: portX(e.from, "right"), y: portY(e.from, "right") },
      { x: portX(e.to, "left"), y: portY(e.to, "left") }
    ];
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: "left",
      pattern: "direct",
      points
    };
  }
  if (sameRow && rowFree && e.kind === "assoc" && u.col < v.col) {
    noteLabelNeed(ctx, e, u.col + 1);
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: "left",
      pattern: "direct",
      points: [
        { x: portX(e.from, "right"), y: nodeCY(e.from, -10) },
        { x: portX(e.to, "left"), y: nodeCY(e.to, -10) }
      ]
    };
  }
  if (ctx.optimizeReadability && e.kind === "seq" && isGw(u.node) && !e.onSpine && sameRow && v.col > u.col && !rowFree) {
    const useBelow = alternativeBelow(ctx, u);
    const channelRow = useBelow ? u.row + 1 : u.row;
    const channelPos = ctx.globalChannel.get(rowKey(u.lane, channelRow));
    const sourceFree = useBelow ? true : topFree(ctx, u);
    const targetFree = useBelow ? bottomFree(v.node) && noDownwardOut(ctx, v, gV) && !needsBottomMessagePort(ctx, v.node.id) : true;
    if (channelPos !== void 0 && sourceFree && targetFree && reserveColRun(ctx, u.col, gU, channelPos, e) && reserveColRun(ctx, v.col, gV, channelPos, e)) {
      const side = useBelow ? "bottom" : "top";
      const tCh2 = allocChannel(
        ctx,
        u.lane,
        channelRow,
        u.col,
        v.col,
        useBelow ? "above" : "below",
        gU,
        u.col
      );
      return {
        edgeId: e.id,
        fromSide: side,
        toSide: side,
        pattern: "channel-approach",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, side) },
          { x: nodeCX(e.from), y: channelY(u.lane, channelRow, tCh2) },
          { x: nodeCX(e.to), y: channelY(u.lane, channelRow, tCh2) },
          { x: nodeCX(e.to), y: portY(e.to, side) }
        ]
      };
    }
  }
  if (ctx.optimizeReadability && isGw(u.node) && !e.onSpine && gV < gU && !isGw(v.node) && topFree(ctx, u) && rowFree && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && canReserveRowRun(ctx, v.lane, v.row, u.col, v.col, e.from, e.to) && reserveColRun(ctx, u.col, gV, gU, e)) {
    noteRowRun(ctx, v.lane, v.row, u.col, v.col, e);
    return {
      edgeId: e.id,
      fromSide: "top",
      toSide: "left",
      pattern: "rise",
      points: [
        { x: nodeCX(e.from), y: portY(e.from, "top") },
        { x: nodeCX(e.from), y: rowMidY(v.lane, v.row) },
        { x: portX(e.to, "left"), y: portY(e.to, "left") }
      ]
    };
  }
  if (ctx.optimizeReadability && isGw(u.node) && !e.onSpine && gV < gU && topFree(ctx, u) && rowFreeWide) {
    const chU = ctx.globalChannel.get(rowKey(u.lane, u.row));
    if (canReserveRowRun(ctx, v.lane, v.row, gutterScale(u.col + 1), v.col, e.from, e.to) && reserveColRun(ctx, u.col, chU, gU, e)) {
      const g12 = u.col + 1;
      noteLabelNeed(ctx, e, g12);
      noteRowRun(ctx, v.lane, v.row, gutterScale(g12), v.col, e);
      const tSrc = allocChannel(ctx, u.lane, u.row, u.col, g12 - 0.5, "below", gU, u.col);
      const r12 = allocGutter(ctx, g12, "exit", chU, gV);
      return {
        edgeId: e.id,
        fromSide: "top",
        toSide: "left",
        pattern: "row-approach",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "top") },
          { x: nodeCX(e.from), y: channelY(u.lane, u.row, tSrc) },
          { x: gutterX(g12, "exit", r12), y: channelY(u.lane, u.row, tSrc) },
          { x: gutterX(g12, "exit", r12), y: rowMidY(v.lane, v.row) },
          { x: portX(e.to, "left"), y: portY(e.to, "left") }
        ]
      };
    }
  }
  if (isGw(u.node) && !e.onSpine && gV > gU) {
    if (!isGw(v.node) && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && rowFree && reserveColRun(ctx, u.col, gU, gV, e)) {
      noteRowRun(ctx, v.lane, v.row, u.col, v.col, e);
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "left",
        pattern: "drop",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.from), y: rowMidY(v.lane, v.row) },
          { x: portX(e.to, "left"), y: portY(e.to, "left") }
        ]
      };
    }
    const chV = ctx.globalChannel.get(rowKey(v.lane, v.row));
    if (!ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && reserveColRun(ctx, u.col, gU, chV, e)) {
      const tCh2 = allocChannel(ctx, v.lane, v.row, u.col, v.col, "above", gU, u.col);
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "top",
        pattern: "channel-approach",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.from), y: channelY(v.lane, v.row, tCh2) },
          { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh2) },
          { x: nodeCX(e.to), y: portY(e.to, "top") }
        ]
      };
    }
    return planFromBottomViaGutter(ctx, e, u, v, gU, chV);
  }
  if (!sameRow && isGw(v.node)) {
    const l = planRowThenColumn(ctx, e, u, v, gU, gV);
    if (l) return l;
    if (!westFree(ctx, v, e)) return planIntoTop(ctx, e, u, v, gU);
  }
  if (!sameRow && isEventKind(v.node.kind) && gU > gV && eventBottomOpen(ctx, v.node)) {
    return planRowThenColumn(ctx, e, u, v, gU, gV) ?? planIntoTop(ctx, e, u, v, gU);
  }
  const g1 = u.col + 1;
  noteLabelNeed(ctx, e, g1);
  const srcY = fallbackRightY(e, e.from);
  if (rowFreeWide && !sameRow && u.col < v.col && (e.kind !== "seq" || canReserveRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e.from, e.to)) && canReserveRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e.from, e.to)) {
    if (e.kind === "seq") noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
    else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
    noteRowRun(ctx, v.lane, v.row, gutterScale(g1), v.col, e);
    const run = allocGutter(ctx, g1, "exit", gU, gV);
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: "left",
      pattern: "row-approach",
      points: [
        { x: portX(e.from, "right"), y: srcY },
        { x: gutterX(g1, "exit", run), y: srcY },
        { x: gutterX(g1, "exit", run), y: rowMidY(v.lane, v.row) },
        { x: portX(e.to, "left"), y: portY(e.to, "left") }
      ]
    };
  }
  const adjacentPeer = ctx.occupied.get(`${v.lane}:${v.row}:${u.col}`);
  if (e.kind === "assoc" && !isDocLike(u.node.kind) && v.node.kind === "doc" && u.lane === v.lane && !sameRow && v.col === g1 && adjacentPeer !== void 0 && ctx.g.edges.some((other) => other.from === adjacentPeer && other.to === e.to)) {
    noteRowRun(ctx, v.lane, v.row, gutterScale(v.col), v.col, e);
    noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(v.col), e);
    const run = allocGutter(ctx, v.col, "entry", gU, gV);
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: "left",
      pattern: "row-approach",
      points: [
        { x: portX(e.from, "right"), y: srcY },
        { x: gutterX(v.col, "entry", run), y: srcY },
        { x: gutterX(v.col, "entry", run), y: rowMidY(v.lane, v.row) },
        { x: portX(e.to, "left"), y: portY(e.to, "left") }
      ]
    };
  }
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row));
  const r1 = allocGutter(ctx, g1, "exit", gU, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, g1 - 0.5, v.col - 0.5, gU < chPos ? "above" : "below", gU, g1 - 0.5);
  const gv = v.col;
  const r2 = allocGutter(ctx, gv, "entry", chPos, gV);
  if (e.kind === "seq") noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
  noteRowRun(ctx, v.lane, v.row, gutterScale(gv), v.col, e);
  return {
    edgeId: e.id,
    fromSide: "right",
    toSide: "left",
    pattern: "channel-approach",
    points: [
      { x: portX(e.from, "right"), y: srcY },
      { x: gutterX(g1, "exit", r1), y: srcY },
      { x: gutterX(g1, "exit", r1), y: channelY(v.lane, v.row, tCh) },
      { x: gutterX(gv, "entry", r2), y: channelY(v.lane, v.row, tCh) },
      { x: gutterX(gv, "entry", r2), y: rowMidY(v.lane, v.row) },
      { x: portX(e.to, "left"), y: portY(e.to, "left") }
    ]
  };
}
function fallbackRightY(e, fromId) {
  if (e.kind === "seq") return portY(fromId, "right");
  return nodeCY(fromId, e.kind === "msg" ? 8 : 10);
}
function adjacentPoolGap(ctx, u, v) {
  const pair = poolPairIndices(ctx, u, v);
  if (!pair) return void 0;
  const [ui, vi] = pair;
  return Math.abs(ui - vi) === 1 ? Math.min(ui, vi) : void 0;
}
function poolPairIndices(ctx, u, v) {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ui = poolIndex.get(lanePool.get(u.lane));
  const vi = poolIndex.get(lanePool.get(v.lane));
  return ui !== void 0 && vi !== void 0 ? [ui, vi] : void 0;
}
function alternativeBelow(ctx, u) {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ownPool = lanePool.get(u.lane);
  const ownIndex = ownPool === void 0 ? void 0 : poolIndex.get(ownPool);
  if (ownIndex === void 0) return true;
  const nodePool = (id) => {
    const n = ctx.nodeById.get(id);
    return n ? lanePool.get(n.lane) : void 0;
  };
  let above = 0;
  let below = 0;
  for (const e of ctx.g.edges) {
    if (e.kind !== "msg") continue;
    const fromPool = e.fromPool ?? nodePool(e.from);
    const toPool = e.toPool ?? nodePool(e.to);
    if (fromPool !== ownPool && toPool !== ownPool) continue;
    const other = fromPool === ownPool ? toPool : fromPool;
    const oi = other === void 0 ? void 0 : poolIndex.get(other);
    if (oi === void 0) continue;
    if (oi < ownIndex) above++;
    if (oi > ownIndex) below++;
  }
  return above >= below;
}
function planAcrossPoolGap(ctx, e, u, v, gap) {
  const lanePool = new Map(ctx.g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(ctx.g.pools.map((pl, i) => [pl.id, i]));
  const ui = poolIndex.get(lanePool.get(u.lane));
  const down = ui === gap;
  const gapPos = ctx.globalPoolGap.get(gap);
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row));
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row));
  const z = planAcrossPoolGapZ(ctx, e, u, v, gap, gapPos, gU, gV, down);
  if (z) return z;
  const rightward = v.col > u.col;
  const sameCol = v.col === u.col;
  let fromSide = sameCol ? "right" : rightward ? "left" : "right";
  let toSide = sameCol ? "left" : rightward ? "left" : "right";
  let srcG = fromSide === "left" ? u.col : u.col + 1;
  let dstG = toSide === "left" ? v.col : v.col + 1;
  if (ctx.gapDestFlip.has(e.id)) {
    toSide = toSide === "left" ? "right" : "left";
    dstG = toSide === "left" ? v.col : v.col + 1;
  }
  const srcYOffset = down ? 8 : -8;
  const stub = (side, c, g) => side === "left" ? [gutterScale(g), c] : [c, gutterScale(g)];
  if (!reserveStubRun(ctx, u.lane, u.row, srcYOffset, ...stub(fromSide, u.col, srcG), e)) {
    const altSide = fromSide === "left" ? "right" : "left";
    const altG = altSide === "left" ? u.col : u.col + 1;
    if (reserveStubRun(ctx, u.lane, u.row, srcYOffset, ...stub(altSide, u.col, altG), e)) {
      fromSide = altSide;
      srcG = altG;
    }
  }
  let dstMagnitude = toSide === "left" ? 12 : 14;
  let dstYOffset = down ? -dstMagnitude : dstMagnitude;
  if (!reserveStubRun(ctx, v.lane, v.row, dstYOffset, ...stub(toSide, v.col, dstG), e)) {
    const altSide = toSide === "left" ? "right" : "left";
    const altG = altSide === "left" ? v.col : v.col + 1;
    const altMag = altSide === "left" ? 12 : 14;
    const altOffset = down ? -altMag : altMag;
    if (reserveStubRun(ctx, v.lane, v.row, altOffset, ...stub(altSide, v.col, altG), e)) {
      toSide = altSide;
      dstG = altG;
      dstMagnitude = altMag;
      dstYOffset = altOffset;
    }
  }
  const srcRun = allocGutter(ctx, srcG, "exit", gU, gapPos);
  const dstRun = allocGutter(ctx, dstG, "entry", gapPos, gV);
  const srcScale = srcG - 0.5;
  const dstScale = dstG - 0.5;
  const run = allocPoolGap(ctx, gap, down ? srcScale : dstScale, down ? dstScale : srcScale);
  return {
    edgeId: e.id,
    fromSide,
    toSide,
    pattern: "channel-approach",
    points: [
      { x: portX(e.from, fromSide), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, "exit", srcRun), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, "exit", srcRun), y: poolChannelY(gap, run) },
      { x: gutterX(dstG, "entry", dstRun), y: poolChannelY(gap, run) },
      { x: gutterX(dstG, "entry", dstRun), y: nodeCY(e.to, dstYOffset) },
      { x: portX(e.to, toSide), y: nodeCY(e.to, dstYOffset) }
    ]
  };
}
function planAcrossPoolGapZ(ctx, e, u, v, gap, gapPos, gU, gV, down) {
  if (isAttachedBoundary(u.node) || isAttachedBoundary(v.node)) return void 0;
  const otherMsg = (id) => ctx.g.edges.some((o) => o.id !== e.id && o.kind === "msg" && (o.from === id || o.to === id));
  if (isGw(u.node) && otherMsg(u.node.id) || isGw(v.node) && otherMsg(v.node.id)) return void 0;
  const bottomLabelFree = (n) => bottomFree(n) || eventLabelMovedUp(ctx, n.id);
  const slotted = (n) => n.kind === "task";
  const fromSide = down ? "bottom" : "top";
  const toSide = down ? "top" : "bottom";
  if (down) {
    if (!bottomLabelFree(u.node)) return void 0;
    if (isGw(u.node) && !bottomOutFree(ctx, u, gU)) return void 0;
    if (eventLabelMovedUp(ctx, v.node.id)) return void 0;
  } else {
    if (!topFree(ctx, u) && !(slotted(u.node) && topUsersSlottable(ctx, u))) return void 0;
    if (isEventKind(u.node.kind) && eventLabelMovedUp(ctx, u.node.id)) return void 0;
    if (!bottomLabelFree(v.node)) return void 0;
    if (v.node.kind !== "task" && eventHasBottomOut(ctx, v.node.id) && !isEventKind(v.node.kind)) return void 0;
    if (isGw(v.node) && !bottomOutFree(ctx, v, gV)) return void 0;
  }
  const straight = u.col === v.col;
  const pair = straight ? ctx.g.edges.find((o) => o.kind === "msg" && o.from === e.to && o.to === e.from) : void 0;
  const pairPlan = pair ? ctx.planned.get(pair.id) : void 0;
  const pairId = pair?.id;
  const sameSourceMsg = (o) => o.kind === "msg" && o.from === u.node.id;
  const sameTargetMsg = (o) => o.kind === "msg" && o.to === v.node.id;
  if (straight && !(faceQuiet(ctx, u.node.id, fromSide, e, pairId, sameSourceMsg) && faceQuiet(ctx, v.node.id, toSide, e, pairId, sameTargetMsg))) return void 0;
  const returnExitsFace = ctx.g.edges.some((o) => {
    if (o.from !== u.node.id || o.kind !== "seq" || !o.isReturn) return false;
    const done = ctx.planned.get(o.id);
    return done ? done.fromSide === fromSide : true;
  });
  if (returnExitsFace) return void 0;
  const shareU = !straight && slotted(u.node) ? u.node.id : void 0;
  const shareV = !straight && slotted(v.node) ? v.node.id : void 0;
  const gapRun = {
    a: Math.min(u.col, v.col),
    b: Math.max(u.col, v.col),
    upperX: down ? u.col : v.col,
    lowerX: down ? v.col : u.col
  };
  if (!straight) {
    if (!gapOrderConsistent(ctx, u.col, { ...gapRun, upperSide: down })) return void 0;
    if (!gapOrderConsistent(ctx, v.col, { ...gapRun, upperSide: !down })) return void 0;
  }
  if (!canReserveColRun(ctx, u.col, gU, gapPos, e.from, e.to, shareU, pairId)) return void 0;
  if (!canReserveColRun(ctx, v.col, gapPos, gV, e.from, e.to, shareV, pairId)) return void 0;
  reserveColRun(ctx, u.col, gU, gapPos, e, e.from, shareU, pairId);
  if (straight) markExclusiveColRun(ctx, u.col);
  else ctx.colRuns.get(u.col).at(-1).gap = { ...gapRun, upperSide: down };
  reserveColRun(ctx, v.col, gapPos, gV, e, e.from, shareV, pairId);
  if (straight) markExclusiveColRun(ctx, v.col);
  else ctx.colRuns.get(v.col).at(-1).gap = { ...gapRun, upperSide: !down };
  if (straight) {
    const PAIR = 6;
    const off = pair === void 0 ? 0 : pairPlan ? PAIR : -PAIR;
    return {
      edgeId: e.id,
      fromSide,
      toSide,
      pattern: "drop",
      points: [
        { x: nodeCX(e.from, off), y: portY(e.from, fromSide) },
        { x: nodeCX(e.to, off), y: portY(e.to, toSide) }
      ]
    };
  }
  const run = allocPoolGap(ctx, gap, down ? u.col : v.col, down ? v.col : u.col);
  return {
    edgeId: e.id,
    fromSide,
    toSide,
    pattern: "channel-approach",
    points: [
      { x: nodeCX(e.from), y: portY(e.from, fromSide) },
      { x: nodeCX(e.from), y: poolChannelY(gap, run) },
      { x: nodeCX(e.to), y: poolChannelY(gap, run) },
      { x: nodeCX(e.to), y: portY(e.to, toSide) }
    ]
  };
}
function planAcrossPoolExterior(ctx, e, u, v, ui, vi) {
  const down = ui < vi;
  const srcGap = down ? ui : ui - 1;
  const dstGap = down ? vi - 1 : vi;
  const srcGapPos = ctx.globalPoolGap.get(srcGap);
  const dstGapPos = ctx.globalPoolGap.get(dstGap);
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row));
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row));
  const srcG = u.col + 1;
  const dstG = v.col + 1;
  const outerG = ctx.p.maxCol + 2;
  ctx.poolExteriorGutter = outerG;
  const srcRun = allocGutter(ctx, srcG, "exit", gU, srcGapPos);
  const dstRun = allocGutter(ctx, dstG, "entry", dstGapPos, gV);
  const outerRun = allocGutter(ctx, outerG, "exit", srcGapPos, dstGapPos);
  const srcPoolRun = allocPoolGap(ctx, srcGap, srcG - 0.5, outerG + 0.5);
  const dstPoolRun = allocPoolGap(ctx, dstGap, outerG + 0.5, dstG - 0.5);
  const srcYOffset = down ? 8 : -8;
  const dstYOffset = down ? -14 : 14;
  noteStubRun(ctx, u.lane, u.row, srcYOffset, u.col, gutterScale(srcG), e);
  noteStubRun(ctx, v.lane, v.row, dstYOffset, v.col, gutterScale(dstG), e);
  return {
    edgeId: e.id,
    fromSide: "right",
    toSide: "right",
    pattern: "channel-approach",
    points: [
      { x: portX(e.from, "right"), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, "exit", srcRun), y: nodeCY(e.from, srcYOffset) },
      { x: gutterX(srcG, "exit", srcRun), y: poolChannelY(srcGap, srcPoolRun) },
      { x: gutterX(outerG, "exit", outerRun), y: poolChannelY(srcGap, srcPoolRun) },
      { x: gutterX(outerG, "exit", outerRun), y: poolChannelY(dstGap, dstPoolRun) },
      { x: gutterX(dstG, "entry", dstRun), y: poolChannelY(dstGap, dstPoolRun) },
      { x: gutterX(dstG, "entry", dstRun), y: nodeCY(e.to, dstYOffset) },
      { x: portX(e.to, "right"), y: nodeCY(e.to, dstYOffset) }
    ]
  };
}
function planFromBottomViaGutter(ctx, e, u, v, gU, chV) {
  const g1 = u.col + 1;
  noteLabelNeed(ctx, e, g1);
  const rGutter = allocGutter(ctx, g1, "exit", gU, chV);
  const tDst = allocChannel(
    ctx,
    v.lane,
    v.row,
    g1 - 0.5,
    v.col,
    gU < chV ? "above" : "below",
    gU,
    g1 - 0.5
  );
  return {
    edgeId: e.id,
    fromSide: "bottom",
    toSide: "top",
    pattern: "channel-approach",
    points: [
      { x: nodeCX(e.from), y: portY(e.from, "bottom") },
      { x: nodeCX(e.from), y: portStubY(e.from, "bottom") },
      { x: gutterX(g1, "exit", rGutter), y: portStubY(e.from, "bottom") },
      { x: gutterX(g1, "exit", rGutter), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: portY(e.to, "top") }
    ]
  };
}
function planMessageFromTopViaGutter(ctx, e, u, v, gU, chV) {
  const chU = ctx.globalChannel.get(rowKey(u.lane, u.row));
  if (chU === void 0 || !reserveColRun(ctx, u.col, chU, gU, e)) return void 0;
  const g1 = u.col + 1;
  noteLabelNeed(ctx, e, g1);
  const tSrc = allocChannel(ctx, u.lane, u.row, u.col, g1 - 0.5, "below", gU, u.col);
  const rGutter = allocGutter(ctx, g1, "exit", chU, chV);
  const tDst = allocChannel(
    ctx,
    v.lane,
    v.row,
    g1 - 0.5,
    v.col,
    chU < chV ? "above" : "below",
    chU,
    g1 - 0.5
  );
  return {
    edgeId: e.id,
    fromSide: "top",
    toSide: "top",
    pattern: "channel-approach",
    points: [
      { x: nodeCX(e.from), y: portY(e.from, "top") },
      { x: nodeCX(e.from), y: channelY(u.lane, u.row, tSrc) },
      { x: gutterX(g1, "exit", rGutter), y: channelY(u.lane, u.row, tSrc) },
      { x: gutterX(g1, "exit", rGutter), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tDst) },
      { x: nodeCX(e.to), y: portY(e.to, "top") }
    ]
  };
}
function planIntoTop(ctx, e, u, v, gU) {
  const vRowPos = ctx.globalRow.get(rowKey(v.lane, v.row));
  const fromBelow = gU > vRowPos;
  const chBelowKey = rowKey(v.lane, v.row + 1);
  const canEnterBottom = fromBelow && ctx.globalChannel.has(chBelowKey) && bottomOutFree(ctx, v, vRowPos) && !ctx.occupied.has(`${v.lane}:${v.row + 1}:${v.col}`) && (bottomFree(v.node) || eventBottomOpen(ctx, v.node)) && !needsBottomMessagePort(ctx, v.node.id);
  const farTargetGutter = ctx.optimizeReadability && fromBelow && !canEnterBottom && u.lane === v.lane && u.col < v.col && !nodeBetweenOnRow(ctx, u.lane, u.row, u.col + 1, v.col);
  const g1 = farTargetGutter ? v.col + 1 : u.col + 1;
  noteLabelNeed(ctx, e, g1);
  if (e.kind === "seq") noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(g1), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
  if (canEnterBottom) {
    const chB = ctx.globalChannel.get(chBelowKey);
    const r12 = allocGutter(ctx, g1, farTargetGutter ? "entry" : "exit", gU, chB);
    const tCh2 = allocChannel(ctx, v.lane, v.row + 1, g1 - 0.5, v.col, "below", gU, g1 - 0.5);
    const srcY2 = fallbackRightY(e, e.from);
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: "bottom",
      pattern: "channel-approach",
      points: [
        { x: portX(e.from, "right"), y: srcY2 },
        { x: gutterX(g1, farTargetGutter ? "entry" : "exit", r12), y: srcY2 },
        { x: gutterX(g1, farTargetGutter ? "entry" : "exit", r12), y: channelY(v.lane, v.row + 1, tCh2) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row + 1, tCh2) },
        { x: nodeCX(e.to), y: portY(e.to, "bottom") }
      ]
    };
  }
  if (fromBelow && isEventKind(v.node.kind) && eventBottomOpen(ctx, v.node) && !needsBottomMessagePort(ctx, v.node.id)) {
    const side = farTargetGutter ? "entry" : "exit";
    const run = allocGutter(ctx, g1, side, gU, vRowPos);
    const srcY2 = fallbackRightY(e, e.from);
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: "bottom",
      pattern: "channel-approach",
      points: [
        { x: portX(e.from, "right"), y: srcY2 },
        { x: gutterX(g1, side, run), y: srcY2 },
        { x: gutterX(g1, side, run), y: portStubY(e.to, "bottom") },
        { x: nodeCX(e.to), y: portStubY(e.to, "bottom") },
        { x: nodeCX(e.to), y: portY(e.to, "bottom") }
      ]
    };
  }
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row));
  const gutterSide = farTargetGutter ? "entry" : "exit";
  const r1 = allocGutter(ctx, g1, gutterSide, gU, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, g1 - 0.5, v.col, gU < chPos ? "above" : "below", gU, g1 - 0.5);
  const srcY = fallbackRightY(e, e.from);
  return {
    edgeId: e.id,
    fromSide: "right",
    toSide: "top",
    pattern: "channel-approach",
    points: [
      { x: portX(e.from, "right"), y: srcY },
      { x: gutterX(g1, gutterSide, r1), y: srcY },
      { x: gutterX(g1, gutterSide, r1), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: portY(e.to, "top") }
    ]
  };
}
function planRowThenColumn(ctx, e, u, v, gU, gV) {
  if (gU === gV || v.col <= u.col) return void 0;
  if (isGw(u.node) && !e.onSpine) return void 0;
  if (isAttachedBoundary(u.node) || isAttachedBoundary(v.node)) return void 0;
  if (isDocLike(v.node.kind) && e.kind !== "assoc") return void 0;
  if (nodeBetweenOnRow(ctx, u.lane, u.row, u.col + 1, v.col)) return void 0;
  const fromBelow = gU > gV;
  const side = fromBelow ? "bottom" : "top";
  if (fromBelow) {
    if (!bottomOutFree(ctx, v, gV) || needsBottomMessagePort(ctx, v.node.id)) return void 0;
    if (!(bottomFree(v.node) || eventBottomOpen(ctx, v.node))) return void 0;
    if (v.node.kind !== "task" && !isDocLike(v.node.kind) && eventHasBottomOut(ctx, v.node.id)) return void 0;
  } else if (isEventKind(v.node.kind) && e.kind === "seq") {
    return void 0;
  }
  if (!canReserveRowRun(ctx, u.lane, u.row, u.col, v.col, e.from, e.to)) return void 0;
  if (!reserveColRun(ctx, v.col, gU, gV, e)) return void 0;
  noteRowRun(ctx, u.lane, u.row, u.col, v.col, e);
  noteLabelNeed(ctx, e, u.col + 1);
  const srcY = fallbackRightY(e, e.from);
  return {
    edgeId: e.id,
    fromSide: "right",
    toSide: side,
    pattern: "row-column",
    points: [
      { x: portX(e.from, "right"), y: srcY },
      { x: nodeCX(e.to), y: srcY },
      { x: nodeCX(e.to), y: portY(e.to, side) }
    ]
  };
}
function noDownwardOut(ctx, v, vRowPos) {
  for (const e2 of ctx.g.edges) {
    if (e2.from !== v.node.id || e2.isReturn) continue;
    if (e2.toPool) {
      const lane = blackboxLane(ctx, e2.toPool);
      const bandPos = lane === void 0 ? void 0 : ctx.globalRow.get(rowKey(lane, 0));
      if (bandPos !== void 0 && bandPos > vRowPos) return false;
      continue;
    }
    const t = ctx.nodeById.get(e2.to);
    if (!t) continue;
    const tPos = ctx.globalRow.get(rowKey(t.lane, ctx.p.row.get(t.id)));
    if (tPos > vRowPos) return false;
  }
  return true;
}
function bottomOutFree(ctx, v, vRowPos) {
  for (const e2 of ctx.g.edges) {
    if (e2.from !== v.node.id || e2.isReturn) continue;
    if (e2.toPool) {
      const lane = blackboxLane(ctx, e2.toPool);
      const bandPos = lane === void 0 ? void 0 : ctx.globalRow.get(rowKey(lane, 0));
      if (bandPos !== void 0 && bandPos > vRowPos) return false;
      continue;
    }
    const t = ctx.nodeById.get(e2.to);
    if (!t) continue;
    const tPos = ctx.globalRow.get(rowKey(t.lane, ctx.p.row.get(t.id)));
    if (tPos <= vRowPos) continue;
    if (e2.kind === "assoc" || e2.kind === "msg") {
      if (v.node.kind === "task") continue;
      return false;
    }
    if (e2.kind === "seq" && isGw(v.node) && !e2.onSpine) return false;
  }
  return true;
}
function planPoolMsg(ctx, e) {
  if (e.toPool) {
    const u = cellOf(ctx, e.from);
    const lane2 = blackboxLane(ctx, e.toPool);
    const bandPos2 = ctx.globalRow.get(rowKey(lane2, 0));
    const gU = ctx.globalRow.get(rowKey(u.lane, u.row));
    const below = bandPos2 > gU;
    if (below && bottomFree(u.node) && reserveColRun(ctx, u.col, gU, bandPos2, e)) {
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "top",
        pattern: "drop",
        points: [
          { x: nodeCX(e.from), y: portY(e.from, "bottom") },
          { x: nodeCX(e.from), y: { t: "laneEdge", lane: lane2, edge: "top" } }
        ]
      };
    }
    const g1 = u.col + 1;
    const run2 = allocGutter(ctx, g1, "exit", gU, bandPos2);
    const srcY = fallbackRightY(e, e.from);
    noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(g1), e);
    return {
      edgeId: e.id,
      fromSide: "right",
      toSide: below ? "top" : "bottom",
      pattern: "channel-approach",
      points: [
        { x: portX(e.from, "right"), y: srcY },
        { x: gutterX(g1, "exit", run2), y: srcY },
        { x: gutterX(g1, "exit", run2), y: { t: "laneEdge", lane: lane2, edge: below ? "top" : "bottom" } }
      ]
    };
  }
  const v = cellOf(ctx, e.to);
  const lane = blackboxLane(ctx, e.fromPool);
  const bandPos = ctx.globalRow.get(rowKey(lane, 0));
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row));
  const above = bandPos < gV;
  if (!isEventKind(v.node.kind)) {
    if (above && reserveColRun(ctx, v.col, bandPos, gV, e, `#pool:${lane}`)) {
      return {
        edgeId: e.id,
        fromSide: "bottom",
        toSide: "top",
        pattern: "drop",
        points: [
          { x: nodeCX(e.to), y: { t: "laneEdge", lane, edge: "bottom" } },
          { x: nodeCX(e.to), y: portY(e.to, "top") }
        ]
      };
    }
    const chPos2 = ctx.globalChannel.get(rowKey(v.lane, v.row));
    const gx2 = v.col + 1;
    const run2 = allocGutter(ctx, gx2, "exit", bandPos, chPos2);
    const tCh2 = allocChannel(ctx, v.lane, v.row, gx2 - 0.5, v.col, bandPos < chPos2 ? "above" : "below", bandPos, gx2 - 0.5);
    return {
      edgeId: e.id,
      fromSide: above ? "bottom" : "top",
      toSide: "top",
      pattern: "channel-approach",
      points: [
        { x: gutterX(gx2, "exit", run2), y: { t: "laneEdge", lane, edge: above ? "bottom" : "top" } },
        { x: gutterX(gx2, "exit", run2), y: channelY(v.lane, v.row, tCh2) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh2) },
        { x: nodeCX(e.to), y: portY(e.to, "top") }
      ]
    };
  }
  const face = above ? "top" : "bottom";
  const poolEdge = above ? "bottom" : "top";
  const faceOpen = face === "top" || eventBottomOpen(ctx, v.node);
  const enter = faceOpen ? face : "top";
  if ((enter === "top" ? above : !above) && reserveColRun(ctx, v.col, bandPos, gV, e, `#pool:${lane}`)) {
    return {
      edgeId: e.id,
      fromSide: poolEdge,
      toSide: enter,
      pattern: "drop",
      points: [
        { x: nodeCX(e.to), y: { t: "laneEdge", lane, edge: poolEdge } },
        { x: nodeCX(e.to), y: portY(e.to, enter) }
      ]
    };
  }
  const gx = v.col + 1;
  if (enter === "bottom") {
    const belowRow = v.row + 1;
    const belowCh = ctx.globalChannel.get(rowKey(v.lane, belowRow));
    if (belowCh !== void 0) {
      const run3 = allocGutter(ctx, gx, "exit", bandPos, belowCh);
      const tCh2 = allocChannel(ctx, v.lane, belowRow, gx - 0.5, v.col, "below", bandPos, gx - 0.5);
      return {
        edgeId: e.id,
        fromSide: poolEdge,
        toSide: "bottom",
        pattern: "channel-approach",
        points: [
          { x: gutterX(gx, "exit", run3), y: { t: "laneEdge", lane, edge: poolEdge } },
          { x: gutterX(gx, "exit", run3), y: channelY(v.lane, belowRow, tCh2) },
          { x: nodeCX(e.to), y: channelY(v.lane, belowRow, tCh2) },
          { x: nodeCX(e.to), y: portY(e.to, "bottom") }
        ]
      };
    }
    const run2 = allocGutter(ctx, gx, "exit", bandPos, gV);
    return {
      edgeId: e.id,
      fromSide: poolEdge,
      toSide: "bottom",
      pattern: "channel-approach",
      points: [
        { x: gutterX(gx, "exit", run2), y: { t: "laneEdge", lane, edge: poolEdge } },
        { x: gutterX(gx, "exit", run2), y: portStubY(e.to, "bottom") },
        { x: nodeCX(e.to), y: portStubY(e.to, "bottom") },
        { x: nodeCX(e.to), y: portY(e.to, "bottom") }
      ]
    };
  }
  const chPos = ctx.globalChannel.get(rowKey(v.lane, v.row));
  const run = allocGutter(ctx, gx, "exit", bandPos, chPos);
  const tCh = allocChannel(ctx, v.lane, v.row, gx - 0.5, v.col, bandPos < chPos ? "above" : "below", bandPos, gx - 0.5);
  return {
    edgeId: e.id,
    fromSide: poolEdge,
    toSide: "top",
    pattern: "channel-approach",
    points: [
      { x: gutterX(gx, "exit", run), y: { t: "laneEdge", lane, edge: poolEdge } },
      { x: gutterX(gx, "exit", run), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, tCh) },
      { x: nodeCX(e.to), y: portY(e.to, "top") }
    ]
  };
}
function planReturn(ctx, e) {
  const u = cellOf(ctx, e.from);
  const v = cellOf(ctx, e.to);
  const gU = ctx.globalRow.get(rowKey(u.lane, u.row));
  const gV = ctx.globalRow.get(rowKey(v.lane, v.row));
  if (ctx.optimizeReadability) {
    const outerRow = gV < gU ? u.row + 1 : gV > gU ? u.row : u.row + 1;
    const outer = ctx.globalChannel.get(rowKey(u.lane, outerRow));
    const targetSide = outer !== void 0 && outer < gV ? "top" : "bottom";
    const targetDirect = targetSide === "top" || bottomFree(v.node) && noDownwardOut(ctx, v, gV) && !needsBottomMessagePort(ctx, v.node.id);
    if (outer !== void 0 && targetDirect && reserveColRun(ctx, v.col, outer, gV, e)) {
      const gup2 = u.col + 1;
      const sourceSide = outer < gU ? "top" : "bottom";
      const sourceDirect = sourceSide === "top" ? topFree(ctx, u) : bottomFree(u.node);
      if (sourceDirect && reserveColRun(ctx, u.col, outer, gU, e)) {
        const t3 = allocChannel(
          ctx,
          u.lane,
          outerRow,
          v.col,
          u.col,
          outer < gU ? "below" : "above",
          gU,
          u.col
        );
        return {
          edgeId: e.id,
          fromSide: sourceSide,
          toSide: targetSide,
          pattern: "return",
          points: [
            { x: nodeCX(e.from), y: portY(e.from, sourceSide) },
            { x: nodeCX(e.from), y: channelY(u.lane, outerRow, t3) },
            { x: nodeCX(e.to), y: channelY(u.lane, outerRow, t3) },
            { x: nodeCX(e.to), y: portY(e.to, targetSide) }
          ]
        };
      }
      const rUp2 = allocGutter(ctx, gup2, "exit", gU, outer);
      const t2 = allocChannel(
        ctx,
        u.lane,
        outerRow,
        v.col,
        gup2 - 0.5,
        outer < gU ? "below" : "above",
        gU,
        gup2 - 0.5
      );
      const srcY2 = fallbackRightY(e, e.from);
      if (e.kind === "seq") noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(gup2), e);
      else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(gup2), e);
      return {
        edgeId: e.id,
        fromSide: "right",
        toSide: targetSide,
        pattern: "return",
        points: [
          { x: portX(e.from, "right"), y: srcY2 },
          { x: gutterX(gup2, "exit", rUp2), y: srcY2 },
          { x: gutterX(gup2, "exit", rUp2), y: channelY(u.lane, outerRow, t2) },
          { x: nodeCX(e.to), y: channelY(u.lane, outerRow, t2) },
          { x: nodeCX(e.to), y: portY(e.to, targetSide) }
        ]
      };
    }
  }
  const chV = ctx.globalChannel.get(rowKey(v.lane, v.row));
  if (chV === gU - 1 && !isAttachedBoundary(u.node) && topFree(ctx, u) && reserveColRun(ctx, u.col, chV, gU, e)) {
    const t2 = allocChannel(ctx, v.lane, v.row, v.col, u.col, "below", gU, u.col);
    return {
      edgeId: e.id,
      fromSide: "top",
      toSide: "top",
      pattern: "return",
      points: [
        { x: nodeCX(e.from), y: portY(e.from, "top") },
        { x: nodeCX(e.from), y: channelY(v.lane, v.row, t2) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, t2) },
        { x: nodeCX(e.to), y: portY(e.to, "top") }
      ]
    };
  }
  if ((ctx.optimizeReadability || !isGw(u.node)) && e.kind === "seq" && chV < gU && !isAttachedBoundary(u.node) && topFree(ctx, u) && !ctx.occupied.has(`${v.lane}:${v.row}:${u.col}`) && !(v.row > 0 && ctx.occupied.has(`${v.lane}:${v.row - 1}:${u.col}`)) && reserveColRun(ctx, u.col, chV, gU, e)) {
    const t2 = allocChannel(ctx, v.lane, v.row, v.col, u.col, "below", gU, u.col);
    return {
      edgeId: e.id,
      fromSide: "top",
      toSide: "top",
      pattern: "return",
      points: [
        { x: nodeCX(e.from), y: portY(e.from, "top") },
        { x: nodeCX(e.from), y: channelY(v.lane, v.row, t2) },
        { x: nodeCX(e.to), y: channelY(v.lane, v.row, t2) },
        { x: nodeCX(e.to), y: portY(e.to, "top") }
      ]
    };
  }
  const gup = u.col + 1;
  const rUp = allocGutter(ctx, gup, "exit", gU, chV);
  const t = allocChannel(ctx, v.lane, v.row, v.col, gup - 0.5, gU < chV ? "above" : "below", gU, gup - 0.5);
  const srcY = fallbackRightY(e, e.from);
  if (e.kind === "seq") noteRowRun(ctx, u.lane, u.row, u.col, gutterScale(gup), e);
  else noteStubRun(ctx, u.lane, u.row, fallbackOffset(e), u.col, gutterScale(gup), e);
  return {
    edgeId: e.id,
    fromSide: "right",
    toSide: "top",
    pattern: "return",
    points: [
      { x: portX(e.from, "right"), y: srcY },
      { x: gutterX(gup, "exit", rUp), y: srcY },
      { x: gutterX(gup, "exit", rUp), y: channelY(v.lane, v.row, t) },
      { x: nodeCX(e.to), y: channelY(v.lane, v.row, t) },
      { x: nodeCX(e.to), y: portY(e.to, "top") }
    ]
  };
}

// src/coords.ts
var GUTTER_BASE = 28;
var TRACK_PITCH = 14;
var GUTTER_PAD = 10;
var CH_BASE = 16;
var CH_PAD = 10;
var LANE_PAD = 10;
var HEADER_W = 34;
var POOL_HEADER_W = 34;
var POOL_GAP_BASE = 48;
var POOL_GAP_PAD = 10;
var PAD = 24;
var TITLE_H = 44;
var ROW_MIN_EXT = 20;
function transposeCells(cells2) {
  const out = /* @__PURE__ */ new Map();
  for (const [id, c] of cells2) {
    out.set(id, {
      ...c,
      shapeW: c.shapeH,
      shapeH: c.shapeW,
      leftExt: c.topExt,
      rightExt: c.bottomExt,
      topExt: c.leftExt,
      bottomExt: c.rightExt
    });
  }
  return out;
}
var VERT_GUTTER_LABEL_NEED = 32;
function computeCoords(g, p, cells2, rp, includeTitle = true) {
  const maxCol = p.maxCol;
  const leftW = [];
  const rightW = [];
  for (let c = 0; c <= maxCol; c++) {
    let lw = 20;
    let rw = 20;
    for (const n of g.nodes) {
      if (p.col.get(n.id) !== c) continue;
      const cell = cells2.get(n.id);
      lw = Math.max(lw, cell.leftExt);
      rw = Math.max(rw, cell.rightExt);
    }
    leftW.push(quant(lw));
    rightW.push(quant(rw));
  }
  const gutterCenter = [];
  const gutterLeft = [];
  const gutterExit = [];
  const gutterTotal = [];
  const colCenterX = [];
  const hasPools = g.pools.length > 0;
  const totalHeader = (hasPools ? POOL_HEADER_W : 0) + HEADER_W;
  let x = PAD + totalHeader;
  const lastGutter = rp.poolExteriorGutter ?? maxCol + 1;
  for (let gi = 0; gi <= lastGutter; gi++) {
    const t = rp.gutterTracks.get(gi) ?? { exit: 0, entry: 0 };
    const total = t.exit + t.entry;
    const label = rp.gutterLabelNeed.get(gi) ?? 0;
    const w = quant(Math.max(GUTTER_BASE, total * TRACK_PITCH + 2 * GUTTER_PAD, label + GRID));
    gutterLeft.push(x);
    gutterExit.push(t.exit);
    gutterTotal.push(total);
    gutterCenter.push(x + w / 2);
    x += w;
    if (gi <= maxCol) {
      colCenterX.push(x + leftW[gi]);
      x += leftW[gi] + rightW[gi];
    }
  }
  const width = x + PAD;
  const bandRight = rp.poolExteriorGutter === void 0 ? width - PAD : gutterLeft[rp.poolExteriorGutter];
  const gutterX2 = (gi, side, track) => {
    const total = Math.max(1, gutterTotal[gi] ?? 1);
    const k = side === "exit" ? track : (gutterExit[gi] ?? 0) + track;
    return gutterCenter[gi] - (total - 1) * TRACK_PITCH / 2 + k * TRACK_PITCH;
  };
  const rowMid = /* @__PURE__ */ new Map();
  const channelTop = /* @__PURE__ */ new Map();
  const channelH = /* @__PURE__ */ new Map();
  const lanes = [];
  const poolGapTop = /* @__PURE__ */ new Map();
  const poolGapH = /* @__PURE__ */ new Map();
  const titleH = includeTitle && g.title ? TITLE_H : 0;
  let y = PAD + titleH;
  let prevPool = null;
  const poolSpan = /* @__PURE__ */ new Map();
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  for (let li = 0; li < g.lanes.length; li++) {
    const lane = g.lanes[li];
    const myPool = poolOfLane.get(lane.id);
    if (prevPool !== null && myPool !== prevPool) {
      const gap = poolIndex.get(prevPool);
      if (gap !== void 0) {
        const tracks = rp.poolGapTracks.get(gap) ?? 0;
        const h = quant(Math.max(POOL_GAP_BASE, tracks * TRACK_PITCH + (tracks > 0 ? 2 * POOL_GAP_PAD : 0)));
        poolGapTop.set(gap, y);
        poolGapH.set(gap, h);
        y += h;
      }
    }
    prevPool = myPool;
    const laneTop = y;
    if (lane.blackbox) {
      y = laneTop + 56;
      lanes.push({ id: lane.id, label: lane.label, blackbox: true, x: PAD, w: bandRight - PAD, y: laneTop, h: 56 });
      if (myPool !== void 0) poolSpan.set(myPool, { y0: laneTop, y1: y });
      continue;
    }
    y += LANE_PAD;
    const rows = p.laneRows.get(lane.id) ?? 1;
    for (let r = 0; r < rows; r++) {
      const key2 = `${lane.id}:${r}`;
      const tracks = rp.channelTracks.get(key2) ?? 0;
      const ch = quant(Math.max(CH_BASE, tracks * TRACK_PITCH + 2 * CH_PAD * Math.sign(tracks)));
      channelTop.set(key2, y);
      channelH.set(key2, ch);
      y += ch;
      let topExt = ROW_MIN_EXT;
      let bottomExt = ROW_MIN_EXT;
      for (const n of g.nodes) {
        if (n.lane !== lane.id || p.row.get(n.id) !== r) continue;
        const cell = cells2.get(n.id);
        topExt = Math.max(topExt, cell.topExt);
        bottomExt = Math.max(bottomExt, cell.bottomExt);
      }
      rowMid.set(key2, y + quant(topExt));
      y += quant(topExt) + quant(bottomExt);
    }
    const terminalKey = `${lane.id}:${rows}`;
    const terminalTracks = rp.channelTracks.get(terminalKey) ?? 0;
    if (terminalTracks > 0) {
      const ch = quant(Math.max(CH_BASE, terminalTracks * TRACK_PITCH + 2 * CH_PAD));
      channelTop.set(terminalKey, y);
      channelH.set(terminalKey, ch);
      y += ch;
    }
    y += LANE_PAD;
    const headerNeed = quant(measureText(lane.label, 12) + 28);
    if (y - laneTop < headerNeed) y = laneTop + headerNeed;
    if (myPool !== void 0 && poolOfLane.get(g.lanes[li + 1]?.id ?? "") !== myPool) {
      const pl = g.pools.find((p2) => p2.id === myPool);
      if (pl) {
        const poolStart = poolSpan.get(myPool)?.y0 ?? laneTop;
        const poolNeed = quant(measureText(pl.label, 12) + 28);
        if (y - poolStart < poolNeed) y = poolStart + poolNeed;
      }
    }
    lanes.push({ id: lane.id, label: lane.label, blackbox: lane.blackbox, x: PAD, w: bandRight - PAD, y: laneTop, h: y - laneTop });
    if (myPool !== void 0) {
      const span = poolSpan.get(myPool) ?? { y0: laneTop, y1: y };
      span.y1 = y;
      if (!poolSpan.has(myPool)) poolSpan.set(myPool, span);
      else poolSpan.get(myPool).y1 = y;
    }
  }
  const height = y + PAD;
  const poolGeoms = g.pools.filter((pl) => poolSpan.has(pl.id)).map((pl) => {
    const sp = poolSpan.get(pl.id);
    return { id: pl.id, label: pl.label, x: PAD, w: bandRight - PAD, y: sp.y0, h: sp.y1 - sp.y0 };
  });
  const channelY2 = (lane, row, track) => {
    const key2 = `${lane}:${row}`;
    const tracks = Math.max(1, rp.channelTracks.get(key2) ?? 1);
    const mid = channelTop.get(key2) + channelH.get(key2) / 2;
    return mid - (tracks - 1) * TRACK_PITCH / 2 + track * TRACK_PITCH;
  };
  const poolChannelY2 = (gap, track) => {
    const tracks = Math.max(1, rp.poolGapTracks.get(gap) ?? 1);
    const mid = poolGapTop.get(gap) + poolGapH.get(gap) / 2;
    return mid - (tracks - 1) * TRACK_PITCH / 2 + track * TRACK_PITCH;
  };
  const nodeGeom = /* @__PURE__ */ new Map();
  for (const n of g.nodes) {
    const cell = cells2.get(n.id);
    const cx = colCenterX[p.col.get(n.id)];
    const cy = rowMid.get(`${n.lane}:${p.row.get(n.id)}`);
    nodeGeom.set(n.id, {
      id: n.id,
      kind: n.kind,
      subtype: n.subtype,
      label: n.label,
      labelLines: cell.labelLines,
      lane: n.lane,
      x: cx - cell.shapeW / 2,
      y: cy - cell.shapeH / 2,
      w: cell.shapeW,
      h: cell.shapeH,
      cx,
      cy,
      onSpine: n.onSpine,
      provisional: n.provisional,
      synthetic: n.synthetic,
      labelSide: cell.labelSide,
      eventThrow: n.eventThrow,
      interrupting: n.interrupting,
      attachedTo: n.attachedTo,
      callProcess: n.callProcess,
      callTaskType: n.callTaskType,
      eventSubTrigger: n.eventSubTrigger,
      eventSubInterrupting: n.eventSubInterrupting,
      loop: n.loop,
      compensation: n.compensation,
      adhoc: n.adhoc,
      collection: n.collection
    });
  }
  overlayBoundaryEvents(g, nodeGeom);
  const portPt = (id, side) => {
    const ng = nodeGeom.get(id);
    switch (side) {
      case "left":
        return { x: ng.x, y: ng.cy };
      case "right":
        return { x: ng.x + ng.w, y: ng.cy };
      case "top":
        return { x: ng.cx, y: ng.y };
      case "bottom":
        return { x: ng.cx, y: ng.y + ng.h };
    }
  };
  return { colCenterX, gutterX: gutterX2, rowMid, channelY: channelY2, poolChannelY: poolChannelY2, nodeGeom, lanes, poolGeoms, width, height, bandRight, headerW: totalHeader, titleH, portPt };
}
function overlayBoundaryEvents(g, nodeGeom) {
  const groups = /* @__PURE__ */ new Map();
  for (const n of g.nodes) {
    if (!isAttachedBoundary(n) || !n.attachedTo || !nodeGeom.has(n.attachedTo)) continue;
    const list = groups.get(n.attachedTo) ?? [];
    list.push(n.id);
    groups.set(n.attachedTo, list);
  }
  for (const [hostId, ids] of groups) {
    const host = nodeGeom.get(hostId);
    const r = EVENT_R;
    ids.forEach((id, i) => {
      const ng = nodeGeom.get(id);
      if (!ng) return;
      const cx = host.x + host.w * (i + 1) / (ids.length + 1);
      const cy = host.y + host.h;
      ng.cx = cx;
      ng.cy = cy;
      ng.w = r * 2;
      ng.h = r * 2;
      ng.x = cx - r;
      ng.y = cy - r;
    });
  }
}

// src/wire.ts
function wire(g, rp, co, orientation = "horizontal", titleShift = 0) {
  const vertical = orientation === "vertical";
  const edgeById = new Map(g.edges.map((e) => [e.id, e]));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const siblingIndex = /* @__PURE__ */ new Map();
  const siblingCount = /* @__PURE__ */ new Map();
  for (const plan of rp.plans) {
    const e = edgeById.get(plan.edgeId);
    if (!e.label) continue;
    const key2 = `${e.from}:${plan.fromSide}`;
    siblingIndex.set(e.id, siblingCount.get(key2) ?? 0);
    siblingCount.set(key2, (siblingCount.get(key2) ?? 0) + 1);
  }
  const out = [];
  for (const plan of rp.plans) {
    const e = edgeById.get(plan.edgeId);
    const resolved = plan.points.map((sp) => resolve(sp, co, rp));
    if (!e.fromPool && resolved.length > 1) {
      resolved[0] = clipToShape(resolved[0], co.nodeGeom.get(e.from), plan.fromSide);
    }
    if (!e.toPool && resolved.length > 1) {
      const last = resolved.length - 1;
      resolved[last] = clipToShape(resolved[last], co.nodeGeom.get(e.to), plan.toSide);
    }
    const logical = simplify(resolved);
    const pts = vertical ? logical.map((p) => ({ x: p.y, y: p.x + titleShift })) : logical;
    out.push({
      id: e.id,
      kind: e.kind,
      from: e.from,
      to: e.to,
      label: e.label,
      fromPool: e.fromPool,
      toPool: e.toPool,
      points: pts,
      labelPos: e.label ? labelPos(
        pts,
        e.label,
        e.isReturn,
        siblingIndex.get(e.id) ?? 0,
        isGatewayKind(nodeById.get(e.from)?.kind ?? "task") && !e.onSpine,
        vertical,
        e.kind === "msg"
      ) : void 0,
      onSpine: e.onSpine,
      isReturn: e.isReturn,
      provisional: e.provisional,
      mainHint: e.mainHint,
      returnHint: e.returnHint,
      isDefault: e.isDefault,
      isConditional: e.isConditional,
      assocKind: e.assocKind
    });
  }
  return out;
}
function clipToShape(p, n, side) {
  const dx = p.x - n.cx;
  const dy = p.y - n.cy;
  if (isEventKind(n.kind)) {
    const rx = n.w / 2;
    const ry = n.h / 2;
    if (side === "left" || side === "right") {
      const x = rx * Math.sqrt(Math.max(0, 1 - dy * dy / (ry * ry)));
      return { x: n.cx + (side === "right" ? x : -x), y: p.y };
    }
    const y = ry * Math.sqrt(Math.max(0, 1 - dx * dx / (rx * rx)));
    return { x: p.x, y: n.cy + (side === "bottom" ? y : -y) };
  }
  if (isGatewayKind(n.kind)) {
    const hw = n.w / 2;
    const hh = n.h / 2;
    if (side === "left" || side === "right") {
      const x = hw * Math.max(0, 1 - Math.abs(dy) / hh);
      return { x: n.cx + (side === "right" ? x : -x), y: p.y };
    }
    const y = hh * Math.max(0, 1 - Math.abs(dx) / hw);
    return { x: p.x, y: n.cy + (side === "bottom" ? y : -y) };
  }
  return p;
}
function resolve(sp, co, rp) {
  const laneG = (id) => co.lanes.find((l) => l.id === id);
  let x;
  switch (sp.x.t) {
    case "portX":
      x = co.portPt(sp.x.id, sp.x.side).x;
      break;
    case "gutter":
      x = co.gutterX(sp.x.g, sp.x.side, rp.gutterRunTrack.get(sp.x.run) ?? 0);
      break;
    case "nodeCX":
      x = co.nodeGeom.get(sp.x.id).cx + (sp.x.offset ?? 0);
      break;
  }
  let y;
  switch (sp.y.t) {
    case "portY":
      y = co.portPt(sp.y.id, sp.y.side).y;
      break;
    case "nodeCY":
      y = co.nodeGeom.get(sp.y.id).cy + (sp.y.offset ?? 0);
      break;
    case "portStubY": {
      const py = co.portPt(sp.y.id, sp.y.side).y;
      y = py + (sp.y.side === "bottom" ? sp.y.offset : -sp.y.offset);
      break;
    }
    case "channel":
      y = co.channelY(sp.y.lane, sp.y.row, rp.channelRunTrack.get(sp.y.run) ?? 0);
      break;
    case "poolChannel":
      y = co.poolChannelY(sp.y.gap, rp.poolGapRunTrack.get(sp.y.run) ?? 0);
      break;
    case "rowMid":
      y = co.rowMid.get(`${sp.y.lane}:${sp.y.row}`);
      break;
    case "laneEdge": {
      const lg = laneG(sp.y.lane);
      y = sp.y.edge === "top" ? lg.y : lg.y + lg.h;
      break;
    }
  }
  return { x, y };
}
function simplify(pts) {
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    dedup.push(p);
  }
  const out = [];
  for (let i = 0; i < dedup.length; i++) {
    const a = out[out.length - 1];
    const b = dedup[i];
    const c = dedup[i + 1];
    if (a && c && (a.x === b.x && b.x === c.x || a.y === b.y && b.y === c.y)) continue;
    out.push(b);
  }
  return out;
}
var HOP_MARGIN = 12;
var CROSS_EPS = 4;
function computeHops(edges) {
  const hits = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      for (let s1 = 0; s1 + 1 < e1.points.length; s1++) {
        for (let s2 = 0; s2 + 1 < e2.points.length; s2++) {
          const cross = segCross(e1.points[s1], e1.points[s1 + 1], e2.points[s2], e2.points[s2 + 1]);
          if (!cross) continue;
          const h1 = Math.abs(e1.points[s1].y - e1.points[s1 + 1].y) < 0.01;
          hits.push({ e: e1, seg: s1, horizontal: h1, a: e1.points[s1], b: e1.points[s1 + 1], x: cross.x, y: cross.y });
          hits.push({ e: e2, seg: s2, horizontal: !h1, a: e2.points[s2], b: e2.points[s2 + 1], x: cross.x, y: cross.y });
        }
      }
    }
  }
  const byPoint = /* @__PURE__ */ new Map();
  for (const hit of hits) {
    const key2 = `${hit.x},${hit.y}`;
    const list = byPoint.get(key2) ?? [];
    list.push(hit);
    byPoint.set(key2, list);
  }
  for (const group2 of byPoint.values()) {
    const x = group2[0].x;
    const y = group2[0].y;
    const bundles = /* @__PURE__ */ new Map();
    for (const hit of group2) {
      const bkey = `${hit.horizontal ? "h" : "v"}:${hit.horizontal ? hit.a.y : hit.a.x}`;
      const list = bundles.get(bkey) ?? [];
      if (!list.some((h) => h.e === hit.e && h.seg === hit.seg)) list.push(hit);
      bundles.set(bkey, list);
    }
    const all = [...bundles.values()];
    const hasSpine = (b) => b.some((h) => h.e.onSpine);
    const canHop = (b) => b.some((h) => !h.e.onSpine && hopEndClear(h, x, y));
    let hoppers;
    if (all.some(hasSpine)) hoppers = all.filter((b) => !hasSpine(b));
    else {
      const horiz = all.filter((b) => b[0].horizontal);
      hoppers = horiz.length > 0 ? horiz : all;
    }
    if (!hoppers.some(canHop)) {
      const other = all.filter((b) => !hoppers.includes(b));
      if (other.some(canHop)) hoppers = other;
      else continue;
    }
    const seen = /* @__PURE__ */ new Set();
    for (const bundle of hoppers) {
      for (const hit of bundle) {
        if (hit.e.onSpine || !hopEndClear(hit, x, y)) continue;
        const id = `${hit.e.id}:${hit.seg}:${x}:${y}`;
        if (seen.has(id)) continue;
        seen.add(id);
        (hit.e.hops ??= []).push({ seg: hit.seg, x, y });
      }
    }
  }
}
function hopEndClear(hit, x, y) {
  const dist = hit.horizontal ? Math.min(Math.abs(x - hit.a.x), Math.abs(x - hit.b.x)) : Math.min(Math.abs(y - hit.a.y), Math.abs(y - hit.b.y));
  return dist >= HOP_MARGIN;
}
function segCross(a1, a2, b1, b2) {
  const aH = Math.abs(a1.y - a2.y) < 0.01;
  const bH = Math.abs(b1.y - b2.y) < 0.01;
  if (aH === bH) return null;
  const [h1, h2, v1, v2] = aH ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
  const x = v1.x;
  const y = h1.y;
  const [hx0, hx1] = h1.x < h2.x ? [h1.x, h2.x] : [h2.x, h1.x];
  const [vy0, vy1] = v1.y < v2.y ? [v1.y, v2.y] : [v2.y, v1.y];
  if (x < hx0 + CROSS_EPS || x > hx1 - CROSS_EPS) return null;
  if (y < vy0 + CROSS_EPS || y > vy1 - CROSS_EPS) return null;
  return { x, y };
}
function labelPos(pts, label, isReturn, sibling, preferBranchSeg, vertical = false, sourceFirst = false) {
  const w = measureText(label, EDGE_FONT_SIZE);
  const a = pts[0];
  const b = pts[1] ?? a;
  const stack = (base) => sibling === 0 ? base : { x: base.x, y: base.y + (EDGE_FONT_SIZE + 11) + (sibling - 1) * (EDGE_FONT_SIZE + 5) };
  const isV = (p, q) => Math.abs(p.x - q.x) < 0.01;
  const isH = (p, q) => Math.abs(p.y - q.y) < 0.01;
  if (vertical) {
    if (!isReturn && isV(a, b) && Math.abs(b.y - a.y) >= 24) {
      return stack({ x: a.x + 8, y: a.y + (b.y > a.y ? 10 : -10 - EDGE_FONT_SIZE) });
    }
    if (!isReturn && preferBranchSeg) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        if (isH(p, q) && Math.abs(q.x - p.x) >= 16) {
          const x = q.x > p.x ? p.x + 6 : p.x - 6 - w;
          return { x, y: p.y - 6 - EDGE_FONT_SIZE };
        }
      }
    }
    if (!isReturn && sourceFirst && isH(a, b) && Math.abs(b.x - a.x) >= w + 12) {
      const x = b.x > a.x ? a.x + 6 : a.x - 6 - w;
      return stack({ x, y: a.y - 6 - EDGE_FONT_SIZE });
    }
    const minDy = isReturn ? 36 : 24;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (isV(p, q) && Math.abs(q.y - p.y) >= minDy) {
        return stack({ x: p.x + 8, y: p.y + (q.y > p.y ? 6 : -6 - EDGE_FONT_SIZE) });
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (isH(p, q) && Math.abs(q.x - p.x) >= 16) {
        const x = q.x > p.x ? p.x + 6 : p.x - 6 - w;
        return stack({ x, y: p.y - 6 - EDGE_FONT_SIZE });
      }
    }
    return stack({ x: a.x + 6, y: Math.min(a.y, b.y) - 6 - EDGE_FONT_SIZE });
  }
  if (!isReturn && isV(a, b) && Math.abs(b.y - a.y) >= 24) {
    return stack({ x: a.x + 8, y: a.y + (b.y > a.y ? 10 : -10 - EDGE_FONT_SIZE) });
  }
  if (!isReturn && preferBranchSeg) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (isV(p, q) && Math.abs(q.y - p.y) >= 16) {
        return { x: p.x + 8, y: p.y + Math.sign(q.y - p.y) * 10 - EDGE_FONT_SIZE / 2 };
      }
    }
  }
  const minDx = isReturn ? 36 : 16;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (isH(p, q) && Math.abs(q.x - p.x) >= minDx) {
      const x = q.x > p.x ? p.x + 6 : p.x - 6 - w;
      return stack({ x, y: p.y - 6 - EDGE_FONT_SIZE });
    }
  }
  return stack({ x: Math.min(a.x, b.x) + 6, y: a.y - 6 - EDGE_FONT_SIZE });
}

// src/edge-labels.ts
var LABEL_H = EDGE_FONT_SIZE + 4;
var EDGE_CLEARANCE = 1;
var AMBIG_GAP = 8;
var START_ALONG_BAND = 80;
function currentLabelScore([outside, node, label, sequence, other], ambiguity2, ownHits, farBand) {
  return [outside, node, label, ambiguity2, sequence, other, ownHits, farBand, 0, 0, 0, 0, 0];
}
function edgeLabelBox(e) {
  if (!e.label || !e.labelPos) return void 0;
  return {
    x: e.labelPos.x,
    y: e.labelPos.y,
    w: measureText(e.label, EDGE_FONT_SIZE),
    h: LABEL_H
  };
}
function placeEdgeLabels(geometry) {
  const obstacles = geometry.nodes.flatMap(nodeObstacles);
  const placed = [];
  const rank = (e) => e.kind === "seq" ? 0 : e.kind === "assoc" ? 1 : 2;
  const labels = geometry.edges.filter((e) => e.label && e.labelPos).map((e, index) => ({ e, index })).sort((a, b) => rank(a.e) - rank(b.e) || a.index - b.index);
  let moved = 0;
  let kept = 0;
  let fallback = 0;
  for (const { e } of labels) {
    const current = edgeLabelBox(e);
    const curExternal = externalHits(geometry, e, current, obstacles, placed);
    const curAmb = ambiguity(geometry, e, current);
    if (curExternal.every((n) => n === 0) && curAmb === 0 && startDist(e, current) <= 160) {
      placed.push(current);
      kept++;
      continue;
    }
    const selectBest = (cands) => {
      let best2;
      for (const candidate of cands) {
        const box = { x: candidate.pos.x, y: candidate.pos.y, w: current.w, h: LABEL_H };
        const [outside, node, labelHit, sequence, other] = externalHits(geometry, e, box, obstacles, placed);
        let ownHits = 0;
        for (let i = 0; i + 1 < e.points.length; i++) {
          if (i === candidate.segment) continue;
          if (intersects(box, segmentBox(e.points[i], e.points[i + 1]), EDGE_CLEARANCE)) ownHits++;
        }
        const far = startDist(e, box);
        const score2 = [
          outside,
          node,
          labelHit,
          ambiguity(geometry, e, box),
          sequence,
          other,
          ownHits,
          Math.floor(far / START_ALONG_BAND),
          Math.floor(candidate.along / START_ALONG_BAND),
          candidate.segment,
          candidate.overflow,
          candidate.offsetRank,
          candidate.order
        ];
        if (!best2 || compareScore(score2, best2.score) < 0) best2 = { score: score2, pos: candidate.pos };
      }
      return best2;
    };
    let best = selectBest(labelCandidates(e, current.w, geometry));
    if (best && (best.score.slice(0, 7).some((n) => n > 0) || (best.score[10] ?? 0) > 0)) {
      const wide = selectBest(labelCandidates(e, current.w, geometry, true));
      if (wide && compareScore(wide.score, best.score) < 0) best = wide;
    }
    let curOwnHits = 0;
    for (let i = 0; i + 1 < e.points.length; i++) {
      if (intersects(current, segmentBox(e.points[i], e.points[i + 1]), EDGE_CLEARANCE)) curOwnHits++;
    }
    const currentScore = currentLabelScore(
      curExternal,
      curAmb,
      curOwnHits,
      Math.floor(startDist(e, current) / START_ALONG_BAND)
    );
    if (best && compareScore(best.score, currentScore) < 0) {
      e.labelPos = best.pos;
      placed.push(edgeLabelBox(e));
      moved++;
    } else {
      placed.push(current);
      fallback++;
    }
  }
  return { moved, kept, fallback, ...inspectEdgeLabels(geometry) };
}
function inspectEdgeLabels(geometry) {
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
  const details = [];
  for (let li = 0; li < labels.length; li++) {
    const current = labels[li];
    for (const obstacle of obstacles) {
      if (!intersects(current.box, obstacle.box)) continue;
      nodeHits++;
      details.push(`${current.e.id}:node:${obstacle.id}`);
    }
    for (const other2 of geometry.edges) {
      if (other2.id === current.e.id) continue;
      if (!edgeIntersectsBox(other2, current.box)) continue;
      edgeHits++;
      details.push(`${current.e.id}:edge:${other2.id}`);
    }
    for (let mi = li + 1; mi < labels.length; mi++) {
      const other2 = labels[mi];
      if (!intersects(current.box, other2.box)) continue;
      labelHits++;
      details.push(`${current.e.id}:label:${other2.e.id}`);
    }
    const own = ownDist(current.e, current.box);
    const other = otherDist(geometry, current.e, current.box);
    if (other < own) stolen++;
    if (other < own + AMBIG_GAP) ambiguous++;
  }
  return { nodeHits, edgeHits, labelHits, stolen, ambiguous, details };
}
function nodeObstacles(n) {
  const out = [{ x: n.x, y: n.y, w: n.w, h: n.h }];
  if (n.kind === "task" || n.kind === "note" || n.kind === "group" || n.labelLines.length === 0) return out;
  const labelW = Math.max(...n.labelLines.map((line) => measureText(line, OUT_LABEL_FONT)));
  const labelH = n.labelLines.length * OUT_LABEL_LINE_H;
  if (n.kind === "xor" || n.kind === "and") {
    out.push({ x: n.cx - 8 - labelW, y: n.y - 6 - labelH, w: labelW, h: labelH });
  } else if (n.kind === "doc" || n.kind === "store") {
    out.push({ x: n.cx + 6, y: n.y + n.h + 4, w: labelW, h: labelH });
  } else if (n.labelSide === "left") {
    out.push({ x: n.x - 6 - labelW, y: n.cy - labelH / 2, w: labelW, h: labelH });
  } else if (n.labelSide === "right") {
    out.push({ x: n.x + n.w + 6, y: n.cy - labelH / 2, w: labelW, h: labelH });
  } else if (n.labelSide === "top") {
    out.push({ x: n.cx - labelW / 2, y: n.y - 6 - labelH, w: labelW, h: labelH });
  } else {
    out.push({ x: n.cx - labelW / 2, y: n.y + n.h + 6, w: labelW, h: labelH });
  }
  return out;
}
function prefixLength(pts, seg) {
  let n = 0;
  for (let i = 0; i < seg; i++) {
    const a = pts[i], b = pts[i + 1];
    n += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return n;
}
function alongAnchors(p, q, pad, box, minOff) {
  const len = Math.abs(q - p);
  const dir = q >= p ? 1 : -1;
  const at = (off) => dir > 0 ? p + off : p - off - box;
  const out = [];
  for (let off = minOff; off <= 96 && off < len; off += 8) out.push(at(off));
  if (len >= 120) out.push(at(0.15 * len), at(0.3 * len));
  out.push((p + q) / 2 - box / 2);
  out.push(dir > 0 ? q - pad - box : q + pad);
  const seen = /* @__PURE__ */ new Set();
  return out.filter((v) => {
    const k = Math.round(v * 2);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function labelCandidates(e, width, geometry, full = false) {
  const candidates = [];
  const source = geometry.nodes.find((n) => n.id === e.from);
  const restrictGatewayBranch = !e.isReturn && e.kind === "seq" && !e.onSpine && (source?.kind === "xor" || source?.kind === "and");
  let order = 0;
  const hOffsets = [[6, 0], [2, 1], [20, 2], [34, 3]];
  const vOffsets = [[8, 0], [2, 1], [22, 2], [36, 3]];
  for (let i = 0; i + 1 < e.points.length; i++) {
    if (restrictGatewayBranch && !full && i > 3) break;
    const a = e.points[i];
    const b = e.points[i + 1];
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
            const along = base + Math.abs(x + width / 2 - a.x);
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
            const along = base + Math.abs(y + LABEL_H / 2 - a.y);
            candidates.push({ pos: { x: p.x + offset, y }, segment: i, overflow, offsetRank, order: order++, along });
            candidates.push({ pos: { x: p.x - offset - width, y }, segment: i, overflow, offsetRank, order: order++, along });
          }
        }
      }
    }
  }
  return candidates;
}
function externalHits(geometry, e, box, obstacles, placed) {
  const outside = box.x < 0 || box.y < 0 || box.x + box.w > geometry.width || box.y + box.h > geometry.height ? 1 : 0;
  const node = obstacles.reduce((n, obstacle) => n + Number(intersects(box, obstacle)), 0);
  const label = placed.reduce((n, other2) => n + Number(intersects(box, other2)), 0);
  let sequence = 0;
  let other = 0;
  for (const edge of geometry.edges) {
    if (edge.id === e.id || !edgeIntersectsBox(edge, box)) continue;
    if (edge.kind === "seq") sequence++;
    else other++;
  }
  return [outside, node, label, sequence, other];
}
function ambiguity(geometry, e, box) {
  return otherDist(geometry, e, box) < ownDist(e, box) + AMBIG_GAP ? 1 : 0;
}
function startDist(e, box) {
  const start = e.points[0];
  return Math.abs(box.x + box.w / 2 - start.x) + Math.abs(box.y + box.h / 2 - start.y);
}
function uniqueSubsegments(e, i, edges) {
  const a = e.points[i];
  const b = e.points[i + 1];
  const horizontal = Math.abs(a.y - b.y) < 0.01;
  const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  if (hi - lo < 12) return [];
  const line = horizontal ? a.y : a.x;
  const cuts = [];
  for (const other of edges) {
    if (other.id === e.id) continue;
    for (let j = 0; j + 1 < other.points.length; j++) {
      const p = other.points[j];
      const q = other.points[j + 1];
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
      return forward ? { p: { x: range.lo, y: line }, q: { x: range.hi, y: line } } : { p: { x: range.hi, y: line }, q: { x: range.lo, y: line } };
    }
    return forward ? { p: { x: line, y: range.lo }, q: { x: line, y: range.hi } } : { p: { x: line, y: range.hi }, q: { x: line, y: range.lo } };
  });
}
function subtractRanges(lo, hi, cuts) {
  const sorted = cuts.map((c) => ({ lo: Math.max(lo, c.lo), hi: Math.min(hi, c.hi) })).filter((c) => c.hi > c.lo).sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out = [];
  let cur = lo;
  for (const cut of sorted) {
    if (cut.lo > cur) out.push({ lo: cur, hi: cut.lo });
    cur = Math.max(cur, cut.hi);
  }
  if (cur < hi) out.push({ lo: cur, hi });
  return out.filter((range) => range.hi - range.lo >= 12);
}
function ownDist(e, box) {
  let own = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < e.points.length; i++) {
    own = Math.min(own, boxSegDist(box, e.points[i], e.points[i + 1]));
  }
  return own;
}
function otherDist(geometry, e, box) {
  let other = Number.POSITIVE_INFINITY;
  for (const o of geometry.edges) {
    if (o.id === e.id) continue;
    for (let i = 0; i + 1 < o.points.length; i++) {
      other = Math.min(other, boxSegDist(box, o.points[i], o.points[i + 1]));
      if (other === 0) return 0;
    }
  }
  return other;
}
function boxSegDist(box, a, b) {
  const sb = segmentBox(a, b);
  const dx = Math.max(sb.x - (box.x + box.w), box.x - (sb.x + sb.w), 0);
  const dy = Math.max(sb.y - (box.y + box.h), box.y - (sb.y + sb.h), 0);
  return Math.hypot(dx, dy);
}
function edgeIntersectsBox(edge, box) {
  for (let i = 0; i + 1 < edge.points.length; i++) {
    if (intersects(box, segmentBox(edge.points[i], edge.points[i + 1]), EDGE_CLEARANCE)) return true;
  }
  return false;
}
function segmentBox(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function intersects(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}
function compareScore(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// src/oracle.ts
var EPS = 0.5;
function checkOracle(g, geo) {
  const out = [];
  const vertical = geo.orientation === "vertical";
  const nodeById = new Map(geo.nodes.map((n) => [n.id, n]));
  const laneById = new Map(geo.lanes.map((l) => [l.id, l]));
  const normNode = new Map(g.nodes.map((n) => [n.id, n]));
  const blackboxLaneByPool = new Map(g.lanes.filter((l) => l.blackbox).map((l) => [l.pool, l.id]));
  const laneEdgeOk = (poolId, pt) => {
    const lane = laneById.get(blackboxLaneByPool.get(poolId) ?? poolId);
    if (!lane) return false;
    return vertical ? Math.abs(pt.x - lane.x) < EPS || Math.abs(pt.x - lane.x - lane.w) < EPS : Math.abs(pt.y - lane.y) < EPS || Math.abs(pt.y - lane.y - lane.h) < EPS;
  };
  for (const e of geo.edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i];
      const b = e.points[i + 1];
      if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) {
        out.push(viol("O-1", `\u8FBA ${e.id} \u306E\u533A\u9593 ${i} \u304C\u659C\u3081 (${fmt(a)} -> ${fmt(b)})`));
      }
    }
    if (e.fromPool) {
      if (!laneEdgeOk(e.fromPool, e.points[0])) out.push(viol("O-2", `\u8FBA ${e.id} \u306E\u59CB\u70B9\u304C\u30D7\u30FC\u30EB\u5E2F ${e.fromPool} \u306E\u7E01\u306B\u306A\u3044`));
    } else {
      checkEndpoint(out, e, e.points[0], e.points[1] ?? e.points[0], nodeById.get(e.from), "\u59CB\u70B9");
    }
    if (e.toPool) {
      if (!laneEdgeOk(e.toPool, e.points[e.points.length - 1])) out.push(viol("O-2", `\u8FBA ${e.id} \u306E\u7D42\u70B9\u304C\u30D7\u30FC\u30EB\u5E2F ${e.toPool} \u306E\u7E01\u306B\u306A\u3044`));
    } else {
      checkEndpoint(out, e, e.points[e.points.length - 1], e.points[e.points.length - 2] ?? e.points[0], nodeById.get(e.to), "\u7D42\u70B9");
    }
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i];
      const b = e.points[i + 1];
      for (const n of geo.nodes) {
        if (i === 0 && !e.fromPool && n.id === e.from) continue;
        if (i === e.points.length - 2 && !e.toPool && n.id === e.to) continue;
        const fromN = nodeById.get(e.from);
        const toN = nodeById.get(e.to);
        if (fromN && isAttachedBoundary(fromN) && n.id === fromN.attachedTo) continue;
        if (toN && isAttachedBoundary(toN) && n.id === toN.attachedTo) continue;
        if (n.kind === "boundary" && n.attachedTo && (e.from === n.attachedTo || e.to === n.attachedTo)) continue;
        if (segIntersectsRect(a, b, n.x + 2, n.y + 2, n.w - 4, n.h - 4)) {
          out.push(viol("O-3", `\u8FBA ${e.id} \u306E\u533A\u9593 ${i} \u304C\u30CE\u30FC\u30C9 ${n.id} \u306E\u5185\u90E8\u3092\u901A\u904E`));
        }
      }
    }
    if (e.fromPool || e.toPool) continue;
    const uLane = normNode.get(e.from).lane;
    const vLane = normNode.get(e.to).lane;
    if (uLane === vLane) {
      const lane = laneById.get(uLane);
      for (const p of e.points) {
        const [lo, hi, v] = vertical ? [lane.x, lane.x + lane.w, p.x] : [lane.y, lane.y + lane.h, p.y];
        if (v < lo - EPS || v > hi + EPS) {
          out.push(viol("O-5", `\u540C\u4E00\u30EC\u30FC\u30F3\u8FBA ${e.id} \u304C\u30EC\u30FC\u30F3 ${uLane} \u306E\u5E2F\u3092\u51FA\u305F (${vertical ? "x" : "y"}=${v})`));
        }
      }
    }
  }
  const poolOfLane = new Map(g.lanes.map((l) => [l.id, l.pool]));
  const poolIndex = new Map(g.pools.map((pl, i) => [pl.id, i]));
  const poolGeom = new Map(geo.pools.map((pl) => [pl.id, pl]));
  const poolOfNode = (id) => {
    const n = normNode.get(id);
    return n ? poolOfLane.get(n.lane) : id;
  };
  for (const e of geo.edges) {
    if (e.kind === "msg" && poolOfNode(e.from) === poolOfNode(e.to)) {
      out.push(viol("O-7", `\u30E1\u30C3\u30BB\u30FC\u30B8 ${e.id} \u304C\u540C\u4E00\u30D7\u30FC\u30EB\u5185\u3092\u6D41\u308C\u3066\u3044\u308B`));
    }
    if (e.kind === "seq" && poolOfNode(e.from) !== poolOfNode(e.to)) {
      out.push(viol("O-7", `\u30B7\u30FC\u30B1\u30F3\u30B9 ${e.id} \u304C\u30D7\u30FC\u30EB\u3092\u8D8A\u3048\u3066\u3044\u308B`));
    }
  }
  for (const e of geo.edges) {
    if (e.kind !== "msg" || e.fromPool || e.toPool) continue;
    const up = poolOfNode(e.from);
    const vp = poolOfNode(e.to);
    const ui = poolIndex.get(up);
    const vi = poolIndex.get(vp);
    if (ui === void 0 || vi === void 0) continue;
    if (Math.abs(ui - vi) > 1) {
      const lo = Math.min(ui, vi);
      const hi = Math.max(ui, vi);
      for (let pi = lo + 1; pi < hi; pi++) {
        const middle = poolGeom.get(g.pools[pi].id);
        const crossesInterior = e.points.some((p, i) => {
          const q = e.points[i + 1];
          return !!q && segIntersectsRect(p, q, middle.x, middle.y, middle.w, middle.h);
        });
        if (crossesInterior) {
          out.push(viol("O-10", `\u975E\u96A3\u63A5\u30D7\u30FC\u30EB\u9593\u30E1\u30C3\u30BB\u30FC\u30B8 ${e.id} \u304C\u4E2D\u9593\u30D7\u30FC\u30EB ${g.pools[pi].id} \u306E\u5185\u90E8\u3092\u901A\u904E`));
        }
      }
      continue;
    }
    const firstId = ui < vi ? up : vp;
    const secondId = ui < vi ? vp : up;
    const first = poolGeom.get(firstId);
    const second = poolGeom.get(secondId);
    if (e.points.length === 2) continue;
    if (vertical) {
      const x0 = first.x + first.w;
      const x1 = second.x;
      const hasGapRun = e.points.some((p, i) => {
        const q = e.points[i + 1];
        return !!q && Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) > EPS && p.x > x0 + EPS && p.x < x1 - EPS;
      });
      if (!hasGapRun) out.push(viol("O-10", `\u96A3\u63A5\u30D7\u30FC\u30EB\u9593\u30E1\u30C3\u30BB\u30FC\u30B8 ${e.id} \u306B\u30D7\u30FC\u30EB\u9593\u5782\u76F4\u8D70\u884C\u304C\u306A\u3044`));
    } else {
      const y0 = first.y + first.h;
      const y1 = second.y;
      const hasGapRun = e.points.some((p, i) => {
        const q = e.points[i + 1];
        return !!q && Math.abs(p.y - q.y) < EPS && Math.abs(p.x - q.x) > EPS && p.y > y0 + EPS && p.y < y1 - EPS;
      });
      if (!hasGapRun) out.push(viol("O-10", `\u96A3\u63A5\u30D7\u30FC\u30EB\u9593\u30E1\u30C3\u30BB\u30FC\u30B8 ${e.id} \u306B\u30D7\u30FC\u30EB\u9593\u6C34\u5E73\u8D70\u884C\u304C\u306A\u3044`));
    }
  }
  for (const n of geo.nodes) {
    const outgoing = geo.edges.filter((e) => e.kind === "msg" && !e.fromPool && e.from === n.id);
    const incoming = geo.edges.filter((e) => e.kind === "msg" && !e.toPool && e.to === n.id);
    for (const outEdge of outgoing) {
      for (const inEdge of incoming) {
        if (samePoint(outEdge.points[0], inEdge.points.at(-1))) {
          out.push(viol("O-11", `\u30CE\u30FC\u30C9 ${n.id} \u306E\u30E1\u30C3\u30BB\u30FC\u30B8\u5165\u53E3 ${inEdge.id} \u3068\u51FA\u53E3 ${outEdge.id} \u304C\u540C\u4E00\u70B9\u3092\u5171\u6709`));
        }
      }
    }
  }
  for (const n of geo.nodes) {
    const lane = laneById.get(n.lane);
    if (n.x < lane.x - EPS || n.x + n.w > lane.x + lane.w + EPS || n.y < lane.y - EPS || n.y + n.h > lane.y + lane.h + EPS) {
      out.push(viol("O-4", `\u30CE\u30FC\u30C9 ${n.id} \u304C\u30EC\u30FC\u30F3 ${n.lane} \u306E\u5E2F\u304B\u3089\u306F\u307F\u51FA\u3059`));
    }
  }
  for (let i = 0; i < geo.edges.length; i++) {
    for (let j = i + 1; j < geo.edges.length; j++) {
      const e1 = geo.edges[i];
      const e2 = geo.edges[j];
      if (e1.from !== e2.from || normNode.get(e1.from)?.kind !== "task") continue;
      const mixed = e1.kind === "seq" !== (e2.kind === "seq");
      if (!mixed) continue;
      if (samePoint(e1.points[0], e2.points[0])) {
        const seq = e1.kind === "seq" ? e1 : e2;
        const other = e1.kind === "seq" ? e2 : e1;
        out.push(viol("O-8", `\u30BF\u30B9\u30AF ${e1.from} \u306E\u540C\u4E00\u51FA\u53E3\u3092\u30B7\u30FC\u30B1\u30F3\u30B9 ${seq.id} \u3068 ${other.kind} ${other.id} \u304C\u5171\u6709`));
      }
    }
  }
  for (const e of geo.edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to || from.kind !== "xor" && from.kind !== "and") continue;
    if (e.kind !== "seq" || e.onSpine || e.isReturn) continue;
    if (vertical) {
      if (to.cx <= from.cx) continue;
      if (!samePoint(e.points[0], { x: from.x + from.w, y: from.cy })) {
        out.push(viol("O-9", `\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4 ${from.id} \u306E\u53F3\u65B9\u5411\u5206\u5C90 ${e.id} \u304C east \u9802\u70B9\u304B\u3089\u51FA\u3066\u3044\u306A\u3044`));
      }
    } else {
      if (to.cy <= from.cy) continue;
      if (!samePoint(e.points[0], { x: from.cx, y: from.y + from.h })) {
        out.push(viol("O-9", `\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4 ${from.id} \u306E\u4E0B\u964D\u5206\u5C90 ${e.id} \u304C south \u9802\u70B9\u304B\u3089\u51FA\u3066\u3044\u306A\u3044`));
      }
    }
  }
  for (let i = 0; i < geo.edges.length; i++) {
    for (let j = i + 1; j < geo.edges.length; j++) {
      const e1 = geo.edges[i];
      const e2 = geo.edges[j];
      if (e1.from === e2.from || e1.to === e2.to) continue;
      const seg = findOverlap(e1, e2);
      if (seg) out.push(viol("O-6", `\u8FBA ${e1.id} \u3068 ${e2.id} \u306E\u533A\u9593\u304C\u91CD\u306A\u308B (${seg})`));
    }
  }
  return out;
}
function viol(code, message) {
  return { level: "error", code, message: `[oracle] ${message}` };
}
var fmt = (p) => `(${Math.round(p.x)},${Math.round(p.y)})`;
var samePoint = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
function checkEndpoint(out, e, end, prev, n, which) {
  if (isEventKind(n.kind)) {
    const metric = Math.hypot((end.x - n.cx) / (n.w / 2), (end.y - n.cy) / (n.h / 2));
    if (Math.abs(metric - 1) > EPS / Math.min(n.w / 2, n.h / 2)) {
      out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u304C\u5186 ${n.id} \u306E\u5883\u754C\u4E0A\u306B\u306A\u3044 ${fmt(end)}`));
      return;
    }
    checkApproach(out, e, end, prev, n, which);
    return;
  }
  if (isGatewayKind(n.kind)) {
    const metric = Math.abs(end.x - n.cx) / (n.w / 2) + Math.abs(end.y - n.cy) / (n.h / 2);
    if (Math.abs(metric - 1) > EPS / Math.min(n.w / 2, n.h / 2)) {
      out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u304C\u83F1\u5F62 ${n.id} \u306E\u5883\u754C\u4E0A\u306B\u306A\u3044 ${fmt(end)}`));
      return;
    }
    checkApproach(out, e, end, prev, n, which);
    return;
  }
  const onV = (Math.abs(end.x - n.x) < EPS || Math.abs(end.x - n.x - n.w) < EPS) && end.y > n.y - EPS && end.y < n.y + n.h + EPS;
  const onH = (Math.abs(end.y - n.y) < EPS || Math.abs(end.y - n.y - n.h) < EPS) && end.x > n.x - EPS && end.x < n.x + n.w + EPS;
  if (!onV && !onH) {
    out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u304C ${n.id} \u306E\u5883\u754C\u4E0A\u306B\u306A\u3044 ${fmt(end)}`));
    return;
  }
  const segH = Math.abs(end.y - prev.y) < EPS;
  if (onV && !segH) out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u533A\u9593\u304C ${n.id} \u306E\u7E26\u5883\u754C\u306B\u5782\u76F4\u3067\u306A\u3044`));
  if (onH && !onV && segH) out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u533A\u9593\u304C ${n.id} \u306E\u6A2A\u5883\u754C\u306B\u5782\u76F4\u3067\u306A\u3044`));
}
function checkApproach(out, e, end, prev, n, which) {
  const segH = Math.abs(end.y - prev.y) < EPS;
  const segV = Math.abs(end.x - prev.x) < EPS;
  if (!segH && !segV) return;
  if (segH) {
    const side = end.x < n.cx ? -1 : 1;
    if ((prev.x - end.x) * side < -EPS) {
      out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u533A\u9593\u304C ${n.id} \u306E\u5185\u90E8\u5074\u304B\u3089\u63A5\u7D9A\u3057\u3066\u3044\u308B`));
    }
  } else {
    const side = end.y < n.cy ? -1 : 1;
    if ((prev.y - end.y) * side < -EPS) {
      out.push(viol("O-2", `\u8FBA ${e.id} \u306E${which}\u533A\u9593\u304C ${n.id} \u306E\u5185\u90E8\u5074\u304B\u3089\u63A5\u7D9A\u3057\u3066\u3044\u308B`));
    }
  }
}
function segIntersectsRect(a, b, rx, ry, rw, rh) {
  if (rw <= 0 || rh <= 0) return false;
  const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
  const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
  return x0 < rx + rw - EPS && x1 > rx + EPS && y0 < ry + rh - EPS && y1 > ry + EPS;
}
function findOverlap(e1, e2) {
  for (let i = 0; i + 1 < e1.points.length; i++) {
    for (let j = 0; j + 1 < e2.points.length; j++) {
      const a1 = e1.points[i];
      const b1 = e1.points[i + 1];
      const a2 = e2.points[j];
      const b2 = e2.points[j + 1];
      const h1 = Math.abs(a1.y - b1.y) < EPS;
      const h2 = Math.abs(a2.y - b2.y) < EPS;
      if (h1 !== h2) continue;
      if (h1) {
        if (Math.abs(a1.y - a2.y) > 1) continue;
        const [l1, r1] = a1.x < b1.x ? [a1.x, b1.x] : [b1.x, a1.x];
        const [l2, r2] = a2.x < b2.x ? [a2.x, b2.x] : [b2.x, a2.x];
        if (Math.min(r1, r2) - Math.max(l1, l2) > 1) return `y=${Math.round(a1.y)}`;
      } else {
        if (Math.abs(a1.x - a2.x) > 1) continue;
        const [t1, b1y] = a1.y < b1.y ? [a1.y, b1.y] : [b1.y, a1.y];
        const [t2, b2y] = a2.y < b2.y ? [a2.y, b2.y] : [b2.y, a2.y];
        if (Math.min(b1y, b2y) - Math.max(t1, t2) > 1) return `x=${Math.round(a1.x)}`;
      }
    }
  }
  return null;
}

// src/page-budget.ts
var VIEWPORT_WIDTH = 1600;
var VIEWPORT_HEIGHT = 900;
var SOFT_FONT_LIMIT = 9;
var HARD_LANE_FONT_LIMIT = 6;
var TIME_SCREEN_LIMIT = 2;
function diagnosePageBudget(geometry, strict2 = false) {
  const width = Math.max(1, geometry.width);
  const height = Math.max(1, geometry.height);
  const vertical = geometry.orientation === "vertical";
  const laneAxis = vertical ? width : height;
  const timeAxis = vertical ? height : width;
  const laneViewport = vertical ? VIEWPORT_WIDTH : VIEWPORT_HEIGHT;
  const timeViewport = vertical ? VIEWPORT_HEIGHT : VIEWPORT_WIDTH;
  const metrics = {
    fitFont: FONT_SIZE * Math.min(1, VIEWPORT_WIDTH / width, VIEWPORT_HEIGHT / height),
    laneFont: FONT_SIZE * Math.min(1, laneViewport / laneAxis),
    timeScreens: timeAxis / timeViewport,
    width: geometry.width,
    height: geometry.height
  };
  const summary = `1600x900\u63DB\u7B97: \u5168\u4F53 ${metrics.fitFont.toFixed(1)}px\u3001\u30EC\u30FC\u30F3\u8EF8 ${metrics.laneFont.toFixed(1)}px\u3001\u6642\u9593\u8EF8 ${metrics.timeScreens.toFixed(2)}\u753B\u9762\uFF08SVG ${geometry.width}x${geometry.height}\uFF09`;
  const diagnostics = [];
  const hopCount2 = geometry.edges.reduce((count, edge) => count + (edge.hops?.length ?? 0), 0);
  diagnostics.push({
    level: "info",
    code: "N-440",
    message: `\u8868\u793A\u4E88\u7B97 ${summary}\u3001\u4EA4\u5DEE\u30DB\u30C3\u30D7 ${hopCount2} \u7B87\u6240`
  });
  if (metrics.fitFont < SOFT_FONT_LIMIT && (metrics.laneFont < SOFT_FONT_LIMIT || metrics.timeScreens > TIME_SCREEN_LIMIT)) {
    diagnostics.push({
      level: "warning",
      code: "W-440",
      message: `\u5358\u4E00\u30D3\u30E5\u30FC\u3060\u3051\u3067\u306E\u63D0\u4F9B\u306B\u4E0D\u5411\u304D\u3002\u6982\u8981\u56F3\u3068\u5FC5\u8981\u306A\u8A73\u7D30\u56F3\u3078\u5206\u3051\u308B\uFF08${summary}\uFF09`
    });
  }
  if (metrics.laneFont < HARD_LANE_FONT_LIMIT) {
    diagnostics.push({
      level: strict2 ? "error" : "warning",
      code: strict2 ? "E-441" : "W-441",
      message: `\u30EC\u30FC\u30F3\u8EF8\u306E\u7E2E\u5C0F\u3067\u7269\u7406\u7684\u306B\u5224\u8AAD\u3067\u304D\u306A\u3044\u3002\u5206\u5272\u3057\u3066\u304B\u3089\u63D0\u4F9B\u3059\u308B\uFF08${summary}\uFF09`
    });
  }
  return { metrics, diagnostics };
}

// src/crossing-causes.ts
function differentSourceSharedLength(edges) {
  let shared = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let s1 = 0; s1 + 1 < edges[i].points.length; s1++) {
      const a1 = edges[i].points[s1];
      const a2 = edges[i].points[s1 + 1];
      const aH = isHorizontal(a1, a2);
      for (let j = i + 1; j < edges.length; j++) {
        if (edges[i].from === edges[j].from) continue;
        for (let s2 = 0; s2 + 1 < edges[j].points.length; s2++) {
          const b1 = edges[j].points[s2];
          const b2 = edges[j].points[s2 + 1];
          if (isHorizontal(b1, b2) !== aH) continue;
          if (aH) {
            if (a1.y !== b1.y) continue;
            shared += overlapLen(a1.x, a2.x, b1.x, b2.x);
          } else {
            if (a1.x !== b1.x) continue;
            shared += overlapLen(a1.y, a2.y, b1.y, b2.y);
          }
        }
      }
    }
  }
  return shared;
}
function isHorizontal(a, b) {
  return Math.abs(a.y - b.y) < 0.01;
}
function overlapLen(a1, a2, b1, b2) {
  const left = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const right = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, right - left);
}

// src/sift-order.ts
var SIFT_PASSES = 2;
var SIFT_CAP = 16;
var FLIP_CAP = 5;
var SIFT_MIN_HOPS = 4;
var FLIP_MIN_HOPS = 6;
function improveRouting(g, placement, optimizeReadability, materialize, start) {
  let current = siftConflictOrder(g, start);
  const hops = hopCount(current.geometry.edges);
  const hasGap = current.plan.plans.some((p) => p.points.some((pt) => pt.y.t === "poolChannel"));
  if (hops < FLIP_MIN_HOPS || !hasGap || current.geometry.pools.length < 2) return current;
  const flips = /* @__PURE__ */ new Set();
  const tried = /* @__PURE__ */ new Set();
  let best = scoreOf(g, current.geometry);
  for (let i = 0; i < FLIP_CAP; i++) {
    const id = nextGapFlip(current, tried);
    if (id === void 0) break;
    tried.add(id);
    flips.add(id);
    const cand = materialize(route(g, placement, optimizeReadability, { gapDestFlip: flips }));
    const next = scoreOf(g, cand.geometry);
    if (better(next, best)) {
      current = siftConflictOrder(g, cand);
      best = scoreOf(g, current.geometry);
    } else {
      flips.delete(id);
    }
  }
  return current;
}
function siftConflictOrder(g, current) {
  if (hopCount(current.geometry.edges) < SIFT_MIN_HOPS) return current;
  let bestPlan = current.plan;
  let bestGeom = current.geometry;
  let bestLabelReport = current.labelReport;
  let best = scoreOf(g, bestGeom);
  let cheap = cheapScore(bestGeom.edges);
  let tries = 0;
  for (let pass = 0; pass < SIFT_PASSES; pass++) {
    const pairs = crossingPairs(bestGeom.edges);
    let improved = false;
    for (const [a, b] of pairs) {
      if (tries >= SIFT_CAP) return pack(current, bestPlan, bestGeom, bestLabelReport);
      const cand = trySharedSwap(bestPlan, a, b);
      if (!cand) continue;
      tries++;
      const geom = rewire(g, cand, current);
      const cheapNext = cheapScore(geom.edges);
      if (!cheapBetter(cheapNext, cheap)) continue;
      const labelReport = placeEdgeLabels(geom);
      const next = scoreOf(g, geom);
      if (!better(next, best)) continue;
      bestPlan = cand;
      bestGeom = geom;
      bestLabelReport = labelReport;
      best = next;
      cheap = cheapNext;
      improved = true;
    }
    if (!improved) break;
  }
  return pack(current, bestPlan, bestGeom, bestLabelReport);
}
function pack(origin, plan, geometry, labelReport = origin.labelReport) {
  return { plan, geometry, coords: origin.coords, titleShift: origin.titleShift, labelReport };
}
function rewire(g, plan, origin) {
  const edges = wire(g, plan, origin.coords, origin.geometry.orientation, origin.titleShift);
  computeHops(edges);
  return { ...origin.geometry, edges };
}
function scoreOf(g, geometry) {
  const labels = inspectEdgeLabels(geometry);
  const oracle = checkOracle(g, geometry).filter((d) => d.level === "error").length;
  let hops = 0;
  let raw = 0;
  let spine = 0;
  for (const e of geometry.edges) hops += e.hops?.length ?? 0;
  for (const hit of rawHits(geometry.edges)) {
    raw++;
    if (hit.spine) spine++;
  }
  return [oracle, spine, labels.stolen + labels.ambiguous, differentSourceSharedLength(geometry.edges), hops, raw];
}
function better(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}
function hopCount(edges) {
  return edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0);
}
function cheapScore(edges) {
  let hops = 0;
  let raw = 0;
  let spine = 0;
  for (const e of edges) hops += e.hops?.length ?? 0;
  for (const hit of rawHits(edges)) {
    raw++;
    if (hit.spine) spine++;
  }
  return { spine, hops, raw };
}
function cheapBetter(a, b) {
  if (a.spine !== b.spine) return a.spine < b.spine;
  if (a.hops !== b.hops) return a.hops < b.hops;
  return a.raw < b.raw;
}
function nextGapFlip(current, tried) {
  const counts = /* @__PURE__ */ new Map();
  for (const [a, b] of crossingPairs(current.geometry.edges)) {
    counts.set(a, (counts.get(a) ?? 0) + 1);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const gapIds = new Set(
    current.plan.plans.filter((p) => p.points.some((pt) => pt.y.t === "poolChannel")).map((p) => p.edgeId)
  );
  let best;
  for (const id of gapIds) {
    if (tried.has(id)) continue;
    const n = counts.get(id) ?? 0;
    if (n === 0) continue;
    if (!best || n > best.n || n === best.n && id < best.id) best = { id, n };
  }
  return best?.id;
}
function crossingPairs(edges) {
  const pairs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const hit of rawHits(edges)) {
    const [a, b] = hit.a < hit.b ? [hit.a, hit.b] : [hit.b, hit.a];
    const key2 = `${a}|${b}`;
    if (seen.has(key2)) continue;
    seen.add(key2);
    pairs.push([a, b]);
  }
  pairs.sort((p, q) => p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0);
  return pairs;
}
function rawHits(edges) {
  const hits = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      for (let s1 = 0; s1 + 1 < e1.points.length; s1++) {
        for (let s2 = 0; s2 + 1 < e2.points.length; s2++) {
          if (!segCross(
            e1.points[s1],
            e1.points[s1 + 1],
            e2.points[s2],
            e2.points[s2 + 1]
          )) continue;
          hits.push({ a: e1.id, b: e2.id, spine: e1.onSpine || e2.onSpine });
        }
      }
    }
  }
  return hits;
}
function trySharedSwap(plan, aId, bId) {
  const next = clonePlan(plan);
  const pa = next.plans.find((p) => p.edgeId === aId);
  const pb = next.plans.find((p) => p.edgeId === bId);
  if (!pa || !pb) return void 0;
  let swapped = false;
  swapped = swapTracks(next.gutterRunTrack, gutterRuns(pa), gutterRuns(pb)) || swapped;
  swapped = swapTracks(next.channelRunTrack, channelRuns(pa), channelRuns(pb)) || swapped;
  swapped = swapTracks(next.poolGapRunTrack, poolRuns(pa), poolRuns(pb)) || swapped;
  swapped = swapPortOffsets(pa, pb) || swapped;
  return swapped ? next : void 0;
}
function swapTracks(map, aRuns, bRuns) {
  let swapped = false;
  for (const [key2, runA] of aRuns) {
    const runB = bRuns.get(key2);
    if (runB === void 0) continue;
    const ta = map.get(runA) ?? 0;
    const tb = map.get(runB) ?? 0;
    if (ta === tb) continue;
    map.set(runA, tb);
    map.set(runB, ta);
    swapped = true;
  }
  return swapped;
}
function gutterRuns(p) {
  const out = /* @__PURE__ */ new Map();
  for (const pt of p.points) {
    if (pt.x.t === "gutter") out.set(`${pt.x.g}:${pt.x.side}`, pt.x.run);
  }
  return out;
}
function channelRuns(p) {
  const out = /* @__PURE__ */ new Map();
  for (const pt of p.points) {
    if (pt.y.t === "channel") out.set(`${pt.y.lane}:${pt.y.row}`, pt.y.run);
  }
  return out;
}
function poolRuns(p) {
  const out = /* @__PURE__ */ new Map();
  for (const pt of p.points) {
    if (pt.y.t === "poolChannel") out.set(String(pt.y.gap), pt.y.run);
  }
  return out;
}
function swapPortOffsets(a, b) {
  let swapped = false;
  swapped = swapStubAxis(a, b, 0, 0, "x") || swapped;
  swapped = swapStubAxis(a, b, 0, 0, "y") || swapped;
  swapped = swapStubAxis(a, b, a.points.length - 2, b.points.length - 2, "x") || swapped;
  swapped = swapStubAxis(a, b, a.points.length - 2, b.points.length - 2, "y") || swapped;
  return swapped;
}
function swapStubAxis(a, b, ia, ib, axis) {
  const a0 = a.points[ia];
  const a1 = a.points[ia + 1];
  const b0 = b.points[ib];
  const b1 = b.points[ib + 1];
  if (!a0 || !a1 || !b0 || !b1) return false;
  const sa = a0[axis];
  const sb = b0[axis];
  if (sa.t !== "nodeCX" && sa.t !== "nodeCY") return false;
  if (sb.t !== sa.t) return false;
  if (!sameStub(a0[axis], a1[axis]) || !sameStub(b0[axis], b1[axis])) return false;
  if (sa.t === "nodeCX" && sb.t === "nodeCX" && sa.id !== sb.id) return false;
  if (sa.t === "nodeCY" && sb.t === "nodeCY" && sa.id !== sb.id) return false;
  const oa = "offset" in sa ? sa.offset ?? 0 : 0;
  const ob = "offset" in sb ? sb.offset ?? 0 : 0;
  if (oa === ob) return false;
  setOffset(a0, axis, ob);
  setOffset(a1, axis, ob);
  setOffset(b0, axis, oa);
  setOffset(b1, axis, oa);
  return true;
}
function sameStub(a, b) {
  if (a.t !== b.t) return false;
  if (a.t === "nodeCX" && b.t === "nodeCX") return a.id === b.id && (a.offset ?? 0) === (b.offset ?? 0);
  if (a.t === "nodeCY" && b.t === "nodeCY") return a.id === b.id && (a.offset ?? 0) === (b.offset ?? 0);
  return false;
}
function setOffset(pt, axis, offset) {
  if (axis === "x" && pt.x.t === "nodeCX") pt.x = { t: "nodeCX", id: pt.x.id, offset };
  if (axis === "y" && pt.y.t === "nodeCY") pt.y = { t: "nodeCY", id: pt.y.id, offset };
}
function clonePlan(rp) {
  return {
    ...rp,
    plans: rp.plans.map((p) => ({
      ...p,
      points: p.points.map((pt) => ({ x: { ...pt.x }, y: { ...pt.y } }))
    })),
    gutterRunTrack: new Map(rp.gutterRunTrack),
    channelRunTrack: new Map(rp.channelRunTrack),
    poolGapRunTrack: new Map(rp.poolGapRunTrack),
    gutterTracks: new Map(rp.gutterTracks),
    channelTracks: new Map(rp.channelTracks),
    poolGapTracks: new Map(rp.poolGapTracks),
    gutterLabelNeed: new Map(rp.gutterLabelNeed)
  };
}

// src/oarsp.ts
var CLEAR = 8;
var PORT_STEM = 20;
var CORNER = 6;
var EPS2 = 0.01;
var MIN_VISUAL_SEGMENT = 16;
var PORT_CORNER_GAP = 12;
var MIN_PORT_GAP = 12;
var PORT_SAMPLES = 16;
var WORLD_CAP = 4096;
var BEAM_WIDTH = 48;
function improveDataAssociations(geometry) {
  const routed = improveDataAssociationsOnce(geometry);
  return routed === geometry ? geometry : improveCrowdedPorts(routed);
}
function improveCrowdedPorts(geometry) {
  let edges = geometry.edges;
  let changed = false;
  for (const conflict of conflictComponents(edges, geometry.nodes)) {
    const group2 = [...conflict.ports.keys()].map((id) => edges.find((edge) => edge.id === id));
    if (group2.length < 3) continue;
    const candidates = group2.map((edge) => portCandidates(geometry, edge, conflict.ports.get(edge.id)));
    if (candidates.some((list) => list.length < 2)) continue;
    const focus = new Set(group2.map((edge) => edge.id));
    const candidate = applyChoices(edges, group2, candidates, new Array(group2.length).fill(1));
    if (compare(worldScore(candidate, geometry, focus), worldScore(edges, geometry, focus)) >= 0) continue;
    edges = candidate;
    changed = true;
  }
  return changed ? { ...geometry, edges } : geometry;
}
function improveDataAssociationsOnce(geometry) {
  let changed = false;
  let edges = geometry.edges.map((e) => ({
    ...e,
    points: e.points.map((p) => ({ ...p })),
    hops: void 0
  }));
  for (const conflict of conflictComponents(edges, geometry.nodes)) {
    const group2 = conflict.ids.map((id) => edges.find((e) => e.id === id));
    const focus = new Set(conflict.ids);
    const candidates = group2.map((edge) => conflict.needsGrid ? routeCandidates(geometry, edge, edges.filter((e) => e !== edge)) : portCandidates(geometry, edge, conflict.ports.get(edge.id) ?? /* @__PURE__ */ new Map()));
    if (!conflict.needsGrid) {
      if (candidates.some((list) => list.length < 2)) continue;
      const candidate = applyChoices(edges, group2, candidates, new Array(group2.length).fill(1));
      if (compare(worldScore(candidate, geometry, focus), worldScore(edges, geometry, focus)) < 0) {
        edges = candidate;
        changed = true;
      }
      continue;
    }
    const product = candidates.reduce((n, list) => n * list.length, 1);
    const keep = product <= WORLD_CAP ? product : BEAM_WIDTH;
    let worlds = [{
      choices: new Array(group2.length).fill(0),
      cost: worldScore(edges, geometry, focus)
    }];
    for (let i = 0; i < group2.length; i++) {
      const expanded2 = [];
      for (const world of worlds) for (let choice = 0; choice < candidates[i].length; choice++) {
        const choices = world.choices.slice();
        choices[i] = choice;
        expanded2.push({ choices, cost: worldScore(applyChoices(edges, group2, candidates, choices), geometry, focus) });
      }
      expanded2.sort((a, b) => compare(a.cost, b.cost) || choiceKey(a.choices).localeCompare(choiceKey(b.choices)));
      worlds = expanded2.slice(0, keep);
    }
    const best = worlds[0];
    const current = worldScore(edges, geometry, focus);
    if (!best || compare(best.cost, current) >= 0) continue;
    edges = applyChoices(edges, group2, candidates, best.choices);
    changed = true;
  }
  return changed ? { ...geometry, edges } : geometry;
}
function routeCandidates(geometry, edge, others) {
  const out = [edge.points];
  const seen = /* @__PURE__ */ new Set([pathKey(edge.points)]);
  const path = shortestPaths(geometry, edge, others)[0];
  if (path) addCandidate(out, seen, path);
  return out;
}
function portCandidates(geometry, edge, ports) {
  const out = [edge.points];
  const from = geometry.nodes.find((n) => n.id === edge.from);
  const to = geometry.nodes.find((n) => n.id === edge.to);
  if (!from || !to || edge.points.length < 2) return out;
  const sourceSide = portSide(from, edge.points[0]);
  const targetSide = portSide(to, edge.points.at(-1));
  if (!sourceSide || !targetSide) return out;
  const points = edge.points.map((p) => ({ ...p }));
  if (ports.has("from") && !moveEndpoint(points, from, sourceSide, ports.get("from"), true)) return out;
  if (ports.has("to") && !moveEndpoint(points, to, targetSide, ports.get("to"), false)) return out;
  out.push(simplify(points));
  return out;
}
function moveEndpoint(points, node, side, point, source) {
  const endpoint = source ? 0 : points.length - 1;
  const adjacent = source ? 1 : points.length - 2;
  const a = points[endpoint], b = points[adjacent];
  const previousAdjacent = { ...b };
  const horizontal = side === "left" || side === "right";
  if (horizontal ? Math.abs(a.y - b.y) >= EPS2 : Math.abs(a.x - b.x) >= EPS2) return false;
  points[endpoint] = { ...point };
  if (horizontal) {
    b.y = point.y;
    b.x = side === "right" ? Math.max(b.x, node.x + node.w + PORT_STEM) : Math.min(b.x, node.x - PORT_STEM);
  } else {
    b.x = point.x;
    b.y = side === "bottom" ? Math.max(b.y, node.y + node.h + PORT_STEM) : Math.min(b.y, node.y - PORT_STEM);
  }
  const continuation = points[source ? adjacent + 1 : adjacent - 1];
  if (continuation) {
    if (horizontal && Math.abs(previousAdjacent.x - continuation.x) < EPS2) {
      continuation.x = b.x;
    } else if (!horizontal && Math.abs(previousAdjacent.y - continuation.y) < EPS2) {
      continuation.y = b.y;
    }
  }
  return points.every((p, i) => i === 0 || Math.abs(p.x - points[i - 1].x) < EPS2 || Math.abs(p.y - points[i - 1].y) < EPS2);
}
function addCandidate(out, seen, path) {
  const key2 = pathKey(path);
  if (seen.has(key2)) return;
  seen.add(key2);
  out.push(path);
}
function shortestPaths(geometry, edge, others) {
  const from = geometry.nodes.find((n) => n.id === edge.from);
  const to = geometry.nodes.find((n) => n.id === edge.to);
  if (!from || !to || from.id === to.id) return [];
  const rects = geometry.nodes.map(expanded);
  const sources = boundaryRayPorts(from);
  const targets = boundaryRayPorts(to);
  const lane = from.lane === to.lane ? geometry.lanes.find((l) => l.id === from.lane) : void 0;
  const inLane = (p) => !lane || (geometry.orientation === "vertical" ? p.x >= lane.x - EPS2 && p.x <= lane.x + lane.w + EPS2 : p.y >= lane.y - EPS2 && p.y <= lane.y + lane.h + EPS2);
  const usableSources = sources.filter((p) => inLane(p.stub));
  const usableTargets = targets.filter((p) => inLane(p.stub));
  if (usableSources.length === 0 || usableTargets.length === 0) return [];
  const xs = unique([
    ...rects.flatMap((r) => [r.x1, r.x2]),
    ...usableSources.map((p) => p.stub.x),
    ...usableTargets.map((p) => p.stub.x)
  ]);
  const ys = unique([
    ...rects.flatMap((r) => [r.y1, r.y2]),
    ...usableSources.map((p) => p.stub.y),
    ...usableTargets.map((p) => p.stub.y)
  ]);
  const points = [];
  const byKey = /* @__PURE__ */ new Map();
  for (const y of ys) for (const x of xs) {
    const p = { x, y };
    if (!inLane(p) || rects.some((r) => inside(p, r))) continue;
    byKey.set(key(p), points.length);
    points.push(p);
  }
  const adjacent = points.map(() => []);
  connectLines(points, adjacent, rects, true);
  connectLines(points, adjacent, rects, false);
  const stateCount = points.length * 2;
  const dist = new Array(stateCount);
  const prev = new Int32Array(stateCount).fill(-1);
  const root = new Int32Array(stateCount).fill(-1);
  const heap = new MinHeap();
  usableSources.forEach((port, i) => {
    const v = byKey.get(key(port.stub));
    if (v === void 0) return;
    const state = v * 2 + port.dir;
    const initial = segmentCost(port.point, port.stub, edge, others);
    if (portSide(from, port.point) !== preferredSide(from, to)) initial[2] += 1e4;
    if (!dist[state] || compare(initial, dist[state]) < 0) {
      dist[state] = initial;
      root[state] = i;
      heap.push(state, initial);
    }
  });
  while (heap.length > 0) {
    const item = heap.pop();
    if (dist[item.state] !== item.cost) continue;
    const v = Math.floor(item.state / 2);
    const dir = item.state % 2;
    for (const next of adjacent[v]) {
      const seg = segmentCost(points[v], points[next.to], edge, others);
      if (dir !== next.dir) seg[5]++;
      const cost = add(item.cost, seg);
      const state = next.to * 2 + next.dir;
      if (dist[state] && compare(cost, dist[state]) >= 0) continue;
      dist[state] = cost;
      prev[state] = item.state;
      root[state] = root[item.state];
      heap.push(state, cost);
    }
  }
  const finishes = [];
  for (const target of usableTargets) {
    const v = byKey.get(key(target.stub));
    if (v === void 0) continue;
    for (const dir of [0, 1]) {
      const state = v * 2 + dir;
      const base = dist[state];
      if (!base) continue;
      const tail = segmentCost(target.stub, target.point, edge, others);
      if (portSide(to, target.point) !== preferredSide(to, from)) tail[2] += 1e4;
      if (dir !== target.dir) tail[5]++;
      const cost = add(base, tail);
      finishes.push({ state, target, cost });
    }
  }
  finishes.sort((a, b) => compare(a.cost, b.cost) || key(a.target.point).localeCompare(key(b.target.point)) || a.state - b.state);
  const out = [], seen = /* @__PURE__ */ new Set();
  for (const finish of finishes) {
    if (root[finish.state] < 0) continue;
    const grid = [];
    for (let state = finish.state; state >= 0; state = prev[state]) {
      grid.push(points[Math.floor(state / 2)]);
      if (prev[state] < 0) break;
    }
    grid.reverse();
    const path = simplify([usableSources[root[finish.state]].point, ...grid, finish.target.point]);
    const pathId = pathKey(path);
    if (seen.has(pathId)) continue;
    seen.add(pathId);
    out.push(path);
    break;
  }
  return out;
}
function boundaryRayPorts(node) {
  const out = [];
  for (let i = 0; i < PORT_SAMPLES; i++) {
    const angle = i * 2 * Math.PI / PORT_SAMPLES;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const tx = node.w / 2 / Math.max(Math.abs(dx), EPS2);
    const ty = node.h / 2 / Math.max(Math.abs(dy), EPS2);
    if (tx <= ty) out.push(sidePort(node, dx >= 0 ? "right" : "left", clamp(node.cy + dy * tx, node.y + CORNER, node.y + node.h - CORNER)));
    else out.push(sidePort(node, dy >= 0 ? "bottom" : "top", clamp(node.cx + dx * ty, node.x + CORNER, node.x + node.w - CORNER)));
  }
  return uniquePorts(out);
}
function sidePort(node, side, at) {
  at = Math.round(at * 100) / 100;
  if (side === "left") return { point: { x: node.x, y: at }, stub: { x: node.x - PORT_STEM, y: at }, dir: 0 };
  if (side === "right") return { point: { x: node.x + node.w, y: at }, stub: { x: node.x + node.w + PORT_STEM, y: at }, dir: 0 };
  if (side === "top") return { point: { x: at, y: node.y }, stub: { x: at, y: node.y - PORT_STEM }, dir: 1 };
  return { point: { x: at, y: node.y + node.h }, stub: { x: at, y: node.y + node.h + PORT_STEM }, dir: 1 };
}
function uniquePorts(ports) {
  const seen = /* @__PURE__ */ new Set();
  return ports.filter((port) => {
    const id = `${key(port.point)}:${port.dir}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
function connectLines(points, adjacent, rects, horizontal) {
  const groups = /* @__PURE__ */ new Map();
  points.forEach((p, i) => {
    const k = horizontal ? p.y : p.x;
    const list = groups.get(k) ?? [];
    list.push(i);
    groups.set(k, list);
  });
  for (const group2 of groups.values()) {
    group2.sort((a, b) => horizontal ? points[a].x - points[b].x : points[a].y - points[b].y);
    for (let i = 0; i + 1 < group2.length; i++) {
      const a = group2[i], b = group2[i + 1];
      if (rects.some((r) => blocked(points[a], points[b], r))) continue;
      const dir = horizontal ? 0 : 1;
      adjacent[a].push({ to: b, dir });
      adjacent[b].push({ to: a, dir });
    }
  }
}
function conflictComponents(edges, nodes) {
  const eligible = edges.filter((e) => e.kind === "assoc" && (!e.assocKind || e.assocKind === "data"));
  const active = /* @__PURE__ */ new Set();
  const gridEdges = /* @__PURE__ */ new Set();
  const assignedPorts = /* @__PURE__ */ new Map();
  const links = new Map(eligible.map((e) => [e.id, /* @__PURE__ */ new Set()]));
  const link = (a, b, needsGrid = false) => {
    active.add(a.id);
    active.add(b.id);
    if (needsGrid) {
      gridEdges.add(a.id);
      gridEdges.add(b.id);
    }
    links.get(a.id).add(b.id);
    links.get(b.id).add(a.id);
  };
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i], b = eligible[j];
    if (a.from !== b.from && a.to !== b.to && sharedPair(a, b) > 0) link(a, b, true);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const portGroups = /* @__PURE__ */ new Map();
  const addPort = (edge, endpoint, nodeId, point, next) => {
    const node = nodeById.get(nodeId), side = node && portSide(node, point);
    if (!node || !side) return;
    const key2 = `${endpoint}:${nodeId}:${side}`;
    const list = portGroups.get(key2) ?? [];
    list.push({ edge, endpoint, at: side === "left" || side === "right" ? point.y : point.x, side, stem: [point, next] });
    portGroups.set(key2, list);
  };
  for (const edge of eligible) {
    addPort(edge, "from", edge.from, edge.points[0], edge.points[1] ?? edge.points[0]);
    addPort(edge, "to", edge.to, edge.points.at(-1), edge.points.at(-2) ?? edge.points.at(-1));
  }
  for (const uses of portGroups.values()) {
    if (uses.length < 3) continue;
    const crowded = uses.some((a, i) => uses.slice(i + 1).some((b) => Math.abs(a.at - b.at) < MIN_PORT_GAP && projectedStemOverlap(a.stem, b.stem, a.side) > 0));
    if (!crowded) continue;
    const nodeId = uses[0].edge[uses[0].endpoint];
    const node = nodeById.get(nodeId);
    const side = uses[0].side;
    let candidates = boundaryRayPorts(node).filter((port) => portSide(node, port.point) === side).map((port) => ({ point: port.point, at: side === "left" || side === "right" ? port.point.y : port.point.x })).sort((a, b) => a.at - b.at);
    const candidateGap = Math.min(...candidates.slice(1).map((candidate, i) => candidate.at - candidates[i].at));
    if (candidates.length < uses.length || candidateGap < MIN_PORT_GAP) {
      const lo = (side === "left" || side === "right" ? node.y : node.x) + CORNER;
      const hi = (side === "left" || side === "right" ? node.y + node.h : node.x + node.w) - CORNER;
      const span = MIN_PORT_GAP * (uses.length - 1);
      if (hi - lo < span) continue;
      const mean = uses.reduce((sum, use) => sum + use.at, 0) / uses.length;
      const start = clamp(mean - span / 2, lo, hi - span);
      candidates = Array.from({ length: uses.length }, (_, i) => {
        const port = sidePort(node, side, start + i * MIN_PORT_GAP);
        return { point: port.point, at: start + i * MIN_PORT_GAP };
      });
    }
    if (candidates.length < uses.length) continue;
    const ordered = [...uses].sort((a, b) => a.at - b.at || a.edge.id.localeCompare(b.edge.id));
    let best = candidates.slice(0, ordered.length);
    let bestDistance = Infinity;
    for (let start = 0; start + ordered.length <= candidates.length; start++) {
      const window = candidates.slice(start, start + ordered.length);
      const distance = window.reduce((sum, candidate, i) => sum + Math.abs(candidate.at - ordered[i].at), 0);
      if (distance < bestDistance) {
        best = window;
        bestDistance = distance;
      }
    }
    for (let i = 0; i < ordered.length; i++) {
      const use = ordered[i];
      const ports = assignedPorts.get(use.edge.id) ?? /* @__PURE__ */ new Map();
      ports.set(use.endpoint, best[i].point);
      assignedPorts.set(use.edge.id, ports);
    }
    for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
      link(uses[i].edge, uses[j].edge);
    }
  }
  const out = [];
  const unseen = new Set(active);
  while (unseen.size > 0) {
    const first = [...unseen].sort()[0];
    const stack = [first];
    const component = [];
    unseen.delete(first);
    while (stack.length > 0) {
      const id = stack.pop();
      component.push(id);
      for (const next of [...links.get(id) ?? []].sort().reverse()) {
        if (!unseen.delete(next)) continue;
        stack.push(next);
      }
    }
    out.push({
      ids: component.sort(),
      needsGrid: component.some((id) => gridEdges.has(id)),
      ports: new Map(component.flatMap((id) => assignedPorts.has(id) ? [[id, assignedPorts.get(id)]] : []))
    });
  }
  return out;
}
function applyChoices(edges, group2, candidates, choices) {
  const picked = new Map(group2.map((edge, i) => [edge.id, candidates[i][choices[i]]]));
  return edges.map((edge) => {
    const points = picked.get(edge.id);
    return points ? { ...edge, points, labelPos: void 0, hops: void 0 } : edge;
  });
}
function worldScore(edges, geometry, focus) {
  const total = [0, 0, 0, 0, 0, 0, 0];
  for (const edge of edges) {
    if (focus && !focus.has(edge.id)) continue;
    const part = score(edge.points, edge, edges.filter((e) => e !== edge), geometry.nodes);
    for (let i = 0; i < total.length; i++) total[i] = total[i] + part[i];
  }
  total[2] = portOrderPenalty(edges, geometry.nodes);
  total[5] = visualAppearancePenalty({ ...geometry, edges }) * 1e3 + total[5];
  return total;
}
function visualAppearancePenalty(geometry) {
  const nodes = new Map(geometry.nodes.map((n) => [n.id, n]));
  let penalty = 0;
  for (const edge of geometry.edges) {
    let length = 0;
    for (let i = 1; i + 2 < edge.points.length; i++) {
      const a = edge.points[i], b = edge.points[i + 1];
      penalty += Math.max(0, MIN_VISUAL_SEGMENT - Math.abs(a.x - b.x) - Math.abs(a.y - b.y));
    }
    for (let i = 0; i + 1 < edge.points.length; i++) {
      length += Math.abs(edge.points[i + 1].x - edge.points[i].x) + Math.abs(edge.points[i + 1].y - edge.points[i].y);
    }
    const first = edge.points[0], last = edge.points.at(-1);
    penalty += length - Math.abs(last.x - first.x) - Math.abs(last.y - first.y);
    if (!edge.isReturn) {
      const axis = geometry.orientation === "horizontal" ? "x" : "y";
      const direction = Math.sign(last[axis] - first[axis]);
      if (direction !== 0) for (let i = 0; i + 1 < edge.points.length; i++) {
        const step = (edge.points[i + 1][axis] - edge.points[i][axis]) * direction;
        if (step < 0) penalty -= step;
      }
    }
    if (edge.kind !== "assoc") continue;
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (from) penalty += cornerPortPenalty(from, edge.points[0]);
    if (to) penalty += cornerPortPenalty(to, edge.points.at(-1));
  }
  return penalty;
}
function cornerPortPenalty(node, point) {
  const side = portSide(node, point);
  if (!side) return 0;
  const at = side === "left" || side === "right" ? point.y - node.y : point.x - node.x;
  const span = side === "left" || side === "right" ? node.h : node.w;
  return Math.max(0, PORT_CORNER_GAP - Math.min(at, span - at));
}
function portOrderPenalty(edges, nodes) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const groups = /* @__PURE__ */ new Map();
  const add2 = (node, peer, point, next) => {
    const side = portSide(node, point);
    if (!side) return;
    const verticalSide = side === "left" || side === "right";
    const key2 = `${node.id}:${side}`;
    const list = groups.get(key2) ?? [];
    list.push({
      at: verticalSide ? point.y : point.x,
      toward: verticalSide ? peer.cy : peer.cx,
      misaligned: side !== preferredSide(node, peer),
      side,
      stem: [point, next]
    });
    groups.set(key2, list);
  };
  for (const edge of edges) {
    if (edge.kind !== "assoc") continue;
    const from = nodeById.get(edge.from), to = nodeById.get(edge.to);
    if (!from || !to) continue;
    add2(from, to, edge.points[0], edge.points[1] ?? edge.points[0]);
    add2(to, from, edge.points.at(-1), edge.points.at(-2) ?? edge.points.at(-1));
  }
  let misaligned = 0, proximity = 0, inversions = 0;
  for (const uses of groups.values()) misaligned += uses.filter((use) => use.misaligned).length;
  for (const uses of groups.values()) for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) {
    const a = uses[i], b = uses[j];
    const gap = Math.abs(a.at - b.at);
    if (gap < MIN_PORT_GAP && projectedStemOverlap(a.stem, b.stem, a.side) > 0) {
      proximity += MIN_PORT_GAP - gap;
    } else if ((a.at - b.at) * (a.toward - b.toward) < 0) inversions++;
  }
  return misaligned * 1e4 + proximity * 100 + inversions;
}
function projectedStemOverlap(a, b, side) {
  const axis = side === "left" || side === "right" ? "x" : "y";
  return Math.max(
    0,
    Math.min(Math.max(a[0][axis], a[1][axis]), Math.max(b[0][axis], b[1][axis])) - Math.max(Math.min(a[0][axis], a[1][axis]), Math.min(b[0][axis], b[1][axis]))
  );
}
function preferredSide(node, peer) {
  const dx = peer.cx - node.cx, dy = peer.cy - node.cy;
  return Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? "right" : "left" : dy >= 0 ? "bottom" : "top";
}
function portSide(node, p) {
  if (Math.abs(p.x - node.x) < 1) return "left";
  if (Math.abs(p.x - node.x - node.w) < 1) return "right";
  if (Math.abs(p.y - node.y) < 1) return "top";
  if (Math.abs(p.y - node.y - node.h) < 1) return "bottom";
  return void 0;
}
function score(points, edge, others, nodes) {
  const out = [0, 0, 0, 0, 0, Math.max(0, points.length - 2), 0];
  for (let i = 0; i + 1 < points.length; i++) {
    const seg = segmentCost(points[i], points[i + 1], edge, others);
    out[1] += seg[1];
    out[3] += seg[3];
    out[4] += seg[4];
    out[6] += seg[6];
    for (const n of nodes) {
      if (i === 0 && n.id === edge.from || i === points.length - 2 && n.id === edge.to) continue;
      if (blocked(points[i], points[i + 1], { x1: n.x + 2, y1: n.y + 2, x2: n.x + n.w - 2, y2: n.y + n.h - 2 })) out[0]++;
    }
  }
  return out;
}
function segmentCost(a, b, edge, others) {
  const out = [
    0,
    0,
    0,
    0,
    0,
    0,
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  ];
  for (const other of others) for (let i = 0; i + 1 < other.points.length; i++) {
    const c = other.points[i], d = other.points[i + 1];
    out[1] += overlap(a, b, c, d);
    if (segCross(a, b, c, d)) {
      out[4]++;
      if (other.onSpine) out[3]++;
    }
  }
  return out;
}
function sharedPair(a, b) {
  let n = 0;
  for (let i = 0; i + 1 < a.points.length; i++) for (let j = 0; j + 1 < b.points.length; j++) {
    n += overlap(a.points[i], a.points[i + 1], b.points[j], b.points[j + 1]);
  }
  return n;
}
function overlap(a, b, c, d) {
  const ah = Math.abs(a.y - b.y) < EPS2, ch = Math.abs(c.y - d.y) < EPS2;
  if (ah !== ch) return 0;
  if (ah) {
    if (Math.abs(a.y - c.y) > 1) return 0;
    return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
  }
  if (Math.abs(a.x - c.x) > 1) return 0;
  return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
}
function expanded(n) {
  return { x1: n.x - CLEAR, y1: n.y - CLEAR, x2: n.x + n.w + CLEAR, y2: n.y + n.h + CLEAR };
}
function inside(p, r) {
  return p.x > r.x1 + EPS2 && p.x < r.x2 - EPS2 && p.y > r.y1 + EPS2 && p.y < r.y2 - EPS2;
}
function blocked(a, b, r) {
  if (Math.abs(a.y - b.y) < EPS2) {
    return a.y > r.y1 + EPS2 && a.y < r.y2 - EPS2 && Math.max(a.x, b.x) > r.x1 + EPS2 && Math.min(a.x, b.x) < r.x2 - EPS2;
  }
  return a.x > r.x1 + EPS2 && a.x < r.x2 - EPS2 && Math.max(a.y, b.y) > r.y1 + EPS2 && Math.min(a.y, b.y) < r.y2 - EPS2;
}
function unique(values) {
  return [...new Set(values.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b);
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function key(p) {
  return `${p.x},${p.y}`;
}
function pathKey(points) {
  return points.map(key).join("|");
}
function choiceKey(choices) {
  return choices.join(",");
}
function add(a, b) {
  return a.map((n, i) => n + b[i]);
}
function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
var MinHeap = class {
  items = [];
  get length() {
    return this.items.length;
  }
  push(state, cost) {
    this.items.push({ state, cost });
    for (let i = this.items.length - 1; i > 0; ) {
      const p = Math.floor((i - 1) / 2);
      if (compare(this.items[p].cost, cost) <= 0) break;
      this.items[i] = this.items[p];
      i = p;
      this.items[i] = { state, cost };
    }
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    this.items[0] = last;
    for (let i = 0; ; ) {
      const l = i * 2 + 1, r = l + 1;
      let best = i;
      if (l < this.items.length && compare(this.items[l].cost, this.items[best].cost) < 0) best = l;
      if (r < this.items.length && compare(this.items[r].cost, this.items[best].cost) < 0) best = r;
      if (best === i) break;
      [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
      i = best;
    }
    return first;
  }
};

// src/markers.ts
function eventMarkerGroup(n, stroke) {
  const raw = n.subtype;
  if (!raw || raw === "none") return "";
  if (!EVENT_MARKER_SET.has(raw)) {
    return `<rect data-event-marker="unknown" data-unknown-subtype="${escAttr(raw)}" x="${n.cx}" y="${n.cy}" width="0" height="0"/>`;
  }
  const filled = isThrowEvent(n);
  return eventMarker(raw, filled, n.cx, n.cy, stroke);
}
function stamp(svg, attrs) {
  return svg.replace(/^<([a-z]+)\b/, `<$1 ${attrs}`);
}
var EVENT_MARKER_SET = /* @__PURE__ */ new Set([
  "message",
  "timer",
  "error",
  "escalation",
  "cancel",
  "compensation",
  "conditional",
  "link",
  "signal",
  "terminate",
  "multiple",
  "parallelMultiple"
]);
function eventMarker(trigger, filled, cx, cy, stroke) {
  const fill = filled ? stroke : "none";
  const inner = filled ? "#ffffff" : stroke;
  const s = `fill="${fill}" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"`;
  const line = `fill="none" stroke="${stroke}" stroke-width="1.1" stroke-linecap="round"`;
  const body = markerPath(trigger, filled, cx, cy, s, line, inner);
  if (body === "") return "";
  return stamp(body, `data-event-marker="${trigger}" data-event-filled="${filled ? "true" : "false"}"`);
}
function markerPath(trigger, filled, cx, cy, s, line, inner) {
  switch (trigger) {
    case "message": {
      const w = 14, h = 10;
      const x = cx - w / 2, y = cy - h / 2;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${s}/><path d="M ${x} ${y} L ${cx} ${cy + 1} L ${x + w} ${y}" fill="none" stroke="${filled ? "#ffffff" : inner}" stroke-width="1.1"/>`;
    }
    case "timer":
      return `<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="${strokeOf(s)}" stroke-width="1.1"/><circle cx="${cx}" cy="${cy}" r="6.2" fill="none" stroke="${strokeOf(s)}" stroke-width="0.9"/><path d="M ${cx} ${cy} L ${cx} ${cy - 4.2} M ${cx} ${cy} L ${cx + 3.2} ${cy + 1.6}" ${line}/>`;
    case "error":
      return `<path d="M ${cx - 1.2} ${cy - 7.2} L ${cx + 4.2} ${cy - 0.6} L ${cx + 0.6} ${cy - 0.6} L ${cx + 2.4} ${cy + 7.2} L ${cx - 4.4} ${cy + 0.4} L ${cx - 0.2} ${cy + 0.4} Z" ${s}/>`;
    case "escalation":
      return `<path d="M ${cx} ${cy - 7.2} L ${cx + 5.6} ${cy + 6.4} L ${cx} ${cy + 2.4} L ${cx - 5.6} ${cy + 6.4} Z" ${s}/>`;
    case "cancel":
      return `<path d="M ${cx - 5.2} ${cy - 5.2} L ${cx + 5.2} ${cy + 5.2} M ${cx + 5.2} ${cy - 5.2} L ${cx - 5.2} ${cy + 5.2}" ${line.replace('stroke-width="1.1"', 'stroke-width="1.8"')}/>`;
    case "compensation":
      return `<path d="M ${cx + 6.2} ${cy - 5.4} L ${cx - 0.2} ${cy} L ${cx + 6.2} ${cy + 5.4} Z" ${s}/><path d="M ${cx + 0.4} ${cy - 5.4} L ${cx - 6} ${cy} L ${cx + 0.4} ${cy + 5.4} Z" ${s}/>`;
    case "conditional": {
      const x = cx - 5, y = cy - 6.5;
      return `<rect x="${x}" y="${y}" width="10" height="13" rx="0.5" ${s}/><path d="M ${x + 2} ${y + 3.2} H ${x + 8} M ${x + 2} ${y + 6.2} H ${x + 8} M ${x + 2} ${y + 9.2} H ${x + 7}" fill="none" stroke="${filled ? "#ffffff" : strokeOf(s)}" stroke-width="1"/>`;
    }
    case "link":
      return `<path d="M ${cx - 6.4} ${cy - 3} L ${cx + 0.6} ${cy - 3} L ${cx + 0.6} ${cy - 5.6} L ${cx + 7} ${cy} L ${cx + 0.6} ${cy + 5.6} L ${cx + 0.6} ${cy + 3} L ${cx - 6.4} ${cy + 3} Z" ${s}/>`;
    case "signal":
      return `<path d="M ${cx} ${cy - 7.2} L ${cx + 6.4} ${cy + 5.2} L ${cx - 6.4} ${cy + 5.2} Z" ${s}/>`;
    case "terminate":
      return `<circle cx="${cx}" cy="${cy}" r="6.2" fill="${strokeOf(s)}" stroke="${strokeOf(s)}" data-event-inner="terminate"/>`;
    case "multiple":
      return pentagon(cx, cy, 7, s);
    case "parallelMultiple":
      return `<path d="M ${cx} ${cy - 6.5} L ${cx} ${cy + 6.5} M ${cx - 6.5} ${cy} L ${cx + 6.5} ${cy}" ${line.replace('stroke-width="1.1"', 'stroke-width="1.8"')}/>`;
    default:
      return "";
  }
}
function strokeOf(s) {
  const m = /stroke="([^"]+)"/.exec(s);
  return m?.[1] ?? "#18181b";
}
function pentagon(cx, cy, r, s) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + 2 * Math.PI * i / 5;
    pts.push(`${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`);
  }
  return `<polygon points="${pts.join(" ")}" ${s}/>`;
}
function taskTypeIcon(n, stroke) {
  const x = n.x + 6;
  const y = n.y + 5;
  const s = ` stroke="${stroke}" stroke-width="1.2" fill="none" stroke-linecap="round"`;
  const wrap = (name, body) => stamp(body, `data-task-marker="${name}"`);
  const taskType = n.subtype === "call" && n.callProcess === false && n.callTaskType ? n.callTaskType : n.subtype;
  switch (taskType) {
    case "user":
      return wrap(
        "user",
        `<circle cx="${x + 4.5}" cy="${y + 3.4}" r="2.3"${s}/><path d="M ${x + 0.6} ${y + 10.6} Q ${x + 4.5} ${y + 5.6} ${x + 8.4} ${y + 10.6}"${s}/>`
      );
    case "service": {
      const cx = x + 5, cy = y + 5;
      let ticks = "";
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i;
        ticks += `M ${cx + Math.cos(a) * 3.1} ${cy + Math.sin(a) * 3.1} L ${cx + Math.cos(a) * 5} ${cy + Math.sin(a) * 5} `;
      }
      return wrap("service", `<circle cx="${cx}" cy="${cy}" r="3.1"${s}/><path d="${ticks}"${s}/>`);
    }
    case "rule":
      return wrap(
        "rule",
        `<rect x="${x}" y="${y + 1}" width="11" height="8.5"${s}/><path d="M ${x} ${y + 4} H ${x + 11} M ${x + 3.5} ${y + 4} V ${y + 9.5}"${s}/>`
      );
    case "script":
      return wrap(
        "script",
        `<path d="M ${x} ${y + 2} H ${x + 10} M ${x} ${y + 5} H ${x + 10} M ${x} ${y + 8} H ${x + 7}"${s}/>`
      );
    case "send":
      return wrap(
        "send",
        `<rect x="${x}" y="${y + 1.5}" width="12" height="8" fill="${stroke}" stroke="${stroke}" stroke-width="1"/><path d="M ${x} ${y + 1.5} L ${x + 6} ${y + 6} L ${x + 12} ${y + 1.5}" stroke="#ffffff" stroke-width="1" fill="none"/>`
      );
    case "receive":
      return wrap(
        "receive",
        `<rect x="${x}" y="${y + 1.5}" width="12" height="8"${s}/><path d="M ${x} ${y + 1.5} L ${x + 6} ${y + 6} L ${x + 12} ${y + 1.5}"${s}/>`
      );
    case "manual":
      return wrap(
        "manual",
        `<path d="M ${x + 1} ${y + 10.5} V ${y + 5.2} Q ${x + 1} ${y + 4.2} ${x + 2} ${y + 4.2} Q ${x + 3} ${y + 4.2} ${x + 3} ${y + 5.2} V ${y + 2.5} Q ${x + 3} ${y + 1.5} ${x + 4} ${y + 1.5} Q ${x + 5} ${y + 1.5} ${x + 5} ${y + 2.5} V ${y + 4.4} V ${y + 1.8} Q ${x + 5} ${y + 0.8} ${x + 6} ${y + 0.8} Q ${x + 7} ${y + 0.8} ${x + 7} ${y + 1.8} V ${y + 4.4} V ${y + 2.5} Q ${x + 7} ${y + 1.5} ${x + 8} ${y + 1.5} Q ${x + 9} ${y + 1.5} ${x + 9} ${y + 2.5} V ${y + 5} Q ${x + 10.5} ${y + 3.8} ${x + 11.3} ${y + 4.8} Q ${x + 11.8} ${y + 5.5} ${x + 11} ${y + 6.5} L ${x + 8.5} ${y + 10.5} Z"${s}/>`
      );
    default:
      if (n.subtype && n.subtype !== "call" && n.subtype !== "sub" && n.subtype !== "transaction" && n.subtype !== "eventSub") {
        return `<rect data-task-marker="unknown" data-unknown-subtype="${escAttr(n.subtype)}" x="${n.x}" y="${n.y}" width="0" height="0"/>`;
      }
      return "";
  }
}
function eventSubStartMarker(n, stroke) {
  if (n.subtype !== "eventSub") return "";
  const cx = n.x + 16;
  const cy = n.y + 16;
  const trigger = n.eventSubTrigger;
  if (!trigger) {
    return `<rect data-event-sub-start="missing" x="${cx}" y="${cy}" width="0" height="0"/>`;
  }
  const dash = n.eventSubInterrupting === false ? ' stroke-dasharray="3 2"' : "";
  return `<g data-event-sub-start="${trigger}" data-event-sub-interrupting="${n.eventSubInterrupting === false ? "false" : "true"}"><circle cx="${cx}" cy="${cy}" r="10" fill="#ffffff" stroke="${stroke}" stroke-width="1.2"${dash}/>` + eventMarker(trigger, false, cx, cy, stroke) + "</g>";
}
function activityBottomMarkers(n, stroke) {
  if (!hasBottomActivityMarker(n)) return "";
  const items = [];
  const s = ` stroke="${stroke}" stroke-width="1.2" fill="none" stroke-linecap="round"`;
  const plus = n.subtype === "sub" || n.subtype === "transaction" || n.subtype === "eventSub" || n.subtype === "call" && n.callProcess !== false;
  if (plus) {
    items.push({
      name: "collapsed",
      w: 12,
      draw: (x2, y2) => `<rect data-activity-marker="collapsed" x="${x2}" y="${y2}" width="12" height="12"${s}/><path d="M ${x2 + 6} ${y2 + 2.5} V ${y2 + 9.5} M ${x2 + 2.5} ${y2 + 6} H ${x2 + 9.5}"${s}/>`
    });
  }
  if (n.loop === "loop") {
    items.push({
      name: "loop",
      w: 12,
      draw: (x2, y2) => `<path data-activity-marker="loop" d="M ${x2 + 9.2} ${y2 + 3.2} A 4.4 4.4 0 1 0 ${x2 + 9.4} ${y2 + 8.6}"${s}/><path d="M ${x2 + 9.2} ${y2 + 0.8} L ${x2 + 9.2} ${y2 + 4.4} L ${x2 + 5.8} ${y2 + 3.2}"${s}/>`
    });
  } else if (n.loop === "parallel") {
    items.push({
      name: "parallel-mi",
      w: 12,
      draw: (x2, y2) => `<path data-activity-marker="parallel-mi" d="M ${x2 + 3} ${y2 + 2} V ${y2 + 10} M ${x2 + 6} ${y2 + 2} V ${y2 + 10} M ${x2 + 9} ${y2 + 2} V ${y2 + 10}"${s}/>`
    });
  } else if (n.loop === "sequential") {
    items.push({
      name: "sequential-mi",
      w: 12,
      draw: (x2, y2) => `<path data-activity-marker="sequential-mi" d="M ${x2 + 2} ${y2 + 3.5} H ${x2 + 10} M ${x2 + 2} ${y2 + 6} H ${x2 + 10} M ${x2 + 2} ${y2 + 8.5} H ${x2 + 10}"${s}/>`
    });
  }
  if (n.compensation) {
    items.push({
      name: "compensation",
      w: 14,
      draw: (x2, y2) => `<path data-activity-marker="compensation" d="M ${x2 + 13} ${y2 + 2} L ${x2 + 7} ${y2 + 6} L ${x2 + 13} ${y2 + 10} Z"${s}/><path d="M ${x2 + 7.5} ${y2 + 2} L ${x2 + 1.5} ${y2 + 6} L ${x2 + 7.5} ${y2 + 10} Z"${s}/>`
    });
  }
  if (n.adhoc) {
    items.push({
      name: "adhoc",
      w: 14,
      draw: (x2, y2) => `<path data-activity-marker="adhoc" d="M ${x2 + 1} ${y2 + 7} Q ${x2 + 4} ${y2 + 2} ${x2 + 7} ${y2 + 7} T ${x2 + 13} ${y2 + 7}"${s}/>`
    });
  }
  if (items.length === 0) return "";
  const gap = 4;
  const total = items.reduce((w, it) => w + it.w, 0) + gap * (items.length - 1);
  let x = n.cx - total / 2;
  const y = n.y + n.h - 14;
  return items.map((it) => {
    const drawn = it.draw(x, y);
    x += it.w + gap;
    return drawn;
  }).join("");
}
function gatewayInner(n, stroke) {
  const { cx, cy } = n;
  const m = 7;
  if (n.kind === "and" && n.subtype !== "event") {
    return `<path data-gateway-marker="parallel" d="M ${cx} ${cy - m - 2} L ${cx} ${cy + m + 2} M ${cx - m - 2} ${cy} L ${cx + m + 2} ${cy}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (n.kind === "and" && n.subtype === "event") {
    return `<circle data-gateway-marker="parallel-event" cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="${stroke}" stroke-width="1.1"/><circle cx="${cx}" cy="${cy}" r="6.5" fill="none" stroke="${stroke}" stroke-width="1.1"/>` + pentagon(cx, cy, 4, `fill="none" stroke="${stroke}" stroke-width="1.1"`) + `<path d="M ${cx} ${cy - 2.2} L ${cx} ${cy + 2.2} M ${cx - 2.2} ${cy} L ${cx + 2.2} ${cy}" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/>`;
  }
  if (n.subtype === "event") {
    return `<circle data-gateway-marker="event" cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="${stroke}" stroke-width="1.1"/><circle cx="${cx}" cy="${cy}" r="6.5" fill="none" stroke="${stroke}" stroke-width="1.1"/>` + pentagon(cx, cy, 4, `fill="none" stroke="${stroke}" stroke-width="1.1"`);
  }
  if (n.subtype === "or") {
    return `<circle data-gateway-marker="inclusive" cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="${stroke}" stroke-width="2.2"/>`;
  }
  if (n.subtype === "complex") {
    return `<path data-gateway-marker="complex" d="M ${cx} ${cy - 8} L ${cx} ${cy + 8} M ${cx - 8} ${cy} L ${cx + 8} ${cy} M ${cx - 5.6} ${cy - 5.6} L ${cx + 5.6} ${cy + 5.6} M ${cx + 5.6} ${cy - 5.6} L ${cx - 5.6} ${cy + 5.6}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>`;
  }
  if (n.subtype) {
    return `<rect data-gateway-marker="unknown" data-unknown-subtype="${escAttr(n.subtype)}" x="${cx}" y="${cy}" width="0" height="0"/>`;
  }
  return `<path data-gateway-marker="exclusive" d="M ${cx - m} ${cy - m} L ${cx + m} ${cy + m} M ${cx - m} ${cy + m} L ${cx + m} ${cy - m}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`;
}
function dataObjectExtras(n, stroke) {
  const out = [];
  if (n.subtype === "input" || n.subtype === "output") {
    const filled = n.subtype === "output";
    const ax = n.x + 3;
    const ay = n.cy;
    out.push(
      `<path data-doc-io="${n.subtype}" d="M ${ax} ${ay - 4} L ${ax + 7} ${ay - 4} L ${ax + 7} ${ay - 7} L ${ax + 13} ${ay} L ${ax + 7} ${ay + 7} L ${ax + 7} ${ay + 4} L ${ax} ${ay + 4} Z" fill="${filled ? stroke : "none"}" stroke="${stroke}" stroke-width="1"/>`
    );
  }
  if (n.collection) {
    const y = n.y + n.h - 5;
    const cx = n.cx;
    out.push(
      `<path data-collection="true" d="M ${cx - 5} ${y - 6} V ${y} M ${cx} ${y - 6} V ${y} M ${cx + 5} ${y - 6} V ${y}" stroke="${stroke}" stroke-width="1.2"/>`
    );
  }
  return out.join("");
}
function escAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// src/svg.ts
var FONT = `'Hiragino Kaku Gothic ProN','Hiragino Sans','Noto Sans JP','Yu Gothic',Meiryo,sans-serif`;
var C = {
  bg: "#ffffff",
  laneBorder: "#c9c9cf",
  laneHeader: "#ececef",
  laneAlt: "#fafafa",
  node: "#3f3f46",
  nodeSpine: "#18181b",
  nodeFill: "#ffffff",
  text: "#18181b",
  subText: "#52525b",
  edge: "#52525b",
  edgeSpine: "#18181b",
  provisional: "#b45309",
  title: "#18181b"
};
function renderSvg(geo, version = "dev") {
  const gid = idAllocator();
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" data-process-model-generator="${esc(version)}" width="${geo.width}" height="${geo.height}" viewBox="0 0 ${geo.width} ${geo.height}" font-family="${esc(FONT)}">`
  );
  parts.push(`<rect width="${geo.width}" height="${geo.height}" fill="${C.bg}"/>`);
  if (geo.title) {
    parts.push(text(geo.title, 24, 24 + 18, TITLE_FONT_SIZE, C.title, "start", 600));
  }
  const vertical = geo.orientation === "vertical";
  const poolHeaderT = geo.pools.length > 0 ? 34 : 0;
  const laneHeaderT = geo.headerW - poolHeaderT;
  const laneInPool = (l, pl) => vertical ? l.x >= pl.x && l.x < pl.x + pl.w : l.y >= pl.y && l.y < pl.y + pl.h;
  const dupLaneLabel = new Set(
    geo.pools.filter((pl) => geo.lanes.filter((l) => laneInPool(l, pl)).length === 1).map((pl) => pl.label)
  );
  const renderLane = (lane, i) => {
    const out = [];
    if (lane.blackbox) {
      out.push(`<rect x="${lane.x}" y="${lane.y}" width="${lane.w}" height="${lane.h}" fill="#f1f1f3" stroke="#a1a1aa" stroke-width="1.5"/>`);
      const bx = lane.x + lane.w / 2;
      const by = lane.y + lane.h / 2;
      if (vertical) {
        out.push(
          `<text x="${bx}" y="${by}" font-size="13" font-weight="600" fill="${C.subText}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${bx} ${by})">${esc(lane.label)}</text>`
        );
      } else {
        out.push(text(lane.label, bx, by, 13, C.subText, "middle", 600, false, false));
      }
      return out.join("\n");
    }
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
    if (dupLaneLabel.has(lane.label)) return out.join("\n");
    if (vertical) {
      out.push(
        `<text x="${ix + iw / 2}" y="${iy + laneHeaderT / 2}" font-size="12" fill="${C.subText}" text-anchor="middle" dominant-baseline="central">${esc(lane.label)}</text>`
      );
    } else {
      const lx = ix + laneHeaderT / 2;
      const ly = lane.y + lane.h / 2;
      out.push(
        `<text x="${lx}" y="${ly}" font-size="12" fill="${C.subText}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${lx} ${ly})">${esc(lane.label)}</text>`
      );
    }
    return out.join("\n");
  };
  const laneGs = geo.lanes.map((lane, i) => group(gid("lane", lane.id), renderLane(lane, i)));
  const band = [];
  if (geo.pools.length > 0) {
    const claimed = /* @__PURE__ */ new Set();
    for (const pool of geo.pools) {
      const inner = [];
      inner.push(`<rect x="${pool.x}" y="${pool.y}" width="${pool.w}" height="${pool.h}" fill="none" stroke="#a1a1aa" stroke-width="1.5"/>`);
      const isBlackbox = vertical ? geo.lanes.some((l) => l.blackbox && l.x === pool.x && l.w === pool.w) : geo.lanes.some((l) => l.blackbox && l.y === pool.y && l.h === pool.h);
      if (!isBlackbox) {
        if (vertical) {
          inner.push(`<rect x="${pool.x}" y="${pool.y}" width="${pool.w}" height="${poolHeaderT}" fill="#e4e4e7"/>`);
          inner.push(
            `<text x="${pool.x + pool.w / 2}" y="${pool.y + poolHeaderT / 2}" font-size="12" font-weight="600" fill="${C.subText}" text-anchor="middle" dominant-baseline="central">${esc(pool.label)}</text>`
          );
        } else {
          inner.push(`<rect x="${pool.x}" y="${pool.y}" width="${poolHeaderT}" height="${pool.h}" fill="#e4e4e7"/>`);
          const px = pool.x + poolHeaderT / 2;
          const py = pool.y + pool.h / 2;
          inner.push(
            `<text x="${px}" y="${py}" font-size="12" font-weight="600" fill="${C.subText}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${px} ${py})">${esc(pool.label)}</text>`
          );
        }
      }
      geo.lanes.forEach((lane, i) => {
        if (claimed.has(i) || !laneInPool(lane, pool)) return;
        claimed.add(i);
        inner.push(laneGs[i]);
      });
      band.push(group(gid("pool", pool.id), inner.join("\n")));
    }
    geo.lanes.forEach((_, i) => {
      if (!claimed.has(i)) band.push(laneGs[i]);
    });
  } else {
    band.push(...laneGs);
  }
  parts.push(layer("layer-band", band));
  parts.push(layer("layer-edges", geo.edges.map((e) => group(gid("edge", e.id), renderEdge(e)))));
  parts.push(layer("layer-nodes", geo.nodes.map((n) => group(gid("node", n.id), renderNode(n)))));
  parts.push("</svg>");
  return parts.join("\n");
}
function group(id, content) {
  return content === "" ? "" : `<g id="${id}">
${content}
</g>`;
}
function layer(id, members) {
  const content = members.filter((m) => m !== "").join("\n");
  return content === "" ? `<g id="${id}"/>` : `<g id="${id}">
${content}
</g>`;
}
function idAllocator() {
  const used = /* @__PURE__ */ new Set();
  return (prefix, raw) => {
    let s = raw.replace(/[^\p{L}0-9_.-]/gu, "_");
    if (!/^[\p{L}_]/u.test(s)) s = `_${s}`;
    let id = `${prefix}-${s}`;
    for (let k = 2; used.has(id); k++) id = `${prefix}-${s}_${k}`;
    used.add(id);
    return id;
  };
}
function renderNode(n) {
  const stroke = n.provisional ? C.provisional : n.onSpine ? C.nodeSpine : C.node;
  const sw = n.onSpine ? 1.6 : 1.25;
  const out = [];
  if (n.kind === "task") {
    const isCall = n.subtype === "call";
    const isEventSub = n.subtype === "eventSub";
    const isTx = n.subtype === "transaction";
    const shapeDash = n.provisional ? ' stroke-dasharray="5 3"' : isEventSub ? ' stroke-dasharray="4 3"' : "";
    const attrs = `data-task-type="${n.subtype === "call" ? n.callProcess === false ? "call-global" : "call-process" : esc(n.subtype ?? "abstract")}"`;
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${isCall ? 2.6 : sw}"${shapeDash} ${attrs}/>`
    );
    if (isTx) {
      out.push(
        `<rect data-task-border="transaction" x="${n.x + 3}" y="${n.y + 3}" width="${n.w - 6}" height="${n.h - 6}" rx="6" fill="none" stroke="${stroke}" stroke-width="1.1"/>`
      );
    }
    if (isEventSub) out.push(eventSubStartMarker(n, stroke));
    else if (hasTopTaskIcon(n)) out.push(taskTypeIcon(n, stroke));
    else if (n.subtype && n.subtype !== "call" && n.subtype !== "sub" && n.subtype !== "transaction" && n.subtype !== "eventSub") {
      out.push(taskTypeIcon(n, stroke));
    }
    out.push(activityBottomMarkers(n, stroke));
    const total = n.labelLines.length * LINE_H;
    const shift = (hasTopTaskIcon(n) ? 6 : 0) + (hasBottomActivityMarker(n) ? -7 : 0);
    n.labelLines.forEach((line, i) => {
      const y = n.cy + shift - total / 2 + i * LINE_H + LINE_H / 2;
      out.push(text(line, n.cx, y, FONT_SIZE, C.text, "middle", 400, true));
    });
    return out.join("\n");
  }
  if (isGatewayKind(n.kind)) {
    const { cx, cy } = n;
    const h = n.w / 2;
    const dash2 = n.provisional ? ' stroke-dasharray="5 3"' : "";
    out.push(
      `<path d="M ${cx} ${cy - h} L ${cx + h} ${cy} L ${cx} ${cy + h} L ${cx - h} ${cy} Z" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash2}/>`
    );
    out.push(gatewayInner(n, stroke));
    const totalH2 = n.labelLines.length * OUT_LABEL_LINE_H;
    n.labelLines.forEach((line, i) => {
      const y = n.y - 6 - totalH2 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx - 8, y, OUT_LABEL_FONT, C.subText, "end", 400, true, true));
    });
    return out.join("\n");
  }
  const dash = n.provisional ? ' stroke-dasharray="5 3"' : "";
  if (n.kind === "store") {
    const { x, y, w, h } = n;
    const ry = 7;
    out.push(
      `<path d="M ${x} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} V ${y + ry}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
      `<ellipse cx="${n.cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
      `<path d="M ${x} ${y + ry + 5} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry + 5}" fill="none" stroke="${stroke}" stroke-width="1"/>`
    );
    n.labelLines.forEach((line, i) => {
      const ly = n.y + n.h + 4 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx + 6, ly, OUT_LABEL_FONT, C.subText, "start", 400, true, true));
    });
    return out.join("\n");
  }
  if (n.kind === "note") {
    const { x, y, h } = n;
    out.push(
      `<path d="M ${x + 8} ${y} H ${x} V ${y + h} H ${x + 8}" fill="none" stroke="${stroke}" stroke-width="1.1"/>`
    );
    const totalNH = n.labelLines.length * OUT_LABEL_LINE_H;
    n.labelLines.forEach((line, i) => {
      const ly = n.cy - totalNH / 2 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, x + 6, ly, OUT_LABEL_FONT, C.subText, "start", 400, true, true));
    });
    return out.join("\n");
  }
  if (n.kind === "group") {
    const gDash = n.provisional ? ' stroke-dasharray="5 3"' : ' stroke-dasharray="6 4"';
    out.push(
      `<rect data-artifact="group" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" fill="none" stroke="${stroke}" stroke-width="1.2"${gDash}/>`
    );
    const totalGH = n.labelLines.length * OUT_LABEL_LINE_H;
    n.labelLines.forEach((line, i) => {
      const ly = n.y + 8 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx, ly, OUT_LABEL_FONT, C.subText, "middle", 400, true, true));
    });
    if (totalGH === 0) {
    }
    return out.join("\n");
  }
  if (n.kind === "doc") {
    if (n.subtype === "message") {
      const x = n.x, y = n.y, w = n.w, h = n.h;
      out.push(
        `<rect data-artifact="message" x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
        `<path d="M ${x} ${y} L ${n.cx} ${y + h * 0.55} L ${x + w} ${y}" fill="none" stroke="${stroke}" stroke-width="1.1"/>`
      );
    } else {
      const f = 10;
      const { x, y, w, h } = n;
      const bodyH = n.collection ? h - 8 : h;
      out.push(
        `<path data-artifact="data-object" d="M ${x} ${y} L ${x + w - f} ${y} L ${x + w} ${y + f} L ${x + w} ${y + bodyH} L ${x} ${y + bodyH} Z" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`,
        `<path d="M ${x + w - f} ${y} L ${x + w - f} ${y + f} L ${x + w} ${y + f}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`
      );
      out.push(dataObjectExtras({ ...n, h: bodyH }, stroke));
    }
    n.labelLines.forEach((line, i) => {
      const ly = n.y + n.h + 4 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, n.cx + 6, ly, OUT_LABEL_FONT, C.subText, "start", 400, true, true));
    });
    return out.join("\n");
  }
  const r = n.w / 2;
  const swc = n.kind === "end" ? 3 : 1.6;
  const eventDash = n.provisional ? ' stroke-dasharray="5 3"' : n.interrupting === false ? ' stroke-dasharray="4 3"' : "";
  const role = n.kind === "boundary" ? n.interrupting === false ? "boundary-nonint" : "boundary" : n.kind === "end" ? "end" : n.kind === "start" ? n.interrupting === false ? "start-nonint" : "start" : isThrowEvent(n) ? "throw" : "catch";
  out.push(
    `<circle data-event-role="${role}" cx="${n.cx}" cy="${n.cy}" r="${r - swc / 2}" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="${swc}"${eventDash}/>`
  );
  if (n.kind === "mid" || n.kind === "boundary") {
    out.push(`<circle cx="${n.cx}" cy="${n.cy}" r="${r - 4}" fill="none" stroke="${stroke}" stroke-width="1.2"${eventDash}/>`);
  }
  out.push(eventMarkerGroup(n, stroke));
  const totalH = n.labelLines.length * OUT_LABEL_LINE_H;
  if (n.labelSide === "left" || n.labelSide === "right") {
    const lx = n.labelSide === "left" ? n.x - 6 : n.x + n.w + 6;
    n.labelLines.forEach((line, i) => {
      const y = n.cy - totalH / 2 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
      out.push(text(line, lx, y, OUT_LABEL_FONT, C.subText, n.labelSide === "left" ? "end" : "start", 400, true, true));
    });
    return out.join("\n");
  }
  n.labelLines.forEach((line, i) => {
    const y = n.labelSide === "top" ? n.y - 6 - totalH + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2 : n.y + n.h + 6 + i * OUT_LABEL_LINE_H + OUT_LABEL_LINE_H / 2;
    out.push(text(line, n.cx, y, OUT_LABEL_FONT, C.subText, "middle", 400, true, true));
  });
  return out.join("\n");
}
var ARROW_L = 9;
var ARROW_W = 7;
var HOP_R = 5;
function renderEdge(e) {
  if (e.points.length < 2) return "";
  const isAssoc = e.kind === "assoc";
  const isMsg = e.kind === "msg";
  const assocKind = e.assocKind ?? (isAssoc ? "data" : void 0);
  const undirected = isAssoc && assocKind === "undirected";
  const both = isAssoc && assocKind === "both";
  const stroke = e.provisional ? C.provisional : e.onSpine ? C.edgeSpine : C.edge;
  const sw = e.onSpine ? 2 : isAssoc ? 1.2 : 1.3;
  const dash = e.provisional ? ' stroke-dasharray="5 3"' : isAssoc ? assocKind === "data" ? ' stroke-dasharray="2 4" stroke-linecap="round"' : ' stroke-dasharray="1 3"' : isMsg ? ' stroke-dasharray="7 4"' : "";
  const pts = e.points;
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dx = Math.sign(last.x - prev.x);
  const dy = Math.sign(last.y - prev.y);
  const shortened = undirected ? last : { x: last.x - dx * ARROW_L, y: last.y - dy * ARROW_L };
  const linePts = [...pts.slice(0, -1), shortened];
  const out = [];
  const assocAttr = isAssoc ? ` data-assoc="${assocKind}"` : "";
  const defaultAttr = e.isDefault ? ' data-edge-default="true"' : "";
  const condAttr = e.isConditional ? ' data-edge-conditional="true"' : "";
  const mainAttr = e.mainHint || e.onSpine ? ' data-main-path="true"' : "";
  const returnAttr = e.returnHint ? ' data-return-hint="true"' : "";
  out.push(`<path d="${pathWithHops(linePts, e.hops)}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash}${assocAttr}${defaultAttr}${condAttr}${mainAttr}${returnAttr}/>`);
  const bx = last.x - dx * ARROW_L;
  const by = last.y - dy * ARROW_L;
  const px = dy !== 0 ? ARROW_W / 2 : 0;
  const py = dx !== 0 ? ARROW_W / 2 : 0;
  const openArrow = (x, y, ddx, ddy) => {
    const abx = x - ddx * ARROW_L;
    const aby = y - ddy * ARROW_L;
    const apx = ddy !== 0 ? ARROW_W / 2 : 0;
    const apy = ddx !== 0 ? ARROW_W / 2 : 0;
    return `<path d="M ${abx - apx} ${aby - apy} L ${x} ${y} L ${abx + apx} ${aby + apy}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
  };
  if (isMsg) {
    const p0 = pts[0];
    out.push(
      `<circle cx="${p0.x}" cy="${p0.y}" r="3.5" fill="${C.nodeFill}" stroke="${stroke}" stroke-width="1.2"/>`,
      openArrow(last.x, last.y, dx, dy)
    );
  } else if (isAssoc) {
    if (!undirected) out.push(openArrow(last.x, last.y, dx, dy));
    if (both) {
      const p0 = pts[0];
      const p1 = pts[1];
      out.push(openArrow(p0.x, p0.y, Math.sign(p0.x - p1.x), Math.sign(p0.y - p1.y)));
    }
  } else {
    out.push(
      `<path d="M ${last.x} ${last.y} L ${bx - px} ${by - py} L ${bx + px} ${by + py} Z" fill="${stroke}"/>`
    );
  }
  if (e.isDefault && e.kind === "seq") {
    out.push(defaultSlash(pts[0], pts[1], stroke));
  }
  if (e.isConditional && e.kind === "seq") {
    out.push(conditionalDiamond(pts[0], pts[1], stroke));
  }
  if (e.label && e.labelPos) {
    out.push(text(e.label, e.labelPos.x, e.labelPos.y + EDGE_FONT_SIZE / 2 + 2, EDGE_FONT_SIZE, C.subText, "start", 400, false, true));
  }
  return out.join("\n");
}
function defaultSlash(a, b, stroke) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(10, len / 2);
  const cx = a.x + dx / len * t;
  const cy = a.y + dy / len * t;
  const nx = -dy / len;
  const ny = dx / len;
  const s = 5;
  return `<path data-default-slash="true" d="M ${cx + nx * s - dx / len * 2} ${cy + ny * s - dy / len * 2} L ${cx - nx * s + dx / len * 2} ${cy - ny * s + dy / len * 2}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round"/>`;
}
function conditionalDiamond(a, b, stroke) {
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
function pathWithHops(pts, hops) {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const segHops = (hops ?? []).filter((h) => h.seg === k);
    if (segHops.length === 0) {
      d += ` L ${b.x} ${b.y}`;
      continue;
    }
    const horizontal = Math.abs(a.y - b.y) < 0.01;
    const dir = horizontal ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
    const pos = segHops.map((h) => horizontal ? h.x : h.y).sort((p, q) => (p - q) * dir);
    const clusters = [];
    for (const p of pos) {
      const lastC = clusters[clusters.length - 1];
      if (lastC && Math.abs(p - (dir > 0 ? lastC.hi : lastC.lo)) < HOP_R * 2 + 2) {
        if (dir > 0) lastC.hi = p;
        else lastC.lo = p;
      } else {
        clusters.push({ lo: Math.min(p, p), hi: Math.max(p, p) });
        const c = clusters[clusters.length - 1];
        c.lo = p;
        c.hi = p;
      }
    }
    const sweep = dir > 0 ? 1 : 0;
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
function text(s, x, y, size, fill, anchor = "start", weight = 400, forceWidth = false, halo = false) {
  if (s === "") return "";
  const w = measureText(s, size);
  const tl = forceWidth ? ` textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : "";
  const haloAttr = halo ? ` paint-order="stroke" stroke="#ffffff" stroke-width="3"` : "";
  const weightAttr = weight !== 400 ? ` font-weight="${weight}"` : "";
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="central"${weightAttr}${haloAttr}${tl}>${esc(s)}</text>`;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// src/compile.ts
var CompileError = class extends Error {
  constructor(diagnostics) {
    super(
      "\u30B3\u30F3\u30D1\u30A4\u30EB\u30A8\u30E9\u30FC:\n" + diagnostics.filter((d) => d.level === "error").map((d) => `  ${d.code}: ${d.message}`).join("\n")
    );
    this.diagnostics = diagnostics;
  }
  diagnostics;
};
function compile(source, opts = {}) {
  const strict2 = opts.strict ?? false;
  const parsed = parse(source);
  const diagnostics = applyStrictSemantics(parsed.diagnostics, strict2);
  const ir = parsed.ir;
  if (strict2 && diagnostics.some((d) => d.level === "error")) {
    throw new CompileError(diagnostics);
  }
  const normalized = normalize(ir, strict2);
  const diags = [...diagnostics, ...normalized.report];
  if (strict2 && normalized.report.some((d) => d.level === "error")) {
    throw new CompileError(diags);
  }
  const orientation = normalized.orientation ?? opts.orientation ?? "horizontal";
  const vertical = orientation === "vertical";
  const labelCrossMinus = crossMinusLabelEvents(normalized);
  const cells2 = measureNodes(normalized.nodes, labelCrossMinus, orientation);
  const placement = place(normalized);
  const cellsL = vertical ? transposeCells(cells2) : cells2;
  const titleShift = vertical && normalized.title ? TITLE_H : 0;
  const assemble = (plan) => {
    const planL = vertical ? {
      ...plan,
      gutterLabelNeed: new Map(
        [...plan.gutterLabelNeed].map(([gi, w]) => [gi, Math.min(w, VERT_GUTTER_LABEL_NEED)])
      )
    } : plan;
    const coords = computeCoords(normalized, placement, cellsL, planL, !vertical);
    const edges2 = wire(normalized, planL, coords, orientation, titleShift);
    const nodes = normalized.nodes.map((n) => {
      const lg = coords.nodeGeom.get(n.id);
      if (!vertical) return lg;
      return { ...lg, x: lg.y, y: lg.x + titleShift, w: lg.h, h: lg.w, cx: lg.cy, cy: lg.cx + titleShift };
    });
    const band = (b) => vertical ? { ...b, x: b.y, y: b.x + titleShift, w: b.h, h: b.w } : b;
    const titleNeed = normalized.title ? PAD + measureText(normalized.title, TITLE_FONT_SIZE) + PAD : 0;
    const geometry2 = {
      title: normalized.title,
      orientation,
      width: Math.max(vertical ? coords.height : coords.width, titleNeed),
      height: vertical ? coords.width + titleShift : coords.height,
      headerW: coords.headerW,
      bandRight: vertical ? coords.height - PAD : coords.bandRight,
      bandBottom: vertical ? coords.bandRight + titleShift : coords.height - PAD,
      pools: coords.poolGeoms.map(band),
      lanes: coords.lanes.map(band),
      nodes,
      edges: edges2
    };
    computeHops(edges2);
    const labelReport = placeEdgeLabels(geometry2);
    return { plan: planL, geometry: geometry2, coords, titleShift, labelReport };
  };
  const finish = (assembled) => {
    const geometry2 = assembled.geometry;
    return { assembled, geometry: geometry2, violations: checkOracle(normalized, geometry2), labelReport: assembled.labelReport };
  };
  const baseline = finish(assemble(route(normalized, placement, false)));
  const improved = finish(assemble(route(normalized, placement, true)));
  const picked = compareScore2(layoutScore(improved), layoutScore(baseline)) < 0 ? improved : baseline;
  const readability = picked === improved;
  const refinedAssembled = improveRouting(
    normalized,
    placement,
    readability,
    assemble,
    picked.assembled
  );
  const unchanged = refinedAssembled.geometry.edges === picked.geometry.edges;
  const refined = unchanged ? picked : finish(refinedAssembled);
  const symbolicSelected = unchanged || compareScore2(layoutScore(refined), layoutScore(picked)) < 0 ? refined : picked;
  const oarspGeometry = improveDataAssociations(symbolicSelected.geometry);
  let selected = symbolicSelected;
  if (oarspGeometry !== symbolicSelected.geometry) {
    computeHops(oarspGeometry.edges);
    const labelReport = placeEdgeLabels(oarspGeometry);
    const candidate = {
      assembled: { ...symbolicSelected.assembled, geometry: oarspGeometry, labelReport },
      geometry: oarspGeometry,
      violations: checkOracle(normalized, oarspGeometry),
      labelReport
    };
    if (compareScore2(layoutScore(candidate), layoutScore(symbolicSelected)) < 0) selected = candidate;
  }
  const geometry = selected.geometry;
  const edges = geometry.edges;
  if (picked === improved) {
    diags.push({ level: "info", code: "N-431", message: "\u5168\u4F53\u53EF\u8AAD\u6027\u30B9\u30B3\u30A2\u306B\u3088\u308A\u6539\u5584\u7D4C\u8DEF\u3092\u63A1\u7528" });
  }
  if (selected !== symbolicSelected) {
    diags.push({ level: "info", code: "N-434", message: "Data Association \u306E\u76F4\u4EA4\u53EF\u8996\u30B0\u30E9\u30D5\u7D4C\u8DEF\u3092\u63A1\u7528" });
  }
  const laneOfNode = new Map(normalized.nodes.map((n) => [n.id, n.lane]));
  const poolOfLane = new Map(normalized.lanes.map((l) => [l.id, l.pool]));
  const poolOfNode = (id) => poolOfLane.get(laneOfNode.get(id) ?? "");
  for (const e of normalized.edges) {
    if (e.fromPool || e.toPool || poolOfNode(e.from) !== poolOfNode(e.to)) continue;
    if (e.isReturn && placement.col.get(e.to) >= placement.col.get(e.from)) {
      diags.push({
        level: "warning",
        code: "W-252",
        message: `\u623B\u308A\u8FBA ${e.from} -> ${e.to} \u304C\u6642\u9593\u8EF8\u306E\u9806\u65B9\u5411\u306B\u914D\u7F6E\u3055\u308C\u305F\uFF08\u30A8\u30F3\u30B8\u30F3\u4E0D\u5909\u6761\u4EF6\u306E\u7834\u308C\u306E\u7591\u3044\uFF09`
      });
    }
  }
  diags.push(...selected.violations);
  if (selected.labelReport.nodeHits > 0) {
    const nodeDetails = selected.labelReport.details.filter((detail) => detail.includes(":node:"));
    diags.push({
      level: "warning",
      code: "W-432",
      message: `\u8FBA\u30E9\u30D9\u30EB\u3068\u30CE\u30FC\u30C9\u306E\u91CD\u306A\u308A ${selected.labelReport.nodeHits} \u7B87\u6240\uFF08${nodeDetails.slice(0, 3).join(", ")}\uFF09`
    });
  }
  if (selected.labelReport.edgeHits > 0 || selected.labelReport.labelHits > 0) {
    diags.push({
      level: "info",
      code: "N-432",
      message: `\u8FBA\u30E9\u30D9\u30EB\u306E\u6B8B\u5B58\u4EA4\u5DEE: \u7DDA ${selected.labelReport.edgeHits}\u3001\u30E9\u30D9\u30EB ${selected.labelReport.labelHits}`
    });
  }
  if (selected.labelReport.stolen > 0 || selected.labelReport.ambiguous > 0) {
    diags.push({
      level: "info",
      code: "N-433",
      message: `\u8FBA\u30E9\u30D9\u30EB\u306E\u6240\u6709\u4E0D\u660E: stolen ${selected.labelReport.stolen}\u3001ambiguous ${selected.labelReport.ambiguous}`
    });
  }
  const hopCount2 = edges.reduce((n, e) => n + (e.hops?.length ?? 0), 0);
  if (hopCount2 > 0) {
    diags.push({ level: "info", code: "N-430", message: `\u4EA4\u5DEE\u30DB\u30C3\u30D7 ${hopCount2} \u7B87\u6240` });
  }
  const pageBudget = diagnosePageBudget(geometry, strict2);
  diags.push(...pageBudget.diagnostics);
  if (pageBudget.diagnostics.some((d) => d.level === "error")) {
    throw new CompileError(diags);
  }
  return {
    svg: renderSvg(geometry, opts.version),
    geometry,
    normalized,
    diagnostics: diags
  };
}
function layoutScore(candidate) {
  const { geometry, violations, labelReport } = candidate;
  let sharedGatewayExits = 0;
  let hops = 0;
  let bends = 0;
  let length = 0;
  let farLabels = 0;
  for (const e of geometry.edges) {
    hops += e.hops?.length ?? 0;
    bends += Math.max(0, e.points.length - 2);
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i];
      const b = e.points[i + 1];
      length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }
    if (e.label && e.labelPos) {
      const a = e.points[0];
      const x = e.labelPos.x + measureText(e.label, EDGE_FONT_SIZE) / 2;
      const y = e.labelPos.y + (EDGE_FONT_SIZE + 4) / 2;
      if (Math.abs(x - a.x) + Math.abs(y - a.y) > 160) farLabels++;
    }
  }
  for (const n of geometry.nodes) {
    if (n.kind !== "xor" && n.kind !== "and") continue;
    const outs = geometry.edges.filter((e) => e.from === n.id && e.kind === "seq");
    if (outs.length !== 2) continue;
    if (outs[0].points[0].x === outs[1].points[0].x && outs[0].points[0].y === outs[1].points[0].y) {
      sharedGatewayExits++;
    }
  }
  return [
    violations.filter((d) => d.level === "error").length,
    sharedGatewayExits,
    labelReport.nodeHits,
    labelReport.edgeHits + labelReport.labelHits,
    hops,
    labelReport.stolen,
    labelReport.ambiguous,
    farLabels,
    visualAppearancePenalty(geometry),
    bends,
    length,
    geometry.width * geometry.height
  ];
}
function compareScore2(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// src/eval.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
var HEADERS = ["claim", "kind", "view:id", "status", "reason"];
var CONSULTING_HEADERS = ["claim", "kind", "source", "view:id", "status", "reason"];
var STATUSES = /* @__PURE__ */ new Set(["modeled", "?", "excluded", "unresolved"]);
var CONSULTING_KINDS = /* @__PURE__ */ new Set([
  "fact",
  "assume",
  "conflict",
  "unknown-topology",
  "unknown-label",
  "proposal",
  "view",
  "diagnostic"
]);
var VIEW_BOUNDARIES = /* @__PURE__ */ new Set(["outcome", "handoff", "subprocess", "trigger", "time", "variant"]);
function cells(line) {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
function separator(line, columns) {
  const parts = cells(line);
  return parts.length === columns && parts.every((part) => /^:?-{3,}:?$/u.test(part));
}
function parseLedger(markdown, consulting = false) {
  const lines = markdown.split(/\r?\n/u);
  const findings = [];
  const headers = consulting ? CONSULTING_HEADERS : HEADERS;
  let header = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    const normalized = cells(lines[i]).map((cell) => cell.toLowerCase());
    if (normalized.join("\0") === headers.join("\0") && separator(lines[i + 1], headers.length)) {
      header = i;
      break;
    }
  }
  if (header < 0) {
    return {
      rows: [],
      findings: [{
        level: "error",
        code: "E-510",
        message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33\u304C\u306A\u3044\u3002\u5217\u3092 ${headers.join(" | ")} \u306E\u9806\u3067\u4F5C\u6210\u3059\u308B`
      }]
    };
  }
  const rows = [];
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const parts = cells(line);
    if (parts.length !== headers.length) {
      findings.push({
        level: "error",
        code: "E-510",
        message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306E\u5217\u6570\u304C ${parts.length}\u3002${headers.length} \u5217\u306B\u56FA\u5B9A\u3059\u308B`
      });
      continue;
    }
    const [claim, kind, source, viewId, statusRaw, reason] = consulting ? parts : [parts[0], parts[1], void 0, parts[2], parts[3], parts[4]];
    if (!claim || !kind || consulting && !source || !viewId || !statusRaw || !reason) {
      findings.push({
        level: "error",
        code: "E-510",
        message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306B\u7A7A\u6B04\u304C\u3042\u308B`
      });
      continue;
    }
    if (!STATUSES.has(statusRaw)) {
      findings.push({
        level: "error",
        code: "E-510",
        message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306E status\u300C${statusRaw}\u300D\u306F modeled / ? / excluded / unresolved \u306E\u3044\u305A\u308C\u3067\u3082\u306A\u3044`
      });
      continue;
    }
    if (consulting) {
      const locators = source.split(";").map((value) => value.trim()).filter(Boolean);
      if (locators.some((value) => !/^[a-z][a-z0-9-]*:.+/u.test(value)) || kind === "conflict" && locators.length < 2) {
        findings.push({
          level: "error",
          code: "E-515",
          message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306E source \u306F\u7A2E\u5225:\u4F4D\u7F6E\u5F62\u5F0F${kind === "conflict" ? "\u30922\u4EF6\u4EE5\u4E0A" : ""}\u3067\u8A18\u9332\u3059\u308B`
        });
        continue;
      }
      if (!CONSULTING_KINDS.has(kind)) {
        findings.push({
          level: "error",
          code: "E-515",
          message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306E kind\u300C${kind}\u300D\u306F consulting \u306E\u56FA\u5B9A\u8A9E\u5F59\u306B\u306A\u3044`
        });
        continue;
      }
      if (kind === "unknown-topology" && statusRaw !== "unresolved") {
        findings.push({
          level: "error",
          code: "E-515",
          message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306E unknown-topology \u306F unresolved \u306B\u3059\u308B\u3002\u56DE\u7B54\u6E08\u307F\u306A\u3089 fact \u7B49\u3078\u66F4\u65B0\u3059\u308B`
        });
        continue;
      }
      const asked = kind === "unknown-topology" ? listValue(reason, "asked") : void 0;
      if (kind === "unknown-topology" && (asked?.length !== 1 || !/^(?:user-question:.+|unavailable:.+|no-channel)$/u.test(asked[0]))) {
        findings.push({
          level: "error",
          code: "E-515",
          message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${i + 1} \u884C\u76EE\u306E unknown-topology \u306F reason \u306B asked=user-question:<id> / unavailable:<locator> / no-channel \u306E\u3044\u305A\u308C\u304B\u3092\u8A18\u9332\u3059\u308B`
        });
        continue;
      }
    }
    rows.push({ claim, kind, source, viewId, status: statusRaw, reason, line: i + 1 });
  }
  if (rows.length === 0) {
    findings.push({ level: "error", code: "E-510", message: "\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33\u306B\u30C7\u30FC\u30BF\u884C\u304C\u306A\u3044" });
  }
  return { rows, findings };
}
function splitViewRef(ref) {
  const index = ref.indexOf(":");
  if (index <= 0 || index === ref.length - 1) return void 0;
  return { view: ref.slice(0, index), target: ref.slice(index + 1) };
}
function listValue(reason, key2) {
  const match = new RegExp(`(?:^|;)\\s*${key2}=([^;]+)`, "u").exec(reason);
  if (!match) return void 0;
  const value = match[1].trim();
  if (value === "-" || value === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function sameMembers(actual, reported) {
  return [...actual].sort().join("\0") === [...reported].sort().join("\0");
}
function evaluateDelivery(options) {
  const findings = [];
  let markdown = "";
  try {
    markdown = readFileSync(options.reportPath, "utf8");
  } catch {
    findings.push({
      level: "error",
      code: "E-510",
      message: `\u30EC\u30D3\u30E5\u30FC\u5831\u544A\u3092\u8AAD\u3081\u306A\u3044: ${options.reportPath}`
    });
  }
  const ledger = parseLedger(markdown, options.consulting);
  findings.push(...ledger.findings);
  const rows = ledger.rows;
  const flowFiles = readdirSync(options.directory).filter((name) => name.endsWith(".flow")).sort();
  if (flowFiles.length === 0) {
    findings.push({ level: "error", code: "E-500", message: "\u8A55\u4FA1\u5BFE\u8C61\u306E .flow \u304C\u306A\u3044" });
    return { findings, flowIds: [], rows };
  }
  const views = [];
  for (const name of flowFiles) {
    const flowPath = join(options.directory, name);
    const source = readFileSync(flowPath, "utf8");
    const parsed = parse(source);
    const id = parsed.ir.id;
    if (!id) {
      findings.push({
        level: "error",
        code: "E-501",
        message: `${name}: flow id[label] \u306E\u5B89\u5B9A ID \u304C\u306A\u3044`
      });
      continue;
    }
    if (views.some((view) => view.id === id)) {
      findings.push({ level: "error", code: "E-501", message: `flow id ${id} \u304C\u91CD\u8907\u3057\u3066\u3044\u308B` });
      continue;
    }
    try {
      const svgPath = join(options.directory, `${basename(name, ".flow")}.svg`);
      const delivered = existsSync(svgPath) ? readFileSync(svgPath, "utf8") : void 0;
      const result = compile(source, { strict: true, version: options.version });
      views.push({ id, file: name, ir: parsed.ir, diagnostics: result.diagnostics });
      if (delivered === void 0) {
        findings.push({ level: "error", code: "E-500", message: `${name}: \u5BFE\u5FDC\u3059\u308B SVG \u304C\u306A\u3044` });
      } else if (delivered !== result.svg) {
        findings.push({
          level: "error",
          code: "E-500",
          message: `${name}: \u914D\u5E03 SVG \u304C\u540C\u3058\u7248\u306E strict \u518D\u30B3\u30F3\u30D1\u30A4\u30EB\u7D50\u679C\u3068\u4E00\u81F4\u3057\u306A\u3044`
        });
      }
    } catch (error) {
      if (error instanceof CompileError) {
        for (const diagnostic of error.diagnostics.filter((d) => d.level === "error")) {
          findings.push({ level: "error", code: diagnostic.code, message: `${name}: ${diagnostic.message}` });
        }
      } else {
        throw error;
      }
    }
  }
  const byView = new Map(views.map((view) => [view.id, view]));
  for (const row of rows) {
    const ref = splitViewRef(row.viewId);
    if (!ref || !byView.has(ref.view)) {
      findings.push({
        level: "error",
        code: "E-511",
        message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${row.line} \u884C\u76EE\u306E view:id\u300C${row.viewId}\u300D\u304C\u6210\u679C\u7269\u306B\u5B58\u5728\u3057\u306A\u3044`
      });
      continue;
    }
    if (ref.target === "*" || /^W-\d+$/u.test(ref.target)) continue;
    const view = byView.get(ref.view);
    const nodeExists = view.ir.nodes.some((node) => node.id === ref.target);
    const edgeExists = view.ir.edges.some((edge) => `${edge.from}->${edge.to}` === ref.target);
    if (!nodeExists && !edgeExists) {
      findings.push({
        level: "error",
        code: "E-511",
        message: `\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33 ${row.line} \u884C\u76EE\u306E\u5BFE\u8C61\u300C${row.viewId}\u300D\u304C .flow \u306B\u5B58\u5728\u3057\u306A\u3044`
      });
    }
  }
  for (const view of views) {
    const indexRow = rows.find(
      (row) => row.claim === "view-index" && row.kind === "view" && row.viewId === `${view.id}:*`
    );
    if (!indexRow) {
      findings.push({
        level: "error",
        code: "E-512",
        message: `${view.id}: view-index \u884C\u304C\u306A\u3044`
      });
    } else {
      const actualEntries = view.ir.nodes.filter((node) => node.kind === "start").map((node) => node.id);
      const actualExits = view.ir.nodes.filter((node) => node.kind === "end").map((node) => node.id);
      const entries = listValue(indexRow.reason, "entry");
      const exits = listValue(indexRow.reason, "exits");
      if (!entries || !exits || !sameMembers(actualEntries, entries) || !sameMembers(actualExits, exits)) {
        findings.push({
          level: "error",
          code: "E-512",
          message: `${view.id}: view-index \u306E reason \u306F entry=<id,...>; exits=<id,...> \u3092\u5B9F\u969B\u306E\u958B\u59CB\u30FB\u7D42\u4E86\u3068\u4E00\u81F4\u3055\u305B\u308B`
        });
      }
    }
    const warningCodes = [...new Set(
      view.diagnostics.filter((diagnostic) => diagnostic.level === "warning").map((diagnostic) => diagnostic.code)
    )];
    for (const code of warningCodes) {
      const disposition = rows.find(
        (row) => row.claim === code && row.kind === "diagnostic" && row.viewId === `${view.id}:${code}`
      );
      if (!disposition) {
        findings.push({
          level: "error",
          code: "E-513",
          message: `${view.id}: \u5B9F\u969B\u306B\u767A\u751F\u3057\u305F ${code} \u306E\u51E6\u5206\u884C\u304C\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33\u306B\u306A\u3044`
        });
      } else if (disposition.status === "unresolved" || disposition.status === "?") {
        findings.push({
          level: "error",
          code: "E-513",
          message: `${view.id}: ${code} \u304C ${disposition.status} \u306E\u307E\u307E\u3067\u5B8C\u4E86\u6271\u3044\u306B\u3067\u304D\u306A\u3044`
        });
      }
    }
    for (const node of view.ir.nodes.filter((candidate) => candidate.provisional)) {
      const covered = rows.some(
        (row) => row.viewId === `${view.id}:${node.id}` && (row.status === "?" || row.status === "unresolved")
      );
      if (!covered) {
        findings.push({
          level: "error",
          code: "E-514",
          message: `${view.id}:${node.id} \u306E ? \u3092\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33\u304C\u8AAC\u660E\u3057\u3066\u3044\u306A\u3044`
        });
      }
    }
    for (const edge of view.ir.edges.filter((candidate) => candidate.provisional)) {
      const target = `${edge.from}->${edge.to}`;
      const covered = rows.some(
        (row) => row.viewId === `${view.id}:${target}` && (row.status === "?" || row.status === "unresolved")
      );
      if (!covered) {
        findings.push({
          level: "error",
          code: "E-514",
          message: `${view.id}:${target} \u306E ->? \u3092\u30EC\u30D3\u30E5\u30FC\u53F0\u5E33\u304C\u8AAC\u660E\u3057\u3066\u3044\u306A\u3044`
        });
      }
    }
  }
  const oversized = views.some((view) => view.diagnostics.some((diagnostic) => diagnostic.code === "W-440"));
  if (oversized && (flowFiles.length < 2 || !options.parentId)) {
    findings.push({
      level: "error",
      code: "E-517",
      message: "W-440 \u3092\u542B\u3080\u6210\u679C\u7269\u306F\u3001\u8907\u6570 .flow \u3068 --parent \u306B\u3088\u308B\u89AA\u5B50\u8A55\u4FA1\u304C\u5FC5\u8981"
    });
  }
  if (options.parentId) {
    const parent = byView.get(options.parentId);
    if (!parent) {
      findings.push({ level: "error", code: "E-501", message: `\u89AA\u30D3\u30E5\u30FC ${options.parentId} \u304C\u5B58\u5728\u3057\u306A\u3044` });
    } else {
      const referencedBy = /* @__PURE__ */ new Map();
      for (const owner of views) {
        for (const node of owner.ir.nodes.filter((candidate) => candidate.kind === "task" && candidate.subtype === "sub")) {
          if (!byView.has(node.id)) {
            findings.push({
              level: "error",
              code: "E-502",
              message: `${owner.id}:${node.id} \u306E task(sub) \u306B\u5BFE\u5FDC\u3059\u308B\u5B50 .flow \u304C\u306A\u3044`
            });
            continue;
          }
          const owners = referencedBy.get(node.id) ?? /* @__PURE__ */ new Set();
          owners.add(owner.id);
          referencedBy.set(node.id, owners);
        }
      }
      for (const child of views.filter((view) => view.id !== parent.id)) {
        let plan;
        let boundary;
        if (options.consulting) {
          plan = rows.find(
            (row) => row.claim === "view-plan" && row.kind === "view" && row.viewId === `${child.id}:*`
          );
          boundary = plan && listValue(plan.reason, "boundary")?.[0];
          const level = plan && listValue(plan.reason, "level")?.[0];
          const state = plan && listValue(plan.reason, "state")?.[0];
          if (!plan || !boundary || !VIEW_BOUNDARIES.has(boundary) || !["1", "2"].includes(level ?? "") || !["asis", "tobe"].includes(state ?? "")) {
            findings.push({
              level: "error",
              code: "E-516",
              message: `${child.id}: consulting \u306E view-plan \u306F boundary=<outcome|handoff|subprocess|trigger|time|variant>; level=<1|2>; state=<asis|tobe> \u3092\u8981\u6C42\u3059\u308B`
            });
          }
        }
        const independent = rows.some(
          (row) => row.claim === "independent-trigger" && row.kind === "view" && row.viewId === `${child.id}:*` && row.status === "modeled"
        );
        const owners = referencedBy.get(child.id);
        if (independent && owners?.size) {
          findings.push({
            level: "error",
            code: "E-501",
            message: `${child.id}: task(sub) \u304B\u3089\u53C2\u7167\u3055\u308C\u308B\u5B50\u30D3\u30E5\u30FC\u3092 independent-trigger \u3068\u3057\u3066\u91CD\u8907\u5BA3\u8A00\u3067\u304D\u306A\u3044`
          });
        } else if (independent && options.consulting && !["trigger", "time"].includes(boundary ?? "")) {
          findings.push({
            level: "error",
            code: "E-516",
            message: `${child.id}: independent-trigger \u306E view-plan \u306F boundary=trigger \u307E\u305F\u306F time \u306B\u3059\u308B`
          });
        } else if (!owners?.size && !independent) {
          findings.push({
            level: "error",
            code: "E-501",
            message: `${child.id}: \u3069\u306E\u30D3\u30E5\u30FC\u306B\u3082\u540C\u3058 ID \u306E task(sub) \u304C\u306A\u304F\u3001independent-trigger \u884C\u3082\u306A\u3044`
          });
        }
      }
      const parentPoolLabels = new Set(parent.ir.pools.flatMap((pool) => [pool.id, pool.label]));
      const parentLaneLabels = new Set(parent.ir.lanes.flatMap((lane) => [lane.id, lane.label]));
      for (const child of views.filter((view) => view.id !== parent.id)) {
        for (const pool of child.ir.pools) {
          if (parentPoolLabels.has(pool.id) || parentPoolLabels.has(pool.label)) continue;
          if (!parentLaneLabels.has(pool.id) && !parentLaneLabels.has(pool.label)) continue;
          findings.push({
            level: "warning",
            code: "W-503",
            message: `${child.id} \u3067\u5916\u90E8\u30D7\u30FC\u30EB\u306E ${pool.id}\u300C${pool.label}\u300D\u304C\u89AA\u3067\u306F\u30EC\u30FC\u30F3\u306B\u306A\u3063\u3066\u3044\u308B`
          });
        }
      }
    }
  }
  const labelIds = /* @__PURE__ */ new Map();
  for (const view of views) {
    for (const lane of view.ir.lanes) {
      const ids = labelIds.get(lane.label) ?? /* @__PURE__ */ new Set();
      ids.add(lane.id);
      labelIds.set(lane.label, ids);
    }
  }
  for (const [label, ids] of labelIds) {
    if (ids.size < 2) continue;
    findings.push({
      level: "info",
      code: "N-505",
      message: `\u540C\u3058\u30EC\u30FC\u30F3\u8868\u793A\u540D\u300C${label}\u300D\u306B\u8907\u6570 ID \u304C\u3042\u308B: ${[...ids].sort().join(", ")}`
    });
  }
  return { findings, flowIds: views.map((view) => view.id), rows };
}

// src/cli.ts
var CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;
function print(stream, value) {
  const visible = stream.isTTY ? value.replace(CONTROL_CHARACTER, (character) => `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`) : value;
  (stream === process.stderr ? console.error : console.log)(visible);
}
if (process.stderr.isTTY) {
  process.on("uncaughtException", (error) => {
    print(process.stderr, error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
var args = process.argv.slice(2);
if (args.includes("--version")) {
  print(process.stdout, "0.2.19");
  process.exit(0);
}
if (args[0] === "eval") {
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : void 0;
  };
  const directory = valueAfter("--dir");
  const reportPath = valueAfter("--report");
  const parentId = valueAfter("--parent");
  const consulting = args.includes("--consulting");
  if (!directory || !reportPath) {
    print(process.stderr, "usage: process-model-generator eval --dir <\u6210\u679C\u7269dir> --report <review.md> [--parent <flow-id>] [--consulting]");
    process.exit(2);
  }
  const result = evaluateDelivery({
    directory,
    reportPath,
    parentId,
    consulting,
    version: "0.2.19"
  });
  for (const finding of result.findings) {
    const tag = finding.level === "error" ? "ERROR" : finding.level === "warning" ? "WARN " : "info ";
    print(process.stderr, `${tag} ${finding.code} ${finding.message}`);
  }
  const errors = result.findings.filter((finding) => finding.level === "error").length;
  const warnings = result.findings.filter((finding) => finding.level === "warning").length;
  print(process.stderr, `evaluated ${result.flowIds.length} views: ${errors} errors, ${warnings} warnings`);
  process.exit(errors > 0 ? 1 : 0);
}
var input = args.find((a) => !a.startsWith("-"));
var outIdx = args.indexOf("-o");
var output = outIdx >= 0 ? args[outIdx + 1] : void 0;
var strict = args.includes("--strict");
var emitNormalized = args.includes("--emit-normalized");
var verticalDefault = args.includes("--vertical");
if (!input) {
  print(process.stderr, "usage: process-model-generator <input.flow> [-o out.svg] [--strict] [--vertical] [--emit-normalized] | process-model-generator eval --dir <dir> --report <review.md> [--parent <flow-id>] [--consulting] | --version");
  process.exit(2);
}
try {
  const source = readFileSync2(input, "utf8");
  const result = compile(source, {
    strict,
    orientation: verticalDefault ? "vertical" : void 0,
    version: "0.2.19"
  });
  for (const d of result.diagnostics) {
    const tag = d.level === "error" ? "ERROR" : d.level === "warning" ? "WARN " : "info ";
    print(process.stderr, `${tag} ${d.code} ${d.message}${d.line !== void 0 ? ` (line ${d.line})` : ""}`);
  }
  if (emitNormalized) {
    const n = result.normalized;
    print(process.stdout, "--- \u6B63\u898F\u5316\u5F8C IR ---");
    for (const node of n.nodes) {
      print(
        process.stdout,
        `${node.kind}	${node.id}	[${node.label}]	lane=${node.lane}${node.onSpine ? "	spine" : ""}${node.synthetic ? "	synthetic" : ""}${node.provisional ? "	?" : ""}`
      );
    }
    for (const e of n.edges) {
      print(
        process.stdout,
        `edge	${e.kind}	${e.from} -> ${e.to}${e.label ? `: ${e.label}` : ""}${e.onSpine ? "	spine" : ""}${e.isReturn ? "	return" : ""}${e.synthetic ? "	synthetic" : ""}`
      );
    }
  }
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, result.svg, "utf8");
    print(process.stderr, `wrote ${output} (${result.geometry.width}x${result.geometry.height})`);
  } else {
    print(process.stdout, result.svg);
  }
  const hasError = result.diagnostics.some((d) => d.level === "error");
  process.exit(hasError ? 1 : 0);
} catch (err) {
  if (err instanceof CompileError) {
    print(process.stderr, err.message);
    process.exit(1);
  }
  throw err;
}
