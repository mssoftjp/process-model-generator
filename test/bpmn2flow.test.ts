import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.ts';
import { evaluateDelivery } from '../src/eval.ts';

const SCRIPT = join(process.cwd(), 'skills/process-model-generator/scripts/bpmn2flow.py');

function convert(xml: string, sourceUrl = 'test://fixture'): { flow: string; stats: {
  supportedCount: number; unsupportedCount: number;
  supported: Array<{ tag: string; id: string }>;
  unsupported: Array<{ tag: string; id: string; reason: string }>;
} } {
  const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-bpmn-'));
  const bpmn = join(dir, 'in.bpmn');
  const flow = join(dir, 'out.flow');
  const stats = join(dir, 'stats.json');
  writeFileSync(bpmn, xml);
  execFileSync('python3', [SCRIPT, bpmn, flow, sourceUrl, '--json-stats', stats], { encoding: 'utf8' });
  return { flow: readFileSync(flow, 'utf8'), stats: JSON.parse(readFileSync(stats, 'utf8')) };
}

const NS = `xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"`;

describe('BPMN XML → DSL → SVG', () => {
  it('レーン参照のない文書を元の参加者と書き手のレーンに保つ', () => {
    const xml = `<definitions ${NS}>
      <process id="company" name="Company">
        <laneSet><lane id="accounting" name="Accounting"><flowNodeRef>s</flowNodeRef><flowNodeRef>write</flowNodeRef><flowNodeRef>e</flowNodeRef></lane></laneSet>
        <startEvent id="s"/><task id="write" name="Write invoice"><dataOutputAssociation id="da"><targetRef>doc</targetRef></dataOutputAssociation></task><endEvent id="e"/>
        <dataObjectReference id="doc" name="Invoice"/>
        <sequenceFlow id="f1" sourceRef="s" targetRef="write"/><sequenceFlow id="f2" sourceRef="write" targetRef="e"/>
      </process>
      <process id="supplier" name="Supplier"><startEvent id="ss"/><endEvent id="se"/><sequenceFlow id="sf" sourceRef="ss" targetRef="se"/></process>
      <collaboration id="c"><participant id="cp" name="Company" processRef="company"/><participant id="sp" name="Supplier" processRef="supplier"/></collaboration>
    </definitions>`;
    for (const input of [xml, xml.replace(/<collaboration[\s\S]*<\/collaboration>/, '')]) {
      const { flow, stats } = convert(input);
      const r = compile(flow, { strict: true });
      const doc = r.normalized.nodes.find(n => n.label === 'Invoice')!;
      expect(r.normalized.lanes.find(l => l.id === doc.lane)?.label).toBe('Accounting');
      expect(r.diagnostics.filter(d => d.code === 'W-209' || d.code === 'W-105')).toEqual([]);
      expect(stats.unsupportedCount).toBe(0);
    }
    const ambiguous = xml.replace('</laneSet>', '<lane id="other" name="Other"><flowNodeRef>otherWriter</flowNodeRef></lane></laneSet>')
      .replace('<dataObjectReference', '<task id="otherWriter"><dataOutputAssociation id="da2"><targetRef>doc</targetRef></dataOutputAssociation></task><sequenceFlow id="f3" sourceRef="otherWriter" targetRef="e"/><dataObjectReference')
      .replace('id="f2" sourceRef="write" targetRef="e"', 'id="f2" sourceRef="write" targetRef="otherWriter"');
    const { flow, stats } = convert(ambiguous);
    const uncertain = compile(flow, { strict: true }).normalized.nodes.find(n => n.label === 'Invoice')!;
    expect(uncertain.provisional).toBe(true);
    expect(stats.unsupported.some(item => item.tag === 'laneAssignment')).toBe(true);
  });

  it('catch / throw / default / condition / call を保持する', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <process id="p" name="Sample" isExecutable="false">
    <startEvent id="start1" name="go"/>
    <userTask id="task1" name="Do"/>
    <intermediateCatchEvent id="wait1" name="wait">
      <messageEventDefinition/>
    </intermediateCatchEvent>
    <intermediateThrowEvent id="send1" name="send">
      <messageEventDefinition/>
    </intermediateThrowEvent>
    <callActivity id="call1" name="Call" calledElement="OtherProcess"/>
    <exclusiveGateway id="gw1" name="?" default="flowDef"/>
    <endEvent id="end1" name="done">
      <terminateEventDefinition/>
    </endEvent>
    <sequenceFlow id="f1" sourceRef="start1" targetRef="task1"/>
    <sequenceFlow id="f2" sourceRef="task1" targetRef="wait1"/>
    <sequenceFlow id="f3" sourceRef="wait1" targetRef="send1"/>
    <sequenceFlow id="f4" sourceRef="send1" targetRef="gw1"/>
    <sequenceFlow id="flowDef" sourceRef="gw1" targetRef="call1"/>
    <sequenceFlow id="flowCond" name="alt" sourceRef="gw1" targetRef="end1">
      <conditionExpression xsi:type="tFormalExpression">x&gt;1</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f5" sourceRef="call1" targetRef="end1"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(flow).toContain('mid(message)');
    expect(flow).toContain('mid(message,throw)');
    expect(flow).toContain('end(terminate)');
    expect(flow).toContain('task(call)');
    expect(flow).toContain('->/');
    expect(flow).not.toMatch(/=>/);
    expect(stats.unsupportedCount).toBe(0);
    expect(stats.supported.some((s) => s.tag === 'intermediateCatchEvent')).toBe(true);
    expect(stats.supported.some((s) => s.tag === 'intermediateThrowEvent')).toBe(true);
    const r = compile(flow);
    expect(r.diagnostics.filter((d) => d.code.startsWith('O-'))).toEqual([]);
    expect(r.svg).toContain('data-event-filled="false"');
    expect(r.svg).toContain('data-event-filled="true"');
    expect(r.svg).toContain('data-default-slash="true"');
    expect(r.svg).toContain('data-task-type="call-process"');
  });

  it('boundaryEvent の attachedToRef と cancelActivity を保持する', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS}>
  <process id="p" name="B">
    <userTask id="t1" name="Work"/>
    <boundaryEvent id="b1" name="timeout" attachedToRef="t1" cancelActivity="true">
      <timerEventDefinition/>
    </boundaryEvent>
    <boundaryEvent id="b2" name="ping" attachedToRef="t1" cancelActivity="false">
      <messageEventDefinition/>
    </boundaryEvent>
    <endEvent id="e1"/>
    <endEvent id="e2"/>
    <sequenceFlow id="f1" sourceRef="t1" targetRef="e1"/>
    <sequenceFlow id="f2" sourceRef="b1" targetRef="e2"/>
    <sequenceFlow id="f3" sourceRef="b2" targetRef="e2"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(flow).toMatch(/boundary\(timer\).*@/);
    expect(flow).toMatch(/boundary\(message,nonint\)/);
    expect(stats.supported.some((s) => s.tag === 'boundaryEvent')).toBe(true);
    const r = compile(flow);
    expect(r.svg).toContain('data-event-role="boundary"');
    expect(r.svg).toContain('data-event-role="boundary-nonint"');
  });

  it('展開サブプロセスと外側の接続を supported に数えず平坦化しない', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS}>
  <process id="p" name="P">
    <startEvent id="s"/>
    <subProcess id="sub1" name="Inner">
      <startEvent id="innerS"/>
      <task id="innerT" name="hidden"/>
      <endEvent id="innerE"/>
      <sequenceFlow id="i1" sourceRef="innerS" targetRef="innerT"/>
      <sequenceFlow id="i2" sourceRef="innerT" targetRef="innerE"/>
    </subProcess>
    <endEvent id="e"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="sub1"/>
    <sequenceFlow id="f2" sourceRef="sub1" targetRef="e"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(stats.unsupported.some((u) => u.tag === 'subProcess' && u.reason.includes('Expanded'))).toBe(true);
    expect(flow).not.toMatch(/^\s+task.*\[hidden\]/m);
    expect(stats.supported.some((s) => s.id === 'innerT')).toBe(false);
    expect(stats.unsupported.some((u) => u.id === 'innerT')).toBe(true);
    expect(stats.supported.some((s) => s.id === 'f1' || s.id === 'f2')).toBe(false);
    expect(stats.unsupported.filter((u) => u.id === 'f1' || u.id === 'f2')).toHaveLength(2);
  });

  it('レーン付きプール枠へのメッセージは supported にせず落とす', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS}>
  <collaboration id="c">
    <participant id="parA" name="A" processRef="pa"/>
    <participant id="parB" name="B" processRef="pb"/>
    <messageFlow id="m1" sourceRef="t1" targetRef="parB"/>
  </collaboration>
  <process id="pa" name="A">
    <task id="t1" name="Send"/>
  </process>
  <process id="pb" name="B">
    <task id="t2" name="Work"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(flow).not.toMatch(/~>\s*p1/);
    expect(stats.unsupported.some((u) => u.tag === 'messageFlow')).toBe(true);
    expect(stats.supported.some((s) => s.tag === 'messageFlow')).toBe(false);
  });

  it('原本と変換後の要素数を JSON で検査できる', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS}>
  <process id="p" name="P">
    <startEvent id="s"/>
    <task id="t"/>
    <endEvent id="e"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(stats.supportedCount).toBeGreaterThan(0);
    expect(stats.supportedCount + stats.unsupportedCount).toBeGreaterThan(stats.supportedCount - 1);
    expect(new Set(stats.supported.map((s) => s.tag))).toEqual(new Set([
      'process-lane', 'startEvent', 'task', 'endEvent', 'sequenceFlow', 'sequenceFlow',
    ].slice(0, 5)));
    const r = compile(flow, { strict: true });
    expect(r.normalized.id).toBe('p');
    expect(compile(convert(xml.replace('name="P"', 'name="Renamed"')).flow).normalized.id).toBe('p');
    const dir = mkdtempSync(join(tmpdir(), 'process-model-generator-converted-delivery-'));
    writeFileSync(join(dir, 'p.flow'), flow);
    writeFileSync(join(dir, 'p.svg'), r.svg);
    const entry = r.normalized.nodes.find(n => n.kind === 'start')!.id;
    const exit = r.normalized.nodes.find(n => n.kind === 'end')!.id;
    const reportPath = join(dir, 'review.md');
    writeFileSync(reportPath, `| claim | kind | view:id | status | reason |\n|---|---|---|---|---|\n| view-index | view | p:* | modeled | entry=${entry}; exits=${exit} |`);
    expect(evaluateDelivery({ directory: dir, reportPath }).findings).toEqual([]);
  });

  it('改行を含む出典をコメント内に留め、トポロジを変えない', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS}>
  <process id="p" name="P">
    <task id="t" name="Work"/>
  </process>
