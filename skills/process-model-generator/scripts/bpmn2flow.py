#!/usr/bin/env python3
"""BPMN XML → Process Model Generator DSL の機械変換器。

目的: 実在の .bpmn 原本から DSL を機械生成する。手写しの転写ドリフトを排除し、
対応/未対応の要素を機械集計して台帳の数字を検証可能にする。

対応: プール / レーン / タスク類(種別・下部マーカー) / 開始・終了・中間(catch/throw) /
境界イベント(割込み・非割込み) / XOR・AND・包含・複合・イベントベース /
シーケンス(名前・default・条件) / メッセージフロー / データオブジェクト・入出力・
コレクション / データストア / データ関連 / Association(無方向・方向付き) /
注釈 / メッセージ成果物 /
縦向き図(DI の isHorizontal="false")。

未対応として数える: 展開 Sub-Process の入れ子平坦化、Choreography / Conversation、
展開 Event Sub-Process、BPMN Group 包含、縦横混在 DI。近似して意味を落とす要素は supported に入れない。

使い方: python3 scripts/bpmn2flow.py in.bpmn out.flow "出典URL" [--json-stats out.json]
"""
import json
import sys
import re
import xml.etree.ElementTree as ET
from collections import Counter

B = '{http://www.omg.org/spec/BPMN/20100524/MODEL}'
DI = '{http://www.omg.org/spec/BPMN/20100524/DI}'
DC = '{http://www.omg.org/spec/DD/20100524/DC}'

TASK_TAGS = {
    'task', 'userTask', 'serviceTask', 'scriptTask', 'businessRuleTask',
    'manualTask', 'sendTask', 'receiveTask', 'callActivity', 'subProcess',
    'adHocSubProcess', 'transaction',
}
TASK_SUB = {
    'userTask': 'user', 'serviceTask': 'service', 'businessRuleTask': 'rule',
    'scriptTask': 'script', 'sendTask': 'send', 'receiveTask': 'receive',
    'manualTask': 'manual', 'callActivity': 'call', 'subProcess': 'sub',
    'adHocSubProcess': 'sub', 'transaction': 'transaction',
}
EVENT_DEF = {
    'messageEventDefinition': 'message',
    'timerEventDefinition': 'timer',
    'errorEventDefinition': 'error',
    'escalationEventDefinition': 'escalation',
    'cancelEventDefinition': 'cancel',
    'compensateEventDefinition': 'compensation',
    'conditionalEventDefinition': 'conditional',
    'linkEventDefinition': 'link',
    'signalEventDefinition': 'signal',
    'terminateEventDefinition': 'terminate',
}
GW_MAP = {
    'exclusiveGateway': 'xor',
    'parallelGateway': 'and',
    'inclusiveGateway': 'xor(or)',
    'complexGateway': 'xor(complex)',
}
FLOW_NODE_TAGS = TASK_TAGS | {
    'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent',
    'boundaryEvent', 'exclusiveGateway', 'parallelGateway', 'inclusiveGateway',
    'complexGateway', 'eventBasedGateway', 'implicitThrowEvent',
}
GLOBAL_TASK_TAGS = {
    'globalTask': None,
    'globalUserTask': 'user',
    'globalManualTask': 'manual',
    'globalScriptTask': 'script',
    'globalBusinessRuleTask': 'rule',
}


def local(tag):
    return tag.replace(B, '') if tag.startswith(B) else tag.split('}', 1)[-1]


def clean(s):
    return re.sub(r'\s+', ' ', (s or '').strip())


def emit_node(out, orig_id, rec, sid):
    kind, label, prov, attached = rec
    mark = '?' if prov else ''
    ident = sid(orig_id)
    attach = ''
    if attached:
        attach = f' @{sid(attached)}'
    if kind.startswith(('start', 'end', 'boundary', 'mid')) and not label:
        out.append(f'  {kind}{mark} {ident}{attach}')
    else:
        out.append(f'  {kind}{mark} {ident}[{label}]{attach}')


def event_info(el):
    defs = []
    for c in el:
        t = local(c.tag)
        if t in EVENT_DEF:
            defs.append(EVENT_DEF[t])
    parallel = (el.get('parallelMultiple') or '').strip().lower() in ('true', '1')
    if parallel and len(defs) > 1:
        return 'parallelMultiple'
    if len(defs) > 1:
        return 'multiple'
    return defs[0] if defs else None


def loop_tokens(el):
    toks = []
    for c in el:
        t = local(c.tag)
        if t == 'standardLoopCharacteristics':
            toks.append('loop')
        elif t == 'multiInstanceLoopCharacteristics':
            toks.append('sequential' if (c.get('isSequential') or '').lower() in ('true', '1') else 'parallel')
        elif t == 'compensation':
            pass
    if el.get('isForCompensation') in ('true', '1'):
        toks.append('compensation')
    if local(el.tag) == 'adHocSubProcess' or el.get('triggeredByEvent') in ('true', '1'):
        pass
    return toks


def main(src, dst, source_url, stats_json=None):
    tree = ET.parse(src)
    root = tree.getroot()

    orientable = {p.get('id') for p in root.findall(f'.//{B}participant')}
    orientable |= {ln.get('id') for ln in root.iter(f'{B}lane')}
    pos = {}
    expanded = {}
    horiz_flags = []
    for sh in root.iter(f'{DI}BPMNShape'):
        b = sh.find(f'{DC}Bounds')
        if b is not None:
            pos[sh.get('bpmnElement')] = (float(b.get('x')), float(b.get('y')))
        ih = sh.get('isHorizontal')
        if ih is not None and sh.get('bpmnElement') in orientable:
            ih = ih.strip()
            if ih in ('true', '1'):
                horiz_flags.append(True)
            elif ih in ('false', '0'):
                horiz_flags.append(False)
        ie = sh.get('isExpanded')
        if ie is not None:
            expanded[sh.get('bpmnElement')] = ie.strip() in ('true', '1')
    vertical = bool(horiz_flags) and not any(horiz_flags)
    mixed_orientation = any(horiz_flags) and not all(horiz_flags)

    def cross_of(eid, default=1e9):
        p = pos.get(eid)
        return (p[0] if vertical else p[1]) if p else default

    def main_of(eid, default=1e9):
        p = pos.get(eid)
        return (p[1] if vertical else p[0]) if p else default

    processes = root.findall(f'{B}process')
    participants = {p.get('processRef'): clean(p.get('name')) for p in root.findall(f'.//{B}participant')}
    process_ids = {pr.get('id') for pr in processes}
    global_tasks = {}
    for t, marker in GLOBAL_TASK_TAGS.items():
        for el in root.iter(f'{B}{t}'):
            if el.get('id'):
                global_tasks[el.get('id')] = marker

    supported = []  # (tag, id, name)
    unsupported = []  # (tag, id, name, reason)

    def add_unsup(tag, eid, name, reason):
        unsupported.append((tag, eid or '', name or '', reason))

    def add_sup(tag, eid, name):
        supported.append((tag, eid or '', name or ''))

    if mixed_orientation:
        add_unsup('isHorizontal', '', '', '縦横混在DI。横として変換')

    # choreography / conversation は対象外
    for tag in ('choreography', 'conversation', 'subConversation', 'callConversation'):
        for el in root.iter(f'{B}{tag}'):
            add_unsup(tag, el.get('id'), clean(el.get('name')), 'Process/Collaboration 対象外')

    lanes = []  # (y, laneName, [nodeIds], pid)
    nodes = {}  # id -> (kind, label, provisional, attachedTo|None)
    edges = []  # (kind, src, dst, label, mainHint, isDefault, assocKind)
    node_lane = {}
    nested_ids = set()

    def walk_nested(container, owner_id, owner_tag):
        for child in list(container):
            t = local(child.tag)
            cid = child.get('id')
            if t in FLOW_NODE_TAGS or t in ('dataObject', 'dataObjectReference', 'dataStoreReference',
                                            'dataInput', 'dataOutput', 'textAnnotation', 'group', 'association'):
                if cid:
                    nested_ids.add(cid)
                    add_unsup(t, cid, clean(child.get('name')),
                              f'展開 {owner_tag} {owner_id} の内部。平坦化しない')
            if t in ('subProcess', 'adHocSubProcess', 'transaction'):
                walk_nested(child, cid or owner_id, t)

    for proc in processes:
        pid = proc.get('id')
        pname = participants.get(pid) or clean(proc.get('name')) or pid
        lane_els = proc.findall(f'{B}laneSet/{B}lane') or proc.findall(f'.//{B}lane')
        if lane_els:
            for lane in lane_els:
                refs = [fr.text for fr in lane.findall(f'{B}flowNodeRef') if fr.text]
                y = min((cross_of(r) for r in refs), default=1e9)
                lanes.append((y, clean(lane.get('name')) or pname, refs, pid))
                add_sup('lane', lane.get('id'), clean(lane.get('name')))
                for r in refs:
                    node_lane[r] = clean(lane.get('name')) or pname
        else:
            refs = [el.get('id') for el in proc if el.get('id') and local(el.tag) in FLOW_NODE_TAGS]
            y = min((cross_of(r) for r in refs), default=1e9)
            lanes.append((y, pname, refs, pid))
            add_sup('process-lane', pid, pname)
            for r in refs:
                node_lane[r] = pname

        for el in list(proc):
            tag = local(el.tag)
            eid = el.get('id')
            name = clean(el.get('name'))
            if eid in nested_ids:
                continue
            if tag in ('subProcess', 'adHocSubProcess', 'transaction'):
                inner_flow = [c for c in el if local(c.tag) in FLOW_NODE_TAGS]
                is_exp = expanded.get(eid, bool(inner_flow))
                triggered = (el.get('triggeredByEvent') or '').lower() in ('true', '1')
                toks = list(loop_tokens(el))
                if tag == 'adHocSubProcess':
                    toks.append('adhoc')
                if triggered:
                    kind = 'task(eventSub'
                    starts = [c for c in el if local(c.tag) == 'startEvent']
                    if len(starts) == 1:
                        trigger = event_info(starts[0])
                        if trigger:
                            toks.append(trigger)
                        if (starts[0].get('isInterrupting') or 'true').lower() in ('false', '0'):
                            toks.append('nonint')
                    if toks:
                        kind += ',' + ','.join(toks)
                    kind += ')'
                elif tag == 'transaction':
                    kind = 'task(transaction' + ((',' + ','.join(toks)) if toks else '') + ')'
                else:
                    kind = 'task(sub' + ((',' + ','.join(toks)) if toks else '') + ')'
                if is_exp and inner_flow:
                    add_unsup(tag, eid, name, 'Expanded Sub-Process。入れ子レイアウトは未対応のため平坦化しない')
                    walk_nested(el, eid, tag)
                    # collapsed 近似にはしない
                    continue
                nodes[eid] = (kind, name or eid, False, None)
                add_sup(tag, eid, name)
                continue
            if tag in TASK_TAGS:
                sub = TASK_SUB.get(tag)
                toks = list(loop_tokens(el))
                if tag == 'callActivity':
                    called = el.get('calledElement') or ''
                    if called in global_tasks:
                        sub = 'call,global'
                        if global_tasks[called]:
                            sub += ',' + global_tasks[called]
                    else:
                        sub = 'call'  # Process 呼出し（+）。未解決も Process 側
                parts = []
                if sub:
                    parts.append(sub)
                parts.extend(toks)
                kind = f"task({','.join(parts)})" if parts else 'task'
                nodes[eid] = (kind, name or eid, False, None)
                add_sup(tag, eid, name)
            elif tag in GW_MAP:
                nodes[eid] = (GW_MAP[tag], name, False, None)
                add_sup(tag, eid, name)
            elif tag == 'eventBasedGateway':
                inst = (el.get('eventGatewayType') or 'Exclusive').strip()
                if inst.lower() == 'parallel':
                    nodes[eid] = ('and(event)', name, False, None)
                else:
                    nodes[eid] = ('xor(event)', name, False, None)
                add_sup(tag, eid, name)
            elif tag == 'startEvent':
                sub = event_info(el)
                nonint = (el.get('isInterrupting') or 'true').lower() in ('false', '0')
                toks = []
                if sub:
                    toks.append(sub)
                if nonint:
                    toks.append('nonint')
                kind = f"start({','.join(toks)})" if toks else 'start'
                nodes[eid] = (kind, name, False, None)
                add_sup(tag, eid, name)
            elif tag == 'endEvent':
                sub = event_info(el)
                kind = f'end({sub})' if sub else 'end'
                nodes[eid] = (kind, name, False, None)
                if sub == 'cancel':
                    add_unsup(tag, eid, name, 'Cancel End は Transaction 内部専用。展開入れ子は未対応')
                else:
                    add_sup(tag, eid, name)
            elif tag == 'intermediateCatchEvent':
                sub = event_info(el)
                kind = f'mid({sub})' if sub else 'mid'
                nodes[eid] = (kind, name, False, None)
                add_sup(tag, eid, name)
            elif tag == 'intermediateThrowEvent':
                sub = event_info(el)
                if sub:
                    kind = f'mid({sub},throw)'
                else:
                    kind = 'mid(throw)'
                nodes[eid] = (kind, name, False, None)
                add_sup(tag, eid, name)
            elif tag == 'boundaryEvent':
                sub = event_info(el)
                attached = el.get('attachedToRef')
                cancel = (el.get('cancelActivity') or 'true').lower() not in ('false', '0')
                toks = []
                if sub:
                    toks.append(sub)
                if not cancel:
                    toks.append('nonint')
                kind = f"boundary({','.join(toks)})" if toks else 'boundary'
                label = name or eid
                if attached:
                    nodes[eid] = (kind, label, False, attached)
                    add_sup(tag, eid, name)
                else:
                    add_unsup(tag, eid, name, 'attachedToRef が無い')
            elif tag in ('dataObject', 'dataObjectReference'):
                coll = (el.get('isCollection') or '').lower() in ('true', '1')
                kind = 'doc(collection)' if coll else 'doc'
                nodes[eid] = (kind, name or eid, False, None)
                add_sup(tag, eid, name)
            elif tag == 'dataInput':
                coll = (el.get('isCollection') or '').lower() in ('true', '1')
                kind = 'doc(input,collection)' if coll else 'doc(input)'
                nodes[eid] = (kind, name or eid, False, None)
                add_sup(tag, eid, name)
            elif tag == 'dataOutput':
                coll = (el.get('isCollection') or '').lower() in ('true', '1')
                kind = 'doc(output,collection)' if coll else 'doc(output)'
                nodes[eid] = (kind, name or eid, False, None)
                add_sup(tag, eid, name)
            elif tag == 'dataStoreReference':
                nodes[eid] = ('store', name or eid, False, None)
                add_sup(tag, eid, name)
            elif tag == 'textAnnotation':
                nodes[eid] = ('note', clean(''.join(el.itertext())) or eid, False, None)
                add_sup(tag, eid, name)
            elif tag == 'group':
                add_unsup(tag, eid, name, 'BPMN Group は包含レイアウトが必要。点状成果物へ近似しない')

        for asc in proc.findall(f'{B}association'):
            a, b = asc.get('sourceRef'), asc.get('targetRef')
            direction = (asc.get('associationDirection') or 'None').lower()
            if a in nodes and b in nodes:
                if direction == 'one':
                    edges.append(('assoc', a, b, '', False, False, 'directed'))
                elif direction == 'both':
                    edges.append(('assoc', a, b, '', False, False, 'both'))
                else:
                    edges.append(('assoc', a, b, '', False, False, 'undirected'))
                add_sup('association', asc.get('id'), '')
            else:
                add_unsup('association', asc.get('id'), '', '端点が変換対象外')
        defaults = {el.get('default') for el in proc.iter() if el.get('default')}
        for sf in proc.findall(f'{B}sequenceFlow'):
            sid, tid = sf.get('sourceRef'), sf.get('targetRef')
            if sid in nested_ids or tid in nested_ids:
                add_unsup('sequenceFlow', sf.get('id'), clean(sf.get('name')), '展開サブプロセス内部')
                continue
            if sid not in nodes or tid not in nodes:
                add_unsup('sequenceFlow', sf.get('id'), clean(sf.get('name')),
                          '始点または終点が変換対象外')
                continue
            cond = sf.find(f'{B}conditionExpression')
            is_def = sf.get('id') in defaults
            label = clean(sf.get('name'))
            if cond is not None and not label:
                label = clean(''.join(cond.itertext())) or '条件'
            edges.append(('seq', sid, tid, label, False, is_def, None))
            add_sup('sequenceFlow', sf.get('id'), label)
        for el in proc:
            tag = local(el.tag)
            owner = el.get('id')
            for child in el:
                ct = local(child.tag)
                if ct == 'dataInputAssociation':
                    srcs = [s.text for s in child.findall(f'{B}sourceRef') if s.text]
                    if srcs and owner in nodes and all(s in nodes for s in srcs):
                        for s in srcs:
                            edges.append(('assoc', s, owner, '', False, False, 'data'))
                        add_sup('dataInputAssociation', child.get('id'), '')
                    else:
                        add_unsup('dataInputAssociation', child.get('id'), '', '始点または終点が変換対象外')
                elif ct == 'dataOutputAssociation':
                    tgt = child.find(f'{B}targetRef')
                    if tgt is not None and tgt.text in nodes and owner in nodes:
                        edges.append(('assoc', owner, tgt.text, '', False, False, 'data'))
                        add_sup('dataOutputAssociation', child.get('id'), '')
                    else:
                        add_unsup('dataOutputAssociation', child.get('id'), '', '始点または終点が変換対象外')

    # 定義レベルの message 成果物（図に載るものだけ）
    for msg in root.findall(f'{B}message'):
        mid = msg.get('id')
        if mid in pos:
            nodes[mid] = ('doc(message)', clean(msg.get('name')) or mid, False, None)
            add_sup('message', mid, clean(msg.get('name')))

    proc_has_nodes = {pr.get('id'): any(el.get('id') in nodes for el in pr.iter()) for pr in processes}
    pool_names = {}  # processRef -> (pool id, label)
    blackbox_entries = []  # (cross position, pool id, label, participant id)
    part_pool = {}
    pool_y = {}
    pn = 0
    for pt in root.findall(f'.//{B}participant'):
        pr = pt.get('processRef')
        pid = f'p{pn}'
        pn += 1
        label = clean(pt.get('name')) or pid
        part_pool[pt.get('id')] = pid
        pool_y[pid] = cross_of(pt.get('id'))
        if pr:
            pool_names[pr] = (pid, label)
        else:
            blackbox_entries.append((pool_y[pid], pid, label, pt.get('id')))
        add_sup('participant', pt.get('id'), label)
    blackbox_pools = {pid for _, pid, _, _ in blackbox_entries}
    blackbox_pools |= {pid for prid, (pid, _) in pool_names.items() if not proc_has_nodes.get(prid)}

    def emit_end(x):
        return x in nodes or x in blackbox_pools

    for mf in root.findall(f'.//{B}messageFlow'):
        ms, mt = mf.get('sourceRef'), mf.get('targetRef')
        ms2 = ms if ms in nodes else part_pool.get(ms)
        mt2 = mt if mt in nodes else part_pool.get(mt)
        if ms2 and mt2 and emit_end(ms2) and emit_end(mt2):
            edges.append(('msg', ms2, mt2, clean(mf.get('name')), False, False, None))
            add_sup('messageFlow', mf.get('id'), clean(mf.get('name')))
        else:
            add_unsup('messageFlow', mf.get('id'), clean(mf.get('name')),
                      '不明参照、またはレーン付きプール枠へのメッセージ（黒箱のみポート）')

    short = {}
    pool_ids = {pid for pid, _ in pool_names.values()} | blackbox_pools

    def sid(eid):
        if eid in pool_ids:
            return eid
        if eid not in short:
            short[eid] = f'n{len(short)}'
        return short[eid]

    out = []
    pnames2 = [clean(p.get('name')) for p in root.findall(f'.//{B}participant') if clean(p.get('name'))]
    title = pnames2[0] if pnames2 else (clean(processes[0].get('name')) if processes else 'process')
    out.append(f'# 出典(原本): {clean(source_url)}')
    out.append('# scripts/bpmn2flow.py による機械変換。手修正した場合は出典と変更理由を記録する')
    out.append(f'# conversion-stats: supported={len(supported)} unsupported={len(unsupported)}')
    for tag, eid, name, reason in unsupported:
        out.append(f'# unsupported: {tag}\t{eid}\t{name}\t{reason}')
    out.append(f'flow {title}')
    if vertical:
        out.append('orientation vertical')
    out.append('')
    emitted_pool = None
    items = []
    for _, lname, refs, prid in lanes:
        placed_all = [r for r in refs if r in nodes]
        yy = min((cross_of(r) for r in placed_all), default=None)
        if placed_all:
            items.append((yy if yy is not None else 1e9, 'lane', lname, placed_all, prid))
    for prid, (pid, label) in pool_names.items():
        if not proc_has_nodes.get(prid):
            items.append((pool_y.get(pid, 1e9), 'blackbox', label, [], prid))
    for yy, pid, label, participant_id in blackbox_entries:
        items.append((yy, 'blackbox-direct', label, [], (pid, participant_id)))
    for yy, kind_, lname, placed_all, prid in sorted(items, key=lambda x: x[0]):
        if kind_ == 'blackbox':
            pid, label = pool_names[prid]
            out.append(f'pool {pid}[{label}]')
            emitted_pool = pid
            continue
        if kind_ == 'blackbox-direct':
            pid, _ = prid
            out.append(f'pool {pid}[{lname}]')
            emitted_pool = pid
            continue
        if pool_names and prid in pool_names:
            pid, label = pool_names[prid]
            if pid != emitted_pool:
                out.append(f'pool {pid}[{label}]')
                emitted_pool = pid
        out.append(f'lane {lname}')
        for r in sorted(placed_all, key=main_of):
            emit_node(out, r, nodes[r], sid)
    orphan = [r for r in nodes if r not in node_lane]
    if orphan:
        for r in sorted(orphan, key=main_of):
            emit_node(out, r, nodes[r], sid)
    out.append('')
    for kind, s, d, label, main, is_def, assoc_kind in edges:
        if s not in nodes and s not in blackbox_pools:
            continue
        if d not in nodes and d not in blackbox_pools:
            continue
        if kind == 'assoc':
            if assoc_kind == 'undirected':
                arrow = '-.-'
            elif assoc_kind == 'directed':
                arrow = '..>'
            elif assoc_kind == 'both':
                arrow = '<..>'
            else:
                arrow = '-.->'
        elif kind == 'msg':
            arrow = '~>'
        elif is_def:
            arrow = '->/'
        elif main:
            arrow = '=>'
        else:
            arrow = '->'
        lab = f': {label}' if label else ''
        ss = sid(s) if s in nodes else s
        dd = sid(d) if d in nodes else d
        out.append(f'{ss} {arrow} {dd}{lab}')

    with open(dst, 'w') as f:
        f.write('\n'.join(out) + '\n')

    total = len(supported) + len(unsupported)
    print(f'{src}:')
    print(f'  表現可 {len(supported)} / 全 {total} = {len(supported) / total * 100:.0f}%' if total else '  空')
    if unsupported:
        c = Counter(k for k, *_ in unsupported)
        print('  未対応:', ', '.join(f'{k}×{v}' for k, v in sorted(c.items())))
        for tag, eid, name, reason in unsupported[:20]:
            print(f'    {tag} {eid} {name}: {reason}')
    payload = {
        'source': src,
        'supported': [{'tag': t, 'id': i, 'name': n} for t, i, n in supported],
        'unsupported': [{'tag': t, 'id': i, 'name': n, 'reason': r} for t, i, n, r in unsupported],
        'supportedCount': len(supported),
        'unsupportedCount': len(unsupported),
    }
    if stats_json:
        with open(stats_json, 'w') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


if __name__ == '__main__':
    args = sys.argv[1:]
    stats_json = None
    if '--json-stats' in args:
        i = args.index('--json-stats')
        stats_json = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    if len(args) < 2:
        print('usage: bpmn2flow.py in.bpmn out.flow [source-url] [--json-stats out.json]', file=sys.stderr)
        sys.exit(2)
    main(args[0], args[1], args[2] if len(args) > 2 else '(unknown)', stats_json)