</definitions>`;
    const safe = convert(xml);
    const injected = convert(xml, 'https://example.test/source\r\nflow injected\nlane Attacker\n  task evil[Hidden]');
    expect(injected.flow.split('\n', 1)[0]).toBe(
      '# 出典(原本): https://example.test/source flow injected lane Attacker task evil[Hidden]',
    );
    expect(injected.flow.match(/^flow /gm)).toHaveLength(1);
    expect(compile(injected.flow).normalized).toEqual(compile(safe.flow).normalized);
    expect(injected.stats.supportedCount).toBe(safe.stats.supportedCount);
    expect(injected.stats.unsupportedCount).toBe(safe.stats.unsupportedCount);
    expect(injected.stats.supported).toEqual(safe.stats.supported);
    expect(injected.stats.unsupported).toEqual(safe.stats.unsupported);
  });

  it('無名 conditionExpression と双方向 Association を保持する', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <process id="p" name="P">
    <task id="a" name="A"/>
    <task id="b" name="B"/>
    <textAnnotation id="n"><text>note</text></textAnnotation>
    <sequenceFlow id="f" sourceRef="a" targetRef="b">
      <conditionExpression xsi:type="tFormalExpression">amount &gt; 0</conditionExpression>
    </sequenceFlow>
    <association id="as" sourceRef="a" targetRef="n" associationDirection="Both"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(flow).toContain(': amount > 0');
    expect(flow).toContain('<..>');
    expect(stats.unsupportedCount).toBe(0);
    const r = compile(flow);
    expect(r.svg).toContain('data-conditional-diamond="true"');
    expect(r.svg).toContain('data-assoc="both"');
  });

  it('Global Task 種別と collapsed Event Sub-Process の開始イベントを保持する', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS} xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC">
  <globalUserTask id="gu" name="Global User"/>
  <process id="p" name="P">
    <callActivity id="call" name="Call" calledElement="gu"/>
    <subProcess id="es" name="Alarm" triggeredByEvent="true">
      <startEvent id="ess" isInterrupting="false"><timerEventDefinition/></startEvent>
    </subProcess>
  </process>
  <bpmndi:BPMNDiagram><bpmndi:BPMNPlane>
    <bpmndi:BPMNShape bpmnElement="es" isExpanded="false"><dc:Bounds x="100" y="100" width="100" height="80"/></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</definitions>`;
    const { flow } = convert(xml);
    expect(flow).toContain('task(call,global,user)');
    expect(flow).toContain('task(eventSub,timer,nonint)');
    const r = compile(flow);
    expect(r.svg).toContain('data-task-marker="user"');
    expect(r.svg).toContain('data-event-sub-start="timer"');
    expect(r.svg).toContain('data-event-sub-interrupting="false"');
  });

  it('複数の黒箱 participant をすべて出力し、Group は近似しない', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${NS}>
  <collaboration id="c">
    <participant id="worker" name="Worker" processRef="p"/>
    <participant id="bb1" name="Vendor A"/>
    <participant id="bb2" name="Vendor B"/>
    <messageFlow id="m1" sourceRef="t" targetRef="bb1"/>
    <messageFlow id="m2" sourceRef="t" targetRef="bb2"/>
  </collaboration>
  <process id="p" name="P">
    <task id="t" name="Send"/>
    <group id="g" categoryValueRef="cv"/>
  </process>
</definitions>`;
    const { flow, stats } = convert(xml);
    expect(flow).toContain('pool p1[Vendor A]');
    expect(flow).toContain('pool p2[Vendor B]');
    expect(flow.match(/~>/g)).toHaveLength(2);
    expect(stats.supported.filter((s) => s.tag === 'messageFlow')).toHaveLength(2);
    expect(stats.unsupported.some((u) => u.tag === 'group')).toBe(true);
    expect(stats.supported.some((s) => s.tag === 'group')).toBe(false);
  });
});
